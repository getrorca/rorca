/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { CheckpointCorruptionError, RetentionBudgetExhaustedError } from './errors';

export const PTY_CHECKPOINT_VERSION = 1;
export const DEFAULT_PTY_CHECKPOINT_SCROLLBACK = 10_000;
export const DEFAULT_MAX_PTY_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const MAX_INCOMPLETE_ANSI_BYTES = 64 * 1024;

export interface EncodedPtyCheckpoint {
  version: number;
  terminalCols: number;
  terminalRows: number;
  compressedBlob: Buffer;
  checksum: string;
  uncompressedBytes: number;
}

export interface PtyCheckpointCodecOptions {
  cols: number;
  rows: number;
  scrollback?: number;
  maxCheckpointBytes?: number;
  onMalformedInput?: (details: { pendingAnsiBytes: number }) => void;
}

type EscapeState = 'normal' | 'escape' | 'csi' | 'osc' | 'string' | 'string-escape';

/**
 * Return the largest prefix ending outside an ANSI control sequence. xterm can
 * parse split sequences itself, but holding the suffix here gives checkpoint
 * boundaries a deterministic parser state and prevents serializing half an OSC,
 * DCS, CSI, or character-set transition.
 */
export function splitCompleteAnsiPrefix(value: string): { complete: string; pending: string } {
  let state: EscapeState = 'normal';
  let sequenceStart = -1;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (state === 'normal') {
      if (code === 0x1b) state = 'escape';
      else if (code === 0x9b) state = 'csi';
      else if (code === 0x9d) state = 'osc';
      else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) state = 'string';
      if (state !== 'normal') sequenceStart = index;
      continue;
    }
    if (state === 'escape') {
      if (code === 0x5b) state = 'csi';
      else if (code === 0x5d) state = 'osc';
      else if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) state = 'string';
      else if (code >= 0x20 && code <= 0x2f) state = 'escape';
      else {
        state = 'normal';
        sequenceStart = -1;
      }
      continue;
    }
    if (state === 'csi') {
      if (code >= 0x40 && code <= 0x7e) {
        state = 'normal';
        sequenceStart = -1;
      }
      continue;
    }
    if (state === 'osc') {
      if (code === 0x07 || code === 0x9c) {
        state = 'normal';
        sequenceStart = -1;
      } else if (code === 0x1b) {
        state = 'string-escape';
      }
      continue;
    }
    if (state === 'string') {
      if (code === 0x9c) {
        state = 'normal';
        sequenceStart = -1;
      } else if (code === 0x1b) state = 'string-escape';
      continue;
    }
    if (state === 'string-escape') {
      if (code === 0x5c) {
        state = 'normal';
        sequenceStart = -1;
      } else if (code !== 0x1b) {
        // OSC and other string controls may contain ESC bytes which are not ST.
        state = 'string';
      }
    }
  }
  return sequenceStart < 0
    ? { complete: value, pending: '' }
    : { complete: value.slice(0, sequenceStart), pending: value.slice(sequenceStart) };
}

function splitCompleteUtf8Prefix(value: Buffer): { complete: Buffer; pending: Buffer } {
  if (value.length === 0) return { complete: value, pending: Buffer.alloc(0) };
  let lead = value.length - 1;
  while (lead >= 0 && (value[lead] & 0xc0) === 0x80 && value.length - lead <= 4) lead -= 1;
  if (lead < 0) return { complete: value, pending: Buffer.alloc(0) };
  const first = value[lead];
  const expected = first >= 0xf0 && first <= 0xf4 ? 4
    : first >= 0xe0 && first <= 0xef ? 3
      : first >= 0xc2 && first <= 0xdf ? 2 : 1;
  const available = value.length - lead;
  if (expected > available) {
    return { complete: value.subarray(0, lead), pending: Buffer.from(value.subarray(lead)) };
  }
  return { complete: value, pending: Buffer.alloc(0) };
}

export function checksumPtyCheckpoint(blob: Buffer): string {
  return createHash('sha256').update(blob).digest('hex');
}

export function decodePtyCheckpoint(
  checkpoint: Pick<EncodedPtyCheckpoint, 'version' | 'compressedBlob' | 'checksum'>,
  maxCheckpointBytes = DEFAULT_MAX_PTY_CHECKPOINT_BYTES,
): Buffer {
  if (checkpoint.version !== PTY_CHECKPOINT_VERSION) {
    throw new CheckpointCorruptionError('Unsupported PTY checkpoint version', {
      expectedVersion: PTY_CHECKPOINT_VERSION,
      actualVersion: checkpoint.version,
    });
  }
  if (checkpoint.compressedBlob.length > maxCheckpointBytes) {
    throw new CheckpointCorruptionError('Compressed PTY checkpoint exceeds its configured bound');
  }
  const expected = Buffer.from(checkpoint.checksum, 'hex');
  const actual = Buffer.from(checksumPtyCheckpoint(checkpoint.compressedBlob), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new CheckpointCorruptionError('PTY checkpoint checksum mismatch');
  }
  try {
    return gunzipSync(checkpoint.compressedBlob, { maxOutputLength: maxCheckpointBytes });
  } catch (cause) {
    throw new CheckpointCorruptionError('PTY checkpoint decompression failed', {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/** A single-writer headless xterm emulator used only by PTY ingestion. */
export class PtyCheckpointEmulator {
  private readonly terminal: Terminal;
  private readonly serializer: SerializeAddon;
  private readonly scrollback: number;
  private readonly maxCheckpointBytes: number;
  private readonly onMalformedInput?: PtyCheckpointCodecOptions['onMalformedInput'];
  private pendingUtf8: Buffer = Buffer.alloc(0);
  private pendingAnsi = '';
  private writes = Promise.resolve();

  constructor(options: PtyCheckpointCodecOptions) {
    this.scrollback = options.scrollback ?? DEFAULT_PTY_CHECKPOINT_SCROLLBACK;
    this.maxCheckpointBytes = options.maxCheckpointBytes ?? DEFAULT_MAX_PTY_CHECKPOINT_BYTES;
    this.onMalformedInput = options.onMalformedInput;
    this.terminal = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: this.scrollback,
      allowProposedApi: true,
      convertEol: false,
    });
    this.serializer = new SerializeAddon();
    // Headless Terminal implements the same addon contract at runtime. The
    // addon's published declaration names the browser Terminal nominally.
    this.terminal.loadAddon(this.serializer as never);
  }

  accept(bytes: Buffer): void {
    if (bytes.length === 0) return;
    const utf8 = splitCompleteUtf8Prefix(this.pendingUtf8.length > 0
      ? Buffer.concat([this.pendingUtf8, bytes])
      : bytes);
    this.pendingUtf8 = utf8.pending;
    const decoded = utf8.complete.toString('utf8');
    const boundary = splitCompleteAnsiPrefix(this.pendingAnsi + decoded);
    this.pendingAnsi = boundary.pending;
    if (boundary.complete) this.enqueueWrite(boundary.complete);
    if (Buffer.byteLength(this.pendingAnsi) > MAX_INCOMPLETE_ANSI_BYTES) {
      this.onMalformedInput?.({ pendingAnsiBytes: Buffer.byteLength(this.pendingAnsi) });
      this.pendingAnsi = '';
      this.enqueueWrite('\uFFFD');
    }
  }

  isCheckpointBoundary(): boolean {
    return this.pendingUtf8.length === 0 && this.pendingAnsi.length === 0;
  }

  resize(cols: number, rows: number): void {
    this.writes = this.writes.then(() => { this.terminal.resize(cols, rows); });
  }

  serialize(): Promise<EncodedPtyCheckpoint> {
    // Queue the snapshot as a barrier. Bytes accepted after this call chain
    // behind it and therefore cannot leak into a checkpoint carrying an older
    // logical sequence number.
    let resolveSnapshot!: (checkpoint: EncodedPtyCheckpoint) => void;
    let rejectSnapshot!: (error: unknown) => void;
    const snapshot = new Promise<EncodedPtyCheckpoint>((resolve, reject) => {
      resolveSnapshot = resolve;
      rejectSnapshot = reject;
    });
    this.writes = this.writes.then(() => {
      try {
        // Never flush incomplete decoder/ANSI state into the checkpoint. Those
        // bytes remain associated with later deltas and cannot corrupt parser state.
        const serialized = this.serializer.serialize({ scrollback: this.scrollback });
        const uncompressed = Buffer.from(serialized, 'utf8');
        if (uncompressed.length > this.maxCheckpointBytes) {
          throw new RetentionBudgetExhaustedError('Serialized PTY checkpoint exceeds its configured bound', {
            bytes: uncompressed.length,
            maxBytes: this.maxCheckpointBytes,
          });
        }
        const compressedBlob = gzipSync(uncompressed, { level: 6 });
        if (compressedBlob.length > this.maxCheckpointBytes) {
          throw new RetentionBudgetExhaustedError('Compressed PTY checkpoint exceeds its configured bound', {
            bytes: compressedBlob.length,
            maxBytes: this.maxCheckpointBytes,
          });
        }
        resolveSnapshot({
          version: PTY_CHECKPOINT_VERSION,
          terminalCols: this.terminal.cols,
          terminalRows: this.terminal.rows,
          compressedBlob,
          checksum: checksumPtyCheckpoint(compressedBlob),
          uncompressedBytes: uncompressed.length,
        });
      } catch (error) {
        rejectSnapshot(error);
      }
    });
    return snapshot;
  }

  dispose(): void {
    this.serializer.dispose();
    this.terminal.dispose();
  }

  private enqueueWrite(value: string): void {
    this.writes = this.writes.then(() => new Promise<void>((resolve) => {
      this.terminal.write(value, resolve);
    }));
  }
}
