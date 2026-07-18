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

const JWT_MAX_LIFETIME_SECONDS = 9 * 60;
const JWT_BACKDATE_SECONDS = 60;
const TOKEN_EXPIRY_SKEW_MS = 60_000;
const MAX_CACHE_ENTRIES = 256;
const REPO_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

type PermissionLevel = 'read' | 'write' | 'admin';

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
}

interface BindingRow {
  binding_id: string;
  workspace_id: string;
  binding_status: GithubAppBindingRecord['status'];
  app_id: string | number;
  app_slug: string;
  registration_status: GithubAppBindingRecord['registrationStatus'];
  private_key_secret_id: string;
  webhook_secret_id: string;
  installation_record_id: string;
  installation_id: string | number;
  installation_status: GithubAppBindingRecord['installationStatus'];
  account_id: string | number;
  account_login: string;
  account_type: GithubAppBindingRecord['accountType'];
  repository_selection: 'selected';
  repository_id: string | number;
  repo_owner: string;
  repo_name: string;
  permissions: Record<string, string> | string;
  events: string[] | string;
  last_validated_at: string | null;
  last_webhook_at: string | null;
  validation_error_code: string | null;
}

export interface GithubAppTokenMetadata {
  source: 'github-app-installation';
  bindingId: string;
  appId: number;
  appSlug: string;
  installationId: number;
  repositoryId: number;
  repository: { owner: string; name: string };
  permissions: Record<string, string>;
  expiresAt: string;
}

export interface RepositoryInstallationToken {
  token: string;
  metadata: GithubAppTokenMetadata;
}

interface CacheEntry extends RepositoryInstallationToken {
  expiresAtMs: number;
  cachedAtMs: number;
}

interface ProviderDependencies {
  fetch: typeof fetch;
  now: () => Date;
  getSecret: typeof getIntegrationSecret;
}

const DEFAULT_DEPS: ProviderDependencies = {
  fetch,
  now: () => new Date(),
  getSecret: getIntegrationSecret,
};

const tokenCache = new Map<string, CacheEntry>();
const refreshes = new Map<string, Promise<RepositoryInstallationToken>>();

function parseObject(value: unknown): Record<string, string> {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as Record<string, string>; } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, string> : {};
}

function parseArray(value: unknown): string[] {
  if (typeof value === 'string') {
    try { return parseArray(JSON.parse(value)); } catch { return []; }
  }
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function mapBinding(row: BindingRow): GithubAppBindingRecord {
  return {
    bindingId: row.binding_id,
    workspaceId: row.workspace_id,
    status: row.binding_status,
    appId: Number(row.app_id),
    appSlug: row.app_slug,
    registrationStatus: row.registration_status,
    privateKeySecretId: row.private_key_secret_id,
    webhookSecretId: row.webhook_secret_id,
    installationRecordId: row.installation_record_id,
    installationId: Number(row.installation_id),
    installationStatus: row.installation_status,
    accountId: Number(row.account_id),
    accountLogin: row.account_login,
    accountType: row.account_type,
    repositorySelection: row.repository_selection,
    repositoryId: Number(row.repository_id),
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    permissions: parseObject(row.permissions),
    events: parseArray(row.events),
    lastValidatedAt: row.last_validated_at,
    lastWebhookAt: row.last_webhook_at,
    validationErrorCode: row.validation_error_code,
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
           b.last_validated_at, b.last_webhook_at, b.validation_error_code
      FROM github_app_workspace_bindings b
      JOIN github_app_registrations r ON r.id = b.registration_id
      JOIN github_app_installations i ON i.id = b.installation_record_id
     WHERE b.workspace_id = $1`, [workspaceId]);
  return row ? mapBinding(row) : null;
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** Create a GitHub App RS256 JWT without third-party JWT serialization. */
export function createGithubAppJwt(appId: number, privateKeyPem: string, now = new Date()): string {
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new ValidationError('GitHub App id must be a positive safe integer');
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (!Number.isFinite(nowSeconds)) throw new ValidationError('Invalid JWT clock');
  let key: crypto.KeyObject;
  try {
    key = crypto.createPrivateKey(privateKeyPem);
  } catch {
    throw new ValidationError('GitHub App private key is not a valid PEM private key');
  }
  if (key.asymmetricKeyType !== 'rsa' && key.asymmetricKeyType !== 'rsa-pss') {
    throw new ValidationError('GitHub App private key must be RSA');
  }
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iat: nowSeconds - JWT_BACKDATE_SECONDS,
    exp: nowSeconds + JWT_MAX_LIFETIME_SECONDS,
    iss: String(appId),
  }));
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), key).toString('base64url');
  return `${signingInput}.${signature}`;
}

function assertRepository(owner: string, repo: string): void {
  if (!REPO_OWNER.test(owner) || !REPO_NAME.test(repo)) {
    throw new ValidationError('Invalid GitHub repository owner or name');
  }
}

function permissionAtLeast(actual: string | undefined, required: PermissionLevel): boolean {
  const rank: Record<string, number> = { read: 1, write: 2, admin: 3 };
  return (rank[actual ?? ''] ?? 0) >= rank[required];
}

export function assertGithubAppPermissions(
  permissions: Record<string, string>,
  required: Record<string, PermissionLevel>,
): void {
  const missing = Object.entries(required)
    .filter(([name, level]) => !permissionAtLeast(permissions[name], level))
    .map(([name, level]) => `${name}:${level}`);
  if (missing.length > 0) {
    throw new UnprocessableError('GitHub App installation lacks required repository permissions', 'GITHUB_APP_PERMISSION_MISSING', { missing });
  }
}

async function providerJson<T>(response: Response, code: string): Promise<T> {
  if (!response.ok) {
    throw new UnprocessableError(`GitHub App provider request failed with status ${response.status}`, code, {
      providerStatus: response.status,
    });
  }
  try { return await response.json() as T; } catch {
    throw new UnprocessableError('GitHub App provider returned an invalid response', code);
  }
}

async function markBindingInvalid(bindingId: string, code: string): Promise<void> {
  tokenCache.delete(bindingId);
  await execute(
    `UPDATE github_app_workspace_bindings
        SET status = 'invalid', validation_error_code = $2, status_changed_at = NOW()
      WHERE id = $1 AND status = 'active'`,
    [bindingId, code.slice(0, 100)],
  ).catch(() => {});
}

async function refreshRepositoryToken(
  binding: GithubAppBindingRecord,
  requiredPermissions: Record<string, PermissionLevel>,
  deps: ProviderDependencies,
): Promise<RepositoryInstallationToken> {
  const privateKey = await deps.getSecret(binding.privateKeySecretId, 'private_key');
  if (!privateKey) {
    await markBindingInvalid(binding.bindingId, 'private_key_unavailable');
    throw new UnprocessableError('GitHub App private key is unavailable', 'GITHUB_APP_PRIVATE_KEY_UNAVAILABLE');
  }
  const appJwt = createGithubAppJwt(binding.appId, privateKey, deps.now());
  const appHeaders = {
    Authorization: `Bearer ${appJwt}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Rorca-OSS',
  };
  const installation = await providerJson<{
    id?: number; app_id?: number; repository_selection?: string;
    suspended_at?: string | null; account?: { id?: number; login?: string; type?: string };
  }>(await deps.fetch(`https://api.github.com/app/installations/${binding.installationId}`, { headers: appHeaders }), 'GITHUB_APP_INSTALLATION_UNAVAILABLE');
  const installationMatches = installation.id === binding.installationId
    && installation.app_id === binding.appId
    && installation.repository_selection === 'selected'
    && !installation.suspended_at
    && installation.account?.id === binding.accountId
    && installation.account?.login?.toLowerCase() === binding.accountLogin.toLowerCase()
    && installation.account?.type === binding.accountType;
  if (!installationMatches) {
    await markBindingInvalid(binding.bindingId, 'installation_identity_mismatch');
    throw new ConflictError('GitHub App installation identity no longer matches the immutable binding');
  }

  const tokenResponse = await providerJson<{
    token?: string; expires_at?: string; permissions?: Record<string, string>; repository_selection?: string;
    repositories?: Array<{ id?: number }>;
  }>(await deps.fetch(`https://api.github.com/app/installations/${binding.installationId}/access_tokens`, {
    method: 'POST',
    headers: { ...appHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ repository_ids: [binding.repositoryId] }),
  }), 'GITHUB_APP_TOKEN_UNAVAILABLE');
  const expiresAtMs = new Date(tokenResponse.expires_at ?? '').getTime();
  const exactRepositories = tokenResponse.repositories;
  if (!tokenResponse.token || !Number.isFinite(expiresAtMs) || expiresAtMs <= deps.now().getTime() + TOKEN_EXPIRY_SKEW_MS
    || tokenResponse.repository_selection !== 'selected' || !Array.isArray(exactRepositories)
    || exactRepositories.length !== 1 || exactRepositories[0]?.id !== binding.repositoryId) {
    await markBindingInvalid(binding.bindingId, 'token_response_invalid');
    throw new UnprocessableError('GitHub App returned an unusable repository token', 'GITHUB_APP_TOKEN_INVALID');
  }
  const permissions = tokenResponse.permissions ?? {};
  assertGithubAppPermissions(permissions, requiredPermissions);

  const repo = await providerJson<{ id?: number; full_name?: string }>(
    await deps.fetch(`https://api.github.com/repos/${encodeURIComponent(binding.repoOwner)}/${encodeURIComponent(binding.repoName)}`, {
      headers: { ...appHeaders, Authorization: `Bearer ${tokenResponse.token}` },
    }),
    'GITHUB_APP_REPOSITORY_UNAVAILABLE',
  );
  if (repo.id !== binding.repositoryId || repo.full_name?.toLowerCase() !== `${binding.repoOwner}/${binding.repoName}`.toLowerCase()) {
    await markBindingInvalid(binding.bindingId, 'repository_identity_mismatch');
    throw new ConflictError('GitHub App repository identity no longer matches the immutable binding');
  }

  const result: RepositoryInstallationToken = {
    token: tokenResponse.token,
    metadata: {
      source: 'github-app-installation',
      bindingId: binding.bindingId,
      appId: binding.appId,
      appSlug: binding.appSlug,
      installationId: binding.installationId,
      repositoryId: binding.repositoryId,
      repository: { owner: binding.repoOwner, name: binding.repoName },
      permissions,
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
  };
  tokenCache.set(binding.bindingId, { ...result, expiresAtMs, cachedAtMs: deps.now().getTime() });
  while (tokenCache.size > MAX_CACHE_ENTRIES) {
    const oldest = [...tokenCache.entries()].sort((a, b) => a[1].cachedAtMs - b[1].cachedAtMs)[0]?.[0];
    if (!oldest) break;
    tokenCache.delete(oldest);
  }
  await execute(
    `UPDATE github_app_workspace_bindings
        SET permissions = $2::jsonb, last_validated_at = NOW(), validation_error_code = NULL
      WHERE id = $1 AND status = 'active'`,
    [binding.bindingId, JSON.stringify(permissions)],
  ).catch(() => {});
  return result;
}

export async function resolveRepositoryInstallationToken(
  workspaceId: string,
  repository: { owner: string; name: string },
  requiredPermissions: Record<string, PermissionLevel> = {},
  overrides: Partial<ProviderDependencies> = {},
): Promise<RepositoryInstallationToken | null> {
  assertRepository(repository.owner, repository.name);
  const binding = await getWorkspaceGithubAppBinding(workspaceId);
  if (!binding) return null;
  if (binding.status !== 'active' || binding.registrationStatus !== 'active' || binding.installationStatus !== 'active') {
    throw new UnprocessableError('GitHub App binding is not active', 'GITHUB_APP_BINDING_INACTIVE', {
      bindingStatus: binding.status,
      installationStatus: binding.installationStatus,
    });
  }
  if (binding.repoOwner.toLowerCase() !== repository.owner.toLowerCase()
    || binding.repoName.toLowerCase() !== repository.name.toLowerCase()) {
    throw new ConflictError('Requested repository does not match the workspace GitHub App binding');
  }
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const cached = tokenCache.get(binding.bindingId);
  if (cached && cached.expiresAtMs > deps.now().getTime() + TOKEN_EXPIRY_SKEW_MS) {
    assertGithubAppPermissions(cached.metadata.permissions, requiredPermissions);
    return { token: cached.token, metadata: cached.metadata };
  }
  const existing = refreshes.get(binding.bindingId);
  if (existing) {
    const result = await existing;
    assertGithubAppPermissions(result.metadata.permissions, requiredPermissions);
    return result;
  }
  const refresh = refreshRepositoryToken(binding, requiredPermissions, deps)
    .finally(() => refreshes.delete(binding.bindingId));
  refreshes.set(binding.bindingId, refresh);
  return refresh;
}

export async function revalidateWorkspaceGithubAppBinding(
  workspaceId: string,
  overrides: Partial<ProviderDependencies> = {},
): Promise<GithubAppTokenMetadata> {
  const binding = await getWorkspaceGithubAppBinding(workspaceId);
  if (!binding) throw new UnprocessableError('No GitHub App binding exists', 'GITHUB_APP_BINDING_MISSING');
  if (binding.registrationStatus !== 'active' || binding.installationStatus !== 'active') {
    throw new UnprocessableError('GitHub App registration or installation is inactive', 'GITHUB_APP_BINDING_INACTIVE');
  }
  const result = await refreshRepositoryToken(binding, {
    actions: 'read', checks: 'write', statuses: 'write', contents: 'write', pull_requests: 'write',
  }, { ...DEFAULT_DEPS, ...overrides });
  await execute(
    `UPDATE github_app_workspace_bindings
        SET status = 'active', validation_error_code = NULL, status_changed_at = NOW(), last_validated_at = NOW()
      WHERE id = $1`,
    [binding.bindingId],
  );
  return result.metadata;
}

export function clearGithubAppTokenCacheForTests(): void {
  tokenCache.clear();
  refreshes.clear();
}
