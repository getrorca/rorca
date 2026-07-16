/**
 * Opaque references for execution secrets.
 *
 * pg-boss persists job data. Never put decrypted workspace variables or provider
 * credentials in that data (or in structured logs). Workers resolve these refs
 * only immediately before spawning the execution child.
 */
import { getWorkspaceEnvVars } from '../routes/env-vars';
import { getVaultKey } from '../routes/vault';

export const EXECUTION_SECRET_REFERENCE_VERSION = 'v1' as const;
export const PROVIDER_ENV: Record<string, { key: string; baseUrlKey?: string }> = {
  anthropic: { key: 'ANTHROPIC_API_KEY' },
  openrouter: { key: 'OPENROUTER_API_KEY' },
  'openai-compat': { key: 'OPENAI_API_KEY', baseUrlKey: 'OPENAI_BASE_URL' },
};

export interface ExecutionSecretReferences {
  version: typeof EXECUTION_SECRET_REFERENCE_VERSION;
  workspaceId: string;
  /** Identity reference only; this is not a credential. */
  vaultUserId?: string;
  providers: Array<keyof typeof PROVIDER_ENV>;
  includeWorkspaceEnv: true;
}

export function createExecutionSecretReferences(input: {
  workspaceId: string | number;
  vaultUserId?: string;
  providers?: Array<keyof typeof PROVIDER_ENV>;
}): ExecutionSecretReferences {
  return {
    version: EXECUTION_SECRET_REFERENCE_VERSION,
    workspaceId: String(input.workspaceId),
    ...(input.vaultUserId ? { vaultUserId: input.vaultUserId } : {}),
    providers: [...new Set(input.providers ?? Object.keys(PROVIDER_ENV) as Array<keyof typeof PROVIDER_ENV>)],
    includeWorkspaceEnv: true,
  };
}

/** Resolve secret material at the execution boundary only. */
export async function resolveExecutionSecrets(refs?: ExecutionSecretReferences): Promise<Record<string, string>> {
  if (!refs) return {};
  const env = refs.includeWorkspaceEnv ? await getWorkspaceEnvVars(refs.workspaceId) : {};
  if (!refs.vaultUserId) return env;

  for (const provider of refs.providers) {
    const mapping = PROVIDER_ENV[provider];
    if (!mapping || env[mapping.key]) continue;
    const vaultKey = await getVaultKey(refs.vaultUserId, provider);
    if (!vaultKey?.key || typeof vaultKey.key !== 'string') continue;
    env[mapping.key] = vaultKey.key;
    if (mapping.baseUrlKey && typeof vaultKey.baseUrl === 'string' && vaultKey.baseUrl) {
      env[mapping.baseUrlKey] = vaultKey.baseUrl;
    }
  }
  return env;
}

/** Safe metadata for logs/tests; deliberately contains no environment values. */
export function redactExecutionJobPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const { envOverrides: _envOverrides, secretReferences, ...safe } = payload;
  const refs = secretReferences as Partial<ExecutionSecretReferences> | undefined;
  return {
    ...safe,
    envOverrides: '[redacted]',
    ...(refs ? { secretReferences: {
      version: refs.version,
      workspaceId: refs.workspaceId,
      providerCount: Array.isArray(refs.providers) ? refs.providers.length : 0,
      includeWorkspaceEnv: refs.includeWorkspaceEnv === true,
    } } : {}),
  };
}

/** Avoid persisting secrets if a hook echoes an environment value. */
export function redactSecretText(text: string, secrets: Record<string, string>): string {
  return Object.values(secrets).reduce((redacted, secret) => (
    secret && secret.length >= 4 ? redacted.split(secret).join('[REDACTED]') : redacted
  ), text);
}
