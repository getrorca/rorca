/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-008: Worker IPC PID update tests
 *
 * When the worker spawns execution-engine via tsx, the tsx wrapper (e.g. PID 85596)
 * compiles TypeScript and forks an inner Node.js process (e.g. PID 85599). The tsx
 * wrapper exits within ~1-2s, leaving pipeline_runs.pid pointing at a dead process.
 *
 * Fix: execution-engine calls process.send?.({ type: 'pid', pid: process.pid }) at
 * startup. The worker listens for this IPC message and updates pipeline_runs.pid with
 * the live engine PID.
 *
 * Tests:
 *   (1) IPC 'pid' message triggers pipeline_runs UPDATE with the inner PID
 *   (2) IPC message with wrong type is ignored (no spurious DB update)
 *   (3) IPC message with non-number pid is ignored
 *   (4) Multiple IPC messages — only 'pid' type triggers UPDATE
 *   (5) No IPC message emitted — initial tsx PID remains (fallback is acceptable)
 */

import { EventEmitter } from 'events';

// ── IPC message handler (extracted from worker.ts for unit testing) ───────────

/**
 * Replica of the child.on('message', ...) handler from worker.ts handlePipelineRun.
 * Takes the mock execute function so we can assert it is called correctly.
 */
function attachIpcPidHandler(
  child: EventEmitter,
  runId: number,
  execute: (sql: string, params: unknown[]) => Promise<void>,
  log: (msg: string, meta?: Record<string, unknown>) => void,
): void {
  child.on('message', async (msg: unknown) => {
    if (
      typeof msg === 'object' &&
      msg !== null &&
      (msg as Record<string, unknown>).type === 'pid' &&
      typeof (msg as Record<string, unknown>).pid === 'number'
    ) {
      const enginePid = (msg as Record<string, unknown>).pid as number;
      log(`[worker] Received inner engine PID via IPC — updating pipeline_runs.pid`, { runId, enginePid });
      try {
        await execute('UPDATE pipeline_runs SET pid = $1 WHERE id = $2', [enginePid, runId]);
      } catch (err) {
        log(`[worker] Failed to update pipeline_runs.pid`, { runId, enginePid });
      }
    }
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Worker IPC PID update', () => {

  // ── (1) IPC 'pid' message triggers pipeline_runs UPDATE ──────────────────

  describe('(1) Valid IPC pid message triggers DB update', () => {
    it('calls execute with UPDATE pipeline_runs SET pid=$1 and the inner PID', async () => {
      const runId = 42;
      const innerPid = 99999;
      const execute = jest.fn().mockResolvedValue(undefined);
      const log = jest.fn();

      const child = new EventEmitter();
      attachIpcPidHandler(child, runId, execute, log);

      // Simulate execution-engine sending process.send({ type: 'pid', pid: innerPid })
      child.emit('message', { type: 'pid', pid: innerPid });

      // Allow async handler to complete
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'UPDATE pipeline_runs SET pid = $1 WHERE id = $2',
        [innerPid, runId],
      );
    });

    it('updates pipeline_runs with the exact PID value from the message', async () => {
      const runId = 123;
      const innerPid = 85599;
      const execute = jest.fn().mockResolvedValue(undefined);

      const child = new EventEmitter();
      attachIpcPidHandler(child, runId, execute, jest.fn());

      child.emit('message', { type: 'pid', pid: innerPid });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const [sql, params] = execute.mock.calls[0];
      expect(sql).toContain('UPDATE pipeline_runs SET pid');
      expect(params[0]).toBe(innerPid);
      expect(params[1]).toBe(runId);
    });
  });

  // ── (2) Wrong message type is ignored ────────────────────────────────────

  describe('(2) Non-pid message types are ignored', () => {
    it('does not call execute for messages with type != "pid"', async () => {
      const execute = jest.fn();
      const child = new EventEmitter();
      attachIpcPidHandler(child, 1, execute, jest.fn());

      child.emit('message', { type: 'heartbeat', data: 'some data' });
      child.emit('message', { type: 'status', runId: 1 });
      child.emit('message', { type: 'ready' });

      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(execute).not.toHaveBeenCalled();
    });

    it('does not call execute for null message', async () => {
      const execute = jest.fn();
      const child = new EventEmitter();
      attachIpcPidHandler(child, 1, execute, jest.fn());

      child.emit('message', null);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(execute).not.toHaveBeenCalled();
    });

    it('does not call execute for string message', async () => {
      const execute = jest.fn();
      const child = new EventEmitter();
      attachIpcPidHandler(child, 1, execute, jest.fn());

      child.emit('message', 'pid:12345');
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(execute).not.toHaveBeenCalled();
    });
  });

  // ── (3) Non-number pid field is ignored ──────────────────────────────────

  describe('(3) IPC message with non-number pid is rejected', () => {
    it('does not call execute when pid is a string', async () => {
      const execute = jest.fn();
      const child = new EventEmitter();
      attachIpcPidHandler(child, 1, execute, jest.fn());

      child.emit('message', { type: 'pid', pid: '99999' }); // string, not number
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(execute).not.toHaveBeenCalled();
    });

    it('does not call execute when pid is undefined', async () => {
      const execute = jest.fn();
      const child = new EventEmitter();
      attachIpcPidHandler(child, 1, execute, jest.fn());

      child.emit('message', { type: 'pid' }); // no pid field
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(execute).not.toHaveBeenCalled();
    });

    it('does not call execute when pid is null', async () => {
      const execute = jest.fn();
      const child = new EventEmitter();
      attachIpcPidHandler(child, 1, execute, jest.fn());

      child.emit('message', { type: 'pid', pid: null });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(execute).not.toHaveBeenCalled();
    });
  });

  // ── (4) Mixed IPC messages — only 'pid' triggers UPDATE ──────────────────

  describe('(4) Mixed messages — only type="pid" triggers execute', () => {
    it('filters correctly when pid message is mixed with other message types', async () => {
      const runId = 7;
      const innerPid = 77777;
      const execute = jest.fn().mockResolvedValue(undefined);
      const child = new EventEmitter();
      attachIpcPidHandler(child, runId, execute, jest.fn());

      // Emit several message types; only the pid message should trigger execute
      child.emit('message', { type: 'ready' });
      child.emit('message', { type: 'pid', pid: innerPid });
      child.emit('message', { type: 'heartbeat' });
      child.emit('message', null);
      child.emit('message', { type: 'pid', pid: 'not-a-number' });

      await new Promise<void>((resolve) => setImmediate(resolve));

      // Only the one valid 'pid' message should have triggered execute
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        'UPDATE pipeline_runs SET pid = $1 WHERE id = $2',
        [innerPid, runId],
      );
    });
  });

  // ── (5) execute error is handled gracefully ───────────────────────────────

  describe('(5) DB error in execute does not throw', () => {
    it('swallows execute rejection and continues normally', async () => {
      const execute = jest.fn().mockRejectedValue(new Error('DB connection lost'));
      const log = jest.fn();
      const child = new EventEmitter();
      attachIpcPidHandler(child, 1, execute, log);

      child.emit('message', { type: 'pid', pid: 12345 });

      // Should not throw — error is caught internally
      await expect(
        new Promise<void>((resolve) => setTimeout(resolve, 20)),
      ).resolves.toBeUndefined();

      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  // ── (6) No IPC message — initial tsx PID stays (no regression) ───────────

  describe('(6) No IPC message emitted — no execute call', () => {
    it('does not call execute if no message event is emitted', async () => {
      const execute = jest.fn();
      const child = new EventEmitter();
      attachIpcPidHandler(child, 99, execute, jest.fn());

      // Simulate process exit with no IPC message
      child.emit('exit', 0);
      child.emit('close');

      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(execute).not.toHaveBeenCalled();
    });
  });
});

// ── process.send?.() guard test ───────────────────────────────────────────────

describe('execution-engine process.send guard', () => {
  it('process.send?.() is a no-op when process.send is undefined (standalone mode)', () => {
    // When execution-engine is run standalone (not via worker IPC), process.send is undefined.
    // The optional-chaining guard process.send?.() must not throw in that case.
    const originalSend = process.send;
    try {
      // @ts-ignore — force undefined to simulate standalone invocation
      process.send = undefined;
      // This is exactly what execution-engine.ts calls — must not throw
      expect(() => {
        process.send?.({ type: 'pid', pid: process.pid });
      }).not.toThrow();
    } finally {
      process.send = originalSend;
    }
  });

  it('process.send?.() calls process.send when the IPC channel is present', () => {
    const originalSend = process.send;
    const mockSend = jest.fn().mockReturnValue(true);
    try {
      // @ts-ignore — simulate IPC channel present
      process.send = mockSend;
      process.send?.({ type: 'pid', pid: 12345 });
      expect(mockSend).toHaveBeenCalledWith({ type: 'pid', pid: 12345 });
    } finally {
      process.send = originalSend;
    }
  });
});
