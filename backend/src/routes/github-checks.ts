/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, type Request, type Response } from 'express';
import { queryOne } from '../db/index';
import { postCommitStatus, MANUAL_CHECK_NAME, type CheckState } from '../lib/github-checks';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';
import { handleRouteError } from '../lib/async-handler';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from '../lib/errors';
import { requireWorkspaceAdmin } from '../lib/auth-utils';
import { requireGithubRepositoryAuthority, githubRepoApiUrl } from '../lib/github-repository-authority';
import { resolveWorkspaceGitHubToken } from '../lib/github-token-resolver';
import { fetchGithubWithTimeout } from '../lib/github-app-credential-provider';

const router = Router();
const FULL_SHA = /^[0-9a-f]{40}$/;

interface RunBindingRow {
  id: number;
  workspace_id: string;
  pr_number: number | null;
  branch_name: string | null;
}

/**
 * @swagger
 * /api/github/checks/{sha}:
 *   post:
 *     tags: [GitHub]
 *     summary: Post a non-governing manual status for a canonically bound run and PR
 *     operationId: updateGithubManualCheckStatus
 *     description: Admin-only HTTP operation. The fixed manual context is excluded from autonomous reviewed-delivery evidence and this operation is intentionally non-MCP.
 *     parameters:
 *       - in: path
 *         name: sha
 *         required: true
 *         schema: { type: string, pattern: '^[0-9a-f]{40}$' }
 *         description: Full immutable Git commit object id
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [state, workspaceId, runId]
 *             properties:
 *               state: { type: string, enum: [pending, success, failure, error] }
 *               description: { type: string, maxLength: 140 }
 *               workspaceId: { type: string }
 *               runId: { type: integer, minimum: 1 }
 *     responses:
 *       200: { description: Non-governing manual status posted }
 *       400: { description: Invalid full SHA, state, workspace, or run identity }
 *       403: { description: Workspace administrator authority required }
 *       404: { description: Canonical repository or run/PR binding not found }
 *       409: { description: Provider PR identity or immutable head SHA mismatch }
 *       422: { description: Exact repository credential unavailable }
 *       502: { description: Failed to post status to GitHub }
 */
router.post('/:sha', requireWorkspaceAdmin(), async (req: Request, res: Response) => {
  try {
    const sha = String(req.params.sha || '').toLowerCase();
    const { state, description, workspaceId } = req.body ?? {};
    const runId = Number(req.body?.runId);
    if (!FULL_SHA.test(sha)) throw new ValidationError('Invalid SHA: a full 40-hex Git/GitHub object id is required');
    if (!['pending', 'success', 'failure', 'error'].includes(String(state))) throw new ValidationError('Invalid state. Must be pending, success, failure, or error');
    if (!workspaceId || typeof workspaceId !== 'string') throw new ValidationError('workspaceId is required');
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new ValidationError('runId must be a positive safe integer');

    const run = await queryOne<RunBindingRow>(
      `SELECT id, workspace_id, pr_number, branch_name
         FROM pipeline_runs
        WHERE id = $1 AND workspace_id = $2`,
      [runId, workspaceId],
    );
    if (!run) throw new NotFoundError('Canonical workspace pipeline run', String(runId));
    if (!run.pr_number || !run.branch_name) throw new UnprocessableError('Run has no canonical PR and branch binding', 'PR_BINDING_REQUIRED');

    const authority = await requireGithubRepositoryAuthority(workspaceId);
    const resolved = await resolveWorkspaceGitHubToken(workspaceId, {
      repository: { owner: authority.owner, name: authority.name },
      purpose: 'pulls-read',
    });
    if (!resolved) throw new UnprocessableError('Exact-repository GitHub credential is unavailable', 'GITHUB_CREDENTIAL_UNAVAILABLE');

    const response = await fetchGithubWithTimeout(fetch, githubRepoApiUrl(authority.owner, authority.name, `/pulls/${run.pr_number}`), {
      headers: {
        Authorization: `Bearer ${resolved.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Rorca-OSS',
      },
    });
    if (!response.ok) throw new UnprocessableError(`GitHub PR verification failed with status ${response.status}`, 'GITHUB_PR_VERIFICATION_FAILED');
    const pr = await response.json() as {
      number?: number;
      head?: { sha?: string; ref?: string; repo?: { full_name?: string } };
    };
    if (pr.number !== run.pr_number || pr.head?.ref !== run.branch_name
      || pr.head?.repo?.full_name?.toLowerCase() !== `${authority.owner}/${authority.name}`.toLowerCase()) {
      throw new ConflictError('Provider pull request does not match the canonical workspace run/repository binding');
    }
    if (pr.head.sha?.toLowerCase() !== sha) throw new ConflictError('Manual status SHA is not the current immutable head of the canonical pull request');

    const desc = typeof description === 'string' && description.trim() ? description.trim().slice(0, 140) : `Manual ${state} via Rorca`;
    const posted = await postCommitStatus(authority.owner, authority.name, sha, state as CheckState, desc, undefined, workspaceId, MANUAL_CHECK_NAME);
    if (!posted) { res.status(502).json({ error: 'Failed to post status to GitHub' }); return; }

    const walEvent = await queryOne<WalEvent>(
      `INSERT INTO wal_events (event_type, workspace_id, actor, payload)
       VALUES ('github_check_manual', $1, $2, $3) RETURNING *`,
      [workspaceId, req.user?.email || req.user?.id || 'operator', JSON.stringify({
        runId, prNumber: run.pr_number, sha, state, description: desc, context: MANUAL_CHECK_NAME,
        governingEvidenceEligible: false,
      })],
    );
    if (walEvent) broadcastAll(walEvent);
    res.json({ ok: true, runId, prNumber: run.pr_number, sha, state, context: MANUAL_CHECK_NAME, description: desc, governingEvidenceEligible: false });
  } catch (error) {
    handleRouteError(res, error, '[Checks] Manual update');
  }
});

export default router;
