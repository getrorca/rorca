/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Host-only, generation-fenced story attempt evidence. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { PoolClient } from 'pg';
import { transaction } from '../db/index';
import { ConflictError } from './errors';
import { retryHash } from './retry-governance';
import {
  deriveStoryContractRevision,
  type ImmutableStoryExecutionManifest,
} from './story-execution-packet';
import { assertNotProtectedWave1Run } from './wave-1-stabilization';

export const HOST_STORY_ATTEMPT_ENVELOPE_VERSION = 'rorca.host-story-attempt-envelope.v1' as const;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export type HostAttemptOutcome = 'success' | 'nonzero_exit' | 'timeout' | 'cancelled' | 'crash';
export type HostAttemptOutcomeProvenance = 'host_process' | 'host_timeout' | 'host_cancellation' | 'host_recovery';

export interface HostAttemptRuntimeIdentity {
  processRole: 'worker-engine' | 'story-provider';
  workerId: string;
  engineEntrypoint: string;
  agent: string;
  model: string | null;
  terminalMode: string;
  processPid: number;
}

export interface HostAttemptLaunchInput {
  workspaceId: string;
  runId: number;
  launchGeneration: string;
  cancellationFence: string;
  canonicalSpecPath: string;
  runSpecPath: string;
  repositoryPath: string;
  worktreePath: string;
  /** Host-observed authority captured immediately before this distinct provider spawn. */
  expectedGitSha: string;
  expectedGitBranch: string;
  runtime: HostAttemptRuntimeIdentity;
  manifests: readonly ImmutableStoryExecutionManifest[];
}

export interface HostAttemptLaunchReceipt {
  runId: number;
  launchGeneration: string;
  inserted: number;
  replayed: number;
  envelopeIds: string[];
}

interface AttemptRow {
  envelope_id: string;
  workspace_id: string;
  run_id: number | string;
  story_id: string;
  attempt: number;
  launch_generation: string;
  cancellation_fence: string;
  manifest_hash: string;
  spec_revision: string;
  canonical_spec_path: string;
  canonical_spec_revision: string | null;
  canonical_spec_bytes_hash: string | null;
  run_spec_revision: string | null;
  run_spec_bytes_hash: string | null;
  base_git_sha: string;
  expected_git_sha: string | null;
  observed_git_sha: string;
  expected_git_branch: string | null;
  worktree_branch: string;
  worktree_realpath: string;
  worktree_identity: string;
  repository_realpath: string;
  repository_identity: string;
  identity_hash: string;
  payload_hash: string;
  authority_state: 'valid' | 'conflict';
  outcome: HostAttemptOutcome | null;
  outcome_provenance: HostAttemptOutcomeProvenance | null;
  exit_code: number | null;
  exit_signal: string | null;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'credential.helper=', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch { return false; }
}

function canonicalRelativeSpecPath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || path.posix.isAbsolute(normalized)
    || normalized.split('/').some((segment) => segment === '..')
    || normalized !== path.posix.normalize(normalized)) {
    throw new ConflictError('Host attempt canonical spec path is not an exact workspace-relative path');
  }
  return normalized;
}

function exactSha(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!SHA1.test(normalized)) throw new ConflictError(`${label} is not an exact Git SHA`);
  return normalized;
}

function fileIdentity(realpath: string): string {
  const stat = fs.statSync(realpath);
  return retryHash({ realpath, device: String(stat.dev), inode: String(stat.ino) });
}

interface ObservedJsonFile {
  realpath: string;
  bytesHash: string;
  revision: string;
  parsed: unknown;
}

class HostFileObservationConflict extends Error {
  constructor(
    readonly reasonCode: 'path_escape' | 'path_moved' | 'file_missing' | 'file_unreadable' | 'invalid_json',
    message: string,
  ) {
    super(message);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function observeExactJsonFile(input: {
  expectedPath: string;
  allowedRoot: string;
  label: string;
}): ObservedJsonFile {
  const expectedPath = path.resolve(input.expectedPath);
  const allowedRoot = path.resolve(input.allowedRoot);
  if (!isWithin(allowedRoot, expectedPath)) {
    throw new HostFileObservationConflict('path_escape', `${input.label} expected path escaped its authority root`);
  }
  let realpath: string;
  try {
    realpath = fs.realpathSync(expectedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new HostFileObservationConflict(
      code === 'ENOENT' ? 'file_missing' : 'file_unreadable',
      `${input.label} is ${code === 'ENOENT' ? 'missing' : 'unreadable'} at its exact frozen path`,
    );
  }
  if (realpath !== expectedPath) {
    throw new HostFileObservationConflict('path_moved', `${input.label} moved or traversed a symlink from its exact frozen path`);
  }
  if (!isWithin(allowedRoot, realpath)) {
    throw new HostFileObservationConflict('path_escape', `${input.label} escaped its authority root`);
  }
  let bytes: Buffer;
  try {
    const stat = fs.statSync(realpath);
    if (!stat.isFile()) throw new Error('not a regular file');
    bytes = fs.readFileSync(realpath);
  } catch {
    throw new HostFileObservationConflict('file_unreadable', `${input.label} is not a readable regular file`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')) as unknown; }
  catch { throw new HostFileObservationConflict('invalid_json', `${input.label} bytes are not valid JSON`); }
  return {
    realpath,
    bytesHash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    revision: deriveStoryContractRevision(parsed),
    parsed,
  };
}

function repositoryIdentity(repositoryRealpath: string): { identity: string; membership: string; remote: string | null } {
  const gitCommon = fs.realpathSync(path.resolve(repositoryRealpath, git(repositoryRealpath, ['rev-parse', '--git-common-dir'])));
  let remote: string | null = null;
  try { remote = git(repositoryRealpath, ['remote', 'get-url', 'origin']) || null; } catch { /* local repositories are valid */ }
  return {
    identity: retryHash({ repositoryRealpath, gitCommonRealpath: gitCommon, remote }),
    membership: retryHash({ gitCommonRealpath: gitCommon, remote }),
    remote,
  };
}

function hasCompleteSuccessfulAttemptAuthority(row: AttemptRow): boolean {
  return row.outcome === 'success'
    && row.outcome_provenance === 'host_process'
    && row.exit_code === 0
    && row.exit_signal === null
    && SHA256.test(row.canonical_spec_revision ?? '')
    && SHA256.test(row.canonical_spec_bytes_hash ?? '')
    && SHA256.test(row.run_spec_revision ?? '')
    && SHA256.test(row.run_spec_bytes_hash ?? '')
    && row.spec_revision === row.run_spec_revision
    && SHA1.test(row.base_git_sha)
    && SHA1.test(row.expected_git_sha ?? '')
    && row.observed_git_sha === row.expected_git_sha
    && Boolean(row.expected_git_branch?.trim())
    && row.worktree_branch === row.expected_git_branch;
}
function validateLaunchInput(input: HostAttemptLaunchInput): void {
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0) throw new ConflictError('Host attempt run ID is invalid');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.launchGeneration)) {
    throw new ConflictError('Host attempt launch generation is invalid');
  }
  if (!SHA256.test(input.cancellationFence)) throw new ConflictError('Host attempt cancellation fence is invalid');
  canonicalRelativeSpecPath(input.canonicalSpecPath);
  exactSha(input.expectedGitSha, 'Expected provider-attempt Git revision');
  if (!input.expectedGitBranch.trim()) throw new ConflictError('Expected provider-attempt branch is absent');
  if (input.manifests.length === 0) throw new ConflictError('Host attempt launch requires immutable story manifests');
}

async function recordConflict(client: PoolClient, input: {
  workspaceId: string;
  runId: number;
  storyId: string;
  attempt: number;
  launchGeneration: string;
  existingIdentityHash: string | null;
  conflictingIdentityHash: string;
  reasonCode: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await client.query(`
    INSERT INTO host_story_attempt_conflicts (
      workspace_id, run_id, story_id, attempt, launch_generation,
      existing_identity_hash, conflicting_identity_hash, reason_code, observed_payload
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
  `, [
    input.workspaceId, input.runId, input.storyId, input.attempt, input.launchGeneration,
    input.existingIdentityHash, input.conflictingIdentityHash, input.reasonCode,
    JSON.stringify(input.payload),
  ]);
  // A conflict belongs to the immutable story-attempt identity, not merely to
  // the incoming generation. Poison an unfinished canonical envelope even when
  // the conflict was delivered under a stale generation. Finalized envelopes
  // remain append-only, but every semantic-success selector below excludes any
  // conflict row for the same story attempt.
  await client.query(`
    UPDATE host_story_attempt_envelopes SET authority_state = 'conflict'
     WHERE workspace_id = $1 AND run_id = $2 AND story_id = $3
       AND attempt = $4 AND outcome IS NULL
  `, [input.workspaceId, input.runId, input.storyId, input.attempt]);
}

async function recordLaunchObservationConflicts(
  input: HostAttemptLaunchInput,
  reasonCode: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await transaction(async (client: PoolClient) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`pipeline-run-authority:${input.runId}`],
    );
    for (const manifest of input.manifests) {
      const existing = (await client.query<Pick<AttemptRow, 'identity_hash'>>(`
        SELECT identity_hash FROM host_story_attempt_envelopes
         WHERE workspace_id=$1 AND run_id=$2 AND story_id=$3 AND attempt=$4
         FOR UPDATE
      `, [input.workspaceId, input.runId, manifest.identity.storyId, manifest.identity.attempt])).rows[0];
      await recordConflict(client, {
        workspaceId: input.workspaceId,
        runId: input.runId,
        storyId: manifest.identity.storyId,
        attempt: manifest.identity.attempt,
        launchGeneration: input.launchGeneration,
        existingIdentityHash: existing?.identity_hash ?? null,
        conflictingIdentityHash: retryHash({ reasonCode, payload }),
        reasonCode,
        payload,
      });
    }
  });
}

function storiesFromSpec(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const spec = value as Record<string, unknown>;
  if (Array.isArray(spec.userStories)) {
    return spec.userStories.filter((story): story is Record<string, unknown> =>
      Boolean(story && typeof story === 'object' && !Array.isArray(story)));
  }
  if (!Array.isArray(spec.phases)) return [];
  return spec.phases.flatMap((phase) => {
    if (!phase || typeof phase !== 'object' || Array.isArray(phase)) return [];
    const phaseStories = (phase as Record<string, unknown>).stories;
    return Array.isArray(phaseStories)
      ? phaseStories.filter((story): story is Record<string, unknown> =>
          Boolean(story && typeof story === 'object' && !Array.isArray(story)))
      : [];
  });
}

/**
 * Persist every story launch before the worker releases the engine start gate.
 * Exact duplicate delivery is idempotent; changed content is separately audited
 * and poisons the generation rather than replacing host identity.
 */
export async function persistHostAttemptLaunches(input: HostAttemptLaunchInput): Promise<HostAttemptLaunchReceipt> {
  assertNotProtectedWave1Run(input.runId);
  validateLaunchInput(input);
  const canonicalSpecPath = canonicalRelativeSpecPath(input.canonicalSpecPath);
  let repositoryRealpath: string;
  let worktreeRealpath: string;
  let repository: ReturnType<typeof repositoryIdentity>;
  let worktreeRepository: ReturnType<typeof repositoryIdentity>;
  try {
    repositoryRealpath = fs.realpathSync(input.repositoryPath);
    worktreeRealpath = fs.realpathSync(input.worktreePath);
    repository = repositoryIdentity(repositoryRealpath);
    worktreeRepository = repositoryIdentity(worktreeRealpath);
  } catch (error) {
    await recordLaunchObservationConflicts(input, 'repository_path_unreadable', {
      repositoryPath: path.resolve(input.repositoryPath),
      worktreePath: path.resolve(input.worktreePath),
      observation: error instanceof Error ? error.message : String(error),
    });
    throw new ConflictError('Host attempt repository or worktree path is missing or unreadable');
  }
  if (worktreeRepository.membership !== repository.membership) {
    await transaction(async (client: PoolClient) => {
      for (const manifest of input.manifests) {
        const existing = (await client.query<Pick<AttemptRow, 'identity_hash'>>(`
          SELECT identity_hash FROM host_story_attempt_envelopes
           WHERE workspace_id=$1 AND run_id=$2 AND story_id=$3 AND attempt=$4
           FOR UPDATE
        `, [input.workspaceId, input.runId, manifest.identity.storyId, manifest.identity.attempt])).rows[0];
        await recordConflict(client, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          storyId: manifest.identity.storyId,
          attempt: manifest.identity.attempt,
          launchGeneration: input.launchGeneration,
          existingIdentityHash: existing?.identity_hash ?? null,
          conflictingIdentityHash: retryHash({
            repositoryRealpath, worktreeRealpath,
            repositoryMembership: repository.membership,
            worktreeMembership: worktreeRepository.membership,
          }),
          reasonCode: 'worktree_identity_mismatch',
          payload: { repositoryRealpath, worktreeRealpath, repositoryRemote: repository.remote },
        });
      }
    });
    throw new ConflictError('Host attempt conflicts with worktree_identity_mismatch: worktree is not a canonical repository member');
  }
  let canonicalSpecObservation: ObservedJsonFile;
  let runSpecObservation: ObservedJsonFile;
  try {
    canonicalSpecObservation = observeExactJsonFile({
      expectedPath: path.resolve(repositoryRealpath, canonicalSpecPath),
      allowedRoot: repositoryRealpath,
      label: 'Canonical spec',
    });
    runSpecObservation = observeExactJsonFile({
      expectedPath: input.runSpecPath,
      allowedRoot: worktreeRealpath,
      label: 'Run spec',
    });
  } catch (error) {
    if (!(error instanceof HostFileObservationConflict)) throw error;
    const label = error.message.startsWith('Canonical spec') ? 'canonical_spec' : 'run_spec';
    await recordLaunchObservationConflicts(input, `${label}_${error.reasonCode}`, {
      expectedCanonicalSpecPath: path.resolve(repositoryRealpath, canonicalSpecPath),
      expectedRunSpecPath: path.resolve(input.runSpecPath),
      repositoryRealpath,
      worktreeRealpath,
      observation: error.message,
    });
    throw new ConflictError(error.message);
  }
  const worktreeIdentity = fileIdentity(worktreeRealpath);
  const observedGitSha = exactSha(git(worktreeRealpath, ['rev-parse', 'HEAD^{commit}']), 'Observed worktree HEAD');
  const expectedGitSha = exactSha(input.expectedGitSha, 'Expected provider-attempt Git revision');
  const worktreeBranch = git(worktreeRealpath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!Number.isSafeInteger(input.runtime.processPid) || input.runtime.processPid <= 0) {
    throw new ConflictError('Host attempt engine process identity is invalid');
  }
  const runtimeIdentity = Object.freeze({ ...input.runtime });
  const runSpecStories = storiesFromSpec(runSpecObservation.parsed);
  const runSpecStoryRevisions = new Map<string, string>();
  for (const story of runSpecStories) {
    const storyId = typeof story.id === 'string' ? story.id.trim() : '';
    if (!storyId || runSpecStoryRevisions.has(storyId)) continue;
    runSpecStoryRevisions.set(storyId, deriveStoryContractRevision(story));
  }

  const result = await transaction(async (client: PoolClient) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`pipeline-run-authority:${input.runId}`],
    );
    const run = (await client.query<{
      workspace_id: string;
      dispatch_fence: string | null;
      spec_path: string;
      execution_workspace_path: string | null;
      execution_worktree_path: string | null;
      canonical_spec_revision: string | null;
      canonical_spec_bytes_hash: string | null;
      run_spec_path: string | null;
      run_spec_revision: string | null;
      run_spec_bytes_hash: string | null;
      first_provider_launch_verified_at: Date | string | null;
      prior_launches: number | string;
      cancellation_requested: boolean;
    }>(`
      SELECT run.workspace_id, run.dispatch_fence, run.spec_path,
             run.execution_workspace_path, run.execution_worktree_path,
             run.canonical_spec_revision, run.canonical_spec_bytes_hash,
             run.run_spec_path, run.run_spec_revision, run.run_spec_bytes_hash,
             run.first_provider_launch_verified_at,
             (SELECT COUNT(*) FROM host_story_attempt_envelopes envelope
               WHERE envelope.run_id = run.id) AS prior_launches,
             (EXISTS (
               SELECT 1 FROM pipeline_run_cancellation_requests cancellation
                WHERE cancellation.run_id = run.id
             ) OR EXISTS (
               SELECT 1 FROM governed_retry_dispatches retry
                WHERE retry.retry_run_id = run.id AND retry.cancellation_requested_at IS NOT NULL
             )) AS cancellation_requested
        FROM pipeline_runs run WHERE run.id = $1 FOR SHARE
    `, [input.runId])).rows[0];
    if (!run || run.workspace_id !== input.workspaceId) throw new ConflictError('Host attempt run/workspace authority is absent');

    let inserted = 0;
    let replayed = 0;
    const envelopeIds: string[] = [];
    let conflictMessage: string | null = null;
    for (const manifest of input.manifests) {
      const baseGitSha = exactSha(manifest.execution.worktree.baseRevision, 'Manifest base revision');
      const payload = {
        schemaVersion: HOST_STORY_ATTEMPT_ENVELOPE_VERSION,
        workspaceId: input.workspaceId,
        runId: input.runId,
        storyId: manifest.identity.storyId,
        attempt: manifest.identity.attempt,
        launchGeneration: input.launchGeneration,
        cancellationFence: input.cancellationFence,
        manifestHash: manifest.manifestHash,
        specId: manifest.identity.specId,
        specRevision: manifest.revisions.specRevision,
        storyRevision: manifest.revisions.storyRevision,
        canonicalSpecPath,
        canonicalSpecRevision: canonicalSpecObservation.revision,
        canonicalSpecBytesHash: canonicalSpecObservation.bytesHash,
        runSpecPath: runSpecObservation.realpath,
        runSpecRevision: runSpecObservation.revision,
        runSpecBytesHash: runSpecObservation.bytesHash,
        repositoryRealpath,
        repositoryIdentity: repository.identity,
        repositoryRemote: repository.remote,
        baseGitSha,
        expectedGitSha,
        observedGitSha,
        expectedGitBranch: input.expectedGitBranch,
        worktreeRealpath,
        worktreeIdentity,
        worktreeBranch,
        runtimeIdentity,
      };
      const identityHash = retryHash(payload);
      const payloadHash = retryHash({ ...payload, launchedBy: 'rorca-host' });
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `host-story-attempt:${input.workspaceId}:${input.runId}:${manifest.identity.storyId}:${manifest.identity.attempt}`,
      ]);
      const existingAttempt = (await client.query<AttemptRow>(`
        SELECT * FROM host_story_attempt_envelopes
         WHERE workspace_id = $1 AND run_id = $2 AND story_id = $3
           AND attempt = $4 FOR UPDATE
      `, [input.workspaceId, input.runId, manifest.identity.storyId, manifest.identity.attempt])).rows[0];
      const existing = existingAttempt?.launch_generation === input.launchGeneration
        ? existingAttempt
        : undefined;

      if (existingAttempt && !existing) {
        await recordConflict(client, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          storyId: manifest.identity.storyId,
          attempt: manifest.identity.attempt,
          launchGeneration: input.launchGeneration,
          existingIdentityHash: existingAttempt.identity_hash,
          conflictingIdentityHash: identityHash,
          reasonCode: 'stale_generation',
          payload,
        });
        conflictMessage = `Host attempt ${manifest.identity.storyId} conflicts with stale_generation`;
        continue;
      }

      // Every distinct provider attempt re-observes both immutable files and
      // compares its manifest labels to the exact run-owned execution payload.
      // Canonical source authority remains separately frozen on pipeline_runs.
      const specMismatch = !run.canonical_spec_revision || !run.canonical_spec_bytes_hash
        || !run.run_spec_path || !run.run_spec_revision || !run.run_spec_bytes_hash
        || run.canonical_spec_revision !== canonicalSpecObservation.revision
        || run.canonical_spec_bytes_hash !== canonicalSpecObservation.bytesHash
        || path.resolve(run.run_spec_path) !== runSpecObservation.realpath
        || run.run_spec_revision !== runSpecObservation.revision
        || run.run_spec_bytes_hash !== runSpecObservation.bytesHash
        || manifest.revisions.specRevision !== runSpecObservation.revision
        || runSpecStoryRevisions.get(manifest.identity.storyId) !== manifest.revisions.storyRevision;
      const gitMismatch = observedGitSha !== expectedGitSha
        || worktreeBranch !== input.expectedGitBranch
        || manifest.execution.worktree.branch !== input.expectedGitBranch
        || !isAncestor(worktreeRealpath, baseGitSha, observedGitSha);
      const runMismatch = run.cancellation_requested
        || run.dispatch_fence !== input.cancellationFence
        || run.spec_path !== canonicalSpecPath
        || run.execution_workspace_path !== repositoryRealpath
        || run.execution_worktree_path !== worktreeRealpath
        || specMismatch
        || gitMismatch;
      // The payload hash includes the per-launch child PID, which legitimately
      // differs when the engine retries the same attempt (e.g. after a
      // transient model failure). A same-generation existing envelope with
      // matching immutable dimensions (spec, git, worktree, revisions) is the
      // same logical launch: replay it rather than recording payload_changed.
      // Only run/spec/git/worktree drift or a changed launch generation is a
      // genuine conflict.
      if (runMismatch || (existing && (existing.spec_revision !== manifest.revisions.specRevision
        || existing.worktree_realpath !== worktreeRealpath
        || existing.worktree_identity !== worktreeIdentity
        || existing.base_git_sha !== baseGitSha
        || existing.expected_git_sha !== expectedGitSha
        || existing.observed_git_sha !== observedGitSha
        || existing.expected_git_branch !== input.expectedGitBranch
        || existing.manifest_hash !== manifest.manifestHash))) {
        const reasonCode = run.cancellation_requested || run.dispatch_fence !== input.cancellationFence
          ? 'cancellation_fence_mismatch'
          : run.spec_path !== canonicalSpecPath
              || (existing !== undefined && existing.canonical_spec_path !== canonicalSpecPath)
            ? 'canonical_path_mismatch'
            : specMismatch
                || (existing?.spec_revision !== undefined && existing.spec_revision !== manifest.revisions.specRevision)
              ? 'spec_revision_mismatch'
              : run.execution_worktree_path !== worktreeRealpath
                  || (existing !== undefined && (existing.worktree_realpath !== worktreeRealpath
                    || existing.worktree_identity !== worktreeIdentity))
                ? 'worktree_identity_mismatch'
                : gitMismatch
                    || (existing !== undefined && (existing.base_git_sha !== baseGitSha
                      || existing.expected_git_sha !== expectedGitSha
                      || existing.observed_git_sha !== observedGitSha
                      || existing.expected_git_branch !== input.expectedGitBranch))
                  ? 'git_revision_mismatch'
                  : 'payload_changed';
        await recordConflict(client, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          storyId: manifest.identity.storyId,
          attempt: manifest.identity.attempt,
          launchGeneration: input.launchGeneration,
          existingIdentityHash: existing?.identity_hash ?? null,
          conflictingIdentityHash: identityHash,
          reasonCode,
          payload,
        });
        conflictMessage = `Host attempt ${manifest.identity.storyId} conflicts with ${reasonCode}`;
        continue;
      }
      if (existing) {
        if (existing.authority_state !== 'valid') conflictMessage = `Host attempt ${manifest.identity.storyId} generation is already conflicted`;
        replayed += 1;
        envelopeIds.push(existing.envelope_id);
        continue;
      }
      const row = (await client.query<{ envelope_id: string }>(`
        INSERT INTO host_story_attempt_envelopes (
          schema_version, workspace_id, run_id, story_id, attempt, launch_generation,
          cancellation_fence, manifest_hash, spec_id, spec_revision, story_revision,
          canonical_spec_path, run_spec_path, repository_realpath, repository_identity,
          repository_remote, base_git_sha, observed_git_sha, worktree_realpath,
          worktree_identity, worktree_branch, runtime_identity, identity_hash, payload_hash,
          canonical_spec_revision, canonical_spec_bytes_hash, run_spec_revision, run_spec_bytes_hash,
          expected_git_sha, expected_git_branch
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23,$24,$25,$26,$27,$28,$29,$30
        ) RETURNING envelope_id
      `, [
        HOST_STORY_ATTEMPT_ENVELOPE_VERSION, input.workspaceId, input.runId,
        manifest.identity.storyId, manifest.identity.attempt, input.launchGeneration,
        input.cancellationFence, manifest.manifestHash, manifest.identity.specId,
        manifest.revisions.specRevision, manifest.revisions.storyRevision,
        canonicalSpecPath, path.resolve(input.runSpecPath), repositoryRealpath,
        repository.identity, repository.remote, baseGitSha, observedGitSha,
        worktreeRealpath, worktreeIdentity, worktreeBranch, JSON.stringify(runtimeIdentity),
        identityHash, payloadHash, canonicalSpecObservation.revision,
        canonicalSpecObservation.bytesHash, runSpecObservation.revision, runSpecObservation.bytesHash,
        expectedGitSha, input.expectedGitBranch,
      ])).rows[0];
      if (!row) throw new ConflictError('Host attempt launch was not durably persisted');
      inserted += 1;
      envelopeIds.push(row.envelope_id);
    }
    if (!conflictMessage && Number(run.prior_launches) === 0
      && run.first_provider_launch_verified_at === null && inserted > 0) {
      const verified = await client.query(`
        UPDATE pipeline_runs SET first_provider_launch_verified_at = statement_timestamp()
         WHERE id = $1 AND first_provider_launch_verified_at IS NULL
           AND dispatch_fence = $2
           AND NOT EXISTS (
             SELECT 1 FROM pipeline_run_cancellation_requests cancellation
              WHERE cancellation.run_id = pipeline_runs.id
           )
         RETURNING id
      `, [input.runId, input.cancellationFence]);
      if (verified.rowCount !== 1) {
        throw new ConflictError('First provider launch lost frozen run authority before verification');
      }
    }
    return { inserted, replayed, envelopeIds, conflictMessage };
  });
  if (result.conflictMessage) throw new ConflictError(result.conflictMessage);
  return {
    runId: input.runId,
    launchGeneration: input.launchGeneration,
    inserted: result.inserted,
    replayed: result.replayed,
    envelopeIds: result.envelopeIds,
  };
}

export async function finalizeHostStoryAttempt(input: {
  workspaceId: string;
  runId: number;
  storyId: string;
  attempt: number;
  launchGeneration: string;
  cancellationFence: string;
  manifestHash: string;
  outcome: HostAttemptOutcome;
  provenance: HostAttemptOutcomeProvenance;
  exitCode?: number | null;
  exitSignal?: string | null;
}): Promise<'finalized' | 'replayed'> {
  assertNotProtectedWave1Run(input.runId);
  if (!SHA256.test(input.cancellationFence)) throw new ConflictError('Host attempt completion fence is invalid');
  return transaction(async (client: PoolClient) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `pipeline-run-authority:${input.runId}`,
    ]);
    const row = (await client.query<AttemptRow>(`
      SELECT * FROM host_story_attempt_envelopes
       WHERE workspace_id = $1 AND run_id = $2 AND story_id = $3
         AND attempt = $4 AND launch_generation = $5 FOR UPDATE
    `, [input.workspaceId, input.runId, input.storyId, input.attempt, input.launchGeneration])).rows[0];
    if (!row) throw new ConflictError('Host attempt launch envelope is absent');
    const run = (await client.query<{ dispatch_fence: string | null; cancellation_requested: boolean }>(`
      SELECT run.dispatch_fence,
             (EXISTS (SELECT 1 FROM pipeline_run_cancellation_requests cancellation WHERE cancellation.run_id = run.id)
               OR EXISTS (SELECT 1 FROM governed_retry_dispatches retry WHERE retry.retry_run_id = run.id AND retry.cancellation_requested_at IS NOT NULL)) AS cancellation_requested
        FROM pipeline_runs run WHERE run.id = $1 FOR SHARE
    `, [input.runId])).rows[0];
    const conflict = (await client.query<{ conflict_id: string }>(`
      SELECT conflict_id FROM host_story_attempt_conflicts
       WHERE workspace_id = $1 AND run_id = $2 AND story_id = $3 AND attempt = $4
       LIMIT 1
    `, [input.workspaceId, input.runId, input.storyId, input.attempt])).rows[0];
    if (conflict || row.authority_state !== 'valid' || row.manifest_hash !== input.manifestHash
      || row.cancellation_fence !== input.cancellationFence
      || run?.dispatch_fence !== input.cancellationFence
      || run?.cancellation_requested === true) {
      await recordConflict(client, {
        workspaceId: input.workspaceId,
        runId: input.runId,
        storyId: input.storyId,
        attempt: input.attempt,
        launchGeneration: input.launchGeneration,
        existingIdentityHash: row.identity_hash,
        conflictingIdentityHash: retryHash(input),
        reasonCode: row.cancellation_fence !== input.cancellationFence
          || run?.dispatch_fence !== input.cancellationFence || run?.cancellation_requested === true
          ? 'cancellation_fence_mismatch' : 'payload_changed',
        payload: input,
      });
      return 'conflict' as const;
    }
    if (row.outcome !== null) {
      const same = row.outcome === input.outcome
        && row.outcome_provenance === input.provenance
        && row.exit_code === (input.exitCode ?? null)
        && row.exit_signal === (input.exitSignal ?? null);
      if (!same) {
        await recordConflict(client, {
          workspaceId: input.workspaceId,
          runId: input.runId,
          storyId: input.storyId,
          attempt: input.attempt,
          launchGeneration: input.launchGeneration,
          existingIdentityHash: row.identity_hash,
          conflictingIdentityHash: retryHash(input),
          reasonCode: 'payload_changed',
          payload: input,
        });
        return 'conflict' as const;
      }
      return 'replayed';
    }
    const updated = await client.query(`
      UPDATE host_story_attempt_envelopes
         SET outcome = $6, outcome_provenance = $7, exit_code = $8,
             exit_signal = $9, finished_at = statement_timestamp()
       WHERE workspace_id = $1 AND run_id = $2 AND story_id = $3
         AND attempt = $4 AND launch_generation = $5
         AND authority_state = 'valid' AND outcome IS NULL
       RETURNING envelope_id
    `, [input.workspaceId, input.runId, input.storyId, input.attempt,
      input.launchGeneration, input.outcome, input.provenance,
      input.exitCode ?? null, input.exitSignal ?? null]);
    if (updated.rowCount !== 1) throw new ConflictError('Host attempt completion lost generation authority');
    return 'finalized';
  }).then((result) => {
    if (result === 'conflict') throw new ConflictError('Host attempt completion conflicts with immutable launch authority');
    return result;
  });
}

/**
 * Worker recovery finalizes every envelope the engine did not settle itself.
 * Existing successful rows are immutable and untouched.
 */
export async function finalizeUnfinishedHostAttemptGeneration(input: {
  workspaceId: string;
  runId: number;
  launchGeneration?: string;
  cancellationFence: string;
  outcome: Exclude<HostAttemptOutcome, 'success'>;
  provenance: HostAttemptOutcomeProvenance;
  exitCode?: number | null;
  exitSignal?: string | null;
}): Promise<number> {
  assertNotProtectedWave1Run(input.runId);
  return transaction(async (client: PoolClient) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `pipeline-run-authority:${input.runId}`,
    ]);
    const run = (await client.query<{ dispatch_fence: string | null; cancellation_requested: boolean }>(`
      SELECT run.dispatch_fence,
             (EXISTS (SELECT 1 FROM pipeline_run_cancellation_requests cancellation WHERE cancellation.run_id = run.id)
               OR EXISTS (SELECT 1 FROM governed_retry_dispatches retry WHERE retry.retry_run_id = run.id AND retry.cancellation_requested_at IS NOT NULL)) AS cancellation_requested
        FROM pipeline_runs run WHERE run.id = $1 FOR UPDATE
    `, [input.runId])).rows[0];
    if (!run || run.dispatch_fence !== input.cancellationFence
      || (run.cancellation_requested && input.outcome !== 'cancelled')) {
      throw new ConflictError('Host attempt recovery lost the active cancellation fence');
    }
    const updated = await client.query(`
      UPDATE host_story_attempt_envelopes
         SET outcome = $5, outcome_provenance = $6, exit_code = $7,
             exit_signal = $8, finished_at = statement_timestamp()
       WHERE workspace_id = $1 AND run_id = $2
         AND ($3::uuid IS NULL OR launch_generation = $3::uuid)
         AND cancellation_fence = $4 AND authority_state = 'valid' AND outcome IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM host_story_attempt_conflicts conflict
            WHERE conflict.workspace_id = host_story_attempt_envelopes.workspace_id
              AND conflict.run_id = host_story_attempt_envelopes.run_id
              AND conflict.story_id = host_story_attempt_envelopes.story_id
              AND conflict.attempt = host_story_attempt_envelopes.attempt
         )
    `, [input.workspaceId, input.runId, input.launchGeneration ?? null, input.cancellationFence,
      input.outcome, input.provenance, input.exitCode ?? null, input.exitSignal ?? null]);
    return updated.rowCount ?? 0;
  });
}

/** Semantic success may consume only the exact successful host generation. */
export async function requireSuccessfulHostStoryAttempt(input: {
  workspaceId: string;
  runId: number;
  storyId: string;
  attempt: number;
  launchGeneration: string;
  cancellationFence: string;
  manifestHash: string;
}): Promise<void> {
  assertNotProtectedWave1Run(input.runId);
  const accepted = await transaction(async (client: PoolClient) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `pipeline-run-authority:${input.runId}`,
    ]);
    const row = (await client.query<AttemptRow>(`
      SELECT * FROM host_story_attempt_envelopes
       WHERE workspace_id = $1 AND run_id = $2 AND story_id = $3
         AND attempt = $4 AND launch_generation = $5 FOR SHARE
    `, [input.workspaceId, input.runId, input.storyId, input.attempt, input.launchGeneration])).rows[0];
    const run = (await client.query<{ dispatch_fence: string | null; cancellation_requested: boolean }>(`
      SELECT run.dispatch_fence,
             (EXISTS (SELECT 1 FROM pipeline_run_cancellation_requests cancellation WHERE cancellation.run_id = run.id)
               OR EXISTS (SELECT 1 FROM governed_retry_dispatches retry WHERE retry.retry_run_id = run.id AND retry.cancellation_requested_at IS NOT NULL)) AS cancellation_requested
        FROM pipeline_runs run WHERE run.id = $1 FOR SHARE
    `, [input.runId])).rows[0];
    return Boolean(row && run && row.authority_state === 'valid'
      && hasCompleteSuccessfulAttemptAuthority(row)
      && row.cancellation_fence === input.cancellationFence
      && run.dispatch_fence === input.cancellationFence
      && !run.cancellation_requested
      && row.manifest_hash === input.manifestHash
      && !(await client.query<{ conflict_id: string }>(`
        SELECT conflict_id FROM host_story_attempt_conflicts
         WHERE workspace_id = $1 AND run_id = $2 AND story_id = $3 AND attempt = $4
         LIMIT 1
      `, [input.workspaceId, input.runId, input.storyId, input.attempt])).rows[0]);
  });
  if (!accepted) throw new ConflictError('Semantic closeout lacks exact successful host attempt authority');
}
