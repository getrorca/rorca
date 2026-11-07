/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Forgejo release authority seam (W5-003): mirrors `release-authority.ts` over
 * the Forgejo API. Draft PRs are created host-owned via
 * POST /repos/{owner}/{repo}/pulls (draft:true, "[WIP] {specId}"), recorded in
 * pipeline_run_release_intents with immutable audit, and reconciled/drained
 * without ever granting merge authority.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { execute, query, queryOne, transaction } from '../db/index';
import type { RunHostAuthority } from './run-host-authority';
import { loadHostRunCloseoutReference } from './run-closeout-authority';
import {
  persistTrustedWalEvent,
  relayTrustedWalEvent,
  trustedWalReference,
  type TrustedWalReference,
  type TrustedWalRow,
} from './trusted-wal';
import { isGitSha } from './git-sha';
import { forgejoRepoApiUrl, assertForgejoRef } from './forgejo-repository-authority';
import {
  fetchForgejoWithTimeout,
  getWorkspaceForgejoCredential,
  resolveWorkspaceForgejoToken,
  type ResolvedForgejoToken,
} from './forgejo-token-credential-provider';
import {
  revalidateForgejoRunReleaseIdentity,
  withForgejoReleaseActuation,
  withForgejoRunReleaseLock,
  type ForgejoReleaseActuationContext,
  type ForgejoRunReleaseIdentity,
} from './forgejo-release-identity';
import { sanitizeForgejoProviderException, forgejoProviderError, formatForgejoProviderError } from './forgejo-provider-error';

export type RunMergeStrategy = 'direct' | 'pr' | 'draft-pr' | 'branch-only';
export type RunReleaseStepStatus = 'pending' | 'processing' | 'completed' | 'not_required' | 'failed';
type StepStatus = RunReleaseStepStatus;

export function shouldActuateReleaseStep(status: RunReleaseStepStatus | undefined): boolean {
  return status !== 'completed' && status !== 'not_required';
}

export interface ForgejoPrepareRunReleaseInput {
  runId: number;
  workspaceId: string;
  specId: string;
  authorizedSha: string;
  branchName: string;
  workspaceRealpath: string;
  worktreeRealpath: string;
  baseBranch: string;
  baseSha: string;
  mergeStrategy: RunMergeStrategy;
  autoMerge: false;
  externalSend: boolean;
  expectedDispatchFence?: string | null;
  /** Proposal-bound metadata from the W5-005 federation bridge. */
  proposalHash?: string;
  changedPathManifestHash?: string;
  hostCloseoutEventId?: number | null;
  hostCloseoutIdentityHash?: string | null;
  terminalizeRun?: boolean;
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
  repository_authority_source: 'forgejo-token' | null;
  repository_binding_id: string | null;
  repository_id: number | string | null;
  repository_instance_url: string | null;
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
  proposal_hash: string | null;
  changed_path_manifest_hash: string | null;
  dispatch_fence: string | null;
  terminal_event_id: number | string | null;
  host_closeout_event_id: number | string | null;
  host_closeout_identity_hash: string | null;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function identityHash(
  identityValue: ForgejoRunReleaseIdentity,
  input: ForgejoPrepareRunReleaseInput,
): string {
  return crypto.createHash('sha256').update(stable({
    version: 2,
    ...identityValue,
    mergeStrategy: input.mergeStrategy,
    autoMerge: input.autoMerge,
    externalSend: input.externalSend,
    deploymentAllowed: false,
    proposalHash: input.proposalHash ?? null,
    changedPathManifestHash: input.changedPathManifestHash ?? null,
    hostCloseoutEventId: input.hostCloseoutEventId ?? null,
    hostCloseoutIdentityHash: input.hostCloseoutIdentityHash ?? null,
    terminalizeRun: input.terminalizeRun === true,
  })).digest('hex');
}

function steps(row: ReleaseIntentRow): Record<string, StepStatus> {
  const parsed = typeof row.step_state === 'string' ? JSON.parse(row.step_state) as unknown : row.step_state;
  return parsed && !Array.isArray(parsed) && typeof parsed === 'object'
    ? parsed as Record<string, StepStatus>
    : {};
}

function identity(row: ReleaseIntentRow): ForgejoRunReleaseIdentity {
  if (!row.base_branch || !row.base_sha || !row.integration_checkout_path || !isGitSha(row.base_sha)) {
    throw new Error('Forgejo release intent lacks immutable base/path identity');
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
    repository: row.repository_owner && row.repository_name && row.repository_authority_source === 'forgejo-token'
      && row.repository_binding_id
      ? {
        instanceUrl: row.repository_instance_url ?? '',
        owner: row.repository_owner,
        name: row.repository_name,
        source: 'forgejo-token',
        bindingId: row.repository_binding_id,
        repositoryId: row.repository_id == null ? null : Number(row.repository_id),
      }
      : null,
  };
}

async function loadIntent(runId: number): Promise<ReleaseIntentRow | undefined> {
  return queryOne<ReleaseIntentRow>(`
    SELECT run_id, workspace_id, spec_id, authorized_sha, branch_name,
           execution_workspace_path, execution_worktree_path,
           repository_owner, repository_name, repository_authority_source,
           repository_binding_id, repository_id, repository_instance_url,
           merge_strategy, auto_merge, external_send, identity_hash, status,
           step_state, base_branch, base_sha, provider_release_ref,
           integration_checkout_path, proposal_hash, changed_path_manifest_hash,
           dispatch_fence, terminal_event_id, host_closeout_event_id,
           host_closeout_identity_hash
      FROM pipeline_run_release_intents
     WHERE run_id = $1
  `, [runId]);
}

function needsRepository(input: ForgejoPrepareRunReleaseInput): boolean {
  return input.externalSend && (input.mergeStrategy !== 'direct' || input.autoMerge);
}

function providerReleaseRef(runId: number, sha: string): string {
  return `ssdlc/run-${runId}-${sha.slice(0, 12)}`;
}

export function integrationPath(workspaceRealpath: string, runId: number, authorizedSha: string): string {
  const digest = crypto.createHash('sha256').update(`${workspaceRealpath}\0${runId}\0${authorizedSha}`).digest('hex');
  return path.join(os.tmpdir(), `rorca-forgejo-release-integration-${digest}`);
}

function assertCleanCanonicalBase(workspace: string, branch: string, expectedSha: string): void {
  void workspace; void branch; void expectedSha;
  // The canonical base is frozen from the identity passed by the caller (host
  // authority or federation bridge); Forgejo projection performs no local
  // merge, so no git worktree assertion is needed here.
}

function providerRefSha(
  authority: { instanceUrl: string; owner: string; name: string },
  token: string,
  branch: string,
): Promise<string | null> {
  assertForgejoRef(branch);
  return fetchProviderRefSha(authority, token, branch);
}

async function fetchProviderRefSha(
  authority: { instanceUrl: string; owner: string; name: string },
  token: string,
  branch: string,
): Promise<string | null> {
  const suffix = `/branches/${branch.split('/').map(encodeURIComponent).join('/')}`;
  const response = await fetchForgejoWithTimeout(fetch,
    forgejoRepoApiUrl(authority.instanceUrl, authority.owner, authority.name, suffix),
    { headers: forgejoHeaders(token) });
  if (response.status === 404) return null;
  if (!response.ok) throw forgejoProviderError(response, 'FORGEJO_RELEASE_REF_LOOKUP_FAILED');
  const body = await response.json().catch(() => null) as { commit?: { id?: unknown } } | null;
  const sha = typeof body?.commit?.id === 'string' ? body.commit.id.toLowerCase() : null;
  if (!isGitSha(sha)) throw new Error('Forgejo provider ref lookup returned an indeterminate SHA');
  return sha;
}

function forgejoHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Rorca-Worker',
  };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim();
}

export interface ForgejoHostPrepareRunReleaseInput {
  hostAuthority: RunHostAuthority;
  mergeStrategy: RunMergeStrategy;
  autoMerge: boolean;
  externalSend: boolean;
  expectedDispatchFence?: string | null;
}

export async function prepareForgejoHostRunReleaseIntent(
  input: ForgejoHostPrepareRunReleaseInput,
): Promise<ForgejoRunReleaseIdentity> {
  if (input.autoMerge) throw new Error('Forgejo release authority grants no merge capability');
  const authority = input.hostAuthority;
  if (!authority.releaseEligible || !isGitSha(authority.finalCommitSha)) {
    throw new Error('complete exact host authority is required before Forgejo release preparation');
  }
  const closeout = await loadHostRunCloseoutReference(authority.runId);
  if (closeout.payload.status !== 'done'
    || closeout.payload.integrated_revision !== authority.finalCommitSha
    || closeout.payload.accepted_story_ids.length !== authority.expectedStoryIds.length
    || authority.expectedStoryIds.some((storyId) => !closeout.payload.accepted_story_ids.includes(storyId))) {
    throw new Error('canonical host closeout does not bind exact successful Forgejo run authority');
  }
  const workspaceRealpath = fs.realpathSync(authority.repositoryTopLevel);
  const worktreeRealpath = fs.realpathSync(authority.checkoutPath);
  const baseBranch = git(workspaceRealpath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const baseSha = git(workspaceRealpath, ['rev-parse', `refs/heads/${baseBranch}^{commit}`]).toLowerCase();
  return prepareForgejoRunReleaseIntent({
    runId: authority.runId,
    workspaceId: authority.workspaceId,
    specId: authority.specId,
    authorizedSha: authority.finalCommitSha,
    branchName: authority.branchName,
    workspaceRealpath,
    worktreeRealpath,
    baseBranch,
    baseSha,
    mergeStrategy: input.mergeStrategy,
    autoMerge: false,
    externalSend: input.externalSend,
    expectedDispatchFence: input.expectedDispatchFence,
    hostCloseoutEventId: closeout.reference.id,
    hostCloseoutIdentityHash: closeout.reference.identityHash,
    terminalizeRun: true,
  });
}

export async function prepareForgejoRunReleaseIntent(input: ForgejoPrepareRunReleaseInput): Promise<ForgejoRunReleaseIdentity> {
  if (input.autoMerge) {
    throw new Error('Forgejo release authority grants no merge capability');
  }
  if (!isGitSha(input.authorizedSha) || !isGitSha(input.baseSha)) {
    throw new Error('Forgejo release requires exact 40-hex head and base SHAs');
  }
  if (input.terminalizeRun
    && (!input.hostCloseoutEventId || !input.hostCloseoutIdentityHash || !input.expectedDispatchFence)) {
    throw new Error('host-owned Forgejo release requires closeout identity and dispatch fence');
  }
  let repository: ForgejoRunReleaseIdentity['repository'] = null;
  if (needsRepository(input)) {
    const binding = await getWorkspaceForgejoCredential(input.workspaceId);
    if (!binding || binding.status !== 'active') {
      throw new Error('canonical Forgejo repository authority is unavailable');
    }
    repository = {
      instanceUrl: binding.instanceUrl,
      owner: binding.owner,
      name: binding.name,
      source: 'forgejo-token',
      bindingId: binding.bindingId,
      repositoryId: Number(binding.scopeProfile.repositoryId ?? null) || null,
    };
  }

  assertCleanCanonicalBase(input.workspaceRealpath, input.baseBranch, input.baseSha);
  const exact: ForgejoRunReleaseIdentity = {
    runId: input.runId,
    workspaceId: input.workspaceId,
    specId: input.specId,
    authorizedSha: input.authorizedSha.toLowerCase(),
    branchName: input.branchName,
    workspaceRealpath: input.workspaceRealpath,
    worktreeRealpath: input.worktreeRealpath,
    baseBranch: input.baseBranch,
    baseSha: input.baseSha.toLowerCase(),
    providerReleaseRef: repository && input.mergeStrategy !== 'direct'
      ? providerReleaseRef(input.runId, input.authorizedSha.toLowerCase())
      : null,
    integrationCheckoutPath: integrationPath(input.workspaceRealpath, input.runId, input.authorizedSha.toLowerCase()),
    repository,
  };

  await withForgejoRunReleaseLock(exact, async () => {
    await revalidateForgejoRunReleaseIdentity(exact, { requireLiveCheckout: input.terminalizeRun === true });
    if (repository) {
      const binding = await getWorkspaceForgejoCredential(input.workspaceId);
      if (!binding || binding.status !== 'active'
        || binding.instanceUrl.replace(/\/+$/, '') !== repository.instanceUrl.replace(/\/+$/, '')
        || binding.owner.toLowerCase() !== repository.owner.toLowerCase()
        || binding.name.toLowerCase() !== repository.name.toLowerCase()
        || binding.bindingId !== repository.bindingId) {
        throw new Error('canonical Forgejo credential changed before release intent freeze');
      }
    }

    const digest = identityHash(exact, input);
    await transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`forgejo-release-intent:${input.runId}`]);
      const existing = (await client.query<{ identity_hash: string }>(
        'SELECT identity_hash FROM pipeline_run_release_intents WHERE run_id = $1 FOR SHARE',
        [input.runId],
      )).rows[0];
      if (existing && existing.identity_hash !== digest) {
        throw new Error('run already has a different immutable Forgejo release intent');
      }
      if (!existing) {
        await client.query(`
          INSERT INTO pipeline_run_release_intents (
            run_id, workspace_id, spec_id, authorized_sha, branch_name,
            execution_workspace_path, execution_worktree_path,
            repository_owner, repository_name, repository_authority_source,
            repository_binding_id, repository_id, repository_instance_url,
            merge_strategy, auto_merge, external_send, deployment_allowed,
            identity_hash, status, step_state, base_branch, base_sha,
            provider_release_ref, integration_checkout_path, dispatch_fence,
            proposal_hash, changed_path_manifest_hash,
            host_closeout_event_id, host_closeout_identity_hash
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,'forgejo-token',$10,$11,$12,$13,FALSE,$14,FALSE,
            $15,'pending','{}'::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$24
          )
        `, [
          exact.runId, exact.workspaceId, exact.specId, exact.authorizedSha, exact.branchName,
          exact.workspaceRealpath, exact.worktreeRealpath,
          repository?.owner ?? null, repository?.name ?? null,
          repository?.bindingId ?? null, repository?.repositoryId ?? null, repository?.instanceUrl ?? null,
          input.mergeStrategy, input.externalSend, digest,
          exact.baseBranch, exact.baseSha, exact.providerReleaseRef, exact.integrationCheckoutPath,
          input.expectedDispatchFence ?? null, input.proposalHash ?? null, input.changedPathManifestHash ?? null,
          input.hostCloseoutEventId ?? null, input.hostCloseoutIdentityHash ?? null,
        ]);
      }
      if (input.terminalizeRun) {
        const run = await client.query(`
          UPDATE pipeline_runs
             SET terminal_checkout_sha = COALESCE(terminal_checkout_sha, $2),
                 terminal_checkout_attested_at = COALESCE(terminal_checkout_attested_at, NOW()),
                 status = CASE WHEN status = 'done' THEN status ELSE 'release_pending' END
           WHERE id = $1 AND workspace_id = $3
             AND execution_workspace_path = $4 AND execution_worktree_path = $5
             AND dispatch_fence = $6
             AND status IN ('starting','running','validating','release_pending','done')
             AND (terminal_checkout_sha IS NULL OR terminal_checkout_sha = $2)
           RETURNING id
        `, [
          exact.runId, exact.authorizedSha, exact.workspaceId,
          exact.workspaceRealpath, exact.worktreeRealpath, input.expectedDispatchFence,
        ]);
        if (run.rowCount !== 1) {
          throw new Error('Forgejo terminal checkout attestation/release_pending transition did not bind exact run');
        }
      }
    });
  });
  return exact;
}

export async function pushExactForgejoRelease(
  identityValue: ForgejoRunReleaseIdentity,
  sha: string,
  branch: string,
  expectedRemoteSha: string | null,
): Promise<void> {
  if (!isGitSha(sha)) throw new Error('Forgejo push SHA is invalid');
  await withForgejoReleaseActuation(identityValue, 'routine', async ({ identity: exact, credential }) => {
    const authority = {
      instanceUrl: credential.metadata.instanceUrl,
      owner: credential.metadata.owner,
      name: credential.metadata.name,
    };
    const before = await providerRefSha(authority, credential.token, branch);
    if (before === sha) return;
    if (before !== expectedRemoteSha) throw new Error('Forgejo provider ref advanced before exact CAS push');
    await revalidateForgejoRunReleaseIdentity(exact);
    const askpassDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-forgejo-release-askpass-'));
    const askpass = path.join(askpassDir, 'askpass.sh');
    fs.writeFileSync(
      askpass,
      '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "rorca-release";; *) printf "%s\\n" "$RORCA_RELEASE_TOKEN";; esac\n',
      { mode: 0o700 },
    );
    try {
      const lease = `--force-with-lease=refs/heads/${branch}:${expectedRemoteSha ?? ''}`;
      const remote = `${authority.instanceUrl.replace(/\/+$/, '')}/${authority.owner}/${authority.name}.git`;
      const result = spawnSync('git', [
        '-c', 'credential.helper=',
        '-c', `core.askPass=${askpass}`,
        'push', lease, remote, `${sha}:refs/heads/${branch}`,
      ], {
        cwd: exact.workspaceRealpath,
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
      if (result.status !== 0) {
        throw new Error(`exact Forgejo release CAS push failed (${result.status ?? 'signal'})`);
      }
    } finally {
      fs.rmSync(askpassDir, { recursive: true, force: true });
    }
    const after = await providerRefSha(authority, credential.token, branch);
    if (after !== sha) throw new Error('Forgejo provider ref raced during exact CAS push; release quarantined');
  });
}

interface ForgejoPullRequest {
  number?: number;
  html_url?: string;
  draft?: boolean;
  state?: string;
  head?: { sha?: string; ref?: string; repo?: { id?: number; full_name?: string } };
  base?: { sha?: string; ref?: string; repo?: { id?: number; full_name?: string } };
}

async function fetchPullRequest(
  authority: { instanceUrl: string; owner: string; name: string },
  token: string,
  number: number,
): Promise<ForgejoPullRequest> {
  const response = await fetchForgejoWithTimeout(fetch,
    forgejoRepoApiUrl(authority.instanceUrl, authority.owner, authority.name, `/pulls/${number}`),
    { headers: forgejoHeaders(token) });
  if (!response.ok) throw forgejoProviderError(response, 'FORGEJO_RELEASE_PR_VERIFY_FAILED');
  return response.json() as Promise<ForgejoPullRequest>;
}

function assertCanonicalForgejoPullRequest(
  pr: ForgejoPullRequest,
  exact: ForgejoRunReleaseIdentity,
  authority: { instanceUrl: string; owner: string; name: string },
  expectedNumber: number,
  draft: boolean,
): void {
  const fullName = `${authority.owner}/${authority.name}`.toLowerCase();
  const baseUrl = authority.instanceUrl.replace(/\/+$/, '');
  if (pr.number !== expectedNumber
    || pr.html_url !== `${baseUrl}/${authority.owner}/${authority.name}/pulls/${expectedNumber}`
    || pr.state !== 'open'
    || typeof pr.draft !== 'boolean'
    || pr.draft !== draft
    || pr.head?.sha?.toLowerCase() !== exact.authorizedSha
    || pr.head?.ref !== exact.providerReleaseRef
    || pr.head?.repo?.full_name?.toLowerCase() !== fullName
    || pr.base?.sha?.toLowerCase() !== exact.baseSha
    || pr.base?.ref !== exact.baseBranch
    || pr.base?.repo?.full_name?.toLowerCase() !== fullName
    || (exact.repository?.repositoryId != null
      && (Number(pr.head?.repo?.id) !== exact.repository.repositoryId
        || Number(pr.base?.repo?.id) !== exact.repository.repositoryId))) {
    throw new Error('Forgejo pull request differs from immutable release authority');
  }
}

async function quarantineForgejoPullRequest(
  authority: { instanceUrl: string; owner: string; name: string },
  token: string,
  number: number,
): Promise<void> {
  const response = await fetchForgejoWithTimeout(fetch,
    forgejoRepoApiUrl(authority.instanceUrl, authority.owner, authority.name, `/pulls/${number}`), {
      method: 'PATCH', headers: forgejoHeaders(token), body: JSON.stringify({ state: 'closed' }),
    });
  if (!response.ok) throw new Error('raced Forgejo pull request could not be quarantined');
}

async function assertExactProviderHead(
  exact: ForgejoRunReleaseIdentity,
  authority: { instanceUrl: string; owner: string; name: string },
  credential: ResolvedForgejoToken,
): Promise<void> {
  if (!exact.providerReleaseRef) throw new Error('Forgejo release has no uniquely owned provider ref');
  const providerHead = await providerRefSha(authority, credential.token, exact.providerReleaseRef);
  if (providerHead !== exact.authorizedSha) {
    throw new Error('Forgejo provider release ref differs from exact authorized SHA');
  }
}

export async function createOrFinalizeForgejoPullRequest(
  identityValue: ForgejoRunReleaseIdentity,
  draft: boolean,
): Promise<number> {
  return withForgejoReleaseActuation(identityValue, 'pulls-write', async ({ identity: exact, credential }) => {
    const authority = { instanceUrl: credential.metadata.instanceUrl, owner: credential.metadata.owner, name: credential.metadata.name };
    await assertExactProviderHead(exact, authority, credential);
    const head = `${authority.owner}:${exact.providerReleaseRef}`;
    const lookup = await fetchForgejoWithTimeout(fetch,
      forgejoRepoApiUrl(authority.instanceUrl, authority.owner, authority.name,
        `/pulls?head=${encodeURIComponent(head)}&state=all&limit=10`),
      { headers: forgejoHeaders(credential.token) });
    if (!lookup.ok) throw forgejoProviderError(lookup, 'FORGEJO_RELEASE_PR_LOOKUP_FAILED');
    const existing = await lookup.json().catch(() => null) as ForgejoPullRequest[] | null;
    if (!Array.isArray(existing)) throw new Error('Forgejo pull request lookup response shape was indeterminate');
    const owned = existing.filter((pr) => pr.head?.ref === exact.providerReleaseRef && Number.isSafeInteger(pr.number));
    if (owned.some((pr) => pr.state !== 'open' && pr.state !== 'closed')) {
      throw new Error('run-owned Forgejo pull request state was indeterminate');
    }
    const open = owned.filter((pr) => pr.state === 'open');
    if (open.length > 1) throw new Error('multiple open Forgejo pull requests share the unique release ref');
    let pr: ForgejoPullRequest | undefined;
    if (open[0]) {
      const number = Number(open[0].number);
      pr = await fetchPullRequest(authority, credential.token, number);
      try { assertCanonicalForgejoPullRequest(pr, exact, authority, number, draft); }
      catch {
        await quarantineForgejoPullRequest(authority, credential.token, number);
        throw new Error('recovered Forgejo pull request differs from immutable release authority; quarantined');
      }
    }
    if (!pr) {
      await assertExactProviderHead(exact, authority, credential); // immediately before mutation
      const created = await fetchForgejoWithTimeout(fetch,
        forgejoRepoApiUrl(authority.instanceUrl, authority.owner, authority.name, '/pulls'), {
          method: 'POST', headers: forgejoHeaders(credential.token), body: JSON.stringify({
            title: draft ? `[WIP] ${exact.specId}` : `feat: ${exact.specId}`,
            head: exact.providerReleaseRef,
            base: exact.baseBranch,
            draft,
            body: `Rorca run #${exact.runId}; exact authorized head ${exact.authorizedSha}.`,
          }),
        });
      if (!created.ok) throw forgejoProviderError(created, 'FORGEJO_RELEASE_PR_CREATE_FAILED');
      const createdPr = await created.json().catch(() => null) as ForgejoPullRequest | null;
      if (!Number.isSafeInteger(createdPr?.number)) {
        throw new Error('Forgejo pull request create response omitted its identity');
      }
      const verified = await fetchPullRequest(authority, credential.token, Number(createdPr!.number));
      try { assertCanonicalForgejoPullRequest(verified, exact, authority, Number(createdPr!.number), draft); }
      catch {
        await quarantineForgejoPullRequest(authority, credential.token, Number(createdPr!.number));
        throw new Error('created Forgejo pull request differs from immutable release authority; quarantined');
      }
      pr = verified;
    }
    if (!Number.isSafeInteger(pr?.number)) throw new Error('Forgejo pull request identity was not returned');
    const number = Number(pr!.number);
    await execute(`UPDATE pipeline_run_release_intents SET step_state = jsonb_set(step_state, '{draft_pr}', $2::jsonb, TRUE)
                    WHERE run_id = $1`, [exact.runId, JSON.stringify({ number, headSha: exact.authorizedSha })]);
    return number;
  });
}

async function setStep(runId: number, step: string, status: StepStatus): Promise<void> {
  const result = await execute(`
    UPDATE pipeline_run_release_intents
       SET step_state = jsonb_set(step_state, $2::text[], to_jsonb($3::text), TRUE), updated_at = NOW()
     WHERE run_id = $1
  `, [runId, `{${step}}`, status]);
  if (result.rowCount !== 1) throw new Error('Forgejo release step did not bind exact intent');
}

async function persistForgejoTerminalIntent(row: ReleaseIntentRow): Promise<TrustedWalReference> {
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
      host_closeout_event_id: Number(row.host_closeout_event_id),
      host_closeout_identity_hash: row.host_closeout_identity_hash,
      merge_strategy: row.merge_strategy,
      completion_scope: 'run_branch',
      base_integrated: false,
      branch_name: row.branch_name,
      semantic_closeout: true,
      deployment_allowed: false,
      release_provider: 'forgejo',
    },
  });
  const updated = await execute(`
    UPDATE pipeline_run_release_intents
       SET terminal_event_id = $2, updated_at = NOW()
     WHERE run_id = $1 AND (terminal_event_id IS NULL OR terminal_event_id = $2)
  `, [Number(row.run_id), terminal.reference.id]);
  if (updated.rowCount !== 1) throw new Error('Forgejo terminal event identity did not bind exact release intent');
  return terminal.reference;
}

async function loadForgejoTerminalIntent(row: ReleaseIntentRow): Promise<TrustedWalReference> {
  if (!row.terminal_event_id) throw new Error('completed Forgejo terminal-intent step lacks durable event identity');
  const event = await queryOne<TrustedWalRow>('SELECT * FROM wal_events WHERE id = $1', [Number(row.terminal_event_id)]);
  if (!event) throw new Error('durable Forgejo terminal event is absent');
  return trustedWalReference(event);
}

async function commitForgejoPublicDoneAndTerminalReady(
  row: ReleaseIntentRow,
  terminal: TrustedWalReference,
): Promise<void> {
  await transaction(async (client) => {
    const run = await client.query(`
      UPDATE pipeline_runs
         SET status = 'done', lifecycle_status = 'finished',
             pid = NULL, finished_at = COALESCE(finished_at, NOW())
       WHERE id = $1 AND workspace_id = $2 AND terminal_checkout_sha = $3
         AND dispatch_fence = $4 AND status = 'release_pending'
       RETURNING id
    `, [Number(row.run_id), row.workspace_id, row.authorized_sha, row.dispatch_fence]);
    if (!row.host_closeout_event_id || !row.host_closeout_identity_hash) {
      throw new Error('Forgejo release intent lacks immutable host closeout identity');
    }
    const ready = await client.query(`
      UPDATE wal_events SET outbox_ready_at = COALESCE(outbox_ready_at, NOW())
       WHERE (
         (id = $1 AND ingest_key = $2 AND event_identity_hash = $3)
         OR (id = $6 AND event_identity_hash = $7 AND event_type = 'run_closeout')
       )
         AND canonical_run_id = $4 AND workspace_id = $5
         AND trust_provenance = 'host' AND trusted_source = 'worker'
       RETURNING id
    `, [
      terminal.id, terminal.ingestKey, terminal.identityHash, terminal.runId, terminal.workspaceId,
      Number(row.host_closeout_event_id), row.host_closeout_identity_hash,
    ]);
    if (run.rowCount !== 1 || ready.rowCount !== 2) {
      throw new Error('Forgejo public done, closeout, and terminal readiness did not commit atomically');
    }
  });
}

export async function reconcileForgejoRunReleaseIntent(runId: number): Promise<{ runId: number; status: 'completed' | 'blocked'; error?: string }> {
  let row = await loadIntent(runId);
  if (!row) return { runId, status: 'blocked', error: 'Forgejo release intent not found' };
  if (row.status === 'completed') return { runId, status: 'completed' };
  const exact = identity(row);
  const external = row.external_send;
  try {
    await revalidateForgejoRunReleaseIdentity(exact, { requireLiveCheckout: row.host_closeout_event_id != null });
    await transaction(async (client) => {
      const claimed = await client.query(`
        UPDATE pipeline_run_release_intents
           SET status = 'processing', claimed_at = NOW(), updated_at = NOW()
         WHERE run_id = $1 AND status != 'completed'
      `, [runId]);
      if (claimed.rowCount !== 1) throw new Error('Forgejo release reconciler could not claim exact intent');
    });

    row = (await loadIntent(runId))!;
    let state = steps(row);
    if (row.host_closeout_event_id && external && row.merge_strategy !== 'direct' && shouldActuateReleaseStep(state.push)) {
      if (!exact.providerReleaseRef) throw new Error('Forgejo external release lacks a unique provider ref');
      await setStep(runId, 'push', 'processing');
      await pushExactForgejoRelease(exact, exact.authorizedSha, exact.providerReleaseRef, null);
      await setStep(runId, 'push', 'completed');
    } else if (shouldActuateReleaseStep(state.push)) {
      await setStep(runId, 'push', 'not_required');
    }

    row = (await loadIntent(runId))!;
    state = steps(row);
    if (row.merge_strategy === 'draft-pr' && external && shouldActuateReleaseStep(state.pr)) {
      await setStep(runId, 'pr', 'processing');
      const number = await createOrFinalizeForgejoPullRequest(exact, true);
      const updated = await execute(`
        UPDATE pipeline_runs
           SET pr_number = $1, pr_creating = FALSE, pr_creation_error = NULL
         WHERE id = $2 AND (pr_number IS NULL OR pr_number = $1)
      `, [number, runId]);
      if (updated.rowCount !== 1) throw new Error('Forgejo PR identity did not bind exact run');
      await setStep(runId, 'pr', 'completed');
      await execute(`
        UPDATE forgejo_federation_projections
           SET draft_pr_number = $2, status = 'projected', updated_at = NOW()
         WHERE intent_run_id = $1 AND status = 'pending'
      `, [runId, number]);
    } else if (shouldActuateReleaseStep(state.pr)) {
      await setStep(runId, 'pr', 'not_required');
    }

    row = (await loadIntent(runId))!;
    state = steps(row);
    for (const step of ['merge', 'local_base', 'workflow', 'integration_cleanup', 'cleanup']) {
      if (shouldActuateReleaseStep(state[step])) await setStep(runId, step, 'not_required');
    }

    row = (await loadIntent(runId))!;
    if (row.host_closeout_event_id && row.host_closeout_identity_hash) {
      state = steps(row);
      if (shouldActuateReleaseStep(state.release_closeout)) {
        await setStep(runId, 'release_closeout', 'processing');
        const closeout = await loadHostRunCloseoutReference(runId);
        if (closeout.reference.id !== Number(row.host_closeout_event_id)
          || closeout.reference.identityHash !== row.host_closeout_identity_hash
          || closeout.payload.status !== 'done'
          || closeout.payload.integrated_revision !== row.authorized_sha) {
          throw new Error('canonical host closeout differs from immutable Forgejo release intent');
        }
        await setStep(runId, 'release_closeout', 'completed');
      }

      row = (await loadIntent(runId))!;
      state = steps(row);
      let terminal: TrustedWalReference;
      if (shouldActuateReleaseStep(state.terminal_intent)) {
        await setStep(runId, 'terminal_intent', 'processing');
        terminal = await persistForgejoTerminalIntent(row);
        await setStep(runId, 'terminal_intent', 'completed');
      } else {
        terminal = await loadForgejoTerminalIntent(row);
      }

      row = (await loadIntent(runId))!;
      state = steps(row);
      if (shouldActuateReleaseStep(state.public_done)) {
        await setStep(runId, 'public_done', 'processing');
        await commitForgejoPublicDoneAndTerminalReady(row, terminal);
        await setStep(runId, 'public_done', 'completed');
      }
      row = (await loadIntent(runId))!;
      state = steps(row);
      if (shouldActuateReleaseStep(state.terminal_relay)) {
        await setStep(runId, 'terminal_relay', 'processing');
        await relayTrustedWalEvent(terminal);
        await setStep(runId, 'terminal_relay', 'completed');
      }
    }

    await transaction(async (client) => {
      const completed = await client.query(`
        UPDATE pipeline_run_release_intents
           SET status = 'completed', completed_at = COALESCE(completed_at, NOW()),
               claimed_at = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = NOW()
         WHERE run_id = $1 AND status != 'completed'
      `, [runId]);
      if (completed.rowCount !== 1) throw new Error('Forgejo release completion did not bind exact intent');
    });
    return { runId, status: 'completed' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await execute(`
      UPDATE pipeline_run_release_intents
         SET status = 'pending', claimed_at = NULL,
             last_error_code = 'FORGEJO_RELEASE_ACTUATION_DEFERRED',
             last_error_message = $2, updated_at = NOW()
       WHERE run_id = $1 AND status != 'completed'
    `, [runId, message.slice(0, 512)]);
    return { runId, status: 'blocked', error: message };
  }
}

export async function reconcilePendingForgejoRunReleases(limit = 100): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError('Invalid Forgejo release reconciliation limit');
  const rows = await query<{ run_id: number | string }>(`
    SELECT run_id FROM pipeline_run_release_intents
     WHERE repository_authority_source = 'forgejo-token'
       AND status IN ('pending', 'processing')
     ORDER BY updated_at ASC
     LIMIT $1
  `, [limit]);
  let completed = 0;
  for (const row of rows) {
    const result = await reconcileForgejoRunReleaseIntent(Number(row.run_id));
    if (result.status === 'completed') completed++;
  }
  return completed;
}

export async function drainForgejoPendingRunReleases(batchSize = 100, globalLimit = 1000): Promise<{ scanned: number; completed: number }> {
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || !Number.isSafeInteger(globalLimit) || globalLimit <= 0) {
    throw new Error('Forgejo release drain bounds are invalid');
  }
  const rows = await query<{ run_id: number | string }>(`
    SELECT run_id FROM pipeline_run_release_intents
     WHERE repository_authority_source = 'forgejo-token'
       AND status IN ('pending', 'processing')
     ORDER BY updated_at ASC
     LIMIT $1
  `, [globalLimit + 1]);
  if (rows.length > globalLimit) throw new Error('pending Forgejo release backlog exceeds startup safety bound');
  let completed = 0;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    for (const row of rows.slice(offset, offset + batchSize)) {
      const result = await reconcileForgejoRunReleaseIntent(Number(row.run_id));
      if (result.status === 'completed') completed++;
    }
  }
  return { scanned: rows.length, completed };
}

export async function loadForgejoRunReleaseIdentity(runId: number, expectedSha: string): Promise<ForgejoRunReleaseIdentity> {
  const row = await loadIntent(runId);
  if (!row || row.authorized_sha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error('reviewed delivery differs from immutable Forgejo run release identity');
  }
  return identity(row);
}

/** Provider-neutral sanitization re-export for consistent error handling. */
export { sanitizeForgejoProviderException, formatForgejoProviderError };

export type ForgejoReleaseActuationContextExport = ForgejoReleaseActuationContext;
