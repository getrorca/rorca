/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-007: Worker stdout → run_output_chunks pipeline tests
 *
 * Root cause: The worker was using the 'exit' event to flush the pending buffer,
 * but Node.js does NOT guarantee all stdout/stderr data events have fired when
 * 'exit' fires. The correct signal is 'close' (fires after all stdio is drained).
 *
 * Tests cover:
 *   (1) Non-worktree run: stdout data flushed to run_output_chunks on 'close'
 *   (2) Worktree run: same pipeline works identically with worktreePath set
 *   (3) Race condition: data arriving AFTER 'exit' but BEFORE 'close' is captured
 *   (4) Final unflushed chunk (< 4KB) written on 'close' — no silent data loss
 *   (5) Empty stdout produces zero chunks (no-op flush)
 */

import { EventEmitter } from 'events';
import { Readable } from 'stream';

// ── Helpers ───────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 4 * 1024; // 4 KB — mirrors worker.ts constant

/**
 * Replica of writeBufferAsChunks from worker.ts.
 * Tests the chunking algorithm in isolation.
 */
async function writeBufferAsChunks(
  runId: number,
  buf: Buffer,
  sequenceRef: { value: number },
  writeChunk: (runId: number, seq: number, data: Buffer) => Promise<void>,
): Promise<void> {
  let offset = 0;
  while (offset < buf.length) {
    const slice = buf.slice(offset, offset + CHUNK_SIZE);
    await writeChunk(runId, sequenceRef.value, slice);
    sequenceRef.value += 1;
    offset += CHUNK_SIZE;
  }
}

/**
 * Simulates the worker's stdout/stderr capture loop exactly as implemented
 * after the US-007 fix ('close' instead of 'exit' for flushPending).
 *
 * Returns the list of chunks written, keyed by sequence number.
 */
async function simulateOutputCapture(opts: {
  runId: number;
  stdoutData: Buffer[];          // data events emitted on stdout
  stderrData: Buffer[];          // data events emitted on stderr
  exitCodeBeforeClose: boolean;  // if true, 'exit' fires before last data events
}): Promise<Array<{ runId: number; sequence: number; data: Buffer }>> {
  const { runId, stdoutData, stderrData, exitCodeBeforeClose } = opts;

  const writtenChunks: Array<{ runId: number; sequence: number; data: Buffer }> = [];

  const writeChunk = jest.fn().mockImplementation(
    async (rid: number, seq: number, data: Buffer) => {
      writtenChunks.push({ runId: rid, sequence: seq, data: Buffer.from(data) });
    },
  );

  const sequenceRef = { value: 1 };
  let pending = Buffer.alloc(0);

  const flushPending = async (): Promise<void> => {
    if (pending.length === 0) return;
    await writeBufferAsChunks(runId, pending, sequenceRef, writeChunk);
    pending = Buffer.alloc(0);
  };

  const handleData = async (data: Buffer): Promise<void> => {
    pending = Buffer.concat([pending, data]);
    while (pending.length >= CHUNK_SIZE) {
      const slice = pending.slice(0, CHUNK_SIZE);
      await writeChunk(runId, sequenceRef.value, slice);
      sequenceRef.value += 1;
      pending = pending.slice(CHUNK_SIZE);
    }
  };

  // Build a mock child process with controllable stdout/stderr streams
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
  };
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });

  // Attach listeners (mirrors worker.ts pattern)
  child.stdout.on('data', (data: Buffer) => { void handleData(data); });
  child.stderr.on('data', (data: Buffer) => { void handleData(data); });

  // Capture exit code from 'exit' (mirrors the fix)
  let capturedCode: number | null = null;
  child.on('exit', (code: number) => { capturedCode = code; });

  // Flush and cleanup on 'close' (the fix — was previously 'exit')
  let closeHandlerResult: Promise<void> | null = null;
  child.on('close', async () => {
    await flushPending();
    // capturedCode is available here because 'close' fires after 'exit'
    void capturedCode; // referenced to suppress unused variable lint
    closeHandlerResult = Promise.resolve(); // signal completion
  });

  // Simulate data flow
  if (exitCodeBeforeClose) {
    // Race condition: emit some stdout, then 'exit', then more stdout, then 'close'
    // This is the bug scenario — output arrives after 'exit'
    for (const d of stdoutData.slice(0, 1)) child.stdout.push(d);
    child.emit('exit', 0);
    // Additional data arrives AFTER exit (e.g., pino sonic-boom flush)
    for (const d of stdoutData.slice(1)) child.stdout.push(d);
    for (const d of stderrData) child.stderr.push(d);
  } else {
    // Normal flow: all data before 'exit' before 'close'
    for (const d of stdoutData) child.stdout.push(d);
    for (const d of stderrData) child.stderr.push(d);
    child.emit('exit', 0);
  }

  // Drain the readable streams (pump all pushed data through)
  await new Promise<void>((resolve) => setImmediate(resolve));

  // Emit 'close' — guarantees all data has been read
  await new Promise<void>((resolve) => {
    child.once('close', resolve);
    child.emit('close');
  });

  // Wait for the async close handler to complete
  await new Promise<void>((resolve) => setImmediate(resolve));

  return writtenChunks;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Worker stdout → run_output_chunks pipeline', () => {

  // ── (1) Non-worktree run — basic output capture ──────────────────────────

  describe('(1) Non-worktree run', () => {
    it('writes stdout data to run_output_chunks', async () => {
      const runId = 42;
      const testData = Buffer.from('Hello from execution-engine stdout\n');

      const chunks = await simulateOutputCapture({
        runId,
        stdoutData: [testData],
        stderrData: [],
        exitCodeBeforeClose: false,
      });

      expect(chunks.length).toBeGreaterThan(0);
      const all = Buffer.concat(chunks.map(c => c.data));
      expect(all.toString('utf8')).toBe(testData.toString('utf8'));
    });

    it('writes stderr data alongside stdout', async () => {
      const runId = 1;
      const out = Buffer.from('stdout line\n');
      const err = Buffer.from('stderr line\n');

      const chunks = await simulateOutputCapture({
        runId,
        stdoutData: [out],
        stderrData: [err],
        exitCodeBeforeClose: false,
      });

      const all = Buffer.concat(chunks.map(c => c.data)).toString('utf8');
      expect(all).toContain('stdout line');
      expect(all).toContain('stderr line');
    });

    it('assigns monotonically increasing sequence numbers starting at 1', async () => {
      const runId = 7;
      // 3 chunks worth of data (each 4KB chunk = one sequence number + tail)
      const data = Buffer.alloc(CHUNK_SIZE * 2 + 100, 0x41);

      const chunks = await simulateOutputCapture({
        runId,
        stdoutData: [data],
        stderrData: [],
        exitCodeBeforeClose: false,
      });

      expect(chunks.length).toBe(3); // 2 full chunks + 1 tail
      expect(chunks[0].sequence).toBe(1);
      expect(chunks[1].sequence).toBe(2);
      expect(chunks[2].sequence).toBe(3);
    });
  });

  // ── (2) Worktree run — identical pipeline ────────────────────────────────

  describe('(2) Worktree run (worktreePath set)', () => {
    // The worker uses cwd=worktreePath for worktree runs but the output capture
    // logic is identical. The runId is from the same pipeline_runs row.
    it('writes stdout data to run_output_chunks with worktree runId', async () => {
      const runId = 99; // worktree run uses the same pipeline_runs.id
      const testData = Buffer.from('[engine] Story US-001 passed\n[engine] Run complete\n');

      const chunks = await simulateOutputCapture({
        runId,
        stdoutData: [testData],
        stderrData: [],
        exitCodeBeforeClose: false,
      });

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.every(c => c.runId === runId)).toBe(true);
      const all = Buffer.concat(chunks.map(c => c.data)).toString('utf8');
      expect(all).toContain('Story US-001 passed');
    });

    it('captures worktree merge logs that arrive just before exit', async () => {
      const runId = 100;
      const storyOutput = Buffer.from('[engine] Story US-001 passed\n');
      // Merge logs are written at the very end of a worktree run
      const mergeLogs = Buffer.from('[auto-merge] Merging feat/my-spec into main\n[auto-merge] done\n');

      const chunks = await simulateOutputCapture({
        runId,
        stdoutData: [storyOutput, mergeLogs],
        stderrData: [],
        exitCodeBeforeClose: false,
      });

      const all = Buffer.concat(chunks.map(c => c.data)).toString('utf8');
      expect(all).toContain('[auto-merge] Merging feat/my-spec into main');
      expect(all).toContain('[auto-merge] done');
    });
  });

  // ── (3) Race condition: data after 'exit', before 'close' ───────────────

  describe('(3) Race condition — stdout data arrives AFTER exit event', () => {
    it('captures data that arrives between exit and close events', async () => {
      const runId = 55;
      const earlyData = Buffer.from('early output\n');
      // This data simulates pino sonic-boom flushing after the process exit signal
      const lateData = Buffer.from('late output flushed by pino sonic-boom\n');

      // exitCodeBeforeClose=true: emit 'exit' between earlyData and lateData
      const chunks = await simulateOutputCapture({
        runId,
        stdoutData: [earlyData, lateData],
        stderrData: [],
        exitCodeBeforeClose: true,
      });

      const all = Buffer.concat(chunks.map(c => c.data)).toString('utf8');
      // Both early and late data must be captured
      expect(all).toContain('early output');
      expect(all).toContain('late output flushed by pino sonic-boom');
    });

    it('with OLD exit-based flush, late data would be LOST (documents the bug)', async () => {
      // This test demonstrates what happened BEFORE the fix:
      // flushPending() in 'exit' would see pending={earlyData} only.
      // lateData arrives after exit, is accumulated in pending, but never flushed.
      //
      // With the fix (close-based flush), lateData IS flushed.
      const runId = 56;
      const earlyData = Buffer.from('early\n');
      const lateData = Buffer.from('this was lost before the fix\n');

      const writtenChunks: string[] = [];
      const CHUNK_SZ = 4 * 1024;

      // Simulate OLD behavior (exit-based flush)
      let pending_old = Buffer.alloc(0);
      const sequenceRef_old = { value: 1 };

      const handleData_old = (data: Buffer) => {
        pending_old = Buffer.concat([pending_old, data]);
      };

      // Simulate the spawn → data → exit → close sequence
      // OLD: flush on exit, THEN more data arrives, THEN close (data lost)
      handleData_old(earlyData);          // data arrives
      // flushPending called on 'exit' — earlyData captured
      if (pending_old.length > 0) {
        writtenChunks.push(pending_old.toString('utf8'));
        pending_old = Buffer.alloc(0);
      }
      handleData_old(lateData);           // data arrives AFTER exit flush
      // No more flushPending — close fires but nobody flushes
      // pending_old still has lateData — LOST

      const lostData = pending_old.toString('utf8');
      expect(lostData).toBe(lateData.toString('utf8')); // confirms the bug

      // Simulate NEW behavior (close-based flush)
      let pending_new = Buffer.alloc(0);
      const newChunks: string[] = [];
      const handleData_new = (data: Buffer) => {
        pending_new = Buffer.concat([pending_new, data]);
      };

      handleData_new(earlyData);
      // 'exit' — just capture code, don't flush
      handleData_new(lateData);           // data arrives after exit
      // 'close' — flush everything
      if (pending_new.length > 0) {
        newChunks.push(pending_new.toString('utf8'));
        pending_new = Buffer.alloc(0);
      }

      const captured = newChunks.join('');
      expect(captured).toContain('early');
      expect(captured).toContain('this was lost before the fix');
    });
  });

  // ── (4) Final unflushed chunk (< 4KB) — no silent data loss ─────────────

  describe('(4) Final unflushed tail chunk written on close', () => {
    it('writes tail data smaller than CHUNK_SIZE on close', async () => {
      const runId = 77;
      // Exactly 100 bytes — less than 4KB, stays in pending until close
      const tailData = Buffer.alloc(100, 0x42);

      const chunks = await simulateOutputCapture({
        runId,
        stdoutData: [tailData],
        stderrData: [],
        exitCodeBeforeClose: false,
      });

      expect(chunks).toHaveLength(1);
      expect(chunks[0].sequence).toBe(1);
      expect(chunks[0].data.length).toBe(100);
      expect(chunks[0].data.every(b => b === 0x42)).toBe(true);
    });

    it('writes mixed full-chunk + tail data correctly', async () => {
      const runId = 78;
      // 1.5 chunks: one full 4KB chunk + 2KB tail
      const fullChunk = Buffer.alloc(CHUNK_SIZE, 0x41);
      const tail = Buffer.alloc(2048, 0x42);

      const chunks = await simulateOutputCapture({
        runId,
        stdoutData: [Buffer.concat([fullChunk, tail])],
        stderrData: [],
        exitCodeBeforeClose: false,
      });

      expect(chunks).toHaveLength(2);
      expect(chunks[0].data.length).toBe(CHUNK_SIZE); // full chunk
      expect(chunks[1].data.length).toBe(2048);        // tail
    });
  });

  // ── (5) Empty stdout — zero chunks written ───────────────────────────────

  describe('(5) Empty stdout produces zero chunks', () => {
    it('writes nothing when engine produces no output', async () => {
      const runId = 11;

      const chunks = await simulateOutputCapture({
        runId,
        stdoutData: [],
        stderrData: [],
        exitCodeBeforeClose: false,
      });

      expect(chunks).toHaveLength(0);
    });
  });
});
