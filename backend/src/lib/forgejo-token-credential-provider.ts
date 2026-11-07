/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Repository-scoped Forgejo token credential provider (W5-002).
 *
 * Mirrors `github-app-credential-provider.ts` / `github-token-resolver.ts`
 * with Forgejo-native token authentication: no JWT, no App-install flow. The
 * raw token NEVER enters the database, API responses, logs, streams, or
 * evidence — only a peppered digest and the exact capability-probe profile are
 * persisted. Tokens are bound per workspace to exactly ONE repository; unknown
 * or over-scoped capabilities fail closed.
 */

import * as crypto from 'node:crypto';
import { transaction } from '../db/index';
import { ConflictError, UnprocessableError, ValidationError } from './errors';
import { assertForgejoRepositoryIdentity } from './forgejo-repository-authority';
import { boundedOutboundFetch, parsePrivateHostAllowlist } from './bounded-outbound-fetch';

/** Vault key for webhook-secret ciphertext at rest. Mirrors auth-utils: an
 * explicit VAULT_KEY wins, otherwise JWT_SECRET (dev fallback keeps local
 * test fixtures hermetic; production must set JWT_SECRET/VAULT_KEY). */
function forgejoWebhookSecretKey(): Buffer {
  const explicit = process.env.VAULT_KEY;
  const raw = explicit || process.env.JWT_SECRET || 'rorca-dev-secret-change-in-production';
  return explicit ? Buffer.from(explicit, 'hex') : crypto.createHash('sha256').update(raw).digest();
}

export const forgejoWebhookSecretCipher = Object.freeze({
  /** AES-256-GCM ciphertext `<iv>:<tag>:<ct>`; never a plaintext or digest. */
  encrypt(plaintext: string): string {
    if (typeof plaintext !== 'string' || plaintext.length < 16 || plaintext.length > 1024) {
      throw new ValidationError('Forgejo webhook secret must be between 16 and 1024 characters');
    }
    const key = forgejoWebhookSecretKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  },
  /** Decrypt stored ciphertext; returns null when malformed or key-mismatched
   * (fail closed — never throw into request handling). */
  decrypt(stored: string): string | null {
    try {
      const parts = stored.split(':');
      if (parts.length !== 3 || !parts.every((part) => /^[0-9a-f]+$/i.test(part))) return null;
      const [ivHex, tagHex, ctHex] = parts;
      const iv = Buffer.from(ivHex, 'hex');
      const tag = Buffer.from(tagHex, 'hex');
      const ct = Buffer.from(ctHex, 'hex');
      if (iv.length !== 12 || tag.length !== 16 || ct.length === 0) return null;
      const decipher = crypto.createDecipheriv('aes-256-gcm', forgejoWebhookSecretKey(), iv);
      decipher.setAuthTag(tag);
      return decipher.update(ct) + decipher.final('utf8');
    } catch {
      return null;
    }
  },
});
/** Bind the current managed client (transaction or advisory fence) to one
 * workspace so RLS-scoped Forgejo queries resolve exactly that scope. */
export async function scopeForgejoWorkspace(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  workspaceId: string,
): Promise<void> {
  await client.query(`SELECT set_config('rorca.workspace_id', $1, TRUE)`, [workspaceId]);
}

const PROVIDER_TIMEOUT_MS = 10_000;
const PROVIDER_CONNECTION_TIMEOUT_MS = 3_000;
const PROVIDER_MAX_RESPONSE_BYTES = 256 * 1024;
const PROBE_FRESHNESS_MS = 24 * 60 * 60_000;
const MAX_CACHE_ENTRIES = 256;

export type ForgejoCredentialPurpose =
  | 'repository-read'
  | 'statuses-write'
  | 'pulls-read'
  | 'pulls-write'
  | 'routine';

export type ForgejoCredentialStatus = 'active' | 'disabled' | 'invalid' | 'revoked';

/** The exact bounded write profile the adapter requires. Anything broader or
 * unknown (admin, extra permissions, extra repositories) fails the probe. */
export const FORGEJO_REQUIRED_SCOPE_PROFILE = Object.freeze({
  permissions: { pull: true as const, push: true as const, admin: false as const },
});

export interface ForgejoCredentialBinding {
  bindingId: string;
  workspaceId: string;
  instanceUrl: string;
  owner: string;
  name: string;
  status: ForgejoCredentialStatus;
  tokenDigest: string;
  scopeProfile: Record<string, unknown>;
  credentialVersion: number;
  keyVersion: number;
  expiresAt: string | null;
  lastValidatedAt: string | null;
  validationErrorCode: string | null;
  auditProvenanceHash: string | null;
  createdAt: string;
  /** Ciphertext-only webhook signing secret state (never plaintext). */
  webhookSecretEncrypted: string | null;
  webhookSecretPreviousEncrypted: string | null;
  webhookSecretVersion: number;
}

export interface ForgejoTokenMetadata {
  source: 'forgejo-token';
  bindingId: string;
  instanceUrl: string;
  owner: string;
  name: string;
  credentialVersion: number;
  keyVersion: number;
  scopeProfile: Record<string, unknown>;
  expiresAt: string | null;
}

export interface ResolvedForgejoToken {
  token: string;
  metadata: ForgejoTokenMetadata;
}

interface BindingRow {
  id: string;
  workspace_id: string;
  instance_url: string;
  repo_owner: string;
  repo_name: string;
  status: ForgejoCredentialStatus;
  token_digest: string;
  scope_profile: Record<string, unknown> | string;
  credential_version: number | string;
  key_version: number | string;
  expires_at: string | null;
  last_validated_at: string | null;
  validation_error_code: string | null;
  audit_provenance_hash: string | null;
  webhook_secret_encrypted: string | null;
  webhook_secret_previous_encrypted: string | null;
  webhook_secret_version: number | string;
  created_at: string;
}

interface ProviderDependencies {
  fetch: typeof fetch;
  now: () => Date;
  resolveHostname?: (hostname: string) => Promise<readonly string[]>;
}

const DEFAULT_DEPS: ProviderDependencies = { fetch, now: () => new Date() };

/** In-memory raw-token cache keyed by binding id — never persisted. */
const tokenCache = new Map<string, { token: string; expiresAtMs: number; cachedAtMs: number }>();

export function clearForgejoTokenCacheForTests(): void {
  tokenCache.clear();
}

export function forgejoCredentialDigest(
  workspaceId: string,
  instanceUrl: string,
  owner: string,
  name: string,
  token: string,
  credentialVersion: number,
  keyVersion: number,
): string {
  if (Buffer.byteLength(token, 'utf8') < 16 || Buffer.byteLength(token, 'utf8') > 1024) {
    throw new ValidationError('Forgejo token must contain between 16 and 1024 bytes');
  }
  return `sha256:${crypto.createHash('sha256')
    .update('rorca.forgejo-token.v1\0')
    .update(workspaceId).update('\0')
    .update(instanceUrl).update('\0')
    .update(owner.toLowerCase()).update('\0')
    .update(name.toLowerCase()).update('\0')
    .update(String(credentialVersion)).update('\0')
    .update(String(keyVersion)).update('\0')
    .update(token)
    .digest('hex')}`;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mapBinding(row: BindingRow): ForgejoCredentialBinding {
  return {
    bindingId: row.id,
    workspaceId: row.workspace_id,
    instanceUrl: row.instance_url,
    owner: row.repo_owner,
    name: row.repo_name,
    status: row.status,
    tokenDigest: row.token_digest,
    scopeProfile: parseObject(row.scope_profile),
    credentialVersion: Number(row.credential_version),
    keyVersion: Number(row.key_version),
    expiresAt: row.expires_at,
    lastValidatedAt: row.last_validated_at,
    validationErrorCode: row.validation_error_code,
    auditProvenanceHash: row.audit_provenance_hash,
    webhookSecretEncrypted: row.webhook_secret_encrypted,
    webhookSecretPreviousEncrypted: row.webhook_secret_previous_encrypted,
    webhookSecretVersion: Number(row.webhook_secret_version),
    createdAt: row.created_at,
  };
}

export async function getWorkspaceForgejoCredential(workspaceId: string): Promise<ForgejoCredentialBinding | null> {
  return transaction(async (client) => {
    await scopeForgejoWorkspace(client, workspaceId);
    const row = (await client.query<BindingRow>(
      `SELECT id, workspace_id, instance_url, repo_owner, repo_name, status, token_digest,
              scope_profile, credential_version, key_version, expires_at, last_validated_at,
              validation_error_code, audit_provenance_hash, created_at,
              webhook_secret_encrypted, webhook_secret_previous_encrypted, webhook_secret_version
         FROM forgejo_workspace_credentials
        WHERE workspace_id = $1 AND superseded_at IS NULL`,
      [workspaceId],
    )).rows[0];
    return row ? mapBinding(row) : null;
  });
}

export async function fetchForgejoWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
  timeoutMs = PROVIDER_TIMEOUT_MS,
  resolveHostname?: (hostname: string) => Promise<readonly string[]>,
): Promise<Response> {
  return boundedOutboundFetch(url, {
    fetchImpl,
    resolveHostname,
    allowedPrivateHosts: parsePrivateHostAllowlist(process.env.RORCA_FORGEJO_PRIVATE_HOST_ALLOWLIST),
    maxRedirects: 3,
    maxResponseBytes: PROVIDER_MAX_RESPONSE_BYTES,
    connectionTimeoutMs: Math.min(PROVIDER_CONNECTION_TIMEOUT_MS, timeoutMs),
    totalTimeoutMs: timeoutMs,
    requestInit: init,
  });
}

function forgejoHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Rorca-Worker',
  };
}

interface ForgejoUser {
  id?: unknown;
  login?: unknown;
  username?: unknown;
  full_name?: unknown;
}

interface ForgejoRepo {
  id?: unknown;
  full_name?: unknown;
  owner?: { login?: unknown };
  permissions?: { admin?: unknown; push?: unknown; pull?: unknown };
}

/** Exact capability probe for one repository. Repository-scoped Forgejo tokens
 * intentionally cannot read `/user`; in that case the repository response and
 * complete writable-repository search are the authoritative identity/scope
 * evidence. Unknown or ambiguous evidence fails closed. */
export async function probeForgejoCapability(
  workspaceId: string,
  instanceUrl: string,
  owner: string,
  name: string,
  token: string,
  deps: ProviderDependencies = DEFAULT_DEPS,
): Promise<{ profile: Record<string, unknown>; repositoryId: number | null }> {
  assertForgejoRepositoryIdentity(owner, name);
  const base = instanceUrl.replace(/\/+$/, '');
  const userResponse = await fetchForgejoWithTimeout(deps.fetch, `${base}/api/v1/user`, {
    headers: forgejoHeaders(token),
  }, PROVIDER_TIMEOUT_MS, deps.resolveHostname);
  if (userResponse.status === 401) {
    throw new UnprocessableError('Forgejo rejected the credential during the capability probe', 'FORGEJO_CREDENTIAL_REJECTED');
  }
  let login: string | null = null;
  let principalId: number | null = null;
  let principalResolution: 'user-endpoint' | 'repository-scoped-token' = 'repository-scoped-token';
  if (userResponse.ok) {
    let user: ForgejoUser;
    try { user = await userResponse.json() as ForgejoUser; } catch {
      throw new UnprocessableError('Forgejo user identity response was unreadable', 'FORGEJO_USER_PROBE_INVALID');
    }
    login = String(user.login ?? user.username ?? '').toLowerCase();
    principalId = Number(user.id);
    if (!login || !Number.isSafeInteger(principalId)) {
      throw new UnprocessableError('Forgejo user identity response was incomplete', 'FORGEJO_USER_IDENTITY_INVALID');
    }
    principalResolution = 'user-endpoint';
  } else if (userResponse.status !== 403) {
    throw new UnprocessableError('Forgejo user identity probe failed', 'FORGEJO_USER_PROBE_FAILED', {
      providerStatus: userResponse.status,
    });
  }

  const repoResponse = await fetchForgejoWithTimeout(deps.fetch, `${base}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
    headers: forgejoHeaders(token),
  }, PROVIDER_TIMEOUT_MS, deps.resolveHostname);
  if (repoResponse.status === 404) {
    throw new UnprocessableError('Forgejo repository is unavailable to this credential', 'FORGEJO_REPOSITORY_UNAVAILABLE');
  }
  if (!repoResponse.ok) {
    throw new UnprocessableError('Forgejo repository probe failed', 'FORGEJO_REPOSITORY_PROBE_FAILED', {
      providerStatus: repoResponse.status,
    });
  }
  let repo: ForgejoRepo;
  try { repo = await repoResponse.json() as ForgejoRepo; } catch {
    throw new UnprocessableError('Forgejo repository response was unreadable', 'FORGEJO_REPOSITORY_PROBE_INVALID');
  }
  const fullName = String(repo.full_name ?? '').toLowerCase();
  const _repoOwner = String(repo.owner?.login ?? '').toLowerCase();
  const expectedFullName = `${owner}/${name}`.toLowerCase();
  if (fullName !== expectedFullName || _repoOwner !== owner.toLowerCase()) {
    throw new UnprocessableError('Forgejo repository identity does not match the configured target', 'FORGEJO_REPOSITORY_IDENTITY_MISMATCH');
  }
  const permissions = repo.permissions;
  if (!permissions || typeof permissions !== 'object'
    || permissions.pull !== true || permissions.push !== true || permissions.admin !== false) {
    throw new UnprocessableError('Forgejo credential scope is not the exact bounded write profile', 'FORGEJO_SCOPE_UNSUPPORTED');
  }
  const repositoryId = Number.isSafeInteger(Number(repo.id)) ? Number(repo.id) : null;
  // Repository exclusivity must be PROVEN from authoritative scope metadata
  // (the token's own accessible-repository enumeration), never inferred from
  // one repository's permission flags. Indeterminate evidence is denied.
  const exclusivity = await probeRepositoryExclusivity(base, token, owner, name, repositoryId, deps);
  if (exclusivity === 'indeterminate') {
    throw new UnprocessableError(
      'Forgejo cannot prove repository exclusivity from authoritative scope metadata; credential rejected as indeterminate',
      'FORGEJO_SCOPE_INDETERMINATE');
  }
  if (exclusivity !== 'exclusive') {
    throw new UnprocessableError('Forgejo credential scope is not exclusive to the configured repository', 'FORGEJO_SCOPE_NOT_EXCLUSIVE');
  }
  const profile = {
    schemaVersion: 'rorca.forgejo-capability-profile.v1',
    login: login,
    principalId,
    principalResolution,
    repositoryId,
    fullName,
    permissions: { pull: true, push: true, admin: false },
    repositoryExclusivity: 'exclusive' as const,
    exclusivitySource: 'writable-repository-search' as const,
    probedAt: deps.now().toISOString(),
  };
  return { profile, repositoryId: profile.repositoryId };
}

const ACCESSIBLE_REPOS_MAX_PAGES = 5;
const ACCESSIBLE_REPOS_PAGE_SIZE = 50;

/** Prove the token can write exactly the configured repository by enumerating
 * the complete repository search visible to that token. Forgejo intentionally
 * denies `/user/repos` to repository-scoped tokens, while `/repos/search`
 * returns their allowed repository set. Read-only public repositories are
 * permitted; any additional writable repository is over-scope. */
async function probeRepositoryExclusivity(
  base: string,
  token: string,
  owner: string,
  name: string,
  repositoryId: number | null,
  deps: ProviderDependencies,
): Promise<'exclusive' | 'over-scope' | 'indeterminate'> {
  const expectedFullName = `${owner}/${name}`.toLowerCase();
  let seenConfiguredRepo = false;
  for (let page = 1; page <= ACCESSIBLE_REPOS_MAX_PAGES; page += 1) {
    const response = await fetchForgejoWithTimeout(deps.fetch,
      `${base}/api/v1/repos/search?page=${page}&limit=${ACCESSIBLE_REPOS_PAGE_SIZE}&private=true`,
      { headers: forgejoHeaders(token) },
      PROVIDER_TIMEOUT_MS,
      deps.resolveHostname);
    if (!response.ok) return 'indeterminate';
    let body: unknown;
    try { body = await response.json(); } catch { return 'indeterminate'; }
    if (!body || typeof body !== 'object') return 'indeterminate';
    const entries = (body as { data?: unknown }).data;
    if (!Array.isArray(entries)) return 'indeterminate';
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') return 'indeterminate';
      const candidate = entry as Record<string, unknown>;
      const fullName = String(candidate.full_name ?? '').toLowerCase();
      const candidateId = Number.isSafeInteger(Number(candidate.id)) ? Number(candidate.id) : null;
      const permissions = candidate.permissions as Record<string, unknown> | undefined;
      if (!fullName || !permissions || typeof permissions !== 'object') return 'indeterminate';
      const canWrite = permissions.push === true || permissions.admin === true;
      if (!canWrite) continue;
      const isConfigured = fullName === expectedFullName
        && (repositoryId == null || candidateId == null || candidateId === repositoryId);
      if (!isConfigured) return 'over-scope';
      if (permissions.pull !== true || permissions.push !== true || permissions.admin !== false) {
        return 'over-scope';
      }
      seenConfiguredRepo = true;
    }
    if (entries.length === 0) break;
    if (entries.length < ACCESSIBLE_REPOS_PAGE_SIZE) break;
    if (page === ACCESSIBLE_REPOS_MAX_PAGES) return 'indeterminate';
  }
  return seenConfiguredRepo ? 'exclusive' : 'indeterminate';
}

export async function markForgejoCredentialInvalid(bindingId: string, workspaceId: string, code: string): Promise<void> {
  tokenCache.delete(bindingId);
  await transaction(async (client) => {
    await scopeForgejoWorkspace(client, workspaceId);
    await client.query(`UPDATE forgejo_workspace_credentials
                          SET status = 'invalid', validation_error_code = $2, status_changed_at = NOW()
                        WHERE id = $1 AND status = 'active' AND superseded_at IS NULL`,
    [bindingId, code.slice(0, 100)]);
  });
}
export interface RegisterForgejoCredentialInput {
  workspaceId: string;
  instanceUrl: string;
  owner: string;
  name: string;
  token: string;
  expiresAt?: string;
  credentialVersion?: number;
  keyVersion?: number;
  createdBy: string;
  auditProvenanceHash?: string;
  /** Optional dedicated webhook signing secret (A1). Ciphertext-only at rest. */
  webhookSecret?: string;
}

export async function registerForgejoCredential(
  input: RegisterForgejoCredentialInput,
  deps: ProviderDependencies = DEFAULT_DEPS,
): Promise<ForgejoCredentialBinding> {
  assertForgejoRepositoryIdentity(input.owner, input.name);
  if (!/^https?:\/\/[A-Za-z0-9._:/-]+$/.test(input.instanceUrl)) {
    throw new ValidationError('Forgejo instance URL is invalid');
  }
  if (input.webhookSecret !== undefined
    && (Buffer.byteLength(input.webhookSecret, 'utf8') < 32
      || Buffer.byteLength(input.webhookSecret, 'utf8') > 1024)) {
    throw new ValidationError('Forgejo webhook secret must contain between 32 and 1024 bytes');
  }
  const credentialVersion = input.credentialVersion ?? 1;
  const keyVersion = input.keyVersion ?? 1;
  const existing = await getWorkspaceForgejoCredential(input.workspaceId);
  if (existing && existing.status === 'active') {
    throw new ConflictError('Forgejo credential already exists for this workspace', { reason: 'forgejo_credential_exists' });
  }
  const { profile } = await probeForgejoCapability(
    input.workspaceId, input.instanceUrl, input.owner, input.name, input.token, deps,
  );
  const digest = forgejoCredentialDigest(input.workspaceId, input.instanceUrl, input.owner, input.name,
    input.token, credentialVersion, keyVersion);
  const bindingId = crypto.randomUUID();
  const expiresAt = input.expiresAt ?? null;
  const webhookSecretCiphertext = input.webhookSecret
    ? forgejoWebhookSecretCipher.encrypt(input.webhookSecret)
    : null;
  await transaction(async (client) => {
    await scopeForgejoWorkspace(client, input.workspaceId);
    await client.query(`
      INSERT INTO forgejo_workspace_credentials (
        id, workspace_id, instance_url, repo_owner, repo_name, token_digest, scope_profile,
        status, credential_version, key_version, expires_at, created_by, audit_provenance_hash,
        webhook_secret_encrypted, webhook_secret_version
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'active',$8,$9,$10,$11,$12,$13,$14)
    `, [bindingId, input.workspaceId, input.instanceUrl, input.owner, input.name, digest,
      JSON.stringify(profile), credentialVersion, keyVersion, expiresAt, input.createdBy,
      input.auditProvenanceHash ?? null, webhookSecretCiphertext,
      webhookSecretCiphertext ? 1 : 0]);
  });
  cacheRawToken(bindingId, input.token, expiresAt, deps.now());
  return (await getWorkspaceForgejoCredential(input.workspaceId))!;
}

export interface RotateForgejoCredentialInput {
  workspaceId: string;
  instanceUrl: string;
  owner: string;
  name: string;
  token: string;
  expiresAt?: string;
  credentialVersion: number;
  keyVersion: number;
  auditProvenanceHash?: string;
}

export async function rotateForgejoCredential(
  input: RotateForgejoCredentialInput,
  deps: ProviderDependencies = DEFAULT_DEPS,
): Promise<ForgejoCredentialBinding> {
  assertForgejoRepositoryIdentity(input.owner, input.name);
  const current = await getWorkspaceForgejoCredential(input.workspaceId);
  if (!current) throw new ConflictError('No active Forgejo credential to rotate', { reason: 'forgejo_credential_missing' });
  if (current.credentialVersion !== input.credentialVersion - 1 || current.keyVersion >= input.keyVersion) {
    throw new ConflictError('Forgejo credential rotation version is not strictly advancing', { reason: 'forgejo_rotation_conflict' });
  }
  const { profile, repositoryId } = await probeForgejoCapability(
    input.workspaceId, input.instanceUrl, input.owner, input.name, input.token, deps,
  );
  void repositoryId;
  const digest = forgejoCredentialDigest(input.workspaceId, input.instanceUrl, input.owner, input.name,
    input.token, input.credentialVersion, input.keyVersion);
  const bindingId = crypto.randomUUID();
  await transaction(async (client) => {
    await scopeForgejoWorkspace(client, input.workspaceId);
    await client.query(`UPDATE forgejo_workspace_credentials
                          SET superseded_at = NOW()
                        WHERE id = $1 AND superseded_at IS NULL`, [current.bindingId]);
    await client.query(`
      INSERT INTO forgejo_workspace_credentials (
        id, workspace_id, instance_url, repo_owner, repo_name, token_digest, scope_profile,
        status, credential_version, key_version, expires_at, created_by, audit_provenance_hash,
        webhook_secret_encrypted, webhook_secret_previous_encrypted, webhook_secret_version
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'active',$8,$9,$10,$11,$12,$13,$14,$15)
    `, [bindingId, input.workspaceId, input.instanceUrl, input.owner, input.name, digest,
      JSON.stringify(profile), input.credentialVersion, input.keyVersion, input.expiresAt ?? null,
      'operator-surface', input.auditProvenanceHash ?? null,
      // A token rotation must not invalidate the dedicated webhook signing
      // secret: carry the current ciphertext + version forward so deliveries
      // keep verifying after the rotation window.
      current.webhookSecretEncrypted ?? null,
      current.webhookSecretPreviousEncrypted ?? null,
      Number(current.webhookSecretVersion ?? 0)]);
  });
  cacheRawToken(bindingId, input.token, input.expiresAt ?? null, deps.now());
  return (await getWorkspaceForgejoCredential(input.workspaceId))!;
}

export async function revokeForgejoCredential(workspaceId: string, reasonCode: string): Promise<void> {
  const binding = await getWorkspaceForgejoCredential(workspaceId);
  if (!binding) throw new ConflictError('No active Forgejo credential to revoke', { reason: 'forgejo_credential_missing' });
  tokenCache.delete(binding.bindingId);
  await transaction(async (client) => {
    await scopeForgejoWorkspace(client, workspaceId);
    await client.query(`UPDATE forgejo_workspace_credentials
                          SET status = 'revoked', status_changed_at = NOW(),
                              validation_error_code = $2, superseded_at = COALESCE(superseded_at, NOW())
                        WHERE id = $1 AND superseded_at IS NULL`,
    [binding.bindingId, reasonCode.slice(0, 100)]);
  });
}

/** Operator surface (A1): provision the dedicated high-entropy webhook signing
 * secret for the current credential binding. The plaintext is encrypted before
 * it ever reaches the database and is never returned, logged, or audited. */
export async function provisionForgejoWebhookSecret(
  workspaceId: string,
  secret: string,
): Promise<{ version: number }> {
  const ciphertext = forgejoWebhookSecretCipher.encrypt(secret);
  return transaction(async (client) => {
    await scopeForgejoWorkspace(client, workspaceId);
    const result = await client.query<{ version: number | string }>(`
      UPDATE forgejo_workspace_credentials
         SET webhook_secret_previous_encrypted = NULL,
             webhook_secret_encrypted = $2,
             webhook_secret_version = webhook_secret_version + 1,
             webhook_secret_rotated_at = NOW(),
             webhook_secret_revoked_at = NULL
       WHERE workspace_id = $1 AND superseded_at IS NULL
       RETURNING webhook_secret_version AS version`, [workspaceId, ciphertext]);
    if (result.rows.length !== 1) {
      throw new ConflictError('No active Forgejo credential to provision a webhook secret for', {
        reason: 'forgejo_credential_missing',
      });
    }
    return { version: Number(result.rows[0].version) };
  });
}

/** Bounded dual-secret rotation (A1): the prior secret remains valid in
 * `webhook_secret_previous_encrypted` until the next rotation or revocation,
 * so in-flight provider deliveries keep verifying during the overlap window. */
export async function rotateForgejoWebhookSecret(
  workspaceId: string,
  newSecret: string,
): Promise<{ version: number }> {
  const ciphertext = forgejoWebhookSecretCipher.encrypt(newSecret);
  return transaction(async (client) => {
    await scopeForgejoWorkspace(client, workspaceId);
    const result = await client.query<{ version: number | string }>(`
      UPDATE forgejo_workspace_credentials
         SET webhook_secret_previous_encrypted = webhook_secret_encrypted,
             webhook_secret_encrypted = $2,
             webhook_secret_version = webhook_secret_version + 1,
             webhook_secret_rotated_at = NOW(),
             webhook_secret_revoked_at = NULL
       WHERE workspace_id = $1 AND superseded_at IS NULL
         AND webhook_secret_version > 0
       RETURNING webhook_secret_version AS version`, [workspaceId, ciphertext]);
    if (result.rows.length !== 1) {
      throw new ConflictError('Forgejo webhook secret has no provisioned secret to rotate', {
        reason: 'forgejo_webhook_secret_missing',
      });
    }
    return { version: Number(result.rows[0].version) };
  });
}

/** Revocation (A1): clears both secrets and permanently marks the binding's
 * webhook secret revoked; the receiver rejects every subsequent delivery. */
export async function revokeForgejoWebhookSecret(workspaceId: string): Promise<void> {
  await transaction(async (client) => {
    await scopeForgejoWorkspace(client, workspaceId);
    await client.query(`
      UPDATE forgejo_workspace_credentials
         SET webhook_secret_previous_encrypted = NULL,
             webhook_secret_encrypted = NULL,
             webhook_secret_version = 0,
             webhook_secret_rotated_at = NOW(),
             webhook_secret_revoked_at = NOW()
       WHERE workspace_id = $1 AND superseded_at IS NULL`, [workspaceId]);
  });
}

export interface ForgejoTokenResolution {
  repository?: { owner: string; name: string };
  purpose?: ForgejoCredentialPurpose;
}

export async function resolveWorkspaceForgejoToken(
  workspaceId: string,
  options: ForgejoTokenResolution = {},
): Promise<ResolvedForgejoToken | null> {
  const binding = await getWorkspaceForgejoCredential(workspaceId);
  if (!binding) return null;
  if (binding.status !== 'active') {
    throw new UnprocessableError('Forgejo credential binding is not active', 'FORGEJO_CREDENTIAL_INACTIVE', {
      bindingStatus: binding.status,
      validationErrorCode: binding.validationErrorCode,
    });
  }
  if (binding.expiresAt && Date.parse(binding.expiresAt) <= Date.now()) {
    throw new UnprocessableError('Forgejo credential has expired', 'FORGEJO_CREDENTIAL_EXPIRED');
  }
  if (options.repository
    && (options.repository.owner.toLowerCase() !== binding.owner.toLowerCase()
      || options.repository.name.toLowerCase() !== binding.name.toLowerCase())) {
    throw new ConflictError('Requested repository does not match the workspace Forgejo credential binding');
  }
  const cached = tokenCache.get(binding.bindingId);
  if (!cached) {
    // Deny-on-unknown: a restarted host has no raw token in memory. The
    // operator must re-enter the credential through the local surface.
    throw new UnprocessableError('Forgejo raw credential is not available in this process; operator re-entry required', 'FORGEJO_TOKEN_UNAVAILABLE');
  }
  if (cached.expiresAtMs && cached.expiresAtMs <= Date.now()) tokenCache.delete(binding.bindingId);
  const metadata: ForgejoTokenMetadata = {
    source: 'forgejo-token',
    bindingId: binding.bindingId,
    instanceUrl: binding.instanceUrl,
    owner: binding.owner,
    name: binding.name,
    credentialVersion: binding.credentialVersion,
    keyVersion: binding.keyVersion,
    scopeProfile: binding.scopeProfile,
    expiresAt: binding.expiresAt,
  };
  return { token: cached.token, metadata };
}

function cacheRawToken(bindingId: string, token: string, expiresAt: string | null, now: Date): void {
  tokenCache.set(bindingId, {
    token,
    expiresAtMs: expiresAt ? Date.parse(expiresAt) : 0,
    cachedAtMs: now.getTime(),
  });
  while (tokenCache.size > MAX_CACHE_ENTRIES) {
    const oldest = [...tokenCache.entries()].sort((a, b) => a[1].cachedAtMs - b[1].cachedAtMs)[0]?.[0];
    if (!oldest) break;
    tokenCache.delete(oldest);
  }
}

export function forgejoBindingHasFreshProbe(binding: ForgejoCredentialBinding | null, now = new Date()): boolean {
  if (!binding || binding.status !== 'active') return false;
  const profile = binding.scopeProfile;
  if (!profile || profile.schemaVersion !== 'rorca.forgejo-capability-profile.v1') return false;
  const probedAt = Date.parse(String(profile.probedAt ?? ''));
  if (!Number.isFinite(probedAt)) return false;
  const ageMs = now.getTime() - probedAt;
  if (ageMs < -5 * 60_000 || ageMs > PROBE_FRESHNESS_MS) return false;
  const permissions = profile.permissions as Record<string, unknown> | undefined;
  return Boolean(permissions && permissions.pull === true && permissions.push === true && permissions.admin === false);
}

/** Re-probe every active binding and mark failures invalid (reconcile). */
export async function reconcileForgejoCredentials(
  workspaceIds: readonly string[],
  deps: ProviderDependencies = DEFAULT_DEPS,
): Promise<{ reconciled: number; invalidated: number }> {
  let invalidated = 0;
  let reconciled = 0;
  for (const workspaceId of workspaceIds) {
    const binding = await getWorkspaceForgejoCredential(workspaceId);
    if (!binding || binding.status !== 'active') continue;
    const cached = tokenCache.get(binding.bindingId);
    if (!cached) continue;
    try {
      await probeForgejoCapability(workspaceId, binding.instanceUrl, binding.owner, binding.name, cached.token, deps);
      // FORCE RLS requires the workspace GUC even for the refresh write —
      // an unscoped UPDATE silently matches zero rows in production.
      await transaction(async (client) => {
        await scopeForgejoWorkspace(client, workspaceId);
        await client.query(`UPDATE forgejo_workspace_credentials SET last_validated_at = NOW()
                            WHERE id = $1 AND superseded_at IS NULL`, [binding.bindingId]);
      });
      reconciled += 1;
    } catch {
      await markForgejoCredentialInvalid(binding.bindingId, workspaceId, 'forgejo_probe_reconcile_failed');
      invalidated += 1;
    }
  }
  return { reconciled, invalidated };
}

/** Import side-effect-free alias mirroring the GitHub resolver's purpose set. */
export const FORGEJO_TOKEN_PROVIDER_VERSION = 'rorca.forgejo-token-provider.v1' as const;
export { PROBE_FRESHNESS_MS };
