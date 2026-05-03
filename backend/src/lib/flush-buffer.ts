/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * FlushBuffer — extracted from worker.ts (US-007).
 *
 * Accumulates data into a pending buffer. When the buffer reaches CHUNK_SIZE,
 * full chunks are flushed immediately via onFlush. Sub-CHUNK_SIZE tails are
 * flushed after FLUSH_INTERVAL_MS of inactivity (debounce). close() flushes
 * any remaining bytes and clears the timer.
 */

export interface FlushBufferOptions {
  /** Maximum bytes per flush (default 4096). */
  chunkSize?: number;
  /** Debounce interval in ms for sub-chunk tails (default 500). */
  flushInterval?: number;
  /** Callback invoked with each chunk to flush. */
  onFlush: (data: Buffer) => Promise<void>;
}

export class FlushBuffer {
  private pending = Buffer.alloc(0);
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  readonly chunkSize: number;
  readonly flushInterval: number;
  private readonly onFlush: (data: Buffer) => Promise<void>;

  constructor(opts: FlushBufferOptions) {
    this.chunkSize = opts.chunkSize ?? 4096;
    this.flushInterval = opts.flushInterval ?? 500;
    this.onFlush = opts.onFlush;
  }

  /**
   * Append data. Full chunks (>= chunkSize) are flushed immediately.
   * Any sub-chunk tail starts/resets a debounce timer.
   */
  async write(data: Buffer): Promise<void> {
    this.pending = Buffer.concat([this.pending, data]);

    // Write complete chunks immediately
    while (this.pending.length >= this.chunkSize) {
      const slice = this.pending.slice(0, this.chunkSize);
      await this.onFlush(slice);
      this.pending = this.pending.slice(this.chunkSize);
    }

    // Debounce: flush sub-chunk tail after interval of no new data
    if (this.pending.length > 0) {
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => { void this.flush(); }, this.flushInterval);
    } else if (this.flushTimer) {
      // Size-based flush consumed everything — cancel pending timer
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Flush any remaining bytes immediately and clear the timer. */
  async close(): Promise<void> {
    await this.flush();
  }

  /** Internal: flush pending buffer and clear timer. */
  private async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.pending.length === 0) return;

    // Split pending into <= chunkSize pieces
    let offset = 0;
    while (offset < this.pending.length) {
      const slice = this.pending.slice(offset, offset + this.chunkSize);
      await this.onFlush(slice);
      offset += this.chunkSize;
    }
    this.pending = Buffer.alloc(0);
  }

  /** Expose timer state for testing. */
  get hasTimer(): boolean {
    return this.flushTimer !== null;
  }

  /** Expose pending buffer length for testing. */
  get pendingLength(): number {
    return this.pending.length;
  }
}
