/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { queryOne, transaction } from '../db/index';
import { ConflictError, ForbiddenError, UnprocessableError } from './errors';
import {
  OpenRouterAuthorityProviderAdapter,
  OpenRouterCreatedLimitedKeySchema,
  OpenRouterKeyMetadataSchema,
  OpenRouterRuntimeKeyReferenceSchema,
  type OpenRouterCreateLimitedKey,
  type OpenRouterCreatedLimitedKey,
  type OpenRouterKeyMetadata,
  type OpenRouterOperationContext,
  type OpenRouterRuntimeKeyReference,
} from './openrouter-authority-provider-adapter';
import {
  RuntimeSecretBindingReferenceSchema,
  type RuntimeSecretBindingReference,
} from './openrouter-runtime-binding-adapter';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const INTENT_DIGEST_DOMAIN = 'rorca.openrouter-runtime-key-rotation-intent.v1\0';
const MAX_REPLACEMENT_NAME_LENGTH = 120;

const Sha256Schema = z.string().regex(SHA256_PATTERN);


export const OpenRouterRotationLimitsSchema = z.object({
  creditLimitUsd: z.number().finite().positive().max(10_000),
  usageLimit: z.number().finite().nonnegative().max(1_000_000_000).nullable(),
  limitReset: z.enum(['daily', 'weekly', 'monthly']).nullable(),
  includeByokInLimit: z.boolean(),
}).strict();
export type OpenRouterRotationLimits = z.infer<typeof OpenRouterRotationLimitsSchema>;

export const OpenRouterCanaryContractReferenceSchema = z.object({
  contractId: z.string().trim().min(1).max(255),
  contractVersion: z.number().int().positive(),
  requestDigest: Sha256Schema,
  responseAssertionDigest: Sha256Schema,
  modelId: z.string().trim().min(1).max(255),
  maxTokens: z.number().int().positive().max(4096),
}).strict();
export type OpenRouterCanaryContractReference = z.infer<typeof OpenRouterCanaryContractReferenceSchema>;

export const OpenRouterRotationIntentMaterialSchema = z.object({
  schemaVersion: z.literal('rorca.openrouter-runtime-key-rotation-intent.v1'),
  workspaceId: z.string().trim().min(1).max(255),
  providerBinding: z.object({
    providerId: z.literal('openrouter'),
    bindingId: z.string().uuid(),
    generation: z.number().int().positive(),
    providerAccountId: z.string().trim().min(1).max(255),
  }).strict(),
  currentRuntimeKey: z.object({
    secretReferenceId: z.string().uuid(),
    fingerprint: Sha256Schema,
  }).strict(),
  desiredName: z.string().trim().min(1).max(120),
  limits: OpenRouterRotationLimitsSchema,
  targetBinding: RuntimeSecretBindingReferenceSchema,
  canary: OpenRouterCanaryContractReferenceSchema,
  timeoutMs: z.number().int().positive().max(86_400_000),
  rollbackAction: z.enum(['restore-prior-binding', 'disable-replacement', 'delete-replacement']),
}).strict().superRefine((value, ctx) => {
  if (value.targetBinding.workspaceId !== value.workspaceId) {
    ctx.addIssue({
      code: 'custom',
      path: ['targetBinding', 'workspaceId'],
      message: 'target binding must belong to the rotation workspace',
    });
  }
});
export type OpenRouterRotationIntentMaterial = z.infer<typeof OpenRouterRotationIntentMaterialSchema>;

function digestIntentMaterial(material: OpenRouterRotationIntentMaterial): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256')
    .update(INTENT_DIGEST_DOMAIN, 'utf8')
    .update(JSON.stringify(material), 'utf8')
    .digest('hex')}`;
}

export const OpenRouterRotationIntentSchema = OpenRouterRotationIntentMaterialSchema.safeExtend({
  requestDigest: Sha256Schema,
}).strict().superRefine((value, ctx) => {
  const { requestDigest: _requestDigest, ...material } = value;
  if (value.requestDigest !== digestIntentMaterial(OpenRouterRotationIntentMaterialSchema.parse(material))) {
    ctx.addIssue({
      code: 'custom',
      path: ['requestDigest'],
      message: 'request digest does not match the immutable rotation intent',
    });
  }
});

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type OpenRouterRotationIntent = DeepReadonly<z.infer<typeof OpenRouterRotationIntentSchema>>;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export function calculateOpenRouterRotationIntentDigest(
  rawMaterial: OpenRouterRotationIntentMaterial,
): `sha256:${string}` {
  const material = OpenRouterRotationIntentMaterialSchema.parse(rawMaterial);
  return digestIntentMaterial(material);
}

export function createOpenRouterRotationIntent(
  rawMaterial: OpenRouterRotationIntentMaterial,
): OpenRouterRotationIntent {
  const material = OpenRouterRotationIntentMaterialSchema.parse(rawMaterial);
  return deepFreeze(OpenRouterRotationIntentSchema.parse({
    ...material,
    requestDigest: digestIntentMaterial(material),
  }));
}

export function assertOpenRouterRotationApproval(
  rawIntent: OpenRouterRotationIntent,
  approvedRequestDigest: string,
): OpenRouterRotationIntent {
  const intent = deepFreeze(OpenRouterRotationIntentSchema.parse(rawIntent));
  if (!SHA256_PATTERN.test(approvedRequestDigest) || approvedRequestDigest !== intent.requestDigest) {
    throw new ForbiddenError('Rotation approval does not match the exact immutable request digest');
  }
  return intent;
}

export function openRouterReplacementName(intent: OpenRouterRotationIntent): string {
  const marker = `[rorca:${intent.requestDigest.slice('sha256:'.length)}]`;
  const desiredLength = MAX_REPLACEMENT_NAME_LENGTH - marker.length - 1;
  return `${intent.desiredName.slice(0, desiredLength).trimEnd()} ${marker}`;
}

export const OpenRouterRotationLifecycleStateSchema = z.enum([
  'pending',
  'active',
  'revoked',
  'cleanup-required',
  'reconciled',
]);
export type OpenRouterRotationLifecycleState = z.infer<typeof OpenRouterRotationLifecycleStateSchema>;

const OpenRouterRotationOperationStateSchema = z.enum(['creating', 'creation-uncertain', 'settled']);

export const OpenRouterRotationReplacementSchema = z.object({
  intentId: z.string().uuid(),
  requestDigest: Sha256Schema,
  workspaceId: z.string().min(1).max(255),
  stableName: z.string().min(1).max(MAX_REPLACEMENT_NAME_LENGTH),
  fencingToken: z.number().int().positive(),
  executionId: z.string().uuid(),
  operationState: OpenRouterRotationOperationStateSchema,
  lifecycleState: OpenRouterRotationLifecycleStateSchema,
  providerResourceId: z.string().min(1).max(255).nullable(),
  runtimeKeyReference: OpenRouterRuntimeKeyReferenceSchema.nullable(),
  limits: OpenRouterRotationLimitsSchema,
  targetBinding: RuntimeSecretBindingReferenceSchema,
}).strict().superRefine((value, ctx) => {
  if (value.operationState === 'settled' && value.providerResourceId === null) {
    ctx.addIssue({ code: 'custom', path: ['providerResourceId'], message: 'settled replacement requires a provider resource id' });
  }
  if (value.runtimeKeyReference !== null && value.providerResourceId === null) {
    ctx.addIssue({ code: 'custom', path: ['runtimeKeyReference'], message: 'runtime key reference requires a provider resource id' });
  }
});
export type OpenRouterRotationReplacement = z.infer<typeof OpenRouterRotationReplacementSchema>;

export type OpenRouterRotationClaim = Readonly<{
  action: 'create' | 'reconcile' | 'return';
  replacement: OpenRouterRotationReplacement;
}>;

export interface OpenRouterRotationStore {
  claim(
    intent: OpenRouterRotationIntent,
    stableName: string,
    executionId: string,
    fencingToken: number,
  ): Promise<OpenRouterRotationClaim>;
  recordCreated(
    intent: OpenRouterRotationIntent,
    executionId: string,
    fencingToken: number,
    created: OpenRouterCreatedLimitedKey,
  ): Promise<OpenRouterRotationReplacement>;
  recordReconciled(
    intent: OpenRouterRotationIntent,
    executionId: string,
    fencingToken: number,
    resource: OpenRouterKeyMetadata,
    runtimeKeyReference: OpenRouterRuntimeKeyReference | null,
    lifecycleState: 'reconciled' | 'cleanup-required',
  ): Promise<OpenRouterRotationReplacement>;
  markCreationUncertain(
    intent: OpenRouterRotationIntent,
    executionId: string,
    fencingToken: number,
  ): Promise<OpenRouterRotationReplacement>;
}

export interface OpenRouterRotationProvider {
  createLimitedKeyForRotation(input: OpenRouterCreateLimitedKey): Promise<OpenRouterCreatedLimitedKey>;
  listKeys(context: OpenRouterOperationContext): Promise<OpenRouterKeyMetadata[]>;
  getStoredRuntimeKeyReference(
    context: OpenRouterOperationContext,
    resourceId: string,
  ): Promise<OpenRouterRuntimeKeyReference | null>;
}

interface RotationRow {
  intent_id: string;
  intent_payload: unknown;
  intent_digest: string;
  workspace_id: string;
  stable_name: string;
  fencing_token: string | number;
  execution_id: string;
  operation_state: 'creating' | 'creation-uncertain' | 'settled';
  lifecycle_state: OpenRouterRotationLifecycleState;
  provider_resource_id: string | null;
  runtime_secret_id: string | null;
  runtime_secret_fingerprint: string | null;
  declared_limits: OpenRouterRotationLimits | string;
  target_binding: RuntimeSecretBindingReference | string;
}

function parseJsonColumn<T>(value: T | string): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function mapReplacement(row: RotationRow): OpenRouterRotationReplacement {
  return OpenRouterRotationReplacementSchema.parse({
    intentId: row.intent_id,
    requestDigest: row.intent_digest,
    workspaceId: row.workspace_id,
    stableName: row.stable_name,
    fencingToken: Number(row.fencing_token),
    executionId: row.execution_id,
    operationState: row.operation_state,
    lifecycleState: row.lifecycle_state,
    providerResourceId: row.provider_resource_id,
    runtimeKeyReference: row.runtime_secret_id === null
      ? null
      : { secretId: row.runtime_secret_id, fingerprint: row.runtime_secret_fingerprint },
    limits: parseJsonColumn(row.declared_limits),
    targetBinding: parseJsonColumn(row.target_binding),
  });
}

const ROTATION_SELECT = `
  SELECT intent.id AS intent_id, intent.intent_payload, intent.intent_digest, intent.workspace_id,
         replacement.stable_name, replacement.fencing_token, replacement.execution_id,
         replacement.operation_state, replacement.lifecycle_state, replacement.provider_resource_id,
         replacement.runtime_secret_id, secret.fingerprint AS runtime_secret_fingerprint,
         replacement.declared_limits, replacement.target_binding
    FROM runtime_key_rotation_intents AS intent
    JOIN runtime_key_rotation_replacements AS replacement ON replacement.intent_id = intent.id
    LEFT JOIN integration_vault_secrets AS secret ON secret.id = replacement.runtime_secret_id
   WHERE intent.workspace_id = $1 AND intent.intent_digest = $2`;

async function readReplacement(workspaceId: string, requestDigest: string): Promise<RotationRow | undefined> {
  return queryOne<RotationRow>(ROTATION_SELECT, [workspaceId, requestDigest]);
}

function assertPersistedIntent(row: RotationRow, intent: OpenRouterRotationIntent): void {
  const persisted = OpenRouterRotationIntentSchema.parse(parseJsonColumn(row.intent_payload));
  if (JSON.stringify(persisted) !== JSON.stringify(intent)) {
    throw new ConflictError('Rotation digest is already bound to different immutable intent material');
  }
}

async function requireReplacement(intent: OpenRouterRotationIntent): Promise<OpenRouterRotationReplacement> {
  const row = await readReplacement(intent.workspaceId, intent.requestDigest);
  if (!row) throw new UnprocessableError('Rotation replacement state could not be persisted', 'OPENROUTER_ROTATION_PERSIST_FAILED');
  assertPersistedIntent(row, intent);
  return mapReplacement(row);
}

export const databaseOpenRouterRotationStore: OpenRouterRotationStore = {
  async claim(intent, stableName, executionId, fencingToken) {
    return transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${intent.workspaceId}:${intent.requestDigest}`]);
      let row = await readReplacement(intent.workspaceId, intent.requestDigest);
      if (!row) {
        const intentId = crypto.randomUUID();
        const insertedIntent = await client.query(
          `INSERT INTO runtime_key_rotation_intents
             (id, workspace_id, provider_binding_id, binding_generation, provider_account_id,
              current_runtime_secret_id, current_key_fingerprint, target_adapter_id, target_binding_id,
              target_workspace_id, target_environment_id, target_generation, desired_name, declared_limits,
              canary_contract, timeout_ms, rollback_action, intent_digest, intent_payload)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb,
                  $15::jsonb, $16, $17, $18, $19::jsonb
             FROM provider_key_resources AS current_resource
             JOIN integration_vault_secrets AS current_secret
               ON current_secret.id = current_resource.runtime_secret_id
              AND current_secret.provider = current_resource.provider
              AND current_secret.secret_kind = current_resource.runtime_secret_kind
            WHERE current_resource.provider_binding_id = $3
              AND current_resource.workspace_id = $2
              AND current_resource.binding_generation = $4
              AND current_resource.provider_account_id = $5
              AND current_resource.runtime_secret_id = $6
              AND current_resource.status = 'active'
              AND current_secret.fingerprint = $7
              AND current_secret.revoked_at IS NULL
            LIMIT 1`,
          [
            intentId, intent.workspaceId, intent.providerBinding.bindingId, intent.providerBinding.generation,
            intent.providerBinding.providerAccountId, intent.currentRuntimeKey.secretReferenceId,
            intent.currentRuntimeKey.fingerprint, intent.targetBinding.adapterId, intent.targetBinding.bindingId,
            intent.targetBinding.workspaceId, intent.targetBinding.environmentId, intent.targetBinding.generation,
            intent.desiredName, JSON.stringify(intent.limits), JSON.stringify(intent.canary), intent.timeoutMs,
            intent.rollbackAction, intent.requestDigest, JSON.stringify(intent),
          ],
        );
        if ((insertedIntent.rowCount ?? 0) !== 1) {
          throw new ForbiddenError('Current runtime key does not belong to the exact provider binding scope');
        }
        await client.query(
          `INSERT INTO runtime_key_rotation_replacements
             (intent_id, workspace_id, intent_digest, provider_binding_id, stable_name, fencing_token,
              execution_id, operation_state, lifecycle_state, declared_limits, target_binding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'creating', 'pending', $8::jsonb, $9::jsonb)`,
          [
            intentId, intent.workspaceId, intent.requestDigest, intent.providerBinding.bindingId,
            stableName, fencingToken, executionId, JSON.stringify(intent.limits),
            JSON.stringify(intent.targetBinding),
          ],
        );
        row = await readReplacement(intent.workspaceId, intent.requestDigest);
        if (!row) throw new UnprocessableError('Rotation claim could not be persisted', 'OPENROUTER_ROTATION_PERSIST_FAILED');
        return { action: 'create' as const, replacement: mapReplacement(row) };
      }

      assertPersistedIntent(row, intent);
      const replacement = mapReplacement(row);
      if (fencingToken < replacement.fencingToken) {
        throw new ForbiddenError('Rotation execution fence is stale');
      }
      if (fencingToken > replacement.fencingToken) {
        await client.query(
          `UPDATE runtime_key_rotation_replacements
              SET fencing_token = $1, execution_id = $2, updated_at = NOW()
            WHERE intent_id = $3`,
          [fencingToken, executionId, replacement.intentId],
        );
        row = await readReplacement(intent.workspaceId, intent.requestDigest);
        if (!row) throw new UnprocessableError('Rotation fence could not be persisted', 'OPENROUTER_ROTATION_PERSIST_FAILED');
      }
      const current = mapReplacement(row);
      return {
        action: current.operationState === 'settled' ? 'return' as const : 'reconcile' as const,
        replacement: current,
      };
    });
  },

  async recordCreated(intent, executionId, fencingToken, created) {
    const parsed = OpenRouterCreatedLimitedKeySchema.parse(created);
    const result = await transaction(async (client) => client.query(
      `UPDATE runtime_key_rotation_replacements AS replacement
          SET provider_resource_id = $1, runtime_secret_id = $2, operation_state = 'settled',
              lifecycle_state = 'pending', updated_at = NOW()
         FROM runtime_key_rotation_intents AS intent
        WHERE replacement.intent_id = intent.id
          AND intent.workspace_id = $3 AND intent.intent_digest = $4
          AND replacement.execution_id = $5 AND replacement.fencing_token = $6
          AND replacement.operation_state = 'creating'
          AND replacement.provider_resource_id IS NULL`,
      [
        parsed.key.resourceId, parsed.runtimeKeyReference.secretId, intent.workspaceId,
        intent.requestDigest, executionId, fencingToken,
      ],
    ));
    if ((result.rowCount ?? 0) === 0) {
      const current = await requireReplacement(intent);
      if (current.providerResourceId !== parsed.key.resourceId) {
        throw new ConflictError('Rotation creation result lost its execution fence');
      }
      return current;
    }
    return requireReplacement(intent);
  },

  async recordReconciled(intent, executionId, fencingToken, resource, runtimeKeyReference, lifecycleState) {
    const parsedResource = OpenRouterKeyMetadataSchema.parse(resource);
    const parsedReference = runtimeKeyReference === null ? null : OpenRouterRuntimeKeyReferenceSchema.parse(runtimeKeyReference);
    const result = await transaction(async (client) => client.query(
      `UPDATE runtime_key_rotation_replacements AS replacement
          SET provider_resource_id = $1, runtime_secret_id = $2, operation_state = 'settled',
              lifecycle_state = $3, execution_id = $4, updated_at = NOW()
         FROM runtime_key_rotation_intents AS intent
        WHERE replacement.intent_id = intent.id
          AND intent.workspace_id = $5 AND intent.intent_digest = $6
          AND replacement.fencing_token = $7
          AND replacement.operation_state <> 'settled'
          AND replacement.provider_resource_id IS NULL`,
      [
        parsedResource.resourceId, parsedReference?.secretId ?? null, lifecycleState, executionId,
        intent.workspaceId, intent.requestDigest, fencingToken,
      ],
    ));
    if ((result.rowCount ?? 0) === 0) {
      const current = await requireReplacement(intent);
      if (current.providerResourceId !== parsedResource.resourceId) {
        throw new ConflictError('Rotation reconciliation result conflicts with durable state');
      }
      return current;
    }
    return requireReplacement(intent);
  },

  async markCreationUncertain(intent, executionId, fencingToken) {
    await transaction(async (client) => client.query(
      `UPDATE runtime_key_rotation_replacements AS replacement
          SET operation_state = 'creation-uncertain', execution_id = $1, updated_at = NOW()
         FROM runtime_key_rotation_intents AS intent
        WHERE replacement.intent_id = intent.id
          AND intent.workspace_id = $2 AND intent.intent_digest = $3
          AND replacement.fencing_token = $4
          AND replacement.operation_state <> 'settled'`,
      [executionId, intent.workspaceId, intent.requestDigest, fencingToken],
    ));
    return requireReplacement(intent);
  },
};

export const ExecuteOpenRouterRotationInputSchema = z.object({
  intent: OpenRouterRotationIntentSchema,
  approvedRequestDigest: Sha256Schema,
  executionId: z.string().uuid(),
  fencingToken: z.number().int().positive(),
}).strict();
export type ExecuteOpenRouterRotationInput = z.infer<typeof ExecuteOpenRouterRotationInputSchema>;

function operationContext(intent: OpenRouterRotationIntent): OpenRouterOperationContext {
  return {
    workspaceId: intent.workspaceId,
    bindingId: intent.providerBinding.bindingId,
    bindingGeneration: intent.providerBinding.generation,
    providerAccountId: intent.providerBinding.providerAccountId,
  };
}

function resourceMatchesIntent(resource: OpenRouterKeyMetadata, intent: OpenRouterRotationIntent): boolean {
  return resource.name === openRouterReplacementName(intent)
    && resource.limits.creditLimitUsd === intent.limits.creditLimitUsd
    && resource.limits.limitReset === intent.limits.limitReset
    && resource.limits.includeByokInLimit === intent.limits.includeByokInLimit;
}

export interface OpenRouterRotationFaults {
  afterProviderAcceptance?(
    created: OpenRouterCreatedLimitedKey,
    intent: OpenRouterRotationIntent,
  ): void | Promise<void>;
}

export class OpenRouterRuntimeKeyRotationService {
  constructor(
    private readonly provider: OpenRouterRotationProvider = new OpenRouterAuthorityProviderAdapter(),
    private readonly store: OpenRouterRotationStore = databaseOpenRouterRotationStore,
    private readonly faults: OpenRouterRotationFaults = {},
  ) {}

  private async reconcile(
    intent: OpenRouterRotationIntent,
    executionId: string,
    fencingToken: number,
  ): Promise<OpenRouterRotationReplacement> {
    let resources: OpenRouterKeyMetadata[];
    try {
      resources = await this.provider.listKeys(operationContext(intent));
    } catch {
      return this.store.markCreationUncertain(intent, executionId, fencingToken);
    }
    const named = resources.filter((resource) => resource.name === openRouterReplacementName(intent));
    if (named.length > 1) {
      throw new ConflictError('Multiple provider keys match one rotation intent');
    }
    const resource = named[0];
    if (!resource) return this.store.markCreationUncertain(intent, executionId, fencingToken);

    let runtimeKeyReference: OpenRouterRuntimeKeyReference | null = null;
    try {
      runtimeKeyReference = await this.provider.getStoredRuntimeKeyReference(
        operationContext(intent),
        resource.resourceId,
      );
    } catch {
      runtimeKeyReference = null;
    }
    const safe = resourceMatchesIntent(resource, intent) && runtimeKeyReference !== null;
    return this.store.recordReconciled(
      intent,
      executionId,
      fencingToken,
      resource,
      runtimeKeyReference,
      safe ? 'reconciled' : 'cleanup-required',
    );
  }

  async execute(rawInput: ExecuteOpenRouterRotationInput): Promise<OpenRouterRotationReplacement> {
    const input = ExecuteOpenRouterRotationInputSchema.parse(rawInput);
    const intent = assertOpenRouterRotationApproval(input.intent, input.approvedRequestDigest);
    const stableName = openRouterReplacementName(intent);
    const claim = await this.store.claim(intent, stableName, input.executionId, input.fencingToken);
    if (claim.action === 'return') return claim.replacement;
    if (claim.action === 'reconcile') return this.reconcile(intent, input.executionId, input.fencingToken);

    let created: OpenRouterCreatedLimitedKey;
    try {
      created = await this.provider.createLimitedKeyForRotation({
        ...operationContext(intent),
        name: stableName,
        creditLimitUsd: intent.limits.creditLimitUsd,
        usageLimit: intent.limits.usageLimit,
        limitReset: intent.limits.limitReset,
        includeByokInLimit: intent.limits.includeByokInLimit,
      });
    } catch {
      return this.reconcile(intent, input.executionId, input.fencingToken);
    }

    try {
      await this.faults.afterProviderAcceptance?.(created, intent);
    } catch {
      throw new UnprocessableError(
        'Injected crash at the afterProviderAcceptance boundary',
        'OPENROUTER_ROTATION_INJECTED_CRASH',
      );
    }
    try {
      if (!resourceMatchesIntent(created.key, intent)) {
        return await this.store.recordReconciled(
          intent,
          input.executionId,
          input.fencingToken,
          created.key,
          created.runtimeKeyReference,
          'cleanup-required',
        );
      }
      return await this.store.recordCreated(intent, input.executionId, input.fencingToken, created);
    } catch {
      return this.reconcile(intent, input.executionId, input.fencingToken);
    }
  }
}
