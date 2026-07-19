/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { execute, queryOne } from '../db/index';
import { ConflictError, UnprocessableError, ValidationError } from './errors';
import { getIntegrationSecret } from './integration-vault';
import { assertGithubRepositoryIdentity } from './github-repository-authority';
import { extractGithubProviderError, isAuthoritativeGithubFailure } from './github-provider-error';

const JWT_MAX_LIFETIME_SECONDS = 9 * 60;
const JWT_BACKDATE_SECONDS = 60;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const MAX_CACHE_ENTRIES = 256;
const PROVIDER_TIMEOUT_MS = 10_000;
export const GITHUB_APP_PROFILE_FRESHNESS_MS = 24 * 60 * 60_000;

type PermissionLevel = 'read' | 'write' | 'admin';
export type GithubPermissionRequest = Record<string, 'read' | 'write'>;

/** The only supported App grant. Unknown permissions/events and broader levels fail closed. */
export const GITHUB_APP_REQUIRED_PERMISSIONS: Readonly<GithubPermissionRequest> = Object.freeze({
  metadata: 'read',
  actions: 'read',
  checks: 'write',
  contents: 'write',
  issues: 'read',
  pull_requests: 'write',
  statuses: 'write',
});
export const GITHUB_APP_REQUIRED_EVENTS = Object.freeze(['check_run', 'issues', 'pull_request', 'push'] as const);
const AUTOMATIC_TOKEN_PERMISSIONS: Readonly<GithubPermissionRequest> = Object.freeze({ metadata: 'read' });
const ALLOWED_APP_PERMISSION_LEVELS: Readonly<Record<string, 'read' | 'write'>> = Object.freeze({
  metadata: 'read',
  ...GITHUB_APP_REQUIRED_PERMISSIONS,
});

export interface GithubAppBindingRecord {
  bindingId: string;
  workspaceId: string;
  status: 'active' | 'disabled' | 'invalid';
  appId: number;
  appSlug: string;
  registrationStatus: 'active' | 'disabled';
  privateKeySecretId: string;
  webhookSecretId: string;
  installationRecordId: string;
  installationId: number;
  installationStatus: 'active' | 'suspended' | 'removed';
  accountId: number;
  accountLogin: string;
  accountType: 'Organization' | 'User';
  repositorySelection: 'selected';
  repositoryId: number;
  repoOwner: string;
  repoName: string;
  permissions: Record<string, string>;
  events: string[];
  lastValidatedAt: string | null;
  lastWebhookAt: string | null;
  validationErrorCode: string | null;
  providerProfileVerifiedAt: string | null;
  providerHookConfigured: boolean;
  signedDeliveryObserved: boolean;
}

interface BindingRow {
  binding_id: string; workspace_id: string; binding_status: GithubAppBindingRecord['status'];
  app_id: string | number; app_slug: string; registration_status: GithubAppBindingRecord['registrationStatus'];
  private_key_secret_id: string; webhook_secret_id: string; installation_record_id: string;
  installation_id: string | number; installation_status: GithubAppBindingRecord['installationStatus'];
  account_id: string | number; account_login: string; account_type: GithubAppBindingRecord['accountType'];
  repository_selection: 'selected'; repository_id: string | number; repo_owner: string; repo_name: string;
  permissions: Record<string, string> | string; events: string[] | string; last_validated_at: string | null;
  last_webhook_at: string | null; validation_error_code: string | null;
  provider_profile_verified_at: string | null; provider_hook_configured: boolean; signed_delivery_observed: boolean;
}

export interface GithubAppTokenMetadata {
  source: 'github-app-installation'; bindingId: string; appId: number; appSlug: string;
  installationId: number; repositoryId: number; repository: { owner: string; name: string };
  permissions: Record<string, string>; expiresAt: string;
}
export interface RepositoryInstallationToken { token: string; metadata: GithubAppTokenMetadata }
interface CacheEntry extends RepositoryInstallationToken { expiresAtMs: number; cachedAtMs: number }
interface ProviderDependencies { fetch: typeof fetch; now: () => Date; getSecret: typeof getIntegrationSecret }
const DEFAULT_DEPS: ProviderDependencies = { fetch, now: () => new Date(), getSecret: getIntegrationSecret };
const tokenCache = new Map<string, CacheEntry>();
const refreshes = new Map<string, Promise<RepositoryInstallationToken>>();

function parseObject(value: unknown): Record<string, string> {
  if (typeof value === 'string') { try { return JSON.parse(value) as Record<string, string>; } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, string> : {};
}
function parseArray(value: unknown): string[] {
  if (typeof value === 'string') { try { return parseArray(JSON.parse(value)); } catch { return []; } }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function mapBinding(row: BindingRow): GithubAppBindingRecord {
  return {
    bindingId: row.binding_id, workspaceId: row.workspace_id, status: row.binding_status,
    appId: Number(row.app_id), appSlug: row.app_slug, registrationStatus: row.registration_status,
    privateKeySecretId: row.private_key_secret_id, webhookSecretId: row.webhook_secret_id,
    installationRecordId: row.installation_record_id, installationId: Number(row.installation_id),
    installationStatus: row.installation_status, accountId: Number(row.account_id), accountLogin: row.account_login,
    accountType: row.account_type, repositorySelection: row.repository_selection, repositoryId: Number(row.repository_id),
    repoOwner: row.repo_owner, repoName: row.repo_name, permissions: parseObject(row.permissions), events: parseArray(row.events),
    lastValidatedAt: row.last_validated_at, lastWebhookAt: row.last_webhook_at,
    validationErrorCode: row.validation_error_code, providerProfileVerifiedAt: row.provider_profile_verified_at,
    providerHookConfigured: row.provider_hook_configured, signedDeliveryObserved: row.signed_delivery_observed,
  };
}

export async function getWorkspaceGithubAppBinding(workspaceId: string): Promise<GithubAppBindingRecord | null> {
  const row = await queryOne<BindingRow>(`
    SELECT b.id AS binding_id, b.workspace_id, b.status AS binding_status,
           r.app_id, r.app_slug, r.status AS registration_status,
           r.private_key_secret_id, r.webhook_secret_id,
           i.id AS installation_record_id, i.installation_id, i.status AS installation_status,
           i.account_id, i.account_login, i.account_type, i.repository_selection,
           b.repository_id, b.repo_owner, b.repo_name, b.permissions, b.events,
           b.last_validated_at, b.last_webhook_at, b.validation_error_code,
           b.provider_profile_verified_at, b.provider_hook_configured, b.signed_delivery_observed
      FROM github_app_workspace_bindings b
      JOIN github_app_registrations r ON r.id = b.registration_id
      JOIN github_app_installations i
        ON i.id = b.installation_record_id
       AND i.registration_id = b.registration_id
       AND i.installation_id = b.installation_id
     WHERE b.workspace_id = $1 AND b.superseded_at IS NULL`, [workspaceId]);
  return row ? mapBinding(row) : null;
}

function base64url(value: string): string { return Buffer.from(value, 'utf8').toString('base64url'); }
export function createGithubAppJwt(appId: number, privateKeyPem: string, now = new Date()): string {
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new ValidationError('GitHub App id must be a positive safe integer');
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (!Number.isFinite(nowSeconds)) throw new ValidationError('Invalid JWT clock');
  let key: crypto.KeyObject;
  try { key = crypto.createPrivateKey(privateKeyPem); } catch { throw new ValidationError('GitHub App private key is not a valid PEM private key'); }
  if (key.asymmetricKeyType !== 'rsa' && key.asymmetricKeyType !== 'rsa-pss') throw new ValidationError('GitHub App private key must be RSA');
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - JWT_BACKDATE_SECONDS, exp: nowSeconds + JWT_MAX_LIFETIME_SECONDS, iss: String(appId) }));
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), key).toString('base64url');
  return `${signingInput}.${signature}`;
}

function permissionAtLeast(actual: string | undefined, required: PermissionLevel): boolean {
  const rank: Record<string, number> = { read: 1, write: 2, admin: 3 };
  return (rank[actual ?? ''] ?? 0) >= rank[required];
}
export function assertGithubAppPermissions(permissions: Record<string, string>, required: Record<string, PermissionLevel>): void {
  const missing = Object.entries(required).filter(([name, level]) => !permissionAtLeast(permissions[name], level)).map(([name, level]) => `${name}:${level}`);
  if (missing.length > 0) throw new UnprocessableError('GitHub App installation lacks required repository permissions', 'GITHUB_APP_PERMISSION_MISSING', { missing });
}

/** Validate provider App configuration against the exact supported ceiling/profile. */
export function assertGithubAppProviderProfile(permissions: Record<string, string>, events: string[]): void {
  const unknown = Object.keys(permissions).filter((name) => !(name in ALLOWED_APP_PERMISSION_LEVELS));
  const broader = Object.entries(permissions).filter(([name, level]) => {
    const allowed = ALLOWED_APP_PERMISSION_LEVELS[name];
    return allowed && level !== allowed;
  }).map(([name, level]) => `${name}:${level}`);
  const missing = Object.entries(GITHUB_APP_REQUIRED_PERMISSIONS)
    .filter(([name, level]) => permissions[name] !== level)
    .map(([name, level]) => `${name}:${level}`);
  const eventSet = new Set(events);
  const unknownEvents = events.filter((event) => !(GITHUB_APP_REQUIRED_EVENTS as readonly string[]).includes(event));
  const missingEvents = GITHUB_APP_REQUIRED_EVENTS.filter((event) => !eventSet.has(event));
  const duplicateEvents = events.filter((event, index) => events.indexOf(event) !== index);
  if (unknown.length || broader.length || missing.length || unknownEvents.length || missingEvents.length || duplicateEvents.length) {
    throw new UnprocessableError('GitHub App provider permissions/events do not match the supported profile', 'GITHUB_APP_PROFILE_UNSUPPORTED', {
      unknownPermissions: unknown, broaderPermissions: broader, missingPermissions: missing,
      unknownEvents, missingEvents, duplicateEvents,
    });
  }
}

export function githubAppBindingHasVerifiedProfile(binding: GithubAppBindingRecord | null, now = new Date()): boolean {
  if (!binding || binding.status !== 'active' || binding.registrationStatus !== 'active'
    || binding.installationStatus !== 'active' || !binding.providerProfileVerifiedAt || !binding.providerHookConfigured) return false;
  const verifiedAt = new Date(binding.providerProfileVerifiedAt).getTime();
  const ageMs = now.getTime() - verifiedAt;
  if (!Number.isFinite(verifiedAt) || ageMs < -5 * 60_000 || ageMs > GITHUB_APP_PROFILE_FRESHNESS_MS) return false;
  try {
    assertGithubAppProviderProfile(binding.permissions, binding.events);
    return true;
  } catch {
    return false;
  }
}

function normalizedPermissionRequest(required: GithubPermissionRequest): GithubPermissionRequest {
  const request = { ...AUTOMATIC_TOKEN_PERMISSIONS, ...required };
  for (const [name, level] of Object.entries(request)) {
    const ceiling = ALLOWED_APP_PERMISSION_LEVELS[name];
    if (!ceiling || level !== ceiling && !(ceiling === 'write' && level === 'read')) {
      throw new ValidationError(`Unsupported GitHub App permission request: ${name}:${level}`);
    }
  }
  return Object.fromEntries(Object.entries(request).sort(([a], [b]) => a.localeCompare(b))) as GithubPermissionRequest;
}
function permissionProfileKey(bindingId: string, request: GithubPermissionRequest): string {
  return `${bindingId}:${Object.entries(request).map(([name, level]) => `${name}=${level}`).join(',')}`;
}
function assertExactTokenProfile(actual: Record<string, string>, requested: GithubPermissionRequest): void {
  const unknown = Object.keys(actual).filter((name) => !(name in requested));
  const broader = Object.entries(actual).filter(([name, level]) => requested[name] !== level).map(([name, level]) => `${name}:${level}`);
  const missing = Object.entries(requested).filter(([name, level]) => actual[name] !== level).map(([name, level]) => `${name}:${level}`);
  if (unknown.length || broader.length || missing.length) {
    throw new UnprocessableError('GitHub App token permission profile is not exact', 'GITHUB_APP_TOKEN_PERMISSION_CONFUSION', {
      unknown, broader, missing,
    });
  }
}

export async function fetchGithubWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit = {}, timeoutMs = PROVIDER_TIMEOUT_MS): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  return fetchImpl(url, { ...init, signal: timeout });
}
async function providerJson<T>(response: Response, code: string): Promise<T> {
  if (!response.ok) {
    const safe = extractGithubProviderError(response, code);
    throw new UnprocessableError(safe.message, safe.code, {
      providerStatus: safe.providerStatus, providerRequestId: safe.requestId,
    });
  }
  try { return await response.json() as T; } catch { throw new UnprocessableError('GitHub App provider returned an invalid response', code); }
}
export async function markGithubAppBindingInvalid(bindingId: string, code: string): Promise<void> {
  for (const key of tokenCache.keys()) if (key.startsWith(`${bindingId}:`)) tokenCache.delete(key);
  await execute(`UPDATE github_app_workspace_bindings SET status = 'invalid', validation_error_code = $2, status_changed_at = NOW()
                  WHERE id = $1 AND status = 'active' AND superseded_at IS NULL`, [bindingId, code.slice(0, 100)]);
}

async function refreshRepositoryToken(binding: GithubAppBindingRecord, request: GithubPermissionRequest, deps: ProviderDependencies): Promise<RepositoryInstallationToken> {
  const cacheKey = permissionProfileKey(binding.bindingId, request);
  const privateKey = await deps.getSecret(binding.privateKeySecretId, 'private_key');
  if (!privateKey) {
    await markGithubAppBindingInvalid(binding.bindingId, 'private_key_unavailable');
    throw new UnprocessableError('GitHub App private key is unavailable', 'GITHUB_APP_PRIVATE_KEY_UNAVAILABLE');
  }
  const appJwt = createGithubAppJwt(binding.appId, privateKey, deps.now());
  const appHeaders = { Authorization: `Bearer ${appJwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Rorca-OSS' };
  const installationResponse = await fetchGithubWithTimeout(deps.fetch, `https://api.github.com/app/installations/${binding.installationId}`, { headers: appHeaders });
  if (!installationResponse.ok && isAuthoritativeGithubFailure(installationResponse.status)) {
    await markGithubAppBindingInvalid(binding.bindingId, 'installation_provider_rejected');
  }
  const installation = await providerJson<{ id?: number; app_id?: number; repository_selection?: string; suspended_at?: string | null; account?: { id?: number; login?: string; type?: string } }>(
    installationResponse, 'GITHUB_APP_INSTALLATION_UNAVAILABLE',
  );
  const matches = installation.id === binding.installationId && installation.app_id === binding.appId
    && installation.repository_selection === 'selected' && !installation.suspended_at
    && installation.account?.id === binding.accountId && installation.account?.login?.toLowerCase() === binding.accountLogin.toLowerCase()
    && installation.account?.type === binding.accountType;
  if (!matches) {
    await markGithubAppBindingInvalid(binding.bindingId, 'installation_identity_mismatch');
    throw new ConflictError('GitHub App installation identity no longer matches the immutable binding');
  }

  const tokenProviderResponse = await fetchGithubWithTimeout(deps.fetch, `https://api.github.com/app/installations/${binding.installationId}/access_tokens`, {
    method: 'POST', headers: { ...appHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository_ids: [binding.repositoryId], permissions: request }),
  });
  if (!tokenProviderResponse.ok && isAuthoritativeGithubFailure(tokenProviderResponse.status)) {
    await markGithubAppBindingInvalid(binding.bindingId, 'token_provider_rejected');
  }
  const tokenResponse = await providerJson<{ token?: string; expires_at?: string; permissions?: Record<string, string>; repository_selection?: string; repositories?: Array<{ id?: number }> }>(
    tokenProviderResponse, 'GITHUB_APP_TOKEN_UNAVAILABLE',
  );
  const expiresAtMs = new Date(tokenResponse.expires_at ?? '').getTime();
  if (!tokenResponse.token || !Number.isFinite(expiresAtMs) || expiresAtMs <= deps.now().getTime() + TOKEN_EXPIRY_SKEW_MS
    || tokenResponse.repository_selection !== 'selected' || !Array.isArray(tokenResponse.repositories)
    || tokenResponse.repositories.length !== 1 || tokenResponse.repositories[0]?.id !== binding.repositoryId) {
    await markGithubAppBindingInvalid(binding.bindingId, 'token_response_invalid');
    throw new UnprocessableError('GitHub App returned an unusable repository token', 'GITHUB_APP_TOKEN_INVALID');
  }
  const permissions = tokenResponse.permissions ?? {};
  try { assertExactTokenProfile(permissions, request); } catch (error) {
    await markGithubAppBindingInvalid(binding.bindingId, 'token_permission_profile_confusion');
    throw error;
  }
  const repositoryResponse = await fetchGithubWithTimeout(deps.fetch, `https://api.github.com/repos/${encodeURIComponent(binding.repoOwner)}/${encodeURIComponent(binding.repoName)}`, {
    headers: { ...appHeaders, Authorization: `Bearer ${tokenResponse.token}` },
  });
  if (!repositoryResponse.ok && isAuthoritativeGithubFailure(repositoryResponse.status)) {
    await markGithubAppBindingInvalid(binding.bindingId, 'repository_provider_rejected');
  }
  const repo = await providerJson<{ id?: number; full_name?: string }>(repositoryResponse, 'GITHUB_APP_REPOSITORY_UNAVAILABLE');
  if (repo.id !== binding.repositoryId || repo.full_name?.toLowerCase() !== `${binding.repoOwner}/${binding.repoName}`.toLowerCase()) {
    await markGithubAppBindingInvalid(binding.bindingId, 'repository_identity_mismatch');
    throw new ConflictError('GitHub App repository identity no longer matches the immutable binding');
  }
  const result: RepositoryInstallationToken = { token: tokenResponse.token, metadata: {
    source: 'github-app-installation', bindingId: binding.bindingId, appId: binding.appId, appSlug: binding.appSlug,
    installationId: binding.installationId, repositoryId: binding.repositoryId,
    repository: { owner: binding.repoOwner, name: binding.repoName }, permissions, expiresAt: new Date(expiresAtMs).toISOString(),
  } };
  tokenCache.set(cacheKey, { ...result, expiresAtMs, cachedAtMs: deps.now().getTime() });
  while (tokenCache.size > MAX_CACHE_ENTRIES) {
    const oldest = [...tokenCache.entries()].sort((a, b) => a[1].cachedAtMs - b[1].cachedAtMs)[0]?.[0];
    if (!oldest) break;
    tokenCache.delete(oldest);
  }
  return result;
}

export async function resolveRepositoryInstallationToken(
  workspaceId: string,
  repository: { owner: string; name: string },
  requiredPermissions: GithubPermissionRequest = {},
  overrides: Partial<ProviderDependencies> = {},
): Promise<RepositoryInstallationToken | null> {
  assertGithubRepositoryIdentity(repository.owner, repository.name);
  const binding = await getWorkspaceGithubAppBinding(workspaceId);
  if (!binding) return null;
  if (!githubAppBindingHasVerifiedProfile(binding, (overrides.now ?? DEFAULT_DEPS.now)())) {
    throw new UnprocessableError('GitHub App binding is not active with a provider-verified supported profile', 'GITHUB_APP_BINDING_INACTIVE', {
      bindingStatus: binding.status, installationStatus: binding.installationStatus,
      providerHookConfigured: binding.providerHookConfigured,
      providerProfileVerifiedAt: binding.providerProfileVerifiedAt,
    });
  }
  if (binding.repoOwner.toLowerCase() !== repository.owner.toLowerCase() || binding.repoName.toLowerCase() !== repository.name.toLowerCase()) {
    throw new ConflictError('Requested repository does not match the workspace GitHub App binding');
  }
  const request = normalizedPermissionRequest(requiredPermissions);
  const cacheKey = permissionProfileKey(binding.bindingId, request);
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs > deps.now().getTime() + TOKEN_EXPIRY_SKEW_MS) return { token: cached.token, metadata: cached.metadata };
  const existing = refreshes.get(cacheKey);
  if (existing) return existing;
  const refresh = refreshRepositoryToken(binding, request, deps).finally(() => refreshes.delete(cacheKey));
  refreshes.set(cacheKey, refresh);
  return refresh;
}

export async function revalidateWorkspaceGithubAppBinding(
  workspaceId: string,
  requiredPermissions: GithubPermissionRequest,
  overrides: Partial<ProviderDependencies> = {},
): Promise<GithubAppTokenMetadata> {
  const binding = await getWorkspaceGithubAppBinding(workspaceId);
  if (!binding) throw new UnprocessableError('No GitHub App binding exists', 'GITHUB_APP_BINDING_MISSING');
  if (binding.registrationStatus !== 'active' || binding.installationStatus !== 'active') throw new UnprocessableError('GitHub App registration or installation is inactive', 'GITHUB_APP_BINDING_INACTIVE');
  const request = normalizedPermissionRequest(requiredPermissions);
  const result = await refreshRepositoryToken(binding, request, { ...DEFAULT_DEPS, ...overrides });
  return result.metadata;
}

export function clearGithubAppTokenCacheForTests(): void { tokenCache.clear(); refreshes.clear(); }
