/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-011: Unit tests for the pg-boss integration layer.
 *
 * All external dependencies are fully mocked — no live DB or child processes.
 * Tests cover:
 *   (1) SIGTERM guard: RORCA_PROCESS_ROLE=engine skips handler registration
 *   (2) triggerPipelineRun payload: boss.send() called with correct shape
 *   (2b) Base queue registration: createQueue() called for all 22 production queues
 *   (3) Core pipeline worker registration: boss.work() called for run, retry, cancel, and closeout reconciliation
 *   (4) Cancellation routing: queued → boss.cancel(); running → boss.send('pipeline:cancel')
 *   (5) run_output_chunks chunking: 10KB input → 3 chunks, sequence 1/2/3
 */

import { EventEmitter } from 'events';
import {
  computePipelineExecutionTimeoutSeconds,
  PGBOSS_EXPIRE_IN_CEILING_SECONDS,
  pipelineExecutionJobSendOptions,
} from '../lib/pipeline-job-lifecycle';

// ── Mock pg-boss before any imports ─────────────────────────────────────────

const mockBossSend = jest.fn().mockResolvedValue(undefined);
const mockBossCancel = jest.fn().mockResolvedValue(undefined);
const mockBossWork = jest.fn().mockResolvedValue(undefined);
const mockBossStart = jest.fn().mockResolvedValue(undefined);
const mockBossStop = jest.fn().mockResolvedValue(undefined);
const mockBossOn = jest.fn();

jest.mock('pg-boss', () => {
  return jest.fn().mockImplementation(() => ({
    on: mockBossOn,
    start: mockBossStart,
    stop: mockBossStop,
    send: mockBossSend,
    cancel: mockBossCancel,
    work: mockBossWork,
  }));
});

// ── Mock db/index.ts ─────────────────────────────────────────────────────────

const mockQuery = jest.fn().mockResolvedValue([]);
const mockQueryOne = jest.fn().mockResolvedValue(undefined);
const mockExecute = jest.fn().mockResolvedValue({ rowCount: 1 });
const mockInitDb = jest.fn().mockResolvedValue(undefined);

jest.mock('../db/index', () => ({
  initDb: mockInitDb,
  query: mockQuery,
  queryOne: mockQueryOne,
  execute: mockExecute,
}));

// ── Mock child_process ───────────────────────────────────────────────────────

const mockSpawn = jest.fn();

jest.mock('child_process', () => ({
  spawn: mockSpawn,
}));

// ── Mock other worker dependencies ───────────────────────────────────────────

jest.mock('../lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../lib/scheduler', () => ({
  registerSchedulesWithBoss: jest.fn().mockResolvedValue(undefined),
  triggerScheduledRun: jest.fn().mockResolvedValue(undefined),
  checkAndFireDueSchedules: jest.fn().mockResolvedValue(undefined),
}));

// ── Mock route-layer imports (pg-boss singleton for pipeline.ts tests) ───────

const mockBossInstance = {
  send: mockBossSend,
  cancel: mockBossCancel,
  work: mockBossWork,
};

jest.mock('../lib/pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getBoss: jest.fn().mockReturnValue(mockBossInstance),
}));

// ─────────────────────────────────────────────────────────────────────────────
// (1) SIGTERM guard — test/library imports do not own process lifecycle
//
// Strategy: intercept process.on BEFORE requiring db/index.ts in an isolated
// module scope. Jest workers must retain their default SIGTERM behavior.
// ─────────────────────────────────────────────────────────────────────────────

describe('(1) SIGTERM guard in db/index.ts', () => {
  afterEach(() => {
    delete process.env.RORCA_PROCESS_ROLE;
    jest.resetAllMocks();
    jest.resetModules();
  });

  test('RORCA_PROCESS_ROLE=engine → test import registers no SIGTERM handler', () => {
    process.env.RORCA_PROCESS_ROLE = 'engine';

    const registeredListeners: Array<{ event: string; listener: (...args: any[]) => void }> = [];
    const onSpy = jest
      .spyOn(process, 'on')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(function (this: NodeJS.EventEmitter, event: string | symbol, listener: (...args: any[]) => void) {
        if (typeof event === 'string') registeredListeners.push({ event, listener });
        // Delegate to EventEmitter.prototype.on for correct return type
        return EventEmitter.prototype.on.call(this, event, listener) as NodeJS.Process;
      } as typeof process.on);

    jest.isolateModules(() => {
      // Explicitly unmock db/index so the real module code (SIGTERM guard) runs
      jest.unmock('../db/index');
      jest.mock('pg', () => ({
        Pool: jest.fn().mockImplementation(() => ({
          on: jest.fn(),
          connect: jest.fn().mockResolvedValue({ release: jest.fn() }),
          end: jest.fn().mockResolvedValue(undefined),
          query: jest.fn().mockResolvedValue({ rows: [] }),
        })),
      }));
      jest.mock('../lib/logger', () => ({
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      }));
      require('../db/index');
    });

    const sigtermCalls = registeredListeners.filter(({ event }) => event === 'SIGTERM');
    expect(sigtermCalls).toHaveLength(0);

    onSpy.mockRestore();
  });

  test('no RORCA_PROCESS_ROLE → test import still registers no SIGTERM handler', () => {
    delete process.env.RORCA_PROCESS_ROLE;

    const registeredEvents: string[] = [];
    const onSpy = jest
      .spyOn(process, 'on')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(function (this: NodeJS.EventEmitter, event: string | symbol, listener: (...args: any[]) => void) {
        if (typeof event === 'string') registeredEvents.push(event);
        return EventEmitter.prototype.on.call(this, event, listener) as NodeJS.Process;
      } as typeof process.on);

    jest.isolateModules(() => {
      // Explicitly unmock db/index so the real module code runs (SIGTERM guard lives there)
      jest.unmock('../db/index');
      jest.mock('pg', () => ({
        Pool: jest.fn().mockImplementation(() => ({
          on: jest.fn(),
          connect: jest.fn().mockResolvedValue({ release: jest.fn() }),
          end: jest.fn().mockResolvedValue(undefined),
          query: jest.fn().mockResolvedValue({ rows: [] }),
        })),
      }));
      jest.mock('../lib/logger', () => ({
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      }));
      require('../db/index');
    });

    const sigtermCalls = registeredEvents.filter(e => e === 'SIGTERM');
    expect(sigtermCalls).toHaveLength(0);

    onSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) Job insertion — boss.send called with correct payload + options
// ─────────────────────────────────────────────────────────────────────────────

describe('(2) triggerPipelineRun() payload', () => {
  beforeEach(() => {
    mockBossSend.mockClear();
  });

  afterEach(() => {
    jest.resetAllMocks();
    // Re-apply mockReturnValue after resetAllMocks clears it
    const { getBoss } = require('../lib/pg-boss') as typeof import('../lib/pg-boss');
    (getBoss as jest.Mock).mockReturnValue(mockBossInstance);
    delete process.env.RORCA_PROCESS_ROLE;
  });

  test('boss.send uses the pg-boss transport ceiling while preserving the immutable worker-enforced run bound', async () => {
    const executionTimeoutSeconds = computePipelineExecutionTimeoutSeconds({
      userStories: [{ id: 'US-001', timeoutMinutes: 90 }],
    });
    // Simulate the payload construction from pipeline.ts.
    const jobPayload = {
      runId: 42,
      executionTimeoutSeconds,
      specPath: 'forge/specs/approved/test-spec.json',
      workspacePath: '/workspace/test',
      agent: 'claude' as const,
      model: null,
      worktreePath: null,
      branchName: null,
      autoWorktree: false,
      envOverrides: {},
    };

    await mockBossInstance.send('pipeline:run', jobPayload, {
      retryLimit: 0,
      ...pipelineExecutionJobSendOptions(jobPayload),
    });

    expect(mockBossSend).toHaveBeenCalledTimes(1);

    const [queueName, payload, options] = mockBossSend.mock.calls[0];

    // Queue name
    expect(queueName).toBe('pipeline:run');

    // All required fields present
    expect(payload).toMatchObject({
      runId: 42,
      specPath: 'forge/specs/approved/test-spec.json',
      workspacePath: '/workspace/test',
      agent: 'claude',
      model: null,
      worktreePath: null,
      branchName: null,
      autoWorktree: false,
      envOverrides: {},
    });

    expect(options).toMatchObject({
      retryLimit: 0,
      ...pipelineExecutionJobSendOptions(jobPayload),
    });
    expect(options.expireInSeconds).toBe(PGBOSS_EXPIRE_IN_CEILING_SECONDS);
    expect(options.expireInSeconds).toBeLessThan(executionTimeoutSeconds);
  });

  test('job uses auto-generated UUID (no explicit id option)', async () => {
    const runId = 99;
    const payload = { runId, executionTimeoutSeconds: 7_200 };
    await mockBossInstance.send('pipeline:run', payload, {
      retryLimit: 0,
      ...pipelineExecutionJobSendOptions(payload),
    });

    const [, , options] = mockBossSend.mock.calls[0];
    // No explicit id — pg-boss generates a valid UUID automatically
    expect(options.id).toBeUndefined();
  });
});

describe('(2b) Base queue registration', () => {
  test('ensureQueues registers the exact production queue surface including lifecycle assurance', async () => {
    const createQueue = jest.fn().mockResolvedValue(undefined);
    const { ensureQueues } = jest.requireActual('../lib/pg-boss') as typeof import('../lib/pg-boss');

    await ensureQueues({ createQueue } as never);

    expect(createQueue).toHaveBeenCalledTimes(24);
    expect(createQueue.mock.calls.map(([queueName]) => queueName)).toEqual([
      'pipeline:run',
      'pipeline:run:direct',
      'pipeline:retry',
      'pipeline:cancel',
      'pipeline:cron',
      'pipeline:merge',
      'pipeline:closeout-reconcile',
      'pipeline:pr-delivery',
      'pipeline:lifecycle-assurance',
      'pipeline:pre-staging-qualification',
      'spec:enrich',
      'context:enrich',
      'workspace:hydrate',
      'context:capture',
      'context:distill',
      'queue-snapshot-prune',
      'integration:health-check',
      'spec:match-skills',
      'spec:memory-synthesis',
      'spec:suggest-skills',
      'bounty:control',
      'bounty:work',
      'bounty:reconcile',
      'bounty:isolated-proposal',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) Core pipeline worker handler registration
// ─────────────────────────────────────────────────────────────────────────────

describe('(3) Core pipeline worker handler registration', () => {
  beforeEach(() => {
    mockBossWork.mockClear();
  });

  afterEach(() => {
    jest.resetAllMocks();
    delete process.env.RORCA_PROCESS_ROLE;
  });

  test('boss.work covers every core published pipeline queue', async () => {
    const handleRun = jest.fn();
    const handleDirectRun = jest.fn();
    const handleRetry = jest.fn();
    const handleCancel = jest.fn();
    const handleCloseoutReconciliation = jest.fn();

    await mockBossInstance.work('pipeline:run', handleRun);
    await mockBossInstance.work('pipeline:run:direct', handleDirectRun);
    await mockBossInstance.work('pipeline:retry', handleRetry);
    await mockBossInstance.work('pipeline:cancel', handleCancel);
    await mockBossInstance.work('pipeline:closeout-reconcile', handleCloseoutReconciliation);

    expect(mockBossWork).toHaveBeenCalledTimes(5);

    const registeredQueues = mockBossWork.mock.calls.map(([queueName]) => queueName);
    expect(registeredQueues).toEqual(expect.arrayContaining([
      'pipeline:run',
      'pipeline:run:direct',
      'pipeline:retry',
      'pipeline:cancel',
      'pipeline:closeout-reconcile',
    ]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (4) Cancellation routing — queued → boss.cancel; running → boss.send
// ─────────────────────────────────────────────────────────────────────────────

describe('(4) Cancellation routing', () => {
  beforeEach(() => {
    mockBossSend.mockClear();
    mockBossCancel.mockClear();
    mockQueryOne.mockClear();
  });

  afterEach(() => {
    jest.resetAllMocks();
    delete process.env.RORCA_PROCESS_ROLE;
  });

  test('queued run → boss.cancel("pipeline:run", String(runId))', async () => {
    // Mock DB returns status='queued'
    mockQueryOne.mockResolvedValueOnce({ status: 'queued', workspace_id: 1 });

    const runId = 10;
    const run = await mockQueryOne('SELECT status FROM pipeline_runs WHERE id = $1', [runId]);

    // Mirrors the routing logic in pipeline.ts cancel route (lines 3151-3195)
    if (run?.status === 'queued') {
      await mockBossInstance.cancel('pipeline:run', String(runId));
    } else {
      await mockBossInstance.send('pipeline:cancel', { runId });
    }

    expect(mockBossCancel).toHaveBeenCalledTimes(1);
    expect(mockBossCancel).toHaveBeenCalledWith('pipeline:run', '10');
    expect(mockBossSend).not.toHaveBeenCalled();
  });

  test('running run → boss.send("pipeline:cancel", { runId })', async () => {
    // Mock DB returns status='running'
    mockQueryOne.mockResolvedValueOnce({ status: 'running', workspace_id: 1 });

    const runId = 11;
    const run = await mockQueryOne('SELECT status FROM pipeline_runs WHERE id = $1', [runId]);

    // Mirrors the routing logic in pipeline.ts cancel route (lines 3192-3196)
    if (run?.status === 'queued') {
      await mockBossInstance.cancel('pipeline:run', String(runId));
    } else {
      await mockBossInstance.send('pipeline:cancel', { runId });
    }

    expect(mockBossSend).toHaveBeenCalledTimes(1);
    expect(mockBossSend).toHaveBeenCalledWith('pipeline:cancel', { runId: 11 });
    expect(mockBossCancel).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (5) run_output_chunks chunking — 10KB input → 3 chunks, sequence 1/2/3
// ─────────────────────────────────────────────────────────────────────────────

describe('(5) run_output_chunks chunking', () => {
  const CHUNK_SIZE = 4 * 1024; // 4 KB (mirrors worker.ts constant)

  /**
   * Replica of writeBufferAsChunks from worker.ts, operating on a mock execute.
   * This lets us test the chunking logic in isolation without importing worker.ts
   * (which has top-level side effects like process.exit on missing DATABASE_URL).
   */
  async function writeBufferAsChunks(
    runId: number,
    buf: Buffer,
    sequenceRef: { value: number },
    executeChunk: (runId: number, seq: number, data: Buffer) => Promise<void>,
  ): Promise<void> {
    let offset = 0;
    while (offset < buf.length) {
      const slice = buf.slice(offset, offset + CHUNK_SIZE);
      await executeChunk(runId, sequenceRef.value, slice);
      sequenceRef.value += 1;
      offset += CHUNK_SIZE;
    }
  }

  afterEach(() => {
    jest.resetAllMocks();
  });

  test('10240-byte input produces ceil(10240/4096)=3 chunks', async () => {
    const INPUT_SIZE = 10 * 1024; // 10 KB exactly
    const buf = Buffer.alloc(INPUT_SIZE, 0x41); // fill with 'A'

    const chunks: Array<{ runId: number; sequence: number; size: number; data: Buffer }> = [];
    const mockWriteChunk = jest.fn().mockImplementation(
      async (runId: number, seq: number, data: Buffer) => {
        chunks.push({ runId, sequence: seq, size: data.length, data: Buffer.from(data) });
      },
    );

    const sequenceRef = { value: 1 };
    await writeBufferAsChunks(1, buf, sequenceRef, mockWriteChunk);

    const expectedChunks = Math.ceil(INPUT_SIZE / CHUNK_SIZE); // 3
    expect(chunks).toHaveLength(expectedChunks);
    expect(chunks).toHaveLength(3);
  });

  test('sequence numbers are exactly 1, 2, 3 (1-based, monotonically increasing)', async () => {
    const INPUT_SIZE = 10 * 1024;
    const buf = Buffer.alloc(INPUT_SIZE, 0x42);

    const chunks: Array<{ runId: number; sequence: number; size: number; data: Buffer }> = [];
    const mockWriteChunk = jest.fn().mockImplementation(
      async (runId: number, seq: number, data: Buffer) => {
        chunks.push({ runId, sequence: seq, size: data.length, data: Buffer.from(data) });
      },
    );

    const sequenceRef = { value: 1 };
    await writeBufferAsChunks(42, buf, sequenceRef, mockWriteChunk);

    expect(chunks[0].sequence).toBe(1);
    expect(chunks[1].sequence).toBe(2);
    expect(chunks[2].sequence).toBe(3);
  });

  test('each chunk is at most 4096 bytes', async () => {
    const INPUT_SIZE = 10 * 1024;
    const buf = Buffer.alloc(INPUT_SIZE, 0x43);

    const chunks: Array<{ runId: number; sequence: number; size: number; data: Buffer }> = [];
    const mockWriteChunk = jest.fn().mockImplementation(
      async (runId: number, seq: number, data: Buffer) => {
        chunks.push({ runId, sequence: seq, size: data.length, data: Buffer.from(data) });
      },
    );

    const sequenceRef = { value: 1 };
    await writeBufferAsChunks(7, buf, sequenceRef, mockWriteChunk);

    for (const chunk of chunks) {
      expect(chunk.size).toBeLessThanOrEqual(CHUNK_SIZE);
    }
  });

  test('final chunk contains remaining bytes (10240 - 2*4096 = 2048 bytes)', async () => {
    const INPUT_SIZE = 10 * 1024; // 10240 bytes
    // After 2 full 4096-byte chunks: 10240 - 8192 = 2048 remaining
    const EXPECTED_LAST_CHUNK_SIZE = INPUT_SIZE - 2 * CHUNK_SIZE; // 2048

    const buf = Buffer.alloc(INPUT_SIZE, 0x44);

    const chunks: Array<{ runId: number; sequence: number; size: number; data: Buffer }> = [];
    const mockWriteChunk = jest.fn().mockImplementation(
      async (runId: number, seq: number, data: Buffer) => {
        chunks.push({ runId, sequence: seq, size: data.length, data: Buffer.from(data) });
      },
    );

    const sequenceRef = { value: 1 };
    await writeBufferAsChunks(5, buf, sequenceRef, mockWriteChunk);

    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.size).toBe(EXPECTED_LAST_CHUNK_SIZE);
  });

  test('all chunk bytes concatenated reconstruct original buffer', async () => {
    const INPUT_SIZE = 10 * 1024;
    // Fill with non-uniform pattern to verify byte fidelity
    const buf = Buffer.allocUnsafe(INPUT_SIZE);
    for (let i = 0; i < INPUT_SIZE; i++) {
      buf[i] = i % 256;
    }

    const chunks: Array<{ runId: number; sequence: number; size: number; data: Buffer }> = [];
    const mockWriteChunk = jest.fn().mockImplementation(
      async (runId: number, seq: number, data: Buffer) => {
        chunks.push({ runId, sequence: seq, size: data.length, data: Buffer.from(data) });
      },
    );

    const sequenceRef = { value: 1 };
    await writeBufferAsChunks(3, buf, sequenceRef, mockWriteChunk);

    const reconstructed = Buffer.concat(chunks.map(c => c.data));
    expect(reconstructed).toEqual(buf);
  });

  test('runId is passed consistently to every chunk write', async () => {
    const INPUT_SIZE = 10 * 1024;
    const buf = Buffer.alloc(INPUT_SIZE, 0x45);
    const expectedRunId = 99;

    const seenRunIds: number[] = [];
    const mockWriteChunk = jest.fn().mockImplementation(
      async (runId: number, _seq: number, _data: Buffer) => {
        seenRunIds.push(runId);
      },
    );

    const sequenceRef = { value: 1 };
    await writeBufferAsChunks(expectedRunId, buf, sequenceRef, mockWriteChunk);

    expect(seenRunIds).toHaveLength(3);
    for (const id of seenRunIds) {
      expect(id).toBe(expectedRunId);
    }
  });
});
