/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Terminal } from '@xterm/headless';
import {
  checksumPtyCheckpoint,
  decodePtyCheckpoint,
  PtyCheckpointEmulator,
  splitCompleteAnsiPrefix,
} from '../pty-checkpoint-codec';
import { CheckpointCorruptionError, RetentionBudgetExhaustedError } from '../errors';

describe('PTY checkpoint codec', () => {
  it('holds incomplete ANSI families at byte accumulation boundaries', () => {
    expect(splitCompleteAnsiPrefix('before\x1b[31')).toEqual({ complete: 'before', pending: '\x1b[31' });
    expect(splitCompleteAnsiPrefix('\x1b[31mred')).toEqual({ complete: '\x1b[31mred', pending: '' });
    expect(splitCompleteAnsiPrefix('x\x1b]0;partial')).toEqual({ complete: 'x', pending: '\x1b]0;partial' });
    expect(splitCompleteAnsiPrefix('\x1b]0;title\x07ok')).toEqual({ complete: '\x1b]0;title\x07ok', pending: '' });
    expect(splitCompleteAnsiPrefix('x\x1bPpayload\x1b')).toEqual({ complete: 'x', pending: '\x1bPpayload\x1b' });
  });

  it('serializes split UTF-8/ANSI, resize, scrollback, and alternate-screen transitions', async () => {
    const emulator = new PtyCheckpointEmulator({ cols: 20, rows: 4, scrollback: 8 });
    const bytes = Buffer.from('one\r\ntwo🙂\r\n\x1b[31mred\x1b[0m\r\n', 'utf8');
    emulator.accept(bytes.subarray(0, 9));
    expect(emulator.isCheckpointBoundary()).toBe(false);
    emulator.accept(bytes.subarray(9, 12)); // split the emoji
    emulator.accept(bytes.subarray(12, 20)); // split CSI text
    emulator.accept(bytes.subarray(20));
    emulator.accept(Buffer.from('\x1b[38;'));
    expect(emulator.isCheckpointBoundary()).toBe(false);
    emulator.accept(Buffer.from('5;10mansi-boundary\x1b[0m'));
    expect(emulator.isCheckpointBoundary()).toBe(true);
    emulator.accept(Buffer.from('\x1b[?1049hALT SCREEN\x1b[?1049lmain screen', 'utf8'));
    emulator.resize(24, 5);

    const checkpoint = await emulator.serialize();
    const serialized = decodePtyCheckpoint(checkpoint).toString('utf8');
    expect(checkpoint.version).toBe(1);
    expect(checkpoint.terminalCols).toBe(24);
    expect(checkpoint.terminalRows).toBe(5);
    expect(checkpoint.checksum).toBe(checksumPtyCheckpoint(checkpoint.compressedBlob));
    expect(checkpoint.compressedBlob.length).toBeLessThan(16 * 1024 * 1024);
    expect(serialized).toContain('two🙂');
    // SerializeAddon may encode the visible row with cursor/edit controls rather
    // than one contiguous literal. Replay the checkpoint and assert terminal
    // semantics instead of coupling the test to one serializer encoding.
    const restored = new Terminal({ cols: checkpoint.terminalCols, rows: checkpoint.terminalRows, scrollback: 8, allowProposedApi: true });
    await new Promise<void>((resolve) => restored.write(serialized, resolve));
    const restoredText = Array.from(
      { length: restored.buffer.active.length },
      (_, index) => restored.buffer.active.getLine(index)?.translateToString(true) ?? '',
    ).join('\n');
    expect(restoredText.replace(/\s/g, '')).toContain('mainscreen');
    restored.dispose();
    emulator.dispose();
  });

  it('rejects checksum corruption before decompression/reset', async () => {
    const emulator = new PtyCheckpointEmulator({ cols: 10, rows: 3 });
    emulator.accept(Buffer.from('recoverable'));
    const checkpoint = await emulator.serialize();
    const corrupt = Buffer.from(checkpoint.compressedBlob);
    corrupt[Math.floor(corrupt.length / 2)] ^= 0xff;
    expect(() => decodePtyCheckpoint({ ...checkpoint, compressedBlob: corrupt }))
      .toThrow(CheckpointCorruptionError);
    expect(() => decodePtyCheckpoint({ ...checkpoint, version: 999 }))
      .toThrow(CheckpointCorruptionError);
    emulator.dispose();
  });

  it('fails a checkpoint explicitly when serialization exceeds its bound', async () => {
    const emulator = new PtyCheckpointEmulator({ cols: 20, rows: 4, scrollback: 20, maxCheckpointBytes: 32 });
    emulator.accept(Buffer.from('terminal state that cannot fit in thirty two bytes'));
    await expect(emulator.serialize()).rejects.toBeInstanceOf(RetentionBudgetExhaustedError);
    emulator.dispose();
  });
});
