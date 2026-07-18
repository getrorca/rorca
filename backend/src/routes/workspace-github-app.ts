/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { execute, queryOne, transaction } from '../db/index';
import { requireWorkspaceAdmin, requireWorkspaceMember } from '../lib/auth-utils';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from '../lib/errors';
import {
  assertGithubAppPermissions,
  assertGithubAppProviderProfile,
  createGithubAppJwt,
  fetchGithubWithTimeout,
  getWorkspaceGithubAppBinding,
  githubAppBindingHasVerifiedProfile,
  GITHUB_APP_REQUIRED_EVENTS,
  GITHUB_APP_REQUIRED_PERMISSIONS,
  revalidateWorkspaceGithubAppBinding,
} from '../lib/github-app-credential-provider';
import { assertGithubRepositoryIdentity } from '../lib/github-repository-authority';
import { getIntegrationSecret, insertPreparedIntegrationSecret, prepareIntegrationSecret } from '../lib/integration-vault';

const router = Router();
const SETUP_TTL_MS = 10 * 60_000;
const APP_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

interface RegistrationRow { id: string; app_id: string | number; app_slug: string; private_key_secret_id: string; webhook_secret_id: string }
interface AppConversion { id?: number; slug?: string; client_id?: string; pem?: string; webhook_secret?: string }
interface ProviderApp { id?: number; slug?: string; permissions?: Record<string, string>; events?: string[] }

function digest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
function actor(req: Request): string {
  const value = req.user?.email || req.user?.id;
  if (!value) throw new ValidationError('Authenticated operator identity is required');
  return String(value).slice(0, 255);
}
async function requireWorkspace(workspaceId: string): Promise<void> {
  const row = await queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
  if (!row) throw new NotFoundError('Workspace', workspaceId);
}

function publicSetup(): { callbackUrl: string; webhookUrl: string; organization: string; createUrl: string } | null {
  const appUrl = process.env.RORCA_APP_URL?.trim();
  const webhookUrl = process.env.RORCA_GITHUB_WEBHOOK_URL?.trim() || 'https://hooks.rorca.ai/api/webhooks/github';
  const organization = process.env.RORCA_GITHUB_APP_CREATION_ORG?.trim() || '';
  if (!ORG.test(organization)) return null;
  try {
    const callback = new URL('/settings/github?github_app_setup=callback', appUrl);
    const hook = new URL(webhookUrl);
    if (callback.protocol !== 'https:' || hook.protocol !== 'https:'
      || ['localhost', '127.0.0.1'].includes(callback.hostname)
      || hook.pathname !== '/api/webhooks/github' || hook.search || hook.hash) return null;
    return {
      callbackUrl: callback.toString(), webhookUrl: hook.toString(), organization,
      createUrl: `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`,
    };
  } catch { return null; }
}
function expectedWebhookUrl(): string {
  const value = process.env.RORCA_GITHUB_WEBHOOK_URL?.trim() || 'https://hooks.rorca.ai/api/webhooks/github';
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.pathname !== '/api/webhooks/github' || url.search || url.hash) {
    throw new UnprocessableError('Dedicated HTTPS GitHub webhook URL is not configured', 'GITHUB_APP_WEBHOOK_URL_INVALID');
  }
  return url.toString();
}
function appHeaders(jwt: string): Record<string, string> {
  return { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Rorca-OSS' };
}
async function githubJson<T>(response: Response, code: string): Promise<T> {
  if (!response.ok) throw new UnprocessableError(`GitHub App setup request failed with status ${response.status}`, code, { providerStatus: response.status });
  try { return await response.json() as T; } catch { throw new UnprocessableError('GitHub App setup returned an invalid response', code); }
}
function validateRegistrationInput(input: AppConversion): Required<Pick<AppConversion, 'id' | 'slug' | 'pem' | 'webhook_secret'>> & Pick<AppConversion, 'client_id'> {
  if (!Number.isSafeInteger(input.id) || Number(input.id) <= 0) throw new ValidationError('appId must be a positive safe integer');
  if (!input.slug || !APP_SLUG.test(input.slug)) throw new ValidationError('appSlug is invalid');
  if (!input.pem || input.pem.length > 65_536) throw new ValidationError('privateKeyPem is required');
  if (!input.webhook_secret || input.webhook_secret.length < 16 || input.webhook_secret.length > 1_024) throw new ValidationError('webhookSecret must be between 16 and 1024 characters');
  return { id: Number(input.id), slug: input.slug, pem: input.pem, webhook_secret: input.webhook_secret, client_id: input.client_id };
}

async function verifyProviderProfile(jwt: string, expectedApp?: { id: number; slug: string }): Promise<{ permissions: Record<string, string>; events: string[]; webhookVerified: true }> {
  const headers = appHeaders(jwt);
  const [providerApp, hook] = await Promise.all([
    githubJson<ProviderApp>(await fetchGithubWithTimeout(fetch, 'https://api.github.com/app', { headers }), 'GITHUB_APP_IDENTITY_UNAVAILABLE'),
    githubJson<{ url?: string; content_type?: string; insecure_ssl?: string }>(
      await fetchGithubWithTimeout(fetch, 'https://api.github.com/app/hook/config', { headers }),
      'GITHUB_APP_WEBHOOK_CONFIG_UNAVAILABLE',
    ),
  ]);
  if (expectedApp && (providerApp.id !== expectedApp.id || providerApp.slug?.toLowerCase() !== expectedApp.slug.toLowerCase())) {
    throw new ConflictError('GitHub App identity does not match the supplied private key');
  }
  const permissions = providerApp.permissions ?? {};
  const events = Array.isArray(providerApp.events) ? providerApp.events : [];
  assertGithubAppProviderProfile(permissions, events);
  if (hook.url !== expectedWebhookUrl() || hook.content_type !== 'json' || !['0', undefined].includes(hook.insecure_ssl)) {
    throw new UnprocessableError('GitHub App webhook configuration does not match the dedicated secure endpoint', 'GITHUB_APP_WEBHOOK_PROFILE_UNSUPPORTED');
  }
  return { permissions, events, webhookVerified: true };
}

async function registerApp(input: AppConversion, createdBy: string): Promise<{ appId: number; appSlug: string }> {
  const valid = validateRegistrationInput(input);
  const existing = await queryOne<{ id: string }>(`SELECT id FROM github_app_registrations WHERE status = 'active'`);
  if (existing) {
    throw new ConflictError('An active GitHub App registration already exists. Registration key rotation/replacement is blocked until a dedicated audited rotation ceremony is used.');
  }
  const jwt = createGithubAppJwt(valid.id, valid.pem);
  await verifyProviderProfile(jwt, { id: valid.id, slug: valid.slug });
  const privateKey = prepareIntegrationSecret('private_key', valid.pem, createdBy);
  const webhookSecret = prepareIntegrationSecret('webhook_secret', valid.webhook_secret, createdBy);
  await transaction(async (client) => {
    await insertPreparedIntegrationSecret(client, privateKey);
    await insertPreparedIntegrationSecret(client, webhookSecret);
    await client.query(
      `INSERT INTO github_app_registrations
         (id, app_id, app_slug, client_id, private_key_secret_id, webhook_secret_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [crypto.randomUUID(), valid.id, valid.slug, valid.client_id ?? null, privateKey.id, webhookSecret.id, createdBy],
    );
  });
  return { appId: valid.id, appSlug: valid.slug };
}
async function activeRegistration(): Promise<RegistrationRow> {
  const row = await queryOne<RegistrationRow>(`SELECT id, app_id, app_slug, private_key_secret_id, webhook_secret_id FROM github_app_registrations WHERE status = 'active'`);
  if (!row) throw new UnprocessableError('No active GitHub App registration exists', 'GITHUB_APP_NOT_REGISTERED');
  return row;
}
function fullCapabilityState(binding: Awaited<ReturnType<typeof getWorkspaceGithubAppBinding>>) {
  if (!binding) return { repository: false, actions: false, pulls: false, contents: false, statuses: false, checks: false, issues: false, webhooks: false };
  const active = githubAppBindingHasVerifiedProfile(binding);
  return { repository: active, actions: active, pulls: active, contents: active, statuses: active, checks: active, issues: active, webhooks: active };
}
function supportedProfilePermissionsWithMetadata(): Record<string, 'read' | 'write'> {
  return { metadata: 'read', ...GITHUB_APP_REQUIRED_PERMISSIONS };
}

router.use('/:id/github/app', requireWorkspaceMember());

/**
 * @swagger
 * /api/workspaces/{id}/github/app:
 *   get:
 *     tags: [GitHub]
 *     summary: Read provider-verified repository-scoped GitHub App state
 *     operationId: getWorkspaceGithubAppState
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Read-only workspace-owned App diagnostics contain no credential material."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: GitHub App binding and fail-closed capability state }
 *       401: { description: Authentication required }
 *       403: { description: Workspace membership required }
 */
router.get('/:id/github/app', async (req, res, next) => {
  try {
    const workspaceId = String(req.params.id); await requireWorkspace(workspaceId);
    const binding = await getWorkspaceGithubAppBinding(workspaceId);
    if (!binding) {
      const registration = await queryOne<{ app_id: string | number; app_slug: string }>(`SELECT app_id, app_slug FROM github_app_registrations WHERE status = 'active'`);
      res.json({ configured: false, connected: false, registration: registration ? { appId: Number(registration.app_id), appSlug: registration.app_slug } : null,
        capabilities: fullCapabilityState(null), nextAction: registration ? 'Install the App on one selected repository, then bind it.' : 'Register the canonical GitHub App.' }); return;
    }
    const capabilities = fullCapabilityState(binding);
    const connected = Object.values(capabilities).every(Boolean);
    res.json({ configured: true, connected, source: 'github-app-installation', app: { id: binding.appId, slug: binding.appSlug },
      installation: { id: binding.installationId, accountId: binding.accountId, account: binding.accountLogin, type: binding.accountType, status: binding.installationStatus },
      repository: { id: binding.repositoryId, owner: binding.repoOwner, name: binding.repoName },
      binding: { id: binding.bindingId, status: binding.status, lastValidatedAt: binding.lastValidatedAt, lastWebhookAt: binding.lastWebhookAt, validationErrorCode: binding.validationErrorCode },
      capabilities, permissions: binding.permissions, events: binding.events,
      nextAction: connected ? null : 'An administrator must revalidate or replace the binding; legacy credential and webhook fallback remain blocked.' });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/app/setup/start:
 *   post:
 *     tags: [GitHub]
 *     summary: Create one operator-bound GitHub App Manifest state
 *     operationId: startWorkspaceGithubAppSetup
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "App registration grants repository authority and is operator-only and non-MCP."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Manifest handoff or bounded import ceremony }
 *       403: { description: Workspace admin required }
 */
router.post('/:id/github/app/setup/start', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const workspaceId = String(req.params.id); await requireWorkspace(workspaceId);
    const setup = publicSetup();
    if (!setup) {
      res.json({ mode: 'bounded-import', nextAction: 'Use the in-product one-time import form. Configure RORCA_APP_URL, RORCA_GITHUB_WEBHOOK_URL, and RORCA_GITHUB_APP_CREATION_ORG to enable Manifest setup.' }); return;
    }
    const state = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SETUP_TTL_MS);
    await execute(`INSERT INTO github_app_setup_states (id, workspace_id, state_digest, csrf_digest, requested_by, callback_url, expires_at)
                   VALUES ($1, $2, $3, NULL, $4, $5, $6)`,
      [crypto.randomUUID(), workspaceId, digest(state), actor(req), setup.callbackUrl, expiresAt]);
    res.json({ mode: 'manifest', state, expiresAt: expiresAt.toISOString(), createUrl: `${setup.createUrl}?state=${encodeURIComponent(state)}`,
      manifest: { name: 'Rorca', url: 'https://rorca.ai', redirect_url: setup.callbackUrl, public: false,
        hook_attributes: { url: setup.webhookUrl, active: true }, default_events: [...GITHUB_APP_REQUIRED_EVENTS],
        default_permissions: GITHUB_APP_REQUIRED_PERMISSIONS },
      nextAction: `Create the private App in the ${setup.organization} organization. The one-time state remains bound to this authenticated operator and workspace for 10 minutes.` });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/app/setup/exchange:
 *   post:
 *     tags: [GitHub]
 *     summary: Consume one-time state and exchange a Manifest code
 *     operationId: exchangeWorkspaceGithubAppManifest
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Manifest exchange handles private App credentials inside the vault boundary and is non-MCP."
 *     responses:
 *       200: { description: App registered without returning secrets }
 *       409: { description: State expired, consumed, or owned by another operator }
 */
router.post('/:id/github/app/setup/exchange', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const workspaceId = String(req.params.id);
    const state = typeof req.body?.state === 'string' ? req.body.state : '';
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    if (!/^[A-Za-z0-9_-]{20,256}$/.test(state) || !/^[A-Za-z0-9_-]{6,256}$/.test(code)) throw new ValidationError('Valid one-time state and manifest code are required');
    const consumed = await queryOne<{ id: string }>(`UPDATE github_app_setup_states SET consumed_at = NOW()
      WHERE workspace_id = $1 AND state_digest = $2 AND requested_by = $3 AND consumed_at IS NULL AND expires_at > NOW() RETURNING id`,
      [workspaceId, digest(state), actor(req)]);
    if (!consumed) throw new ConflictError('GitHub App setup state is expired, used, mismatched, or not owned by this operator');
    const conversion = await githubJson<AppConversion>(await fetchGithubWithTimeout(fetch,
      `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
      { method: 'POST', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Rorca-OSS' } }),
      'GITHUB_APP_MANIFEST_EXCHANGE_FAILED');
    const registered = await registerApp(conversion, actor(req));
    res.json({ registered: true, ...registered, nextAction: 'Install the App on one selected repository, then bind it.' });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/app/import:
 *   post:
 *     tags: [GitHub]
 *     summary: One-time bounded import of an existing GitHub App
 *     operationId: importWorkspaceGithubApp
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Secrets cross only the authenticated operator-to-vault boundary and are never returned, logged, or MCP-exposed."
 *     responses:
 *       200: { description: Provider profile verified and secrets atomically vaulted }
 *       409: { description: Active registration replacement is explicitly blocked }
 */
router.post('/:id/github/app/import', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    await requireWorkspace(String(req.params.id));
    const registered = await registerApp({ id: Number(req.body?.appId), slug: String(req.body?.appSlug ?? ''),
      client_id: typeof req.body?.clientId === 'string' ? req.body.clientId : undefined,
      pem: typeof req.body?.privateKeyPem === 'string' ? req.body.privateKeyPem : undefined,
      webhook_secret: typeof req.body?.webhookSecret === 'string' ? req.body.webhookSecret : undefined }, actor(req));
    res.json({ registered: true, ...registered, nextAction: 'Install the App on one selected repository, then bind it.' });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/app/revalidate:
 *   post:
 *     tags: [GitHub]
 *     summary: Provider-revalidate the current App binding and full supported profile
 *     operationId: revalidateWorkspaceGithubApp
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Revalidation restores authority only after provider identity, event, webhook, and permission checks."
 *     responses:
 *       200: { description: Binding revalidated without returning a token }
 */
router.post('/:id/github/app/revalidate', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const workspaceId = String(req.params.id); await requireWorkspace(workspaceId);
    const registration = await activeRegistration();
    const key = await getIntegrationSecret(registration.private_key_secret_id, 'private_key');
    if (!key) throw new UnprocessableError('GitHub App private key is unavailable', 'GITHUB_APP_PRIVATE_KEY_UNAVAILABLE');
    const profile = await verifyProviderProfile(createGithubAppJwt(Number(registration.app_id), key), { id: Number(registration.app_id), slug: registration.app_slug });
    const metadata = await revalidateWorkspaceGithubAppBinding(workspaceId, GITHUB_APP_REQUIRED_PERMISSIONS);
    await transaction(async (client) => {
      await client.query(`UPDATE github_app_workspace_bindings SET status = 'active', permissions = $2::jsonb, events = $3::jsonb,
          webhook_verified = TRUE, provider_profile_verified_at = NOW(), validation_error_code = NULL, status_changed_at = NOW(), last_validated_at = NOW()
          WHERE id = $1 AND superseded_at IS NULL`, [metadata.bindingId, JSON.stringify(profile.permissions), JSON.stringify(profile.events)]);
      await client.query(`INSERT INTO wal_events (event_type, workspace_id, actor, payload) VALUES ('github_app_repository_binding_revalidated', $1, $2, $3::jsonb)`,
        [workspaceId, actor(req), JSON.stringify({ bindingId: metadata.bindingId, installationId: metadata.installationId, repositoryId: metadata.repositoryId })]);
    });
    res.json({ revalidated: true, source: metadata.source, installationId: metadata.installationId, repositoryId: metadata.repositoryId,
      repository: metadata.repository, capabilities: fullCapabilityState(await getWorkspaceGithubAppBinding(workspaceId)), nextAction: 'Provider-supported profile verified.' });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/app/bind:
 *   post:
 *     tags: [GitHub]
 *     summary: Validate and bind or audit-replace one exact App repository
 *     operationId: bindWorkspaceGithubAppRepository
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Repository authority selection and replacement are explicit admin actions and non-MCP."
 *     responses:
 *       200: { description: Provider-verified exact repository binding created }
 *       409: { description: Replacement rationale missing or provider identity conflicts }
 */
router.post('/:id/github/app/bind', requireWorkspaceAdmin(), async (req, res, next) => {
  try {
    const workspaceId = String(req.params.id); await requireWorkspace(workspaceId);
    const installationId = Number(req.body?.installationId); const repositoryId = Number(req.body?.repositoryId);
    const repoOwner = String(req.body?.repoOwner ?? '').trim(); const repoName = String(req.body?.repoName ?? '').trim();
    const replacementReason = typeof req.body?.replacementReason === 'string' ? req.body.replacementReason.trim() : '';
    if (!Number.isSafeInteger(installationId) || installationId <= 0 || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw new ValidationError('installationId and repositoryId must be positive safe integers');
    assertGithubRepositoryIdentity(repoOwner, repoName);
    const current = await getWorkspaceGithubAppBinding(workspaceId);
    if (current && replacementReason.length < 8) throw new ConflictError('Replacing the current App binding requires an audited replacementReason of at least 8 characters');
    const registration = await activeRegistration();
    const privateKey = await getIntegrationSecret(registration.private_key_secret_id, 'private_key');
    if (!privateKey) throw new UnprocessableError('GitHub App private key is unavailable', 'GITHUB_APP_PRIVATE_KEY_UNAVAILABLE');
    const jwt = createGithubAppJwt(Number(registration.app_id), privateKey); const headers = appHeaders(jwt);
    const profile = await verifyProviderProfile(jwt, { id: Number(registration.app_id), slug: registration.app_slug });
    const installation = await githubJson<{ id?: number; app_id?: number; repository_selection?: string; suspended_at?: string | null; account?: { id?: number; login?: string; type?: 'Organization' | 'User' } }>(
      await fetchGithubWithTimeout(fetch, `https://api.github.com/app/installations/${installationId}`, { headers }), 'GITHUB_APP_INSTALLATION_UNAVAILABLE');
    if (installation.id !== installationId || installation.app_id !== Number(registration.app_id) || installation.repository_selection !== 'selected'
      || installation.suspended_at || !installation.account?.id || !installation.account.login || !['Organization', 'User'].includes(String(installation.account.type))) {
      throw new ConflictError('Installation does not belong to the active App or is not an active selected-repositories installation');
    }
    const requestedPermissions = supportedProfilePermissionsWithMetadata();
    const token = await githubJson<{ token?: string; expires_at?: string; permissions?: Record<string, string>; repository_selection?: string; repositories?: Array<{ id?: number }> }>(
      await fetchGithubWithTimeout(fetch, `https://api.github.com/app/installations/${installationId}/access_tokens`, {
        method: 'POST', headers, body: JSON.stringify({ repository_ids: [repositoryId], permissions: GITHUB_APP_REQUIRED_PERMISSIONS }),
      }), 'GITHUB_APP_TOKEN_UNAVAILABLE');
    if (!token.token || token.repository_selection !== 'selected' || new Date(token.expires_at ?? '').getTime() <= Date.now() + 60_000
      || !Array.isArray(token.repositories) || token.repositories.length !== 1 || token.repositories[0]?.id !== repositoryId) {
      throw new UnprocessableError('GitHub did not issue a usable exact-repository installation token', 'GITHUB_APP_TOKEN_INVALID');
    }
    assertGithubAppPermissions(token.permissions ?? {}, requestedPermissions);
    const unknownTokenPermissions = Object.keys(token.permissions ?? {}).filter((name) => !(name in requestedPermissions));
    const broaderTokenPermissions = Object.entries(token.permissions ?? {}).filter(([name, level]) => requestedPermissions[name] !== level);
    if (unknownTokenPermissions.length || broaderTokenPermissions.length) throw new UnprocessableError('GitHub returned a broader or unknown token permission grant', 'GITHUB_APP_TOKEN_PERMISSION_CONFUSION');
    const repository = await githubJson<{ id?: number; full_name?: string }>(await fetchGithubWithTimeout(fetch,
      `https://api.github.com/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}`,
      { headers: { ...headers, Authorization: `Bearer ${token.token}` } }), 'GITHUB_APP_REPOSITORY_UNAVAILABLE');
    if (repository.id !== repositoryId || repository.full_name?.toLowerCase() !== `${repoOwner}/${repoName}`.toLowerCase()) throw new ConflictError('Repository identity does not match the requested installation binding');

    const installationRecordId = crypto.randomUUID(); const bindingId = crypto.randomUUID(); const principal = actor(req);
    await transaction(async (client) => {
      await client.query(`INSERT INTO github_app_installations
        (id, registration_id, installation_id, account_id, account_login, account_type, repository_selection, created_by, last_validated_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'selected', $7, NOW()) ON CONFLICT (installation_id) DO NOTHING`,
        [installationRecordId, registration.id, installationId, installation.account!.id, installation.account!.login, installation.account!.type, principal]);
      const found = await client.query<{ id: string; registration_id: string; installation_id: string }>(
        'SELECT id, registration_id, installation_id::text FROM github_app_installations WHERE installation_id = $1 FOR SHARE', [installationId]);
      const record = found.rows[0];
      if (!record || record.registration_id !== registration.id || Number(record.installation_id) !== installationId) throw new ConflictError('Installation identity conflicts with the active App registration');
      if (current) {
        await client.query(`UPDATE github_app_workspace_bindings SET status = 'disabled', superseded_at = NOW(), superseded_by_principal = $2,
          replacement_reason = $3, validation_error_code = 'superseded', status_changed_at = NOW() WHERE id = $1 AND superseded_at IS NULL`,
          [current.bindingId, principal, replacementReason]);
      }
      await client.query(`INSERT INTO github_app_workspace_bindings
        (id, workspace_id, registration_id, installation_record_id, installation_id, repository_id, repo_owner, repo_name,
         permissions, events, created_by, last_validated_at, provider_profile_verified_at, webhook_verified)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,NOW(),NOW(),TRUE)`,
        [bindingId, workspaceId, registration.id, record.id, installationId, repositoryId, repoOwner, repoName,
          JSON.stringify(profile.permissions), JSON.stringify(profile.events), principal]);
      await client.query(`INSERT INTO github_repository_configs (workspace_id, repo_owner, repo_name)
        VALUES ($1,$2,$3) ON CONFLICT (workspace_id) DO UPDATE SET repo_owner = EXCLUDED.repo_owner, repo_name = EXCLUDED.repo_name, updated_at = NOW()`,
        [workspaceId, repoOwner, repoName]);
      await client.query(`UPDATE workspace_github_webhooks SET authority_status = 'retired', retired_at = NOW(), webhook_secret_revoked_at = NOW(),
        retirement_reason = 'retired_by_github_app_binding' WHERE workspace_id = $1 AND authority_status = 'active'`, [workspaceId]);
      await client.query(`INSERT INTO wal_events (event_type, workspace_id, actor, payload) VALUES ($1,$2,$3,$4::jsonb)`,
        [current ? 'github_app_repository_binding_replaced' : 'github_app_repository_bound', workspaceId, principal,
          JSON.stringify({ bindingId, supersededBindingId: current?.bindingId ?? null, appId: Number(registration.app_id), installationId, repositoryId, repository: `${repoOwner}/${repoName}`, legacyWebhookAuthorityRetired: true, legacyWebhookSecretAuthorityRevoked: true })]);
    });
    res.json({ bound: true, replaced: Boolean(current), source: 'github-app-installation', appId: Number(registration.app_id), installationId, repositoryId,
      repository: { owner: repoOwner, name: repoName }, capabilities: { repository: true, actions: true, pulls: true, contents: true, statuses: true, checks: true, issues: true, webhooks: true },
      nextAction: 'Full provider-supported profile and dedicated webhook configuration verified.' });
  } catch (error) { next(error); }
});

export default router;
