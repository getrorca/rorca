/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { execute, queryOne } from '../db/index';
import {
  OpenRouterAuthorityProviderAdapter,
  type OpenRouterProviderBinding,
} from './openrouter-authority-provider-adapter';
import {
  OpenRouterRotationCutoverReceiptSchema,
  OpenRouterRotationRecoveryReceiptSchema,
} from './openrouter-runtime-key-cutover';
import {
  OpenRouterRotationIntentSchema,
  type OpenRouterRotationIntent,
} from './openrouter-runtime-key-rotation';
import {
  RuntimeProviderCompletionEvidenceSchema,
  RuntimeProviderRejectionEvidenceSchema,
  RuntimeSecretBindingReferenceSchema,
} from './openrouter-runtime-binding-adapter';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  UnprocessableError,
} from './errors';

export const OPENROUTER_ROTATION_POLICY_VERSION = 'rorca.openrouter-runtime-key-rotation-policy.v1' as const;
export const OPENROUTER_QUALIFICATION_RECEIPT_VERSION = 'rorca.openrouter-runtime-key-qualification-receipt.v1' as const;
export const OPENROUTER_QUALIFICATION_ROLLBACK_RECEIPT_VERSION = 'rorca.openrouter-runtime-key-qualification-rollback-receipt.v1' as const;
export const MAX_OPENROUTER_QUALIFICATION_SPEND_USD = 5;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const Sha256Schema = z.string().regex(SHA256_PATTERN);
const QualificationStateSchema = z.enum(['running', 'passed', 'failed', 'rolled-back']);
const ProviderBindingReferenceSchema = z.object({
  bindingId: z.string().uuid(),
  generation: z.number().int().positive(),
  providerAccountId: z.string().trim().min(1).max(255),
}).strict();

export const OpenRouterQualificationCrashBoundarySchema = z.enum([
  'after-provider-acceptance',
  'after-binding-stage',
  'after-deploy-acceptance',
  'after-canary-result',
  'after-cutover',
  'after-old-key-disable',
]);
export type OpenRouterQualificationCrashBoundary = z.infer<typeof OpenRouterQualificationCrashBoundarySchema>;
const REQUIRED_CRASH_BOUNDARIES = Object.freeze([...OpenRouterQualificationCrashBoundarySchema.options]);

export const OpenRouterQualificationMaterialSchema = z.object({
  qualificationId: z.string().uuid(),
  fixtureId: z.string().trim().min(1).max(120),
  workspaceId: z.string().trim().min(1).max(255),
  providerBinding: ProviderBindingReferenceSchema,
  targetBinding: RuntimeSecretBindingReferenceSchema,
  spendLimitUsd: z.number().positive().max(MAX_OPENROUTER_QUALIFICATION_SPEND_USD),
  timeoutMs: z.number().int().positive().max(3_600_000),
  grantIssuedAt: z.string().datetime(),
  grantExpiresAt: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.grantExpiresAt) <= Date.parse(value.grantIssuedAt)) {
    ctx.addIssue({ code: 'custom', path: ['grantExpiresAt'], message: 'qualification grant must expire after issuance' });
  }
  if (value.targetBinding.workspaceId !== value.workspaceId) {
    ctx.addIssue({ code: 'custom', path: ['targetBinding', 'workspaceId'], message: 'target workspace must match qualification workspace' });
  }
});
export type OpenRouterQualificationMaterial = z.infer<typeof OpenRouterQualificationMaterialSchema>;

export const ExecuteOpenRouterQualificationInputSchema = OpenRouterQualificationMaterialSchema.safeExtend({
  requestDigest: Sha256Schema,
}).strict();
export type ExecuteOpenRouterQualificationInput = z.infer<typeof ExecuteOpenRouterQualificationInputSchema>;

export const OpenRouterQualificationFixtureDescriptorSchema = z.object({
  fixtureId: z.string().trim().min(1).max(120),
  owner: z.literal('rorca'),
  provider: z.literal('openrouter'),
  accountClass: z.literal('dedicated-low-limit'),
  disposable: z.literal(true),
  targetBinding: RuntimeSecretBindingReferenceSchema,
}).strict();
export type OpenRouterQualificationFixtureDescriptor = z.infer<typeof OpenRouterQualificationFixtureDescriptorSchema>;

const DeniedBeforeProviderCallSchema = z.object({
  outcome: z.literal('denied'),
  providerCallMade: z.literal(false),
}).strict();

const KnownProviderResourceSchema = z.object({
  resourceId: z.string().trim().min(1).max(255),
  providerStatus: z.enum(['disabled', 'deleted']),
  lifecycleState: z.enum(['revoked', 'reconciled']),
}).strict();

const CrashRecoveryEvidenceSchema = z.object({
  boundary: OpenRouterQualificationCrashBoundarySchema,
  replacementCreateCount: z.literal(1),
  resumeCount: z.literal(1),
  targetFunctional: z.literal(true),
  providerKeysKnown: z.literal(true),
}).strict();

export const OpenRouterLiveQualificationEvidenceSchema = z.object({
  schemaVersion: z.literal('rorca.openrouter-runtime-key-live-evidence.v1'),
  fixture: OpenRouterQualificationFixtureDescriptorSchema,
  spend: z.object({
    declaredLimitUsd: z.number().positive().max(MAX_OPENROUTER_QUALIFICATION_SPEND_USD),
    observedUsd: z.number().nonnegative(),
  }).strict(),
  successfulRotation: z.object({
    cutoverReceipt: OpenRouterRotationCutoverReceiptSchema,
    completion: RuntimeProviderCompletionEvidenceSchema,
    oldKeyRejection: RuntimeProviderRejectionEvidenceSchema,
  }).strict(),
  security: z.object({
    promptExtraction: z.object({
      completion: RuntimeProviderCompletionEvidenceSchema,
      secretMaterialObserved: z.literal(false),
    }).strict(),
    crossWorkspace: DeniedBeforeProviderCallSchema,
    crossEnvironment: DeniedBeforeProviderCallSchema,
    alteredIntent: DeniedBeforeProviderCallSchema,
    replay: DeniedBeforeProviderCallSchema,
    expiredGrant: DeniedBeforeProviderCallSchema,
    revokedKeyReuse: z.object({
      outcome: z.literal('denied'),
      rejection: RuntimeProviderRejectionEvidenceSchema,
    }).strict(),
  }).strict(),
  rollback: z.object({
    receipt: OpenRouterRotationRecoveryReceiptSchema,
    priorTargetFunctional: z.literal(true),
    priorBindingRestored: z.literal(true),
  }).strict(),
  crashRecovery: z.array(CrashRecoveryEvidenceSchema).length(REQUIRED_CRASH_BOUNDARIES.length),
  providerCleanup: z.object({
    completed: z.literal(true),
    resources: z.array(KnownProviderResourceSchema).min(1),
  }).strict(),
  receiptsPreserved: z.literal(true),
  completedAt: z.string().datetime(),
}).strict();
export type OpenRouterLiveQualificationEvidence = z.infer<typeof OpenRouterLiveQualificationEvidenceSchema>;

export const OpenRouterQualificationReceiptSchema = z.object({
  schemaVersion: z.literal(OPENROUTER_QUALIFICATION_RECEIPT_VERSION),
  qualificationId: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(255),
  providerBinding: ProviderBindingReferenceSchema,
  fixture: OpenRouterQualificationFixtureDescriptorSchema,
  spend: z.object({
    declaredLimitUsd: z.number().positive().max(MAX_OPENROUTER_QUALIFICATION_SPEND_USD),
    observedUsd: z.number().nonnegative(),
  }).strict(),
  successfulCutoverReceiptId: z.string().uuid(),
  rollbackReceiptId: z.string().uuid(),
  evidenceDigest: Sha256Schema,
  qualifiedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  receiptDigest: Sha256Schema,
}).strict();
export type OpenRouterQualificationReceipt = z.infer<typeof OpenRouterQualificationReceiptSchema>;

export const OpenRouterRotationPolicyMaterialSchema = z.object({
  policyVersion: z.literal(OPENROUTER_ROTATION_POLICY_VERSION),
  qualificationId: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(255),
  providerBinding: ProviderBindingReferenceSchema,
  targetBinding: RuntimeSecretBindingReferenceSchema,
  maxRotationCreditUsd: z.number().positive().max(MAX_OPENROUTER_QUALIFICATION_SPEND_USD),
  expiresAt: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  if (value.targetBinding.workspaceId !== value.workspaceId) {
    ctx.addIssue({ code: 'custom', path: ['targetBinding', 'workspaceId'], message: 'policy target workspace must match policy workspace' });
  }
});
export type OpenRouterRotationPolicyMaterial = z.infer<typeof OpenRouterRotationPolicyMaterialSchema>;

export const AcceptOpenRouterRotationPolicyInputSchema = OpenRouterRotationPolicyMaterialSchema.safeExtend({
  policyDigest: Sha256Schema,
}).strict();
export type AcceptOpenRouterRotationPolicyInput = z.infer<typeof AcceptOpenRouterRotationPolicyInputSchema>;

export const OpenRouterRotationPolicyRecordSchema = OpenRouterRotationPolicyMaterialSchema.safeExtend({
  policyDigest: Sha256Schema,
  status: z.enum(['active', 'disabled']),
  acceptedAt: z.string().datetime(),
  disabledAt: z.string().datetime().nullable(),
}).strict();
export type OpenRouterRotationPolicyRecord = z.infer<typeof OpenRouterRotationPolicyRecordSchema>;

export const OpenRouterQualificationRollbackEvidenceSchema = z.object({
  targetFunctional: z.literal(true),
  priorBindingRestored: z.literal(true),
  replacements: z.array(KnownProviderResourceSchema).min(1),
  receiptsPreserved: z.literal(true),
  completedAt: z.string().datetime(),
}).strict();
export type OpenRouterQualificationRollbackEvidence = z.infer<typeof OpenRouterQualificationRollbackEvidenceSchema>;

export const OpenRouterQualificationRollbackReceiptSchema = z.object({
  schemaVersion: z.literal(OPENROUTER_QUALIFICATION_ROLLBACK_RECEIPT_VERSION),
  qualificationId: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(255),
  providerBinding: ProviderBindingReferenceSchema,
  targetBinding: RuntimeSecretBindingReferenceSchema,
  qualificationReceiptDigest: Sha256Schema,
  replacements: z.array(KnownProviderResourceSchema).min(1),
  targetFunctional: z.literal(true),
  priorBindingRestored: z.literal(true),
  receiptsPreserved: z.literal(true),
  rolledBackAt: z.string().datetime(),
  receiptDigest: Sha256Schema,
}).strict();
export type OpenRouterQualificationRollbackReceipt = z.infer<typeof OpenRouterQualificationRollbackReceiptSchema>;

export interface OpenRouterQualificationFixture {
  readonly descriptor: OpenRouterQualificationFixtureDescriptor;
  execute(
    input: Readonly<ExecuteOpenRouterQualificationInput>,
    signal: AbortSignal,
  ): Promise<OpenRouterLiveQualificationEvidence>;
  rollback(
    receipt: Readonly<OpenRouterQualificationReceipt>,
    signal: AbortSignal,
  ): Promise<OpenRouterQualificationRollbackEvidence>;
}

export class OpenRouterQualificationFixtureRegistry {
  private readonly fixtures = new Map<string, OpenRouterQualificationFixture>();

  register(fixture: OpenRouterQualificationFixture): () => void {
    const descriptor = OpenRouterQualificationFixtureDescriptorSchema.parse(fixture.descriptor);
    if (this.fixtures.has(descriptor.fixtureId)) {
      throw new ConflictError(`OpenRouter qualification fixture ${descriptor.fixtureId} is already registered`);
    }
    this.fixtures.set(descriptor.fixtureId, fixture);
    return () => {
      if (this.fixtures.get(descriptor.fixtureId) === fixture) this.fixtures.delete(descriptor.fixtureId);
    };
  }

  resolve(fixtureId: string): OpenRouterQualificationFixture | null {
    return this.fixtures.get(fixtureId) ?? null;
  }
}

export const openRouterQualificationFixtures = new OpenRouterQualificationFixtureRegistry();

export interface OpenRouterQualificationRecord {
  qualificationId: string;
  workspaceId: string;
  providerBinding: z.infer<typeof ProviderBindingReferenceSchema>;
  fixtureId: string;
  targetBinding: z.infer<typeof RuntimeSecretBindingReferenceSchema>;
  spendLimitUsd: number;
  observedSpendUsd: number | null;
  timeoutMs: number;
  requestDigest: string;
  grantIssuedAt: string;
  grantExpiresAt: string;
  state: z.infer<typeof QualificationStateSchema>;
  receipt: OpenRouterQualificationReceipt | null;
  failureCode: string | null;
  rollbackReceipt: OpenRouterQualificationRollbackReceipt | null;
}

export interface OpenRouterQualificationStore {
  claim(input: ExecuteOpenRouterQualificationInput): Promise<boolean>;
  complete(
    input: ExecuteOpenRouterQualificationInput,
    evidence: OpenRouterLiveQualificationEvidence,
    receipt: OpenRouterQualificationReceipt,
  ): Promise<void>;
  fail(qualificationId: string, failureCode: string): Promise<void>;
  read(qualificationId: string): Promise<OpenRouterQualificationRecord | null>;
  acceptPolicy(policy: OpenRouterRotationPolicyRecord): Promise<boolean>;
  readPolicy(workspaceId: string, bindingId: string): Promise<OpenRouterRotationPolicyRecord | null>;
  disablePolicy(workspaceId: string, bindingId: string, disabledAt: string): Promise<void>;
  recordRollback(qualificationId: string, receipt: OpenRouterQualificationRollbackReceipt): Promise<void>;
}

interface QualificationRow {
  id: string;
  workspace_id: string;
  provider_binding_id: string;
  binding_generation: number | string;
  provider_account_id: string;
  fixture_id: string;
  target_binding: unknown;
  spend_limit_usd: number | string;
  observed_spend_usd: number | string | null;
  timeout_ms: number | string;
  request_digest: string;
  grant_issued_at: Date | string;
  grant_expires_at: Date | string;
  state: string;
  receipt: unknown | null;
  failure_code: string | null;
  rollback_receipt: unknown | null;
}

interface PolicyRow {
  policy: unknown;
  policy_digest: string;
  status: string;
  accepted_at: Date | string;
  disabled_at: Date | string | null;
}

function jsonValue<T>(value: T | string): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapQualification(row: QualificationRow): OpenRouterQualificationRecord {
  return {
    qualificationId: row.id,
    workspaceId: row.workspace_id,
    providerBinding: ProviderBindingReferenceSchema.parse({
      bindingId: row.provider_binding_id,
      generation: Number(row.binding_generation),
      providerAccountId: row.provider_account_id,
    }),
    fixtureId: row.fixture_id,
    targetBinding: RuntimeSecretBindingReferenceSchema.parse(jsonValue(row.target_binding)),
    spendLimitUsd: Number(row.spend_limit_usd),
    observedSpendUsd: row.observed_spend_usd === null ? null : Number(row.observed_spend_usd),
    timeoutMs: Number(row.timeout_ms),
    requestDigest: row.request_digest,
    grantIssuedAt: iso(row.grant_issued_at),
    grantExpiresAt: iso(row.grant_expires_at),
    state: QualificationStateSchema.parse(row.state),
    receipt: row.receipt === null ? null : OpenRouterQualificationReceiptSchema.parse(jsonValue(row.receipt)),
    failureCode: row.failure_code,
    rollbackReceipt: row.rollback_receipt === null
      ? null
      : OpenRouterQualificationRollbackReceiptSchema.parse(jsonValue(row.rollback_receipt)),
  };
}

export const databaseOpenRouterQualificationStore: OpenRouterQualificationStore = {
  async claim(input) {
    const result = await execute(
      `INSERT INTO runtime_key_rotation_qualifications
         (id, workspace_id, provider_binding_id, binding_generation, provider_account_id,
          fixture_id, target_binding, spend_limit_usd, timeout_ms, request_digest,
          grant_issued_at, grant_expires_at, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, 'running')
       ON CONFLICT DO NOTHING`,
      [
        input.qualificationId,
        input.workspaceId,
        input.providerBinding.bindingId,
        input.providerBinding.generation,
        input.providerBinding.providerAccountId,
        input.fixtureId,
        JSON.stringify(input.targetBinding),
        input.spendLimitUsd,
        input.timeoutMs,
        input.requestDigest,
        input.grantIssuedAt,
        input.grantExpiresAt,
      ],
    );
    return result.rowCount === 1;
  },

  async complete(input, evidence, receipt) {
    const result = await execute(
      `UPDATE runtime_key_rotation_qualifications
          SET state = 'passed', evidence = $2::jsonb, receipt = $3::jsonb,
              receipt_digest = $4, observed_spend_usd = $5, completed_at = $6
        WHERE id = $1 AND state = 'running' AND request_digest = $7`,
      [
        input.qualificationId,
        JSON.stringify(evidence),
        JSON.stringify(receipt),
        receipt.receiptDigest,
        evidence.spend.observedUsd,
        receipt.qualifiedAt,
        input.requestDigest,
      ],
    );
    if (result.rowCount !== 1) {
      throw new ConflictError('OpenRouter qualification completion fence was lost');
    }
  },

  async fail(qualificationId, failureCode) {
    await execute(
      `UPDATE runtime_key_rotation_qualifications
          SET state = 'failed', failure_code = $2, completed_at = NOW()
        WHERE id = $1 AND state = 'running'`,
      [qualificationId, failureCode],
    );
  },

  async read(qualificationId) {
    const row = await queryOne<QualificationRow>(
      `SELECT id, workspace_id, provider_binding_id, binding_generation, provider_account_id,
              fixture_id, target_binding, spend_limit_usd, observed_spend_usd, timeout_ms,
              request_digest, grant_issued_at, grant_expires_at, state, receipt,
              failure_code, rollback_receipt
         FROM runtime_key_rotation_qualifications
        WHERE id = $1`,
      [qualificationId],
    );
    return row ? mapQualification(row) : null;
  },

  async acceptPolicy(policy) {
    const result = await execute(
      `INSERT INTO runtime_key_rotation_policies
         (provider_binding_id, workspace_id, binding_generation, provider_account_id,
          qualification_id, policy_version, policy_digest, policy, status, accepted_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'active', $9, $10)
       ON CONFLICT (provider_binding_id) DO UPDATE
         SET qualification_id = EXCLUDED.qualification_id,
             binding_generation = EXCLUDED.binding_generation,
             provider_account_id = EXCLUDED.provider_account_id,
             policy_version = EXCLUDED.policy_version,
             policy_digest = EXCLUDED.policy_digest,
             policy = EXCLUDED.policy,
             status = 'active',
             accepted_at = EXCLUDED.accepted_at,
             expires_at = EXCLUDED.expires_at,
             disabled_at = NULL,
             updated_at = NOW()
       WHERE runtime_key_rotation_policies.status = 'disabled'`,
      [
        policy.providerBinding.bindingId,
        policy.workspaceId,
        policy.providerBinding.generation,
        policy.providerBinding.providerAccountId,
        policy.qualificationId,
        policy.policyVersion,
        policy.policyDigest,
        JSON.stringify({
          policyVersion: policy.policyVersion,
          qualificationId: policy.qualificationId,
          workspaceId: policy.workspaceId,
          providerBinding: policy.providerBinding,
          targetBinding: policy.targetBinding,
          maxRotationCreditUsd: policy.maxRotationCreditUsd,
          expiresAt: policy.expiresAt,
        }),
        policy.acceptedAt,
        policy.expiresAt,
      ],
    );
    return result.rowCount === 1;
  },

  async readPolicy(workspaceId, bindingId) {
    const row = await queryOne<PolicyRow>(
      `SELECT policy, policy_digest, status, accepted_at, disabled_at
         FROM runtime_key_rotation_policies
        WHERE workspace_id = $1 AND provider_binding_id = $2`,
      [workspaceId, bindingId],
    );
    if (!row) return null;
    const material = OpenRouterRotationPolicyMaterialSchema.parse(jsonValue(row.policy));
    return OpenRouterRotationPolicyRecordSchema.parse({
      ...material,
      policyDigest: row.policy_digest,
      status: row.status,
      acceptedAt: iso(row.accepted_at),
      disabledAt: row.disabled_at === null ? null : iso(row.disabled_at),
    });
  },

  async disablePolicy(workspaceId, bindingId, disabledAt) {
    await execute(
      `UPDATE runtime_key_rotation_policies
          SET status = 'disabled', disabled_at = COALESCE(disabled_at, $3), updated_at = NOW()
        WHERE workspace_id = $1 AND provider_binding_id = $2 AND status = 'active'`,
      [workspaceId, bindingId, disabledAt],
    );
  },

  async recordRollback(qualificationId, receipt) {
    const result = await execute(
      `UPDATE runtime_key_rotation_qualifications
          SET state = 'rolled-back', rollback_receipt = $2::jsonb, rolled_back_at = $3
        WHERE id = $1 AND state = 'passed'`,
      [qualificationId, JSON.stringify(receipt), receipt.rolledBackAt],
    );
    if (result.rowCount !== 1) throw new ConflictError('OpenRouter qualification rollback fence was lost');
  },
};

export interface OpenRouterQualificationAuthority {
  getProviderBinding(workspaceId: string): Promise<OpenRouterProviderBinding | null>;
}

function digest(domain: string, value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(domain).update(JSON.stringify(value)).digest('hex')}`;
}

export function calculateOpenRouterQualificationDigest(
  rawMaterial: OpenRouterQualificationMaterial,
): `sha256:${string}` {
  const material = OpenRouterQualificationMaterialSchema.parse(rawMaterial);
  return digest('rorca.openrouter-runtime-key-qualification.v1\0', material);
}

export function calculateOpenRouterRotationPolicyDigest(
  rawMaterial: OpenRouterRotationPolicyMaterial,
): `sha256:${string}` {
  const material = OpenRouterRotationPolicyMaterialSchema.parse(rawMaterial);
  return digest('rorca.openrouter-runtime-key-rotation-policy.v1\0', material);
}

function exactBindingMatches(
  binding: OpenRouterProviderBinding,
  reference: z.infer<typeof ProviderBindingReferenceSchema>,
): boolean {
  return binding.bindingId === reference.bindingId
    && binding.generation === reference.generation
    && binding.providerAccountId === reference.providerAccountId;
}

function targetMatches(
  left: z.infer<typeof RuntimeSecretBindingReferenceSchema>,
  right: z.infer<typeof RuntimeSecretBindingReferenceSchema>,
): boolean {
  return left.adapterId === right.adapterId
    && left.bindingId === right.bindingId
    && left.workspaceId === right.workspaceId
    && left.environmentId === right.environmentId
    && left.generation === right.generation;
}

function assertCrashCoverage(evidence: OpenRouterLiveQualificationEvidence): void {
  const boundaries = evidence.crashRecovery.map((item) => item.boundary);
  if (new Set(boundaries).size !== REQUIRED_CRASH_BOUNDARIES.length
      || REQUIRED_CRASH_BOUNDARIES.some((boundary) => !boundaries.includes(boundary))) {
    throw new UnprocessableError(
      'Live qualification did not reconcile every required crash boundary',
      'OPENROUTER_QUALIFICATION_CRASH_COVERAGE_INVALID',
    );
  }
}

function assertLiveEvidence(
  evidence: OpenRouterLiveQualificationEvidence,
  input: ExecuteOpenRouterQualificationInput,
  descriptor: OpenRouterQualificationFixtureDescriptor,
): void {
  if (evidence.fixture.fixtureId !== descriptor.fixtureId
      || !targetMatches(evidence.fixture.targetBinding, input.targetBinding)) {
    throw new UnprocessableError(
      'Live qualification evidence does not match the exact Rorca fixture',
      'OPENROUTER_QUALIFICATION_FIXTURE_MISMATCH',
    );
  }
  if (evidence.spend.declaredLimitUsd !== input.spendLimitUsd
      || evidence.spend.observedUsd > input.spendLimitUsd) {
    throw new UnprocessableError(
      'Live qualification exceeded its declared spend limit',
      'OPENROUTER_QUALIFICATION_SPEND_EXCEEDED',
    );
  }
  const success = evidence.successfulRotation;
  if (success.cutoverReceipt.workspaceId !== input.workspaceId
      || success.cutoverReceipt.providerBinding.bindingId !== input.providerBinding.bindingId
      || success.cutoverReceipt.providerBinding.generation !== input.providerBinding.generation
      || success.cutoverReceipt.target.adapterId !== input.targetBinding.adapterId
      || success.cutoverReceipt.target.bindingId !== input.targetBinding.bindingId
      || success.cutoverReceipt.target.environmentId !== input.targetBinding.environmentId
      || success.completion.providerResponseDigest !== success.cutoverReceipt.canary.providerResponseDigest
      || success.oldKeyRejection.keyFingerprint !== success.cutoverReceipt.retiredKey.fingerprint
      || success.oldKeyRejection.rejectionStatus !== success.cutoverReceipt.retiredKey.rejectionStatus) {
    throw new UnprocessableError(
      'Live qualification cutover evidence is inconsistent',
      'OPENROUTER_QUALIFICATION_CUTOVER_INVALID',
    );
  }
  if (evidence.rollback.receipt.outcome !== 'rolled-back'
      || evidence.rollback.receipt.workspaceId !== input.workspaceId
      || evidence.rollback.receipt.providerBinding.bindingId !== input.providerBinding.bindingId
      || evidence.rollback.receipt.target.adapterId !== input.targetBinding.adapterId
      || evidence.rollback.receipt.target.bindingId !== input.targetBinding.bindingId
      || evidence.rollback.receipt.target.environmentId !== input.targetBinding.environmentId) {
    throw new UnprocessableError(
      'Live qualification rollback evidence is inconsistent',
      'OPENROUTER_QUALIFICATION_ROLLBACK_INVALID',
    );
  }
  assertCrashCoverage(evidence);
}

async function boundedFixtureOperation<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new UnprocessableError(
            'OpenRouter qualification fixture timed out',
            'OPENROUTER_QUALIFICATION_TIMEOUT',
          ));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}


export class OpenRouterRuntimeKeyQualificationService {
  constructor(
    private readonly authority: OpenRouterQualificationAuthority = new OpenRouterAuthorityProviderAdapter(),
    private readonly store: OpenRouterQualificationStore = databaseOpenRouterQualificationStore,
    private readonly fixtures: OpenRouterQualificationFixtureRegistry = openRouterQualificationFixtures,
    private readonly now: () => number = Date.now,
  ) {}

  private async requireHealthyBinding(
    workspaceId: string,
    reference: z.infer<typeof ProviderBindingReferenceSchema>,
  ): Promise<OpenRouterProviderBinding> {
    const binding = await this.authority.getProviderBinding(workspaceId);
    if (!binding || !exactBindingMatches(binding, reference) || binding.bindingStatus !== 'active'
        || !binding.health.providerAccountVerified || !binding.health.completionProbeRejected
        || binding.health.verifiedAt === null) {
      throw new ForbiddenError('OpenRouter rotation requires an exact healthy provider binding');
    }
    return binding;
  }

  async qualify(rawInput: ExecuteOpenRouterQualificationInput): Promise<OpenRouterQualificationReceipt> {
    const input = ExecuteOpenRouterQualificationInputSchema.parse(rawInput);
    const { requestDigest, ...material } = input;
    if (calculateOpenRouterQualificationDigest(material) !== requestDigest) {
      throw new ForbiddenError('OpenRouter qualification grant does not match the exact request');
    }
    const now = this.now();
    if (Date.parse(input.grantIssuedAt) > now || Date.parse(input.grantExpiresAt) <= now) {
      throw new ForbiddenError('OpenRouter qualification grant is not currently valid');
    }
    const binding = await this.requireHealthyBinding(input.workspaceId, input.providerBinding);
    if (input.spendLimitUsd > binding.policyLimits.maxCreditUsd) {
      throw new ForbiddenError('OpenRouter qualification spend exceeds the healthy binding policy');
    }
    const fixture = this.fixtures.resolve(input.fixtureId);
    if (!fixture) {
      throw new ServiceUnavailableError(
        'Explicit Rorca-owned OpenRouter qualification fixture is unavailable',
      );
    }
    const descriptor = OpenRouterQualificationFixtureDescriptorSchema.parse(fixture.descriptor);
    if (descriptor.fixtureId !== input.fixtureId || !targetMatches(descriptor.targetBinding, input.targetBinding)) {
      throw new ForbiddenError('OpenRouter qualification fixture does not match the exact workspace and environment');
    }
    if (!await this.store.claim(input)) {
      throw new ConflictError('OpenRouter qualification requests cannot be replayed');
    }

    try {
      const evidence = OpenRouterLiveQualificationEvidenceSchema.parse(
        await boundedFixtureOperation(input.timeoutMs, (signal) => fixture.execute(input, signal)),
      );
      assertLiveEvidence(evidence, input, descriptor);
      const qualifiedAt = new Date(this.now()).toISOString();
      const baseReceipt = {
        schemaVersion: OPENROUTER_QUALIFICATION_RECEIPT_VERSION,
        qualificationId: input.qualificationId,
        workspaceId: input.workspaceId,
        providerBinding: input.providerBinding,
        fixture: descriptor,
        spend: evidence.spend,
        successfulCutoverReceiptId: evidence.successfulRotation.cutoverReceipt.receiptId,
        rollbackReceiptId: evidence.rollback.receipt.receiptId,
        evidenceDigest: digest('rorca.openrouter-runtime-key-live-evidence.v1\0', evidence),
        qualifiedAt,
        expiresAt: input.grantExpiresAt,
      } as const;
      const receipt = OpenRouterQualificationReceiptSchema.parse({
        ...baseReceipt,
        receiptDigest: digest('rorca.openrouter-runtime-key-qualification-receipt.v1\0', baseReceipt),
      });
      await this.store.complete(input, evidence, receipt);
      return receipt;
    } catch (error) {
      await this.store.fail(input.qualificationId, 'OPENROUTER_QUALIFICATION_FAILED');
      if (error instanceof UnprocessableError) throw error;
      throw new UnprocessableError(
        'OpenRouter live qualification failed closed',
        'OPENROUTER_QUALIFICATION_FAILED',
      );
    }
  }

  async acceptPolicy(rawInput: AcceptOpenRouterRotationPolicyInput): Promise<OpenRouterRotationPolicyRecord> {
    const input = AcceptOpenRouterRotationPolicyInputSchema.parse(rawInput);
    const { policyDigest, ...material } = input;
    if (calculateOpenRouterRotationPolicyDigest(material) !== policyDigest) {
      throw new ForbiddenError('OpenRouter rotation policy acceptance does not match the exact policy');
    }
    const now = this.now();
    if (Date.parse(input.expiresAt) <= now) {
      throw new ForbiddenError('OpenRouter rotation policy has expired');
    }
    await this.requireHealthyBinding(input.workspaceId, input.providerBinding);
    const qualification = await this.store.read(input.qualificationId);
    if (!qualification || qualification.state !== 'passed' || qualification.receipt === null
        || qualification.workspaceId !== input.workspaceId
        || !targetMatches(qualification.targetBinding, input.targetBinding)
        || qualification.providerBinding.bindingId !== input.providerBinding.bindingId
        || qualification.providerBinding.generation !== input.providerBinding.generation
        || qualification.providerBinding.providerAccountId !== input.providerBinding.providerAccountId
        || Date.parse(qualification.grantExpiresAt) < Date.parse(input.expiresAt)
        || input.maxRotationCreditUsd > qualification.spendLimitUsd) {
      throw new ForbiddenError('OpenRouter rotation policy requires a current exact passing qualification');
    }
    const policy = OpenRouterRotationPolicyRecordSchema.parse({
      ...input,
      status: 'active',
      acceptedAt: new Date(now).toISOString(),
      disabledAt: null,
    });
    if (!await this.store.acceptPolicy(policy)) {
      throw new ConflictError('An accepted OpenRouter rotation policy is already active');
    }
    return policy;
  }

  async assertRotationAvailable(rawIntent: OpenRouterRotationIntent): Promise<OpenRouterRotationPolicyRecord> {
    const intent = OpenRouterRotationIntentSchema.parse(rawIntent);
    await this.requireHealthyBinding(intent.workspaceId, intent.providerBinding);
    const policy = await this.store.readPolicy(intent.workspaceId, intent.providerBinding.bindingId);
    if (!policy || policy.status !== 'active' || Date.parse(policy.expiresAt) <= this.now()
        || policy.providerBinding.generation !== intent.providerBinding.generation
        || policy.providerBinding.providerAccountId !== intent.providerBinding.providerAccountId
        || !targetMatches(policy.targetBinding, intent.targetBinding)
        || intent.limits.creditLimitUsd > policy.maxRotationCreditUsd) {
      throw new ForbiddenError('OpenRouter rotation rollout is unavailable for this exact workspace binding');
    }
    const qualification = await this.store.read(policy.qualificationId);
    if (!qualification || qualification.state !== 'passed' || qualification.receipt === null) {
      throw new ForbiddenError('OpenRouter rotation rollout qualification is not current');
    }
    return policy;
  }

  async rollback(rawInput: {
    qualificationId: string;
    workspaceId: string;
    bindingId: string;
  }): Promise<OpenRouterQualificationRollbackReceipt> {
    const input = z.object({
      qualificationId: z.string().uuid(),
      workspaceId: z.string().trim().min(1).max(255),
      bindingId: z.string().uuid(),
    }).strict().parse(rawInput);
    const qualification = await this.store.read(input.qualificationId);
    if (!qualification) throw new NotFoundError('OpenRouter qualification not found');
    if (qualification.workspaceId !== input.workspaceId
        || qualification.providerBinding.bindingId !== input.bindingId) {
      throw new ForbiddenError('OpenRouter qualification rollback does not match the exact binding scope');
    }
    if (qualification.state === 'rolled-back' && qualification.rollbackReceipt) {
      return qualification.rollbackReceipt;
    }
    if (qualification.state !== 'passed' || qualification.receipt === null) {
      throw new ConflictError('Only a passing OpenRouter qualification can be rolled back');
    }

    const disabledAt = new Date(this.now()).toISOString();
    await this.store.disablePolicy(
      qualification.workspaceId,
      qualification.providerBinding.bindingId,
      disabledAt,
    );
    const fixture = this.fixtures.resolve(qualification.fixtureId);
    if (!fixture) {
      throw new ServiceUnavailableError(
        'OpenRouter rollout is disabled but qualification cleanup requires reconciliation',
      );
    }
    const descriptor = OpenRouterQualificationFixtureDescriptorSchema.parse(fixture.descriptor);
    if (!targetMatches(descriptor.targetBinding, qualification.targetBinding)) {
      throw new ForbiddenError('OpenRouter rollback fixture does not match the qualified target');
    }
    const evidence = OpenRouterQualificationRollbackEvidenceSchema.parse(
      await boundedFixtureOperation(
        qualification.timeoutMs,
        (signal) => fixture.rollback(qualification.receipt as OpenRouterQualificationReceipt, signal),
      ),
    );
    const baseReceipt = {
      schemaVersion: OPENROUTER_QUALIFICATION_ROLLBACK_RECEIPT_VERSION,
      qualificationId: qualification.qualificationId,
      workspaceId: qualification.workspaceId,
      providerBinding: qualification.providerBinding,
      targetBinding: qualification.targetBinding,
      qualificationReceiptDigest: qualification.receipt.receiptDigest,
      replacements: evidence.replacements,
      targetFunctional: evidence.targetFunctional,
      priorBindingRestored: evidence.priorBindingRestored,
      receiptsPreserved: evidence.receiptsPreserved,
      rolledBackAt: evidence.completedAt,
    } as const;
    const receipt = OpenRouterQualificationRollbackReceiptSchema.parse({
      ...baseReceipt,
      receiptDigest: digest(
        'rorca.openrouter-runtime-key-qualification-rollback-receipt.v1\0',
        baseReceipt,
      ),
    });
    await this.store.recordRollback(qualification.qualificationId, receipt);
    return receipt;
  }

  async status(workspaceId: string, bindingId: string): Promise<{
    available: boolean;
    policy: OpenRouterRotationPolicyRecord | null;
  }> {
    const parsedWorkspaceId = z.string().trim().min(1).max(255).parse(workspaceId);
    const parsedBindingId = z.string().uuid().parse(bindingId);
    const policy = await this.store.readPolicy(parsedWorkspaceId, parsedBindingId);
    if (!policy || policy.status !== 'active' || Date.parse(policy.expiresAt) <= this.now()) {
      return { available: false, policy };
    }
    const binding = await this.authority.getProviderBinding(parsedWorkspaceId);
    const qualification = await this.store.read(policy.qualificationId);
    const available = binding !== null
      && exactBindingMatches(binding, policy.providerBinding)
      && binding.bindingStatus === 'active'
      && binding.health.providerAccountVerified
      && binding.health.completionProbeRejected
      && binding.health.verifiedAt !== null
      && qualification?.state === 'passed'
      && qualification.receipt !== null;
    return { available, policy };
  }
}
