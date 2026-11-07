/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { execute, query, queryOne, transaction } from '../db/index';
import {
  DELIVERY_AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION,
  OpenRouterManagementOperationSchema,
  OpenRouterPolicyLimitsSchema,
  OpenRouterProviderBindingSchema,
  type AuthorityCapability,
  type DeliveryAuthorityProviderAdapter,
  type OpenRouterManagementOperation,
  type OpenRouterPolicyLimits,
  type OpenRouterProviderBinding,
  type ProviderBinding,
} from './authority-provider-adapter';
import { boundedOutboundFetch } from './bounded-outbound-fetch';
import { DeliveryAdapterDescriptorSchema, type DeliveryAdapterDescriptor } from './delivery-adapter';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError, ValidationError } from './errors';
import {
  insertPreparedIntegrationSecret,
  prepareOpenRouterManagementSecret,
  resolveOpenRouterManagementSecret,
  storeOpenRouterRuntimeSecret,
} from './integration-vault';

export { OpenRouterManagementOperationSchema, OpenRouterPolicyLimitsSchema, OpenRouterProviderBindingSchema };
export type { OpenRouterManagementOperation, OpenRouterPolicyLimits, OpenRouterProviderBinding };

export const OPENROUTER_AUTHORITY_ADAPTER_CONTRACT_VERSION = DELIVERY_AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION;
export const OPENROUTER_AUTHORITY_ADAPTER_DESCRIPTOR: DeliveryAdapterDescriptor = DeliveryAdapterDescriptorSchema.parse({
  contractVersion: 'rorca.delivery-adapter.v1',
  adapterId: 'openrouter-runtime-keys',
  adapterVersion: '1.0.0',
  label: 'OpenRouter runtime-key authority',
  kind: 'provider',
  default: false,
  optional: true,
  requiresNetwork: true,
  requiresCredentials: true,
  supportsReviewBundle: false,
  supportsExternalChangeRequest: false,
  implementationStatus: 'canonical_adapter',
  mergeAuthority: 'none',
  deploymentAuthority: 'none',
});
const OPENROUTER_API_ORIGIN = 'https://openrouter.ai';
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const PROVIDER_TIMEOUT_MS = 10_000;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const OpenRouterKeyMetadataSchema = z.object({
  resourceId: z.string().min(1).max(255),
  fingerprint: z.string().regex(SHA256_PATTERN),
  name: z.string().min(1).max(255),
  status: z.enum(['active', 'disabled', 'deleted']),
  limits: z.object({
    creditLimitUsd: z.number().finite().nonnegative().nullable(),
    usage: z.number().finite().nonnegative().nullable(),
    limitReset: z.enum(['daily', 'weekly', 'monthly']).nullable(),
    includeByokInLimit: z.boolean(),
  }).strict(),
  providerCreatedAt: z.string().datetime().nullable(),
  providerUpdatedAt: z.string().datetime().nullable(),
}).strict();
export type OpenRouterKeyMetadata = z.infer<typeof OpenRouterKeyMetadataSchema>;

export const OpenRouterRuntimeKeyReferenceSchema = z.object({
  secretId: z.string().uuid(),
  fingerprint: z.string().regex(SHA256_PATTERN),
}).strict();
export type OpenRouterRuntimeKeyReference = z.infer<typeof OpenRouterRuntimeKeyReferenceSchema>;

export const OpenRouterCreatedLimitedKeySchema = z.object({
  key: OpenRouterKeyMetadataSchema,
  runtimeKeyReference: OpenRouterRuntimeKeyReferenceSchema,
}).strict();
export type OpenRouterCreatedLimitedKey = z.infer<typeof OpenRouterCreatedLimitedKeySchema>;

export const OpenRouterOperationContextSchema = z.object({
  workspaceId: z.string().min(1).max(255),
  bindingId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  providerAccountId: z.string().min(1).max(255),
}).strict();
export type OpenRouterOperationContext = z.infer<typeof OpenRouterOperationContextSchema>;

export const OpenRouterCreateLimitedKeySchema = OpenRouterOperationContextSchema.extend({
  name: z.string().trim().min(1).max(120),
  creditLimitUsd: z.number().finite().positive().max(10_000),
  usageLimit: z.number().finite().nonnegative().max(1_000_000_000).nullable(),
  limitReset: z.enum(['daily', 'weekly', 'monthly']).nullable(),
  includeByokInLimit: z.boolean().optional(),
}).strict();
export type OpenRouterCreateLimitedKey = z.infer<typeof OpenRouterCreateLimitedKeySchema>;

interface ProviderBindingRow {
  id: string;
  workspace_id: string;
  provider_account_id: string;
  generation: string | number;
  status: 'active' | 'disabled' | 'invalid';
  management_secret_id: string;
  management_secret_fingerprint: `sha256:${string}`;
  policy_limits: OpenRouterPolicyLimits | string;
  approved_operations: OpenRouterManagementOperation[];
  provider_account_verified: boolean;
  completion_probe_rejected: boolean;
  verified_at: string | null;
  validation_error_code: string | null;
}

interface ProviderResourceRow {
  provider_resource_id: string;
}

interface RuntimeKeyReferenceRow {
  secret_id: string;
  fingerprint: string;
}

export interface OpenRouterProviderResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

export interface OpenRouterProviderTransport {
  request(input: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    credential: string;
    body?: Readonly<Record<string, unknown>>;
  }): Promise<OpenRouterProviderResponse>;
}

export interface OpenRouterAuthorityStore {
  readBinding(bindingId: string): Promise<OpenRouterProviderBinding | null>;
  readBindingForWorkspace(workspaceId: string): Promise<OpenRouterProviderBinding | null>;
  markBindingVerified(bindingId: string): Promise<void>;
  saveResources(binding: OpenRouterProviderBinding, resources: readonly OpenRouterKeyMetadata[], runtimeSecretId?: string): Promise<void>;
  assertResourceOwned(binding: OpenRouterProviderBinding, resourceId: string): Promise<void>;
  markResourceStatus(binding: OpenRouterProviderBinding, resourceId: string, status: 'disabled' | 'deleted'): Promise<void>;
  readRuntimeKeyReference(
    binding: OpenRouterProviderBinding,
    resourceId: string,
  ): Promise<OpenRouterRuntimeKeyReference | null>;
}

export interface OpenRouterSecretStore {
  resolveManagementCredential(secretId: string): Promise<string | null>;
  storeRuntimeCredential(value: string, createdBy: string): Promise<{ id: string; fingerprint: string }>;
}

function parseJsonObject(value: OpenRouterPolicyLimits | string): OpenRouterPolicyLimits {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return OpenRouterPolicyLimitsSchema.parse(parsed);
}

function mapBinding(row: ProviderBindingRow): OpenRouterProviderBinding {
  return OpenRouterProviderBindingSchema.parse({
    providerId: 'openrouter',
    bindingId: row.id,
    workspaceId: row.workspace_id,
    bindingStatus: row.status,
    providerAccountId: row.provider_account_id,
    generation: Number(row.generation),
    managementSecretReference: {
      secretId: row.management_secret_id,
      fingerprint: row.management_secret_fingerprint,
    },
    policyLimits: parseJsonObject(row.policy_limits),
    approvedOperations: row.approved_operations,
    health: {
      providerAccountVerified: row.provider_account_verified,
      completionProbeRejected: row.completion_probe_rejected,
      verifiedAt: row.verified_at,
      validationErrorCode: row.validation_error_code,
    },
  });
}

async function readBinding(where: 'id' | 'workspace_id', value: string): Promise<OpenRouterProviderBinding | null> {
  const row = await queryOne<ProviderBindingRow>(
    `SELECT id, workspace_id, provider_account_id, generation, status, management_secret_id,
            management_secret_fingerprint, policy_limits, approved_operations,
            provider_account_verified, completion_probe_rejected, verified_at, validation_error_code
       FROM provider_authority_bindings
      WHERE provider = 'openrouter' AND ${where} = $1`,
    [value],
  );
  return row ? mapBinding(row) : null;
}

const databaseStore: OpenRouterAuthorityStore = {
  readBinding: (bindingId) => readBinding('id', bindingId),
  readBindingForWorkspace: (workspaceId) => readBinding('workspace_id', workspaceId),
  async markBindingVerified(bindingId) {
    await execute(
      `UPDATE provider_authority_bindings
          SET status = 'active', provider_account_verified = TRUE, completion_probe_rejected = TRUE,
              verified_at = NOW(), validation_error_code = NULL, disabled_at = NULL, updated_at = NOW()
        WHERE id = $1 AND status = 'invalid'`,
      [bindingId],
    );
  },
  async saveResources(binding, resources, runtimeSecretId) {
    for (const resource of resources) {
      await execute(
        `INSERT INTO provider_key_resources
           (id, provider, provider_binding_id, workspace_id, binding_generation, provider_account_id,
            provider_resource_id, key_fingerprint, runtime_secret_id, display_name, status, policy_limits,
            provider_created_at, provider_updated_at)
         VALUES ($1, 'openrouter', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
         ON CONFLICT (provider_binding_id, provider_resource_id) DO UPDATE SET
           key_fingerprint = EXCLUDED.key_fingerprint,
           runtime_secret_id = COALESCE(EXCLUDED.runtime_secret_id, provider_key_resources.runtime_secret_id),
           display_name = EXCLUDED.display_name,
           status = EXCLUDED.status,
           policy_limits = EXCLUDED.policy_limits,
           provider_created_at = COALESCE(EXCLUDED.provider_created_at, provider_key_resources.provider_created_at),
           provider_updated_at = EXCLUDED.provider_updated_at,
           updated_at = NOW()`,
        [
          crypto.randomUUID(), binding.bindingId, binding.workspaceId, binding.generation,
          binding.providerAccountId, resource.resourceId, resource.fingerprint, runtimeSecretId ?? null,
          resource.name, resource.status, JSON.stringify(resource.limits),
          resource.providerCreatedAt, resource.providerUpdatedAt,
        ],
      );
    }
  },
  async assertResourceOwned(binding, resourceId) {
    const row = await queryOne<ProviderResourceRow>(
      `SELECT provider_resource_id FROM provider_key_resources
        WHERE provider_binding_id = $1 AND workspace_id = $2 AND binding_generation = $3
          AND provider_account_id = $4 AND provider_resource_id = $5 AND status <> 'deleted'`,
      [binding.bindingId, binding.workspaceId, binding.generation, binding.providerAccountId, resourceId],
    );
    if (!row) throw new ForbiddenError('Provider resource is not authorized for this binding');
  },
  async markResourceStatus(binding, resourceId, status) {
    await execute(
      `UPDATE provider_key_resources SET status = $1, updated_at = NOW()
        WHERE provider_binding_id = $2 AND workspace_id = $3 AND binding_generation = $4
          AND provider_account_id = $5 AND provider_resource_id = $6`,
      [status, binding.bindingId, binding.workspaceId, binding.generation, binding.providerAccountId, resourceId],
    );
  },
  async readRuntimeKeyReference(binding, resourceId) {
    const row = await queryOne<RuntimeKeyReferenceRow>(
      `SELECT secret.id AS secret_id, secret.fingerprint
         FROM provider_key_resources AS resource
         JOIN integration_vault_secrets AS secret
           ON secret.id = resource.runtime_secret_id
          AND secret.provider = resource.provider
          AND secret.secret_kind = resource.runtime_secret_kind
        WHERE resource.provider_binding_id = $1
          AND resource.workspace_id = $2
          AND resource.binding_generation = $3
          AND resource.provider_account_id = $4
          AND resource.provider_resource_id = $5
          AND resource.status <> 'deleted'
          AND secret.revoked_at IS NULL`,
      [binding.bindingId, binding.workspaceId, binding.generation, binding.providerAccountId, resourceId],
    );
    return row
      ? OpenRouterRuntimeKeyReferenceSchema.parse({
        secretId: row.secret_id,
        fingerprint: row.fingerprint,
      })
      : null;
  },
};

const databaseSecretStore: OpenRouterSecretStore = {
  resolveManagementCredential: resolveOpenRouterManagementSecret,
  async storeRuntimeCredential(value, createdBy) {
    const stored = await storeOpenRouterRuntimeSecret(value, createdBy);
    return { id: stored.id, fingerprint: stored.fingerprint };
  },
};

const openRouterTransport: OpenRouterProviderTransport = {
  async request(input) {
    const response = await boundedOutboundFetch(new URL(input.path, OPENROUTER_API_ORIGIN), {
      maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES,
      connectionTimeoutMs: 3_000,
      totalTimeoutMs: PROVIDER_TIMEOUT_MS,
      requestInit: {
        method: input.method,
        headers: {
          Authorization: `Bearer ${input.credential}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      },
    });
    let body: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new UnprocessableError('OpenRouter returned a malformed response', 'OPENROUTER_RESPONSE_INVALID');
      }
    }
    return { status: response.status, headers: response.headers, body };
  },
};

function objectValue(value: unknown): Record<string, unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  return parsed.success ? parsed.data : {};
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function nullableTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function resourceFingerprint(resourceId: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update('rorca.openrouter-resource.v1\0').update(resourceId).digest('hex')}`;
}

function parseKeyMetadata(value: unknown): OpenRouterKeyMetadata {
  const key = objectValue(value);
  const resourceId = typeof key.hash === 'string' ? key.hash : typeof key.id === 'string' ? key.id : '';
  const name = typeof key.name === 'string' && key.name.trim()
    ? key.name.trim()
    : typeof key.label === 'string' && key.label.trim() ? key.label.trim() : '';
  const reset = key.limit_reset;
  const parsed = OpenRouterKeyMetadataSchema.safeParse({
    resourceId,
    fingerprint: resourceFingerprint(resourceId),
    name,
    status: key.deleted === true ? 'deleted' : key.disabled === true ? 'disabled' : 'active',
    limits: {
      creditLimitUsd: nullableNumber(key.limit),
      usage: nullableNumber(key.usage),
      limitReset: reset === 'daily' || reset === 'weekly' || reset === 'monthly' ? reset : null,
      includeByokInLimit: key.include_byok_in_limit === true,
    },
    providerCreatedAt: nullableTimestamp(key.created_at),
    providerUpdatedAt: nullableTimestamp(key.updated_at),
  });
  if (!parsed.success) {
    throw new UnprocessableError('OpenRouter key metadata response was invalid', 'OPENROUTER_RESPONSE_INVALID');
  }
  return parsed.data;
}

function parseKeyList(body: unknown): OpenRouterKeyMetadata[] {
  const data = objectValue(body).data;
  if (!Array.isArray(data)) {
    throw new UnprocessableError('OpenRouter key metadata response was invalid', 'OPENROUTER_RESPONSE_INVALID');
  }
  return data.map(parseKeyMetadata);
}

function assertCredentialAbsent(value: unknown, credentials: readonly string[]): void {
  const serialized = JSON.stringify(value);
  if (credentials.some((credential) => credential.length > 0 && serialized.includes(credential))) {
    throw new UnprocessableError('OpenRouter metadata contained credential material', 'OPENROUTER_RESPONSE_INVALID');
  }
}

function providerAccountIdentity(response: OpenRouterProviderResponse): string | null {
  const body = objectValue(response.body);
  const data = objectValue(body.data);
  const value = response.headers.get('x-openrouter-account-id') ?? body.account_id ?? data.account_id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function assertProviderSuccess(response: OpenRouterProviderResponse, operation: string): void {
  if (response.status < 200 || response.status >= 300) {
    throw new UnprocessableError(`OpenRouter ${operation} was rejected`, 'OPENROUTER_OPERATION_REJECTED');
  }
}

function assertCreatePolicy(binding: OpenRouterProviderBinding, input: OpenRouterCreateLimitedKey): void {
  if (input.creditLimitUsd > binding.policyLimits.maxCreditUsd) {
    throw new ForbiddenError('Requested credit limit exceeds the approved binding policy');
  }
  if (binding.policyLimits.maxUsage !== null
      && (input.usageLimit === null || input.usageLimit > binding.policyLimits.maxUsage)) {
    throw new ForbiddenError('Requested usage limit exceeds the approved binding policy');
  }
  if (input.limitReset !== null && !binding.policyLimits.allowedLimitResets.includes(input.limitReset)) {
    throw new ForbiddenError('Requested limit reset is not approved by the binding policy');
  }
  if (input.includeByokInLimit !== undefined
      && input.includeByokInLimit !== binding.policyLimits.includeByokInLimit) {
    throw new ForbiddenError('Requested BYOK limit policy does not match the approved binding policy');
  }
}

export class OpenRouterAuthorityProviderAdapter
implements DeliveryAuthorityProviderAdapter {
  readonly contractVersion = OPENROUTER_AUTHORITY_ADAPTER_CONTRACT_VERSION;
  readonly descriptor = OPENROUTER_AUTHORITY_ADAPTER_DESCRIPTOR;
  readonly capabilities: readonly AuthorityCapability[] = Object.freeze([...OpenRouterManagementOperationSchema.options] as readonly AuthorityCapability[]);

  constructor(
    private readonly store: OpenRouterAuthorityStore = databaseStore,
    private readonly secretStore: OpenRouterSecretStore = databaseSecretStore,
    private readonly transport: OpenRouterProviderTransport = openRouterTransport,
  ) {}

  private async resolveManagementCredential(binding: OpenRouterProviderBinding): Promise<string> {
    let credential: string | null;
    try {
      credential = await this.secretStore.resolveManagementCredential(binding.managementSecretReference.secretId);
    } catch {
      throw new UnprocessableError(
        'OpenRouter management credential is unavailable',
        'OPENROUTER_CREDENTIAL_UNAVAILABLE',
      );
    }
    if (typeof credential !== 'string' || credential.length === 0) {
      throw new UnprocessableError(
        'OpenRouter management credential is unavailable',
        'OPENROUTER_CREDENTIAL_UNAVAILABLE',
      );
    }
    return credential;
  }

  private async requestProvider(
    input: Parameters<OpenRouterProviderTransport['request']>[0],
  ): Promise<OpenRouterProviderResponse> {
    try {
      return await this.transport.request(input);
    } catch {
      throw new UnprocessableError(
        'OpenRouter provider request failed',
        'OPENROUTER_PROVIDER_UNAVAILABLE',
      );
    }
  }

  async getProviderBinding(workspaceId: string): Promise<OpenRouterProviderBinding | null> {
    return this.store.readBindingForWorkspace(workspaceId);
  }

  async revalidateProviderBinding(workspaceId: string, _bindingId: string): Promise<ProviderBinding> {
    const binding = await this.store.readBindingForWorkspace(workspaceId);
    if (!binding) throw new NotFoundError('OpenRouter provider binding not found');
    return binding;
  }

  private async authorize(
    rawContext: OpenRouterOperationContext,
    operation: OpenRouterManagementOperation,
  ): Promise<{ binding: OpenRouterProviderBinding; credential: string }> {
    const context = OpenRouterOperationContextSchema.parse({
      workspaceId: rawContext.workspaceId,
      bindingId: rawContext.bindingId,
      bindingGeneration: rawContext.bindingGeneration,
      providerAccountId: rawContext.providerAccountId,
    });
    const binding = await this.store.readBinding(context.bindingId);
    if (!binding) throw new NotFoundError('OpenRouter provider binding not found');
    if (binding.workspaceId !== context.workspaceId) throw new ForbiddenError('Provider binding workspace does not match');
    if (binding.generation !== context.bindingGeneration) throw new ForbiddenError('Provider binding generation is stale');
    if (binding.providerAccountId !== context.providerAccountId) throw new ForbiddenError('Provider account does not match');
    if (binding.bindingStatus === 'disabled') throw new ForbiddenError('Provider binding is disabled');
    if (operation !== 'verify_binding' && binding.bindingStatus !== 'active') {
      throw new ForbiddenError('Provider binding is not healthy');
    }
    if (!binding.approvedOperations.includes(operation)) {
      throw new ForbiddenError('Provider management operation is not approved');
    }

    const credential = await this.resolveManagementCredential(binding);
    const fingerprint = `sha256:${crypto.createHash('sha256').update(credential, 'utf8').digest('hex')}`;
    if (fingerprint !== binding.managementSecretReference.fingerprint) {
      throw new ForbiddenError('Provider account credential does not match the binding');
    }
    return { binding, credential };
  }

  async verify(rawContext: OpenRouterOperationContext): Promise<OpenRouterProviderBinding> {
    const { binding, credential } = await this.authorize(rawContext, 'verify_binding');
    const management = await this.requestProvider({ method: 'GET', path: '/api/v1/keys', credential });
    assertProviderSuccess(management, 'management endpoint probe');
    parseKeyList(management.body);
    const accountId = providerAccountIdentity(management);
    if (accountId !== binding.providerAccountId) {
      throw new ForbiddenError('OpenRouter account identity did not match the binding');
    }

    const completion = await this.requestProvider({
      method: 'POST',
      path: '/api/v1/chat/completions',
      credential,
      body: {
        model: 'openrouter/free',
        messages: [{ role: 'user', content: 'credential-boundary-probe' }],
        max_tokens: 1,
      },
    });
    if (completion.status !== 401 && completion.status !== 403) {
      throw new UnprocessableError(
        'OpenRouter management credential was not rejected by the completion endpoint',
        'OPENROUTER_MANAGEMENT_CREDENTIAL_CAN_INFER',
      );
    }
    await this.store.markBindingVerified(binding.bindingId);
    const verified = await this.store.readBinding(binding.bindingId);
    if (!verified || verified.bindingStatus !== 'active') {
      throw new UnprocessableError('OpenRouter binding verification could not be persisted', 'OPENROUTER_BINDING_PERSIST_FAILED');
    }
    return verified;
  }

  async listKeys(rawContext: OpenRouterOperationContext): Promise<OpenRouterKeyMetadata[]> {
    const { binding, credential } = await this.authorize(rawContext, 'list_keys');
    const response = await this.requestProvider({ method: 'GET', path: '/api/v1/keys', credential });
    assertProviderSuccess(response, 'key listing');
    const accountId = providerAccountIdentity(response);
    if (accountId !== binding.providerAccountId) throw new ForbiddenError('OpenRouter account identity did not match the binding');
    const resources = parseKeyList(response.body);
    assertCredentialAbsent(resources, [credential]);
    await this.store.saveResources(binding, resources);
    return resources;
  }

  async createLimitedKeyForRotation(rawInput: OpenRouterCreateLimitedKey): Promise<OpenRouterCreatedLimitedKey> {
    const input = OpenRouterCreateLimitedKeySchema.parse(rawInput);
    const { binding, credential } = await this.authorize(input, 'create_limited_key');
    assertCreatePolicy(binding, input);
    const response = await this.requestProvider({
      method: 'POST',
      path: '/api/v1/keys',
      credential,
      body: {
        name: input.name,
        limit: input.creditLimitUsd,
        limit_reset: input.limitReset,
        include_byok_in_limit: input.includeByokInLimit ?? binding.policyLimits.includeByokInLimit,
        ...(input.usageLimit === null ? {} : { usage_limit: input.usageLimit }),
      },
    });
    assertProviderSuccess(response, 'limited-key creation');
    const responseBody = objectValue(response.body);
    const runtimeCredential = typeof responseBody.key === 'string' ? responseBody.key : null;
    if (!runtimeCredential) {
      throw new UnprocessableError('OpenRouter did not return the created runtime credential', 'OPENROUTER_RESPONSE_INVALID');
    }
    const resource = parseKeyMetadata(responseBody.data);
    assertCredentialAbsent(resource, [credential, runtimeCredential]);
    let stored: { id: string; fingerprint: string };
    try {
      stored = await this.secretStore.storeRuntimeCredential(
        runtimeCredential,
        `openrouter-binding:${binding.bindingId}`,
      );
    } catch {
      throw new UnprocessableError(
        'OpenRouter runtime credential could not be stored',
        'OPENROUTER_RUNTIME_SECRET_STORE_FAILED',
      );
    }
    if (!z.string().uuid().safeParse(stored.id).success || !SHA256_PATTERN.test(stored.fingerprint)) {
      throw new UnprocessableError(
        'OpenRouter runtime credential could not be stored',
        'OPENROUTER_RUNTIME_SECRET_STORE_FAILED',
      );
    }
    await this.store.saveResources(binding, [resource], stored.id);
    return OpenRouterCreatedLimitedKeySchema.parse({
      key: resource,
      runtimeKeyReference: {
        secretId: stored.id,
        fingerprint: stored.fingerprint,
      },
    });
  }

  async createLimitedKey(rawInput: OpenRouterCreateLimitedKey): Promise<OpenRouterKeyMetadata> {
    return (await this.createLimitedKeyForRotation(rawInput)).key;
  }

  async getStoredRuntimeKeyReference(
    rawContext: OpenRouterOperationContext,
    resourceId: string,
  ): Promise<OpenRouterRuntimeKeyReference | null> {
    const { binding } = await this.authorize(rawContext, 'list_keys');
    await this.store.assertResourceOwned(binding, resourceId);
    return this.store.readRuntimeKeyReference(binding, resourceId);
  }

  async disableKey(rawContext: OpenRouterOperationContext, resourceId: string): Promise<OpenRouterKeyMetadata> {
    const { binding, credential } = await this.authorize(rawContext, 'disable_key');
    await this.store.assertResourceOwned(binding, resourceId);
    const response = await this.requestProvider({
      method: 'PATCH',
      path: `/api/v1/keys/${encodeURIComponent(resourceId)}`,
      credential,
      body: { disabled: true },
    });
    assertProviderSuccess(response, 'key disable');
    const resource = parseKeyMetadata(objectValue(response.body).data);
    assertCredentialAbsent(resource, [credential]);
    if (resource.resourceId !== resourceId || resource.status !== 'disabled') {
      throw new UnprocessableError('OpenRouter key disable could not be verified', 'OPENROUTER_RESPONSE_INVALID');
    }
    await this.store.markResourceStatus(binding, resourceId, 'disabled');
    return resource;
  }

  async deleteKey(rawContext: OpenRouterOperationContext, resourceId: string): Promise<void> {
    const { binding, credential } = await this.authorize(rawContext, 'delete_key');
    await this.store.assertResourceOwned(binding, resourceId);
    const response = await this.requestProvider({
      method: 'DELETE',
      path: `/api/v1/keys/${encodeURIComponent(resourceId)}`,
      credential,
    });
    assertProviderSuccess(response, 'key deletion');
    await this.store.markResourceStatus(binding, resourceId, 'deleted');
  }
}

export interface RegisterOpenRouterBindingInput {
  workspaceId: string;
  providerAccountId: string;
  managementCredential: string;
  policyLimits: OpenRouterPolicyLimits;
  approvedOperations: OpenRouterManagementOperation[];
  createdBy: string;
}

/** Configure one fail-closed binding. Verification is a separate provider probe. */
export async function registerOpenRouterBinding(rawInput: RegisterOpenRouterBindingInput): Promise<OpenRouterProviderBinding> {
  const input = z.object({
    workspaceId: z.string().min(1).max(255),
    providerAccountId: z.string().min(1).max(255),
    managementCredential: z.string().trim().min(16).max(1024),
    policyLimits: OpenRouterPolicyLimitsSchema,
    approvedOperations: z.array(OpenRouterManagementOperationSchema).min(1).max(5),
    createdBy: z.string().min(1).max(255),
  }).strict().parse(rawInput);
  const prepared = prepareOpenRouterManagementSecret(input.managementCredential, input.createdBy);
  const bindingId = crypto.randomUUID();
  try {
    await transaction(async (client) => {
      await insertPreparedIntegrationSecret(client, prepared);
      await client.query(
        `INSERT INTO provider_authority_bindings
           (id, provider, workspace_id, provider_account_id, generation, status,
            management_secret_id, management_secret_fingerprint, policy_limits,
            approved_operations, created_by)
         VALUES ($1, 'openrouter', $2, $3, 1, 'invalid', $4, $5, $6::jsonb, $7::text[], $8)`,
        [
          bindingId, input.workspaceId, input.providerAccountId, prepared.id, prepared.fingerprint,
          JSON.stringify(input.policyLimits), [...new Set(input.approvedOperations)], input.createdBy,
        ],
      );
    });
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw new ConflictError('An OpenRouter provider binding already exists for this workspace');
    }
    throw error;
  }
  const binding = await readBinding('id', bindingId);
  if (!binding) throw new UnprocessableError('OpenRouter binding could not be persisted', 'OPENROUTER_BINDING_PERSIST_FAILED');
  return binding;
}

/** Disable only future provider authority; existing runtime/provider keys are untouched. */
export async function disableOpenRouterBinding(workspaceId: string, bindingId: string, generation: number): Promise<void> {
  if (!workspaceId.trim() || !z.string().uuid().safeParse(bindingId).success || !Number.isSafeInteger(generation) || generation < 1) {
    throw new ValidationError('Exact workspace, binding, and positive generation are required');
  }
  const result = await execute(
    `UPDATE provider_authority_bindings
        SET status = 'disabled', disabled_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2 AND provider = 'openrouter' AND generation = $3 AND status <> 'disabled'`,
    [bindingId, workspaceId, generation],
  );
  if (result.rowCount === 0) throw new ConflictError('OpenRouter binding is missing, stale, or already disabled');
}

/** Read-only redacted core resource projection for routes and receipts. */
export async function listRecordedOpenRouterKeys(workspaceId: string, bindingId: string): Promise<OpenRouterKeyMetadata[]> {
  const rows = await query<{
    provider_resource_id: string;
    key_fingerprint: string;
    display_name: string;
    status: 'active' | 'disabled' | 'deleted';
    policy_limits: OpenRouterKeyMetadata['limits'] | string;
    provider_created_at: string | null;
    provider_updated_at: string | null;
  }>(
    `SELECT provider_resource_id, key_fingerprint, display_name, status, policy_limits,
            provider_created_at, provider_updated_at
       FROM provider_key_resources
      WHERE workspace_id = $1 AND provider_binding_id = $2
      ORDER BY created_at DESC`,
    [workspaceId, bindingId],
  );
  return rows.map((row) => {
    let limits: unknown = row.policy_limits;
    if (typeof limits === 'string') {
      try {
        limits = JSON.parse(limits);
      } catch {
        throw new UnprocessableError('Recorded OpenRouter key metadata is invalid', 'OPENROUTER_RESOURCE_INVALID');
      }
    }
    return OpenRouterKeyMetadataSchema.parse({
      resourceId: row.provider_resource_id,
      fingerprint: row.key_fingerprint,
      name: row.display_name,
      status: row.status,
      limits,
      providerCreatedAt: row.provider_created_at,
      providerUpdatedAt: row.provider_updated_at,
    });
  });
}
