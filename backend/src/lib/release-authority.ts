/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** One host-owned, restart-safe release and terminal closeout seam. */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { execute, query, queryOne, transaction } from '../db/index';
import { performMerge, type MergeResult } from './merge-handler';
import { type MergeResolutionPosture } from './merge-conflict-resolver';
import { type RunHostAuthority } from './run-host-authority';
import {
  getGithubRepositoryAuthority,
  githubRepoApiUrl,
  isFullGitObjectId,
} from './github-repository-authority';
import { fetchGithubWithTimeout } from './github-app-credential-provider';
import { githubRateLimiter } from './github-rate-limiter';
import { githubProviderError } from './github-provider-error';
import {
  persistTrustedWalEvent,
  relayTrustedWalEvent,
  type TrustedWalReference,
} from './trusted-wal';
import {
  revalidateRunReleaseIdentity,
  withGithubReleaseActuation,
  withRunReleaseLock,
  type RunReleaseIdentity,
} from './release-identity';

const FULL_SHA = /^[0-9a-f]{40}$/;
export type RunMergeStrategy = 'direct' | 'pr' | 'draft-pr' | 'branch-only';
export type RunReleaseStepStatus = 'pending' | 'processing' | 'completed' | 'not_required' | 'failed';
type StepStatus = RunReleaseStepStatus;

/** Pending and crash-left processing steps reconcile; terminal steps never repeat. */
export function shouldActuateReleaseStep(status: RunReleaseStepStatus | undefined): boolean {
  return status !== 'completed' && status !== 'not_required';
}

interface ReleaseIntentRow {
  run_id: number | string;
  workspace_id: string;
  spec_id: string;
  authorized_sha: string;
  branch_name: string;
  execution_workspace_path: string;
  execution_worktree_path: string;
  repository_owner: string | null;
  repository_name: string | null;
  repository_authority_source: 'github-app-installation' | 'pat-oauth-fallback' | null;
  repository_binding_id: string | null;
  repository_installation_id: number | string | null;
  repository_id: number | string | null;
  merge_strategy: RunMergeStrategy;
  auto_merge: boolean;
  external_send: boolean;
  identity_hash: string;
  status: 'pending' | 'processing' | 'completed' | 'blocked';
  step_state: Record<string, unknown> | string;
  merge_commit_sha: string | null;
  terminal_event_id: number | null;
}

export interface PrepareRunReleaseInput {
  hostAuthority: RunHostAuthority;
  mergeStrategy: RunMergeStrategy;
  autoMerge: boolean;
  externalSend: boolean;
}

export interface RunReleaseResult {
  runId: number;
  status: 'completed' | 'blocked';
  error?: string;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

function identityHash(identity: RunReleaseIdentity, input: PrepareRunReleaseInput): string {
  return crypto.createHash('sha256').update(stable({
    version: 1,
    ...identity,
    mergeStrategy: input.mergeStrategy,
    autoMerge: input.autoMerge,
    externalSend: input.externalSend,
    deploymentAllowed: false,
  })).digest('hex');
}

function steps(row: ReleaseIntentRow): Record<string, StepStatus> {
  const parsed = typeof row.step_state === 'string' ? JSON.parse(row.step_state) as unknown : row.step_state;
  return parsed && !Array.isArray(parsed) && typeof parsed === 'object'
    ? parsed as Record<string, StepStatus>
    : {};
}

function identity(row: ReleaseIntentRow): RunReleaseIdentity {
  return {
    runId: Number(row.run_id),
    workspaceId: row.workspace_id,
    specId: row.spec_id,
    authorizedSha: row.authorized_sha.toLowerCase(),
    branchName: row.branch_name,
    workspaceRealpath: row.execution_workspace_path,
    worktreeRealpath: row.execution_worktree_path,
    repository: row.repository_owner && row.repository_name && row.repository_authority_source
      ? {
        owner: row.repository_owner,
        name: row.repository_name,
        source: row.repository_authority_source,
        bindingId: row.repository_binding_id,
        installationId: row.repository_installation_id == null ? null : Number(row.repository_installation_id),
        repositoryId: row.repository_id == null ? null : Number(row.repository_id),
      }
      : null,
  };
}

async function loadIntent(runId: number): Promise<ReleaseIntentRow | undefined> {
  return queryOne<ReleaseIntentRow>('SELECT * FROM pipeline_run_release_intents WHERE run_id = $1', [runId]);
}

async function setStep(runId: number, step: string, status: StepStatus, extraSql = '', values: unknown[] = []): Promise<void> {
  await execute(`
    UPDATE pipeline_run_release_intents
       SET status = CASE WHEN status = 'pending' THEN 'processing' ELSE status END,
           step_state = jsonb_set(step_state, ARRAY[$2], to_jsonb($3::text), TRUE),
           updated_at = NOW()${extraSql}
     WHERE run_id = $1
  `, [runId, step, status, ...values]);
}

function needsRepository(input: PrepareRunReleaseInput): boolean {
  if (!input.externalSend) return false;
  return input.mergeStrategy !== 'direct' || input.autoMerge;
}

export async function prepareRunReleaseIntent(input: PrepareRunReleaseInput): Promise<RunReleaseIdentity> {
  const authority = input.hostAuthority;
  if (!authority.releaseEligible || !authority.finalCommitSha || !FULL_SHA.test(authority.finalCommitSha)) {
    throw new Error('complete exact host authority is required before release preparation');
  }
  const workspaceRealpath = fs.realpathSync(authority.repositoryTopLevel);
  const worktreeRealpath = fs.realpathSync(authority.checkoutPath);
  let repository: RunReleaseIdentity['repository'] = null;
  if (needsRepository(input)) {
    const canonical = await getGithubRepositoryAuthority(authority.workspaceId, { requireActive: true });
    if (!canonical) throw new Error('canonical repository authority is unavailable');
    repository = {
      owner: canonical.owner,
      name: canonical.name,
      source: canonical.source,
      bindingId: canonical.bindingId,
      installationId: canonical.installationId,
      repositoryId: canonical.repositoryId,
    };
  }
  const exact: RunReleaseIdentity = {
    runId: authority.runId,
    workspaceId: authority.workspaceId,
    specId: authority.specId,
    authorizedSha: authority.finalCommitSha,
    branchName: authority.branchName,
    workspaceRealpath,
    worktreeRealpath,
    repository,
  };
  await withRunReleaseLock(exact, async () => {
    await revalidateRunReleaseIdentity(exact);
    const digest = identityHash(exact, input);
    await execute(`
      INSERT INTO pipeline_run_release_intents (
        run_id, workspace_id, spec_id, authorized_sha, branch_name,
        execution_workspace_path, execution_worktree_path,
        repository_owner, repository_name, repository_authority_source,
        repository_binding_id, repository_installation_id, repository_id,
        merge_strategy, auto_merge, external_send, deployment_allowed,
        identity_hash, status, step_state
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,FALSE,$17,'pending','{}'::jsonb)
      ON CONFLICT (run_id) DO NOTHING
    `, [
      exact.runId, exact.workspaceId, exact.specId, exact.authorizedSha, exact.branchName,
      exact.workspaceRealpath, exact.worktreeRealpath,
      repository?.owner ?? null, repository?.name ?? null, repository?.source ?? null,
      repository?.bindingId ?? null, repository?.installationId ?? null, repository?.repositoryId ?? null,
      input.mergeStrategy, input.autoMerge, input.externalSend, digest,
    ]);
    const persisted = await loadIntent(exact.runId);
    if (!persisted || persisted.identity_hash !== digest) {
      throw new Error('run already has a different immutable release intent');
    }
    await execute(`
      UPDATE pipeline_runs
         SET terminal_checkout_sha = COALESCE(terminal_checkout_sha, $2),
             terminal_checkout_attested_at = COALESCE(terminal_checkout_attested_at, NOW()),
             status = CASE WHEN status = 'done' THEN status ELSE 'release_pending' END
       WHERE id = $1
         AND (terminal_checkout_sha IS NULL OR terminal_checkout_sha = $2)
    `, [exact.runId, exact.authorizedSha]);
  });
  return exact;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Rorca-Worker',
  };
}

async function pushExact(identityValue: RunReleaseIdentity, sha: string, branch: string): Promise<void> {
  if (!FULL_SHA.test(sha)) throw new Error('push SHA is invalid');
  await withGithubReleaseActuation(identityValue, 'merge', async ({ authority, credential }) => {
    // The callee repeats local branch/HEAD validation while the seam lock is held.
    await revalidateRunReleaseIdentity(identityValue);
    const askpassDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-release-askpass-'));
    const askpass = path.join(askpassDir, 'askpass.sh');
    fs.writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "x-access-token";; *) printf "%s\\n" "$RORCA_RELEASE_TOKEN";; esac\n', { mode: 0o700 });
    try {
      const result = spawnSync('git', [
        '-c', 'credential.helper=', '-c', 'core.askPass=' + askpass,
        'push', `https://github.com/${authority.owner}/${authority.name}.git`,
        `${sha}:refs/heads/${branch}`,
      ], {
        cwd: identityValue.workspaceRealpath,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: askpassDir,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: askpass,
          RORCA_RELEASE_TOKEN: credential.token,
        },
      });
      if (result.status !== 0) throw new Error(`exact release push failed (${result.status ?? 'signal'})`);
    } finally {
      fs.rmSync(askpassDir, { recursive: true, force: true });
    }
  });
}

async function createOrFinalizePullRequest(row: ReleaseIntentRow, draft: boolean): Promise<number> {
  const exact = identity(row);
  return withGithubReleaseActuation(exact, 'pulls-write', async ({ authority, credential }) => {
    await revalidateRunReleaseIdentity(exact);
    const head = `${authority.owner}:${exact.branchName}`;
    const lookup = await githubRateLimiter.execute(() => fetchGithubWithTimeout(fetch,
      githubRepoApiUrl(authority.owner, authority.name, `/pulls?head=${encodeURIComponent(head)}&state=open&per_page=10`),
      { headers: headers(credential.token) }));
    if (!lookup.ok) throw githubProviderError(lookup, 'GITHUB_RELEASE_PR_LOOKUP_FAILED');
    const existing = await lookup.json() as Array<{ number?: number; draft?: boolean; head?: { sha?: string } }>;
    const exactMatches = existing.filter(pr => pr.head?.sha?.toLowerCase() === exact.authorizedSha && Number.isSafeInteger(pr.number));
    if (exactMatches.length > 1) throw new Error('multiple pull requests match exact release identity');
    let pr = exactMatches[0];
    if (!pr) {
      await revalidateRunReleaseIdentity(exact);
      const created = await githubRateLimiter.execute(() => fetchGithubWithTimeout(fetch,
        githubRepoApiUrl(authority.owner, authority.name, '/pulls'), {
          method: 'POST', headers: headers(credential.token), body: JSON.stringify({
            title: draft ? `[WIP] ${exact.specId}` : `feat: ${exact.specId}`,
            head: exact.branchName,
            base: authority.autoPrTargetBranch || 'main',
            draft,
            body: `Rorca run #${exact.runId}; exact authorized head ${exact.authorizedSha}.`,
          }),
        }));
      if (!created.ok) throw githubProviderError(created, 'GITHUB_RELEASE_PR_CREATE_FAILED');
      pr = await created.json() as typeof pr;
    }
    if (!pr?.number) throw new Error('pull request identity was not returned');
    if (!draft && pr.draft === true) {
      await revalidateRunReleaseIdentity(exact);
      const finalized = await githubRateLimiter.execute(() => fetchGithubWithTimeout(fetch,
        githubRepoApiUrl(authority.owner, authority.name, `/pulls/${pr!.number}`), {
          method: 'PATCH', headers: headers(credential.token), body: JSON.stringify({ draft: false }),
        }));
      if (!finalized.ok) throw githubProviderError(finalized, 'GITHUB_RELEASE_PR_FINALIZE_FAILED');
    }
    return Number(pr.number);
  });
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).trim();
}

async function cleanupExecutionWorktree(row: ReleaseIntentRow): Promise<void> {
  const exact = identity(row);
  if (exact.worktreeRealpath === exact.workspaceRealpath) {
    await execute(`UPDATE pipeline_runs SET worktree_cleanup_status = 'completed', worktree_cleaned_at = NOW() WHERE id = $1`, [exact.runId]);
    return;
  }
  await withRunReleaseLock(exact, async () => {
    await revalidateRunReleaseIdentity(exact);
    await execute(`UPDATE pipeline_runs SET worktree_cleanup_status = 'pending' WHERE id = $1`, [exact.runId]);
    const result = spawnSync('git', ['worktree', 'remove', '--force', exact.worktreeRealpath], {
      cwd: exact.workspaceRealpath, encoding: 'utf8', timeout: 30_000,
    });
    if (result.status !== 0 && fs.existsSync(exact.worktreeRealpath)) {
      await execute(`UPDATE pipeline_runs SET worktree_cleanup_status = 'failed' WHERE id = $1`, [exact.runId]);
      throw new Error('execution worktree cleanup failed');
    }
    await execute(`UPDATE pipeline_runs SET worktree_cleanup_status = 'completed', worktree_cleaned_at = NOW() WHERE id = $1`, [exact.runId]);
  });
}

async function ensureReleaseEffects(row: ReleaseIntentRow, posture?: MergeResolutionPosture, resolverEnv: Record<string, string> = {}): Promise<void> {
  const state = steps(row);
  const exact = identity(row);
  const external = row.external_send;
  if (row.merge_strategy === 'direct' && row.auto_merge) {
    if (shouldActuateReleaseStep(state.merge)) {
      await setStep(exact.runId, 'merge', 'processing');
      const baseBefore = git(exact.workspaceRealpath, ['rev-parse', '--verify', 'HEAD^{commit}']).toLowerCase();
      const merged: MergeResult = await performMerge(
        exact.runId, exact.branchName, exact.workspaceRealpath, posture, resolverEnv, exact,
      );
      if (!merged.success || !merged.mergeCommitSha || !isFullGitObjectId(merged.mergeCommitSha)) {
        throw new Error(merged.error ?? 'direct merge did not produce an exact commit');
      }
      await setStep(exact.runId, 'merge', 'completed', ', base_before_sha = $4, merge_commit_sha = $5', [baseBefore, merged.mergeCommitSha.toLowerCase()]);
      row.merge_commit_sha = merged.mergeCommitSha.toLowerCase();
    }
    if (external && shouldActuateReleaseStep(state.push)) {
      const refreshed = await loadIntent(exact.runId);
      const mergeSha = refreshed?.merge_commit_sha;
      if (!mergeSha) throw new Error('direct push lacks durable merge SHA');
      if (git(exact.workspaceRealpath, ['rev-parse', '--verify', 'HEAD^{commit}']).toLowerCase() !== mergeSha) {
        throw new Error('base branch advanced after exact direct merge');
      }
      await setStep(exact.runId, 'push', 'processing');
      const baseBranch = git(exact.workspaceRealpath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      await pushExact(exact, mergeSha, baseBranch);
      await setStep(exact.runId, 'push', 'completed');
    } else if (!external) await setStep(exact.runId, 'push', 'not_required');
  } else if (row.merge_strategy === 'direct') {
    await setStep(exact.runId, 'merge', 'not_required');
    await setStep(exact.runId, 'push', 'not_required');
  } else {
    await setStep(exact.runId, 'merge', 'not_required');
    if (external && shouldActuateReleaseStep(state.push)) {
      await setStep(exact.runId, 'push', 'processing');
      await pushExact(exact, exact.authorizedSha, exact.branchName);
      await setStep(exact.runId, 'push', 'completed');
    } else if (!external) await setStep(exact.runId, 'push', 'not_required');
    if (external && (row.merge_strategy === 'pr' || row.merge_strategy === 'draft-pr') && shouldActuateReleaseStep(state.pr)) {
      await setStep(exact.runId, 'pr', 'processing');
      const prNumber = await createOrFinalizePullRequest(row, row.merge_strategy === 'draft-pr');
      await execute('UPDATE pipeline_runs SET pr_number = $1, pr_creating = FALSE, pr_creation_error = NULL WHERE id = $2', [prNumber, exact.runId]);
      await setStep(exact.runId, 'pr', 'completed');
    } else if (row.merge_strategy === 'branch-only' || !external) await setStep(exact.runId, 'pr', 'not_required');
  }
  // Deployment authority is deliberately absent from autonomous release.
  await setStep(exact.runId, 'workflow', 'not_required');
}

async function persistTerminalIntent(row: ReleaseIntentRow): Promise<TrustedWalReference> {
  const terminal = await persistTrustedWalEvent({
    eventType: 'run_finished',
    workspaceId: row.workspace_id,
    runId: Number(row.run_id),
    source: 'worker',
    payload: {
      run_id: Number(row.run_id),
      status: 'done',
      source: 'host-release-closeout',
      authorized_sha: row.authorized_sha,
      release_identity_hash: row.identity_hash,
      merge_strategy: row.merge_strategy,
      deployment_allowed: false,
    },
  });
  await execute('UPDATE pipeline_run_release_intents SET terminal_event_id = $2, updated_at = NOW() WHERE run_id = $1', [Number(row.run_id), terminal.reference.id]);
  return terminal.reference;
}

async function commitPublicDoneAndTerminalReady(
  row: ReleaseIntentRow,
  terminal: TrustedWalReference,
): Promise<void> {
  await transaction(async (client) => {
    const run = await client.query(`
      UPDATE pipeline_runs
         SET status = 'done', lifecycle_status = 'finished',
             finished_at = COALESCE(finished_at, NOW())
       WHERE id = $1 AND workspace_id = $2
       RETURNING id
    `, [Number(row.run_id), row.workspace_id]);
    const ready = await client.query(`
      UPDATE wal_events
         SET outbox_ready_at = COALESCE(outbox_ready_at, NOW())
       WHERE id = $1 AND ingest_key = $2 AND event_identity_hash = $3
         AND canonical_run_id = $4 AND workspace_id = $5
         AND trust_provenance = 'host' AND trusted_source = 'worker'
       RETURNING id
    `, [terminal.id, terminal.ingestKey, terminal.identityHash, terminal.runId, terminal.workspaceId]);
    if (run.rowCount !== 1 || ready.rowCount !== 1) {
      throw new Error('public done and exact terminal readiness did not commit atomically');
    }
  });
}

export async function reconcileRunReleaseIntent(
  runId: number,
  posture?: MergeResolutionPosture,
  resolverEnv: Record<string, string> = {},
): Promise<RunReleaseResult> {
  const row = await loadIntent(runId);
  if (!row) return { runId, status: 'blocked', error: 'release intent not found' };
  if (row.status === 'completed') return { runId, status: 'completed' };
  let publicDoneCommitted = false;
  try {
    await execute(`UPDATE pipeline_run_release_intents SET status = 'processing', claimed_at = NOW(), updated_at = NOW() WHERE run_id = $1 AND status != 'completed'`, [runId]);
    await ensureReleaseEffects(row, posture, resolverEnv);
    await execute(`
      INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload, ingest_key)
      VALUES ('run_closeout', $1, $2, 'rorca-host', $3::jsonb, $4)
      ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING
    `, [row.workspace_id, row.spec_id, JSON.stringify({
      run_id: Number(row.run_id),
      status: 'done',
      authorized_sha: row.authorized_sha,
      release_identity_hash: row.identity_hash,
      merge_strategy: row.merge_strategy,
      completion_scope: row.merge_strategy === 'direct' && row.auto_merge ? 'base_integrated' : 'run_branch',
      base_integrated: row.merge_strategy === 'direct' && row.auto_merge,
      deployment_allowed: false,
    }), `run-release-closeout:v1:${row.identity_hash}`]);
    await setStep(runId, 'release_closeout', 'completed');
    const terminal = await persistTerminalIntent(row);
    await setStep(runId, 'terminal_intent', 'completed');

    if (row.merge_strategy === 'direct' && row.auto_merge) {
      try {
        await cleanupExecutionWorktree(row);
        await setStep(runId, 'cleanup', 'completed');
      } catch (_error) {
        await setStep(runId, 'cleanup', 'failed');
        // Cleanup failure is durable and visible; immutable execution identity is
        // retained, and terminal authority remains safe from the live checkout.
      }
    } else await setStep(runId, 'cleanup', 'not_required');

    // Public done and terminal readiness share one transaction. A crash after
    // this boundary leaves a durable ready event for startup relay, never a
    // ghost done row without closeout.
    await commitPublicDoneAndTerminalReady(row, terminal);
    publicDoneCommitted = true;
    await setStep(runId, 'public_done', 'completed');
    await relayTrustedWalEvent(terminal);
    await setStep(runId, 'terminal_relay', 'completed');
    await execute(`
      UPDATE pipeline_run_release_intents
         SET status = 'completed', completed_at = NOW(), claimed_at = NULL,
             last_error_code = NULL, last_error_message = NULL, updated_at = NOW()
       WHERE run_id = $1
    `, [runId]);
    return { runId, status: 'completed' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await execute(`
      UPDATE pipeline_run_release_intents
         SET status = 'pending', claimed_at = NULL,
             last_error_code = 'RELEASE_ACTUATION_DEFERRED',
             last_error_message = $2, updated_at = NOW()
       WHERE run_id = $1
    `, [runId, message.slice(0, 512)]);
    if (!publicDoneCommitted) {
      await execute(`UPDATE pipeline_runs SET status = 'release_pending', summary = $2 WHERE id = $1`, [runId, `release_deferred:${message.slice(0, 200)}`]);
    }
    return { runId, status: 'blocked', error: message };
  }
}

export async function reconcilePendingRunReleases(limit = 100): Promise<number> {
  const pending = await query<{ run_id: number | string }>(`
    SELECT run_id FROM pipeline_run_release_intents
     WHERE status IN ('pending', 'processing')
        OR (status = 'blocked' AND terminal_event_id IS NOT NULL)
     ORDER BY updated_at ASC, run_id ASC LIMIT $1
  `, [limit]);
  let completed = 0;
  for (const candidate of pending) {
    const result = await reconcileRunReleaseIntent(Number(candidate.run_id));
    if (result.status === 'completed') completed++;
  }
  return completed;
}

/** Load the exact immutable release identity for reviewed PR merge actuation. */
export async function loadRunReleaseIdentity(runId: number, expectedSha: string): Promise<RunReleaseIdentity> {
  const row = await loadIntent(runId);
  if (!row || row.authorized_sha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error('reviewed delivery differs from immutable run release identity');
  }
  return identity(row);
}
