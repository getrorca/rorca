/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'crypto';
import path from 'path';
import { readFile } from 'fs/promises';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { query, queryOne, execute } from '../db/index';
import { encryptToken, requireWorkspaceAdmin, requireWorkspaceMember } from '../lib/auth-utils';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { storeOAuthToken, revokeToken, markTokenValidated } from '../lib/integration-vault';
import { resolveWorkspaceGitHubToken } from '../lib/github-token-resolver';
import { fetchGithubWithTimeout, getWorkspaceGithubAppBinding, githubAppBindingHasVerifiedProfile } from '../lib/github-app-credential-provider';
import { extractGithubProviderError } from '../lib/github-provider-error';
import {
  assertGithubRepositoryIdentity,
  getGithubRepositoryAuthority,
  githubRepoApiUrl,
} from '../lib/github-repository-authority';
import { renderPrTemplate, SAMPLE_PR_TEMPLATE_DATA, type PrTemplateData } from '../lib/github/pr-template';
import { requireProviderMutationAuthority } from '../lib/provider-mutation-authority';

const router = Router({ strict: true, caseSensitive: true });

interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
}

interface GithubWebhookRow {
  workspace_id: string;
  repo_owner: string;
  repo_name: string;
  webhook_id: number | null;
  encrypted_webhook_secret: string;
  last_webhook_at: string | null;
  created_at: string;
}

interface GithubWorkflowSummary {
  id: number;
  name: string;
  path: string;
  state: string;
  htmlUrl?: string;
  badgeUrl?: string;
}

interface LatestRunPreviewRow {
  id: number;
  spec_path: string | null;
  status: string | null;
  started_at: string | null;
  finished_at: string | null;
  agent_type: string | null;
  agent_model: string | null;
}

function buildGitHubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Rorca-OSS',
  };
}

function parseScopes(headerValue: string | null): string[] {
  return (headerValue || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function getBackendBaseUrl(req: Request): string {
  return process.env.RORCA_API_URL?.trim() || `${req.protocol}://${req.get('host')}`;
}

async function requireWorkspace(id: string): Promise<WorkspaceRow> {
  const workspace = await queryOne<WorkspaceRow>('SELECT id, label, path FROM workspaces WHERE id = $1', [id]);
  if (!workspace) {
    throw new NotFoundError('Workspace not found');
  }
  return workspace;
}

async function validateGitHubToken(token: string): Promise<{
  username: string;
  avatarUrl: string | null;
  scopes: string[];
}> {
  const response = await fetchGithubWithTimeout(fetch, 'https://api.github.com/user', {
    headers: buildGitHubHeaders(token),
  });

  if (!response.ok) {
    const safe = extractGithubProviderError(response, 'GITHUB_TOKEN_VALIDATION_FAILED');
    throw new ValidationError(safe.message, { providerStatus: safe.providerStatus, providerRequestId: safe.requestId });
  }

  const data = await response.json() as { login?: string; avatar_url?: string | null };
  if (!data.login) {
    throw new ValidationError('GitHub token did not return a user login');
  }

  return {
    username: data.login,
    avatarUrl: data.avatar_url ?? null,
    scopes: parseScopes(response.headers.get('x-oauth-scopes')),
  };
}

function formatDuration(startedAt?: string | null, finishedAt?: string | null): string {
  if (!startedAt || !finishedAt) return 'Unknown';
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 'Unknown';
  const totalSeconds = Math.round((end - start) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

async function readSpecPreview(workspace: WorkspaceRow, specPath: string | null): Promise<{ title: string; brief: string }> {
  if (!specPath) return SAMPLE_PR_TEMPLATE_DATA.spec;
  try {
    const fullPath = path.join(workspace.path, specPath);
    const raw = await readFile(fullPath, 'utf8');
    const parsed = JSON.parse(raw) as { specName?: string; id?: string; title?: string; brief?: string; description?: string };
    return {
      title: parsed.specName || parsed.title || parsed.id || path.basename(specPath, '.json'),
      brief: parsed.brief || parsed.description || SAMPLE_PR_TEMPLATE_DATA.spec.brief,
    };
  } catch {
    return {
      title: specPath ? path.basename(specPath, '.json') : SAMPLE_PR_TEMPLATE_DATA.spec.title,
      brief: SAMPLE_PR_TEMPLATE_DATA.spec.brief,
    };
  }
}

async function buildLatestPrTemplatePreview(workspace: WorkspaceRow): Promise<{ data: PrTemplateData; source: 'latest-run' | 'sample'; runSummary: Record<string, unknown> | null }> {
  const latestRun = await queryOne<LatestRunPreviewRow>(
    `SELECT id, spec_path, status, started_at, finished_at,
            COALESCE(agent_type, agent, 'claude') AS agent_type,
            agent_model
       FROM pipeline_runs
      WHERE workspace_id = $1
      ORDER BY id DESC
      LIMIT 1`,
    [workspace.id],
  ).catch(() => undefined);

  if (!latestRun) {
    return { data: SAMPLE_PR_TEMPLATE_DATA, source: 'sample', runSummary: null };
  }

  const storyRows = await query<{ status: string | null; count: string }>(
    `SELECT COALESCE(status, 'unknown') AS status, COUNT(*)::text AS count
       FROM story_results
      WHERE run_id = $1
      GROUP BY COALESCE(status, 'unknown')`,
    [latestRun.id],
  ).catch(() => []);

  const storyCounts = storyRows.reduce<Record<string, number>>((acc, row) => {
    acc[String(row.status || 'unknown')] = Number(row.count || 0);
    return acc;
  }, {});
  const storiesPassed = storyCounts.passed || storyCounts.done || storyCounts.success || 0;
  const storiesFailed = storyCounts.failed || storyCounts.error || 0;
  const storiesSkipped = storyCounts.skipped || storyCounts.skip || 0;
  const storiesTotal = Object.values(storyCounts).reduce((sum, value) => sum + value, 0);

  const usage = await queryOne<{ input_tokens: string | number | null; output_tokens: string | number | null; cost_usd: string | number | null }>(
    `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM token_usage
      WHERE run_id = $1`,
    [latestRun.id],
  ).catch(() => undefined);

  const tokensInput = Number(usage?.input_tokens ?? 0);
  const tokensOutput = Number(usage?.output_tokens ?? 0);
  const spec = await readSpecPreview(workspace, latestRun.spec_path);
  const data: PrTemplateData = {
    spec,
    run: {
      id: latestRun.id,
      storiesPassed,
      storiesTotal,
      storiesFailed,
      storiesSkipped,
      tokensInput,
      tokensOutput,
      tokensTotal: tokensInput + tokensOutput,
      costUsd: `$${Number(usage?.cost_usd ?? 0).toFixed(2)}`,
      duration: formatDuration(latestRun.started_at, latestRun.finished_at),
      agentType: latestRun.agent_type || 'claude',
      model: latestRun.agent_model || 'default',
      diffStats: 'Diff stats are attached when the run uses a PR release strategy.',
      diffSummary: `Latest ${latestRun.status || 'pipeline'} run for ${spec.title}`,
    },
  };

  return {
    data,
    source: 'latest-run',
    runSummary: {
      id: latestRun.id,
      status: latestRun.status,
      specPath: latestRun.spec_path,
      title: spec.title,
      storiesPassed,
      storiesTotal,
    },
  };
}

function mapWorkflow(workflow: Record<string, unknown>): GithubWorkflowSummary {
  return {
    id: Number(workflow.id),
    name: String(workflow.name || workflow.path || workflow.id),
    path: String(workflow.path || ''),
    state: String(workflow.state || 'unknown'),
    htmlUrl: typeof workflow.html_url === 'string' ? workflow.html_url : undefined,
    badgeUrl: typeof workflow.badge_url === 'string' ? workflow.badge_url : undefined,
  };
}

async function createWebhook(
  owner: string,
  repo: string,
  token: string,
  webhookUrl: string,
  secret: string,
): Promise<number> {
  const response = await fetchGithubWithTimeout(fetch, githubRepoApiUrl(owner, repo, '/hooks'), {
    method: 'POST',
    headers: buildGitHubHeaders(token),
    body: JSON.stringify({
      name: 'web',
      active: true,
      events: ['push', 'pull_request', 'issues', 'check_run'],
      config: {
        url: webhookUrl,
        content_type: 'json',
        secret,
        insecure_ssl: '0',
      },
    }),
  });

  if (response.status === 422) {
    const hooksResponse = await fetchGithubWithTimeout(fetch, githubRepoApiUrl(owner, repo, '/hooks'), {
      headers: buildGitHubHeaders(token),
    });
    if (hooksResponse.ok) {
      const hooks = await hooksResponse.json() as Array<{ id?: number; config?: { url?: string } }>;
      const existing = hooks.find((hook) => hook.config?.url === webhookUrl);
      if (existing?.id) {
        return existing.id;
      }
    }
  }

  if (!response.ok) {
    const safe = extractGithubProviderError(response, 'GITHUB_WEBHOOK_CREATE_FAILED');
    throw new ValidationError(safe.message, { providerStatus: safe.providerStatus, providerRequestId: safe.requestId });
  }

  const data = await response.json() as { id?: number };
  if (!data.id) {
    throw new ValidationError('GitHub did not return a webhook id');
  }
  return data.id;
}

async function deleteWebhook(owner: string, repo: string, webhookId: number, token: string): Promise<void> {
  const response = await fetchGithubWithTimeout(fetch, githubRepoApiUrl(owner, repo, `/hooks/${webhookId}`), {
    method: 'DELETE',
    headers: buildGitHubHeaders(token),
  });

  if (!response.ok && response.status !== 404) {
    const safe = extractGithubProviderError(response, 'GITHUB_WEBHOOK_DELETE_FAILED');
    throw new ValidationError(safe.message, { providerStatus: safe.providerStatus, providerRequestId: safe.requestId });
  }
}

async function getGithubRow(workspaceId: string): Promise<GithubWebhookRow | null> {
  const row = (await queryOne<GithubWebhookRow>(
    `SELECT workspace_id, repo_owner, repo_name, webhook_id, encrypted_webhook_secret, last_webhook_at,
            created_at
       FROM workspace_github_webhooks
      WHERE workspace_id = $1 AND authority_status = 'active'`,
    [workspaceId],
  )) ?? null;
  if (row) assertGithubRepositoryIdentity(row.repo_owner, row.repo_name);
  return row;
}

router.use('/:id/github', requireWorkspaceMember());

/**
 * @swagger
 * /api/workspaces/{id}/github:
 *   get:
 *     tags: [GitHub]
 *     summary: Get workspace GitHub repository status
 *     operationId: getWorkspaceGithubRepositoryStatus
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workspace GitHub wiring is user-owned integration metadata and should require authenticated access."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: OK }
 */
router.get('/:id/github', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requireWorkspace(String(req.params.id));
    const workspaceId = String(req.params.id);
    const authority = await getGithubRepositoryAuthority(workspaceId);
    if (!authority) { res.json({ connected: false, credentialSource: null }); return; }
    const appBinding = authority.source === 'github-app-installation' ? await getWorkspaceGithubAppBinding(workspaceId) : null;
    const appCapable = appBinding ? githubAppBindingHasVerifiedProfile(appBinding) : true;
    const legacy = authority.source === 'pat-oauth-fallback' ? await getGithubRow(workspaceId) : null;
    const connected = authority.status === 'active' && appCapable
      && (authority.source === 'github-app-installation' ? authority.webhookConfigured : Boolean(legacy));
    res.json({
      connected,
      credentialSource: authority.source,
      repoOwner: authority.owner,
      repoName: authority.name,
      repositoryId: authority.repositoryId,
      installationId: authority.installationId,
      webhookId: legacy?.webhook_id ?? null,
      webhookUrl: authority.source === 'github-app-installation'
        ? process.env.RORCA_GITHUB_WEBHOOK_URL?.trim() || 'https://hooks.rorca.ai/api/webhooks/github'
        : `${getBackendBaseUrl(req)}/api/webhooks/github`,
      lastWebhookAt: authority.lastWebhookAt,
      webhookConfigured: authority.webhookConfigured,
      signedDeliveryObserved: authority.signedDeliveryObserved,
      connectedAt: authority.connectedAt,
      nextAction: connected ? null : 'Provider capability revalidation is required; fallback is blocked while an App binding exists.',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/account:
 *   get:
 *     tags: [GitHub]
 *     summary: Get stored GitHub credential status for a workspace
 *     operationId: getWorkspaceGithubAccountStatus
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workspace-scoped GitHub credential metadata is user-owned integration state and should require authenticated access."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: OK }
 */
router.get('/:id/github/account', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = String(req.params.id);
    await requireWorkspace(workspaceId);
    const appBinding = await getWorkspaceGithubAppBinding(workspaceId);
    if (appBinding) {
      const connected = githubAppBindingHasVerifiedProfile(appBinding);
      res.json({
        connected,
        source: 'github-app-installation',
        username: `${appBinding.appSlug}[bot]`,
        connectedAt: null,
        scopes: [],
        installationId: appBinding.installationId,
        repositoryId: appBinding.repositoryId,
        repository: `${appBinding.repoOwner}/${appBinding.repoName}`,
        nextAction: connected ? null : 'Administrator revalidation is required; PAT fallback is blocked while this App binding exists.',
      });
      return;
    }
    const resolved = await resolveWorkspaceGitHubToken(workspaceId, { purpose: 'repository-read' });
    if (!resolved) {
      res.json({ connected: false });
      return;
    }

    const validated = await validateGitHubToken(resolved.token);
    await markTokenValidated(workspaceId, 'github', resolved.source === 'workspace-oauth' ? 'oauth_access' : 'api_key').catch(() => {});

    const tokenMeta = await queryOne<{ created_at: string }>(
      `SELECT created_at
         FROM integration_tokens
        WHERE workspace_id = $1 AND provider = 'github' AND token_type IN ('api_key', 'oauth_access') AND revoked_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 1`,
      [workspaceId],
    ).catch(() => undefined);

    res.json({
      connected: true,
      username: validated.username,
      avatarUrl: validated.avatarUrl,
      connectedAt: tokenMeta?.created_at ?? null,
      scopes: validated.scopes,
      source: resolved.source,
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.json({ connected: false, error: err.message });
      return;
    }
    next(err);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/connect:
 *   post:
 *     tags: [GitHub]
 *     summary: Connect a workspace to a GitHub repository using a PAT
 *     operationId: connectWorkspaceGithubPatFallback
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "PAT fallback connection grants repository authority and is an explicit administrator-only migration operation excluded from MCP."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Connected }
 */
router.post('/:id/github/connect', requireProviderMutationAuthority, requireWorkspaceAdmin(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requireWorkspace(String(req.params.id));
    const repoOwner = String(req.body.repoOwner || '').trim();
    const repoName = String(req.body.repoName || '').trim();
    const githubToken = String(req.body.githubToken || '').trim();

    if (!repoOwner || !repoName || !githubToken) throw new ValidationError('repoOwner, repoName, and githubToken are required');
    assertGithubRepositoryIdentity(repoOwner, repoName);
    if (await getWorkspaceGithubAppBinding(String(req.params.id))) {
      throw new ValidationError('Legacy PAT/webhook authority cannot be connected while a current GitHub App binding exists');
    }

    const validated = await validateGitHubToken(githubToken);
    const repositoryResponse = await fetchGithubWithTimeout(fetch, githubRepoApiUrl(repoOwner, repoName), { headers: buildGitHubHeaders(githubToken) });
    if (!repositoryResponse.ok) throw new ValidationError(`PAT cannot access the exact repository: ${repositoryResponse.status}`);
    const providerRepository = await repositoryResponse.json() as { full_name?: string };
    if (providerRepository.full_name?.toLowerCase() !== `${repoOwner}/${repoName}`.toLowerCase()) {
      throw new ValidationError('GitHub returned a different repository identity');
    }
    await storeOAuthToken(String(req.params.id), 'github', {
      token: githubToken,
      tokenType: 'api_key',
      scopes: validated.scopes,
    });

    const webhookSecret = crypto.randomBytes(32).toString('hex');
    const encryptedWebhookSecret = encryptToken(webhookSecret);
    const webhookUrl = `${getBackendBaseUrl(req)}/api/webhooks/github`;
    const manualSetupUrl = `https://github.com/${repoOwner}/${repoName}/settings/hooks/new`;

    let webhookId: number | null = null;
    let error: string | undefined;

    try {
      webhookId = await createWebhook(repoOwner, repoName, githubToken, webhookUrl, webhookSecret);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create webhook automatically';
    }

    await execute(
      `INSERT INTO workspace_github_webhooks
         (workspace_id, repo_owner, repo_name, webhook_id, encrypted_webhook_secret)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id) DO UPDATE SET
         repo_owner = EXCLUDED.repo_owner,
         repo_name = EXCLUDED.repo_name,
         webhook_id = EXCLUDED.webhook_id,
         encrypted_webhook_secret = EXCLUDED.encrypted_webhook_secret,
         authority_status = 'active',
         retired_at = NULL,
         retirement_reason = NULL,
         webhook_secret_revoked_at = NULL`,
      [String(req.params.id), repoOwner, repoName, webhookId, encryptedWebhookSecret],
    );
    await execute(
      `INSERT INTO github_repository_configs (workspace_id, repo_owner, repo_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id) DO UPDATE SET repo_owner = EXCLUDED.repo_owner,
         repo_name = EXCLUDED.repo_name, updated_at = NOW()`,
      [String(req.params.id), repoOwner, repoName],
    );

    res.json({
      connected: true,
      repoOwner,
      repoName,
      webhookId,
      connectedAt: new Date().toISOString(),
      error,
      manualSetupUrl: error ? manualSetupUrl : undefined,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/test-connection:
 *   post:
 *     tags: [GitHub]
 *     summary: Test the canonical workspace GitHub credential
 *     operationId: testWorkspaceGithubConnection
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workspace members may verify only the credential already bound to their canonical repository."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Credential validation result }
 *       401: { description: Authentication required }
 */
router.post('/:id/github/test-connection', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = String(req.params.id);
    await requireWorkspace(workspaceId);
    const appBinding = await getWorkspaceGithubAppBinding(workspaceId);
    const resolved = await resolveWorkspaceGitHubToken(workspaceId, {
      ...(appBinding ? { repository: { owner: appBinding.repoOwner, name: appBinding.repoName } } : {}),
      purpose: 'repository-read',
    });
    if (!resolved) throw new ValidationError('No GitHub token configured for this workspace');
    if (resolved.source === 'github-app-installation') {
      res.json({ valid: true, username: `${appBinding!.appSlug}[bot]`, source: resolved.source });
      return;
    }
    const validated = await validateGitHubToken(resolved.token);
    await markTokenValidated(workspaceId, 'github', resolved.source === 'workspace-oauth' ? 'oauth_access' : 'api_key').catch(() => {});
    res.json({ valid: true, username: validated.username, source: resolved.source });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.json({ valid: false, error: err.message });
      return;
    }
    next(err);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/disconnect-oauth:
 *   post:
 *     tags: [GitHub]
 *     summary: Revoke the workspace OAuth credential
 *     operationId: disconnectWorkspaceGithubOauth
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Credential revocation changes workspace authority and requires an administrator."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: OAuth credential revoked }
 *       403: { description: Workspace admin required }
 */
router.post('/:id/github/disconnect-oauth', requireProviderMutationAuthority, requireWorkspaceAdmin(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requireWorkspace(String(req.params.id));
    await revokeToken(String(req.params.id), 'github');
    res.json({ disconnected: true });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/disconnect:
 *   post:
 *     tags: [GitHub]
 *     summary: Disconnect a legacy repository webhook using an explicit token
 *     operationId: disconnectWorkspaceGithubLegacyWebhook
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Legacy webhook removal changes repository authority and requires an administrator."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [githubToken]
 *             properties:
 *               githubToken: { type: string, minLength: 1, writeOnly: true }
 *     responses:
 *       200: { description: Legacy webhook disconnected }
 *       403: { description: Workspace admin required }
 */
router.post('/:id/github/disconnect', requireProviderMutationAuthority, requireWorkspaceAdmin(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requireWorkspace(String(req.params.id));
    const row = await getGithubRow(String(req.params.id));
    if (!row) {
      res.json({ disconnected: true });
      return;
    }

    const bodyToken = String(req.body.githubToken || '').trim();
    const resolved = bodyToken
      ? { token: bodyToken }
      : await resolveWorkspaceGitHubToken(String(req.params.id), { purpose: 'repository-read' });

    if (row.webhook_id && !resolved?.token) {
      throw new ValidationError('GitHub token required to remove the configured webhook');
    }

    if (row.webhook_id && resolved?.token) {
      await deleteWebhook(row.repo_owner, row.repo_name, row.webhook_id, resolved.token);
    }

    await execute('DELETE FROM workspace_github_webhooks WHERE workspace_id = $1', [String(req.params.id)]);
    res.json({ disconnected: true });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/github:
 *   delete:
 *     tags: [GitHub]
 *     summary: Disable current workspace GitHub authority
 *     operationId: disconnectWorkspaceGithub
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Disabling canonical GitHub authority is an explicit administrator action."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Current authority disabled }
 *       403: { description: Workspace admin required }
 */
router.delete('/:id/github', requireProviderMutationAuthority, requireWorkspaceAdmin(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = String(req.params.id);
    await requireWorkspace(workspaceId);
    const appBinding = await getWorkspaceGithubAppBinding(workspaceId);
    const row = await getGithubRow(workspaceId);
    if (appBinding) {
      await execute(
        `UPDATE github_app_workspace_bindings
            SET status = 'disabled', validation_error_code = 'operator_disabled', status_changed_at = NOW()
          WHERE workspace_id = $1 AND status IN ('active', 'invalid')`,
        [workspaceId],
      );
      await execute(
        `INSERT INTO wal_events (event_type, workspace_id, actor, payload)
         VALUES ('github_app_repository_binding_disabled', $1, $2, $3::jsonb)`,
        [workspaceId, req.user?.email || req.user?.id || 'operator', JSON.stringify({ bindingId: appBinding.bindingId, installationId: appBinding.installationId, repositoryId: appBinding.repositoryId })],
      );
    } else {
      const resolved = await resolveWorkspaceGitHubToken(workspaceId, { purpose: 'repository-read' });
      if (row?.webhook_id && resolved?.token) {
        await deleteWebhook(row.repo_owner, row.repo_name, row.webhook_id, resolved.token).catch(() => {});
      }
    }

    if (!appBinding) await execute('DELETE FROM workspace_github_webhooks WHERE workspace_id = $1', [workspaceId]);
    await revokeToken(workspaceId, 'github');
    res.json({ disconnected: true, source: appBinding ? 'github-app-installation' : 'pat-oauth-fallback' });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/auto-pr:
 *   put:
 *     tags: [GitHub]
 *     summary: Legacy repository-level Auto-PR settings are retired
 *     operationId: updateWorkspaceGithubAutoPr
 *     deprecated: true
 *     x-rorca-tier: admin
 *     x-rorca-mcp: false
 *     x-rorca-rationale: "Compatibility endpoint is hard-disabled; immutable per-run release strategy is the only PR creation authority."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       409: { description: Retired; choose pr or draft-pr on the pipeline run }
 */
router.put('/:id/github/auto-pr', requireWorkspaceAdmin(), async (_req: Request, _res: Response, next: NextFunction) => {
  // Compatibility only. PR creation is selected per run and frozen in the
  // immutable release intent; repository-level Auto-PR settings are retired.
  next(new ConflictError('Legacy Auto-PR settings are retired; choose pr or draft-pr for each pipeline run'));
});

/**
 * @swagger
 * /api/workspaces/{id}/github/workflow-config:
 *   get:
 *     tags: [GitHub]
 *     summary: Legacy workflow dispatch configuration is retired
 *     operationId: getWorkspaceGithubWorkflowConfig
 *     deprecated: true
 *     x-rorca-mcp: false
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       409: { description: Workflow dispatch configuration is retired }
 */
router.get('/:id/github/workflow-config', async (_req: Request, _res: Response, next: NextFunction) => {
  next(new ConflictError('GitHub workflow dispatch configuration is retired and unavailable'));
});

/**
 * @swagger
 * /api/workspaces/{id}/github/workflow-config:
 *   put:
 *     tags: [GitHub]
 *     summary: Legacy workflow dispatch configuration is retired
 *     operationId: updateWorkspaceGithubWorkflowConfig
 *     deprecated: true
 *     x-rorca-tier: admin
 *     x-rorca-mcp: false
 *     x-rorca-rationale: "Compatibility endpoint is hard-disabled and cannot persist or dispatch workflows."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       409: { description: Workflow dispatch configuration is retired }
 */
router.put('/:id/github/workflow-config', requireWorkspaceAdmin(), async (_req: Request, _res: Response, next: NextFunction) => {
  next(new ConflictError('GitHub workflow dispatch configuration is retired and unavailable'));
});

/**
 * @swagger
 * /api/workspaces/{id}/github/workflows:
 *   get:
 *     tags: [GitHub]
 *     summary: List GitHub Actions workflows for the connected repository
 *     operationId: listWorkspaceGithubWorkflows
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workflow discovery is read-only repository diagnostics and requires workspace access."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: OK }
 */
router.get('/:id/github/workflows', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requireWorkspace(String(req.params.id));
    const authority = await getGithubRepositoryAuthority(String(req.params.id), { requireActive: true });
    if (!authority) throw new ValidationError('No GitHub repository connected for this workspace');

    const resolved = await resolveWorkspaceGitHubToken(String(req.params.id), {
      repository: { owner: authority.owner, name: authority.name }, purpose: 'workflow-read',
    });
    if (!resolved) throw new ValidationError('No GitHub token configured for this workspace');

    const response = await fetchGithubWithTimeout(fetch, githubRepoApiUrl(authority.owner, authority.name, '/actions/workflows'), {
      headers: buildGitHubHeaders(resolved.token),
    });

    if (!response.ok) {
      const safe = extractGithubProviderError(response, 'GITHUB_WORKFLOW_LIST_FAILED');
      throw new ValidationError(safe.message, { providerStatus: safe.providerStatus, providerRequestId: safe.requestId });
    }

    const data = await response.json() as { workflows?: Array<Record<string, unknown>> };
    res.json({ workflows: (data.workflows || []).map(mapWorkflow) });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/webhook-ping:
 *   post:
 *     tags: [GitHub]
 *     summary: Send a provider-side ping event to the configured GitHub webhook
 *     operationId: pingWorkspaceGithubWebhook
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Webhook ping performs a real provider POST and requires explicit operator capability plus workspace administration; it is excluded from MCP."
 *     x-rorca-mcp: false
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Ping sent }
 */
router.post('/:id/github/webhook-ping', requireProviderMutationAuthority, requireWorkspaceAdmin(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requireWorkspace(String(req.params.id));
    const row = await getGithubRow(String(req.params.id));
    if (!row) {
      throw new ValidationError('No GitHub repository connected for this workspace');
    }
    if (!row.webhook_id) {
      throw new ValidationError('No GitHub webhook id is configured for this workspace');
    }

    const resolved = await resolveWorkspaceGitHubToken(String(req.params.id), {
      repository: { owner: row.repo_owner, name: row.repo_name }, purpose: 'repository-read',
    });
    if (!resolved) throw new ValidationError('No GitHub token configured for this workspace');

    const response = await fetchGithubWithTimeout(fetch, githubRepoApiUrl(row.repo_owner, row.repo_name, `/hooks/${row.webhook_id}/pings`), {
      method: 'POST',
      headers: buildGitHubHeaders(resolved.token),
    });

    if (!response.ok && response.status !== 204) {
      const safe = extractGithubProviderError(response, 'GITHUB_WEBHOOK_PING_FAILED');
      throw new ValidationError(safe.message, { providerStatus: safe.providerStatus, providerRequestId: safe.requestId });
    }

    res.json({ ok: true, pingedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/pr-template-preview:
 *   post:
 *     tags: [GitHub]
 *     summary: Render a PR template preview using the latest local run where available
 *     operationId: previewWorkspaceGithubPrTemplate
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Template preview reads local workspace run/spec metadata and returns user-owned derived content."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Preview rendered }
 */
router.post('/:id/github/pr-template-preview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspace = await requireWorkspace(String(req.params.id));
    const template = typeof req.body?.template === 'string' ? req.body.template : '';
    const preview = await buildLatestPrTemplatePreview(workspace);
    res.json({
      rendered: renderPrTemplate(template, preview.data),
      source: preview.source,
      run: preview.runSummary,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/actions-yaml:
 *   get:
 *     tags: [GitHub]
 *     summary: Autonomous GitHub Actions workflow generation is retired
 *     operationId: getWorkspaceGithubActionsYaml
 *     deprecated: true
 *     x-rorca-mcp: false
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       409: { description: Autonomous workflow generation is retired }
 */
router.get('/:id/github/actions-yaml', async (_req: Request, _res: Response, next: NextFunction) => {
  next(new ConflictError('Autonomous GitHub Actions workflow generation is retired and unavailable'));
});

/**
 * @swagger
 * /api/workspaces/{id}/github/dispatch:
 *   post:
 *     tags: [GitHub]
 *     summary: Workflow dispatch is hard disabled
 *     operationId: dispatchWorkspaceGithubWorkflow
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "Compatibility endpoint returns conflict without resolving credentials or invoking GitHub."
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workflow_id, ref]
 *             properties:
 *               workflow_id: { type: string, minLength: 1, maxLength: 255 }
 *               ref: { type: string, minLength: 1, maxLength: 255 }
 *               inputs: { type: object, additionalProperties: true }
 *     responses:
 *       409: { description: Workflow dispatch is hard disabled; deployment/workflow authority is not exposed by operator HTTP routes }
 */
router.post('/:id/github/dispatch', requireWorkspaceAdmin(), async (_req: Request, _res: Response, next: NextFunction) => {
  // Intentionally no credential resolution and no provider call. Workflow and
  // deployment actuation are outside the release contract and remain disabled.
  next(new ConflictError('GitHub workflow dispatch is hard disabled'));
});

export function verifyWebhookSignature(rawBody: Buffer | string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const expected = `sha256=${digest}`;
  const provided = signatureHeader.trim();
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

export default router;
