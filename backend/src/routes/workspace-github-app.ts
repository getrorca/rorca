/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response as ExpressResponse } from 'express';
import { execute, queryOne, transaction } from '../db/index';
import { requireWorkspaceAdmin, requireWorkspaceMember } from '../lib/auth-utils';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from '../lib/errors';
import { createGithubAppJwt, getWorkspaceGithubAppBinding, revalidateWorkspaceGithubAppBinding } from '../lib/github-app-credential-provider';
import { getIntegrationSecret, storeIntegrationSecret } from '../lib/integration-vault';

const router = Router();
const SETUP_TTL_MS = 10 * 60_000;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const APP_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const SUPPORTED_EVENTS = ['pull_request', 'push'] as const;

interface RegistrationRow {
  id: string;
  app_id: string | number;
  app_slug: string;
  private_key_secret_id: string;
  webhook_secret_id: string;
}

interface AppConversion {
  id?: number;
  slug?: string;
  client_id?: string;
  pem?: string;
  webhook_secret?: string;
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function actor(req: Request): string {
  const value = req.user?.email || req.user?.id;
  if (!value) throw new ValidationError('Authenticated operator identity is required');
  return String(value).slice(0, 255);
}

function csrfProof(req: Request): string {
  const value = req.headers['x-csrf-token'];
  if (typeof value !== 'string' || value.length < 16 || value.length > 512) {
    throw new ValidationError('A valid CSRF proof is required for GitHub App setup');
  }
  return value;
}

async function requireWorkspace(workspaceId: string): Promise<void> {
  const row = await queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
  if (!row) throw new NotFoundError('Workspace', workspaceId);
}

function publicSetupUrls(): { callbackUrl: string; webhookUrl: string } | null {
  const appUrl = process.env.RORCA_APP_URL?.trim();
  const webhookUrl = process.env.RORCA_GITHUB_WEBHOOK_URL?.trim() || 'https://hooks.rorca.ai/api/webhooks/github';
  try {
    const callback = new URL('/?github_app_setup=callback', appUrl);
    const hook = new URL(webhookUrl);
    if (callback.protocol !== 'https:' || hook.protocol !== 'https:'
      || ['localhost', '127.0.0.1'].includes(callback.hostname)
      || hook.pathname !== '/api/webhooks/github') return null;
    return { callbackUrl: callback.toString(), webhookUrl: hook.toString() };
  } catch {
    return null;
  }
}

function appHeaders(jwt: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Rorca-OSS',
  };
}

async function githubJson<T>(response: Response, code: string): Promise<T> {
  if (!response.ok) {
    throw new UnprocessableError(`GitHub App setup request failed with status ${response.status}`, code, {
      providerStatus: response.status,
    });
  }
  try { return await response.json() as T; } catch {
    throw new UnprocessableError('GitHub App setup returned an invalid response', code);
  }
}

function validateRegistrationInput(input: AppConversion): Required<Pick<AppConversion, 'id' | 'slug' | 'pem' | 'webhook_secret'>> & Pick<AppConversion, 'client_id'> {
  if (!Number.isSafeInteger(input.id) || Number(input.id) <= 0) throw new ValidationError('appId must be a positive safe integer');
  if (!input.slug || !APP_SLUG.test(input.slug)) throw new ValidationError('appSlug is invalid');
  if (!input.pem || input.pem.length > 65_536) throw new ValidationError('privateKeyPem is required');
  if (!input.webhook_secret || input.webhook_secret.length < 16 || input.webhook_secret.length > 1_024) {
    throw new ValidationError('webhookSecret must be between 16 and 1024 characters');
  }
  return { id: Number(input.id), slug: input.slug, pem: input.pem, webhook_secret: input.webhook_secret, client_id: input.client_id };
}

async function registerApp(input: AppConversion, createdBy: string): Promise<{ appId: number; appSlug: string }> {
  const valid = validateRegistrationInput(input);
  const jwt = createGithubAppJwt(valid.id, valid.pem);
  const providerApp = await githubJson<{ id?: number; slug?: string }>(
    await fetch('https://api.github.com/app', { headers: appHeaders(jwt) }),
    'GITHUB_APP_IDENTITY_UNAVAILABLE',
  );
  if (providerApp.id !== valid.id || providerApp.slug?.toLowerCase() !== valid.slug.toLowerCase()) {
    throw new ConflictError('GitHub App identity does not match the supplied private key');
  }

  const privateKey = await storeIntegrationSecret('private_key', valid.pem, createdBy);
  const webhookSecret = await storeIntegrationSecret('webhook_secret', valid.webhook_secret, createdBy);
  try {
    await execute(
      `INSERT INTO github_app_registrations
         (id, app_id, app_slug, client_id, private_key_secret_id, webhook_secret_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [crypto.randomUUID(), valid.id, valid.slug, valid.client_id ?? null, privateKey.id, webhookSecret.id, createdBy],
    );
  } catch (error) {
    await execute('UPDATE integration_vault_secrets SET revoked_at = NOW() WHERE id = ANY($1::uuid[])', [[privateKey.id, webhookSecret.id]]).catch(() => {});
    throw error;
  }
  return { appId: valid.id, appSlug: valid.slug };
}

async function activeRegistration(): Promise<RegistrationRow> {
  const row = await queryOne<RegistrationRow>(
    `SELECT id, app_id, app_slug, private_key_secret_id, webhook_secret_id
       FROM github_app_registrations WHERE status = 'active'`,
  );
  if (!row) throw new UnprocessableError('No active GitHub App registration exists', 'GITHUB_APP_NOT_REGISTERED');
  return row;
}

function capabilityState(permissions: Record<string, string>, hasWebhook: boolean) {
  const atLeastRead = (name: string) => ['read', 'write', 'admin'].includes(permissions[name]);
  const atLeastWrite = (name: string) => ['write', 'admin'].includes(permissions[name]);
  return {
    repository: true,
    actions: atLeastRead('actions'),
    pulls: atLeastWrite('pull_requests'),
    contents: atLeastWrite('contents'),
    statuses: atLeastWrite('statuses'),
    checks: atLeastWrite('checks'),
    webhooks: hasWebhook,
  };
}

router.use('/:id/github/app', requireWorkspaceMember());

/**
 * @swagger
 * /api/workspaces/{id}/github/app:
 *   get:
 *     tags: [GitHub]
 *     summary: Read repository-scoped GitHub App connection and capability state
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Read-only workspace-owned App binding diagnostics contain no credential material and support an honest settings state."
 *     responses:
 *       200: { description: GitHub App binding state }
 */
router.get('/:id/github/app', async (req: Request, res: ExpressResponse, next: NextFunction) => {
  try {
    const workspaceId = String(req.params.id);
    await requireWorkspace(workspaceId);
    const binding = await getWorkspaceGithubAppBinding(workspaceId);
    if (!binding) {
      const registration = await queryOne<{ app_id: string | number; app_slug: string }>(
        `SELECT app_id, app_slug FROM github_app_registrations WHERE status = 'active'`,
      );
      res.json({ configured: false, registration: registration ? { appId: Number(registration.app_id), appSlug: registration.app_slug } : null,
        nextAction: registration ? 'Install the App on a selected repository, then bind that exact installation and repository.' : 'Register the canonical GitHub App.' });
      return;
    }
    const active = binding.status === 'active' && binding.installationStatus === 'active' && binding.registrationStatus === 'active';
    res.json({
      configured: true,
      connected: active,
      source: 'github-app-installation',
      app: { id: binding.appId, slug: binding.appSlug },
      installation: { id: binding.installationId, accountId: binding.accountId, account: binding.accountLogin, type: binding.accountType, status: binding.installationStatus },
      repository: { id: binding.repositoryId, owner: binding.repoOwner, name: binding.repoName },
      binding: { id: binding.bindingId, status: binding.status, lastValidatedAt: binding.lastValidatedAt, lastWebhookAt: binding.lastWebhookAt, validationErrorCode: binding.validationErrorCode },
      capabilities: capabilityState(binding.permissions, true),
      permissions: binding.permissions,
      events: binding.events,
      nextAction: active ? null : 'An administrator must revalidate or replace the invalid App installation binding; PAT fallback is intentionally disabled while it exists.',
    });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/app/setup/start:
 *   post:
 *     tags: [GitHub]
 *     summary: Create a one-time GitHub App Manifest setup state
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "App registration grants repository authority and is restricted to an authenticated operator; admin-tier operations are excluded from MCP."
 *     responses:
 *       200: { description: One-time setup state or bounded import guidance }
 */
router.post('/:id/github/app/setup/start', requireWorkspaceAdmin(), async (req: Request, res: ExpressResponse, next: NextFunction) => {
  try {
    const workspaceId = String(req.params.id);
    await requireWorkspace(workspaceId);
    const urls = publicSetupUrls();
    if (!urls) {
      res.json({
        mode: 'bounded-import',
        nextAction: 'Configure HTTPS RORCA_APP_URL and the dedicated webhook URL, or use the admin import endpoint with values copied once from a manually created App. See docs/operations/github-app-setup.md.',
      });
      return;
    }
    const state = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SETUP_TTL_MS);
    await execute(
      `INSERT INTO github_app_setup_states
         (id, workspace_id, state_digest, csrf_digest, requested_by, callback_url, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [crypto.randomUUID(), workspaceId, digest(state), digest(csrfProof(req)), actor(req), urls.callbackUrl, expiresAt],
    );
    res.json({
      mode: 'manifest', state, expiresAt: expiresAt.toISOString(), createUrl: `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`,
      manifest: {
        name: 'Rorca', url: 'https://rorca.ai', redirect_url: urls.callbackUrl, public: false,
        hook_attributes: { url: urls.webhookUrl, active: true },
        default_events: [...SUPPORTED_EVENTS],
        default_permissions: { metadata: 'read', actions: 'read', checks: 'write', statuses: 'write', contents: 'write', pull_requests: 'write' },
      },
      nextAction: 'Submit this manifest directly to GitHub. Return the one-time code and state to the exchange endpoint within 10 minutes.',
    });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/app/setup/exchange:
 *   post:
 *     tags: [GitHub]
 *     summary: Consume one-time setup state and exchange a GitHub App Manifest code
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Manifest exchange receives private App credentials and is operator-only, one-time, CSRF-bound, and excluded from MCP."
 *     responses:
 *       200: { description: App registered without returning secrets }
 */
router.post('/:id/github/app/setup/exchange', requireWorkspaceAdmin(), async (req: Request, res: ExpressResponse, next: NextFunction) => {
  try {
    const workspaceId = String(req.params.id);
    const state = typeof req.body?.state === 'string' ? req.body.state : '';
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    if (!/^[A-Za-z0-9_-]{20,256}$/.test(state) || !/^[A-Za-z0-9_-]{6,256}$/.test(code)) {
      throw new ValidationError('Valid one-time state and manifest code are required');
    }
    const consumed = await queryOne<{ id: string }>(
      `UPDATE github_app_setup_states
          SET consumed_at = NOW()
        WHERE workspace_id = $1 AND state_digest = $2 AND csrf_digest = $3
          AND requested_by = $4 AND consumed_at IS NULL AND expires_at > NOW()
        RETURNING id`,
      [workspaceId, digest(state), digest(csrfProof(req)), actor(req)],
    );
    if (!consumed) throw new ConflictError('GitHub App setup state is expired, used, mismatched, or not owned by this operator');
    const conversion = await githubJson<AppConversion>(
      await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: 'POST', headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Rorca-OSS' },
      }),
      'GITHUB_APP_MANIFEST_EXCHANGE_FAILED',
    );
    const registered = await registerApp(conversion, actor(req));
    res.json({ registered: true, ...registered, nextAction: 'Install the App on selected repositories, then bind an exact installation/repository.' });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/app/import:
 *   post:
 *     tags: [GitHub]
 *     summary: Bounded one-time import of an existing GitHub App registration
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Private key and webhook secret import is a fallback operator ceremony and must never be model/MCP accessible."
 *     responses:
 *       200: { description: App identity verified and secrets vaulted }
 */
router.post('/:id/github/app/import', requireWorkspaceAdmin(), async (req: Request, res: ExpressResponse, next: NextFunction) => {
  try {
    await requireWorkspace(String(req.params.id));
    const registered = await registerApp({
      id: Number(req.body?.appId), slug: String(req.body?.appSlug ?? ''), client_id: typeof req.body?.clientId === 'string' ? req.body.clientId : undefined,
      pem: typeof req.body?.privateKeyPem === 'string' ? req.body.privateKeyPem : undefined,
      webhook_secret: typeof req.body?.webhookSecret === 'string' ? req.body.webhookSecret : undefined,
    }, actor(req));
    res.json({ registered: true, ...registered, nextAction: 'Install the App on selected repositories, then bind an exact installation/repository.' });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/app/revalidate:
 *   post:
 *     tags: [GitHub]
 *     summary: Revalidate the existing immutable App installation/repository binding
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Revalidation restores existing repository authority only after provider identity and permission checks; it is administrator-only and excluded from MCP."
 *     responses:
 *       200: { description: Binding revalidated without returning a token }
 */
router.post('/:id/github/app/revalidate', requireWorkspaceAdmin(), async (req: Request, res: ExpressResponse, next: NextFunction) => {
  try {
    const workspaceId = String(req.params.id);
    await requireWorkspace(workspaceId);
    const metadata = await revalidateWorkspaceGithubAppBinding(workspaceId);
    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, actor, payload)
       VALUES ('github_app_repository_binding_revalidated', $1, $2, $3::jsonb)`,
      [workspaceId, actor(req), JSON.stringify({ bindingId: metadata.bindingId, installationId: metadata.installationId, repositoryId: metadata.repositoryId })],
    );
    res.json({ revalidated: true, source: metadata.source, installationId: metadata.installationId,
      repositoryId: metadata.repositoryId, repository: metadata.repository, permissions: metadata.permissions,
      expiresAt: metadata.expiresAt, nextAction: 'Review capability diagnostics; no policy, merge, or deployment authority was activated.' });
  } catch (error) { next(error); }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/app/bind:
 *   post:
 *     tags: [GitHub]
 *     summary: Validate and bind one App installation to one exact repository
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Repository authority selection is an explicit administrator action, never a model decision, and is excluded from MCP."
 *     responses:
 *       200: { description: Immutable repository binding created }
 */
router.post('/:id/github/app/bind', requireWorkspaceAdmin(), async (req: Request, res: ExpressResponse, next: NextFunction) => {
  try {
    const workspaceId = String(req.params.id);
    await requireWorkspace(workspaceId);
    const installationId = Number(req.body?.installationId);
    const repositoryId = Number(req.body?.repositoryId);
    const repoOwner = String(req.body?.repoOwner ?? '').trim();
    const repoName = String(req.body?.repoName ?? '').trim();
    if (!Number.isSafeInteger(installationId) || installationId <= 0 || !Number.isSafeInteger(repositoryId) || repositoryId <= 0
      || !OWNER.test(repoOwner) || !REPO.test(repoName)) {
      throw new ValidationError('installationId, repositoryId, repoOwner, and repoName must identify one exact GitHub repository');
    }
    const registration = await activeRegistration();
    const privateKey = await getIntegrationSecret(registration.private_key_secret_id, 'private_key');
    if (!privateKey) throw new UnprocessableError('GitHub App private key is unavailable', 'GITHUB_APP_PRIVATE_KEY_UNAVAILABLE');
    const jwt = createGithubAppJwt(Number(registration.app_id), privateKey);
    const headers = appHeaders(jwt);
    const installation = await githubJson<{
      id?: number; app_id?: number; repository_selection?: string; suspended_at?: string | null;
      account?: { id?: number; login?: string; type?: 'Organization' | 'User' };
    }>(await fetch(`https://api.github.com/app/installations/${installationId}`, { headers }), 'GITHUB_APP_INSTALLATION_UNAVAILABLE');
    if (installation.id !== installationId || installation.app_id !== Number(registration.app_id)
      || installation.repository_selection !== 'selected' || installation.suspended_at
      || !installation.account?.id || !installation.account.login
      || !['Organization', 'User'].includes(String(installation.account.type))) {
      throw new ConflictError('Installation does not belong to the active App or is not an active selected-repositories installation');
    }
    const token = await githubJson<{ token?: string; expires_at?: string; permissions?: Record<string, string>; repository_selection?: string; repositories?: Array<{ id?: number }> }>(
      await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
        method: 'POST', headers, body: JSON.stringify({ repository_ids: [repositoryId] }),
      }), 'GITHUB_APP_TOKEN_UNAVAILABLE');
    if (!token.token || token.repository_selection !== 'selected' || new Date(token.expires_at ?? '').getTime() <= Date.now() + 60_000
      || !Array.isArray(token.repositories) || token.repositories.length !== 1 || token.repositories[0]?.id !== repositoryId) {
      throw new UnprocessableError('GitHub did not issue a usable exact-repository installation token', 'GITHUB_APP_TOKEN_INVALID');
    }
    const repository = await githubJson<{ id?: number; full_name?: string }>(
      await fetch(`https://api.github.com/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}`, {
        headers: { ...headers, Authorization: `Bearer ${token.token}` },
      }), 'GITHUB_APP_REPOSITORY_UNAVAILABLE');
    if (repository.id !== repositoryId || repository.full_name?.toLowerCase() !== `${repoOwner}/${repoName}`.toLowerCase()) {
      throw new ConflictError('Repository identity does not match the requested installation binding');
    }
    const permissions = token.permissions ?? {};
    const installationRecordId = crypto.randomUUID();
    const bindingId = crypto.randomUUID();
    await transaction(async (client) => {
      await client.query(
        `INSERT INTO github_app_installations
           (id, registration_id, installation_id, account_id, account_login, account_type,
            repository_selection, created_by, last_validated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'selected', $7, NOW())
         ON CONFLICT (installation_id) DO NOTHING`,
        [installationRecordId, registration.id, installationId, installation.account!.id, installation.account!.login,
          installation.account!.type, actor(req)],
      );
      const existing = await client.query<{ id: string; registration_id: string }>(
        'SELECT id, registration_id FROM github_app_installations WHERE installation_id = $1 FOR SHARE', [installationId],
      );
      const record = existing.rows[0];
      if (!record || record.registration_id !== registration.id) throw new ConflictError('Installation is already bound to a different App registration');
      await client.query(
        `INSERT INTO github_app_workspace_bindings
           (id, workspace_id, registration_id, installation_record_id, installation_id,
            repository_id, repo_owner, repo_name, permissions, events, created_by, last_validated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, NOW())`,
        [bindingId, workspaceId, registration.id, record.id, installationId, repositoryId, repoOwner, repoName,
          JSON.stringify(permissions), JSON.stringify(SUPPORTED_EVENTS), actor(req)],
      );
      await client.query(
        `INSERT INTO wal_events (event_type, workspace_id, actor, payload)
         VALUES ('github_app_repository_bound', $1, $2, $3::jsonb)`,
        [workspaceId, actor(req), JSON.stringify({ bindingId, appId: Number(registration.app_id), installationId, repositoryId, repository: `${repoOwner}/${repoName}` })],
      );
    });
    res.json({ bound: true, source: 'github-app-installation', appId: Number(registration.app_id), installationId, repositoryId,
      repository: { owner: repoOwner, name: repoName }, capabilities: capabilityState(permissions, true),
      nextAction: 'Review capability diagnostics. No policy, merge, or deployment authority was activated.' });
  } catch (error) { next(error); }
});

export default router;
