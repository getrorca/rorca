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
import { NotFoundError, ValidationError } from '../lib/errors';
import { storeOAuthToken, revokeToken, markTokenValidated } from '../lib/integration-vault';
import { resolveWorkspaceGitHubToken } from '../lib/github-token-resolver';
import { getWorkspaceGithubAppBinding } from '../lib/github-app-credential-provider';
import { renderPrTemplate, SAMPLE_PR_TEMPLATE_DATA, type PrTemplateData } from '../lib/github/pr-template';

const router = Router();

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
  auto_pr_enabled: boolean;
  auto_pr_target_branch: string;
  auto_pr_reviewers: string[] | string;
  workflow_config?: Record<string, unknown> | string | null;
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

function parseReviewers(value: GithubWebhookRow['auto_pr_reviewers']): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseWorkflowConfig(value: GithubWebhookRow['workflow_config']): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return value as Record<string, unknown>;
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
  const response = await fetch('https://api.github.com/user', {
    headers: buildGitHubHeaders(token),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new ValidationError(`GitHub token invalid: ${response.status} ${text || response.statusText}`);
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
      diffStats: 'Diff stats are attached when an auto-PR is created.',
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
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks`, {
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
    const hooksResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks`, {
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
    const text = await response.text();
    throw new ValidationError(`Failed to create webhook: ${response.status} ${text || response.statusText}`);
  }

  const data = await response.json() as { id?: number };
  if (!data.id) {
    throw new ValidationError('GitHub did not return a webhook id');
  }
  return data.id;
}

async function deleteWebhook(owner: string, repo: string, webhookId: number, token: string): Promise<void> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks/${webhookId}`, {
    method: 'DELETE',
    headers: buildGitHubHeaders(token),
  });

  if (!response.ok && response.status !== 404) {
    const text = await response.text();
    throw new ValidationError(`Failed to delete webhook: ${response.status} ${text || response.statusText}`);
  }
}

async function getGithubRow(workspaceId: string): Promise<GithubWebhookRow | null> {
  return (await queryOne<GithubWebhookRow>(
    `SELECT workspace_id, repo_owner, repo_name, webhook_id, encrypted_webhook_secret, last_webhook_at,
            auto_pr_enabled, auto_pr_target_branch, auto_pr_reviewers, workflow_config, created_at
       FROM workspace_github_webhooks
      WHERE workspace_id = $1`,
    [workspaceId],
  )) ?? null;
}

router.use('/:id/github', requireWorkspaceMember());

/**
 * @swagger
 * /api/workspaces/{id}/github:
 *   get:
 *     tags: [GitHub]
 *     summary: Get workspace GitHub repository status
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workspace GitHub wiring is user-owned integration metadata and should require authenticated access."
 *     responses:
 *       200: { description: OK }
 */
router.get('/:id/github', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requireWorkspace(String(req.params.id));
    const workspaceId = String(req.params.id);
    const appBinding = await getWorkspaceGithubAppBinding(workspaceId);
    const row = await getGithubRow(workspaceId);
    if (appBinding) {
      const connected = appBinding.status === 'active' && appBinding.installationStatus === 'active' && appBinding.registrationStatus === 'active';
      res.json({
        connected,
        credentialSource: 'github-app-installation',
        repoOwner: appBinding.repoOwner,
        repoName: appBinding.repoName,
        repositoryId: appBinding.repositoryId,
        installationId: appBinding.installationId,
        webhookId: null,
        webhookUrl: process.env.RORCA_GITHUB_WEBHOOK_URL?.trim() || 'https://hooks.rorca.ai/api/webhooks/github',
        lastWebhookAt: appBinding.lastWebhookAt,
        connectedAt: null,
        nextAction: connected ? null : 'Administrator revalidation is required; fallback is blocked while this App binding exists.',
        autoPr: row ? { enabled: row.auto_pr_enabled, targetBranch: row.auto_pr_target_branch, reviewers: parseReviewers(row.auto_pr_reviewers) } : { enabled: false, targetBranch: 'main', reviewers: [] },
      });
      return;
    }
    if (!row) {
      res.json({ connected: false, credentialSource: null });
      return;
    }

    res.json({
      connected: true,
      credentialSource: 'pat-oauth-fallback',
      repoOwner: row.repo_owner,
      repoName: row.repo_name,
      webhookId: row.webhook_id,
      webhookUrl: `${getBackendBaseUrl(req)}/api/webhooks/github`,
      lastWebhookAt: row.last_webhook_at,
      connectedAt: row.created_at,
      autoPr: {
        enabled: row.auto_pr_enabled,
        targetBranch: row.auto_pr_target_branch,
        reviewers: parseReviewers(row.auto_pr_reviewers),
      },
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
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workspace-scoped GitHub credential metadata is user-owned integration state and should require authenticated access."
 *     responses:
 *       200: { description: OK }
 */
router.get('/:id/github/account', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = String(req.params.id);
    await requireWorkspace(workspaceId);
    const appBinding = await getWorkspaceGithubAppBinding(workspaceId);
    if (appBinding) {
      const connected = appBinding.status === 'active' && appBinding.installationStatus === 'active' && appBinding.registrationStatus === 'active';
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
    const resolved = await resolveWorkspaceGitHubToken(workspaceId, { allowLegacyGlobal: true });
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
 *     x-rorca-tier: admin
 *     x-rorca-rationale: "PAT fallback connection grants repository authority and is an explicit administrator-only migration operation excluded from MCP."
 *     responses:
 *       200: { description: Connected }
 */
router.post('/:id/github/connect', requireWorkspaceAdmin(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requireWorkspace(String(req.params.id));
    const repoOwner = String(req.body.repoOwner || '').trim();
    const repoName = String(req.body.repoName || '').trim();
    const githubToken = String(req.body.githubToken || '').trim();

    if (!repoOwner || !repoName || !githubToken) {
      throw new ValidationError('repoOwner, repoName, and githubToken are required');
    }

    const validated = await validateGitHubToken(githubToken);
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
         encrypted_webhook_secret = EXCLUDED.encrypted_webhook_secret`,
      [String(req.params.id), repoOwner, repoName, webhookId, encryptedWebhookSecret],
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

router.post('/:id/github/test-connection', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaceId = String(req.params.id);
    await requireWorkspace(workspaceId);
    const appBinding = await getWorkspaceGithubAppBinding(workspaceId);
    const resolved = await resolveWorkspaceGitHubToken(workspaceId, {
      ...(appBinding ? { repository: { owner: appBinding.repoOwner, name: appBinding.repoName } } : {}),
      purpose: 'routine', allowLegacyGlobal: true, allowEnvFallback: true,
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

router.post('/:id/github/disconnect-oauth', requireWorkspaceAdmin(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requireWorkspace(String(req.params.id));
    await revokeToken(String(req.params.id), 'github');
    res.json({ disconnected: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/github/disconnect', requireWorkspaceAdmin(), async (req: Request, res: Response, next: NextFunction) => {
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
      : await resolveWorkspaceGitHubToken(String(req.params.id), { allowLegacyGlobal: true, allowEnvFallback: true });

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

router.delete('/:id/github', requireWorkspaceAdmin(), async (req: Request, res: Response, next: NextFunction) => {
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
      const resolved = await resolveWorkspaceGitHubToken(workspaceId, { allowLegacyGlobal: true, allowEnvFallback: true });
      if (row?.webhook_id && resolved?.token) {
        await deleteWebhook(row.repo_owner, row.repo_name, row.webhook_id, resolved.token).catch(() => {});
      }
    }

    await execute('DELETE FROM workspace_github_webhooks WHERE workspace_id = $1', [workspaceId]);
    await revokeToken(workspaceId, 'github');
    res.json({ disconnected: true, source: appBinding ? 'github-app-installation' : 'pat-oauth-fallback' });
  } catch (err) {
    next(err);
  }
});

router.put('/:id/github/auto-pr', requireWorkspaceAdmin(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requireWorkspace(String(req.params.id));
    const enabled = !!req.body.enabled;
    const targetBranch = String(req.body.targetBranch || 'main').trim() || 'main';
    const reviewers = Array.isArray(req.body.reviewers)
      ? req.body.reviewers.filter((value: unknown): value is string => typeof value === 'string').map((value: string) => value.trim()).filter(Boolean)
      : [];

    const row = await getGithubRow(String(req.params.id));
    if (!row) {
      throw new ValidationError('No GitHub repository connected for this workspace');
    }

    await execute(
      `UPDATE workspace_github_webhooks
          SET auto_pr_enabled = $2,
              auto_pr_target_branch = $3,
              auto_pr_reviewers = $4::jsonb
        WHERE workspace_id = $1`,
      [String(req.params.id), enabled, targetBranch, JSON.stringify(reviewers)],
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/github/workflow-config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requireWorkspace(String(req.params.id));
    const row = await getGithubRow(String(req.params.id));
    res.json({ workflowConfig: parseWorkflowConfig(row?.workflow_config ?? null) });
  } catch (err) {
    next(err);
  }
});

router.put('/:id/github/workflow-config', requireWorkspaceAdmin(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requireWorkspace(String(req.params.id));
    const row = await getGithubRow(String(req.params.id));
    if (!row) {
      throw new ValidationError('No GitHub repository connected for this workspace');
    }

    const body = req.body ?? {};
    const workflowConfig = typeof body.workflowConfig === 'object' && body.workflowConfig !== null && !Array.isArray(body.workflowConfig)
      ? body.workflowConfig
      : body;
    if (typeof workflowConfig !== 'object' || Array.isArray(workflowConfig)) {
      throw new ValidationError('workflow config body must be an object');
    }

    await execute(
      'UPDATE workspace_github_webhooks SET workflow_config = $2::jsonb WHERE workspace_id = $1',
      [String(req.params.id), JSON.stringify(workflowConfig)],
    );

    res.json({ ok: true, workflowConfig });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/workspaces/{id}/github/workflows:
 *   get:
 *     tags: [GitHub]
 *     summary: List GitHub Actions workflows for the connected repository
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Workflow discovery reads user-owned GitHub integration metadata and requires workspace access."
 *     responses:
 *       200: { description: OK }
 */
router.get('/:id/github/workflows', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requireWorkspace(String(req.params.id));
    const row = await getGithubRow(String(req.params.id));
    if (!row) {
      throw new ValidationError('No GitHub repository connected for this workspace');
    }

    const resolved = await resolveWorkspaceGitHubToken(String(req.params.id), { allowLegacyGlobal: true, allowEnvFallback: true });
    if (!resolved) {
      throw new ValidationError('No GitHub token configured for this workspace');
    }

    const response = await fetch(`https://api.github.com/repos/${row.repo_owner}/${row.repo_name}/actions/workflows`, {
      headers: buildGitHubHeaders(resolved.token),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new ValidationError(`Failed to list workflows: ${response.status} ${text || response.statusText}`);
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
 *     summary: Send a ping event to the configured GitHub webhook
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Webhook ping mutates only workspace-owned integration health state and requires workspace admin access."
 *     responses:
 *       200: { description: Ping sent }
 */
router.post('/:id/github/webhook-ping', requireWorkspaceAdmin(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requireWorkspace(String(req.params.id));
    const row = await getGithubRow(String(req.params.id));
    if (!row) {
      throw new ValidationError('No GitHub repository connected for this workspace');
    }
    if (!row.webhook_id) {
      throw new ValidationError('No GitHub webhook id is configured for this workspace');
    }

    const resolved = await resolveWorkspaceGitHubToken(String(req.params.id), { allowLegacyGlobal: true, allowEnvFallback: true });
    if (!resolved) {
      throw new ValidationError('No GitHub token configured for this workspace');
    }

    const response = await fetch(`https://api.github.com/repos/${row.repo_owner}/${row.repo_name}/hooks/${row.webhook_id}/pings`, {
      method: 'POST',
      headers: buildGitHubHeaders(resolved.token),
    });

    if (!response.ok && response.status !== 204) {
      const text = await response.text();
      throw new ValidationError(`Failed to ping webhook: ${response.status} ${text || response.statusText}`);
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
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Template preview reads local workspace run/spec metadata and returns user-owned derived content."
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

router.get('/:id/github/actions-yaml', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspace = await requireWorkspace(String(req.params.id));
    const yaml = `name: Rorca Pipeline

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  trigger-rorca:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Rorca run
        env:
          RORCA_API_URL: \${{ secrets.RORCA_API_URL }}
          RORCA_API_TOKEN: \${{ secrets.RORCA_API_TOKEN }}
          WORKSPACE_ID: \${{ secrets.WORKSPACE_ID }}
        run: |
          curl -fsSL -X POST "$RORCA_API_URL/api/pipeline/trigger" \
            -H "Authorization: Bearer $RORCA_API_TOKEN" \
            -H "Content-Type: application/json" \
            -d '{
              "workspaceId": "${workspace.id}",
              "specPath": "forge/specs/approved/your-spec.json",
              "triggerType": "scheduled"
            }'
`;
    res.type('application/x-yaml').send(yaml);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/github/dispatch', requireWorkspaceAdmin(), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await requireWorkspace(String(req.params.id));
    const row = await getGithubRow(String(req.params.id));
    if (!row) {
      throw new ValidationError('No GitHub repository connected for this workspace');
    }

    const resolved = await resolveWorkspaceGitHubToken(String(req.params.id), { allowLegacyGlobal: true, allowEnvFallback: true });
    if (!resolved) {
      throw new ValidationError('No GitHub token configured for this workspace');
    }

    const workflowId = String(req.body.workflow_id || '').trim();
    const ref = String(req.body.ref || 'main').trim() || 'main';
    const inputs = req.body.inputs && typeof req.body.inputs === 'object' && !Array.isArray(req.body.inputs)
      ? req.body.inputs
      : {};

    if (!workflowId) {
      throw new ValidationError('workflow_id is required');
    }

    const response = await fetch(
      `https://api.github.com/repos/${row.repo_owner}/${row.repo_name}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
      {
        method: 'POST',
        headers: buildGitHubHeaders(resolved.token),
        body: JSON.stringify({ ref, inputs }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new ValidationError(`Failed to dispatch workflow: ${response.status} ${text || response.statusText}`);
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
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
