/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  makeRawRef,
  parseRawRef,
  createContextTraceWriter,
  ContextTraceArtifactWriter,
  getTraceArtifactPath,
  getTraceDir,
  readTraceRecords,
  lookupTraceRecord,
  pruneExpiredTraceArtifacts,
  getTraceRetentionDays,
} from '../context-trace';

/** Decompress and parse all NDJSON records from a run's artifact. */
const readArtifactRecords = readTraceRecords;

describe('context-trace', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-trace-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('makeRawRef / parseRawRef (deterministic scheme)', () => {
    it('is deterministic for a given runId + seq', () => {
      expect(makeRawRef(42, 0)).toBe('r42:0');
      expect(makeRawRef(42, 0)).toBe('r42:0');
      expect(makeRawRef(42, 7)).toBe('r42:7');
    });

    it('is monotonic and unique within a run', () => {
      const refs = Array.from({ length: 5 }, (_, seq) => makeRawRef(1, seq));
      expect(refs).toEqual(['r1:0', 'r1:1', 'r1:2', 'r1:3', 'r1:4']);
      expect(new Set(refs).size).toBe(refs.length);
    });

    it('round-trips through parseRawRef', () => {
      expect(parseRawRef('r99:3')).toEqual({ runId: 99, seq: 3 });
      expect(parseRawRef(makeRawRef(7, 12))).toEqual({ runId: 7, seq: 12 });
    });

    it('returns null for malformed refs', () => {
      expect(parseRawRef('nope')).toBeNull();
      expect(parseRawRef('r1')).toBeNull();
      expect(parseRawRef('1:2')).toBeNull();
      expect(parseRawRef('rA:B')).toBeNull();
    });

    it('rejects invalid inputs', () => {
      expect(() => makeRawRef(-1, 0)).toThrow(RangeError);
      expect(() => makeRawRef(1, -1)).toThrow(RangeError);
      expect(() => makeRawRef(1.5, 0)).toThrow(RangeError);
    });
  });

  describe('append (repeated append behavior)', () => {
    it('assigns deterministic monotonic rawRefs and persists records', () => {
      const writer = createContextTraceWriter(tmpDir, 42);

      const ref0 = writer.append('context', { a: 1 });
      const ref1 = writer.append('skill', { b: 2 });
      const ref2 = writer.append('mcp', { c: 3 });

      expect(ref0).toBe('r42:0');
      expect(ref1).toBe('r42:1');
      expect(ref2).toBe('r42:2');
      expect(writer.nextSeq).toBe(3);

      writer.flush();
      const records = readArtifactRecords(tmpDir, 42);
      expect(records).toHaveLength(3);
      expect(records[0]).toMatchObject({ rawRef: 'r42:0', seq: 0, phase: 'context', payload: { a: 1 } });
      expect(records[1]).toMatchObject({ rawRef: 'r42:1', seq: 1, phase: 'skill', payload: { b: 2 } });
      expect(records[2]).toMatchObject({ rawRef: 'r42:2', seq: 2, phase: 'mcp', payload: { c: 3 } });
    });

    it('writes the artifact to the deterministic path under .rorca/traces', () => {
      const writer = createContextTraceWriter(tmpDir, 5);
      writer.append('context', { hello: 'world' });
      expect(fs.existsSync(getTraceArtifactPath(tmpDir, 5))).toBe(true);
      expect(getTraceDir(tmpDir)).toBe(path.join(tmpDir, '.rorca', 'traces'));
    });

    it('appendEvent returns a lightweight event referencing the raw record', () => {
      const writer = createContextTraceWriter(tmpDir, 8);
      const event = writer.appendEvent('context', { big: 'payload' }, {
        status: 'ok',
        storyId: 'US-001',
        metrics: { tokens: 1234, fileCount: 3 },
        label: 'L1-L5 synthesis',
      });

      expect(event).not.toBeNull();
      expect(event).toMatchObject({
        traceId: 'trace:8:context',
        runId: 8,
        storyId: 'US-001',
        seq: 0,
        rawRef: 'r8:0',
        phase: 'context',
        status: 'ok',
        metrics: { tokens: 1234, fileCount: 3 },
        label: 'L1-L5 synthesis',
      });

      // The heavy payload lives only in the artifact, not on the event.
      expect(event as object).not.toHaveProperty('payload');
      const records = readArtifactRecords(tmpDir, 8);
      expect(records[0].payload).toEqual({ big: 'payload' });
    });

    it('keeps sequence gap-free for unserializable payloads', () => {
      const writer = createContextTraceWriter(tmpDir, 3);
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      const ref = writer.append('context', circular);
      expect(ref).toBe('r3:0');
      expect(writer.nextSeq).toBe(1);

      const records = readArtifactRecords(tmpDir, 3);
      expect(records).toHaveLength(1);
      expect(records[0].payload).toEqual({ __traceError: 'unserializable_payload' });
    });
  });

  describe('lazy recovery (readTraceRecords / lookupTraceRecord)', () => {
    it('recovers all records without schema guessing', async () => {
      const writer = createContextTraceWriter(tmpDir, 55);
      writer.append('context', { a: 1 });
      writer.append('skill', { b: 2 });
      await writer.close();

      const records = readTraceRecords(tmpDir, 55);
      expect(records.map((r) => r.rawRef)).toEqual(['r55:0', 'r55:1']);
    });

    it('looks up a single payload by rawRef', async () => {
      const writer = createContextTraceWriter(tmpDir, 56);
      writer.append('context', { a: 1 });
      writer.append('memory', { target: true });
      await writer.close();

      const found = lookupTraceRecord(tmpDir, 'r56:1');
      expect(found).not.toBeNull();
      expect(found?.payload).toEqual({ target: true });
    });

    it('returns empty / null for missing artifacts (nonfatal)', () => {
      expect(readTraceRecords(tmpDir, 999)).toEqual([]);
      expect(lookupTraceRecord(tmpDir, 'r999:0')).toBeNull();
      expect(lookupTraceRecord(tmpDir, 'malformed')).toBeNull();
    });
  });

  describe('close (idempotent)', () => {
    it('is safe to call multiple times', async () => {
      const writer = createContextTraceWriter(tmpDir, 1);
      writer.append('context', { x: 1 });

      await writer.close();
      await expect(writer.close()).resolves.toBeUndefined();
      await expect(writer.close()).resolves.toBeUndefined();

      expect(writer.isActive).toBe(false);
    });

    it('append after close is a no-op returning null', async () => {
      const writer = createContextTraceWriter(tmpDir, 2);
      writer.append('context', { x: 1 });
      await writer.close();

      const ref = writer.append('context', { y: 2 });
      expect(ref).toBeNull();
    });

    it('flushed records remain readable after close', async () => {
      const writer = createContextTraceWriter(tmpDir, 11);
      writer.append('context', { first: true });
      writer.append('memory', { second: true });
      await writer.close();

      const records = readArtifactRecords(tmpDir, 11);
      expect(records.map((r) => r.rawRef)).toEqual(['r11:0', 'r11:1']);
    });
  });

  describe('nonfatal failure handling', () => {
    it('startup failure yields an inactive writer that never throws', () => {
      // Point cwd at a path whose parent is a file, so mkdir of .rorca fails.
      const filePath = path.join(tmpDir, 'iam-a-file');
      fs.writeFileSync(filePath, 'x');
      const writer = createContextTraceWriter(filePath, 1);

      expect(writer.isActive).toBe(false);
      expect(() => writer.append('context', { a: 1 })).not.toThrow();
      expect(writer.append('context', { a: 1 })).toBeNull();
      expect(writer.appendEvent('context', { a: 1 })).toBeNull();
    });

    it('a disabled writer rejects appends without throwing', () => {
      const writer = createContextTraceWriter(tmpDir, 1);
      // Force the writer into a disabled state via its error handling path.
      (writer as unknown as { disabled: boolean }).disabled = true;

      expect(writer.isActive).toBe(false);
      expect(writer.append('context', { a: 1 })).toBeNull();
    });

    it('duplicate sequence is rejected (defensive monotonic guarantee)', () => {
      const writer = createContextTraceWriter(tmpDir, 4);
      writer.append('context', { a: 1 }); // seq 0 -> r4:0

      // Force a collision: rewind the internal seq so the next ref repeats r4:0.
      (writer as unknown as { seq: number }).seq = 0;
      const dup = writer.append('context', { a: 2 });
      expect(dup).toBeNull();
    });
  });

  describe('retention / cleanup extension point', () => {
    it('respects RORCA_TRACE_RETENTION_DAYS override', () => {
      const prev = process.env.RORCA_TRACE_RETENTION_DAYS;
      process.env.RORCA_TRACE_RETENTION_DAYS = '7';
      expect(getTraceRetentionDays()).toBe(7);
      process.env.RORCA_TRACE_RETENTION_DAYS = 'garbage';
      expect(getTraceRetentionDays()).toBe(14);
      if (prev === undefined) delete process.env.RORCA_TRACE_RETENTION_DAYS;
      else process.env.RORCA_TRACE_RETENTION_DAYS = prev;
    });

    it('prunes artifacts older than the retention window', async () => {
      const oldWriter = createContextTraceWriter(tmpDir, 100);
      oldWriter.append('context', { old: true });
      await oldWriter.close();

      const freshWriter = createContextTraceWriter(tmpDir, 200);
      freshWriter.append('context', { fresh: true });
      await freshWriter.close();

      // Backdate the "old" artifact 30 days into the past.
      const oldPath = getTraceArtifactPath(tmpDir, 100);
      const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      fs.utimesSync(oldPath, past, past);

      const removed = pruneExpiredTraceArtifacts(tmpDir, 14);
      expect(removed).toBe(1);
      expect(fs.existsSync(oldPath)).toBe(false);
      expect(fs.existsSync(getTraceArtifactPath(tmpDir, 200))).toBe(true);
    });

    it('is nonfatal when the trace dir does not exist', () => {
      expect(pruneExpiredTraceArtifacts(path.join(tmpDir, 'nope'))).toBe(0);
    });
  });

  describe('ContextTraceArtifactWriter direct construction', () => {
    it('exposes runId and artifactPath', () => {
      const writer = new ContextTraceArtifactWriter({ cwd: tmpDir, runId: 77 });
      expect(writer.runId).toBe(77);
      expect(writer.artifactPath).toBe(getTraceArtifactPath(tmpDir, 77));
    });
  });
});
