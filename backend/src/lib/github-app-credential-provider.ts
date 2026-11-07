/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import type { ScmCapability } from './authority-provider-adapter';
import { execute, queryOne, transaction } from '../db/index';
import { ConflictError, UnprocessableError, ValidationError } from './errors';
import { getIntegrationSecret } from './integration-vault';
import { assertGithubRepositoryIdentity } from './github-repository-authority';
import { extractGithubProviderError, isAuthoritativeGithubFailure } from './github-provider-error';

const JWT_MAX_LIFETIME_SECONDS = 9 * 60;
const JWT_BACKDATE_SECONDS = 60;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const TOKEN_MAX_LIFETIME_MS = 2 * 60 * 60_000;
const MAX_CACHE_ENTRIES = 256;
const PROVIDER_TIMEOUT_MS = 10_000;
export const GITHUB_APP_PROFILE_FRESHNESS_MS = 24 * 60 * 60_000;

type PermissionLevel = 'read' | 'write' | 'admin';
export type GithubPermissionRequest = Record<string, 'read' | 'write'>;

const SCM_CAPABILITY_PERMISSION: Readonly<Record<ScmCapability, Readonly<GithubPermissionRequest>>> = Object.freeze({
  'scm.repository.read': Object.freeze({ contents: 'read' }),
  'scm.branch.write': Object.freeze({ contents: 'write' }),
  'scm.pull_request.write': Object.freeze({ pull_requests: 'write' }),
  'scm.checks.read': Object.freeze({ checks: 'read' }),
  'scm.review.request': Object.freeze({ pull_requests: 'write' }),
});
export const GITHUB_SCM_LEASE_CAPABILITIES = Object.freeze(Object.keys(SCM_CAPABILITY_PERMISSION) as ScmCapability[]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;


export interface GithubInstallationLeasePreflight {
  workspaceId: string;
  bindingId: string;
  bindingGeneration: number;
  authorityGrantId: string;
  repository: { id: number; owner: string; name: string };
  capabilities: readonly ScmCapability[];
}

export interface GithubInstallationLeaseMetadata {
  leaseId: string;
  source: 'github-app-installation';
  workspaceId: string;
  bindingId: string;
  bindingGeneration: number;
  authorityGrantId: string;
  installationId: number;
  repository: { id: number; owner: string; name: string };
  capabilities: readonly ScmCapability[];
  permissions: Readonly<GithubPermissionRequest>;
  expiresAt: string;
}

export type GithubInstallationLeaseSettlementOutcome = 'completed' | 'denied' | 'cancelled' | 'expired' | 'failed';
export interface GithubInstallationLeaseSettlement {
  leaseId: string;
  state: 'settled' | 'reconciliation_required';
  settlementKind: 'revoked' | 'verified_expiry' | 'revocation_failed';
  expiresAt: string;
}

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
  bindingGeneration: number;
  lastValidatedAt: string | null;
  lastWebhookAt: string | null;
  validationErrorCode: string | null;
  providerProfileVerifiedAt: string | null;
  providerHookConfigured: boolean;
  signedDeliveryObserved: boolean;
}

interface BindingRow {
  binding_id: string; workspace_id: string; binding_status: GithubAppBindingRecord['status'];
  binding_generation: string | number;
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
interface CacheEntry extends RepositoryInstallationToken {
  expiresAtMs: number;
  cachedAtMs: number;
  lease?: GithubInstallationLeaseMetadata;
}
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
    bindingGeneration: Number(row.binding_generation),
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
    SELECT b.id AS binding_id, b.workspace_id, b.status AS binding_status, b.binding_generation,
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
    || binding.installationStatus !== 'active' || binding.validationErrorCode !== null
    || !binding.providerProfileVerifiedAt || !binding.providerHookConfigured) return false;
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

function normalizedScmCapabilities(capabilities: readonly ScmCapability[]): ScmCapability[] {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    throw new ValidationError('At least one SCM capability is required');
  }
  const unique = new Set<ScmCapability>();
  for (const capability of capabilities) {
    if (!GITHUB_SCM_LEASE_CAPABILITIES.includes(capability)) {
      throw new ValidationError(`Unsupported SCM capability: ${String(capability)}`);
    }
    if (unique.has(capability)) throw new ValidationError(`Duplicate SCM capability: ${capability}`);
    unique.add(capability);
  }
  return GITHUB_SCM_LEASE_CAPABILITIES.filter(capability => unique.has(capability));
}

export function githubPermissionsForScmCapabilities(capabilities: readonly ScmCapability[]): GithubPermissionRequest {
  const required: GithubPermissionRequest = {};
  for (const capability of normalizedScmCapabilities(capabilities)) {
    for (const [name, level] of Object.entries(SCM_CAPABILITY_PERMISSION[capability])) {
      required[name] = required[name] === 'write' || level === 'write' ? 'write' : 'read';
    }
  }
  return normalizedPermissionRequest(required);
}

function assertLeasePreflightBinding(
  binding: GithubAppBindingRecord,
  request: GithubInstallationLeasePreflight,
  permissions: GithubPermissionRequest,
  now: Date,
): void {
  if (binding.workspaceId !== request.workspaceId) {
    throw new ConflictError('GitHub App binding does not belong to the requested workspace');
  }
  if (binding.status !== 'active' || binding.registrationStatus !== 'active') {
    throw new UnprocessableError('GitHub App binding or registration is inactive', 'GITHUB_APP_BINDING_INACTIVE');
  }
  if (binding.installationStatus !== 'active') {
    throw new UnprocessableError('GitHub App installation is suspended or removed', 'GITHUB_APP_INSTALLATION_INACTIVE');
  }
  if (binding.bindingId !== request.bindingId || binding.bindingGeneration !== request.bindingGeneration) {
    throw new ConflictError('GitHub App binding generation is stale', {
      expectedBindingId: binding.bindingId,
      expectedGeneration: binding.bindingGeneration,
    });
  }
  if (binding.repositoryId !== request.repository.id
    || binding.repoOwner.toLowerCase() !== request.repository.owner.toLowerCase()
    || binding.repoName.toLowerCase() !== request.repository.name.toLowerCase()) {
    throw new ConflictError('Requested repository identity does not match the immutable GitHub App binding');
  }
  assertGithubAppPermissions(binding.permissions, permissions);
  if (binding.validationErrorCode || !binding.providerProfileVerifiedAt || !binding.providerHookConfigured) {
    throw new UnprocessableError('GitHub App provider profile is unverified', 'GITHUB_APP_PROFILE_UNVERIFIED');
  }
  const verifiedAt = new Date(binding.providerProfileVerifiedAt).getTime();
  const profileAgeMs = now.getTime() - verifiedAt;
  if (!Number.isFinite(verifiedAt) || profileAgeMs < -5 * 60_000 || profileAgeMs > GITHUB_APP_PROFILE_FRESHNESS_MS) {
    throw new UnprocessableError('GitHub App provider profile verification is stale', 'GITHUB_APP_PROFILE_STALE');
  }
  try {
    assertGithubAppProviderProfile(binding.permissions, binding.events);
  } catch {
    throw new UnprocessableError('GitHub App provider profile is unverified', 'GITHUB_APP_PROFILE_UNVERIFIED');
  }
}

function permissionProfileKey(bindingId: string, request: GithubPermissionRequest): string {
  return `profile:${bindingId}:${Object.entries(request).map(([name, level]) => `${name}=${level}`).join(',')}`;
}
function cacheToken(key: string, result: RepositoryInstallationToken, now: Date, lease?: GithubInstallationLeaseMetadata): void {
  tokenCache.set(key, {
    ...result,
    expiresAtMs: new Date(result.metadata.expiresAt).getTime(),
    cachedAtMs: now.getTime(),
    lease,
  });
  while (tokenCache.size > MAX_CACHE_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [candidateKey, candidate] of tokenCache) {
      if (!candidate.lease && candidate.cachedAtMs < oldestAt) {
        oldestKey = candidateKey;
        oldestAt = candidate.cachedAtMs;
      }
    }
    if (!oldestKey) break;
    tokenCache.delete(oldestKey);
  }
}
function assertLeaseCacheCapacity(): void {
  let activeLeaseCount = 0;
  for (const entry of tokenCache.values()) if (entry.lease) activeLeaseCount += 1;
  if (activeLeaseCount >= MAX_CACHE_ENTRIES) {
    throw new UnprocessableError('GitHub App installation lease capacity is exhausted', 'GITHUB_APP_LEASE_CAPACITY');
  }
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
  for (const [key, entry] of tokenCache) if (entry.metadata.bindingId === bindingId) tokenCache.delete(key);
  await execute(`UPDATE github_app_workspace_bindings SET status = 'invalid', validation_error_code = $2, status_changed_at = NOW()
                  WHERE id = $1 AND status = 'active' AND superseded_at IS NULL`, [bindingId, code.slice(0, 100)]);
}

async function refreshRepositoryToken(binding: GithubAppBindingRecord, request: GithubPermissionRequest, deps: ProviderDependencies): Promise<RepositoryInstallationToken> {
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
  const nowMs = deps.now().getTime();
  const expiresAtMs = new Date(tokenResponse.expires_at ?? '').getTime();
  if (!tokenResponse.token || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= nowMs + TOKEN_EXPIRY_SKEW_MS || expiresAtMs > nowMs + TOKEN_MAX_LIFETIME_MS
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
  const refresh = refreshRepositoryToken(binding, request, deps)
    .then(result => {
      cacheToken(cacheKey, result, deps.now());
      return result;
    })
    .finally(() => refreshes.delete(cacheKey));
  refreshes.set(cacheKey, refresh);
  return refresh;
}

export async function revokeGithubInstallationToken(
  token: string,
  overrides: Pick<Partial<ProviderDependencies>, 'fetch'> = {},
): Promise<void> {
  const response = await fetchGithubWithTimeout(overrides.fetch ?? DEFAULT_DEPS.fetch, 'https://api.github.com/installation/token', {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Rorca-OSS',
    },
  });
  if (response.status !== 204) {
    const safe = extractGithubProviderError(response, 'GITHUB_APP_TOKEN_REVOCATION_FAILED');
    throw new UnprocessableError(safe.message, safe.code, {
      providerStatus: safe.providerStatus,
      providerRequestId: safe.requestId,
    });
  }
}

export async function preflightGithubInstallationLease(
  request: GithubInstallationLeasePreflight,
  overrides: Partial<ProviderDependencies> = {},
): Promise<GithubInstallationLeaseMetadata> {
  if (!request.workspaceId?.trim()) throw new ValidationError('workspaceId is required');
  if (!UUID.test(request.bindingId)) throw new ValidationError('bindingId must be a UUID');
  if (!Number.isSafeInteger(request.bindingGeneration) || request.bindingGeneration <= 0) {
    throw new ValidationError('bindingGeneration must be a positive safe integer');
  }
  if (!UUID.test(request.authorityGrantId)) throw new ValidationError('authorityGrantId must be a UUID');
  if (!Number.isSafeInteger(request.repository?.id) || request.repository.id <= 0) {
    throw new ValidationError('repository.id must be a positive safe integer');
  }
  assertGithubRepositoryIdentity(request.repository.owner, request.repository.name);

  const capabilities = normalizedScmCapabilities(request.capabilities);
  const permissions = githubPermissionsForScmCapabilities(capabilities);
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const binding = await getWorkspaceGithubAppBinding(request.workspaceId);
  if (!binding) throw new UnprocessableError('No GitHub App binding exists', 'GITHUB_APP_BINDING_MISSING');
  assertLeasePreflightBinding(binding, request, permissions, deps.now());
  const existingGrantLease = await queryOne<{ id: string }>(
    `SELECT id
       FROM provider_authority_leases
      WHERE authority_grant_id = $1`,
    [request.authorityGrantId],
  );
  if (existingGrantLease) {
    throw new ConflictError('GitHub authority grant has already been leased');
  }
  assertLeaseCacheCapacity();

  const result = await refreshRepositoryToken(binding, permissions, deps);
  const leaseId = crypto.randomUUID();
  const mintedAt = deps.now();
  const metadata: GithubInstallationLeaseMetadata = Object.freeze({
    leaseId,
    source: 'github-app-installation',
    workspaceId: request.workspaceId,
    bindingId: binding.bindingId,
    bindingGeneration: binding.bindingGeneration,
    authorityGrantId: request.authorityGrantId,
    installationId: binding.installationId,
    repository: Object.freeze({ id: binding.repositoryId, owner: binding.repoOwner, name: binding.repoName }),
    capabilities: Object.freeze([...capabilities]),
    permissions: Object.freeze({ ...permissions }),
    expiresAt: result.metadata.expiresAt,
  });

  try {
    await transaction(async (client) => {
      const authority = await client.query<{
        id: string;
        status: GithubAppBindingRecord['status'];
        binding_generation: string | number;
        repository_id: string | number;
        repo_owner: string;
        repo_name: string;
      }>(`SELECT id, status, binding_generation, repository_id, repo_owner, repo_name
           FROM github_app_workspace_bindings
          WHERE id = $1 AND workspace_id = $2 AND superseded_at IS NULL
          FOR SHARE`, [binding.bindingId, request.workspaceId]);
      const current = authority.rows[0];
      if (!current || current.status !== 'active'
        || Number(current.binding_generation) !== binding.bindingGeneration
        || Number(current.repository_id) !== binding.repositoryId
        || current.repo_owner.toLowerCase() !== binding.repoOwner.toLowerCase()
        || current.repo_name.toLowerCase() !== binding.repoName.toLowerCase()) {
        throw new ConflictError('GitHub App binding authority changed while the installation lease was minted');
      }
      await client.query(`INSERT INTO provider_authority_leases
        (id, workspace_id, provider_id, provider_binding_id, binding_generation, authority_grant_id,
         repository_external_id, repository_owner, repository_name, capabilities, permissions, minted_at, expires_at)
        VALUES ($1,$2,'github-app',$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)`, [
        leaseId,
        request.workspaceId,
        binding.bindingId,
        binding.bindingGeneration,
        request.authorityGrantId,
        String(binding.repositoryId),
        binding.repoOwner,
        binding.repoName,
        JSON.stringify(capabilities),
        JSON.stringify(permissions),
        mintedAt.toISOString(),
        result.metadata.expiresAt,
      ]);
    });
  } catch (error) {
    try {
      await revokeGithubInstallationToken(result.token, { fetch: deps.fetch });
    } catch {
      // The rejected lease is never made usable; provider expiry remains bounded.
    }
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new ConflictError('GitHub authority grant has already been leased');
    }
    throw error;
  }
  cacheToken(`lease:${leaseId}`, result, mintedAt, metadata);
  return metadata;
}

/**
 * The canonical GitHub delivery adapter is the only intended caller. The
 * credential is passed directly to its in-process operation and is never
 * returned by preflight, serialized, or installed in process-wide environment.
 */
export async function withTrustedGithubInstallationLeaseToken<T>(
  leaseId: string,
  operation: (token: string, metadata: GithubInstallationLeaseMetadata) => Promise<T>,
  now: () => Date = DEFAULT_DEPS.now,
): Promise<T> {
  if (!UUID.test(leaseId)) throw new ValidationError('leaseId must be a UUID');
  const cacheKey = `lease:${leaseId}`;
  const cached = tokenCache.get(cacheKey);
  if (!cached?.lease || cached.expiresAtMs <= now().getTime() + TOKEN_EXPIRY_SKEW_MS) {
    tokenCache.delete(cacheKey);
    throw new UnprocessableError('GitHub App installation lease is not usable in this process', 'GITHUB_APP_LEASE_INACTIVE');
  }
  const authority = await queryOne<{
    lease_state: string;
    binding_status: string;
    binding_generation: string | number;
  }>(`SELECT l.state AS lease_state, b.status AS binding_status, b.binding_generation
        FROM provider_authority_leases l
        JOIN github_app_workspace_bindings b
          ON b.id = l.provider_binding_id
         AND b.workspace_id = l.workspace_id
       WHERE l.id = $1
         AND l.provider_id = 'github-app'
         AND b.superseded_at IS NULL`, [leaseId]);
  if (authority?.lease_state !== 'active' || authority.binding_status !== 'active'
    || Number(authority.binding_generation) !== cached.lease.bindingGeneration) {
    tokenCache.delete(cacheKey);
    throw new UnprocessableError('GitHub App installation lease is not usable in this process', 'GITHUB_APP_LEASE_INACTIVE');
  }
  return operation(cached.token, cached.lease);
}

interface PersistedGithubLeaseSettlement {
  state: 'active' | 'settled' | 'reconciliation_required';
  expires_at: Date | string;
  settlement_kind: GithubInstallationLeaseSettlement['settlementKind'] | null;
  provider_binding_id: string;
}

async function readPersistedGithubLeaseSettlement(
  leaseId: string,
  workspaceId?: string,
): Promise<PersistedGithubLeaseSettlement> {
  const persisted = await queryOne<PersistedGithubLeaseSettlement>(
    `SELECT state, expires_at, settlement_kind, provider_binding_id
       FROM provider_authority_leases
      WHERE id = $1
        AND provider_id = 'github-app'
        AND ($2::text IS NULL OR workspace_id = $2)`,
    [leaseId, workspaceId ?? null],
  );
  if (!persisted) {
    throw new UnprocessableError('GitHub App installation lease does not exist in this workspace', 'GITHUB_APP_LEASE_INACTIVE');
  }
  return persisted;
}

function persistedSettlementResult(
  leaseId: string,
  persisted: PersistedGithubLeaseSettlement,
): GithubInstallationLeaseSettlement | null {
  const expiresAtMs = new Date(persisted.expires_at).getTime();
  if (!Number.isFinite(expiresAtMs)) {
    throw new UnprocessableError('GitHub App installation lease expiry is invalid', 'GITHUB_APP_LEASE_INACTIVE');
  }
  if (persisted.state === 'active') return null;
  if (persisted.state === 'settled'
      && (persisted.settlement_kind === 'revoked' || persisted.settlement_kind === 'verified_expiry')) {
    return Object.freeze({
      leaseId,
      state: 'settled',
      settlementKind: persisted.settlement_kind,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }
  if (persisted.state === 'reconciliation_required' && persisted.settlement_kind === 'revocation_failed') {
    return Object.freeze({
      leaseId,
      state: 'reconciliation_required',
      settlementKind: 'revocation_failed',
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }
  throw new ConflictError('GitHub App installation lease has inconsistent settlement facts');
}

export async function settleGithubInstallationLease(
  leaseId: string,
  outcome: GithubInstallationLeaseSettlementOutcome,
  overrides: Pick<Partial<ProviderDependencies>, 'fetch' | 'now'> = {},
): Promise<GithubInstallationLeaseSettlement> {
  if (!UUID.test(leaseId)) throw new ValidationError('leaseId must be a UUID');
  const now = (overrides.now ?? DEFAULT_DEPS.now)();
  const cacheKey = `lease:${leaseId}`;
  const cached = tokenCache.get(cacheKey);
  if (!cached?.lease) {
    const persisted = await readPersistedGithubLeaseSettlement(leaseId);
    const finalized = persistedSettlementResult(leaseId, persisted);
    if (finalized) return finalized;
    const expiresAtMs = new Date(persisted.expires_at).getTime();
    const verifiedExpiry = expiresAtMs <= now.getTime();
    const state = verifiedExpiry ? 'settled' : 'reconciliation_required';
    const settlementKind = verifiedExpiry ? 'verified_expiry' : 'revocation_failed';
    const result = await execute(`UPDATE provider_authority_leases
      SET state = $2, settlement_outcome = $3, settlement_kind = $4,
          settled_at = $5, revocation_verified_at = CASE WHEN $2 = 'settled' THEN $5 ELSE NULL END
      WHERE id = $1 AND state = 'active'`, [
      leaseId,
      state,
      outcome,
      settlementKind,
      now.toISOString(),
    ]);
    if (result.rowCount !== 1) {
      const concurrent = persistedSettlementResult(leaseId, await readPersistedGithubLeaseSettlement(leaseId));
      if (concurrent) return concurrent;
      throw new ConflictError('GitHub App installation lease changed before settlement');
    }
    if (!verifiedExpiry) {
      await markGithubAppBindingInvalid(persisted.provider_binding_id, 'lease_revocation_failed');
    }
    return Object.freeze({
      leaseId,
      state,
      settlementKind,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  }
  tokenCache.delete(cacheKey);
  const verifiedExpiry = cached.expiresAtMs <= now.getTime();
  let settlementKind: GithubInstallationLeaseSettlement['settlementKind'];
  let state: GithubInstallationLeaseSettlement['state'];

  if (verifiedExpiry) {
    settlementKind = 'verified_expiry';
    state = 'settled';
  } else {
    try {
      await revokeGithubInstallationToken(cached.token, { fetch: overrides.fetch ?? DEFAULT_DEPS.fetch });
      settlementKind = 'revoked';
      state = 'settled';
    } catch {
      settlementKind = 'revocation_failed';
      state = 'reconciliation_required';
    }
  }

  const result = await execute(`UPDATE provider_authority_leases
    SET state = $2, settlement_outcome = $3, settlement_kind = $4, settled_at = $5,
        revocation_verified_at = CASE WHEN $2 = 'settled' THEN $5 ELSE NULL END
    WHERE id = $1 AND state = 'active'`, [
    leaseId,
    state,
    outcome,
    settlementKind,
    now.toISOString(),
  ]);
  if (result.rowCount !== 1) {
    const concurrent = persistedSettlementResult(leaseId, await readPersistedGithubLeaseSettlement(leaseId));
    if (concurrent) return concurrent;
    throw new ConflictError('GitHub App installation lease changed before settlement');
  }
  if (state === 'reconciliation_required') {
    await markGithubAppBindingInvalid(cached.lease.bindingId, 'lease_revocation_failed');
  }
  return Object.freeze({ leaseId, state, settlementKind, expiresAt: cached.lease.expiresAt });
}

/**
 * Read-side reconciliation never reacquires a credential. A failed revocation
 * remains fenced until the persisted provider-bounded expiry has elapsed.
 */
export async function reconcileGithubInstallationLeaseRevocation(
  workspaceId: string,
  leaseId: string,
  now = DEFAULT_DEPS.now(),
): Promise<GithubInstallationLeaseSettlement> {
  if (!workspaceId.trim()) throw new ValidationError('workspaceId is required');
  if (!UUID.test(leaseId)) throw new ValidationError('leaseId must be a UUID');
  const persisted = await readPersistedGithubLeaseSettlement(leaseId, workspaceId);
  const finalized = persistedSettlementResult(leaseId, persisted);
  if (persisted.state !== 'reconciliation_required') {
    if (finalized) return finalized;
    throw new ConflictError('GitHub App installation lease is not awaiting revocation reconciliation');
  }
  const expiresAtMs = new Date(persisted.expires_at).getTime();
  if (expiresAtMs > now.getTime()) return finalized!;

  const result = await execute(`UPDATE provider_authority_leases
    SET state = 'settled', settlement_kind = 'verified_expiry', revocation_verified_at = $3
    WHERE id = $1
      AND workspace_id = $2
      AND provider_id = 'github-app'
      AND state = 'reconciliation_required'
      AND settlement_kind = 'revocation_failed'
      AND expires_at <= $3`, [leaseId, workspaceId, now.toISOString()]);
  if (result.rowCount !== 1) {
    const concurrent = persistedSettlementResult(
      leaseId,
      await readPersistedGithubLeaseSettlement(leaseId, workspaceId),
    );
    if (concurrent) return concurrent;
    throw new ConflictError('GitHub App installation lease changed before revocation reconciliation');
  }
  return Object.freeze({
    leaseId,
    state: 'settled',
    settlementKind: 'verified_expiry',
    expiresAt: new Date(expiresAtMs).toISOString(),
  });
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
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const result = await refreshRepositoryToken(binding, request, deps);
  await revokeGithubInstallationToken(result.token, { fetch: deps.fetch });
  return result.metadata;
}

export function clearGithubAppTokenCacheForTests(): void { tokenCache.clear(); refreshes.clear(); }
