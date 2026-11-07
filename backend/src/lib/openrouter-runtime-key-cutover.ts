/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { z } from 'zod';
import { queryOne, transaction } from '../db/index';
import { ConflictError, ForbiddenError, UnprocessableError } from './errors';
import {
  OpenRouterAuthorityProviderAdapter,
  OpenRouterKeyMetadataSchema,
  type OpenRouterKeyMetadata,
  type OpenRouterOperationContext,
} from './openrouter-authority-provider-adapter';
import {
  ExecuteOpenRouterRotationInputSchema,
  OpenRouterRuntimeKeyRotationService,
  type ExecuteOpenRouterRotationInput,
  type OpenRouterRotationIntent,
  type OpenRouterRotationReplacement,
} from './openrouter-runtime-key-rotation';
import {
  RuntimeProviderCompletionEvidenceSchema,
  RuntimeProviderRejectionEvidenceSchema,
  RuntimeSecretBindingStageResultSchema,
  RuntimeTargetRevisionSchema,
  runtimeSecretBindingAdapters,
  type RuntimeProviderCompletionEvidence,
  type RuntimeProviderRejectionEvidence,
  type RestoreRuntimeSecretBindingInput,
  type RuntimeSecretBindingAdapter,
  type RuntimeSecretBindingAdapterResolver,
} from './openrouter-runtime-binding-adapter';

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const OpenRouterRotationCutoverStateSchema = z.enum([
  'REPLACEMENT_READY',
  'WAITING_FOR_AUTHORIZATION',
  'BINDING_STAGED',
  'TARGET_DEPLOYED',
  'CANARY_PASSED',
  'BINDING_ACTIVE',
  'OLD_KEY_DISABLE_PENDING',
  'OLD_KEY_DISABLED',
  'COMPLETED',
  'ROLLBACK_PENDING',
  'TARGET_RESTORED',
  'ROLLED_BACK',
]);
export type OpenRouterRotationCutoverState = z.infer<typeof OpenRouterRotationCutoverStateSchema>;

const ResumableCutoverStateSchema = z.enum([
  'REPLACEMENT_READY',
  'BINDING_STAGED',
  'TARGET_DEPLOYED',
  'CANARY_PASSED',
  'BINDING_ACTIVE',
  'OLD_KEY_DISABLE_PENDING',
  'OLD_KEY_DISABLED',
]);

export const OpenRouterRotationCutoverReceiptSchema = z.object({
  schemaVersion: z.literal('rorca.openrouter-runtime-key-cutover-receipt.v1'),
  receiptId: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(255),
  requestDigest: Sha256Schema,
  providerBinding: z.object({
    bindingId: z.string().uuid(),
    generation: z.number().int().positive(),
  }).strict(),
  replacement: z.object({
    providerResourceId: z.string().trim().min(1).max(255),
    fingerprint: Sha256Schema,
    lifecycleState: z.literal('active'),
  }).strict(),
  target: z.object({
    adapterId: z.string().trim().min(1).max(120),
    bindingId: z.string().trim().min(1).max(255),
    environmentId: z.string().trim().min(1).max(255),
    bindingGeneration: z.number().int().positive(),
    deployedRevision: z.string().trim().min(1).max(255),
  }).strict(),
  canary: z.object({
    contractId: z.string().trim().min(1).max(255),
    contractVersion: z.number().int().positive(),
    providerResponseDigest: Sha256Schema,
    completedAt: z.string().datetime(),
  }).strict(),
  retiredKey: z.object({
    providerResourceId: z.string().trim().min(1).max(255),
    fingerprint: Sha256Schema,
    rejectionStatus: z.union([z.literal(401), z.literal(403)]),
    providerResponseDigest: Sha256Schema,
    verifiedAt: z.string().datetime(),
  }).strict(),
  emittedAt: z.string().datetime(),
}).strict();
export type OpenRouterRotationCutoverReceipt = z.infer<typeof OpenRouterRotationCutoverReceiptSchema>;

export const OpenRouterRotationRecoveryReceiptSchema = z.object({
  schemaVersion: z.literal('rorca.openrouter-runtime-key-recovery-receipt.v1'),
  receiptId: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(255),
  requestDigest: Sha256Schema,
  outcome: z.enum(['rolled-back', 'reconciliation-required']),
  failure: z.object({
    state: OpenRouterRotationCutoverStateSchema,
    code: z.string().trim().min(1).max(120),
  }).strict(),
  providerBinding: z.object({
    bindingId: z.string().uuid(),
    generation: z.number().int().positive(),
  }).strict(),
  priorKey: z.object({
    providerResourceId: z.string().trim().min(1).max(255),
    fingerprint: Sha256Schema,
    status: z.enum(['active', 'disabled', 'uncertain']),
  }).strict(),
  replacement: z.object({
    providerResourceId: z.string().trim().min(1).max(255).nullable(),
    fingerprint: Sha256Schema.nullable(),
    lifecycleState: z.enum(['pending', 'active', 'revoked', 'cleanup-required', 'reconciled']),
  }).strict(),
  target: z.object({
    adapterId: z.string().trim().min(1).max(120),
    bindingId: z.string().trim().min(1).max(255),
    environmentId: z.string().trim().min(1).max(255),
    priorGeneration: z.number().int().positive(),
    changedGeneration: z.number().int().positive().nullable(),
    restoredGeneration: z.number().int().positive().nullable(),
    restoredRevision: z.string().trim().min(1).max(255).nullable(),
  }).strict(),
  emittedAt: z.string().datetime(),
}).strict();
export type OpenRouterRotationRecoveryReceipt = z.infer<typeof OpenRouterRotationRecoveryReceiptSchema>;

export const OpenRouterRotationCutoverRecordSchema = z.object({
  intentId: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(255),
  requestDigest: Sha256Schema,
  executionId: z.string().uuid(),
  fencingToken: z.number().int().positive(),
  state: OpenRouterRotationCutoverStateSchema,
  resumeState: ResumableCutoverStateSchema.nullable(),
  waitingReasonCode: z.string().trim().min(1).max(120).nullable(),
  timeoutConsumedMs: z.number().int().nonnegative(),
  timeoutStartedAt: z.string().datetime().nullable(),
  oldProviderResourceId: z.string().trim().min(1).max(255),
  targetBindingGeneration: z.number().int().positive().nullable(),
  targetRequiresDeployment: z.boolean().nullable(),
  deployedRevision: z.string().trim().min(1).max(255).nullable(),
  canaryEvidence: RuntimeProviderCompletionEvidenceSchema.nullable(),
  oldKeyDisabledAt: z.string().datetime().nullable(),
  rejectionEvidence: RuntimeProviderRejectionEvidenceSchema.nullable(),
  receipt: OpenRouterRotationCutoverReceiptSchema.nullable(),
  completedAt: z.string().datetime().nullable(),
  failureState: OpenRouterRotationCutoverStateSchema.nullable(),
  failureCode: z.string().trim().min(1).max(120).nullable(),
  restoredBindingGeneration: z.number().int().positive().nullable(),
  restoredRevision: z.string().trim().min(1).max(255).nullable(),
  reconciliationReasonCode: z.string().trim().min(1).max(120).nullable(),
  recoveryReceipt: OpenRouterRotationRecoveryReceiptSchema.nullable(),
}).strict().superRefine((record, ctx) => {
  if (record.state === 'WAITING_FOR_AUTHORIZATION') {
    if (record.resumeState === null || record.waitingReasonCode === null || record.timeoutStartedAt !== null) {
      ctx.addIssue({ code: 'custom', message: 'authorization wait must preserve a paused resume checkpoint' });
    }
  } else if (record.resumeState !== null || record.waitingReasonCode !== null) {
    ctx.addIssue({ code: 'custom', message: 'only authorization waits may carry a resume checkpoint' });
  }
  const stagedStates: OpenRouterRotationCutoverState[] = [
    'BINDING_STAGED', 'TARGET_DEPLOYED', 'CANARY_PASSED', 'BINDING_ACTIVE',
    'OLD_KEY_DISABLE_PENDING', 'OLD_KEY_DISABLED', 'COMPLETED',
  ];
  if (stagedStates.includes(record.state)
      && (record.targetBindingGeneration === null || record.targetRequiresDeployment === null)) {
    ctx.addIssue({ code: 'custom', message: 'staged cutover requires a target binding generation' });
  }
  const deployedStates: OpenRouterRotationCutoverState[] = [
    'TARGET_DEPLOYED', 'CANARY_PASSED', 'BINDING_ACTIVE',
    'OLD_KEY_DISABLE_PENDING', 'OLD_KEY_DISABLED', 'COMPLETED',
  ];
  if (deployedStates.includes(record.state) && record.deployedRevision === null) {
    ctx.addIssue({ code: 'custom', message: 'deployed cutover requires a target revision' });
  }
  const canaryStates: OpenRouterRotationCutoverState[] = [
    'CANARY_PASSED', 'BINDING_ACTIVE', 'OLD_KEY_DISABLE_PENDING', 'OLD_KEY_DISABLED', 'COMPLETED',
  ];
  if (canaryStates.includes(record.state) && record.canaryEvidence === null) {
    ctx.addIssue({ code: 'custom', message: 'canary-passed cutover requires completion evidence' });
  }
  if ((record.state === 'OLD_KEY_DISABLED' || record.state === 'COMPLETED')
      && record.oldKeyDisabledAt === null) {
    ctx.addIssue({ code: 'custom', message: 'disabled-key checkpoint requires provider evidence' });
  }
  if (record.state === 'COMPLETED'
      && (record.rejectionEvidence === null || record.receipt === null || record.completedAt === null)) {
    ctx.addIssue({ code: 'custom', message: 'completed cutover requires rejection evidence and one receipt' });
  }
  const rollbackState = record.state === 'ROLLBACK_PENDING'
    || record.state === 'TARGET_RESTORED'
    || record.state === 'ROLLED_BACK';
  if (rollbackState && (record.failureState === null || record.failureCode === null)) {
    ctx.addIssue({ code: 'custom', message: 'rollback state requires a redacted failure checkpoint' });
  }
  if ((record.state === 'TARGET_RESTORED' || record.state === 'ROLLED_BACK')
      && (record.restoredBindingGeneration === null || record.restoredRevision === null)) {
    ctx.addIssue({ code: 'custom', message: 'restored target requires prior-generation revision evidence' });
  }
  if (record.state === 'ROLLED_BACK' && record.recoveryReceipt?.outcome !== 'rolled-back') {
    ctx.addIssue({ code: 'custom', message: 'completed rollback requires one rollback receipt' });
  }
  if (record.reconciliationReasonCode !== null
      && record.recoveryReceipt?.outcome !== 'reconciliation-required') {
    ctx.addIssue({ code: 'custom', message: 'reconciliation state requires one redacted receipt' });
  }
  if ((record.failureState === null) !== (record.failureCode === null)) {
    ctx.addIssue({ code: 'custom', message: 'failure state and code must be recorded together' });
  }
});
export type OpenRouterRotationCutoverRecord = z.infer<typeof OpenRouterRotationCutoverRecordSchema>;

export interface OpenRouterRotationCutoverStore {
  claim(
    intent: OpenRouterRotationIntent,
    replacement: OpenRouterRotationReplacement,
    executionId: string,
    fencingToken: number,
  ): Promise<OpenRouterRotationCutoverRecord>;
  markWaiting(
    intent: OpenRouterRotationIntent,
    executionId: string,
    fencingToken: number,
    reasonCode: string,
  ): Promise<OpenRouterRotationCutoverRecord>;
  startExecution(
    intent: OpenRouterRotationIntent,
    executionId: string,
    fencingToken: number,
  ): Promise<OpenRouterRotationCutoverRecord>;
  recordBindingStaged(
    intent: OpenRouterRotationIntent,
    executionId: string,
    fencingToken: number,
    bindingGeneration: number,
    requiresDeployment: boolean,
  ): Promise<OpenRouterRotationCutoverRecord>;
  recordTargetDeployed(
    intent: OpenRouterRotationIntent,
    executionId: string,
    fencingToken: number,
    deployedRevision: string,
  ): Promise<OpenRouterRotationCutoverRecord>;
  recordCanaryPassed(
    intent: OpenRouterRotationIntent,
    executionId: string,
    fencingToken: number,
    evidence: RuntimeProviderCompletionEvidence,
  ): Promise<OpenRouterRotationCutoverRecord>;
  recordBindingActive(
    intent: OpenRouterRotationIntent,
    executionId: string,
    fencingToken: number,
  ): Promise<OpenRouterRotationCutoverRecord>;
  recordOldKeyDisabled(
    intent: OpenRouterRotationIntent,
    executionId: string,
    fencingToken: number,
  ): Promise<OpenRouterRotationCutoverRecord>;
  beginOldKeyDisable(
    intent: OpenRouterRotationIntent,
    executionId: string,
    fencingToken: number,
  ): Promise<OpenRouterRotationCutoverRecord>;
  complete(
    intent: OpenRouterRotationIntent,
    replacement: OpenRouterRotationReplacement,
    executionId: string,
    fencingToken: number,
    rejectionEvidence: RuntimeProviderRejectionEvidence,
    receipt: OpenRouterRotationCutoverReceipt,
  ): Promise<OpenRouterRotationCutoverRecord>;
  beginRollback(
    intent: OpenRouterRotationIntent,
    executionId: string,
    fencingToken: number,
    failureState: OpenRouterRotationCutoverState,
    failureCode: string,
  ): Promise<OpenRouterRotationCutoverRecord>;
  recordTargetRestored(
    intent: OpenRouterRotationIntent,
    executionId: string,
    fencingToken: number,
    restoredBindingGeneration: number,
    restoredRevision: string,
  ): Promise<OpenRouterRotationCutoverRecord>;
  completeRollback(
    intent: OpenRouterRotationIntent,
    replacement: OpenRouterRotationReplacement,
    executionId: string,
    fencingToken: number,
    receipt: OpenRouterRotationRecoveryReceipt,
  ): Promise<OpenRouterRotationCutoverRecord>;
  markReconciliationRequired(
    intent: OpenRouterRotationIntent,
    replacement: OpenRouterRotationReplacement,
    executionId: string,
    fencingToken: number,
    reasonCode: string,
    receipt: OpenRouterRotationRecoveryReceipt,
    replacementCleanupRequired: boolean,
  ): Promise<OpenRouterRotationCutoverRecord>;
  clearReconciliationRequired(
    intent: OpenRouterRotationIntent,
    executionId: string,
    fencingToken: number,
  ): Promise<OpenRouterRotationCutoverRecord>;
}

interface CutoverRow {
  intent_id: string;
  workspace_id: string;
  intent_digest: string;
  execution_id: string;
  fencing_token: string | number;
  state: OpenRouterRotationCutoverState;
  resume_state: z.infer<typeof ResumableCutoverStateSchema> | null;
  waiting_reason_code: string | null;
  timeout_consumed_ms: string | number;
  timeout_started_at: string | Date | null;
  old_provider_resource_id: string;
  target_binding_generation: string | number | null;
  target_requires_deployment: boolean | null;
  deployed_revision: string | null;
  canary_evidence: RuntimeProviderCompletionEvidence | string | null;
  old_key_disabled_at: string | Date | null;
  rejection_evidence: RuntimeProviderRejectionEvidence | string | null;
  receipt: OpenRouterRotationCutoverReceipt | string | null;
  completed_at: string | Date | null;
  failure_state: OpenRouterRotationCutoverState | null;
  failure_code: string | null;
  restored_binding_generation: string | number | null;
  restored_revision: string | null;
  reconciliation_reason_code: string | null;
  recovery_receipt: OpenRouterRotationRecoveryReceipt | string | null;
}

const CUTOVER_SELECT = `
  SELECT intent_id, workspace_id, intent_digest, execution_id, fencing_token, state, resume_state,
         waiting_reason_code, timeout_consumed_ms, timeout_started_at, old_provider_resource_id,
         target_binding_generation, target_requires_deployment, deployed_revision, canary_evidence,
         old_key_disabled_at, rejection_evidence, receipt, completed_at, failure_state, failure_code,
         restored_binding_generation, restored_revision, reconciliation_reason_code, recovery_receipt
    FROM runtime_key_rotation_cutovers`;

function parseJson<T>(value: T | string | null): T | null {
  if (value === null) return null;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function timestamp(value: string | Date | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapCutover(row: CutoverRow): OpenRouterRotationCutoverRecord {
  return OpenRouterRotationCutoverRecordSchema.parse({
    intentId: row.intent_id,
    workspaceId: row.workspace_id,
    requestDigest: row.intent_digest,
    executionId: row.execution_id,
    fencingToken: Number(row.fencing_token),
    state: row.state,
    resumeState: row.resume_state,
    waitingReasonCode: row.waiting_reason_code,
    timeoutConsumedMs: Number(row.timeout_consumed_ms),
    timeoutStartedAt: timestamp(row.timeout_started_at),
    oldProviderResourceId: row.old_provider_resource_id,
    targetBindingGeneration: row.target_binding_generation === null ? null : Number(row.target_binding_generation),
    targetRequiresDeployment: row.target_requires_deployment,
    deployedRevision: row.deployed_revision,
    canaryEvidence: parseJson(row.canary_evidence),
    oldKeyDisabledAt: timestamp(row.old_key_disabled_at),
    rejectionEvidence: parseJson(row.rejection_evidence),
    receipt: parseJson(row.receipt),
    completedAt: timestamp(row.completed_at),
    failureState: row.failure_state,
    failureCode: row.failure_code,
    restoredBindingGeneration: row.restored_binding_generation === null
      ? null
      : Number(row.restored_binding_generation),
    restoredRevision: row.restored_revision,
    reconciliationReasonCode: row.reconciliation_reason_code,
    recoveryReceipt: parseJson(row.recovery_receipt),
  });
}

async function requireCutover(intent: OpenRouterRotationIntent): Promise<OpenRouterRotationCutoverRecord> {
  const row = await queryOne<CutoverRow>(`${CUTOVER_SELECT} WHERE workspace_id = $1 AND intent_digest = $2`, [
    intent.workspaceId,
    intent.requestDigest,
  ]);
  if (!row) throw new UnprocessableError('Rotation cutover state could not be persisted', 'OPENROUTER_CUTOVER_PERSIST_FAILED');
  return mapCutover(row);
}

function assertFence(
  record: OpenRouterRotationCutoverRecord,
  executionId: string,
  fencingToken: number,
): void {
  if (record.executionId !== executionId || record.fencingToken !== fencingToken) {
    throw new ForbiddenError('Rotation cutover execution fence is stale');
  }
}

async function requireTransition(
  intent: OpenRouterRotationIntent,
  executionId: string,
  fencingToken: number,
  expectedState: OpenRouterRotationCutoverState,
): Promise<OpenRouterRotationCutoverRecord> {
  const current = await requireCutover(intent);
  assertFence(current, executionId, fencingToken);
  if (current.state !== expectedState) {
    throw new ConflictError(`Rotation cutover transition did not settle at ${expectedState}`);
  }
  return current;
}

export const databaseOpenRouterRotationCutoverStore: OpenRouterRotationCutoverStore = {
  async claim(intent, replacement, executionId, fencingToken) {
    return transaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`${intent.workspaceId}:${intent.requestDigest}:cutover`],
      );
      const selected = await client.query<CutoverRow>(
        `${CUTOVER_SELECT} WHERE workspace_id = $1 AND intent_digest = $2 FOR UPDATE`,
        [intent.workspaceId, intent.requestDigest],
      );
      let row = selected.rows[0];
      if (!row) {
        const inserted = await client.query<CutoverRow>(
          `INSERT INTO runtime_key_rotation_cutovers
             (intent_id, workspace_id, intent_digest, provider_binding_id, execution_id,
              fencing_token, state, old_provider_resource_id)
           SELECT intent.id, intent.workspace_id, intent.intent_digest, intent.provider_binding_id,
                  $1, $2, 'REPLACEMENT_READY', current_resource.provider_resource_id
             FROM runtime_key_rotation_intents AS intent
             JOIN runtime_key_rotation_replacements AS replacement ON replacement.intent_id = intent.id
             JOIN provider_key_resources AS current_resource
               ON current_resource.provider_binding_id = intent.provider_binding_id
              AND current_resource.workspace_id = intent.workspace_id
              AND current_resource.binding_generation = intent.binding_generation
              AND current_resource.provider_account_id = intent.provider_account_id
              AND current_resource.runtime_secret_id = intent.current_runtime_secret_id
              AND current_resource.status = 'active'
            WHERE intent.workspace_id = $3 AND intent.intent_digest = $4
           RETURNING *`,
          [executionId, fencingToken, intent.workspaceId, intent.requestDigest],
        );
        row = inserted.rows[0];
        if (!row) {
          throw new UnprocessableError(
            'Rotation cutover requires a settled replacement and active prior key',
            'OPENROUTER_CUTOVER_NOT_READY',
          );
        }
      } else {
        const currentFence = Number(row.fencing_token);
        if (fencingToken < currentFence) throw new ForbiddenError('Rotation cutover execution fence is stale');
        if (fencingToken > currentFence) {
          const updated = await client.query<CutoverRow>(
            `UPDATE runtime_key_rotation_cutovers
                SET execution_id = $1, fencing_token = $2, updated_at = NOW()
              WHERE intent_id = $3
              RETURNING *`,
            [executionId, fencingToken, row.intent_id],
          );
          row = updated.rows[0];
        } else if (row.execution_id !== executionId) {
          throw new ForbiddenError('Rotation cutover execution fence is already claimed');
        }
      }
      if (!row) throw new UnprocessableError('Rotation cutover state could not be persisted', 'OPENROUTER_CUTOVER_PERSIST_FAILED');
      return mapCutover(row);
    });
  },

  async markWaiting(intent, executionId, fencingToken, reasonCode) {
    await transaction(async (client) => client.query(
      `UPDATE runtime_key_rotation_cutovers
          SET resume_state = state,
              state = 'WAITING_FOR_AUTHORIZATION',
              waiting_reason_code = $1,
              timeout_consumed_ms = timeout_consumed_ms + CASE
                WHEN timeout_started_at IS NULL THEN 0
                ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - timeout_started_at)) * 1000))::BIGINT
              END,
              timeout_started_at = NULL,
              updated_at = NOW()
        WHERE workspace_id = $2 AND intent_digest = $3
          AND execution_id = $4 AND fencing_token = $5
          AND state <> 'WAITING_FOR_AUTHORIZATION' AND state <> 'COMPLETED'`,
      [reasonCode, intent.workspaceId, intent.requestDigest, executionId, fencingToken],
    ));
    return requireTransition(intent, executionId, fencingToken, 'WAITING_FOR_AUTHORIZATION');
  },

  async startExecution(intent, executionId, fencingToken) {
    await transaction(async (client) => client.query(
      `UPDATE runtime_key_rotation_cutovers
          SET state = CASE WHEN state = 'WAITING_FOR_AUTHORIZATION' THEN resume_state ELSE state END,
              resume_state = NULL,
              waiting_reason_code = NULL,
              timeout_started_at = COALESCE(timeout_started_at, NOW()),
              updated_at = NOW()
        WHERE workspace_id = $1 AND intent_digest = $2
          AND execution_id = $3 AND fencing_token = $4
          AND state <> 'COMPLETED'`,
      [intent.workspaceId, intent.requestDigest, executionId, fencingToken],
    ));
    const current = await requireCutover(intent);
    assertFence(current, executionId, fencingToken);
    return current;
  },

  async recordBindingStaged(intent, executionId, fencingToken, bindingGeneration, requiresDeployment) {
    await transaction(async (client) => client.query(
      `UPDATE runtime_key_rotation_cutovers
          SET state = 'BINDING_STAGED', target_binding_generation = $1,
              target_requires_deployment = $2, updated_at = NOW()
        WHERE workspace_id = $3 AND intent_digest = $4
          AND execution_id = $5 AND fencing_token = $6 AND state = 'REPLACEMENT_READY'`,
      [bindingGeneration, requiresDeployment, intent.workspaceId, intent.requestDigest, executionId, fencingToken],
    ));
    return requireTransition(intent, executionId, fencingToken, 'BINDING_STAGED');
  },

  async recordTargetDeployed(intent, executionId, fencingToken, deployedRevision) {
    await transaction(async (client) => client.query(
      `UPDATE runtime_key_rotation_cutovers
          SET state = 'TARGET_DEPLOYED', deployed_revision = $1, updated_at = NOW()
        WHERE workspace_id = $2 AND intent_digest = $3
          AND execution_id = $4 AND fencing_token = $5 AND state = 'BINDING_STAGED'`,
      [deployedRevision, intent.workspaceId, intent.requestDigest, executionId, fencingToken],
    ));
    return requireTransition(intent, executionId, fencingToken, 'TARGET_DEPLOYED');
  },

  async recordCanaryPassed(intent, executionId, fencingToken, evidence) {
    const parsed = RuntimeProviderCompletionEvidenceSchema.parse(evidence);
    await transaction(async (client) => client.query(
      `UPDATE runtime_key_rotation_cutovers
          SET state = 'CANARY_PASSED', canary_evidence = $1::jsonb, updated_at = NOW()
        WHERE workspace_id = $2 AND intent_digest = $3
          AND execution_id = $4 AND fencing_token = $5 AND state = 'TARGET_DEPLOYED'`,
      [JSON.stringify(parsed), intent.workspaceId, intent.requestDigest, executionId, fencingToken],
    ));
    return requireTransition(intent, executionId, fencingToken, 'CANARY_PASSED');
  },

  async recordBindingActive(intent, executionId, fencingToken) {
    await transaction(async (client) => client.query(
      `UPDATE runtime_key_rotation_cutovers
          SET state = 'BINDING_ACTIVE', updated_at = NOW()
        WHERE workspace_id = $1 AND intent_digest = $2
          AND execution_id = $3 AND fencing_token = $4 AND state = 'CANARY_PASSED'`,
      [intent.workspaceId, intent.requestDigest, executionId, fencingToken],
    ));
    return requireTransition(intent, executionId, fencingToken, 'BINDING_ACTIVE');
  },

  async beginOldKeyDisable(intent, executionId, fencingToken) {
    await transaction(async (client) => client.query(
      `UPDATE runtime_key_rotation_cutovers
          SET state = 'OLD_KEY_DISABLE_PENDING', updated_at = NOW()
        WHERE workspace_id = $1 AND intent_digest = $2
          AND execution_id = $3 AND fencing_token = $4 AND state = 'BINDING_ACTIVE'`,
      [intent.workspaceId, intent.requestDigest, executionId, fencingToken],
    ));
    return requireTransition(intent, executionId, fencingToken, 'OLD_KEY_DISABLE_PENDING');
  },

  async recordOldKeyDisabled(intent, executionId, fencingToken) {
    await transaction(async (client) => client.query(
      `UPDATE runtime_key_rotation_cutovers
          SET state = 'OLD_KEY_DISABLED', old_key_disabled_at = NOW(),
              reconciliation_reason_code = NULL, updated_at = NOW()
        WHERE workspace_id = $1 AND intent_digest = $2
          AND execution_id = $3 AND fencing_token = $4 AND state = 'OLD_KEY_DISABLE_PENDING'`,
      [intent.workspaceId, intent.requestDigest, executionId, fencingToken],
    ));
    return requireTransition(intent, executionId, fencingToken, 'OLD_KEY_DISABLED');
  },

  async complete(intent, replacement, executionId, fencingToken, rejectionEvidence, receipt) {
    const parsedRejection = RuntimeProviderRejectionEvidenceSchema.parse(rejectionEvidence);
    const parsedReceipt = OpenRouterRotationCutoverReceiptSchema.parse(receipt);
    await transaction(async (client) => {
      const cutover = await client.query(
        `UPDATE runtime_key_rotation_cutovers
            SET state = 'COMPLETED', rejection_evidence = $1::jsonb, receipt = $2::jsonb,
                completed_at = $3, timeout_started_at = NULL,
                reconciliation_reason_code = NULL, updated_at = NOW()
          WHERE workspace_id = $4 AND intent_digest = $5
            AND execution_id = $6 AND fencing_token = $7
            AND state = 'OLD_KEY_DISABLED' AND receipt IS NULL`,
        [
          JSON.stringify(parsedRejection),
          JSON.stringify(parsedReceipt),
          parsedReceipt.emittedAt,
          intent.workspaceId,
          intent.requestDigest,
          executionId,
          fencingToken,
        ],
      );
      if ((cutover.rowCount ?? 0) !== 1) {
        throw new ConflictError('Rotation cutover receipt could not be emitted exactly once');
      }
      const settled = await client.query(
        `UPDATE runtime_key_rotation_replacements
            SET lifecycle_state = 'active', updated_at = NOW()
          WHERE intent_id = $1 AND provider_resource_id = $2
            AND runtime_secret_id = $3 AND lifecycle_state IN ('pending', 'reconciled')`,
        [replacement.intentId, replacement.providerResourceId, replacement.runtimeKeyReference?.secretId],
      );
      if ((settled.rowCount ?? 0) !== 1) {
        throw new ConflictError('Replacement key could not be settled active with its receipt');
      }
    });
    return requireTransition(intent, executionId, fencingToken, 'COMPLETED');
  },

  async beginRollback(intent, executionId, fencingToken, failureState, failureCode) {
    await transaction(async (client) => client.query(
      `UPDATE runtime_key_rotation_cutovers
          SET state = 'ROLLBACK_PENDING', failure_state = $1, failure_code = $2,
              reconciliation_reason_code = NULL, updated_at = NOW()
        WHERE workspace_id = $3 AND intent_digest = $4
          AND execution_id = $5 AND fencing_token = $6
          AND state = $1 AND state NOT IN ('OLD_KEY_DISABLED', 'COMPLETED', 'ROLLED_BACK')`,
      [failureState, failureCode, intent.workspaceId, intent.requestDigest, executionId, fencingToken],
    ));
    return requireTransition(intent, executionId, fencingToken, 'ROLLBACK_PENDING');
  },

  async recordTargetRestored(
    intent,
    executionId,
    fencingToken,
    restoredBindingGeneration,
    restoredRevision,
  ) {
    await transaction(async (client) => client.query(
      `UPDATE runtime_key_rotation_cutovers
          SET state = 'TARGET_RESTORED', restored_binding_generation = $1,
              restored_revision = $2, reconciliation_reason_code = NULL, updated_at = NOW()
        WHERE workspace_id = $3 AND intent_digest = $4
          AND execution_id = $5 AND fencing_token = $6 AND state = 'ROLLBACK_PENDING'`,
      [
        restoredBindingGeneration,
        restoredRevision,
        intent.workspaceId,
        intent.requestDigest,
        executionId,
        fencingToken,
      ],
    ));
    return requireTransition(intent, executionId, fencingToken, 'TARGET_RESTORED');
  },

  async completeRollback(intent, replacement, executionId, fencingToken, receipt) {
    const parsedReceipt = OpenRouterRotationRecoveryReceiptSchema.parse(receipt);
    await transaction(async (client) => {
      const cutover = await client.query(
        `UPDATE runtime_key_rotation_cutovers
            SET state = 'ROLLED_BACK', recovery_receipt = $1::jsonb,
                reconciliation_reason_code = NULL, timeout_started_at = NULL,
                completed_at = $2, updated_at = NOW()
          WHERE workspace_id = $3 AND intent_digest = $4
            AND execution_id = $5 AND fencing_token = $6 AND state = 'TARGET_RESTORED'`,
        [
          JSON.stringify(parsedReceipt),
          parsedReceipt.emittedAt,
          intent.workspaceId,
          intent.requestDigest,
          executionId,
          fencingToken,
        ],
      );
      if ((cutover.rowCount ?? 0) !== 1) {
        throw new ConflictError('Rotation rollback receipt could not be emitted exactly once');
      }
      const settled = await client.query(
        `UPDATE runtime_key_rotation_replacements
            SET lifecycle_state = 'revoked', updated_at = NOW()
          WHERE intent_id = $1 AND provider_resource_id = $2
            AND lifecycle_state IN ('pending', 'reconciled', 'cleanup-required')`,
        [replacement.intentId, replacement.providerResourceId],
      );
      if ((settled.rowCount ?? 0) !== 1) {
        throw new ConflictError('Failed replacement could not be settled revoked with its rollback receipt');
      }
    });
    return requireTransition(intent, executionId, fencingToken, 'ROLLED_BACK');
  },

  async markReconciliationRequired(
    intent,
    replacement,
    executionId,
    fencingToken,
    reasonCode,
    receipt,
    replacementCleanupRequired,
  ) {
    const parsedReceipt = OpenRouterRotationRecoveryReceiptSchema.parse(receipt);
    await transaction(async (client) => {
      const cutover = await client.query(
        `UPDATE runtime_key_rotation_cutovers
            SET reconciliation_reason_code = $1, recovery_receipt = $2::jsonb,
                timeout_consumed_ms = timeout_consumed_ms + CASE
                  WHEN timeout_started_at IS NULL THEN 0
                  ELSE GREATEST(
                    0,
                    FLOOR(EXTRACT(EPOCH FROM (NOW() - timeout_started_at)) * 1000)
                  )::BIGINT
                END,
                timeout_started_at = NULL, updated_at = NOW()
          WHERE workspace_id = $3 AND intent_digest = $4
            AND execution_id = $5 AND fencing_token = $6
            AND state NOT IN ('COMPLETED', 'ROLLED_BACK')`,
        [
          reasonCode,
          JSON.stringify(parsedReceipt),
          intent.workspaceId,
          intent.requestDigest,
          executionId,
          fencingToken,
        ],
      );
      if ((cutover.rowCount ?? 0) !== 1) {
        throw new ConflictError('Rotation reconciliation receipt could not be persisted');
      }
      if (replacementCleanupRequired && replacement.providerResourceId !== null) {
        await client.query(
          `UPDATE runtime_key_rotation_replacements
              SET lifecycle_state = 'cleanup-required', updated_at = NOW()
            WHERE intent_id = $1 AND provider_resource_id = $2
              AND lifecycle_state IN ('pending', 'reconciled', 'cleanup-required')`,
          [replacement.intentId, replacement.providerResourceId],
        );
      }
    });
    return requireCutover(intent);
  },

  async clearReconciliationRequired(intent, executionId, fencingToken) {
    await transaction(async (client) => client.query(
      `UPDATE runtime_key_rotation_cutovers
          SET reconciliation_reason_code = NULL, updated_at = NOW()
        WHERE workspace_id = $1 AND intent_digest = $2
          AND execution_id = $3 AND fencing_token = $4`,
      [intent.workspaceId, intent.requestDigest, executionId, fencingToken],
    ));
    const current = await requireCutover(intent);
    assertFence(current, executionId, fencingToken);
    return current;
  },
};

export interface OpenRouterCutoverProvider {
  disableKey(context: OpenRouterOperationContext, resourceId: string): Promise<OpenRouterKeyMetadata>;
  listKeys(context: OpenRouterOperationContext): Promise<OpenRouterKeyMetadata[]>;
  deleteKey(context: OpenRouterOperationContext, resourceId: string): Promise<void>;
}

function operationContext(intent: OpenRouterRotationIntent): OpenRouterOperationContext {
  return {
    workspaceId: intent.workspaceId,
    bindingId: intent.providerBinding.bindingId,
    bindingGeneration: intent.providerBinding.generation,
    providerAccountId: intent.providerBinding.providerAccountId,
  };
}

function assertCanaryEvidence(
  evidence: RuntimeProviderCompletionEvidence,
  intent: OpenRouterRotationIntent,
  record: OpenRouterRotationCutoverRecord,
): void {
  if (evidence.contractId !== intent.canary.contractId
      || evidence.contractVersion !== intent.canary.contractVersion
      || evidence.requestDigest !== intent.canary.requestDigest
      || evidence.responseAssertionDigest !== intent.canary.responseAssertionDigest
      || evidence.modelId !== intent.canary.modelId
      || evidence.targetBindingGeneration !== record.targetBindingGeneration
      || evidence.deployedRevision !== record.deployedRevision) {
    throw new UnprocessableError(
      'Runtime target did not satisfy the exact provider completion canary contract',
      'OPENROUTER_COMPLETION_CANARY_INVALID',
    );
  }
}

function assertTargetRevision(
  revision: z.infer<typeof RuntimeTargetRevisionSchema>,
  record: OpenRouterRotationCutoverRecord,
): void {
  if (revision.bindingGeneration !== record.targetBindingGeneration
      || revision.deployedRevision !== record.deployedRevision) {
    throw new UnprocessableError('Runtime target activation changed the proven revision', 'OPENROUTER_TARGET_REVISION_CHANGED');
  }
}

function deadlineAt(record: OpenRouterRotationCutoverRecord, intent: OpenRouterRotationIntent, now: number): string {
  if (record.timeoutStartedAt === null) {
    throw new UnprocessableError('Rotation execution timeout was not started', 'OPENROUTER_CUTOVER_TIMEOUT_INVALID');
  }
  const elapsed = Math.max(0, now - Date.parse(record.timeoutStartedAt));
  const remaining = intent.timeoutMs - record.timeoutConsumedMs - elapsed;
  if (remaining <= 0) throw new UnprocessableError('Rotation execution timed out', 'OPENROUTER_CUTOVER_TIMEOUT');
  return new Date(now + remaining).toISOString();
}

function operationBase(
  adapter: RuntimeSecretBindingAdapter,
  record: OpenRouterRotationCutoverRecord,
  intent: OpenRouterRotationIntent,
  now: number,
) {
  if (adapter.adapterId !== intent.targetBinding.adapterId) {
    throw new ForbiddenError('Runtime target adapter identity does not match the immutable intent');
  }
  const deadline = deadlineAt(record, intent, now);
  return {
    intentDigest: intent.requestDigest,
    fencingToken: record.fencingToken,
    binding: intent.targetBinding,
    deadlineAt: deadline,
    signal: AbortSignal.timeout(Math.max(1, Date.parse(deadline) - now)),
  };
}
function parseAdapterResult<T>(
  schema: z.ZodType<T>,
  value: unknown,
  message: string,
  code: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new UnprocessableError(message, code);
  return parsed.data;
}


function buildReceipt(
  intent: OpenRouterRotationIntent,
  replacement: OpenRouterRotationReplacement,
  record: OpenRouterRotationCutoverRecord,
  rejection: RuntimeProviderRejectionEvidence,
): OpenRouterRotationCutoverReceipt {
  if (!replacement.providerResourceId || !replacement.runtimeKeyReference
      || !record.targetBindingGeneration || !record.deployedRevision || !record.canaryEvidence) {
    throw new UnprocessableError('Rotation receipt evidence is incomplete', 'OPENROUTER_CUTOVER_RECEIPT_INVALID');
  }
  return OpenRouterRotationCutoverReceiptSchema.parse({
    schemaVersion: 'rorca.openrouter-runtime-key-cutover-receipt.v1',
    receiptId: record.intentId,
    workspaceId: intent.workspaceId,
    requestDigest: intent.requestDigest,
    providerBinding: {
      bindingId: intent.providerBinding.bindingId,
      generation: intent.providerBinding.generation,
    },
    replacement: {
      providerResourceId: replacement.providerResourceId,
      fingerprint: replacement.runtimeKeyReference.fingerprint,
      lifecycleState: 'active',
    },
    target: {
      adapterId: intent.targetBinding.adapterId,
      bindingId: intent.targetBinding.bindingId,
      environmentId: intent.targetBinding.environmentId,
      bindingGeneration: record.targetBindingGeneration,
      deployedRevision: record.deployedRevision,
    },
    canary: {
      contractId: record.canaryEvidence.contractId,
      contractVersion: record.canaryEvidence.contractVersion,
      providerResponseDigest: record.canaryEvidence.providerResponseDigest,
      completedAt: record.canaryEvidence.completedAt,
    },
    retiredKey: {
      providerResourceId: record.oldProviderResourceId,
      fingerprint: intent.currentRuntimeKey.fingerprint,
      rejectionStatus: rejection.rejectionStatus,
      providerResponseDigest: rejection.providerResponseDigest,
      verifiedAt: rejection.verifiedAt,
    },
    emittedAt: rejection.verifiedAt,
  });
}


function rollbackOperationBase(
  adapter: RuntimeSecretBindingAdapter,
  record: OpenRouterRotationCutoverRecord,
  intent: OpenRouterRotationIntent,
  now: number,
) {
  if (adapter.adapterId !== intent.targetBinding.adapterId) {
    throw new ForbiddenError('Runtime target adapter identity does not match the immutable intent');
  }
  const timeoutMs = Math.min(intent.timeoutMs, 60_000);
  const deadline = new Date(now + timeoutMs).toISOString();
  return {
    intentDigest: intent.requestDigest,
    fencingToken: record.fencingToken,
    binding: intent.targetBinding,
    deadlineAt: deadline,
    signal: AbortSignal.timeout(timeoutMs),
  };
}

function buildRecoveryReceipt(
  intent: OpenRouterRotationIntent,
  replacement: OpenRouterRotationReplacement,
  record: OpenRouterRotationCutoverRecord,
  outcome: 'rolled-back' | 'reconciliation-required',
  failureState: OpenRouterRotationCutoverState,
  failureCode: string,
  priorKeyStatus: 'active' | 'disabled' | 'uncertain',
  replacementLifecycle: 'pending' | 'active' | 'revoked' | 'cleanup-required' | 'reconciled',
  emittedAt: string,
): OpenRouterRotationRecoveryReceipt {
  return OpenRouterRotationRecoveryReceiptSchema.parse({
    schemaVersion: 'rorca.openrouter-runtime-key-recovery-receipt.v1',
    receiptId: record.intentId,
    workspaceId: intent.workspaceId,
    requestDigest: intent.requestDigest,
    outcome,
    failure: { state: failureState, code: failureCode },
    providerBinding: {
      bindingId: intent.providerBinding.bindingId,
      generation: intent.providerBinding.generation,
    },
    priorKey: {
      providerResourceId: record.oldProviderResourceId,
      fingerprint: intent.currentRuntimeKey.fingerprint,
      status: priorKeyStatus,
    },
    replacement: {
      providerResourceId: replacement.providerResourceId,
      fingerprint: replacement.runtimeKeyReference?.fingerprint ?? null,
      lifecycleState: replacementLifecycle,
    },
    target: {
      adapterId: intent.targetBinding.adapterId,
      bindingId: intent.targetBinding.bindingId,
      environmentId: intent.targetBinding.environmentId,
      priorGeneration: intent.targetBinding.generation,
      changedGeneration: record.targetBindingGeneration,
      restoredGeneration: record.restoredBindingGeneration,
      restoredRevision: record.restoredRevision,
    },
    emittedAt,
  });
}

export interface OpenRouterCutoverFaults {
  afterBindingStage?(): void | Promise<void>;
  afterDeployAcceptance?(): void | Promise<void>;
  afterCanaryResult?(): void | Promise<void>;
  afterCutover?(): void | Promise<void>;
  afterOldKeyDisable?(): void | Promise<void>;
}

type CutoverFaultBoundary = keyof OpenRouterCutoverFaults;
export class OpenRouterRuntimeKeyCutoverService {
  constructor(
    private readonly rotations: OpenRouterRuntimeKeyRotationService = new OpenRouterRuntimeKeyRotationService(),
    private readonly provider: OpenRouterCutoverProvider = new OpenRouterAuthorityProviderAdapter(),
    private readonly store: OpenRouterRotationCutoverStore = databaseOpenRouterRotationCutoverStore,
    private readonly targets: RuntimeSecretBindingAdapterResolver = runtimeSecretBindingAdapters,
    private readonly now: () => number = Date.now,
    private readonly faults: OpenRouterCutoverFaults = {},
  ) {}

  private async injectCrash(boundary: CutoverFaultBoundary): Promise<void> {
    try {
      await this.faults[boundary]?.();
    } catch {
      throw new UnprocessableError(
        `Injected crash at the ${boundary} boundary`,
        'OPENROUTER_CUTOVER_INJECTED_CRASH',
      );
    }
  }

  private async persist<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new UnprocessableError(
        'Rotation recovery checkpoint could not be persisted',
        'OPENROUTER_CUTOVER_PERSIST_FAILED',
      );
    }
  }

  private async reconciliationRequired(
    input: ExecuteOpenRouterRotationInput,
    replacement: OpenRouterRotationReplacement,
    record: OpenRouterRotationCutoverRecord,
    reasonCode: string,
    failureState: OpenRouterRotationCutoverState,
    priorKeyStatus: 'active' | 'disabled' | 'uncertain',
    replacementCleanupRequired: boolean,
  ): Promise<OpenRouterRotationCutoverRecord> {
    const lifecycle = replacementCleanupRequired
      ? 'cleanup-required' as const
      : replacement.lifecycleState;
    const receipt = buildRecoveryReceipt(
      input.intent,
      replacement,
      record,
      'reconciliation-required',
      failureState,
      reasonCode,
      priorKeyStatus,
      lifecycle,
      new Date(this.now()).toISOString(),
    );
    return this.persist(() => this.store.markReconciliationRequired(
      input.intent,
      replacement,
      input.executionId,
      input.fencingToken,
      reasonCode,
      receipt,
      replacementCleanupRequired,
    ));
  }

  private async cleanReplacement(
    input: ExecuteOpenRouterRotationInput,
    replacement: OpenRouterRotationReplacement,
    record: OpenRouterRotationCutoverRecord,
  ): Promise<OpenRouterRotationCutoverRecord> {
    if (replacement.providerResourceId === null) {
      return this.reconciliationRequired(
        input,
        replacement,
        record,
        'OPENROUTER_REPLACEMENT_ID_UNCERTAIN',
        record.failureState ?? record.state,
        'active',
        true,
      );
    }
    if (replacement.providerResourceId === record.oldProviderResourceId) {
      return this.reconciliationRequired(
        input,
        replacement,
        record,
        'OPENROUTER_REPLACEMENT_ID_CONFLICT',
        record.failureState ?? record.state,
        'active',
        true,
      );
    }

    let resources: OpenRouterKeyMetadata[];
    try {
      resources = await this.provider.listKeys(operationContext(input.intent));
    } catch {
      return this.reconciliationRequired(
        input,
        replacement,
        record,
        'OPENROUTER_REPLACEMENT_CLEANUP_UNCERTAIN',
        record.failureState ?? record.state,
        'active',
        true,
      );
    }
    const resource = resources.find((candidate) => candidate.resourceId === replacement.providerResourceId);
    try {
      if (resource && resource.status !== 'deleted') {
        if (input.intent.rollbackAction === 'delete-replacement') {
          await this.provider.deleteKey(operationContext(input.intent), replacement.providerResourceId);
        } else if (resource.status !== 'disabled') {
          const disabled = parseAdapterResult(
            OpenRouterKeyMetadataSchema,
            await this.provider.disableKey(operationContext(input.intent), replacement.providerResourceId),
            'Replacement key disable returned invalid evidence',
            'OPENROUTER_REPLACEMENT_CLEANUP_UNCERTAIN',
          );
          if (disabled.resourceId !== replacement.providerResourceId || disabled.status !== 'disabled') {
            throw new UnprocessableError(
              'Replacement key disable returned invalid evidence',
              'OPENROUTER_REPLACEMENT_CLEANUP_UNCERTAIN',
            );
          }
        }
      }
      const readback = await this.provider.listKeys(operationContext(input.intent));
      const remaining = readback.find((candidate) => candidate.resourceId === replacement.providerResourceId);
      const cleaned = input.intent.rollbackAction === 'delete-replacement'
        ? remaining === undefined || remaining.status === 'deleted'
        : remaining === undefined || remaining.status === 'disabled' || remaining.status === 'deleted';
      if (!cleaned) {
        throw new UnprocessableError(
          'Replacement key cleanup readback failed',
          'OPENROUTER_REPLACEMENT_CLEANUP_UNCERTAIN',
        );
      }
    } catch {
      return this.reconciliationRequired(
        input,
        replacement,
        record,
        'OPENROUTER_REPLACEMENT_CLEANUP_UNCERTAIN',
        record.failureState ?? record.state,
        'active',
        true,
      );
    }

    const receipt = buildRecoveryReceipt(
      input.intent,
      replacement,
      record,
      'rolled-back',
      record.failureState ?? record.state,
      record.failureCode ?? 'OPENROUTER_CUTOVER_FAILED',
      'active',
      'revoked',
      new Date(this.now()).toISOString(),
    );
    return this.persist(() => this.store.completeRollback(
      input.intent,
      replacement,
      input.executionId,
      input.fencingToken,
      receipt,
    ));
  }

  private async rollback(
    input: ExecuteOpenRouterRotationInput,
    replacement: OpenRouterRotationReplacement,
    record: OpenRouterRotationCutoverRecord,
    target: RuntimeSecretBindingAdapter | null,
    failureCode: string,
  ): Promise<OpenRouterRotationCutoverRecord> {
    if (record.state !== 'ROLLBACK_PENDING' && record.state !== 'TARGET_RESTORED') {
      record = await this.persist(() => this.store.beginRollback(
        input.intent,
        input.executionId,
        input.fencingToken,
        record.state,
        failureCode,
      ));
    }
    if (record.state === 'ROLLBACK_PENDING') {
      if (!target) {
        return this.reconciliationRequired(
          input,
          replacement,
          record,
          'OPENROUTER_TARGET_RESTORE_ADAPTER_UNAVAILABLE',
          record.failureState ?? record.state,
          'active',
          false,
        );
      }
      let restored: z.infer<typeof RuntimeTargetRevisionSchema>;
      try {
        const restoreInput: RestoreRuntimeSecretBindingInput = {
          ...rollbackOperationBase(target, record, input.intent, this.now()),
          priorBindingGeneration: input.intent.targetBinding.generation,
          failedBindingGeneration: record.targetBindingGeneration,
          failedDeployedRevision: record.deployedRevision,
        };
        restored = parseAdapterResult(
          RuntimeTargetRevisionSchema,
          await target.restorePriorBinding(restoreInput),
          'Runtime target returned invalid restoration evidence',
          'OPENROUTER_TARGET_RESTORE_UNCERTAIN',
        );
        if (restored.bindingGeneration !== input.intent.targetBinding.generation) {
          throw new UnprocessableError(
            'Runtime target did not restore the immutable prior generation',
            'OPENROUTER_TARGET_RESTORE_UNCERTAIN',
          );
        }
      } catch {
        return this.reconciliationRequired(
          input,
          replacement,
          record,
          'OPENROUTER_TARGET_RESTORE_UNCERTAIN',
          record.failureState ?? record.state,
          'active',
          false,
        );
      }
      record = await this.persist(() => this.store.recordTargetRestored(
        input.intent,
        input.executionId,
        input.fencingToken,
        restored.bindingGeneration,
        restored.deployedRevision,
      ));
    }
    return this.cleanReplacement(input, replacement, record);
  }


  async execute(rawInput: ExecuteOpenRouterRotationInput): Promise<OpenRouterRotationCutoverRecord> {
    const input = ExecuteOpenRouterRotationInputSchema.parse(rawInput);
    const replacement = await this.rotations.execute(input);
    let record = await this.persist(
      () => this.store.claim(input.intent, replacement, input.executionId, input.fencingToken),
    );
    if (record.state === 'COMPLETED' || record.state === 'ROLLED_BACK') return record;

    const target = this.targets.resolve(input.intent.targetBinding.adapterId);
    if (record.state === 'ROLLBACK_PENDING' || record.state === 'TARGET_RESTORED') {
      return this.rollback(
        input,
        replacement,
        record,
        target,
        record.failureCode ?? 'OPENROUTER_CUTOVER_FAILED',
      );
    }
    if (replacement.operationState !== 'settled') {
      return this.reconciliationRequired(
        input,
        replacement,
        record,
        'OPENROUTER_REPLACEMENT_CREATION_UNCERTAIN',
        record.state,
        'active',
        false,
      );
    }
    if (replacement.providerResourceId === null
        || replacement.providerResourceId === record.oldProviderResourceId) {
      return this.reconciliationRequired(
        input,
        replacement,
        record,
        'OPENROUTER_REPLACEMENT_ID_UNCERTAIN',
        record.state,
        'active',
        true,
      );
    }
    if (replacement.lifecycleState === 'cleanup-required'
        || replacement.runtimeKeyReference === null) {
      return this.rollback(
        input,
        replacement,
        record,
        target,
        'OPENROUTER_REPLACEMENT_NOT_SAFE',
      );
    }
    if (replacement.lifecycleState !== 'pending'
        && replacement.lifecycleState !== 'reconciled') {
      return this.reconciliationRequired(
        input,
        replacement,
        record,
        'OPENROUTER_REPLACEMENT_STATE_INVALID',
        record.state,
        'active',
        false,
      );
    }
    if (record.reconciliationReasonCode !== null) {
      record = await this.persist(() => this.store.clearReconciliationRequired(
        input.intent,
        input.executionId,
        input.fencingToken,
      ));
    }
    if (!target) {
      if (record.state === 'WAITING_FOR_AUTHORIZATION') return record;
      return this.persist(() => this.store.markWaiting(
        input.intent,
        input.executionId,
        input.fencingToken,
        'TARGET_BINDING_ADAPTER_UNAVAILABLE',
      ));
    }
    record = await this.persist(
      () => this.store.startExecution(input.intent, input.executionId, input.fencingToken),
    );

    if (record.state === 'REPLACEMENT_READY') {
      let staged: z.infer<typeof RuntimeSecretBindingStageResultSchema>;
      try {
        staged = parseAdapterResult(
          RuntimeSecretBindingStageResultSchema,
          await target.stageReplacement({
            ...operationBase(target, record, input.intent, this.now()),
            replacement: replacement.runtimeKeyReference,
          }),
          'Runtime target returned invalid staging evidence',
          'OPENROUTER_TARGET_STAGE_INVALID',
        );
        if (staged.bindingGeneration < input.intent.targetBinding.generation) {
          throw new UnprocessableError(
            'Runtime target returned a stale binding generation',
            'OPENROUTER_TARGET_GENERATION_STALE',
          );
        }
      } catch {
        return this.rollback(input, replacement, record, target, 'OPENROUTER_TARGET_STAGE_FAILED');
      }
      await this.injectCrash('afterBindingStage');
      record = await this.persist(() => this.store.recordBindingStaged(
        input.intent,
        input.executionId,
        input.fencingToken,
        staged.bindingGeneration,
        staged.requiresDeployment,
      ));
    }

    if (record.state === 'BINDING_STAGED') {
      let revision: z.infer<typeof RuntimeTargetRevisionSchema>;
      try {
        if (record.targetBindingGeneration === null || record.targetRequiresDeployment === null) {
          throw new UnprocessableError(
            'Runtime target staging evidence is incomplete',
            'OPENROUTER_TARGET_STAGE_INVALID',
          );
        }
        revision = parseAdapterResult(
          RuntimeTargetRevisionSchema,
          await target.deployOrRefresh({
            ...operationBase(target, record, input.intent, this.now()),
            bindingGeneration: record.targetBindingGeneration,
            requiresDeployment: record.targetRequiresDeployment,
          }),
          'Runtime target returned invalid revision evidence',
          'OPENROUTER_TARGET_REVISION_CHANGED',
        );
        if (revision.bindingGeneration !== record.targetBindingGeneration) {
          throw new UnprocessableError(
            'Runtime target deployed a different binding generation',
            'OPENROUTER_TARGET_REVISION_CHANGED',
          );
        }
      } catch {
        return this.rollback(input, replacement, record, target, 'OPENROUTER_TARGET_DEPLOY_FAILED');
      }
      await this.injectCrash('afterDeployAcceptance');
      record = await this.persist(() => this.store.recordTargetDeployed(
        input.intent,
        input.executionId,
        input.fencingToken,
        revision.deployedRevision,
      ));
    }

    if (record.state === 'TARGET_DEPLOYED') {
      let evidence: RuntimeProviderCompletionEvidence;
      try {
        if (record.targetBindingGeneration === null || record.deployedRevision === null) {
          throw new UnprocessableError(
            'Runtime target revision evidence is incomplete',
            'OPENROUTER_TARGET_REVISION_CHANGED',
          );
        }
        evidence = parseAdapterResult(
          RuntimeProviderCompletionEvidenceSchema,
          await target.runProviderCompletionCanary({
            ...operationBase(target, record, input.intent, this.now()),
            bindingGeneration: record.targetBindingGeneration,
            deployedRevision: record.deployedRevision,
            canary: input.intent.canary,
          }),
          'Runtime target did not return provider completion evidence',
          'OPENROUTER_COMPLETION_CANARY_INVALID',
        );
        assertCanaryEvidence(evidence, input.intent, record);
      } catch {
        return this.rollback(input, replacement, record, target, 'OPENROUTER_COMPLETION_CANARY_FAILED');
      }
      await this.injectCrash('afterCanaryResult');
      record = await this.persist(() => this.store.recordCanaryPassed(
        input.intent,
        input.executionId,
        input.fencingToken,
        evidence,
      ));
    }

    if (record.state === 'CANARY_PASSED') {
      try {
        if (record.targetBindingGeneration === null || record.deployedRevision === null) {
          throw new UnprocessableError(
            'Canary target evidence is incomplete',
            'OPENROUTER_COMPLETION_CANARY_INVALID',
          );
        }
        const activated = parseAdapterResult(
          RuntimeTargetRevisionSchema,
          await target.activateStagedBinding({
            ...operationBase(target, record, input.intent, this.now()),
            bindingGeneration: record.targetBindingGeneration,
            deployedRevision: record.deployedRevision,
          }),
          'Runtime target returned invalid activation evidence',
          'OPENROUTER_TARGET_REVISION_CHANGED',
        );
        assertTargetRevision(activated, record);
      } catch {
        return this.rollback(input, replacement, record, target, 'OPENROUTER_TARGET_CUTOVER_FAILED');
      }
      await this.injectCrash('afterCutover');
      record = await this.persist(() => this.store.recordBindingActive(
        input.intent,
        input.executionId,
        input.fencingToken,
      ));
    }

    if (record.state === 'BINDING_ACTIVE') {
      record = await this.persist(() => this.store.beginOldKeyDisable(
        input.intent,
        input.executionId,
        input.fencingToken,
      ));
    }

    if (record.state === 'OLD_KEY_DISABLE_PENDING') {
      let oldKey: OpenRouterKeyMetadata | null;
      try {
        oldKey = (await this.provider.listKeys(operationContext(input.intent)))
          .find((resource) => resource.resourceId === record.oldProviderResourceId) ?? null;
      } catch {
        return this.reconciliationRequired(
          input,
          replacement,
          record,
          'OPENROUTER_OLD_KEY_DISABLE_UNCERTAIN',
          record.state,
          'uncertain',
          false,
        );
      }
      if (oldKey === null) {
        return this.reconciliationRequired(
          input,
          replacement,
          record,
          'OPENROUTER_OLD_KEY_DISABLE_UNCERTAIN',
          record.state,
          'uncertain',
          false,
        );
      }
      if (oldKey.status === 'active') {
        let disableAccepted = false;
        try {
          const disabled = parseAdapterResult(
            OpenRouterKeyMetadataSchema,
            await this.provider.disableKey(operationContext(input.intent), record.oldProviderResourceId),
            'Prior OpenRouter key disable returned invalid evidence',
            'OPENROUTER_OLD_KEY_DISABLE_INVALID',
          );
          disableAccepted = disabled.resourceId === record.oldProviderResourceId
            && disabled.status === 'disabled';
        } catch {
          disableAccepted = false;
        }
        if (disableAccepted) await this.injectCrash('afterOldKeyDisable');
        try {
          oldKey = (await this.provider.listKeys(operationContext(input.intent)))
            .find((resource) => resource.resourceId === record.oldProviderResourceId) ?? null;
        } catch {
          return this.reconciliationRequired(
            input,
            replacement,
            record,
            'OPENROUTER_OLD_KEY_DISABLE_UNCERTAIN',
            record.state,
            'uncertain',
            false,
          );
        }
        if (oldKey?.status === 'active') {
          return this.rollback(input, replacement, record, target, 'OPENROUTER_OLD_KEY_DISABLE_FAILED');
        }
      }
      if (oldKey === null) {
        return this.reconciliationRequired(
          input,
          replacement,
          record,
          'OPENROUTER_OLD_KEY_DISABLE_UNCERTAIN',
          record.state,
          'uncertain',
          false,
        );
      }
      record = await this.persist(() => this.store.recordOldKeyDisabled(
        input.intent,
        input.executionId,
        input.fencingToken,
      ));
    }

    if (record.state === 'OLD_KEY_DISABLED') {
      let rejection: RuntimeProviderRejectionEvidence;
      try {
        if (record.targetBindingGeneration === null || record.deployedRevision === null) {
          throw new UnprocessableError(
            'Active runtime target evidence is incomplete',
            'OPENROUTER_TARGET_REVISION_CHANGED',
          );
        }
        rejection = parseAdapterResult(
          RuntimeProviderRejectionEvidenceSchema,
          await target.verifyProviderCredentialRejected({
            ...operationBase(target, record, input.intent, this.now()),
            bindingGeneration: record.targetBindingGeneration,
            deployedRevision: record.deployedRevision,
            rejectedCredential: {
              secretId: input.intent.currentRuntimeKey.secretReferenceId,
              fingerprint: input.intent.currentRuntimeKey.fingerprint,
            },
          }),
          'Runtime target did not prove prior-key completion rejection',
          'OPENROUTER_OLD_KEY_REJECTION_INVALID',
        );
        if (rejection.keyFingerprint !== input.intent.currentRuntimeKey.fingerprint) {
          throw new UnprocessableError(
            'Rejected credential did not match the prior key',
            'OPENROUTER_OLD_KEY_REJECTION_INVALID',
          );
        }
      } catch {
        return this.reconciliationRequired(
          input,
          replacement,
          record,
          'OPENROUTER_OLD_KEY_REJECTION_UNCERTAIN',
          record.state,
          'disabled',
          false,
        );
      }
      try {
        record = await this.store.complete(
          input.intent,
          replacement,
          input.executionId,
          input.fencingToken,
          rejection,
          buildReceipt(input.intent, replacement, record, rejection),
        );
      } catch {
        return this.reconciliationRequired(
          input,
          replacement,
          record,
          'OPENROUTER_CUTOVER_RECEIPT_UNCERTAIN',
          record.state,
          'disabled',
          false,
        );
      }
    }

    return record;
  }
}
