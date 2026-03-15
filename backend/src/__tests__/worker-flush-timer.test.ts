/**
 * US-004: Flush timer tests for the handleData() debounce logic added in US-001.
 *
 * The worker buffers sub-4KB stdout/stderr data and flushes it after 500ms of
 * inactivity (debounce). These tests verify:
 *   (1) Sub-4KB data flushes after 500ms timer fires
 *   (2) Timer resets when new data arrives before timeout
 *   (3) Size-based flush (4KB+) cancels the pending timer
 *   (4) Process close flushes remaining buffer immediately
 *   (5) No empty flush — timer firing on empty buffer is a no-op
 *   (6) Concurrent rapid writes crossing 4KB boundary mid-timer
 *
 * Uses jest.useFakeTimers() for deterministic control over setTimeout/clearTimeout.
 */

// ── Constants (mirror worker.ts) ──────────────────────────────────────────────

const CHUNK_SIZE = 4 * 1024; // 4 KB
const FLUSH_TIMER_MS = 500;

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChunkRecord {
  runId: number;
  sequence: number;
  data: Buffer;
}

// ── Testable replica of worker.ts handleData + flushPending ───────────────────

function createFlushHarness(runId: number) {
  const written: ChunkRecord[] = [];
  const sequenceRef = { value: 1 };
  let pending = Buffer.alloc(0);
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const writeChunk = async (rid: number, seq: number, data: Buffer): Promise<void> => {
    written.push({ runId: rid, sequence: seq, data: Buffer.from(data) });
  };

  const writeBufferAsChunks = async (buf: Buffer): Promise<void> => {
    let offset = 0;
    while (offset < buf.length) {
      const slice = buf.slice(offset, offset + CHUNK_SIZE);
      await writeChunk(runId, sequenceRef.value, slice);
      sequenceRef.value += 1;
      offset += CHUNK_SIZE;
    }
  };

  const flushPending = async (): Promise<void> => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (pending.length === 0) return;
    await writeBufferAsChunks(pending);
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
    if (pending.length > 0) {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(() => { void flushPending(); }, FLUSH_TIMER_MS);
    } else if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  return {
    written,
    handleData,
    flushPending,
    getFlushTimer: () => flushTimer,
    getPending: () => pending,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Worker flush timer (handleData debounce)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('flushes sub-4KB data after 500ms timeout', async () => {
    const { handleData, written } = createFlushHarness(42);
    const payload = Buffer.alloc(100, 0x41); // 100 bytes of 'A'

    await handleData(payload);

    // No immediate flush — data is below 4KB
    expect(written).toHaveLength(0);

    // Advance past the 500ms debounce window
    jest.advanceTimersByTime(500);

    // flushPending fires via setTimeout callback — need to drain microtasks
    await jest.runAllTimersAsync();

    expect(written).toHaveLength(1);
    expect(written[0].runId).toBe(42);
    expect(written[0].sequence).toBe(1);
    expect(written[0].data.length).toBe(100);
    expect(written[0].data.every((b) => b === 0x41)).toBe(true);
  });

  it('resets timer when new data arrives before timeout', async () => {
    const { handleData, written } = createFlushHarness(42);
    const first = Buffer.alloc(50, 0x42);
    const second = Buffer.alloc(50, 0x43);

    // T=0: send first 50 bytes
    await handleData(first);

    // T=300ms: send second 50 bytes — this resets the timer
    jest.advanceTimersByTime(300);
    await handleData(second);

    // T=500ms from initial send — should NOT have flushed (timer was reset at T=300)
    jest.advanceTimersByTime(200);
    // Drain any timers that might have fired
    await Promise.resolve();
    expect(written).toHaveLength(0);

    // T=800ms (500ms after second send) — now the timer fires
    jest.advanceTimersByTime(300);
    await jest.runAllTimersAsync();

    expect(written).toHaveLength(1);
    expect(written[0].data.length).toBe(100); // 50 + 50 concatenated
    // Verify both payloads are present
    expect(written[0].data.slice(0, 50).every((b) => b === 0x42)).toBe(true);
    expect(written[0].data.slice(50).every((b) => b === 0x43)).toBe(true);
  });

  it('size-based flush (4KB+) cancels the pending timer', async () => {
    const { handleData, written, getFlushTimer } = createFlushHarness(42);

    // Send sub-4KB first — starts a timer
    const small = Buffer.alloc(100, 0x44);
    await handleData(small);
    expect(getFlushTimer()).not.toBeNull();

    // Send enough to cross 4KB boundary (100 + 4000 = 4100 > 4096)
    const large = Buffer.alloc(4000, 0x45);
    await handleData(large);

    // 4096 bytes were flushed immediately as one chunk
    expect(written).toHaveLength(1);
    expect(written[0].data.length).toBe(CHUNK_SIZE);
    expect(written[0].sequence).toBe(1);

    // Remaining 4 bytes (4100 - 4096) — a new timer is set for those
    // But the OLD timer was cancelled and replaced
    // Let the new timer fire
    jest.advanceTimersByTime(500);
    await jest.runAllTimersAsync();

    expect(written).toHaveLength(2);
    expect(written[1].data.length).toBe(4); // leftover tail
    expect(written[1].sequence).toBe(2);
  });

  it('size-based flush that consumes all data cancels timer entirely', async () => {
    const { handleData, written, getFlushTimer } = createFlushHarness(42);

    // Send sub-4KB — starts timer
    const small = Buffer.alloc(100, 0x44);
    await handleData(small);
    expect(getFlushTimer()).not.toBeNull();

    // Send exactly enough to make total = 4096 (100 + 3996)
    const exact = Buffer.alloc(3996, 0x45);
    await handleData(exact);

    // Immediate flush of exactly 4096 bytes, zero remainder
    expect(written).toHaveLength(1);
    expect(written[0].data.length).toBe(CHUNK_SIZE);

    // Timer must be cancelled — no pending data
    expect(getFlushTimer()).toBeNull();

    // Advancing time should produce no additional flushes
    jest.advanceTimersByTime(1000);
    await jest.runAllTimersAsync();
    expect(written).toHaveLength(1);
  });

  it('process close flushes remaining buffer without waiting for timer', async () => {
    const { handleData, flushPending, written, getFlushTimer } = createFlushHarness(42);
    const payload = Buffer.alloc(200, 0x46);

    await handleData(payload);
    expect(written).toHaveLength(0);
    expect(getFlushTimer()).not.toBeNull();

    // Simulate process 'close' — calls flushPending() immediately
    await flushPending();

    expect(written).toHaveLength(1);
    expect(written[0].data.length).toBe(200);
    // Timer should be cleared by flushPending
    expect(getFlushTimer()).toBeNull();
  });

  it('does not write to DB when timer fires on empty buffer', async () => {
    const { handleData, written } = createFlushHarness(42);
    const payload = Buffer.alloc(100, 0x47);

    await handleData(payload);

    // Manually flush (simulating close) which empties the buffer
    jest.advanceTimersByTime(500);
    await jest.runAllTimersAsync();
    expect(written).toHaveLength(1);

    // Send no new data, advance timers again — should produce no writes
    jest.advanceTimersByTime(1000);
    await jest.runAllTimersAsync();
    expect(written).toHaveLength(1);
  });

  it('does not flush when flushPending is called on already-empty buffer', async () => {
    const { flushPending, written } = createFlushHarness(42);

    // Call flush with nothing pending
    await flushPending();

    expect(written).toHaveLength(0);
  });

  it('handles rapid sequential writes crossing 4KB boundary mid-timer', async () => {
    const { handleData, written } = createFlushHarness(42);

    // Simulate rapid sequential writes: 10 x 500 bytes = 5000 bytes total
    for (let i = 0; i < 10; i++) {
      await handleData(Buffer.alloc(500, 0x48 + i));
    }

    // After 10 writes of 500 bytes each (5000 total):
    // - 1 full 4KB chunk flushed immediately (bytes 0-4095)
    // - 904 bytes remain in pending buffer (5000 - 4096)
    expect(written).toHaveLength(1);
    expect(written[0].data.length).toBe(CHUNK_SIZE);
    expect(written[0].sequence).toBe(1);

    // Let the debounce timer flush the remainder
    jest.advanceTimersByTime(500);
    await jest.runAllTimersAsync();

    expect(written).toHaveLength(2);
    expect(written[1].data.length).toBe(5000 - CHUNK_SIZE); // 904 bytes
    expect(written[1].sequence).toBe(2);
  });

  it('handles multiple 4KB boundaries in a single large write', async () => {
    const { handleData, written } = createFlushHarness(42);

    // Send 10000 bytes in one go — should produce 2 immediate 4KB chunks + 1808 byte tail
    await handleData(Buffer.alloc(10000, 0x50));

    expect(written).toHaveLength(2);
    expect(written[0].data.length).toBe(CHUNK_SIZE);
    expect(written[0].sequence).toBe(1);
    expect(written[1].data.length).toBe(CHUNK_SIZE);
    expect(written[1].sequence).toBe(2);

    // 10000 - 8192 = 1808 bytes pending — flushed after timer
    jest.advanceTimersByTime(500);
    await jest.runAllTimersAsync();

    expect(written).toHaveLength(3);
    expect(written[2].data.length).toBe(10000 - 2 * CHUNK_SIZE);
    expect(written[2].sequence).toBe(3);
  });
});
