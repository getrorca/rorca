/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Buffer } from 'node:buffer';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { canonicalTransaction, queryOne } from '../db/index';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from './errors';
import {
  StoredStripeCaptureSchema,
  StripeSecureCaptureResultSchema,
  PostgresStripeCredentialSecretStore,
  type StoredStripeCapture,
  type StripeCredentialSecretStore,
  type StripeSecureCaptureResult,
} from './stripe-credential-capture';
import {
  StripeCredentialCutoverService,
  type StripeCredentialCutoverState,
  type StripeDashboardRevocationEvidence,
} from './stripe-credential-cutover';
import { StripeAuthorityProviderAdapter } from './stripe-authority-provider-adapter';
import {
  createStripeRotationIntent,
  stripeOperatorCeremony,
  stripeRotationIntentAuthorityInput,
  stripeRotationIntentPayload,
  StripeRotationApprovalSchema,
  StripeRotationIntentInputSchema,
  StripeRotationIntentSchema,
  type StripeOperatorCeremony,
  type StripeRotationApproval,
  type StripeRotationIntent,
  type StripeRotationIntentInput,
} from './stripe-credential-rotation';
import { stableWalJson } from './trusted-wal';

const FingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const CaptureReceiptReferenceSchema = z.string().regex(/^credential-capture:\/\/rorca\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

export const StripeRotationLifecycleSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('WAITING_FOR_AUTHENTICATION'),
    timeoutDisposition: z.literal('paused'),
    activeElapsedMs: z.number().int().nonnegative(),
    waitingSince: z.string().datetime({ offset: true }),
    resumedAt: z.null(),
    resumeCount: z.literal(0),
    providerEvidenceDigest: z.null(),
    capture: z.null(),
  }).strict(),
  z.object({
    state: z.literal('READY_FOR_STAGING'),
    timeoutDisposition: z.literal('running'),
    activeElapsedMs: z.number().int().nonnegative(),
    waitingSince: z.string().datetime({ offset: true }),
    resumedAt: z.string().datetime({ offset: true }),
    resumeCount: z.literal(1),
    providerEvidenceDigest: FingerprintSchema,
    capture: StripeSecureCaptureResultSchema,
  }).strict(),
]);
export type StripeRotationLifecycle = z.infer<typeof StripeRotationLifecycleSchema>;

export const StripeRotationRecordSchema = z.object({
  intent: StripeRotationIntentSchema,
  lifecycle: StripeRotationLifecycleSchema,
}).strict();
export type StripeRotationRecord = z.infer<typeof StripeRotationRecordSchema>;

export const StripeRotationAuthenticationCompletionSchema = z.object({
  intentDigest: FingerprintSchema,
  captureReceiptReference: CaptureReceiptReferenceSchema,
}).strict();
export type StripeRotationAuthenticationCompletion = z.infer<typeof StripeRotationAuthenticationCompletionSchema>;

interface StripeRotationIntentRow {
  id: string;
  workspace_id: string;
  intent_digest: string;
  intent_payload: unknown;
  state: 'WAITING_FOR_AUTHENTICATION' | 'READY_FOR_STAGING';
  active_timeout_elapsed_ms: string | number;
  waiting_started_at: Date | string;
  resumed_at: Date | string | null;
  resume_count: string | number;
  provider_evidence_digest: string | null;
  capture_result: unknown | null;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function projectRotationRecord(row: StripeRotationIntentRow): StripeRotationRecord {
  const intent = StripeRotationIntentSchema.parse(row.intent_payload);
  if (intent.intentId !== row.id
      || intent.workspaceId !== row.workspace_id
      || intent.intentDigest !== row.intent_digest) {
    throw new ConflictError('Persisted Stripe rotation intent identity is inconsistent');
  }
  const activeElapsedMs = Number(row.active_timeout_elapsed_ms);
  const waitingSince = timestamp(row.waiting_started_at);
  const lifecycle = row.state === 'WAITING_FOR_AUTHENTICATION'
    ? {
      state: row.state,
      timeoutDisposition: 'paused' as const,
      activeElapsedMs,
      waitingSince,
      resumedAt: null,
      resumeCount: 0 as const,
      providerEvidenceDigest: null,
      capture: null,
    }
    : {
      state: row.state,
      timeoutDisposition: 'running' as const,
      activeElapsedMs,
      waitingSince,
      resumedAt: row.resumed_at === null ? null : timestamp(row.resumed_at),
      resumeCount: Number(row.resume_count),
      providerEvidenceDigest: row.provider_evidence_digest,
      capture: row.capture_result,
    };
  return StripeRotationRecordSchema.parse({ intent, lifecycle });
}

async function selectRotationIntent(
  client: PoolClient,
  workspaceId: string,
  intentId: string,
  lock = false,
): Promise<StripeRotationIntentRow | null> {
  const result = await client.query<StripeRotationIntentRow>(
    `SELECT id, workspace_id, intent_digest, intent_payload, state,
            active_timeout_elapsed_ms, waiting_started_at, resumed_at,
            resume_count, provider_evidence_digest, capture_result
       FROM provider_credential_rotation_intents
      WHERE workspace_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
    [workspaceId, intentId],
  );
  return result.rows[0] ?? null;
}

function sameManifest(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((permission, index) => permission === normalizedRight[index]);
}

export function assertStripeCaptureMatchesIntent(
  captureInput: StoredStripeCapture,
  intentInput: StripeRotationIntent,
): StoredStripeCapture {
  const capture = StoredStripeCaptureSchema.parse(captureInput);
  const intent = StripeRotationIntentSchema.parse(intentInput);
  if (capture.intentId !== intent.intentId
      || capture.intentDigest !== intent.intentDigest
      || capture.workspaceId !== intent.workspaceId
      || capture.accountId !== intent.accountId
      || capture.mode !== intent.mode
      || capture.targetBindingReference !== intent.targetBindingReference
      || capture.result.provenance.targetBindingReference !== intent.targetBindingReference) {
    throw new ForbiddenError('Stripe secure capture does not match the exact approved rotation intent');
  }
  if (!sameManifest(capture.permissionManifest, intent.permissionManifest)) {
    throw new ForbiddenError('Stripe secure capture permission manifest exceeds or differs from approval');
  }
  if (capture.result.fingerprint === intent.currentFingerprint) {
    throw new UnprocessableError(
      'Stripe replacement fingerprint must differ from the current binding',
      'STRIPE_REPLACEMENT_NOT_CHANGED',
    );
  }
  return capture;
}

export function resumeStripeRotationRecord(input: {
  record: StripeRotationRecord;
  intentDigest: string;
  capture: StoredStripeCapture;
  resumedAt: Date;
}): { record: StripeRotationRecord; resumed: boolean } {
  const record = StripeRotationRecordSchema.parse(input.record);
  if (record.intent.intentDigest !== input.intentDigest) {
    throw new ForbiddenError('Stripe authentication completion does not match the immutable intent digest');
  }
  const capture = assertStripeCaptureMatchesIntent(input.capture, record.intent);
  if (record.lifecycle.state === 'READY_FOR_STAGING') {
    if (record.lifecycle.providerEvidenceDigest !== capture.providerEvidenceDigest
        || record.lifecycle.capture.reference !== capture.result.reference
        || record.lifecycle.capture.fingerprint !== capture.result.fingerprint
        || record.lifecycle.capture.provenance.captureReceiptReference
          !== capture.result.provenance.captureReceiptReference) {
      throw new ConflictError('Stripe rotation intent already resumed with different capture evidence');
    }
    return { record, resumed: false };
  }
  return {
    record: StripeRotationRecordSchema.parse({
      intent: record.intent,
      lifecycle: {
        state: 'READY_FOR_STAGING',
        timeoutDisposition: 'running',
        activeElapsedMs: record.lifecycle.activeElapsedMs,
        waitingSince: record.lifecycle.waitingSince,
        resumedAt: input.resumedAt.toISOString(),
        resumeCount: 1,
        providerEvidenceDigest: capture.providerEvidenceDigest,
        capture: capture.result,
      },
    }),
    resumed: true,
  };
}

export interface StripeRotationIntentRepository {
  create(intent: StripeRotationIntent): Promise<StripeRotationRecord>;
  get(workspaceId: string, intentId: string): Promise<StripeRotationRecord | null>;
  resumeWithCapture(input: {
    workspaceId: string;
    intentId: string;
    intentDigest: string;
    capture: StoredStripeCapture;
    resumedAt: Date;
  }): Promise<{ record: StripeRotationRecord; resumed: boolean }>;
}

export class PostgresStripeRotationIntentRepository implements StripeRotationIntentRepository {
  async create(intentInput: StripeRotationIntent): Promise<StripeRotationRecord> {
    const intent = StripeRotationIntentSchema.parse(intentInput);
    const authorityPayload = stripeRotationIntentPayload(stripeRotationIntentAuthorityInput(intent));
    const canonicalIntentBytes = Buffer.from(stableWalJson(authorityPayload), 'utf8');
    return canonicalTransaction(async (client) => {
      const inserted = await client.query<StripeRotationIntentRow>(
        `INSERT INTO provider_credential_rotation_intents (
           id, workspace_id, provider, binding_id, provider_account_id,
           mode, current_fingerprint, permission_manifest,
           target_binding_reference, intent_digest, intent_canonical_bytes,
           intent_authority_payload, intent_payload, approval_digest,
           approval_receipt_id, state, active_timeout_elapsed_ms,
           waiting_started_at, resume_count
         ) VALUES ($1,$2,'stripe',$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,
                   $12::jsonb,$9,$13,'WAITING_FOR_AUTHENTICATION',0,$14,0)
         ON CONFLICT (id) DO NOTHING
         RETURNING id, workspace_id, intent_digest, intent_payload, state,
                   active_timeout_elapsed_ms, waiting_started_at, resumed_at,
                   resume_count, provider_evidence_digest, capture_result`,
        [intent.intentId, intent.workspaceId, intent.bindingId, intent.accountId,
          intent.mode, intent.currentFingerprint, JSON.stringify(intent.permissionManifest),
          intent.targetBindingReference, intent.intentDigest, canonicalIntentBytes,
          JSON.stringify(authorityPayload), JSON.stringify(intent),
          intent.approval.authorityReceiptId, intent.createdAt],
      );
      if (inserted.rows[0]) return projectRotationRecord(inserted.rows[0]);
      const existing = await selectRotationIntent(client, intent.workspaceId, intent.intentId);
      if (!existing || existing.intent_digest !== intent.intentDigest
          || stableWalJson(existing.intent_payload) !== stableWalJson(intent)) {
        throw new ConflictError('Stripe rotation intent identifier was already used for a different immutable intent');
      }
      return projectRotationRecord(existing);
    });
  }

  async get(workspaceId: string, intentId: string): Promise<StripeRotationRecord | null> {
    const row = await queryOne<StripeRotationIntentRow>(
      `SELECT id, workspace_id, intent_digest, intent_payload, state,
              active_timeout_elapsed_ms, waiting_started_at, resumed_at,
              resume_count, provider_evidence_digest, capture_result
         FROM provider_credential_rotation_intents
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, intentId],
    );
    return row ? projectRotationRecord(row) : null;
  }

  async resumeWithCapture(input: {
    workspaceId: string;
    intentId: string;
    intentDigest: string;
    capture: StoredStripeCapture;
    resumedAt: Date;
  }): Promise<{ record: StripeRotationRecord; resumed: boolean }> {
    return canonicalTransaction(async (client) => {
      const row = await selectRotationIntent(client, input.workspaceId, input.intentId, true);
      if (!row) throw new NotFoundError('Stripe rotation intent', input.intentId);
      const record = projectRotationRecord(row);
      const transition = resumeStripeRotationRecord({
        record,
        intentDigest: input.intentDigest,
        capture: input.capture,
        resumedAt: input.resumedAt,
      });
      if (!transition.resumed) return transition;
      const capture = StoredStripeCaptureSchema.parse(input.capture);
      const updated = await client.query<StripeRotationIntentRow>(
        `UPDATE provider_credential_rotation_intents
            SET state = 'READY_FOR_STAGING', timeout_disposition = 'running',
                resumed_at = $3, resume_count = 1,
                provider_evidence_digest = $4,
                capture_receipt_reference = $5,
                capture_result = $6::jsonb
          WHERE workspace_id = $1 AND id = $2
            AND state = 'WAITING_FOR_AUTHENTICATION' AND resume_count = 0
          RETURNING id, workspace_id, intent_digest, intent_payload, state,
                    active_timeout_elapsed_ms, waiting_started_at, resumed_at,
                    resume_count, provider_evidence_digest, capture_result`,
        [input.workspaceId, input.intentId, input.resumedAt.toISOString(),
          capture.providerEvidenceDigest, capture.result.provenance.captureReceiptReference,
          JSON.stringify(capture.result)],
      );
      if (!updated.rows[0]) throw new ConflictError('Stripe rotation authentication resume lost its single transition claim');
      return { record: projectRotationRecord(updated.rows[0]), resumed: true };
    });
  }
}

/** Backend workflow surface. Raw credential material is absent by construction. */
export class StripeCredentialRotationService {
  private readonly cutoverService: StripeCredentialCutoverService;

  constructor(
    private readonly stripeAdapter = new StripeAuthorityProviderAdapter(),
    private readonly repository: StripeRotationIntentRepository = new PostgresStripeRotationIntentRepository(),
    private readonly secretStore: StripeCredentialSecretStore = new PostgresStripeCredentialSecretStore(),
    cutoverService?: StripeCredentialCutoverService,
  ) {
    this.cutoverService = cutoverService ?? new StripeCredentialCutoverService(
      (workspaceId, intentId) => this.repository.get(workspaceId, intentId),
      this.stripeAdapter,
    );
  }

  async createApprovedIntent(input: {
    intent: StripeRotationIntentInput;
    approval: StripeRotationApproval;
    intentId?: string;
    now?: Date;
  }): Promise<StripeRotationRecord> {
    const intentInput = StripeRotationIntentInputSchema.parse(input.intent);
    const approval = StripeRotationApprovalSchema.parse(input.approval);
    const inventory = await this.stripeAdapter.inventory(intentInput.workspaceId);
    const binding = inventory.find((candidate) => candidate.bindingId === intentInput.bindingId);
    if (!binding) throw new NotFoundError('Stripe provider binding', intentInput.bindingId);
    const intent = createStripeRotationIntent({
      intentId: input.intentId,
      intent: intentInput,
      approval,
      binding,
      now: input.now,
    });
    return this.repository.create(intent);
  }

  async get(workspaceId: string, intentId: string): Promise<StripeRotationRecord | null> {
    return this.repository.get(workspaceId, intentId);
  }

  async getOperatorCeremony(workspaceId: string, intentId: string): Promise<StripeOperatorCeremony> {
    const record = await this.repository.get(workspaceId, intentId);
    if (!record) throw new NotFoundError('Stripe rotation intent', intentId);
    if (record.lifecycle.state !== 'WAITING_FOR_AUTHENTICATION') {
      throw new ConflictError('Stripe rotation intent is no longer waiting for operator authentication');
    }
    return stripeOperatorCeremony(record.intent);
  }

  async completeAuthentication(input: {
    workspaceId: string;
    intentId: string;
    completion: StripeRotationAuthenticationCompletion;
    now?: Date;
  }): Promise<StripeSecureCaptureResult> {
    const completion = StripeRotationAuthenticationCompletionSchema.parse(input.completion);
    const capture = await this.secretStore.getCapture(completion.captureReceiptReference);
    if (!capture) {
      throw new ForbiddenError('Verified Stripe Dashboard and SecretStore capture evidence is required');
    }
    const resumed = await this.repository.resumeWithCapture({
      workspaceId: input.workspaceId,
      intentId: input.intentId,
      intentDigest: completion.intentDigest,
      capture,
      resumedAt: input.now ?? new Date(),
    });
    return StripeSecureCaptureResultSchema.parse(resumed.record.lifecycle.capture);
  }

  async getCutover(workspaceId: string, intentId: string): Promise<StripeCredentialCutoverState | null> {
    return this.cutoverService.get(workspaceId, intentId);
  }

  async advanceCutover(input: {
    workspaceId: string;
    intentId: string;
    intentDigest: string;
    now?: Date;
  }): Promise<StripeCredentialCutoverState> {
    return this.cutoverService.advance(input);
  }

  async completeRevocation(input: {
    workspaceId: string;
    intentId: string;
    intentDigest: string;
    evidence: StripeDashboardRevocationEvidence;
    now?: Date;
  }): Promise<StripeCredentialCutoverState> {
    return this.cutoverService.completeRevocation(input);
  }
}
