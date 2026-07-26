/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const queryOne = jest.fn();
const query = jest.fn();
const assertWal = jest.fn();
const assertCheckout = jest.fn();
const assertAncestry = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
  query: (...args: unknown[]) => query(...args),
}));
jest.mock('../trusted-wal', () => ({
  assertExactTrustedWalRow: (...args: unknown[]) => assertWal(...args),
}));
jest.mock('../run-git-authority', () => ({
  assertCanonicalRunCheckout: (...args: unknown[]) => assertCheckout(...args),
  assertOrderedCommitAncestry: (...args: unknown[]) => assertAncestry(...args),
  isSupportedGitCommitSha: (value: unknown) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value),
}));

import {
  inspectRunHostAuthority,
  linkedPredecessorAuthorityHash,
} from '../run-host-authority';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function pass(storyId: string, id: number, sha: string) {
  return {
    id, story_id: storyId, status: 'pass', reason: null,
    finished_at: '2026-07-18T10:00:00.000Z', spec_id: 'spec-a', integrated: true,
    commit_sha: sha, commit_message: `integrated ${storyId}`,
    commit_author: 'rorca-execution-engine', commit_branch: 'run/spec-a',
    commit_observed_source: 'worktree_branch', closeout_decision_id: `close-${storyId}`,
    manifest_hash: `sha256:${'1'.repeat(64)}`, closeout_status: 'accepted',
    closeout_manifest_hash: `sha256:${'1'.repeat(64)}`,
    projected_commit_sha: sha, projected_commit_message: `integrated ${storyId}`,
    projected_commit_author: 'rorca-execution-engine', projected_commit_branch: 'run/spec-a',
    projected_commit_source: 'worktree_branch', commit_count: 1,
    worktree_path: '/worktree', attestation_count: 1,
    attestation_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    attestation_digest: 'd'.repeat(64),
    attestation_passed_at: '2026-07-18T09:59:00.000Z',
    attestation_expires_at: '2099-07-18T10:00:00.000Z',
    attestation_revoked_at: null,
    accounting_required: false, accounting_model: null as string | null,
    accounting_input_tokens: null as number | null,
    accounting_output_tokens: null as number | null,
    accounting_reasoning_tokens: null as number | null,
    accounting_cost_usd: null as number | null, accounting_count: 0,
    result_provenance: 'host', result_source: 'execution-engine',
  };
}

function outbox(row: ReturnType<typeof pass>) {
  const payload = {
    run_id: 41, story_id: row.story_id, story_result_id: row.id,
    commit_sha: row.commit_sha, closeout_decision_id: row.closeout_decision_id,
    checkpoint_attestation_id: row.attestation_id,
    checkpoint_attestation_digest: row.attestation_digest,
    checkpoint_attestation_passed_at: row.attestation_passed_at,
    checkpoint_attestation_expires_at: row.attestation_expires_at,
  };
  return {
    id: 100 + row.id, ts: '2026-07-18T10:00:00.000Z', event_type: 'story_passed',
    workspace_id: 'ws-a', spec_id: 'spec-a', story_id: row.story_id, actor: 'rorca-host',
    payload: JSON.stringify(payload), ingest_key: `trusted:${row.id}`,
    trust_provenance: 'host', trusted_source: 'story-result', canonical_run_id: 41,
    story_result_id: row.id, event_identity_hash: 'c'.repeat(64),
    outbox_ready_at: '2026-07-18T10:00:00.000Z', outbox_relayed_at: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  queryOne.mockResolvedValue({
    id: 41, workspace_id: 'ws-a', spec_path: 'forge/specs/approved/spec-a.json',
    status: 'running', lifecycle_status: 'running', expected_story_ids: ['US-001', 'US-002'],
    excluded_story_ids: [], finished_at: null, branch_name: 'run/spec-a',
    worktree_path: '/worktree', execution_workspace_path: '/workspace',
    execution_worktree_path: '/worktree', terminal_checkout_sha: null,
    terminal_checkout_attested_at: null, release_authorized_sha: null,
    release_identity_hash: null, workspace_path: '/workspace',
  });
  const passes = [pass('US-001', 1, A), pass('US-002', 2, B)];
  query.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('DISTINCT ON (sr.story_id)')) return passes;
    if (sql.includes("trusted_source = 'story-result'")) return passes.map(outbox);
    return [];
  });
  assertCheckout.mockReturnValue({
    cwd: '/worktree', repositoryTopLevel: '/workspace', branchName: 'run/spec-a', headSha: B,
  });
});

test('linked predecessor authority digest binds exact result identity', () => {
  const exact = linkedPredecessorAuthorityHash(40, [{ storyId: 'US-001', resultId: 1, commitSha: A }]);
  expect(exact).toMatch(/^[0-9a-f]{64}$/);
  expect(linkedPredecessorAuthorityHash(40, [{ storyId: 'US-001', resultId: 2, commitSha: A }])).not.toBe(exact);
});

test('authorizes only exact complete host passes on the ordered canonical terminal HEAD', async () => {
  const authority = await inspectRunHostAuthority(41);
  expect(authority).toMatchObject({
    complete: true, releaseEligible: true, finalCommitSha: B,
    authoritativePassedStoryIds: ['US-001', 'US-002'], invalidReason: null,
  });
  expect(assertAncestry).toHaveBeenCalledWith('/worktree', [A, B], B);
  const resultSql = String(query.mock.calls.find(([sql]) => String(sql).includes('DISTINCT ON'))?.[0]);
  expect(resultSql).toContain("sr.result_provenance = 'host'");
  expect(resultSql).toContain("sr.result_source IN ('execution-engine', 'worker')");
});

test('immutable terminal checkout attestation survives direct worktree cleanup', async () => {
  queryOne.mockResolvedValue({
    id: 41, workspace_id: 'ws-a', spec_path: 'forge/specs/approved/spec-a.json',
    status: 'release_pending', lifecycle_status: 'validating', expected_story_ids: ['US-001', 'US-002'],
    excluded_story_ids: [], finished_at: null, branch_name: 'run/spec-a',
    worktree_path: '/worktree', execution_workspace_path: '/workspace',
    execution_worktree_path: '/worktree', terminal_checkout_sha: B,
    terminal_checkout_attested_at: '2026-07-18T10:02:00.000Z', release_authorized_sha: B,
    release_execution_workspace_path: '/workspace', release_execution_worktree_path: '/worktree',
    release_identity_hash: 'e'.repeat(64), workspace_path: '/workspace',
  });
  assertCheckout.mockImplementation(() => { throw new Error('run checkout is unavailable'); });
  await expect(inspectRunHostAuthority(41)).resolves.toMatchObject({
    complete: true, releaseEligible: true, finalCommitSha: B, invalidReason: null,
  });
});

test('missing host authority for a future expected story cannot be promoted by exit zero or file flags', async () => {
  query.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('DISTINCT ON (sr.story_id)')) return [pass('US-001', 1, A)];
    if (sql.includes("trusted_source = 'story-result'")) return [outbox(pass('US-001', 1, A))];
    return [];
  });
  assertCheckout.mockReturnValue({ cwd: '/worktree', repositoryTopLevel: '/workspace', branchName: 'run/spec-a', headSha: A });
  const authority = await inspectRunHostAuthority(41);
  expect(authority).toMatchObject({ complete: false, releaseEligible: false });
});

test.each([
  ['branch mismatch', (row: ReturnType<typeof pass>) => { row.commit_branch = 'attacker/branch'; }],
  ['missing attestation', (row: ReturnType<typeof pass>) => { row.attestation_count = 0; }],
  ['attestation digest mismatch', (row: ReturnType<typeof pass>) => { row.attestation_digest = 'bad'; }],
  ['expired attestation', (row: ReturnType<typeof pass>) => { row.attestation_expires_at = '2020-01-01T00:00:00.000Z'; }],
  ['missing accounting projection', (row: ReturnType<typeof pass>) => {
    row.accounting_required = true; row.accounting_model = 'model'; row.accounting_input_tokens = 1;
    row.accounting_output_tokens = 1; row.accounting_reasoning_tokens = 0; row.accounting_cost_usd = 0;
  }],
])('%s fails closed before release', async (_name, mutate) => {
  const row = pass('US-001', 1, A);
  mutate(row);
  queryOne.mockResolvedValue({
    id: 41, workspace_id: 'ws-a', spec_path: 'forge/specs/approved/spec-a.json', status: 'running',
    lifecycle_status: 'running', expected_story_ids: ['US-001'], excluded_story_ids: [],
    finished_at: null, branch_name: 'run/spec-a', worktree_path: '/worktree',
    execution_workspace_path: '/workspace', execution_worktree_path: '/worktree',
    terminal_checkout_sha: null, terminal_checkout_attested_at: null,
    release_authorized_sha: null, release_identity_hash: null, workspace_path: '/workspace',
  });
  query.mockImplementation(async (sqlValue: unknown) => String(sqlValue).includes('DISTINCT ON') ? [row] : [outbox(row)]);
  const authority = await inspectRunHostAuthority(41);
  expect(authority?.releaseEligible).toBe(false);
  expect(authority?.invalidReason).toBeTruthy();
});
