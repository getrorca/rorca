/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from '@jest/globals';
import {
  appendWardenLedger,
  classifyFailure,
  decodeChunkTail,
  readWardenLedger,
  wardenEscalateStalledRuns,
  wardenSweep,
  wardenLedgerDir,
  type FailedRunRow,
} from '../failure-warden';

const LEDGER_ENV: NodeJS.ProcessEnv = { RORCA_HERMES_REPAIR_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-repair-test-')) };
afterEach(() => {
  if (LEDGER_ENV.RORCA_HERMES_REPAIR_HOME) {
    fs.rmSync(LEDGER_ENV.RORCA_HERMES_REPAIR_HOME, { recursive: true, force: true });
  }
});

function failedRun(overrides: Partial<FailedRunRow> = {}): FailedRunRow {
  return {
    id: 611,
    workspace_id: 1,
    spec_path: 'forge/specs/approved/demo.json',
    summary: null,
    status: 'failed',
    finished_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeps(overrides: {
  query?: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  emitWalEvent?: (eventType: string, workspaceId: number | string, payload: Record<string, unknown>) => Promise<void>;
  fetchImpl?: typeof fetch;
} = {}) {
  const events: Array<{ type: string; workspaceId: number | string; payload: Record<string, unknown> }> = [];
  return {
    deps: {
      query: overrides.query ?? (async () => []),
      emitWalEvent: overrides.emitWalEvent ?? (async (type, workspaceId, payload) => { events.push({ type, workspaceId, payload }); }),
      fetchImpl: overrides.fetchImpl ?? (async () => ({ ok: true, status: 200, text: async () => '{}' }) as unknown as Response),
      apiBaseUrl: 'http://127.0.0.1:3030',
    } as unknown as import('../failure-warden').FailureWardenDeps,
    events,
  };
}
describe('failure warden classification', () => {
  it('classifies bwrap-on-mac as dispatch shape', () => {
    expect(classifyFailure(failedRun({ summary: 'linux_bwrap_required_for_requested_mode' }), '')).toBe('dispatch_shape');
  });

  it('classifies egress failures from the evidence tail', () => {
    const run = failedRun();
    expect(classifyFailure(run, 'Connection error.\n[egress broker] blocked host')).toBe('egress_blocked');
    expect(classifyFailure(run, 'TypeError: fetch failed')).toBe('egress_blocked');
  });

  it('trusts authoritative timeout evidence over incidental output text', () => {
    expect(classifyFailure(
      failedRun({ terminal_reason: 'timeout' }),
      'Earlier tool output mentioned Connection error. but the provider later completed work.',
    )).toBe('timeout');
  });

  it('classifies quota exhaustion', () => {
    expect(classifyFailure(failedRun({ summary: 'rate limit exhausted' }), '')).toBe('quota_exhausted');
    expect(classifyFailure(failedRun(), 'API usage limit has been reached')).toBe('quota_exhausted');
  });

  it('classifies envelope conflicts and code bugs', () => {
    expect(classifyFailure(failedRun(), 'stale_generation mismatch at closeout')).toBe('envelope_conflict');
    expect(classifyFailure(failedRun({ summary: 'text = uuid' }), '')).toBe('code_bug');
    expect(classifyFailure(failedRun(), 'expireIn cannot exceed 24 hours')).toBe('code_bug');
  });

  it('classifies a governed retry integration closeout failure', () => {
    expect(classifyFailure(
      failedRun({ status: 'partial_failure', summary: 'retry_integration_pending:ACC-009,ACC-010' }),
      'Incidental graph projection Connection error. after the authoritative closeout summary.',
    )).toBe('closeout_pending');
  });

  it('classifies zombie sweeps and unknown noise', () => {
    expect(classifyFailure(failedRun({ summary: 'orphan_sweep' }), '')).toBe('zombie_loop');
    expect(classifyFailure(failedRun(), 'some brand new failure mode')).toBe('unknown');
  });

  it('decodes chunk tails newest-first', () => {
    const tail = decodeChunkTail([
      { chunk: Buffer.from('first chunk') },
      { chunk: Buffer.from(' second chunk') },
    ]);
    expect(tail).toContain('second chunk');
    expect(tail.indexOf('second chunk')).toBeLessThan(tail.indexOf('first chunk'));
  });

  it('classifies spec revision mismatch and runtime-root removal', () => {
    expect(classifyFailure(failedRun(), 'Host attempt AAV-003 conflicts with spec_revision_mismatch')).toBe('envelope_conflict');
    expect(classifyFailure(failedRun(), "ENOENT: no such file or directory, lstat '...rorca-ordinary-local-pi-runtime-20260316000616-OunWNH'")).toBe('runtime_root');
  });
});

describe('failure warden ledger', () => {
  it('appends and reads JSONL entries per run', async () => {
    await appendWardenLedger({ at: 't1', runId: 611, classification: 'unknown', action: 'escalate', detail: 'x', outcome: 'planned' }, LEDGER_ENV);
    await appendWardenLedger({ at: 't2', runId: 611, classification: 'unknown', action: 'escalate', detail: 'y', outcome: 'ok' }, LEDGER_ENV);
    const entries = await readWardenLedger(611, LEDGER_ENV);
    expect(entries).toHaveLength(2);
    expect(entries[1].outcome).toBe('ok');
    expect(await readWardenLedger(999, LEDGER_ENV)).toHaveLength(0);
  });
});

describe('failure warden sweep', () => {
  it('escalates quota exhaustion without re-driving and emits a WAL event', async () => {
    const { deps, events } = makeDeps({
      query: async (sql) => {
        if (sql.includes('run_output_chunks')) return [];
        return [failedRun({ summary: 'rate limit exhausted' })];
      },
    });
    const result = await wardenSweep(deps, LEDGER_ENV);
    expect(result.acted).toBe(1);
    expect(result.actions[0]).toEqual({ runId: 611, classification: 'quota_exhausted', action: 'escalate' });
    expect(events[0].type).toBe('run_repair_escalated');
    expect(events[0].payload.classification).toBe('quota_exhausted');
    // Ledger holds the plan and the outcome.
    const entries = await readWardenLedger(611, LEDGER_ENV);
    expect(entries.map((e) => e.action)).toEqual(['escalate', 'escalate']);
  });

  it('re-drives envelope conflicts through both governed retry phases', async () => {
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
      posts.push({ url: String(url), body });
      if (posts.length === 1) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            preview: { previewHash: `sha256:${'a'.repeat(64)}`, requiresApproval: false },
            previewIdentity: { schemaVersion: 'retry-preview-identity.v1' },
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, runId: 612 }),
      } as unknown as Response;
    }) as typeof fetch;
    const { deps } = makeDeps({
      query: async (sql) => {
        if (sql.includes('run_output_chunks')) return [];
        return [failedRun({ summary: 'stale_generation' })];
      },
      fetchImpl,
    });
    const result = await wardenSweep(deps, LEDGER_ENV);
    expect(result.actions[0].action).toBe('re-drive-retry');
    expect(posts.map((post) => post.url)).toEqual([
      'http://127.0.0.1:3030/api/pipeline/runs/611/retry',
      'http://127.0.0.1:3030/api/pipeline/runs/611/retry',
    ]);
    expect(posts[0].body).toEqual({ forceSequential: true });
    expect(posts[1].body).toMatchObject({
      forceSequential: true,
      previewHash: `sha256:${'a'.repeat(64)}`,
      approvedPreview: { requiresApproval: false },
      previewIdentity: { schemaVersion: 'retry-preview-identity.v1' },
    });
    const entries = await readWardenLedger(611, LEDGER_ENV);
    expect(entries[0].action).toBe('re-drive-retry');
    expect(entries[1].outcome).toBe('ok');
    expect(entries[1].detail).toContain('retry dispatch API 200');
  });

  it('includes partial failures for a full day and re-drives pending retry closeout', async () => {
    await appendWardenLedger({
      at: 'before-fix',
      runId: 611,
      classification: 'egress_blocked',
      action: 'escalate',
      detail: 'misclassified incidental graph connection error',
      outcome: 'ok',
    }, LEDGER_ENV);
    let candidateSql = '';
    let candidateParams: unknown[] | undefined;
    let postCount = 0;
    const { deps, events } = makeDeps({
      query: async (sql, params) => {
        if (sql.includes('run_output_chunks')) return [];
        candidateSql = sql;
        candidateParams = params;
        return [failedRun({
          status: 'partial_failure',
          summary: 'retry_integration_pending:ACC-009,ACC-010',
        })];
      },
      fetchImpl: (async () => {
        postCount += 1;
        return {
          ok: true,
          status: 200,
          text: async () => postCount === 1
            ? JSON.stringify({
                preview: { previewHash: `sha256:${'d'.repeat(64)}`, requiresApproval: false },
                previewIdentity: { schemaVersion: 'retry-preview-identity.v1' },
              })
            : JSON.stringify({ ok: true, runId: 616 }),
        } as unknown as Response;
      }) as typeof fetch,
    });

    const result = await wardenSweep(deps, LEDGER_ENV);
    expect(candidateSql).toContain("run.status IN ('failed', 'partial_failure')");
    expect(candidateParams).toEqual([24 * 60]);
    expect(result.actions[0]).toEqual({
      runId: 611,
      classification: 'closeout_pending',
      action: 're-drive-retry',
    });
    expect(postCount).toBe(2);
    expect(events[0].type).toBe('run_repair_redriven');
  });

  it('dispatches an authoritative timeout retry instead of classifying incidental egress text', async () => {
    let postCount = 0;
    const { deps, events } = makeDeps({
      query: async (sql) => {
        if (sql.includes('run_output_chunks')) {
          return [{ chunk: Buffer.from('Earlier Connection error. output was not the terminal cause.') }];
        }
        return [failedRun({ terminal_reason: 'timeout' })];
      },
      fetchImpl: (async () => {
        postCount += 1;
        return {
          ok: true,
          status: 200,
          text: async () => postCount === 1
            ? JSON.stringify({
                preview: { previewHash: `sha256:${'b'.repeat(64)}`, requiresApproval: false },
                previewIdentity: { schemaVersion: 'retry-preview-identity.v1' },
              })
            : JSON.stringify({ ok: true, runId: 614 }),
        } as unknown as Response;
      }) as typeof fetch,
    });
    const result = await wardenSweep(deps, LEDGER_ENV);
    expect(result.actions[0]).toEqual({ runId: 611, classification: 'timeout', action: 're-drive-retry' });
    expect(postCount).toBe(2);
    expect(events[0].type).toBe('run_repair_redriven');
  });

  it('re-triggers dispatch shape failures with the corrected Pi profile', async () => {
    const posts: string[] = [];
    const bodies: unknown[] = [];
    const fetchImpl = (async (url: string, init?: { body?: string }) => {
      posts.push(String(url));
      bodies.push(JSON.parse(init?.body ?? '{}'));
      return { ok: true, status: 200, text: async () => '{}' } as unknown as Response;
    }) as typeof fetch;
    const { deps } = makeDeps({
      query: async (sql) => {
        if (sql.includes('run_output_chunks')) return [];
        return [failedRun({ summary: 'linux_bwrap_required_for_requested_mode' })];
      },
      fetchImpl,
    });
    const result = await wardenSweep(deps, LEDGER_ENV);
    expect(result.actions[0].action).toBe('re-trigger-corrected');
    expect(posts).toEqual(['http://127.0.0.1:3030/api/pipeline/trigger']);
    expect(bodies[0]).toMatchObject({ agentOverride: 'pi', forceSequential: true, autoMerge: false, mergeStrategy: 'branch-only' });
  });

  it('escalates egress failures when the allowlist is incomplete, with the exact env fix', async () => {
    const { deps, events } = makeDeps({
      query: async (sql) => {
        if (sql.includes('run_output_chunks')) return [];
        return [failedRun({ summary: 'Connection error.' })];
      },
    });
    LEDGER_ENV.RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS = 'api.openai.com';
    try {
      const result = await wardenSweep(deps, LEDGER_ENV);
      expect(result.actions[0].action).toBe('escalate');
      expect(events[0].payload.operator_action).toContain('RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS');
    } finally {
      delete LEDGER_ENV.RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS;
    }
  });

  it('treats egress failures as transient when the allowlist is complete and dispatches the retry', async () => {
    let postCount = 0;
    const { deps, events } = makeDeps({
      query: async (sql) => {
        if (sql.includes('run_output_chunks')) return [];
        return [failedRun({ summary: 'fetch failed' })];
      },
      fetchImpl: (async () => {
        postCount += 1;
        return {
          ok: true,
          status: 200,
          text: async () => postCount === 1
            ? JSON.stringify({
                preview: { previewHash: `sha256:${'c'.repeat(64)}`, requiresApproval: false },
                previewIdentity: { schemaVersion: 'retry-preview-identity.v1' },
              })
            : JSON.stringify({ ok: true, runId: 615 }),
        } as unknown as Response;
      }) as typeof fetch,
    });
    LEDGER_ENV.RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS = 'api.openai.com,chatgpt.com,api.deepseek.com';
    try {
      const result = await wardenSweep(deps, LEDGER_ENV);
      expect(result.actions[0].action).toBe('re-drive-retry');
      expect(postCount).toBe(2);
      expect(events[0].type).toBe('run_repair_redriven');
    } finally {
      delete LEDGER_ENV.RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS;
    }
  });

  it('skips runs whose latest ledger entry has the current classification', async () => {
    await appendWardenLedger({ at: 't', runId: 611, classification: 'quota_exhausted', action: 'escalate', detail: 'x', outcome: 'ok' }, LEDGER_ENV);
    const { deps } = makeDeps({
      query: async (sql) => sql.includes('run_output_chunks')
        ? []
        : [failedRun({ summary: 'rate limit exhausted' })],
    });
    const result = await wardenSweep(deps, LEDGER_ENV);
    expect(result.acted).toBe(0);
  });

  it('escalates stalled running runs without killing them', async () => {
    const { deps, events } = makeDeps({
      query: async () => [{
        id: 613,
        workspace_id: 2,
        started_at: new Date(Date.now() - 10 * 3600_000).toISOString(),
        summary: null,
      }],
    });
    const escalated = await wardenEscalateStalledRuns(deps, 4, LEDGER_ENV);
    expect(escalated).toBe(1);
    expect(events[0].type).toBe('run_repair_escalated');
    expect(events[0].payload.classification).toBe('zombie_loop');
    // Second call: already escalated, no duplicate.
    expect(await wardenEscalateStalledRuns(deps, 4, LEDGER_ENV)).toBe(0);
  });
  it('honors RORCA_HERMES_REPAIR_HOME and defaults under the home dir', () => {
    expect(wardenLedgerDir(LEDGER_ENV)).toBe(LEDGER_ENV.RORCA_HERMES_REPAIR_HOME);
    const clean: NodeJS.ProcessEnv = { ...LEDGER_ENV };
    delete clean.RORCA_HERMES_REPAIR_HOME;
    expect(wardenLedgerDir(clean)).toBe(path.join(os.homedir(), '.rorca', 'hermes-repair'));
  });
});

describe('failure warden pending-approval retry', () => {
  it('escalates a prepared retry that requires human approval instead of claiming a re-drive', async () => {
    const { deps, events } = makeDeps({
      query: async (sql) => {
        if (sql.includes('run_output_chunks')) return [];
        return [failedRun({ summary: 'stale_generation' })];
      },
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, preview: { requiresApproval: true, previewHash: 'sha256:abc' } }),
      }) as unknown as Response) as typeof fetch,
    });
    const result = await wardenSweep(deps, LEDGER_ENV);
    expect(result.actions[0].action).toBe('re-drive-retry');
    // Escalated, not redriven — human approval is required.
    expect(events[0].type).toBe('run_repair_escalated');
    expect(events[0].payload.operator_action).toContain('requiresApproval');
    const entries = await readWardenLedger(611, LEDGER_ENV);
    expect(entries[1].outcome).toBe('failed');
    expect(entries[1].detail).toContain('requiresApproval');
  });
});
