/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { query, queryOne, transaction } from '../db';
import {
  DELIVERY_AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION,
  BrowserProfileProviderBindingSchema,
  type AuthorityCapability,
  type DeliveryAuthorityProviderAdapter,
  type BrowserProfileProviderBinding,
  type ProviderBinding,
  type ProviderBindingSelector,
} from './authority-provider-adapter';
import { BROWSER_SESSION_BROKER_ADAPTER_DESCRIPTOR } from './delivery-adapter';
import {
  PostgresBrowserAuthenticationRequestRepository,
  UnavailableBrowserAuthenticationRequestRepository,
} from './browser-authentication-wait';
import {
  LocalIsolatedBrowserSessionRunnerHost,
  PostgresBrowserSessionLeaseRepository,
  UnavailableBrowserSessionLeaseRepository,
} from './browser-session-lease';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableError,
  ValidationError,
} from './errors';

export const BrowserExternalProviderSchema = z.enum(['claude', 'chatgpt']);
export type BrowserExternalProvider = z.infer<typeof BrowserExternalProviderSchema>;

const AccountAliasSchema = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,119}$/);

export const ExactBrowserOriginSchema = z.string().transform((value, context) => {
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Origin must be pathless HTTPS or loopback HTTP' });
      return z.NEVER;
    }
    return url.origin;
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Origin must be an absolute URL origin' });
    return z.NEVER;
  }
});

export const BrowserProfileRetentionPolicySchema = z.object({
  mode: z.enum(['preserve', 'quarantine', 'destroy']),
  retainUntil: z.string().datetime().nullable(),
}).strict().superRefine((value, context) => {
  if (value.mode === 'destroy' && value.retainUntil === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['retainUntil'], message: 'destroy retention requires retainUntil' });
  }
});

export const BrowserProfileEnrollmentMetadataSchema = z.object({
  workspaceId: z.string().trim().min(1).max(255),
  externalProvider: BrowserExternalProviderSchema,
  accountAlias: AccountAliasSchema,
  allowedOrigins: z.array(ExactBrowserOriginSchema).min(1).max(32)
    .refine((origins) => new Set(origins).size === origins.length, 'Origins must be unique'),
  retentionPolicy: BrowserProfileRetentionPolicySchema,
  destructionPolicy: z.enum(['operator_delete', 'delete_after_retention']),
}).strict();

export const BeginBrowserProfileEnrollmentSchema = BrowserProfileEnrollmentMetadataSchema.extend({
  operatorId: z.string().trim().min(1).max(255),
});
export type BeginBrowserProfileEnrollment = z.infer<typeof BeginBrowserProfileEnrollmentSchema>;

export const BrowserProfileHealthSchema = z.object({
  provider: z.enum(['healthy', 'degraded', 'locked']),
  session: z.enum(['healthy', 'expired', 'unknown']),
  observedAt: z.string().datetime(),
}).strict();
export type BrowserProfileHealth = z.infer<typeof BrowserProfileHealthSchema>;

export const CaptureBrowserProfileSchema = z.object({
  bindingId: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(255),
  externalProvider: BrowserExternalProviderSchema,
  accountAlias: AccountAliasSchema,
  health: BrowserProfileHealthSchema,
}).strict();
export type CaptureBrowserProfile = z.infer<typeof CaptureBrowserProfileSchema>;


export const BrowserSessionActionNameSchema = z.enum([
  'navigate',
  'click',
  'fill',
  'select',
  'check',
  'readText',
  'upload',
]);
export type BrowserSessionActionName = z.infer<typeof BrowserSessionActionNameSchema>;

export const BrowserSessionActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('navigate'), url: z.string().url().max(4_096) }).strict(),
  z.object({ type: z.literal('click'), selector: z.string().min(1).max(2_048) }).strict(),
  z.object({
    type: z.literal('fill'),
    selector: z.string().min(1).max(2_048),
    value: z.string().max(65_536),
  }).strict(),
  z.object({
    type: z.literal('select'),
    selector: z.string().min(1).max(2_048),
    value: z.string().max(8_192),
  }).strict(),
  z.object({
    type: z.literal('check'),
    selector: z.string().min(1).max(2_048),
    checked: z.boolean(),
  }).strict(),
  z.object({ type: z.literal('readText'), selector: z.string().min(1).max(2_048) }).strict(),
  z.object({
    type: z.literal('upload'),
    selector: z.string().min(1).max(2_048),
    grant: z.object({
      artifactId: z.string().trim().min(1).max(255),
      expiresAt: z.number().int().positive(),
    }).strict(),
  }).strict(),
]);
export type BrowserSessionAction = z.infer<typeof BrowserSessionActionSchema>;

const CREDENTIAL_MATERIAL_REFERENCE = /\b(?:cookies?|totp|passwords?|passkeys?|(?:access|refresh)[-_ ]?tokens?|tokens?|bearer|recovery[-_ ]?codes?|private[-_ ]?keys?|credential[-_ ]?export)\b/i;
const CREDENTIAL_EXTRACTION_VERB = /\b(?:copy|download|export|extract|print|read|return|reveal|show)\b/i;

function browserActionRequestsCredentialExtraction(action: BrowserSessionAction): boolean {
  let securityText: string;
  switch (action.type) {
    case 'navigate': securityText = action.url; break;
    case 'fill':
    case 'select': securityText = `${action.selector}\n${action.value}`; break;
    case 'click':
    case 'check':
    case 'readText': securityText = action.selector; break;
    case 'upload': securityText = `${action.selector}\n${action.grant.artifactId}`; break;
  }
  if (!CREDENTIAL_MATERIAL_REFERENCE.test(securityText)) return false;
  return action.type !== 'click' && action.type !== 'check'
    ? true
    : CREDENTIAL_EXTRACTION_VERB.test(securityText);
}

export const BrowserSessionEvidenceContractSchema = z.object({
  schemaVersion: z.string().trim().min(1).max(120),
  requiredEvidence: z.array(z.enum([
    'screenshot',
    'accessibility_snapshot',
    'network_metadata',
    'provider_state',
    'security_event',
    'revocation_proof',
  ])).min(1).max(16).refine((entries) => new Set(entries).size === entries.length, 'Evidence classes must be unique'),
  redaction: z.literal('required'),
}).strict();
export type BrowserSessionEvidenceContract = z.infer<typeof BrowserSessionEvidenceContractSchema>;

const BrowserSessionBindingSchema = z.object({
  bindingId: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(255),
  externalProvider: BrowserExternalProviderSchema,
  runId: z.string().trim().min(1).max(255),
  storyId: z.string().trim().min(1).max(255),
  purpose: z.string().trim().min(1).max(255),
  profileGeneration: z.number().int().positive(),
}).strict();

export const CreateBrowserSessionGrantSchema = BrowserSessionBindingSchema.extend({
  allowedOrigins: z.array(ExactBrowserOriginSchema).min(1).max(32)
    .refine((origins) => new Set(origins).size === origins.length, 'Origins must be unique'),
  allowedActions: z.array(BrowserSessionActionNameSchema).min(1)
    .max(BrowserSessionActionNameSchema.options.length)
    .refine((actions) => new Set(actions).size === actions.length, 'Actions must be unique'),
  maximumConcurrentRunners: z.number().int().min(1).max(16),
  expiresAt: z.string().datetime(),
  evidenceContract: BrowserSessionEvidenceContractSchema,
}).strict();
export type CreateBrowserSessionGrant = z.infer<typeof CreateBrowserSessionGrantSchema>;

export const BrowserSessionRequestSchema = BrowserSessionBindingSchema.extend({
  grantId: z.string().uuid(),
  allowedOrigins: z.array(ExactBrowserOriginSchema).min(1).max(32)
    .refine((origins) => new Set(origins).size === origins.length, 'Origins must be unique'),
  allowedActions: z.array(BrowserSessionActionNameSchema).min(1)
    .max(BrowserSessionActionNameSchema.options.length)
    .refine((actions) => new Set(actions).size === actions.length, 'Actions must be unique'),
  expiresAt: z.string().datetime(),
}).strict();
export type BrowserSessionRequest = z.infer<typeof BrowserSessionRequestSchema>;

export const BrowserSessionUseSchema = BrowserSessionBindingSchema.extend({
  leaseId: z.string().uuid(),
  action: BrowserSessionActionSchema,
}).strict();
export type BrowserSessionUse = z.infer<typeof BrowserSessionUseSchema>;

export const BrowserSessionEvidenceRequestSchema = BrowserSessionBindingSchema.extend({
  leaseId: z.string().uuid(),
}).strict();
export type BrowserSessionEvidenceRequest = z.infer<typeof BrowserSessionEvidenceRequestSchema>;

export interface BrowserSessionEvidenceArtifact {
  artifactId: string;
  digest: `sha256:${string}`;
  mediaType: 'image/png' | 'text/aria-snapshot';
}

export interface BrowserSessionNetworkMetadata {
  observedAt: string;
  origin: string | null;
  pathDigest: `sha256:${string}`;
  method: string;
  effect: string;
  decision: 'allowed' | 'denied';
}

export interface BrowserSessionEvidenceObservation {
  observedAt: string;
  currentOrigin: string | null;
  screenshot: BrowserSessionEvidenceArtifact;
  accessibilitySnapshot: BrowserSessionEvidenceArtifact;
  networkMetadata: BrowserSessionNetworkMetadata[];
  providerStateDigest: `sha256:${string}`;
  authenticatedSessionObserved: boolean;
  redaction: 'sensitive-elements-masked-and-accessible-text-removed';
}

export const BrowserSessionRevocationSchema = BrowserSessionBindingSchema.extend({
  leaseId: z.string().uuid(),
  reason: z.enum([
    'purpose_completed',
    'operator_revoked',
    'grant_revoked',
    'lease_expired',
    'runner_crashed',
    'policy_denied',
    'authentication_cancelled',
    'authentication_denied',
    'authentication_expired',
    'authentication_unhealthy',
    'authentication_policy_prohibited',
  ]),
}).strict();
export type BrowserSessionRevocation = z.infer<typeof BrowserSessionRevocationSchema>;

export const BrowserSessionReconciliationSchema = BrowserSessionBindingSchema.extend({
  leaseId: z.string().uuid(),
}).strict();
export type BrowserSessionReconciliation = z.infer<typeof BrowserSessionReconciliationSchema>;

const BrowserAuthenticationDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const BrowserAuthenticationStepSchema = z.enum([
  'login_expired',
  'consent',
  'mfa',
  'passkey',
  'captcha',
  'account_locked',
  'provider_step_up',
  'anti_automation',
]);
export type BrowserAuthenticationStep = z.infer<typeof BrowserAuthenticationStepSchema>;

export const BrowserAuthenticationObservationSchema = z.object({
  schemaVersion: z.literal('rorca.browser-authentication-observation.v1'),
  step: BrowserAuthenticationStepSchema,
  observedAt: z.string().datetime(),
  currentOrigin: ExactBrowserOriginSchema,
  signal: z.enum([
    'login_prompt',
    'consent_prompt',
    'mfa_prompt',
    'passkey_prompt',
    'captcha_challenge',
    'account_lock_notice',
    'provider_step_up_prompt',
    'anti_automation_notice',
  ]),
  providerStateDigest: BrowserAuthenticationDigestSchema,
  accessibilityDigest: BrowserAuthenticationDigestSchema,
  screenshotDigest: BrowserAuthenticationDigestSchema.nullable(),
  automationPolicy: z.enum(['human_only', 'prohibited']),
  redaction: z.literal('required'),
}).strict().superRefine((value, context) => {
  const expectedSignal: Record<BrowserAuthenticationStep, typeof value.signal> = {
    login_expired: 'login_prompt',
    consent: 'consent_prompt',
    mfa: 'mfa_prompt',
    passkey: 'passkey_prompt',
    captcha: 'captcha_challenge',
    account_locked: 'account_lock_notice',
    provider_step_up: 'provider_step_up_prompt',
    anti_automation: 'anti_automation_notice',
  };
  if (value.signal !== expectedSignal[value.step]) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['signal'], message: 'Authentication signal does not match its typed step' });
  }
  if (value.step === 'anti_automation' && value.automationPolicy !== 'prohibited') {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['automationPolicy'], message: 'Anti-automation state must prohibit automation' });
  }
});
export type BrowserAuthenticationObservation = z.infer<typeof BrowserAuthenticationObservationSchema>;

export const BrowserAuthenticationWaitSchema = BrowserSessionBindingSchema.extend({
  requestId: z.string().uuid(),
  leaseId: z.string().uuid(),
  step: BrowserAuthenticationStepSchema,
  evidence: BrowserAuthenticationObservationSchema,
  checkpointDigest: BrowserAuthenticationDigestSchema,
  detectedAt: z.string().datetime(),
  authenticationExpiresAt: z.string().datetime(),
}).strict();
export type BrowserAuthenticationWait = z.infer<typeof BrowserAuthenticationWaitSchema>;

export const BrowserAuthenticationResolutionSchema = z.object({
  workspaceId: z.string().trim().min(1).max(255),
  runId: z.string().trim().min(1).max(255),
  decision: z.enum(['complete', 'cancel', 'deny']),
}).strict();
export type BrowserAuthenticationResolution = z.infer<typeof BrowserAuthenticationResolutionSchema>;

export const BrowserAuthenticationRevalidationSchema = z.object({
  schemaVersion: z.literal('rorca.browser-authentication-revalidation.v1'),
  observedAt: z.string().datetime(),
  currentOrigin: ExactBrowserOriginSchema,
  providerStateDigest: BrowserAuthenticationDigestSchema,
  accessibilityDigest: BrowserAuthenticationDigestSchema,
  challengePresent: z.boolean(),
  health: BrowserProfileHealthSchema,
  redaction: z.literal('required'),
}).strict().superRefine((value, context) => {
  if (value.health.observedAt !== value.observedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['health', 'observedAt'],
      message: 'Authentication health must come from the same trusted observation',
    });
  }
});
export type BrowserAuthenticationRevalidation = z.infer<typeof BrowserAuthenticationRevalidationSchema>;

export type BrowserAuthenticationRequestState =
  | 'WAITING_FOR_AUTHENTICATION'
  | 'REVALIDATING'
  | 'RESUMED'
  | 'CANCELLED'
  | 'DENIED'
  | 'EXPIRED'
  | 'UNHEALTHY'
  | 'POLICY_PROHIBITED';
export type BrowserAuthenticationDisposition = 'resumed' | 'terminal' | 'retryable';
export type BrowserAuthenticationOutcomeCode =
  | 'AUTHENTICATION_RESUMED'
  | 'AUTHENTICATION_CANCELLED'
  | 'AUTHENTICATION_DENIED'
  | 'AUTHENTICATION_EXPIRED'
  | 'AUTHENTICATION_UNHEALTHY'
  | 'AUTHENTICATION_POLICY_PROHIBITED';

export interface BrowserAuthenticationRequestRecord extends BrowserAuthenticationWait {
  state: BrowserAuthenticationRequestState;
  disposition: BrowserAuthenticationDisposition | null;
  outcomeCode: BrowserAuthenticationOutcomeCode | null;
  runPauseOwned: boolean;
  resumeCount: 0 | 1;
  resolutionObservation: BrowserAuthenticationRevalidation | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resumedAt: string | null;
}

export type BrowserSessionActionResult =
  | { kind: 'completed'; result?: string }
  | { kind: 'authentication_required'; observation: BrowserAuthenticationObservation };

export type BrowserSessionUseResult =
  | {
    kind: 'completed';
    leaseId: string;
    action: BrowserSessionActionName;
    result?: string;
    usedAt: string;
  }
  | {
    kind: 'authentication_required';
    leaseId: string;
    action: BrowserSessionActionName;
    usedAt: string;
    authenticationRequest: BrowserAuthenticationRequestRecord;
  };

export type BrowserSessionGrantState = 'active' | 'revoked' | 'expired';
export type BrowserSessionLeaseState = 'provisioning' | 'active' | 'revoked' | 'expired' | 'uncertain';

export interface BrowserSessionGrantRecord extends CreateBrowserSessionGrant {
  id: string;
  state: BrowserSessionGrantState;
  issuedAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
  retentionMode: BrowserProfileBindingRecord['retentionMode'];
  retainUntil: string | null;
  destructionPolicy: BrowserProfileBindingRecord['destructionPolicy'];
}

export interface BrowserSessionLeaseRecord extends BrowserSessionRequest {
  id: string;
  state: BrowserSessionLeaseState;
  runnerId: string;
  issuedAt: string;
  lastHeartbeatAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
  maximumConcurrentRunners: number;
  evidenceContract: BrowserSessionEvidenceContract;
  retentionMode: BrowserProfileBindingRecord['retentionMode'];
  retainUntil: string | null;
  destructionPolicy: BrowserProfileBindingRecord['destructionPolicy'];
}

export type BrowserProfileLifecycleReason =
  | 'operator_quarantine'
  | 'provider_unhealthy'
  | 'session_unhealthy'
  | 'operator_delete'
  | 'retention_expired';

type BrowserProfileLifecycleState = 'pending' | 'active' | 'quarantined' | 'deleted';
type BrowserBindingStatus = 'active' | 'disabled' | 'invalid';

export interface BrowserProfileBindingRecord {
  id: string;
  workspaceId: string;
  externalProvider: BrowserExternalProvider;
  accountAlias: string;
  allowedOrigins: string[];
  profileGeneration: number;
  profileSecretRef: string | null;
  lifecycleState: BrowserProfileLifecycleState;
  bindingStatus: BrowserBindingStatus;
  providerHealth: BrowserProfileHealth['provider'];
  sessionHealth: BrowserProfileHealth['session'];
  healthObservedAt: string;
  retentionMode: 'preserve' | 'quarantine' | 'destroy';
  retainUntil: string | null;
  destructionPolicy: 'operator_delete' | 'delete_after_retention';
  enrollmentProvenance: {
    kind: 'human_operator';
    operatorId: string;
    surface: 'operator_takeover';
    enrolledAt: string;
  };
}

interface BrowserProfileBindingRow {
  id: string;
  workspace_id: string;
  external_provider: BrowserExternalProvider;
  account_alias: string;
  allowed_origins: string[];
  profile_generation: number;
  profile_secret_ref: string | null;
  lifecycle_state: BrowserProfileLifecycleState;
  binding_status: BrowserBindingStatus;
  provider_health: BrowserProfileHealth['provider'];
  session_health: BrowserProfileHealth['session'];
  health_observed_at: Date | string;
  retention_mode: BrowserProfileBindingRecord['retentionMode'];
  retain_until: Date | string | null;
  destruction_policy: BrowserProfileBindingRecord['destructionPolicy'];
  enrollment_provenance: BrowserProfileBindingRecord['enrollmentProvenance'];
}

export interface BrowserProfileRepository {
  createPending(record: BrowserProfileBindingRecord): Promise<BrowserProfileBindingRecord>;
  completeEnrollment(bindingId: string, secretRef: string, health: BrowserProfileHealth): Promise<BrowserProfileBindingRecord>;
  findByIdentity(workspaceId: string, provider: BrowserExternalProvider, accountAlias: string): Promise<BrowserProfileBindingRecord | null>;
  findById(bindingId: string): Promise<BrowserProfileBindingRecord | null>;
  listActiveBindings(): Promise<BrowserProfileBindingRecord[]>;
  transitionLifecycle(
    bindingId: string,
    workspaceId: string,
    target: 'quarantined' | 'deleted',
    reason: BrowserProfileLifecycleReason,
  ): Promise<BrowserProfileBindingRecord>;
  recordUseDenied(binding: BrowserProfileBindingRecord, reason: string, origin: string): Promise<void>;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToRecord(row: BrowserProfileBindingRow): BrowserProfileBindingRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    externalProvider: row.external_provider,
    accountAlias: row.account_alias,
    allowedOrigins: [...row.allowed_origins],
    profileGeneration: Number(row.profile_generation),
    profileSecretRef: row.profile_secret_ref,
    lifecycleState: row.lifecycle_state,
    bindingStatus: row.binding_status,
    providerHealth: row.provider_health,
    sessionHealth: row.session_health,
    healthObservedAt: iso(row.health_observed_at),
    retentionMode: row.retention_mode,
    retainUntil: row.retain_until === null ? null : iso(row.retain_until),
    destructionPolicy: row.destruction_policy,
    enrollmentProvenance: row.enrollment_provenance,
  };
}

function evidenceDigest(evidence: Record<string, unknown>): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex')}`;
}

async function insertReceipt(
  client: PoolClient,
  record: BrowserProfileBindingRecord,
  eventType: 'enrollment_started' | 'enrollment_completed' | 'profile_use_denied',
  evidence: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO rorca.authority_provider_receipts
       (binding_id, workspace_id, event_type, evidence, evidence_digest)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [record.id, record.workspaceId, eventType, JSON.stringify(evidence), evidenceDigest(evidence)],
  );
}

export class PostgresBrowserProfileRepository implements BrowserProfileRepository {
  async createPending(record: BrowserProfileBindingRecord): Promise<BrowserProfileBindingRecord> {
    try {
      return await transaction(async (client) => {
        const result = await client.query<BrowserProfileBindingRow>(
          `INSERT INTO rorca.browser_profile_bindings (
             id, workspace_id, external_provider, account_alias, allowed_origins,
             profile_generation, lifecycle_state, binding_status, provider_health,
             session_health, health_observed_at, retention_mode, retain_until,
             destruction_policy, enrollment_provenance
           ) VALUES (
             $1, $2, $3, $4, $5::text[], $6, 'pending', 'disabled', 'degraded',
             'unknown', $7, $8, $9, $10, $11::jsonb
           ) RETURNING *`,
          [
            record.id,
            record.workspaceId,
            record.externalProvider,
            record.accountAlias,
            record.allowedOrigins,
            record.profileGeneration,
            record.healthObservedAt,
            record.retentionMode,
            record.retainUntil,
            record.destructionPolicy,
            JSON.stringify(record.enrollmentProvenance),
          ],
        );
        const created = rowToRecord(result.rows[0]!);
        const evidence = {
          schemaVersion: 'rorca.browser-profile-enrollment-receipt.v1',
          bindingId: created.id,
          workspaceId: created.workspaceId,
          provider: created.externalProvider,
          accountAlias: created.accountAlias,
          allowedOrigins: created.allowedOrigins,
          profileGeneration: created.profileGeneration,
          provenance: created.enrollmentProvenance,
          providerHealth: created.providerHealth,
          sessionHealth: created.sessionHealth,
          secretMaterial: '[redacted]',
        };
        await insertReceipt(client, created, 'enrollment_started', evidence);
        return created;
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictError('This dedicated provider test identity is already enrolled');
      }
      throw error;
    }
  }

  async completeEnrollment(bindingId: string, secretRef: string, health: BrowserProfileHealth): Promise<BrowserProfileBindingRecord> {
    return transaction(async (client) => {
      const locked = await client.query<BrowserProfileBindingRow>(
        'SELECT * FROM rorca.browser_profile_bindings WHERE id = $1 FOR UPDATE',
        [bindingId],
      );
      if (!locked.rows[0]) throw new NotFoundError('Browser profile binding', bindingId);
      if (locked.rows[0].lifecycle_state !== 'pending' || locked.rows[0].profile_secret_ref !== null) {
        throw new ConflictError('Browser profile enrollment is already settled');
      }
      const result = await client.query<BrowserProfileBindingRow>(
        `UPDATE rorca.browser_profile_bindings
            SET profile_secret_ref = $2,
                lifecycle_state = 'active',
                binding_status = 'active',
                provider_health = $3,
                session_health = $4,
                health_observed_at = $5
          WHERE id = $1
          RETURNING *`,
        [bindingId, secretRef, health.provider, health.session, health.observedAt],
      );
      const completed = rowToRecord(result.rows[0]!);
      const evidence = {
        schemaVersion: 'rorca.browser-profile-enrollment-receipt.v1',
        bindingId: completed.id,
        workspaceId: completed.workspaceId,
        provider: completed.externalProvider,
        accountAlias: completed.accountAlias,
        profileGeneration: completed.profileGeneration,
        providerHealth: completed.providerHealth,
        sessionHealth: completed.sessionHealth,
        healthObservedAt: completed.healthObservedAt,
        profileArtifact: '[encrypted-secret-store-reference]',
        authentication: '[completed-by-human-operator]',
        secretMaterial: '[redacted]',
      };
      await insertReceipt(client, completed, 'enrollment_completed', evidence);
      return completed;
    });
  }

  async findByIdentity(workspaceId: string, provider: BrowserExternalProvider, accountAlias: string): Promise<BrowserProfileBindingRecord | null> {
    const row = await queryOne<BrowserProfileBindingRow>(
      `SELECT * FROM rorca.browser_profile_bindings
        WHERE workspace_id = $1 AND external_provider = $2 AND account_alias = $3`,
      [workspaceId, provider, accountAlias],
    );
    return row ? rowToRecord(row) : null;
  }

  async findById(bindingId: string): Promise<BrowserProfileBindingRecord | null> {
    const row = await queryOne<BrowserProfileBindingRow>(
      'SELECT * FROM rorca.browser_profile_bindings WHERE id = $1',
      [bindingId],
    );
    return row ? rowToRecord(row) : null;
  }

  async listActiveBindings(): Promise<BrowserProfileBindingRecord[]> {
    const rows = await query<BrowserProfileBindingRow>(
      `SELECT * FROM rorca.browser_profile_bindings
        WHERE lifecycle_state = 'active' AND binding_status = 'active'
        ORDER BY workspace_id, external_provider, account_alias, id`,
    );
    return rows.map(rowToRecord);
  }

  async transitionLifecycle(
    bindingId: string,
    workspaceId: string,
    target: 'quarantined' | 'deleted',
    reason: BrowserProfileLifecycleReason,
  ): Promise<BrowserProfileBindingRecord> {
    return transaction(async (client) => {
      const locked = await client.query<BrowserProfileBindingRow>(
      'SELECT * FROM rorca.browser_profile_bindings WHERE id = $1 AND workspace_id = $2 FOR UPDATE',
        [bindingId, workspaceId],
      );
      if (!locked.rows[0]) throw new NotFoundError('Browser profile binding', bindingId);
      const current = locked.rows[0].lifecycle_state;
      if (current === target) return rowToRecord(locked.rows[0]);
      if (current === 'pending' || current === 'deleted' || (current === 'quarantined' && target !== 'deleted')) {
        throw new ConflictError(`Browser profile cannot transition from ${current} to ${target}`);
      }
      const result = await client.query<BrowserProfileBindingRow>(
        `UPDATE rorca.browser_profile_bindings
            SET lifecycle_state = $3,
                binding_status = 'disabled',
                lifecycle_reason = $4,
                quarantined_at = CASE WHEN $3 = 'quarantined' THEN clock_timestamp() ELSE quarantined_at END,
                deleted_at = CASE WHEN $3 = 'deleted' THEN clock_timestamp() ELSE deleted_at END
          WHERE id = $1 AND workspace_id = $2
          RETURNING *`,
        [bindingId, workspaceId, target, reason],
      );
      return rowToRecord(result.rows[0]!);
    });
  }

  async recordUseDenied(binding: BrowserProfileBindingRecord, reason: string, origin: string): Promise<void> {
    const evidence = {
      schemaVersion: 'rorca.browser-profile-use-denial.v1',
      bindingId: binding.id,
      workspaceId: binding.workspaceId,
      provider: binding.externalProvider,
      accountAlias: binding.accountAlias,
      profileGeneration: binding.profileGeneration,
      reason,
      requestedOriginDigest: evidenceDigest({ origin }),
      secretMaterial: '[redacted]',
    };
    await transaction((client) => insertReceipt(client, binding, 'profile_use_denied', evidence));
  }
}

export const BrowserProfileArtifactIdentitySchema = z.object({
  bindingId: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(255),
  externalProvider: BrowserExternalProviderSchema,
  accountAlias: AccountAliasSchema,
  profileGeneration: z.number().int().positive(),
  allowedOrigins: z.array(ExactBrowserOriginSchema).min(1).max(32)
    .refine((origins) => new Set(origins).size === origins.length, 'Origins must be unique'),
}).strict();
export type BrowserProfileArtifactIdentity = z.infer<typeof BrowserProfileArtifactIdentitySchema>;

export interface IsolatedBrowserRunnerMountPort {
  mountProfile(input: {
    runnerId: string;
    bindingId: string;
    profileGeneration: number;
    profileBytes: Buffer;
    allowedOrigins: readonly string[];
    modelContextAccess: 'none';
    filesystemAccess: 'ephemeral-profile-only';
    artifactAccess: 'redacted-only';
  }): Promise<void>;
}

export interface BrowserSessionLeaseRepository {
  createGrant(grant: BrowserSessionGrantRecord, healthStaleBefore: string): Promise<BrowserSessionGrantRecord>;
  findGrant(grantId: string): Promise<BrowserSessionGrantRecord | null>;
  reserveLease(
    lease: BrowserSessionLeaseRecord,
    profileHealthStaleBefore: string,
    heartbeatStaleBefore: string,
  ): Promise<BrowserSessionLeaseRecord>;
  activateLease(leaseId: string, activatedAt: string): Promise<BrowserSessionLeaseRecord>;
  authorizeUse(input: BrowserSessionUse, requestedOrigin: string | null, usedAt: string, heartbeatStaleBefore: string): Promise<BrowserSessionLeaseRecord>;
  markUncertain(leaseId: string, reason: string, observedAt: string): Promise<BrowserSessionLeaseRecord>;
  beginRevocation(input: BrowserSessionRevocation, observedAt: string): Promise<BrowserSessionLeaseRecord>;
  completeRevocation(leaseId: string, reason: string, observedAt: string): Promise<BrowserSessionLeaseRecord>;
  completeReconciliation(
    leaseId: string,
    health: BrowserProfileHealth,
    observedAt: string,
  ): Promise<BrowserSessionLeaseRecord>;
  recordSecurityEvent(input: {
    leaseId: string;
    reason:
      | 'action_not_allowed'
      | 'credential_extraction_attempt'
      | 'origin_not_allowlisted'
      | 'network_origin_not_allowlisted';
    requestedOrigin: string | null;
    effect: string;
    observedAt: string;
  }): Promise<void>;
  findLease(leaseId: string): Promise<BrowserSessionLeaseRecord | null>;
  listOpenLeases(bindingId: string, workspaceId: string): Promise<BrowserSessionLeaseRecord[]>;
  listOpenLeasesForBroker(): Promise<BrowserSessionLeaseRecord[]>;
  revokeOpenGrants(reason: string, observedAt: string): Promise<number>;
}

export interface BrowserAuthenticationRequestRepository {
  createWait(request: BrowserAuthenticationRequestRecord): Promise<BrowserAuthenticationRequestRecord>;
  findById(requestId: string): Promise<BrowserAuthenticationRequestRecord | null>;
  findOpenForRun(workspaceId: string, runId: string): Promise<BrowserAuthenticationRequestRecord | null>;
  findLatestForRun(workspaceId: string, runId: string): Promise<BrowserAuthenticationRequestRecord | null>;
  claimForRevalidation(
    requestId: string,
    workspaceId: string,
    runId: string,
    operatorId: string,
    observedAt: string,
  ): Promise<BrowserAuthenticationRequestRecord>;
  settle(input: {
    requestId: string;
    workspaceId: string;
    runId: string;
    expectedStates: readonly Extract<BrowserAuthenticationRequestState, 'WAITING_FOR_AUTHENTICATION' | 'REVALIDATING'>[];
    state: Exclude<BrowserAuthenticationRequestState, 'WAITING_FOR_AUTHENTICATION' | 'REVALIDATING'>;
    disposition: BrowserAuthenticationDisposition;
    outcomeCode: BrowserAuthenticationOutcomeCode;
    resolutionObservation: BrowserAuthenticationRevalidation | null;
    resolvedBy: string;
    resolvedAt: string;
  }): Promise<BrowserAuthenticationRequestRecord>;
}

export interface BrowserSessionRunnerLaunch {
  leaseId: string;
  runnerId: string;
  workspaceId: string;
  runId: string;
  storyId: string;
  purpose: string;
  bindingId: string;
  profileGeneration: number;
  allowedOrigins: readonly string[];
  allowedActions: readonly BrowserSessionActionName[];
  maximumConcurrentRunners: number;
  expiresAt: string;
  evidenceContract: BrowserSessionEvidenceContract;
  networkAccess: 'exact-origin-allowlist-only';
  modelContextAccess: 'none';
  filesystemAccess: 'ephemeral-profile-only';
  artifactAccess: 'redacted-only';
  onSecurityEvent(event: {
    reason: 'network_origin_not_allowlisted';
    requestedOrigin: string | null;
    effect: string;
  }): Promise<void>;
}

export interface BrowserSessionRunnerHost {
  launch(input: BrowserSessionRunnerLaunch): Promise<IsolatedBrowserRunnerMountPort>;
  use(runnerId: string, action: BrowserSessionAction): Promise<BrowserSessionActionResult>;
  captureEvidence(runnerId: string): Promise<BrowserSessionEvidenceObservation>;
  suspendForAuthentication(
    runnerId: string,
    observation: BrowserAuthenticationObservation,
  ): Promise<{ checkpointDigest: `sha256:${string}` }>;
  revalidateAuthentication(
    runnerId: string,
    request: BrowserAuthenticationRequestRecord,
  ): Promise<BrowserAuthenticationRevalidation>;
  resumeAfterAuthentication(runnerId: string, requestId: string): Promise<'resumed' | 'already_resumed'>;
  terminate(runnerId: string): Promise<'terminated' | 'uncertain'>;
  clearEphemeralState(runnerId: string): Promise<void>;
  reconcile(runnerId: string): Promise<{
    termination: 'terminated' | 'uncertain';
    health: BrowserProfileHealth;
  }>;
}

export interface BrowserProfileSecretStore {
  ensureReady(): Promise<void>;
  storeProfile(identity: BrowserProfileArtifactIdentity, profileBytes: Buffer): Promise<string>;
  verifyReference(secretRef: string, identity: BrowserProfileArtifactIdentity): Promise<boolean>;
  mountProfile(
    secretRef: string,
    identity: BrowserProfileArtifactIdentity,
    runnerId: string,
    mountPort: IsolatedBrowserRunnerMountPort,
  ): Promise<void>;
  destroyProfile(secretRef: string): Promise<void>;
}

const ProfileEnvelopeHeaderSchema = z.object({
  schemaVersion: z.literal('rorca.encrypted-browser-profile.v1'),
  secretRef: z.string().uuid(),
  identityDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  artifactDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  artifactBytes: z.number().int().positive(),
  wrapIv: z.string().min(1),
  wrapTag: z.string().min(1),
  wrappedKey: z.string().min(1),
  profileIv: z.string().min(1),
  profileTag: z.string().min(1),
}).strict();
type ProfileEnvelopeHeader = z.infer<typeof ProfileEnvelopeHeaderSchema>;

function canonicalArtifactIdentity(identity: BrowserProfileArtifactIdentity): BrowserProfileArtifactIdentity {
  const parsed = BrowserProfileArtifactIdentitySchema.safeParse(identity);
  if (!parsed.success) {
    throw new ValidationError('Browser profile artifact identity is invalid', {
      fields: parsed.error.issues.map((issue) => issue.path.join('.') || 'identity'),
    });
  }
  return { ...parsed.data, allowedOrigins: [...parsed.data.allowedOrigins].sort() };
}

function profileIdentityBytes(secretRef: string, identity: BrowserProfileArtifactIdentity): Buffer {
  return Buffer.from(JSON.stringify({
    schemaVersion: 'rorca.browser-profile-domain-binding.v1',
    secretRef,
    bindingId: identity.bindingId,
    workspaceId: identity.workspaceId,
    externalProvider: identity.externalProvider,
    accountAlias: identity.accountAlias,
    profileGeneration: identity.profileGeneration,
    allowedOrigins: [...identity.allowedOrigins].sort(),
  }), 'utf8');
}

function digestBytes(bytes: crypto.BinaryLike): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function decodeBase64(value: string, expectedBytes: number, label: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== expectedBytes || decoded.toString('base64') !== value) {
    throw new UnprocessableError(`Encrypted browser profile ${label} is malformed`, 'BROWSER_PROFILE_CORRUPT');
  }
  return decoded;
}

export class EncryptedBrowserProfileSecretStore implements BrowserProfileSecretStore {
  private readonly root: string;
  private masterKey: Buffer | null;

  constructor(options: { root?: string; masterKey?: Buffer } = {}) {
    this.root = options.root ?? process.env.RORCA_BROWSER_PROFILE_STORE_DIR
      ?? path.join(os.homedir(), '.rorca', 'browser-profile-secrets');
    if (options.masterKey && options.masterKey.length !== 32) {
      throw new ServiceUnavailableError('Browser profile master key must contain exactly 32 bytes');
    }
    this.masterKey = options.masterKey ?? null;
  }

  private encryptionKey(): Buffer {
    if (this.masterKey) return this.masterKey;
    const encoded = process.env.RORCA_BROWSER_PROFILE_MASTER_KEY ?? '';
    const decoded = Buffer.from(encoded, 'base64');
    if (!encoded || decoded.length !== 32 || decoded.toString('base64') !== encoded) {
      throw new ServiceUnavailableError('RORCA_BROWSER_PROFILE_MASTER_KEY must contain exactly 32 random bytes in base64');
    }
    this.masterKey = decoded;
    return decoded;
  }

  async ensureReady(): Promise<void> {
    this.encryptionKey();
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700);
  }

  private profilePath(secretRef: string): string {
    if (!z.string().uuid().safeParse(secretRef).success) {
      throw new ValidationError('Browser profile SecretStore reference must be a UUID');
    }
    return path.join(this.root, `${secretRef}.profile.enc`);
  }

  async storeProfile(identity: BrowserProfileArtifactIdentity, profileBytes: Buffer): Promise<string> {
    if (profileBytes.length === 0) throw new ValidationError('Browser profile artifact must not be empty');
    const canonicalIdentity = canonicalArtifactIdentity(identity);
    await this.ensureReady();
    const secretRef = crypto.randomUUID();
    const identityBytes = profileIdentityBytes(secretRef, canonicalIdentity);
    const dataKey = crypto.randomBytes(32);
    const wrapIv = crypto.randomBytes(12);
    const wrapCipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey(), wrapIv);
    wrapCipher.setAAD(identityBytes);
    const wrappedKey = Buffer.concat([wrapCipher.update(dataKey), wrapCipher.final()]);
    const wrapTag = wrapCipher.getAuthTag();

    const profileIv = crypto.randomBytes(12);
    const profileCipher = crypto.createCipheriv('aes-256-gcm', dataKey, profileIv);
    profileCipher.setAAD(identityBytes);
    const ciphertext = Buffer.concat([profileCipher.update(profileBytes), profileCipher.final()]);
    const profileTag = profileCipher.getAuthTag();
    dataKey.fill(0);

    const header: ProfileEnvelopeHeader = {
      schemaVersion: 'rorca.encrypted-browser-profile.v1',
      secretRef,
      identityDigest: digestBytes(identityBytes),
      artifactDigest: digestBytes(profileBytes),
      artifactBytes: profileBytes.length,
      wrapIv: wrapIv.toString('base64'),
      wrapTag: wrapTag.toString('base64'),
      wrappedKey: wrappedKey.toString('base64'),
      profileIv: profileIv.toString('base64'),
      profileTag: profileTag.toString('base64'),
    };

    const target = this.profilePath(secretRef);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(header)}\n`, 'utf8');
        await handle.writeFile(ciphertext);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    return secretRef;
  }

  private async readEnvelope(secretRef: string): Promise<{ header: ProfileEnvelopeHeader; ciphertext: Buffer }> {
    let envelope: Buffer;
    try {
      envelope = await fs.readFile(this.profilePath(secretRef));
    } catch {
      throw new UnprocessableError('Encrypted browser profile artifact is unavailable', 'BROWSER_PROFILE_UNAVAILABLE');
    }
    const newline = envelope.indexOf(0x0a);
    if (newline < 1 || newline > 8192) {
      throw new UnprocessableError('Encrypted browser profile envelope is malformed', 'BROWSER_PROFILE_CORRUPT');
    }
    let header: ProfileEnvelopeHeader;
    try {
      header = ProfileEnvelopeHeaderSchema.parse(JSON.parse(envelope.subarray(0, newline).toString('utf8')));
    } catch {
      throw new UnprocessableError('Encrypted browser profile envelope is malformed', 'BROWSER_PROFILE_CORRUPT');
    }
    if (header.secretRef !== secretRef) {
      throw new UnprocessableError('Encrypted browser profile reference mismatch', 'BROWSER_PROFILE_CORRUPT');
    }
    const ciphertext = envelope.subarray(newline + 1);
    if (ciphertext.length === 0) {
      throw new UnprocessableError('Encrypted browser profile payload is empty', 'BROWSER_PROFILE_CORRUPT');
    }
    return { header, ciphertext };
  }

  private async decryptProfile(
    secretRef: string,
    identity: BrowserProfileArtifactIdentity,
  ): Promise<Buffer> {
    const canonicalIdentity = canonicalArtifactIdentity(identity);
    const { header, ciphertext } = await this.readEnvelope(secretRef);
    const identityBytes = profileIdentityBytes(secretRef, canonicalIdentity);
    if (header.identityDigest !== digestBytes(identityBytes)) {
      throw new ForbiddenError('Browser profile identity or domain policy does not match the encrypted artifact');
    }

    const dataKey = Buffer.alloc(32);
    let unwrappedKey: Buffer | null = null;
    let profileBytes: Buffer | null = null;
    try {
      const unwrap = crypto.createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey(),
        decodeBase64(header.wrapIv, 12, 'wrap IV'),
      );
      unwrap.setAAD(identityBytes);
      unwrap.setAuthTag(decodeBase64(header.wrapTag, 16, 'wrap tag'));
      unwrappedKey = Buffer.concat([
        unwrap.update(decodeBase64(header.wrappedKey, 32, 'wrapped key')),
        unwrap.final(),
      ]);
      if (unwrappedKey.length !== 32) throw new Error('invalid data key length');
      unwrappedKey.copy(dataKey);

      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        dataKey,
        decodeBase64(header.profileIv, 12, 'profile IV'),
      );
      decipher.setAAD(identityBytes);
      decipher.setAuthTag(decodeBase64(header.profileTag, 16, 'profile tag'));
      profileBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (profileBytes.length !== header.artifactBytes || digestBytes(profileBytes) !== header.artifactDigest) {
        throw new Error('profile digest mismatch');
      }
      return profileBytes;
    } catch (error) {
      profileBytes?.fill(0);
      if (error instanceof ForbiddenError || error instanceof UnprocessableError) throw error;
      throw new UnprocessableError('Encrypted browser profile failed integrity validation', 'BROWSER_PROFILE_CORRUPT');
    } finally {
      unwrappedKey?.fill(0);
      dataKey.fill(0);
    }
  }

  async verifyReference(secretRef: string, identity: BrowserProfileArtifactIdentity): Promise<boolean> {
    let profileBytes: Buffer | null = null;
    try {
      profileBytes = await this.decryptProfile(secretRef, identity);
      return true;
    } catch {
      return false;
    } finally {
      profileBytes?.fill(0);
    }
  }

  async mountProfile(
    secretRef: string,
    identity: BrowserProfileArtifactIdentity,
    runnerId: string,
    mountPort: IsolatedBrowserRunnerMountPort,
  ): Promise<void> {
    const profileBytes = await this.decryptProfile(secretRef, identity);
    try {
      await mountPort.mountProfile({
        runnerId,
        bindingId: identity.bindingId,
        profileGeneration: identity.profileGeneration,
        profileBytes,
        allowedOrigins: Object.freeze([...identity.allowedOrigins]),
        modelContextAccess: 'none',
        filesystemAccess: 'ephemeral-profile-only',
        artifactAccess: 'redacted-only',
      });
    } finally {
      profileBytes.fill(0);
    }
  }

  async destroyProfile(secretRef: string): Promise<void> {
    await fs.rm(this.profilePath(secretRef), { force: true });
  }
}

function uniqueSortedOrigins(origins: readonly string[]): string[] {
  const unique = [...new Set(origins)].sort();
  if (unique.length !== origins.length) throw new ValidationError('Browser profile origins must be unique');
  return unique;
}

function artifactIdentity(record: BrowserProfileBindingRecord): BrowserProfileArtifactIdentity {
  return {
    bindingId: record.id,
    workspaceId: record.workspaceId,
    externalProvider: record.externalProvider,
    accountAlias: record.accountAlias,
    profileGeneration: record.profileGeneration,
    allowedOrigins: record.allowedOrigins,
  };
}

function safeBinding(record: BrowserProfileBindingRecord): BrowserProfileProviderBinding | null {
  if (record.lifecycleState === 'pending' || record.profileSecretRef === null) return null;
  const verified = record.lifecycleState === 'active'
    && record.providerHealth === 'healthy'
    && record.sessionHealth === 'healthy';
  return BrowserProfileProviderBindingSchema.parse({
    providerId: 'browser-session',
    bindingId: record.id,
    workspaceId: record.workspaceId,
    bindingStatus: record.bindingStatus,
    externalProvider: record.externalProvider,
    accountAlias: record.accountAlias,
    allowedOrigins: record.allowedOrigins,
    profileGeneration: record.profileGeneration,
    profileStatus: record.lifecycleState,
    retentionPolicy: { mode: record.retentionMode, retainUntil: record.retainUntil },
    destructionPolicy: record.destructionPolicy,
    enrollmentProvenance: record.enrollmentProvenance,
    health: {
      provider: record.providerHealth,
      session: record.sessionHealth,
      observedAt: record.healthObservedAt,
    },
    secretReferences: [{ purpose: 'browser-profile-artifact', secretId: record.profileSecretRef }],
    providerProfileVerified: verified,
  });
}

export const BROWSER_SESSION_BROKER_CAPABILITIES: readonly AuthorityCapability[] = Object.freeze([
  'browser.profile.enroll',
  'browser.profile.read',
  'browser.profile.quarantine',
  'browser.profile.destroy',
  'browser.session.request',
  'browser.session.use',
  'browser.session.revoke',
  'browser.session.reconcile',
  'browser.authentication.read',
  'browser.authentication.resolve',
]);

export const BROWSER_PROFILE_HEALTH_MAX_AGE_MS = 5 * 60 * 1_000;
export const BROWSER_RUNNER_HEARTBEAT_TIMEOUT_MS = 60 * 1_000;
export const BROWSER_AUTHENTICATION_WAIT_MAX_MS = 10 * 60 * 1_000;

export interface BrowserSessionBrokerRecoveryAction {
  code: 'RECONCILE_RUNNER' | 'QUARANTINE_PROFILE' | 'RETRY_BROKER_ROLLBACK';
  bindingId: string | null;
  workspaceId: string | null;
  leaseId: string | null;
  runnerId: string | null;
  action: string;
}

export interface BrowserSessionBrokerDisableResult {
  status: 'disabled' | 'recovery_required';
  disabledAt: string;
  revokedLeaseIds: string[];
  terminatedRunnerIds: string[];
  quarantinedBindingIds: string[];
  revokedGrantCount: number;
  receipts: 'preserved';
  operatorRecoveryActions: BrowserSessionBrokerRecoveryAction[];
}

export class BrowserSessionBroker implements DeliveryAuthorityProviderAdapter {
  readonly contractVersion = DELIVERY_AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION;
  readonly descriptor = BROWSER_SESSION_BROKER_ADAPTER_DESCRIPTOR;
  readonly capabilities = BROWSER_SESSION_BROKER_CAPABILITIES;

  private readonly leaseRepository: BrowserSessionLeaseRepository;
  private readonly authenticationRepository: BrowserAuthenticationRequestRepository;
  private readonly runnerHost: BrowserSessionRunnerHost;
  private rollbackDisabled = false;
  private provisioningOperations = 0;
  private readonly provisioningWaiters = new Set<() => void>();
  private disableInFlight: Promise<BrowserSessionBrokerDisableResult> | null = null;

  constructor(
    private readonly repository: BrowserProfileRepository = new PostgresBrowserProfileRepository(),
    private readonly secretStore: BrowserProfileSecretStore = new EncryptedBrowserProfileSecretStore(),
    private readonly enabled: () => boolean = () => {
      const flag = process.env.RORCA_BROWSER_SESSION_BROKER_ENABLED?.trim().toLowerCase();
      return flag === 'true' || flag === '1';
    },
    private readonly now: () => string = () => new Date().toISOString(),
    leaseRepository?: BrowserSessionLeaseRepository,
    runnerHost?: BrowserSessionRunnerHost,
    authenticationRepository?: BrowserAuthenticationRequestRepository,
  ) {
    this.leaseRepository = leaseRepository ?? (
      repository instanceof PostgresBrowserProfileRepository
        ? new PostgresBrowserSessionLeaseRepository()
        : new UnavailableBrowserSessionLeaseRepository()
    );
    this.authenticationRepository = authenticationRepository ?? (
      repository instanceof PostgresBrowserProfileRepository
        ? new PostgresBrowserAuthenticationRequestRepository()
        : new UnavailableBrowserAuthenticationRequestRepository()
    );
    this.runnerHost = runnerHost ?? new LocalIsolatedBrowserSessionRunnerHost({
      now,
      onRecoveredSecurityEvent: (leaseId, event) => this.leaseRepository.recordSecurityEvent({
        leaseId,
        ...event,
        observedAt: this.now(),
      }),
    });
  }

  private assertEnabled(): void {
    if (this.rollbackDisabled || !this.enabled()) throw new ForbiddenError('Browser session broker is disabled');
  }

  private beginProvisioningOperation(): void {
    this.assertEnabled();
    this.provisioningOperations += 1;
  }

  private endProvisioningOperation(): void {
    this.provisioningOperations -= 1;
    if (this.provisioningOperations !== 0) return;
    for (const resolve of this.provisioningWaiters) resolve();
    this.provisioningWaiters.clear();
  }

  private async waitForProvisioningOperations(): Promise<void> {
    if (this.provisioningOperations === 0) return;
    await new Promise<void>((resolve) => this.provisioningWaiters.add(resolve));
  }

  async beginEnrollment(input: BeginBrowserProfileEnrollment): Promise<BrowserProfileBindingRecord> {
    this.beginProvisioningOperation();
    try {
      const parsed = BeginBrowserProfileEnrollmentSchema.parse(input);
      const allowedOrigins = uniqueSortedOrigins(parsed.allowedOrigins);
      await this.secretStore.ensureReady();
      const existing = await this.repository.findByIdentity(
        parsed.workspaceId,
        parsed.externalProvider,
        parsed.accountAlias,
      );
      if (existing) return this.requireMatchingPendingEnrollment(existing, parsed, allowedOrigins);
      const enrolledAt = this.now();
      const pending: BrowserProfileBindingRecord = {
        id: crypto.randomUUID(),
        workspaceId: parsed.workspaceId,
        externalProvider: parsed.externalProvider,
        accountAlias: parsed.accountAlias,
        allowedOrigins,
        profileGeneration: 1,
        profileSecretRef: null,
        lifecycleState: 'pending',
        bindingStatus: 'disabled',
        providerHealth: 'degraded',
        sessionHealth: 'unknown',
        healthObservedAt: enrolledAt,
        retentionMode: parsed.retentionPolicy.mode,
        retainUntil: parsed.retentionPolicy.retainUntil,
        destructionPolicy: parsed.destructionPolicy,
        enrollmentProvenance: {
          kind: 'human_operator',
          operatorId: parsed.operatorId,
          surface: 'operator_takeover',
          enrolledAt,
        },
      };
      try {
        return await this.repository.createPending(pending);
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        const raced = await this.repository.findByIdentity(
          parsed.workspaceId,
          parsed.externalProvider,
          parsed.accountAlias,
        );
        if (!raced) throw error;
        return this.requireMatchingPendingEnrollment(raced, parsed, allowedOrigins);
      }
    } finally {
      this.endProvisioningOperation();
    }
  }

  /** Trusted enrollment-runner boundary. Raw profile bytes must never call an
   * HTTP route; ownership transfers here and the supplied buffer is erased. */
  async captureEnrolledProfile(input: CaptureBrowserProfile, profileBytes: Buffer): Promise<BrowserProfileProviderBinding> {
    this.beginProvisioningOperation();
    try {
      const parsed = CaptureBrowserProfileSchema.parse(input);
      const record = await this.repository.findById(parsed.bindingId);
      if (!record) throw new NotFoundError('Browser profile binding', parsed.bindingId);
      if (record.lifecycleState !== 'pending') throw new ConflictError('Browser profile enrollment is already settled');
      if (record.workspaceId !== parsed.workspaceId
        || record.externalProvider !== parsed.externalProvider
        || record.accountAlias !== parsed.accountAlias) {
        throw new ForbiddenError('Browser profile enrollment identity does not match the provider binding');
      }

      const identity = artifactIdentity(record);
      const secretRef = await this.secretStore.storeProfile(identity, profileBytes);
      try {
        if (!await this.secretStore.verifyReference(secretRef, identity)) {
          throw new UnprocessableError('Encrypted browser profile identity verification failed', 'BROWSER_PROFILE_CORRUPT');
        }
        const completed = await this.repository.completeEnrollment(record.id, secretRef, parsed.health);
        const binding = safeBinding(completed);
        if (!binding) throw new UnprocessableError('Completed browser profile binding is invalid');
        return binding;
      } catch (error) {
        await this.secretStore.destroyProfile(secretRef);
        throw error;
      }
    } finally {
      profileBytes.fill(0);
      this.endProvisioningOperation();
    }
  }

  async getProviderBinding(workspaceId: string, selector?: ProviderBindingSelector): Promise<ProviderBinding | null> {
    if (this.rollbackDisabled || !this.enabled()) return null;
    if (!selector) throw new ValidationError('Browser profile lookup requires provider and account alias');
    const provider = BrowserExternalProviderSchema.parse(selector.externalProvider);
    const accountAlias = AccountAliasSchema.parse(selector.accountAlias);
    const record = await this.repository.findByIdentity(workspaceId, provider, accountAlias);
    return record ? safeBinding(record) : null;
  }

  async revalidateProviderBinding(workspaceId: string, bindingId: string): Promise<ProviderBinding> {
    const record = await this.repository.findById(bindingId);
    if (!record || record.workspaceId !== workspaceId) throw new NotFoundError('Browser session provider binding not found');
    const binding = safeBinding(record);
    if (!binding) throw new NotFoundError('Browser session provider binding is not enrolled');
    return binding;
  }


  /** Trusted authority boundary. The resulting grant contains policy metadata only. */
  async createSessionGrant(input: CreateBrowserSessionGrant): Promise<BrowserSessionGrantRecord> {
    this.beginProvisioningOperation();
    try {
      const parsed = CreateBrowserSessionGrantSchema.parse(input);
    const issuedAt = this.now();
    const profile = await this.requireLeaseEligibleProfile(parsed, issuedAt);
    if (Date.parse(parsed.expiresAt) <= Date.parse(issuedAt)) {
      throw new ConflictError('Browser session grant expiry must be in the future');
    }
    if (!parsed.allowedOrigins.every((origin) => profile.allowedOrigins.includes(origin))) {
      await this.repository.recordUseDenied(profile, 'grant_origin_broadened', parsed.allowedOrigins[0]!);
      throw new ForbiddenError('Browser session grant broadens the profile origin policy');
    }
    return this.leaseRepository.createGrant({
      ...parsed,
      id: crypto.randomUUID(),
      allowedOrigins: [...parsed.allowedOrigins].sort(),
      allowedActions: [...parsed.allowedActions].sort() as BrowserSessionActionName[],
      state: 'active',
      issuedAt,
      revokedAt: null,
      revocationReason: null,
      retentionMode: profile.retentionMode,
      retainUntil: profile.retainUntil,
      destructionPolicy: profile.destructionPolicy,
      }, this.healthStaleBefore(issuedAt));
    } finally {
      this.endProvisioningOperation();
    }
  }

  async requestSession(input: BrowserSessionRequest): Promise<BrowserSessionLeaseRecord> {
    this.beginProvisioningOperation();
    try {
      const parsed = BrowserSessionRequestSchema.parse(input);
    const issuedAt = this.now();
    const grant = await this.leaseRepository.findGrant(parsed.grantId);
    if (!grant) throw new NotFoundError('Browser session grant', parsed.grantId);
    this.assertGrantMatchesRequest(grant, parsed);
    if (grant.state !== 'active' || Date.parse(grant.expiresAt) <= Date.parse(issuedAt)) {
      throw new ConflictError('Browser session grant is expired or revoked');
    }
    if (Date.parse(parsed.expiresAt) <= Date.parse(issuedAt)
      || Date.parse(parsed.expiresAt) > Date.parse(grant.expiresAt)) {
      throw new ForbiddenError('Browser session lease expiry is outside its authority grant');
    }
    const profile = await this.requireLeaseEligibleProfile(parsed, issuedAt);
    if (!parsed.allowedOrigins.every((origin) => profile.allowedOrigins.includes(origin))) {
      await this.repository.recordUseDenied(profile, 'lease_origin_broadened', parsed.allowedOrigins[0]!);
      throw new ForbiddenError('Browser session lease broadens the profile origin policy');
    }

    const reserved = await this.leaseRepository.reserveLease({
      ...parsed,
      id: crypto.randomUUID(),
      runnerId: crypto.randomUUID(),
      state: 'provisioning',
      issuedAt,
      lastHeartbeatAt: issuedAt,
      revokedAt: null,
      revocationReason: null,
      maximumConcurrentRunners: grant.maximumConcurrentRunners,
      evidenceContract: grant.evidenceContract,
      retentionMode: grant.retentionMode,
      retainUntil: grant.retainUntil,
      destructionPolicy: grant.destructionPolicy,
    }, this.healthStaleBefore(issuedAt), this.heartbeatStaleBefore(issuedAt));

    try {
      const mountPort = await this.runnerHost.launch({
        leaseId: reserved.id,
        runnerId: reserved.runnerId,
        workspaceId: reserved.workspaceId,
        runId: reserved.runId,
        storyId: reserved.storyId,
        purpose: reserved.purpose,
        bindingId: reserved.bindingId,
        profileGeneration: reserved.profileGeneration,
        allowedOrigins: reserved.allowedOrigins,
        allowedActions: reserved.allowedActions,
        maximumConcurrentRunners: reserved.maximumConcurrentRunners,
        expiresAt: reserved.expiresAt,
        evidenceContract: reserved.evidenceContract,
        networkAccess: 'exact-origin-allowlist-only',
        modelContextAccess: 'none',
        filesystemAccess: 'ephemeral-profile-only',
        artifactAccess: 'redacted-only',
        onSecurityEvent: (event) => this.leaseRepository.recordSecurityEvent({
          leaseId: reserved.id,
          ...event,
          observedAt: this.now(),
        }),
      });
      await this.secretStore.mountProfile(
        profile.profileSecretRef!,
        artifactIdentity(profile),
        reserved.runnerId,
        mountPort,
      );
      return await this.leaseRepository.activateLease(reserved.id, this.now());
    } catch (error) {
      const termination = await this.terminateRunner(reserved.runnerId);
      let cleared = false;
      if (termination === 'terminated') {
        try {
          await this.runnerHost.clearEphemeralState(reserved.runnerId);
          cleared = true;
        } catch {
          cleared = false;
        }
      }
      if (termination === 'terminated' && cleared) {
        const revoked = await this.leaseRepository.completeRevocation(
          reserved.id,
          'runner_provisioning_failed',
          this.now(),
        );
        await this.applyLeaseRetention(revoked);
      } else {
        await this.leaseRepository.markUncertain(reserved.id, 'runner_provisioning_termination_uncertain', this.now());
      }
      throw error;
    }
    } finally {
      this.endProvisioningOperation();
    }
  }

  async useSession(input: BrowserSessionUse): Promise<BrowserSessionUseResult> {
    this.assertEnabled();
    const parsed = BrowserSessionUseSchema.parse(input);
    const usedAt = this.now();
    let requestedOrigin: string | null = null;
    if (parsed.action.type === 'navigate') {
      const url = new URL(parsed.action.url);
      const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
      requestedOrigin = url.username || url.password
        || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
        ? url.href
        : url.origin;
    }
    const lease = await this.leaseRepository.authorizeUse(
      parsed,
      requestedOrigin,
      usedAt,
      this.heartbeatStaleBefore(usedAt),
    );
    if (browserActionRequestsCredentialExtraction(parsed.action)) {
      await this.leaseRepository.recordSecurityEvent({
        leaseId: lease.id,
        reason: 'credential_extraction_attempt',
        requestedOrigin: null,
        effect: parsed.action.type,
        observedAt: usedAt,
      });
      throw new ForbiddenError('Browser session credential extraction is prohibited');
    }
    let actionResult: BrowserSessionActionResult;
    try {
      actionResult = await this.runnerHost.use(lease.runnerId, parsed.action);
    } catch (error) {
      if (error instanceof ForbiddenError) throw error;
      await this.leaseRepository.markUncertain(lease.id, 'runner_action_failed', this.now());
      throw error;
    }
    if (actionResult.kind === 'completed') {
      return {
        kind: 'completed',
        leaseId: lease.id,
        action: parsed.action.type,
        ...(actionResult.result === undefined ? {} : { result: actionResult.result }),
        usedAt,
      };
    }

    const observation = BrowserAuthenticationObservationSchema.parse(actionResult.observation);
    let authenticationRequest: BrowserAuthenticationRequestRecord;
    try {
      const checkpoint = await this.runnerHost.suspendForAuthentication(lease.runnerId, observation);
      const detectedAt = observation.observedAt;
      if (Date.parse(detectedAt) < Date.parse(usedAt)) {
        throw new UnprocessableError(
          'Browser authentication observation predates the authorized runner action',
          'BROWSER_AUTHENTICATION_OBSERVATION_STALE',
        );
      }
      const authenticationExpiresAt = new Date(Math.min(
        Date.parse(lease.expiresAt),
        Date.parse(detectedAt) + BROWSER_AUTHENTICATION_WAIT_MAX_MS,
      )).toISOString();
      authenticationRequest = await this.authenticationRepository.createWait({
        requestId: crypto.randomUUID(),
        leaseId: lease.id,
        bindingId: lease.bindingId,
        workspaceId: lease.workspaceId,
        externalProvider: lease.externalProvider,
        runId: lease.runId,
        storyId: lease.storyId,
        purpose: lease.purpose,
        profileGeneration: lease.profileGeneration,
        step: observation.step,
        evidence: observation,
        checkpointDigest: checkpoint.checkpointDigest,
        detectedAt,
        authenticationExpiresAt,
        state: 'WAITING_FOR_AUTHENTICATION',
        disposition: null,
        outcomeCode: null,
        runPauseOwned: false,
        resumeCount: 0,
        resolutionObservation: null,
        resolvedBy: null,
        resolvedAt: null,
        resumedAt: null,
      });
    } catch (error) {
      const termination = await this.terminateRunner(lease.runnerId);
      if (termination === 'terminated') {
        try {
          await this.runnerHost.clearEphemeralState(lease.runnerId);
          const revoked = await this.leaseRepository.completeRevocation(
            lease.id,
            'authentication_wait_persistence_failed',
            this.now(),
          );
          await this.applyLeaseRetention(revoked);
        } catch {
          await this.leaseRepository.markUncertain(
            lease.id,
            'authentication_wait_cleanup_uncertain',
            this.now(),
          );
        }
      } else {
        await this.leaseRepository.markUncertain(
          lease.id,
          'authentication_wait_termination_uncertain',
          this.now(),
        );
      }
      throw error;
    }

    if (authenticationRequest.step === 'anti_automation'
      || authenticationRequest.evidence.automationPolicy === 'prohibited') {
      authenticationRequest = await this.settleTerminalAuthentication(
        authenticationRequest,
        'POLICY_PROHIBITED',
        'terminal',
        'AUTHENTICATION_POLICY_PROHIBITED',
        'authentication_policy_prohibited',
        'broker:provider-policy',
        null,
      );
    }
    return {
      kind: 'authentication_required',
      leaseId: lease.id,
      action: parsed.action.type,
      usedAt,
      authenticationRequest,
    };
  }

  /** Trusted evidence boundary. It returns only opaque artifact IDs, digests, and redacted metadata. */
  async captureSessionEvidence(input: BrowserSessionEvidenceRequest): Promise<BrowserSessionEvidenceObservation> {
    this.assertEnabled();
    const parsed = BrowserSessionEvidenceRequestSchema.parse(input);
    const lease = await this.leaseRepository.findLease(parsed.leaseId);
    if (!lease) throw new NotFoundError('Browser session lease', parsed.leaseId);
    this.assertLeaseMatchesOperation(lease, parsed);
    if (lease.state !== 'active' || Date.parse(lease.expiresAt) <= Date.parse(this.now())) {
      throw new ConflictError('Browser session evidence requires an active unexpired lease', { state: lease.state });
    }
    return this.runnerHost.captureEvidence(lease.runnerId);
  }

  async getAuthenticationRequestForRun(
    workspaceId: string,
    runId: string,
  ): Promise<BrowserAuthenticationRequestRecord | null> {
    this.assertEnabled();
    const identity = z.object({
      workspaceId: z.string().trim().min(1).max(255),
      runId: z.string().trim().min(1).max(255),
    }).strict().parse({ workspaceId, runId });
    const request = await this.authenticationRepository.findLatestForRun(identity.workspaceId, identity.runId);
    if (!request || !this.authenticationRequestOpen(request)) return request;
    if (Date.parse(request.authenticationExpiresAt) > Date.parse(this.now())) return request;
    return this.settleTerminalAuthentication(
      request,
      'EXPIRED',
      'retryable',
      'AUTHENTICATION_EXPIRED',
      'authentication_expired',
      'broker:authentication-expiry',
      null,
    );
  }

  async resolveAuthentication(
    requestId: string,
    input: BrowserAuthenticationResolution,
    operatorId: string,
  ): Promise<BrowserAuthenticationRequestRecord> {
    this.assertEnabled();
    const parsedRequestId = z.string().uuid().parse(requestId);
    const parsed = BrowserAuthenticationResolutionSchema.parse(input);
    const parsedOperatorId = z.string().trim().min(1).max(255).parse(operatorId);
    const current = await this.authenticationRepository.findById(parsedRequestId);
    if (!current) throw new NotFoundError('Browser authentication request', parsedRequestId);
    if (current.workspaceId !== parsed.workspaceId || current.runId !== parsed.runId) {
      throw new ForbiddenError('Browser authentication resolution does not match its run');
    }
    if (!this.authenticationRequestOpen(current)) return current;
    if (Date.parse(current.authenticationExpiresAt) <= Date.parse(this.now())) {
      return this.settleTerminalAuthentication(
        current,
        'EXPIRED',
        'retryable',
        'AUTHENTICATION_EXPIRED',
        'authentication_expired',
        'broker:authentication-expiry',
        null,
      );
    }
    if (parsed.decision === 'cancel') {
      return this.settleTerminalAuthentication(
        current,
        'CANCELLED',
        'terminal',
        'AUTHENTICATION_CANCELLED',
        'authentication_cancelled',
        parsedOperatorId,
        null,
      );
    }
    if (parsed.decision === 'deny') {
      return this.settleTerminalAuthentication(
        current,
        'DENIED',
        'terminal',
        'AUTHENTICATION_DENIED',
        'authentication_denied',
        parsedOperatorId,
        null,
      );
    }
    if (current.evidence.automationPolicy === 'prohibited') {
      return this.settleTerminalAuthentication(
        current,
        'POLICY_PROHIBITED',
        'terminal',
        'AUTHENTICATION_POLICY_PROHIBITED',
        'authentication_policy_prohibited',
        parsedOperatorId,
        null,
      );
    }

    const claimed = await this.authenticationRepository.claimForRevalidation(
      current.requestId,
      current.workspaceId,
      current.runId,
      parsedOperatorId,
      this.now(),
    );
    let revalidation: BrowserAuthenticationRevalidation;
    let lease: BrowserSessionLeaseRecord;
    try {
      lease = await this.requireActiveAuthenticationLease(claimed);
      revalidation = BrowserAuthenticationRevalidationSchema.parse(
        await this.runnerHost.revalidateAuthentication(lease.runnerId, claimed),
      );
    } catch {
      return this.settleTerminalAuthentication(
        claimed,
        'UNHEALTHY',
        'retryable',
        'AUTHENTICATION_UNHEALTHY',
        'authentication_unhealthy',
        parsedOperatorId,
        null,
      );
    }
    const providerStateObservedAfterDetection = Date.parse(revalidation.observedAt)
      >= Date.parse(claimed.evidence.observedAt);
    if (!lease.allowedOrigins.includes(revalidation.currentOrigin)
      || !providerStateObservedAfterDetection) {
      return this.settleTerminalAuthentication(
        claimed,
        'UNHEALTHY',
        'retryable',
        'AUTHENTICATION_UNHEALTHY',
        'authentication_unhealthy',
        parsedOperatorId,
        null,
      );
    }
    if (revalidation.challengePresent) {
      throw new ConflictError(
        'Provider authentication state is still present; operator completion was not accepted',
        { requestId: claimed.requestId, step: claimed.step, state: claimed.state },
      );
    }
    if (revalidation.health.provider !== 'healthy' || revalidation.health.session !== 'healthy') {
      return this.settleTerminalAuthentication(
        claimed,
        'UNHEALTHY',
        'retryable',
        'AUTHENTICATION_UNHEALTHY',
        'authentication_unhealthy',
        parsedOperatorId,
        revalidation,
      );
    }
    try {
      const resumedLease = await this.requireActiveAuthenticationLease(claimed);
      await this.runnerHost.resumeAfterAuthentication(resumedLease.runnerId, claimed.requestId);
    } catch {
      return this.settleTerminalAuthentication(
        claimed,
        'UNHEALTHY',
        'retryable',
        'AUTHENTICATION_UNHEALTHY',
        'authentication_unhealthy',
        parsedOperatorId,
        null,
      );
    }
    return this.authenticationRepository.settle({
      requestId: claimed.requestId,
      workspaceId: claimed.workspaceId,
      runId: claimed.runId,
      expectedStates: ['REVALIDATING'],
      state: 'RESUMED',
      disposition: 'resumed',
      outcomeCode: 'AUTHENTICATION_RESUMED',
      resolutionObservation: revalidation,
      resolvedBy: parsedOperatorId,
      resolvedAt: this.now(),
    });
  }

  async revokeSession(input: BrowserSessionRevocation): Promise<BrowserSessionLeaseRecord> {
    this.assertEnabled();
    const parsed = BrowserSessionRevocationSchema.parse(input);
    const claimed = await this.leaseRepository.beginRevocation(parsed, this.now());
    const termination = await this.terminateRunner(claimed.runnerId);
    if (termination === 'uncertain') {
      await this.leaseRepository.markUncertain(claimed.id, 'runner_termination_uncertain', this.now());
      throw new ServiceUnavailableError('Browser runner termination is uncertain; reconciliation is required');
    }
    try {
      await this.runnerHost.clearEphemeralState(claimed.runnerId);
    } catch {
      await this.leaseRepository.markUncertain(claimed.id, 'runner_ephemeral_cleanup_uncertain', this.now());
      throw new ServiceUnavailableError('Browser runner cleanup is uncertain; reconciliation is required');
    }
    const revoked = await this.leaseRepository.completeRevocation(claimed.id, parsed.reason, this.now());
    await this.applyLeaseRetention(revoked);
    return revoked;
  }

  async reconcileSession(input: BrowserSessionReconciliation): Promise<BrowserSessionLeaseRecord> {
    this.assertEnabled();
    const parsed = BrowserSessionReconciliationSchema.parse(input);
    const lease = await this.leaseRepository.findLease(parsed.leaseId);
    if (!lease) throw new NotFoundError('Browser session lease', parsed.leaseId);
    this.assertLeaseMatchesOperation(lease, parsed);
    if (lease.state !== 'uncertain') {
      throw new ConflictError('Browser session lease is not awaiting reconciliation', { state: lease.state });
    }
    const result = await this.runnerHost.reconcile(lease.runnerId);
    if (result.termination === 'uncertain') {
      await this.leaseRepository.markUncertain(lease.id, 'runner_reconciliation_uncertain', this.now());
      throw new ServiceUnavailableError('Browser runner remains uncertain after reconciliation');
    }
    try {
      await this.runnerHost.clearEphemeralState(lease.runnerId);
    } catch {
      await this.leaseRepository.markUncertain(lease.id, 'runner_reconciliation_cleanup_uncertain', this.now());
      throw new ServiceUnavailableError('Browser runner cleanup remains uncertain after reconciliation');
    }
    const health = BrowserProfileHealthSchema.parse(result.health);
    const reconciled = await this.leaseRepository.completeReconciliation(lease.id, health, this.now());
    await this.applyLeaseRetention(reconciled);
    return reconciled;
  }

  async quarantineProfile(
    bindingId: string,
    workspaceId: string,
    reason: Extract<BrowserProfileLifecycleReason, 'operator_quarantine' | 'provider_unhealthy' | 'session_unhealthy'>,
  ): Promise<BrowserProfileProviderBinding> {
    this.assertEnabled();
    await this.terminateOpenProfileLeases(bindingId, workspaceId, `profile_${reason}`);
    const record = await this.repository.transitionLifecycle(bindingId, workspaceId, 'quarantined', reason);
    const binding = safeBinding(record);
    if (!binding) throw new UnprocessableError('Quarantined browser profile binding is invalid');
    return binding;
  }

  async deleteProfile(
    bindingId: string,
    workspaceId: string,
    reason: Extract<BrowserProfileLifecycleReason, 'operator_delete' | 'retention_expired'>,
  ): Promise<BrowserProfileProviderBinding> {
    this.assertEnabled();
    await this.terminateOpenProfileLeases(bindingId, workspaceId, `profile_${reason}`);
    const record = await this.repository.transitionLifecycle(bindingId, workspaceId, 'deleted', reason);
    if (!record.profileSecretRef) throw new UnprocessableError('Deleted browser profile lacks its SecretStore reference');
    await this.secretStore.destroyProfile(record.profileSecretRef);
    const binding = safeBinding(record);
    if (!binding) throw new UnprocessableError('Deleted browser profile binding is invalid');
    return binding;
  }

  async disableBroker(): Promise<BrowserSessionBrokerDisableResult> {
    this.rollbackDisabled = true;
    if (this.disableInFlight) return this.disableInFlight;
    const operation = this.performBrokerDisable();
    this.disableInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.disableInFlight === operation) this.disableInFlight = null;
    }
  }

  private async performBrokerDisable(): Promise<BrowserSessionBrokerDisableResult> {
    await this.waitForProvisioningOperations();
    const disabledAt = this.now();
    const revokedLeaseIds: string[] = [];
    const terminatedRunnerIds: string[] = [];
    const quarantinedBindingIds: string[] = [];
    const operatorRecoveryActions: BrowserSessionBrokerRecoveryAction[] = [];

    let leases: BrowserSessionLeaseRecord[] = [];
    try {
      leases = await this.leaseRepository.listOpenLeasesForBroker();
    } catch {
      operatorRecoveryActions.push({
        code: 'RETRY_BROKER_ROLLBACK',
        bindingId: null,
        workspaceId: null,
        leaseId: null,
        runnerId: null,
        action: 'Restore lease persistence, then call disableBroker again to enumerate and terminate every open runner.',
      });
    }
    for (const lease of leases) {
      try {
        let termination = await this.terminateRunner(lease.runnerId);
        if (termination === 'uncertain') {
          await this.leaseRepository.markUncertain(lease.id, 'broker_disable_termination_uncertain', this.now());
          const reconciliation = await this.runnerHost.reconcile(lease.runnerId);
          termination = reconciliation.termination;
          if (termination === 'uncertain') {
            throw new ServiceUnavailableError('Browser runner termination remains uncertain');
          }
          await this.runnerHost.clearEphemeralState(lease.runnerId);
          await this.leaseRepository.completeReconciliation(
            lease.id,
            BrowserProfileHealthSchema.parse(reconciliation.health),
            this.now(),
          );
        } else {
          await this.runnerHost.clearEphemeralState(lease.runnerId);
          await this.leaseRepository.completeRevocation(lease.id, 'broker_disabled', this.now());
        }
        terminatedRunnerIds.push(lease.runnerId);
        revokedLeaseIds.push(lease.id);
      } catch {
        try {
          await this.leaseRepository.markUncertain(lease.id, 'broker_disable_reconciliation_required', this.now());
        } catch {
          // The recovery action below remains authoritative when persistence is unavailable.
        }
        operatorRecoveryActions.push({
          code: 'RECONCILE_RUNNER',
          bindingId: lease.bindingId,
          workspaceId: lease.workspaceId,
          leaseId: lease.id,
          runnerId: lease.runnerId,
          action: `Restore runner supervision, reconcile lease ${lease.id}, and verify termination before re-enabling the broker.`,
        });
      }
    }

    let revokedGrantCount = 0;
    try {
      revokedGrantCount = await this.leaseRepository.revokeOpenGrants('broker_disabled', this.now());
    } catch {
      operatorRecoveryActions.push({
        code: 'RETRY_BROKER_ROLLBACK',
        bindingId: null,
        workspaceId: null,
        leaseId: null,
        runnerId: null,
        action: 'Restore grant persistence, then call disableBroker again to revoke every retained active grant.',
      });
    }

    let profiles: BrowserProfileBindingRecord[] = [];
    try {
      profiles = await this.repository.listActiveBindings();
    } catch {
      operatorRecoveryActions.push({
        code: 'RETRY_BROKER_ROLLBACK',
        bindingId: null,
        workspaceId: null,
        leaseId: null,
        runnerId: null,
        action: 'Restore profile persistence, then call disableBroker again to quarantine every active dedicated profile.',
      });
    }
    for (const profile of profiles) {
      try {
        await this.repository.transitionLifecycle(
          profile.id,
          profile.workspaceId,
          'quarantined',
          'operator_quarantine',
        );
        quarantinedBindingIds.push(profile.id);
      } catch {
        operatorRecoveryActions.push({
          code: 'QUARANTINE_PROFILE',
          bindingId: profile.id,
          workspaceId: profile.workspaceId,
          leaseId: null,
          runnerId: null,
          action: `Quarantine dedicated profile ${profile.id} and verify its lifecycle receipt before re-enabling the broker.`,
        });
      }
    }

    return {
      status: operatorRecoveryActions.length === 0 ? 'disabled' : 'recovery_required',
      disabledAt,
      revokedLeaseIds,
      terminatedRunnerIds,
      quarantinedBindingIds,
      revokedGrantCount,
      receipts: 'preserved',
      operatorRecoveryActions,
    };
  }

  private authenticationRequestOpen(request: BrowserAuthenticationRequestRecord): boolean {
    return request.state === 'WAITING_FOR_AUTHENTICATION' || request.state === 'REVALIDATING';
  }

  private async requireAuthenticationLease(
    request: BrowserAuthenticationRequestRecord,
  ): Promise<BrowserSessionLeaseRecord> {
    const lease = await this.leaseRepository.findLease(request.leaseId);
    if (!lease) throw new NotFoundError('Browser session lease', request.leaseId);
    this.assertLeaseMatchesOperation(lease, request);
    return lease;
  }

  private async requireActiveAuthenticationLease(
    request: BrowserAuthenticationRequestRecord,
  ): Promise<BrowserSessionLeaseRecord> {
    const lease = await this.requireAuthenticationLease(request);
    if (lease.state !== 'active' || Date.parse(lease.expiresAt) <= Date.parse(this.now())) {
      throw new ConflictError('Browser authentication resume requires an active unexpired lease', {
        state: lease.state,
      });
    }
    return lease;
  }

  private async settleTerminalAuthentication(
    request: BrowserAuthenticationRequestRecord,
    state: Extract<BrowserAuthenticationRequestState, 'CANCELLED' | 'DENIED' | 'EXPIRED' | 'UNHEALTHY' | 'POLICY_PROHIBITED'>,
    disposition: Extract<BrowserAuthenticationDisposition, 'terminal' | 'retryable'>,
    outcomeCode: Exclude<BrowserAuthenticationOutcomeCode, 'AUTHENTICATION_RESUMED'>,
    revocationReason: Extract<BrowserSessionRevocation['reason'],
      | 'authentication_cancelled'
      | 'authentication_denied'
      | 'authentication_expired'
      | 'authentication_unhealthy'
      | 'authentication_policy_prohibited'>,
    resolvedBy: string,
    resolutionObservation: BrowserAuthenticationRevalidation | null,
  ): Promise<BrowserAuthenticationRequestRecord> {
    if (!this.authenticationRequestOpen(request)) return request;
    const lease = await this.requireAuthenticationLease(request);
    try {
      await this.revokeSession({
        leaseId: lease.id,
        bindingId: lease.bindingId,
        workspaceId: lease.workspaceId,
        externalProvider: lease.externalProvider,
        runId: lease.runId,
        storyId: lease.storyId,
        purpose: lease.purpose,
        profileGeneration: lease.profileGeneration,
        reason: revocationReason,
      });
    } catch (error) {
      if (!(error instanceof ServiceUnavailableError)) throw error;
      // `revokeSession` has already fenced uncertain termination/cleanup in the
      // durable lease state. Settle the typed retry/terminal outcome while the
      // profile remains unavailable until explicit reconciliation.
    }
    return this.authenticationRepository.settle({
      requestId: request.requestId,
      workspaceId: request.workspaceId,
      runId: request.runId,
      expectedStates: request.state === 'REVALIDATING'
        ? ['REVALIDATING']
        : ['WAITING_FOR_AUTHENTICATION'],
      state,
      disposition,
      outcomeCode,
      resolutionObservation,
      resolvedBy,
      resolvedAt: this.now(),
    });
  }

  private requireMatchingPendingEnrollment(
    record: BrowserProfileBindingRecord,
    input: BeginBrowserProfileEnrollment,
    allowedOrigins: readonly string[],
  ): BrowserProfileBindingRecord {
    const exactPolicy = record.allowedOrigins.length === allowedOrigins.length
      && record.allowedOrigins.every((origin, index) => origin === allowedOrigins[index])
      && record.retentionMode === input.retentionPolicy.mode
      && record.retainUntil === input.retentionPolicy.retainUntil
      && record.destructionPolicy === input.destructionPolicy
      && record.enrollmentProvenance.operatorId === input.operatorId;
    if (record.lifecycleState !== 'pending' || !exactPolicy) {
      throw new ConflictError('Dedicated browser profile enrollment already exists with different or settled policy');
    }
    return record;
  }

  private healthStaleBefore(now: string): string {
    return new Date(Date.parse(now) - BROWSER_PROFILE_HEALTH_MAX_AGE_MS).toISOString();
  }

  private heartbeatStaleBefore(now: string): string {
    return new Date(Date.parse(now) - BROWSER_RUNNER_HEARTBEAT_TIMEOUT_MS).toISOString();
  }

  private async requireLeaseEligibleProfile(
    input: {
      bindingId: string;
      workspaceId: string;
      externalProvider: BrowserExternalProvider;
      profileGeneration: number;
      allowedOrigins: readonly string[];
    },
    observedAt: string,
  ): Promise<BrowserProfileBindingRecord> {
    const profile = await this.repository.findById(input.bindingId);
    if (!profile) throw new NotFoundError('Browser profile binding', input.bindingId);
    let denial: string | null = null;
    if (profile.workspaceId !== input.workspaceId) denial = 'workspace_mismatch';
    else if (profile.externalProvider !== input.externalProvider) denial = 'provider_mismatch';
    else if (profile.profileGeneration !== input.profileGeneration) denial = 'profile_generation_stale';
    else if (profile.lifecycleState !== 'active' || profile.bindingStatus !== 'active') denial = 'profile_not_active';
    else if (profile.providerHealth !== 'healthy' || profile.sessionHealth !== 'healthy') denial = 'profile_unhealthy';
    else if (Date.parse(profile.healthObservedAt) < Date.parse(this.healthStaleBefore(observedAt))) denial = 'profile_health_stale';
    else if (profile.profileSecretRef === null) denial = 'profile_artifact_missing';
    if (denial) {
      await this.repository.recordUseDenied(profile, denial, input.allowedOrigins[0] ?? '[none]');
      if (denial === 'profile_generation_stale' || denial === 'profile_health_stale') {
        throw new ConflictError('Browser session profile generation or health observation is stale', { reason: denial });
      }
      throw new ForbiddenError('Browser session profile is not eligible for leasing', { reason: denial });
    }
    return profile;
  }

  private assertGrantMatchesRequest(grant: BrowserSessionGrantRecord, request: BrowserSessionRequest): void {
    if (grant.bindingId !== request.bindingId
      || grant.workspaceId !== request.workspaceId
      || grant.externalProvider !== request.externalProvider
      || grant.runId !== request.runId
      || grant.storyId !== request.storyId
      || grant.purpose !== request.purpose
      || grant.profileGeneration !== request.profileGeneration) {
      throw new ForbiddenError('Browser session request does not match its authority grant');
    }
    if (!request.allowedOrigins.every((origin) => grant.allowedOrigins.includes(origin))
      || !request.allowedActions.every((action) => grant.allowedActions.includes(action))) {
      throw new ForbiddenError('Browser session request broadens its authority grant');
    }
  }

  private assertLeaseMatchesOperation(
    lease: BrowserSessionLeaseRecord,
    input: {
      bindingId: string;
      workspaceId: string;
      externalProvider: BrowserExternalProvider;
      runId: string;
      storyId: string;
      purpose: string;
      profileGeneration: number;
    },
  ): void {
    if (lease.bindingId !== input.bindingId
      || lease.workspaceId !== input.workspaceId
      || lease.externalProvider !== input.externalProvider
      || lease.runId !== input.runId
      || lease.storyId !== input.storyId
      || lease.purpose !== input.purpose
      || lease.profileGeneration !== input.profileGeneration) {
      throw new ForbiddenError('Browser session operation does not match its lease binding');
    }
  }

  private async terminateRunner(runnerId: string): Promise<'terminated' | 'uncertain'> {
    try {
      return await this.runnerHost.terminate(runnerId);
    } catch {
      return 'uncertain';
    }
  }

  private async terminateOpenProfileLeases(bindingId: string, workspaceId: string, reason: string): Promise<void> {
    const leases = await this.leaseRepository.listOpenLeases(bindingId, workspaceId);
    let uncertain = false;
    for (const lease of leases) {
      const termination = await this.terminateRunner(lease.runnerId);
      if (termination === 'uncertain') {
        uncertain = true;
        await this.leaseRepository.markUncertain(lease.id, 'profile_lifecycle_termination_uncertain', this.now());
        continue;
      }
      try {
        await this.runnerHost.clearEphemeralState(lease.runnerId);
        await this.leaseRepository.completeRevocation(lease.id, reason, this.now());
      } catch {
        uncertain = true;
        await this.leaseRepository.markUncertain(lease.id, 'profile_lifecycle_cleanup_uncertain', this.now());
      }
    }
    if (uncertain) {
      throw new ServiceUnavailableError('One or more browser runners require reconciliation before profile lifecycle settlement');
    }
  }

  private async applyLeaseRetention(lease: BrowserSessionLeaseRecord): Promise<void> {
    if (lease.retentionMode === 'preserve') return;
    if (lease.retentionMode === 'quarantine') {
      await this.quarantineProfile(lease.bindingId, lease.workspaceId, 'operator_quarantine');
      return;
    }
    const retentionReached = lease.retainUntil !== null
      && Date.parse(lease.retainUntil) <= Date.parse(this.now());
    if (retentionReached && lease.destructionPolicy === 'delete_after_retention') {
      await this.deleteProfile(lease.bindingId, lease.workspaceId, 'retention_expired');
      return;
    }
    await this.quarantineProfile(lease.bindingId, lease.workspaceId, 'operator_quarantine');
  }
}

export async function findBrowserProfileReceipts(bindingId: string, workspaceId: string): Promise<Array<{
  id: string;
  eventType: string;
  evidence: Record<string, unknown>;
  evidenceDigest: string;
  occurredAt: string;
}>> {
  const rows = await query<{
    id: string;
    event_type: string;
    evidence: Record<string, unknown>;
    evidence_digest: string;
    occurred_at: Date | string;
  }>(
    `SELECT id, event_type, evidence, evidence_digest, occurred_at
       FROM rorca.authority_provider_receipts
      WHERE binding_id = $1 AND workspace_id = $2
      ORDER BY occurred_at, id`,
    [bindingId, workspaceId],
  );
  return rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    evidence: row.evidence,
    evidenceDigest: row.evidence_digest,
    occurredAt: iso(row.occurred_at),
  }));
}


/** One process-wide runner authority so journey control and operator takeover share live runner state. */
export const browserSessionBroker = new BrowserSessionBroker();