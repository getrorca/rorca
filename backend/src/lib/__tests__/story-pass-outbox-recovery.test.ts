/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const transaction = jest.fn();
const queryOne = jest.fn();
const execute = jest.fn();

jest.mock('../run-git-authority', () => ({ assertCanonicalRunCheckout: jest.fn() }));

jest.mock('../../db/index', () => ({
  transaction: (...args: unknown[]) => transaction(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  query: jest.fn(),
  execute: (...args: unknown[]) => execute(...args),
}));

import {
  EXECUTION_ENGINE_RESULT_AUTHORITY,
  persistCanonicalStoryResult,
  verifyReleasedHostResultProposal,
} from '../story-result-persistence';
import { relayTrustedWalEvent, type TrustedWalRow } from '../trusted-wal';

const SHA = 'a'.repeat(40);
const state: {
  result?: Record<string, unknown>;
  commit?: Record<string, unknown>;
  wal?: TrustedWalRow;
} = {};

const client = {
  query: jest.fn(async (sqlValue: unknown, values: unknown[] = []) => {
    const sql = String(sqlValue);
    if (sql.includes('SELECT pr.workspace_id, pr.spec_path')) {
      return { rows: [{
        workspace_id: 'ws-recovery',
        spec_path: 'forge/specs/approved/recovery-spec.json',
        branch_name: 'run/recovery',
        execution_workspace_path: process.cwd(),
        execution_worktree_path: process.cwd(),
        manifest_hash: `sha256:${'1'.repeat(64)}`,
        spec_revision: `sha256:${'2'.repeat(64)}`,
        story_revision: `sha256:${'3'.repeat(64)}`,
        closeout_decision_id: `CLO-sha256:${'4'.repeat(64)}`,
        closeout_status: 'accepted',
      }] };
    }
    if (sql.includes('SELECT id, workspace_id, spec_path, expected_story_ids')) {
      return { rows: [{
        id: 51,
        workspace_id: 'ws-recovery',
        spec_path: 'forge/specs/approved/recovery-spec.json',
        expected_story_ids: ['US-RECOVERY-001'],
      }] };
    }
    if (sql.includes('INSERT INTO story_results')) {
      if (state.result) return { rows: [] };
      state.result = {
        id: 1,
        run_id: values[0], story_id: values[1], status: values[2],
        finished_at: '2026-07-18T10:00:00.000Z', finished_at_source: values[4],
        worktree_path: values[5], worktree_branch: values[6], integrated: values[7],
        commit_sha: values[8], commit_message: values[9], commit_author: values[10],
        commit_branch: values[11], commit_observed_source: values[12],
        input_tokens: values[13], output_tokens: values[14], reasoning_tokens: values[15],
        model_used: values[16], cost_usd: values[17], log_path: values[18],
        blocked_by: values[19], active_skills: values[20],
        completion_packet: values[21] ? JSON.parse(String(values[21])) : null,
        spec_id: values[22], spec_revision: values[23], story_revision: values[24],
        manifest_hash: values[25], closeout_decision_id: values[26], ingest_key: values[27],
        accounting_required: values[28], accounting_model: values[29],
        accounting_input_tokens: values[30], accounting_output_tokens: values[31],
        accounting_reasoning_tokens: values[32], accounting_cost_usd: values[33],
        accounting_cost_source: values[34], accounting_input_rate: values[35],
        accounting_output_rate: values[36], reason: values[37],
        result_provenance: values[38], result_source: values[39],
      };
      return { rows: [{ id: 1 }] };
    }
    if (sql.includes('FROM story_results') && sql.includes('ingest_key = $1')) {
      return { rows: state.result ? [state.result] : [] };
    }
    if (sql.includes('INSERT INTO story_commits')) {
      if (state.commit) return { rows: [] };
      state.commit = {
        id: 1,
        story_id: values[0],
        spec_id: values[1],
        workspace_id: values[2],
        run_id: values[3],
        commit_sha: values[4],
        commit_message: values[5],
        author: values[6],
        branch_name: values[7],
        observed_source: values[8],
      };
      return { rows: [state.commit] };
    }
    if (sql.includes('FROM story_commits')) return { rows: state.commit ? [state.commit] : [] };
    if (sql.includes('SELECT id FROM story_results')) {
      return { rows: state.result ? [{ id: state.result.id }] : [] };
    }
    if (sql.includes("trusted_source = 'story-result'") && sql.includes('story_result_id = $1')) {
      return { rows: state.wal ? [state.wal] : [] };
    }
    if (sql.includes('INSERT INTO wal_events')) {
      if (state.wal) return { rows: [] };
      state.wal = {
        id: 10,
        ts: '2026-07-18T10:00:00.000Z',
        event_type: String(values[0]),
        workspace_id: String(values[1]),
        spec_id: String(values[2]),
        story_id: values[3] as string,
        actor: 'rorca-host',
        payload: String(values[4]),
        ingest_key: String(values[5]),
        trust_provenance: 'host',
        trusted_source: values[7] as 'story-result',
        canonical_run_id: Number(values[8]),
        story_result_id: Number(values[9]),
        event_identity_hash: String(values[10]),
        outbox_ready_at: null,
        outbox_relayed_at: null,
      };
      return { rows: [state.wal] };
    }
    if (sql.includes('SELECT * FROM wal_events WHERE ingest_key')) return { rows: state.wal ? [state.wal] : [] };
    if (sql.includes('FROM token_usage')) return { rows: [] };
    return { rows: [] };
  }),
};

function input() {
  return {
    runId: 51,
    storyId: 'US-RECOVERY-001',
    status: 'pass' as const,
    integrated: true,
    worktreePath: process.cwd(),
    worktreeBranch: 'run/recovery',
    commitSha: SHA,
    commitMessage: 'integrated story(US-RECOVERY-001): exact recovery head',
    idempotencyKey: 'story-result:integrated-pass-v1:recovery',
    expectedWorkspaceId: 'ws-recovery',
    trustedPassOutbox: {
      payload: {
        story_title: 'Recover relay after local pass',
        integrated: true,
        commit_sha: SHA,
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete state.result;
  delete state.commit;
  delete state.wal;
  transaction.mockImplementation(async (fn: (db: typeof client) => Promise<unknown>) => fn(client));
  queryOne.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue);
    if (sql.includes('SELECT w.*')) return state.wal;
    if (sql.includes('UPDATE wal_events w')) {
      if (state.wal) state.wal.outbox_ready_at = '2026-07-18T10:02:00.000Z';
      return state.wal;
    }
    if (sql.includes('SELECT pg_notify(')) return { notified: '' };
    return undefined;
  });
});

test('rejects 64-hex commit identities before any host transaction/finalization', async () => {
  await expect(persistCanonicalStoryResult({
    ...input(), commitSha: 'a'.repeat(64),
  }, EXECUTION_ENGINE_RESULT_AUTHORITY)).rejects.toThrow('full 40-hex Git/GitHub object id');
  expect(transaction).not.toHaveBeenCalled();
});

test('production worker can verify only an exact existing immutable host result', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalRole = process.env.RORCA_PROCESS_ROLE;
  try {
    await persistCanonicalStoryResult(input(), EXECUTION_ENGINE_RESULT_AUTHORITY);
    if (state.wal) state.wal.outbox_ready_at = '2026-07-18T10:02:00.000Z';
    process.env.NODE_ENV = 'production';
    process.env.RORCA_PROCESS_ROLE = 'worker';
    await expect(verifyReleasedHostResultProposal(input())).resolves.toBe(true);

    const near = input();
    near.commitMessage = 'near match must not verify';
    await expect(verifyReleasedHostResultProposal(near)).rejects.toThrow(/different immutable payload/);

    const existing = state.result;
    delete state.result;
    await expect(verifyReleasedHostResultProposal(input())).resolves.toBe(false);
    state.result = existing;
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.RORCA_PROCESS_ROLE = originalRole;
  }
});

test('crash after local pass before relay is recovered by duplicate re-finalization', async () => {
  const first = await persistCanonicalStoryResult(input(), EXECUTION_ENGINE_RESULT_AUTHORITY);
  expect(first.duplicate).toBe(false);
  expect(first.trustedWal).toBeDefined();
  expect(state.wal?.outbox_relayed_at).toBeNull();

  // Simulate markStoryPassed() having completed and the engine dying before relay.
  const localSpecAlreadyPassed = true;
  expect(localSpecAlreadyPassed).toBe(true);

  const refinalized = await persistCanonicalStoryResult(input(), EXECUTION_ENGINE_RESULT_AUTHORITY);
  expect(refinalized).toMatchObject({ duplicate: true, trustedWal: first.trustedWal });
  await relayTrustedWalEvent(refinalized.trustedWal!);

  expect(client.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO story_results'))).toHaveLength(2);
  expect(client.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO story_commits'))).toHaveLength(1);
  expect(client.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO wal_events'))).toHaveLength(1);
  const notifyCalls = queryOne.mock.calls.filter(([sql]) => String(sql).includes("SELECT pg_notify("));
  expect(notifyCalls).toHaveLength(1);
  expect(String(notifyCalls[0][0])).toContain("json_build_object('trusted_wal_id', w.id)");
  expect(state.wal?.spec_id).toBe('recovery-spec');
  expect(state.wal?.story_result_id).toBe(1);
  expect(state.wal?.outbox_ready_at).toBe('2026-07-18T10:02:00.000Z');
  expect(JSON.parse(String(state.wal?.payload))).toMatchObject({
    run_id: 51,
    story_id: 'US-RECOVERY-001',
    story_result_id: 1,
    commit_sha: SHA,
  });

  const changed = input();
  changed.trustedPassOutbox.payload.story_title = 'Changed duplicate identity';
  await expect(persistCanonicalStoryResult(changed, EXECUTION_ENGINE_RESULT_AUTHORITY)).rejects.toThrow(
    'Trusted WAL relay reference does not exactly match the durable event',
  );
});
