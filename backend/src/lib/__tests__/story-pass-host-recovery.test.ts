/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const query = jest.fn();
const relay = jest.fn().mockResolvedValue(undefined);
const assertWal = jest.fn();
const markPassed = jest.fn(async (specPath: string, storyId: string) => {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as { userStories: Array<{ id: string; passes: boolean }> };
  const story = spec.userStories.find(candidate => candidate.id === storyId);
  if (!story) return { changed: false, storyFound: false };
  if (story.passes) return { changed: false, storyFound: true };
  story.passes = true;
  const temporary = `${specPath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(spec));
  fs.renameSync(temporary, specPath);
  return { changed: true, storyFound: true };
});

jest.mock('../../db/index', () => ({ query: (...args: unknown[]) => query(...args) }));
jest.mock('../execution-engine', () => ({
  markStoryPassed: (specPath: string, storyId: string) => markPassed(specPath, storyId),
}));
jest.mock('../trusted-wal', () => ({
  assertExactTrustedWalRow: (...args: unknown[]) => assertWal(...args),
  relayTrustedWalEvent: (...args: unknown[]) => relay(...args),
  trustedWalReference: (row: Record<string, unknown>) => ({ id: row.id }),
}));

import {
  passRecoveryBlocksCompletion,
  recoverUnreleasedIntegratedPasses,
} from '../story-pass-recovery';

const SHA = 'a'.repeat(40);
let root: string;
let repo: string;
let workspace: string;
let candidate: Record<string, unknown>;
let chain: Array<Record<string, unknown>>;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function walPayload() {
  return {
    run_id: 51,
    story_id: 'US-RECOVERY-001',
    story_result_id: 9,
    commit_sha: SHA,
    closeout_decision_id: 'CLO-host-recovery',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-host-pass-recovery-'));
  workspace = path.join(root, 'workspace');
  repo = path.join(root, 'run-worktree');
  fs.mkdirSync(workspace);
  git(workspace, 'init', '-q');
  git(workspace, 'config', 'user.email', 'test@rorca.invalid');
  git(workspace, 'config', 'user.name', 'Rorca Test');
  fs.writeFileSync(path.join(workspace, 'code.txt'), 'base\n');
  git(workspace, 'add', 'code.txt');
  git(workspace, 'commit', '-q', '-m', 'base');
  git(workspace, 'branch', '-M', 'main');
  git(workspace, 'worktree', 'add', '-q', '-b', 'run/recovery', repo);
  fs.writeFileSync(path.join(repo, 'code.txt'), 'verified\n');
  git(repo, 'add', 'code.txt');
  git(repo, 'commit', '-q', '-m', 'verified integration');
  // Use the real repository SHA in the candidate.
  const sha = git(repo, 'rev-parse', 'HEAD');
  const attestationId = '00000000-0000-4000-8000-000000000001';
  const attestationDigest = 'c'.repeat(64);
  const attestationPassedAt = new Date(Date.now() - 1_000).toISOString();
  const attestationExpiresAt = new Date(Date.now() + 60_000).toISOString();
  const snapshot = path.join(repo, '.rorca', 'run-specs', 'run-51.json');
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  fs.writeFileSync(snapshot, JSON.stringify({ userStories: [{ id: 'US-RECOVERY-001', passes: false }] }));

  candidate = {
    wal_id: 17,
    wal_ts: '2026-07-18T10:00:00.000Z',
    event_type: 'story_passed',
    workspace_id: 'ws-recovery',
    spec_id: 'recovery-spec',
    story_id: 'US-RECOVERY-001',
    actor: 'rorca-host',
    payload: {
      ...walPayload(), commit_sha: sha,
      checkpoint_attestation_id: attestationId,
      checkpoint_attestation_digest: attestationDigest,
      checkpoint_attestation_passed_at: attestationPassedAt,
      checkpoint_attestation_expires_at: attestationExpiresAt,
    },
    ingest_key: 'trusted-wal:v1:recovery',
    trust_provenance: 'host',
    trusted_source: 'story-result',
    canonical_run_id: 51,
    story_result_id: 9,
    event_identity_hash: 'b'.repeat(64),
    outbox_ready_at: null,
    outbox_relayed_at: null,
    result_status: 'pass',
    result_integrated: true,
    result_commit_sha: sha,
    result_commit_message: 'integrated story(US-RECOVERY-001)',
    result_commit_author: 'rorca-execution-engine',
    result_commit_branch: 'run/recovery',
    result_commit_source: 'worktree_branch',
    result_closeout_id: 'CLO-host-recovery',
    result_manifest_hash: `sha256:${'1'.repeat(64)}`,
    result_provenance: 'host',
    result_source: 'execution-engine',
    result_worktree_path: repo,
    run_workspace_id: 'ws-recovery',
    run_spec_path: 'forge/specs/approved/recovery-spec.json',
    run_worktree_path: repo,
    run_execution_workspace_path: workspace,
    run_execution_worktree_path: repo,
    run_branch_name: 'run/recovery',
    run_auto_worktree: true,
    run_retried_from_id: null,
    run_expected_story_ids: ['US-RECOVERY-001'],
    run_excluded_story_ids: [],
    workspace_path: workspace,
    closeout_status: 'accepted',
    closeout_manifest_hash: `sha256:${'1'.repeat(64)}`,
    closeout_workspace_id: 'ws-recovery',
    closeout_spec_id: 'recovery-spec',
    closeout_run_id: 51,
    closeout_story_id: 'US-RECOVERY-001',
    commit_sha: sha,
    commit_message: 'integrated story(US-RECOVERY-001)',
    commit_author: 'rorca-execution-engine',
    commit_branch: 'run/recovery',
    commit_source: 'worktree_branch',
    commit_count: 1,
    outbox_count: 1,
    attestation_id: attestationId,
    attestation_digest: attestationDigest,
    attestation_passed_at: attestationPassedAt,
    attestation_expires_at: attestationExpiresAt,
    attestation_revoked_at: null,
    attestation_count: 1,
  };
  chain = [{
    id: 9, story_id: 'US-RECOVERY-001', commit_sha: sha, commit_branch: 'run/recovery',
    result_provenance: 'host', result_source: 'execution-engine', integrated: true,
    closeout_decision_id: 'CLO-host-recovery', closeout_status: 'accepted',
    closeout_manifest_hash: `sha256:${'1'.repeat(64)}`,
    manifest_hash: `sha256:${'1'.repeat(64)}`, projected_commit_sha: sha,
    projected_commit_branch: 'run/recovery', commit_count: 1, outbox_count: 1,
    attestation_count: 1, attestation_id: attestationId,
    attestation_digest: attestationDigest, attestation_passed_at: attestationPassedAt,
    attestation_expires_at: attestationExpiresAt, attestation_revoked_at: null,
  }];
  query.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('SELECT sr.id, sr.story_id')) return chain;
    if (sql.includes('SELECT * FROM wal_events')) return chain.map((row, index) => ({
      id: 17 + index, ts: '2026-07-18T10:00:00.000Z', event_type: 'story_passed',
      workspace_id: 'ws-recovery', spec_id: 'recovery-spec', story_id: row.story_id,
      actor: 'rorca-host', payload: JSON.stringify({ run_id: 51, story_id: row.story_id,
        story_result_id: row.id, commit_sha: row.commit_sha,
        closeout_decision_id: row.closeout_decision_id,
        checkpoint_attestation_id: row.attestation_id,
        checkpoint_attestation_digest: row.attestation_digest,
        checkpoint_attestation_passed_at: row.attestation_passed_at,
        checkpoint_attestation_expires_at: row.attestation_expires_at }),
      ingest_key: `trusted-wal:v1:${row.id}`, trust_provenance: 'host',
      trusted_source: 'story-result', canonical_run_id: 51, story_result_id: row.id,
      event_identity_hash: 'b'.repeat(64), outbox_ready_at: null, outbox_relayed_at: null,
    }));
    return [candidate];
  });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('recovers transaction-before-file and releases only after durable local pass', async () => {
  const result = await recoverUnreleasedIntegratedPasses({ runId: 51 });
  expect(result).toMatchObject({ scanned: 1, recovered: 1, alreadyProjected: 0, blocked: [] });
  expect(markPassed).toHaveBeenCalledWith(path.join(repo, '.rorca', 'run-specs', 'run-51.json'), 'US-RECOVERY-001');
  expect(assertWal).toHaveBeenCalled();
  expect(relay).toHaveBeenCalledTimes(1);
});

test('recovers file-before-ready idempotently without rewriting authority', async () => {
  const snapshot = path.join(repo, '.rorca', 'run-specs', 'run-51.json');
  fs.writeFileSync(snapshot, JSON.stringify({ userStories: [{ id: 'US-RECOVERY-001', passes: true }] }));
  const result = await recoverUnreleasedIntegratedPasses({ runId: 51 });
  expect(result).toMatchObject({ recovered: 0, alreadyProjected: 1, blocked: [] });
  expect(relay).toHaveBeenCalledTimes(1);
});

test('recovers an earlier relay-failed pass after a later exact descendant pass advanced HEAD', async () => {
  const firstSha = String(candidate.result_commit_sha);
  fs.writeFileSync(path.join(repo, 'code.txt'), 'verified\nlater\n');
  git(repo, 'add', 'code.txt');
  git(repo, 'commit', '-q', '-m', 'later integrated story');
  const laterSha = git(repo, 'rev-parse', 'HEAD');
  const snapshot = path.join(repo, '.rorca', 'run-specs', 'run-51.json');
  fs.writeFileSync(snapshot, JSON.stringify({ userStories: [
    { id: 'US-RECOVERY-001', passes: false },
    { id: 'US-RECOVERY-002', passes: true },
  ] }));
  candidate.run_expected_story_ids = ['US-RECOVERY-001', 'US-RECOVERY-002'];
  chain = [
    chain[0],
    { ...chain[0], id: 10, story_id: 'US-RECOVERY-002', commit_sha: laterSha,
      projected_commit_sha: laterSha, closeout_decision_id: 'CLO-host-recovery-2' },
  ];

  const result = await recoverUnreleasedIntegratedPasses({ runId: 51 });
  expect(result).toMatchObject({ recovered: 1, blocked: [] });
  expect(chain.map(row => row.commit_sha)).toEqual([firstSha, laterSha]);
  expect(relay).toHaveBeenCalledTimes(1);
});

test('a symbolic branch switch blocks recovery before relay', async () => {
  git(repo, 'switch', '-q', '-c', 'attacker/branch');
  const result = await recoverUnreleasedIntegratedPasses({ runId: 51 });
  expect(passRecoveryBlocksCompletion(result)).toBe(true);
  expect(relay).not.toHaveBeenCalled();
});

test.each([
  ['branch HEAD drift', () => { candidate.result_commit_sha = 'd'.repeat(40); candidate.commit_sha = 'd'.repeat(40); (candidate.payload as Record<string, unknown>).commit_sha = 'd'.repeat(40); }],
  ['missing attestation', () => { candidate.attestation_count = 0; candidate.attestation_id = null; }],
  ['forged provenance', () => { candidate.result_provenance = 'recovery_proposal'; candidate.result_source = 'fallback-journal'; }],
])('%s remains inert and blocks terminal success', async (_name, mutate) => {
  mutate();
  const result = await recoverUnreleasedIntegratedPasses({ runId: 51 });
  expect(passRecoveryBlocksCompletion(result)).toBe(true);
  expect(result.blocked).toHaveLength(1);
  expect(relay).not.toHaveBeenCalled();
});
