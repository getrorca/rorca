/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-004 / US-007: Tests for FlushBuffer class.
 *
 * Originally tested a hand-rolled harness replicating worker.ts inline logic.
 * Now tests the extracted FlushBuffer class directly:
 *   (1) Sub-chunk data flushes after debounce interval
 *   (2) Timer resets when new data arrives before timeout
 *   (3) Size-based flush (>= chunkSize) cancels the pending timer
 *   (4) close() flushes remaining buffer immediately
 *   (5) No empty flush — timer firing on empty buffer is a no-op
 *   (6) Concurrent rapid writes crossing chunk boundary mid-timer
 *
 * Uses jest.useFakeTimers() for deterministic control over setTimeout/clearTimeout.
 */

import { FlushBuffer } from '../lib/flush-buffer';

// ── Constants ────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 4 * 1024; // 4 KB
const FLUSH_INTERVAL = 500;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('FlushBuffer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createBuffer() {
    const written: Buffer[] = [];
    const buf = new FlushBuffer({
      chunkSize: CHUNK_SIZE,
      flushInterval: FLUSH_INTERVAL,
      onFlush: async (data) => { written.push(Buffer.from(data)); },
    });
    return { buf, written };
  }

  it('flushes sub-4KB data after 500ms timeout', async () => {
    const { buf, written } = createBuffer();
    const payload = Buffer.alloc(100, 0x41);

    await buf.write(payload);

    // No immediate flush — data is below 4KB
    expect(written).toHaveLength(0);

    // Advance past the 500ms debounce window
    jest.advanceTimersByTime(500);
    await jest.runAllTimersAsync();

    expect(written).toHaveLength(1);
    expect(written[0].length).toBe(100);
    expect(written[0].every((b) => b === 0x41)).toBe(true);
  });

  it('resets timer when new data arrives before timeout', async () => {
    const { buf, written } = createBuffer();
    const first = Buffer.alloc(50, 0x42);
    const second = Buffer.alloc(50, 0x43);

    // T=0: send first 50 bytes
    await buf.write(first);

    // T=300ms: send second 50 bytes — this resets the timer
    jest.advanceTimersByTime(300);
    await buf.write(second);

    // T=500ms from initial send — should NOT have flushed (timer was reset at T=300)
    jest.advanceTimersByTime(200);
    await Promise.resolve();
    expect(written).toHaveLength(0);

    // T=800ms (500ms after second send) — now the timer fires
    jest.advanceTimersByTime(300);
    await jest.runAllTimersAsync();

    expect(written).toHaveLength(1);
    expect(written[0].length).toBe(100); // 50 + 50 concatenated
    expect(written[0].slice(0, 50).every((b) => b === 0x42)).toBe(true);
    expect(written[0].slice(50).every((b) => b === 0x43)).toBe(true);
  });

  it('size-based flush (4KB+) cancels the pending timer', async () => {
    const { buf, written } = createBuffer();

    // Send sub-4KB first — starts a timer
    const small = Buffer.alloc(100, 0x44);
    await buf.write(small);
    expect(buf.hasTimer).toBe(true);

    // Send enough to cross 4KB boundary (100 + 4000 = 4100 > 4096)
    const large = Buffer.alloc(4000, 0x45);
    await buf.write(large);

    // 4096 bytes were flushed immediately as one chunk
    expect(written).toHaveLength(1);
    expect(written[0].length).toBe(CHUNK_SIZE);

    // Remaining 4 bytes (4100 - 4096) — a new timer is set for those
    // Let the new timer fire
    jest.advanceTimersByTime(500);
    await jest.runAllTimersAsync();

    expect(written).toHaveLength(2);
    expect(written[1].length).toBe(4); // leftover tail
  });

  it('size-based flush that consumes all data cancels timer entirely', async () => {
    const { buf, written } = createBuffer();

    // Send sub-4KB — starts timer
    const small = Buffer.alloc(100, 0x44);
    await buf.write(small);
    expect(buf.hasTimer).toBe(true);

    // Send exactly enough to make total = 4096 (100 + 3996)
    const exact = Buffer.alloc(3996, 0x45);
    await buf.write(exact);

    // Immediate flush of exactly 4096 bytes, zero remainder
    expect(written).toHaveLength(1);
    expect(written[0].length).toBe(CHUNK_SIZE);

    // Timer must be cancelled — no pending data
    expect(buf.hasTimer).toBe(false);

    // Advancing time should produce no additional flushes
    jest.advanceTimersByTime(1000);
    await jest.runAllTimersAsync();
    expect(written).toHaveLength(1);
  });

  it('close() flushes remaining buffer without waiting for timer', async () => {
    const { buf, written } = createBuffer();
    const payload = Buffer.alloc(200, 0x46);

    await buf.write(payload);
    expect(written).toHaveLength(0);
    expect(buf.hasTimer).toBe(true);

    // Simulate process 'close' — calls close() immediately
    await buf.close();

    expect(written).toHaveLength(1);
    expect(written[0].length).toBe(200);
    // Timer should be cleared by close
    expect(buf.hasTimer).toBe(false);
  });

  it('does not write when timer fires on empty buffer', async () => {
    const { buf, written } = createBuffer();
    const payload = Buffer.alloc(100, 0x47);

    await buf.write(payload);

    // Let the timer flush
    jest.advanceTimersByTime(500);
    await jest.runAllTimersAsync();
    expect(written).toHaveLength(1);

    // Send no new data, advance timers again — should produce no writes
    jest.advanceTimersByTime(1000);
    await jest.runAllTimersAsync();
    expect(written).toHaveLength(1);
  });

  it('does not flush when close() is called on already-empty buffer', async () => {
    const { buf, written } = createBuffer();

    await buf.close();

    expect(written).toHaveLength(0);
  });

  it('handles rapid sequential writes crossing 4KB boundary mid-timer', async () => {
    const { buf, written } = createBuffer();

    // Simulate rapid sequential writes: 10 x 500 bytes = 5000 bytes total
    for (let i = 0; i < 10; i++) {
      await buf.write(Buffer.alloc(500, 0x48 + i));
    }

    // After 10 writes of 500 bytes each (5000 total):
    // - 1 full 4KB chunk flushed immediately (bytes 0-4095)
    // - 904 bytes remain in pending buffer (5000 - 4096)
    expect(written).toHaveLength(1);
    expect(written[0].length).toBe(CHUNK_SIZE);

    // Let the debounce timer flush the remainder
    jest.advanceTimersByTime(500);
    await jest.runAllTimersAsync();

    expect(written).toHaveLength(2);
    expect(written[1].length).toBe(5000 - CHUNK_SIZE); // 904 bytes
  });

  it('handles multiple 4KB boundaries in a single large write', async () => {
    const { buf, written } = createBuffer();

    // Send 10000 bytes in one go — should produce 2 immediate 4KB chunks + 1808 byte tail
    await buf.write(Buffer.alloc(10000, 0x50));

    expect(written).toHaveLength(2);
    expect(written[0].length).toBe(CHUNK_SIZE);
    expect(written[1].length).toBe(CHUNK_SIZE);

    // 10000 - 8192 = 1808 bytes pending — flushed after timer
    jest.advanceTimersByTime(500);
    await jest.runAllTimersAsync();

    expect(written).toHaveLength(3);
    expect(written[2].length).toBe(10000 - 2 * CHUNK_SIZE);
  });

  it('supports custom chunkSize and flushInterval', async () => {
    const written: Buffer[] = [];
    const buf = new FlushBuffer({
      chunkSize: 100,
      flushInterval: 200,
      onFlush: async (data) => { written.push(Buffer.from(data)); },
    });

    // Write 250 bytes — should flush 2 x 100-byte chunks, leave 50 pending
    await buf.write(Buffer.alloc(250, 0x51));

    expect(written).toHaveLength(2);
    expect(written[0].length).toBe(100);
    expect(written[1].length).toBe(100);

    // Custom interval: 200ms
    jest.advanceTimersByTime(200);
    await jest.runAllTimersAsync();

    expect(written).toHaveLength(3);
    expect(written[2].length).toBe(50);
  });
});
