/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** One host-owned, restart-safe, exact-SHA release and terminal closeout seam. */

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
  assertGithubRef,
  type GithubRepositoryAuthority,
} from './github-repository-authority';
import { resolveWorkspaceGitHubToken, type ResolvedGitHubToken } from './github-token-resolver';
import { fetchGithubWithTimeout } from './github-app-credential-provider';
import { githubRateLimiter } from './github-rate-limiter';
import { githubProviderError } from './github-provider-error';
import { isGitSha } from './git-sha';
import {
  persistTrustedWalEvent,
  relayTrustedWalEvent,
  trustedWalReference,
  type TrustedWalReference,
  type TrustedWalRow,
} from './trusted-wal';
import {
  revalidateRunReleaseIdentity,
  withGithubReleaseActuation,
  withRunReleaseLock,
  type RunReleaseIdentity,
} from './release-identity';

export type RunMergeStrategy = 'direct' | 'pr' | 'draft-pr' | 'branch-only';
export type RunReleaseStepStatus = 'pending' | 'processing' | 'completed' | 'not_required' | 'failed';
type StepStatus = RunReleaseStepStatus;

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
  base_branch: string | null;
  base_sha: string | null;
  provider_release_ref: string | null;
  integration_checkout_path: string | null;
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

function identityHash(identityValue: RunReleaseIdentity, input: PrepareRunReleaseInput): string {
  return crypto.createHash('sha256').update(stable({
    version: 2,
    ...identityValue,
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
  if (!row.base_branch || !row.base_sha || !row.integration_checkout_path || !isGitSha(row.base_sha)) {
    throw new Error('release intent lacks immutable base/path identity');
  }
  return {
    runId: Number(row.run_id),
    workspaceId: row.workspace_id,
    specId: row.spec_id,
    authorizedSha: row.authorized_sha.toLowerCase(),
    branchName: row.branch_name,
    workspaceRealpath: row.execution_workspace_path,
    worktreeRealpath: row.execution_worktree_path,
    baseBranch: row.base_branch,
    baseSha: row.base_sha.toLowerCase(),
    providerReleaseRef: row.provider_release_ref,
    integrationCheckoutPath: row.integration_checkout_path,
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
  const result = await execute(`
    UPDATE pipeline_run_release_intents
       SET status = CASE WHEN status = 'pending' THEN 'processing' ELSE status END,
           step_state = jsonb_set(step_state, ARRAY[$2], to_jsonb($3::text), TRUE),
           claimed_at = CASE WHEN $3 IN ('processing', 'pending') THEN NOW() ELSE claimed_at END,
           updated_at = NOW()${extraSql}
     WHERE run_id = $1 AND status != 'completed'
  `, [runId, step, status, ...values]);
  if (result.rowCount !== 1) throw new Error(`release step ${step} could not claim exact intent`);
}

function needsRepository(input: PrepareRunReleaseInput): boolean {
  return input.externalSend && (input.mergeStrategy !== 'direct' || input.autoMerge);
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function tryGit(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
  return { ok: result.status === 0, stdout: String(result.stdout ?? '').trim() };
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

function sameCredentialSource(authority: GithubRepositoryAuthority, credential: ResolvedGitHubToken): boolean {
  return authority.source === 'github-app-installation'
    ? credential.source === 'github-app-installation'
    : ['workspace-oauth', 'workspace-pat'].includes(credential.source);
}

async function providerRefSha(
  authority: Pick<GithubRepositoryAuthority, 'owner' | 'name'>,
  token: string,
  branch: string,
): Promise<string | null> {
  assertGithubRef(branch);
  const suffix = `/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
  const response = await githubRateLimiter.execute(() => fetchGithubWithTimeout(fetch,
    githubRepoApiUrl(authority.owner, authority.name, suffix), { headers: headers(token) }));
  if (response.status === 404) return null;
  if (!response.ok) throw githubProviderError(response, 'GITHUB_RELEASE_REF_LOOKUP_FAILED');
  const body = await response.json().catch(() => null) as { object?: { sha?: unknown } } | null;
  if (!isGitSha(body?.object?.sha)) throw new Error('provider ref lookup returned an indeterminate SHA');
  return body.object.sha.toLowerCase();
}

function integrationPath(workspaceRealpath: string, runId: number, authorizedSha: string): string {
  const digest = crypto.createHash('sha256').update(`${workspaceRealpath}\0${runId}\0${authorizedSha}`).digest('hex');
  return path.join(os.tmpdir(), `rorca-release-integration-${digest}`);
}

function providerReleaseRef(runId: number, sha: string): string {
  return `rorca/release/run-${runId}-${sha.slice(0, 12)}`;
}

function assertCleanCanonicalBase(workspace: string, branch: string, expectedSha: string): void {
  const symbolic = git(workspace, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const base = git(workspace, ['rev-parse', `refs/heads/${branch}^{commit}`]).toLowerCase();
  if (symbolic !== branch || base !== expectedSha || git(workspace, ['status', '--porcelain']) !== '') {
    throw new Error('canonical direct base branch/SHA/worktree differs from frozen release intent');
  }
  if (tryGit(workspace, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) {
    throw new Error('canonical direct base contains an unfinished merge');
  }
}

export async function prepareRunReleaseIntent(input: PrepareRunReleaseInput): Promise<RunReleaseIdentity> {
  const authority = input.hostAuthority;
  if (!authority.releaseEligible || !isGitSha(authority.finalCommitSha)) {
    throw new Error('complete exact host authority is required before release preparation');
  }
  const workspaceRealpath = fs.realpathSync(authority.repositoryTopLevel);
  const worktreeRealpath = fs.realpathSync(authority.checkoutPath);
  let repository: RunReleaseIdentity['repository'] = null;
  let canonicalRepository: GithubRepositoryAuthority | null = null;
  if (needsRepository(input)) {
    canonicalRepository = await getGithubRepositoryAuthority(authority.workspaceId, { requireActive: true });
    if (!canonicalRepository) throw new Error('canonical repository authority is unavailable');
    repository = {
      owner: canonicalRepository.owner,
      name: canonicalRepository.name,
      source: canonicalRepository.source,
      bindingId: canonicalRepository.bindingId,
      installationId: canonicalRepository.installationId,
      repositoryId: canonicalRepository.repositoryId,
    };
  }

  const localBaseBranch = git(workspaceRealpath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const targetBaseBranch = canonicalRepository?.autoPrTargetBranch || localBaseBranch;
  assertGithubRef(targetBaseBranch);
  let frozenBaseSha = git(workspaceRealpath, ['rev-parse', `refs/heads/${targetBaseBranch}^{commit}`]).toLowerCase();
  if (!isGitSha(frozenBaseSha)) throw new Error('local base is not an exact 40-hex commit');
  if (input.mergeStrategy === 'direct' && input.autoMerge) {
    assertCleanCanonicalBase(workspaceRealpath, targetBaseBranch, frozenBaseSha);
  }

  const exact: RunReleaseIdentity = {
    runId: authority.runId,
    workspaceId: authority.workspaceId,
    specId: authority.specId,
    authorizedSha: authority.finalCommitSha.toLowerCase(),
    branchName: authority.branchName,
    workspaceRealpath,
    worktreeRealpath,
    baseBranch: targetBaseBranch,
    baseSha: frozenBaseSha,
    providerReleaseRef: repository && input.mergeStrategy !== 'direct'
      ? providerReleaseRef(authority.runId, authority.finalCommitSha.toLowerCase())
      : null,
    integrationCheckoutPath: integrationPath(workspaceRealpath, authority.runId, authority.finalCommitSha.toLowerCase()),
    repository,
  };

  await withRunReleaseLock(exact, async () => {
    await revalidateRunReleaseIdentity(exact);
    if (canonicalRepository && repository) {
      const credential = await resolveWorkspaceGitHubToken(authority.workspaceId, {
        repository: { owner: canonicalRepository.owner, name: canonicalRepository.name },
        purpose: 'repository-read',
      });
      if (!credential || !sameCredentialSource(canonicalRepository, credential)) {
        throw new Error('canonical repository read credential is unavailable or downgraded');
      }
      const providerBase = await providerRefSha(canonicalRepository, credential.token, targetBaseBranch);
      if (!providerBase) throw new Error('canonical provider base ref is absent');
      if (input.mergeStrategy === 'direct' && input.autoMerge && providerBase !== frozenBaseSha) {
        throw new Error('provider base differs from exact local canonical base');
      }
      frozenBaseSha = providerBase;
      exact.baseSha = providerBase;
    }

    const digest = identityHash(exact, input);
    await transaction(async (client) => {
      await client.query(`
        INSERT INTO pipeline_run_release_intents (
          run_id, workspace_id, spec_id, authorized_sha, branch_name,
          execution_workspace_path, execution_worktree_path,
          repository_owner, repository_name, repository_authority_source,
          repository_binding_id, repository_installation_id, repository_id,
          merge_strategy, auto_merge, external_send, deployment_allowed,
          identity_hash, status, step_state, base_branch, base_sha,
          provider_release_ref, integration_checkout_path
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,FALSE,
          $17,'pending','{}'::jsonb,$18,$19,$20,$21
        )
        ON CONFLICT (run_id) DO NOTHING
      `, [
        exact.runId, exact.workspaceId, exact.specId, exact.authorizedSha, exact.branchName,
        exact.workspaceRealpath, exact.worktreeRealpath,
        repository?.owner ?? null, repository?.name ?? null, repository?.source ?? null,
        repository?.bindingId ?? null, repository?.installationId ?? null, repository?.repositoryId ?? null,
        input.mergeStrategy, input.autoMerge, input.externalSend, digest,
        exact.baseBranch, exact.baseSha, exact.providerReleaseRef, exact.integrationCheckoutPath,
      ]);
      const persisted = (await client.query<{ identity_hash: string }>(
        'SELECT identity_hash FROM pipeline_run_release_intents WHERE run_id = $1 FOR SHARE', [exact.runId],
      )).rows[0];
      if (!persisted || persisted.identity_hash !== digest) {
        throw new Error('run already has a different immutable release intent');
      }
      const run = await client.query(`
        UPDATE pipeline_runs
           SET terminal_checkout_sha = COALESCE(terminal_checkout_sha, $2),
               terminal_checkout_attested_at = COALESCE(terminal_checkout_attested_at, NOW()),
               status = CASE WHEN status = 'done' THEN status ELSE 'release_pending' END
         WHERE id = $1
           AND workspace_id = $3
           AND execution_workspace_path = $4
           AND execution_worktree_path = $5
           AND (terminal_checkout_sha IS NULL OR terminal_checkout_sha = $2)
         RETURNING id
      `, [exact.runId, exact.authorizedSha, exact.workspaceId, exact.workspaceRealpath, exact.worktreeRealpath]);
      if (run.rowCount !== 1) throw new Error('terminal checkout attestation/release_pending transition did not bind exact run');
    });
  });
  return exact;
}

export async function pushExactForTests(
  identityValue: RunReleaseIdentity,
  sha: string,
  branch: string,
  expectedRemoteSha: string | null,
): Promise<void> {
  if (!isGitSha(sha)) throw new Error('push SHA is invalid');
  await withGithubReleaseActuation(identityValue, 'merge', async ({ authority, credential }) => {
    const before = await providerRefSha(authority, credential.token, branch);
    if (before === sha) return;
    if (before !== expectedRemoteSha) throw new Error('provider ref advanced before exact CAS push');
    await revalidateRunReleaseIdentity(identityValue);
    const askpassDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-release-askpass-'));
    const askpass = path.join(askpassDir, 'askpass.sh');
    fs.writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "x-access-token";; *) printf "%s\\n" "$RORCA_RELEASE_TOKEN";; esac\n', { mode: 0o700 });
    try {
      const lease = `--force-with-lease=refs/heads/${branch}:${expectedRemoteSha ?? ''}`;
      const result = spawnSync('git', [
        '-c', 'credential.helper=', '-c', `core.askPass=${askpass}`,
        'push', lease,
        `https://github.com/${authority.owner}/${authority.name}.git`,
        `${sha}:refs/heads/${branch}`,
      ], {
        cwd: identityValue.workspaceRealpath,
        encoding: 'utf8', timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? '', HOME: askpassDir,
          GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
          GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: askpass,
          RORCA_RELEASE_TOKEN: credential.token,
        },
      });
      if (result.status !== 0) throw new Error(`exact release CAS push failed (${result.status ?? 'signal'})`);
    } finally {
      fs.rmSync(askpassDir, { recursive: true, force: true });
    }
    const after = await providerRefSha(authority, credential.token, branch);
    if (after !== sha) throw new Error('provider ref raced during exact CAS push; release quarantined');
  });
}

async function fetchPullRequest(
  authority: GithubRepositoryAuthority,
  token: string,
  number: number,
): Promise<{ number?: number; draft?: boolean; state?: string; head?: { sha?: string; ref?: string } }> {
  const response = await githubRateLimiter.execute(() => fetchGithubWithTimeout(fetch,
    githubRepoApiUrl(authority.owner, authority.name, `/pulls/${number}`), { headers: headers(token) }));
  if (!response.ok) throw githubProviderError(response, 'GITHUB_RELEASE_PR_VERIFY_FAILED');
  return response.json() as Promise<{ number?: number; draft?: boolean; state?: string; head?: { sha?: string; ref?: string } }>;
}

async function quarantinePullRequest(
  authority: GithubRepositoryAuthority,
  token: string,
  number: number,
): Promise<void> {
  const response = await githubRateLimiter.execute(() => fetchGithubWithTimeout(fetch,
    githubRepoApiUrl(authority.owner, authority.name, `/pulls/${number}`), {
      method: 'PATCH', headers: headers(token), body: JSON.stringify({ state: 'closed' }),
    }));
  if (!response.ok) throw new Error('raced pull request could not be quarantined');
}

async function assertExactProviderHead(
  exact: RunReleaseIdentity,
  authority: GithubRepositoryAuthority,
  credential: ResolvedGitHubToken,
): Promise<void> {
  if (!exact.providerReleaseRef) throw new Error('release has no uniquely owned provider ref');
  const providerHead = await providerRefSha(authority, credential.token, exact.providerReleaseRef);
  if (providerHead !== exact.authorizedSha) throw new Error('provider release ref differs from exact authorized SHA');
}

export async function createOrFinalizePullRequestForTests(row: ReleaseIntentRow, draft: boolean): Promise<number> {
  const exact = identity(row);
  return withGithubReleaseActuation(exact, 'pulls-write', async ({ authority, credential }) => {
    await assertExactProviderHead(exact, authority, credential);
    const head = `${authority.owner}:${exact.providerReleaseRef}`;
    const lookup = await githubRateLimiter.execute(() => fetchGithubWithTimeout(fetch,
      githubRepoApiUrl(authority.owner, authority.name, `/pulls?head=${encodeURIComponent(head)}&state=all&per_page=10`),
      { headers: headers(credential.token) }));
    if (!lookup.ok) throw githubProviderError(lookup, 'GITHUB_RELEASE_PR_LOOKUP_FAILED');
    const existing = await lookup.json().catch(() => null) as Array<{ number?: number; draft?: boolean; state?: string; head?: { sha?: string; ref?: string } }> | null;
    if (!Array.isArray(existing)) throw new Error('pull request lookup response shape was indeterminate');
    const owned = existing.filter((pr) => pr.head?.ref === exact.providerReleaseRef && Number.isSafeInteger(pr.number));
    if (owned.some((pr) => pr.state !== 'open' && pr.state !== 'closed')) {
      throw new Error('run-owned pull request state was indeterminate');
    }
    // Closed/quarantined PRs are immutable audit history. Recovery binds only
    // the one currently open PR for the run-owned ref, so a crash after a
    // replacement create/verify converges without forgetting prior attempts.
    const open = owned.filter((pr) => pr.state === 'open');
    if (open.length > 1) throw new Error('multiple open pull requests share the unique release ref');
    let pr = open[0];
    if (pr && pr.head?.sha?.toLowerCase() !== exact.authorizedSha) {
      await quarantinePullRequest(authority, credential.token, Number(pr.number));
      throw new Error('provider head raced before PR create/finalize; pull request quarantined');
    }
    if (!pr) {
      await assertExactProviderHead(exact, authority, credential); // immediately before mutation
      const created = await githubRateLimiter.execute(() => fetchGithubWithTimeout(fetch,
        githubRepoApiUrl(authority.owner, authority.name, '/pulls'), {
          method: 'POST', headers: headers(credential.token), body: JSON.stringify({
            title: draft ? `[WIP] ${exact.specId}` : `feat: ${exact.specId}`,
            head: exact.providerReleaseRef,
            base: exact.baseBranch,
            draft,
            body: `Rorca run #${exact.runId}; exact authorized head ${exact.authorizedSha}.`,
          }),
        }));
      if (!created.ok) throw githubProviderError(created, 'GITHUB_RELEASE_PR_CREATE_FAILED');
      pr = await created.json().catch(() => null) as typeof pr;
      if (!Number.isSafeInteger(pr?.number)) throw new Error('pull request create response omitted its identity');
      const verified = await fetchPullRequest(authority, credential.token, Number(pr!.number));
      if (verified.head?.sha?.toLowerCase() !== exact.authorizedSha
        || verified.head?.ref !== exact.providerReleaseRef) {
        await quarantinePullRequest(authority, credential.token, Number(pr!.number));
        throw new Error('provider head raced during PR create; pull request quarantined');
      }
      pr = verified;
    }
    if (!Number.isSafeInteger(pr?.number)) throw new Error('pull request identity was not returned');
    if (!draft && pr!.draft === true) {
      await assertExactProviderHead(exact, authority, credential);
      const immediatelyBefore = await fetchPullRequest(authority, credential.token, Number(pr!.number));
      if (immediatelyBefore.head?.sha?.toLowerCase() !== exact.authorizedSha
        || immediatelyBefore.head?.ref !== exact.providerReleaseRef) {
        await quarantinePullRequest(authority, credential.token, Number(pr!.number));
        throw new Error('provider head raced before draft finalization; pull request quarantined');
      }
      const finalized = await githubRateLimiter.execute(() => fetchGithubWithTimeout(fetch,
        githubRepoApiUrl(authority.owner, authority.name, `/pulls/${pr!.number}`), {
          method: 'PATCH', headers: headers(credential.token), body: JSON.stringify({ draft: false }),
        }));
      if (!finalized.ok) throw githubProviderError(finalized, 'GITHUB_RELEASE_PR_FINALIZE_FAILED');
      const verified = await fetchPullRequest(authority, credential.token, Number(pr!.number));
      if (verified.draft === true || verified.head?.sha?.toLowerCase() !== exact.authorizedSha
        || verified.head?.ref !== exact.providerReleaseRef) {
        await quarantinePullRequest(authority, credential.token, Number(pr!.number));
        throw new Error('provider head raced during draft finalization; pull request quarantined');
      }
    }
    return Number(pr!.number);
  });
}

function registeredWorktree(workspace: string, target: string): boolean {
  return git(workspace, ['worktree', 'list', '--porcelain'])
    .split('\n').some((line) => line === `worktree ${target}`);
}

async function cleanupRegisteredWorktree(workspace: string, target: string): Promise<void> {
  const registered = registeredWorktree(workspace, target);
  if (!registered && !fs.existsSync(target)) return;
  if (registered) {
    const result = spawnSync('git', ['worktree', 'remove', '--force', target], {
      cwd: workspace, encoding: 'utf8', timeout: 30_000,
    });
    if (result.status !== 0 && fs.existsSync(target)) throw new Error('exact worktree cleanup failed');
    if (!fs.existsSync(target)) git(workspace, ['worktree', 'prune', '--expire', 'now']);
  } else if (fs.existsSync(target)) {
    throw new Error('cleanup target exists but is not registered to the exact repository');
  }
}

async function cleanupExecutionWorktree(row: ReleaseIntentRow): Promise<void> {
  const exact = identity(row);
  if (exact.worktreeRealpath === exact.workspaceRealpath) {
    const done = await execute(`UPDATE pipeline_runs SET worktree_cleanup_status = 'completed', worktree_cleaned_at = COALESCE(worktree_cleaned_at, NOW()) WHERE id = $1`, [exact.runId]);
    if (done.rowCount !== 1) throw new Error('cleanup state did not bind exact run');
    return;
  }
  await withRunReleaseLock(exact, async () => {
    const registered = registeredWorktree(exact.workspaceRealpath, exact.worktreeRealpath);
    if (registered && fs.existsSync(exact.worktreeRealpath)) await revalidateRunReleaseIdentity(exact);
    const pending = await execute(`UPDATE pipeline_runs SET worktree_cleanup_status = 'pending' WHERE id = $1 AND worktree_cleanup_status != 'completed'`, [exact.runId]);
    if (pending.rowCount !== 1) {
      const current = await queryOne<{ worktree_cleanup_status: string }>('SELECT worktree_cleanup_status FROM pipeline_runs WHERE id = $1', [exact.runId]);
      if (current?.worktree_cleanup_status === 'completed') return;
      throw new Error('cleanup claim did not bind exact run');
    }
    await cleanupRegisteredWorktree(exact.workspaceRealpath, exact.worktreeRealpath);
    const done = await execute(`UPDATE pipeline_runs SET worktree_cleanup_status = 'completed', worktree_cleaned_at = COALESCE(worktree_cleaned_at, NOW()) WHERE id = $1`, [exact.runId]);
    if (done.rowCount !== 1) throw new Error('cleanup completion did not bind exact run');
  });
}

async function cleanupIntegrationCheckout(row: ReleaseIntentRow): Promise<void> {
  const exact = identity(row);
  await withRunReleaseLock(exact, async () => {
    await cleanupRegisteredWorktree(exact.workspaceRealpath, exact.integrationCheckoutPath);
  });
}

export async function updateLocalBaseExactForTests(exact: RunReleaseIdentity, mergeSha: string): Promise<void> {
  await withRunReleaseLock(exact, async () => {
    const current = git(exact.workspaceRealpath, ['rev-parse', `refs/heads/${exact.baseBranch}^{commit}`]).toLowerCase();
    const symbolic = git(exact.workspaceRealpath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (symbolic !== exact.baseBranch) throw new Error('canonical base branch switched before local CAS');
    if (current === mergeSha) {
      // Two exact crash states are admissible: update-ref completed while the
      // untouched index/worktree still has the frozen tree (repair with reset),
      // or reset completed and the clean index/worktree already has mergeSha's
      // tree (the effect is complete). Every other tree or dirty state is
      // operator uncertainty and must never be hard-reset.
      const indexTree = git(exact.workspaceRealpath, ['write-tree']).toLowerCase();
      const frozenBaseTree = git(exact.workspaceRealpath, ['rev-parse', `${exact.baseSha}^{tree}`]).toLowerCase();
      const mergeTree = git(exact.workspaceRealpath, ['rev-parse', `${mergeSha}^{tree}`]).toLowerCase();
      const unstagedClean = tryGit(exact.workspaceRealpath, ['diff-files', '--quiet']).ok;
      const untracked = git(exact.workspaceRealpath, ['ls-files', '--others', '--exclude-standard']);
      if (!unstagedClean || untracked !== '') {
        throw new Error('canonical local base recovery found operator worktree changes');
      }
      if (indexTree === mergeTree) return;
      if (indexTree === frozenBaseTree) {
        git(exact.workspaceRealpath, ['reset', '--hard', mergeSha]);
        return;
      }
      throw new Error('canonical local base recovery found operator worktree changes');
    }
    if (current !== exact.baseSha || git(exact.workspaceRealpath, ['status', '--porcelain']) !== '') {
      throw new Error('canonical local base advanced before CAS');
    }
    git(exact.workspaceRealpath, ['update-ref', `refs/heads/${exact.baseBranch}`, mergeSha, exact.baseSha]);
    // Repair the checked-out index/worktree after the atomic ref CAS. A crash
    // here converges through the current===mergeSha branch above.
    git(exact.workspaceRealpath, ['reset', '--hard', mergeSha]);
  });
}

async function ensureReleaseEffects(row: ReleaseIntentRow, posture?: MergeResolutionPosture, resolverEnv: Record<string, string> = {}): Promise<void> {
  let state = steps(row);
  const exact = identity(row);
  const external = row.external_send;
  if (row.merge_strategy === 'direct' && row.auto_merge) {
    if (shouldActuateReleaseStep(state.merge)) {
      await setStep(exact.runId, 'merge', 'processing');
      const merged: MergeResult = await performMerge(
        exact.runId, exact.branchName, exact.workspaceRealpath, posture, resolverEnv, exact,
      );
      if (!merged.success || !isGitSha(merged.mergeCommitSha)) {
        throw new Error(merged.error ?? 'direct merge did not produce an exact commit');
      }
      await setStep(exact.runId, 'merge', 'completed', ', base_before_sha = $4, merge_commit_sha = $5', [exact.baseSha, merged.mergeCommitSha.toLowerCase()]);
    }
    const refreshed = await loadIntent(exact.runId);
    const mergeSha = refreshed?.merge_commit_sha?.toLowerCase();
    if (!mergeSha || !isGitSha(mergeSha)) throw new Error('direct release lacks durable merge SHA');
    state = steps(refreshed!);
    if (external && shouldActuateReleaseStep(state.push)) {
      await setStep(exact.runId, 'push', 'processing');
      await pushExactForTests(exact, mergeSha, exact.baseBranch, exact.baseSha);
      await setStep(exact.runId, 'push', 'completed');
    } else if (!external && shouldActuateReleaseStep(state.push)) await setStep(exact.runId, 'push', 'not_required');
    state = steps((await loadIntent(exact.runId))!);
    if (shouldActuateReleaseStep(state.local_base)) {
      await setStep(exact.runId, 'local_base', 'processing');
      await updateLocalBaseExactForTests(exact, mergeSha);
      await setStep(exact.runId, 'local_base', 'completed');
    }
    state = steps((await loadIntent(exact.runId))!);
    if (shouldActuateReleaseStep(state.pr)) await setStep(exact.runId, 'pr', 'not_required');
  } else if (row.merge_strategy === 'direct') {
    if (shouldActuateReleaseStep(state.merge)) await setStep(exact.runId, 'merge', 'not_required');
    if (shouldActuateReleaseStep(state.push)) await setStep(exact.runId, 'push', 'not_required');
    if (shouldActuateReleaseStep(state.local_base)) await setStep(exact.runId, 'local_base', 'not_required');
    if (shouldActuateReleaseStep(state.pr)) await setStep(exact.runId, 'pr', 'not_required');
  } else {
    if (shouldActuateReleaseStep(state.merge)) await setStep(exact.runId, 'merge', 'not_required');
    if (shouldActuateReleaseStep(state.local_base)) await setStep(exact.runId, 'local_base', 'not_required');
    if (external && shouldActuateReleaseStep(state.push)) {
      if (!exact.providerReleaseRef) throw new Error('non-direct external release lacks unique provider ref');
      await setStep(exact.runId, 'push', 'processing');
      await pushExactForTests(exact, exact.authorizedSha, exact.providerReleaseRef, null);
      await setStep(exact.runId, 'push', 'completed');
    } else if (!external && shouldActuateReleaseStep(state.push)) await setStep(exact.runId, 'push', 'not_required');
    state = steps((await loadIntent(exact.runId))!);
    if (external && (row.merge_strategy === 'pr' || row.merge_strategy === 'draft-pr') && shouldActuateReleaseStep(state.pr)) {
      await setStep(exact.runId, 'pr', 'processing');
      const prNumber = await createOrFinalizePullRequestForTests(row, row.merge_strategy === 'draft-pr');
      const updated = await execute('UPDATE pipeline_runs SET pr_number = $1, pr_creating = FALSE, pr_creation_error = NULL WHERE id = $2', [prNumber, exact.runId]);
      if (updated.rowCount !== 1) throw new Error('PR identity did not bind exact run');
      await setStep(exact.runId, 'pr', 'completed');
    } else if ((row.merge_strategy === 'branch-only' || !external) && shouldActuateReleaseStep(state.pr)) {
      await setStep(exact.runId, 'pr', 'not_required');
    }
  }
  let after = steps((await loadIntent(exact.runId))!);
  if (shouldActuateReleaseStep(after.workflow)) await setStep(exact.runId, 'workflow', 'not_required');
  after = steps((await loadIntent(exact.runId))!);
  if (row.merge_strategy === 'direct' && row.auto_merge
    && shouldActuateReleaseStep(after.integration_cleanup)) {
    await setStep(exact.runId, 'integration_cleanup', 'processing');
    await cleanupIntegrationCheckout(row);
    await setStep(exact.runId, 'integration_cleanup', 'completed');
  } else if (!(row.merge_strategy === 'direct' && row.auto_merge)
    && shouldActuateReleaseStep(after.integration_cleanup)) {
    await setStep(exact.runId, 'integration_cleanup', 'not_required');
  }
}

async function persistTerminalIntent(row: ReleaseIntentRow): Promise<TrustedWalReference> {
  const terminal = await persistTrustedWalEvent({
    eventType: 'run_finished', workspaceId: row.workspace_id, runId: Number(row.run_id), source: 'worker',
    payload: {
      run_id: Number(row.run_id), status: 'done', source: 'host-release-closeout',
      authorized_sha: row.authorized_sha, release_identity_hash: row.identity_hash,
      merge_strategy: row.merge_strategy, deployment_allowed: false,
    },
  });
  const updated = await execute('UPDATE pipeline_run_release_intents SET terminal_event_id = $2, updated_at = NOW() WHERE run_id = $1 AND (terminal_event_id IS NULL OR terminal_event_id = $2)', [Number(row.run_id), terminal.reference.id]);
  if (updated.rowCount !== 1) throw new Error('terminal event identity did not bind exact release intent');
  return terminal.reference;
}

async function loadTerminalIntent(row: ReleaseIntentRow): Promise<TrustedWalReference> {
  if (!row.terminal_event_id) throw new Error('completed terminal-intent step lacks durable event identity');
  const event = await queryOne<TrustedWalRow>('SELECT * FROM wal_events WHERE id = $1', [row.terminal_event_id]);
  if (!event) throw new Error('durable terminal event is absent');
  return trustedWalReference(event);
}

async function commitPublicDoneAndTerminalReady(row: ReleaseIntentRow, terminal: TrustedWalReference): Promise<void> {
  await transaction(async (client) => {
    const run = await client.query(`
      UPDATE pipeline_runs
         SET status = 'done', lifecycle_status = 'finished', finished_at = COALESCE(finished_at, NOW())
       WHERE id = $1 AND workspace_id = $2 AND terminal_checkout_sha = $3
       RETURNING id
    `, [Number(row.run_id), row.workspace_id, row.authorized_sha]);
    const ready = await client.query(`
      UPDATE wal_events SET outbox_ready_at = COALESCE(outbox_ready_at, NOW())
       WHERE id = $1 AND ingest_key = $2 AND event_identity_hash = $3
         AND canonical_run_id = $4 AND workspace_id = $5
         AND trust_provenance = 'host' AND trusted_source = 'worker'
       RETURNING id
    `, [terminal.id, terminal.ingestKey, terminal.identityHash, terminal.runId, terminal.workspaceId]);
    if (run.rowCount !== 1 || ready.rowCount !== 1) throw new Error('public done and exact terminal readiness did not commit atomically');
  });
}

function effectsComplete(state: Record<string, StepStatus>): boolean {
  return ['merge', 'push', 'local_base', 'pr', 'workflow', 'integration_cleanup']
    .every((step) => !shouldActuateReleaseStep(state[step]));
}

export async function reconcileRunReleaseIntent(
  runId: number,
  posture?: MergeResolutionPosture,
  resolverEnv: Record<string, string> = {},
): Promise<RunReleaseResult> {
  let row = await loadIntent(runId);
  if (!row) return { runId, status: 'blocked', error: 'release intent not found' };
  if (row.status === 'completed') return { runId, status: 'completed' };
  let state = steps(row);
  let publicDoneCommitted = state.public_done === 'completed';
  try {
    const exact = identity(row);
    // Preparation is one transaction. Recovery proves the attestation before
    // any external effect; after exact cleanup it uses the immutable terminal pair.
    await revalidateRunReleaseIdentity(exact, {
      requireLiveCheckout: state.cleanup !== 'completed' && !effectsComplete(state),
    });
    const claimed = await execute(`UPDATE pipeline_run_release_intents SET status = 'processing', claimed_at = NOW(), updated_at = NOW() WHERE run_id = $1 AND status != 'completed'`, [runId]);
    if (claimed.rowCount !== 1) throw new Error('release reconciler could not claim exact intent');

    if (!effectsComplete(state)) await ensureReleaseEffects(row, posture, resolverEnv);
    row = (await loadIntent(runId))!;
    state = steps(row);

    if (shouldActuateReleaseStep(state.release_closeout)) {
      await setStep(runId, 'release_closeout', 'processing');
      await execute(`
        INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload, ingest_key)
        VALUES ('run_closeout', $1, $2, 'rorca-host', $3::jsonb, $4)
        ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING
      `, [row.workspace_id, row.spec_id, JSON.stringify({
        run_id: Number(row.run_id), status: 'done', authorized_sha: row.authorized_sha,
        release_identity_hash: row.identity_hash, merge_strategy: row.merge_strategy,
        completion_scope: row.merge_strategy === 'direct' && row.auto_merge ? 'base_integrated' : 'run_branch',
        base_integrated: row.merge_strategy === 'direct' && row.auto_merge, deployment_allowed: false,
      }), `run-release-closeout:v1:${row.identity_hash}`]);
      await setStep(runId, 'release_closeout', 'completed');
    }

    row = (await loadIntent(runId))!;
    state = steps(row);
    let terminal: TrustedWalReference;
    if (shouldActuateReleaseStep(state.terminal_intent)) {
      await setStep(runId, 'terminal_intent', 'processing');
      terminal = await persistTerminalIntent(row);
      await setStep(runId, 'terminal_intent', 'completed');
    } else terminal = await loadTerminalIntent(row);

    row = (await loadIntent(runId))!;
    state = steps(row);
    if (row.merge_strategy === 'direct' && row.auto_merge && shouldActuateReleaseStep(state.cleanup)) {
      await setStep(runId, 'cleanup', 'processing');
      try {
        await cleanupExecutionWorktree(row);
        await setStep(runId, 'cleanup', 'completed');
      } catch (error) {
        await execute(`UPDATE pipeline_runs SET worktree_cleanup_status = 'failed' WHERE id = $1 AND worktree_cleanup_status != 'completed'`, [runId]);
        await setStep(runId, 'cleanup', 'failed');
        throw error;
      }
    } else if (!(row.merge_strategy === 'direct' && row.auto_merge) && shouldActuateReleaseStep(state.cleanup)) {
      await setStep(runId, 'cleanup', 'not_required');
    }

    row = (await loadIntent(runId))!;
    state = steps(row);
    if (shouldActuateReleaseStep(state.public_done)) {
      await setStep(runId, 'public_done', 'processing');
      await commitPublicDoneAndTerminalReady(row, terminal);
      publicDoneCommitted = true;
      await setStep(runId, 'public_done', 'completed');
    }
    if (shouldActuateReleaseStep(state.terminal_relay)) {
      await setStep(runId, 'terminal_relay', 'processing');
      await relayTrustedWalEvent(terminal);
      await setStep(runId, 'terminal_relay', 'completed');
    }
    const completed = await execute(`
      UPDATE pipeline_run_release_intents
         SET status = 'completed', completed_at = COALESCE(completed_at, NOW()), claimed_at = NULL,
             last_error_code = NULL, last_error_message = NULL, updated_at = NOW()
       WHERE run_id = $1 AND status != 'completed'
    `, [runId]);
    if (completed.rowCount !== 1) throw new Error('release completion did not bind exact intent');
    return { runId, status: 'completed' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await execute(`
      UPDATE pipeline_run_release_intents
         SET status = 'pending', claimed_at = NULL,
             last_error_code = 'RELEASE_ACTUATION_DEFERRED',
             last_error_message = $2, updated_at = NOW()
       WHERE run_id = $1 AND status != 'completed'
    `, [runId, message.slice(0, 512)]);
    if (!publicDoneCommitted) {
      await execute(`UPDATE pipeline_runs SET status = 'release_pending', summary = $2 WHERE id = $1 AND status != 'done'`, [runId, `release_deferred:${message.slice(0, 200)}`]);
    }
    return { runId, status: 'blocked', error: message };
  }
}

async function pendingRunIds(limit: number): Promise<number[]> {
  const pending = await query<{ run_id: number | string }>(`
    SELECT run_id FROM pipeline_run_release_intents
     WHERE status IN ('pending', 'processing')
        OR (status = 'blocked' AND terminal_event_id IS NOT NULL)
     ORDER BY updated_at ASC, run_id ASC LIMIT $1
  `, [limit]);
  return pending.map((candidate) => Number(candidate.run_id));
}

export async function reconcilePendingRunReleases(limit = 100): Promise<number> {
  const ids = await pendingRunIds(limit);
  let completed = 0;
  for (const runId of ids) {
    const result = await reconcileRunReleaseIntent(runId);
    if (result.status === 'completed') completed++;
  }
  return completed;
}

/** Drain each extant startup intent once, in bounded batches, before stale classification. */
export async function drainPendingRunReleases(batchSize = 100, globalLimit = 1000): Promise<{ scanned: number; completed: number }> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || !Number.isSafeInteger(globalLimit) || globalLimit <= 0) {
    throw new Error('release drain bounds are invalid');
  }
  const ids = await pendingRunIds(globalLimit + 1);
  if (ids.length > globalLimit) throw new Error('pending release backlog exceeds startup safety bound');
  let completed = 0;
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    for (const runId of ids.slice(offset, offset + batchSize)) {
      const result = await reconcileRunReleaseIntent(runId);
      if (result.status === 'completed') completed++;
    }
  }
  return { scanned: ids.length, completed };
}

export async function loadRunReleaseIdentity(runId: number, expectedSha: string): Promise<RunReleaseIdentity> {
  const row = await loadIntent(runId);
  if (!row || row.authorized_sha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error('reviewed delivery differs from immutable run release identity');
  }
  return identity(row);
}
