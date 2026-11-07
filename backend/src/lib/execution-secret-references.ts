/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Opaque references for execution secrets.
 *
 * pg-boss persists job data. Never put decrypted workspace variables or provider
 * credentials in that data (or in structured logs). Workers resolve these refs
 * only immediately before spawning the execution child.
 */
import { getWorkspaceEnvVars } from '../routes/env-vars';
import { getVaultKey } from '../routes/vault';
import {
  assertAuthorityRedactedValue,
  redactAuthorityLogValue,
} from './authority-redaction';

export const EXECUTION_SECRET_REFERENCE_VERSION = 'v1' as const;
export type ExecutionProviderCredential = 'anthropic' | 'openrouter' | 'openai-compat';
export const PROVIDER_ENV: Record<ExecutionProviderCredential, { key: string; baseUrlKey?: string }> = {
  anthropic: { key: 'ANTHROPIC_API_KEY' },
  openrouter: { key: 'OPENROUTER_API_KEY' },
  'openai-compat': { key: 'OPENAI_API_KEY', baseUrlKey: 'OPENAI_BASE_URL' },
};

export interface ExecutionSecretReferences {
  version: typeof EXECUTION_SECRET_REFERENCE_VERSION;
  workspaceId: string;
  /** Identity reference only; this is not a credential. */
  vaultUserId?: string;
  providers: ExecutionProviderCredential[];
  includeWorkspaceEnv: boolean;
}

export function createExecutionSecretReferences(input: {
  workspaceId: string | number;
  vaultUserId?: string;
  providers?: ExecutionProviderCredential[];
  includeWorkspaceEnv?: boolean;
}): ExecutionSecretReferences {
  return {
    version: EXECUTION_SECRET_REFERENCE_VERSION,
    workspaceId: String(input.workspaceId),
    ...(input.vaultUserId ? { vaultUserId: input.vaultUserId } : {}),
    providers: [...new Set(input.providers ?? Object.keys(PROVIDER_ENV) as ExecutionProviderCredential[])],
    includeWorkspaceEnv: input.includeWorkspaceEnv ?? true,
  };
}

/** Resolve secret material at the execution boundary only. */
export async function resolveExecutionSecrets(refs?: ExecutionSecretReferences): Promise<Record<string, string>> {
  if (!refs) return {};
  const workspaceEnv = await getWorkspaceEnvVars(refs.workspaceId);
  const env: Record<string, string> = refs.includeWorkspaceEnv ? { ...workspaceEnv } : {};

  for (const provider of refs.providers) {
    const mapping = PROVIDER_ENV[provider];
    if (!mapping) continue;
    // A contained recovery child may request only model-provider credentials,
    // never arbitrary workspace variables. Prefer an existing workspace value
    // before consulting the user vault.
    if (workspaceEnv[mapping.key]) env[mapping.key] = workspaceEnv[mapping.key];
    if (mapping.baseUrlKey && workspaceEnv[mapping.baseUrlKey]) {
      env[mapping.baseUrlKey] = workspaceEnv[mapping.baseUrlKey];
    }
    if (env[mapping.key] || !refs.vaultUserId) continue;
    const vaultKey = await getVaultKey(refs.vaultUserId, provider);
    if (!vaultKey?.key || typeof vaultKey.key !== 'string') continue;
    env[mapping.key] = vaultKey.key;
    if (mapping.baseUrlKey && typeof vaultKey.baseUrl === 'string' && vaultKey.baseUrl) {
      env[mapping.baseUrlKey] = vaultKey.baseUrl;
    }
  }
  return env;
}
/** Reject credential bytes before a payload is persisted as pg-boss JSON. */
export function assertExecutionJobPayloadRedacted(payload: Record<string, unknown>): void {
  assertAuthorityRedactedValue(payload, {
    allowedReferenceKeys: ['secretReferences'],
    maximumBytes: 256 * 1024,
  });
}


/** Safe metadata for logs/tests; deliberately contains no environment values. */
export function redactExecutionJobPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const { envOverrides: _envOverrides, secretReferences, ...safe } = payload;
  const refs = secretReferences as Partial<ExecutionSecretReferences> | undefined;
  const projection = {
    ...safe,
    envOverrides: '[redacted]',
    ...(refs ? { secretReferences: {
      version: refs.version,
      workspaceId: refs.workspaceId,
      providerCount: Array.isArray(refs.providers) ? refs.providers.length : 0,
      includeWorkspaceEnv: refs.includeWorkspaceEnv === true,
    } } : {}),
  };
  return redactAuthorityLogValue(projection) as Record<string, unknown>;
}

/** Avoid persisting secrets if a hook echoes an environment value. */
export function redactSecretText(text: string, secrets: Record<string, string>): string {
  const explicitlyRedacted = Object.values(secrets).reduce((redacted, secret) => (
    secret && secret.length >= 4 ? redacted.split(secret).join('[REDACTED]') : redacted
  ), text);
  return redactAuthorityLogValue(explicitlyRedacted, Object.values(secrets)) as string;
}
