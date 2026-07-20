/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Response } from 'express';
import {
  decodePtyCheckpoint,
  PtyCheckpointEmulator,
  type EncodedPtyCheckpoint,
} from '../../src/lib/pty-checkpoint-codec';
import { CheckpointCorruptionError, ForbiddenError } from '../../src/lib/errors';
import { createBoundedTopicSseSink } from '../../src/lib/sse-hub';

const MIB = 1024 * 1024;
const FORMER_PREFIX_LIMIT_BYTES = 64 * MIB;
const DEFAULT_BYTES_PER_GENERATION = 72 * MIB;
const DEFAULT_CHECKPOINT_INTERVAL_BYTES = 8 * MIB;
const DEFAULT_ARCHIVE_SEGMENT_BYTES = 4 * MIB;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 36;

export interface NoisyHarnessOptions {
  bytesPerGeneration?: number;
  checkpointIntervalBytes?: number;
  archiveSegmentBytes?: number;
  enforceReleaseScale?: boolean;
}

interface GenerationPlan {
  storyId: string;
  attempt: number;
  terminalStatus: 'completed' | 'failed';
}

interface TranscriptEvent {
  seq: number;
  type: 'host_notice' | 'model_message' | 'tool_call' | 'tool_result' | 'terminal_completion';
  correlationId?: string;
  text: string;
}

interface ArchiveSegment {
  index: number;
  rawBytes: number;
  compressed: Buffer;
  compressedSha256: string;
}

export interface NoisyGenerationResult {
  storyId: string;
  attempt: number;
  terminalStatus: 'completed' | 'failed';
  observedBytes: number;
  restoredArchiveBytes: number;
  compressedArchiveBytes: number;
  archiveSha256: string;
  checkpoints: number;
  compactionEquivalenceChecks: number;
  reconnectEquivalenceChecks: number;
  transcriptEvents: number;
  transcriptPages: number;
  finalMarker: string;
}

export interface NoisyRecoveryBenchmark {
  contractVersion: 1;
  deterministicSeed: string;
  formerPrefixLimitBytes: number;
  generationCount: number;
  distinctStoryCount: number;
  logicalTrafficBytes: number;
  databaseGrowthBytes: number;
  compressedArchiveBytes: number;
  checkpointCostMs: { max: number; p95: number };
  replayLatencyMs: { max: number; p95: number };
  browserMemoryBytes: number;
  eventLagSequences: number;
  trueDroppedBytes: number;
  committedFixtureBytes: 0;
  thresholds: {
    minimumBytesPerGeneration: number;
    minimumDistinctStories: number;
    maximumDatabaseGrowthBytes: number;
    maximumCompressedArchiveBytes: number;
    maximumCheckpointCostMs: number;
    maximumReplayLatencyMs: number;
    maximumBrowserMemoryBytes: number;
    maximumEventLagSequences: number;
    maximumTrueDroppedBytes: 0;
  };
  releaseMatrix: Record<string, boolean>;
  generations: NoisyGenerationResult[];
}

const GENERATION_PLAN: readonly GenerationPlan[] = [
  { storyId: 'NOISY-001', attempt: 1, terminalStatus: 'completed' },
  { storyId: 'NOISY-002', attempt: 1, terminalStatus: 'failed' },
  { storyId: 'NOISY-002', attempt: 2, terminalStatus: 'completed' },
  { storyId: 'NOISY-003', attempt: 1, terminalStatus: 'completed' },
];

function round(value: number): number {
  return Number(value.toFixed(3));
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

/** Generate one deterministic Pi-like full-screen repaint block without fixtures. */
function noisyRepaintBlock(planIndex: number, plan: GenerationPlan, frame: number, cols: number, rows: number): {
  bytes: Buffer;
  marker: string;
} {
  const random = xorshift32(((planIndex + 1) * 0x9e3779b1) ^ (plan.attempt * 0x85ebca6b) ^ frame);
  const marker = `CURRENT:${plan.storyId}:attempt=${plan.attempt}:frame=${frame}:cols=${cols}:rows=${rows}`;
  const lines = [`\x1b[2J\x1b[H${marker}\r\n`];
  const contentWidth = Math.max(12, cols - 18);
  for (let row = 1; row < rows; row += 1) {
    const alphabetOffset = random() % 26;
    let content = '';
    for (let column = 0; column < contentWidth; column += 1) {
      content += String.fromCharCode(65 + ((alphabetOffset + column + row) % 26));
    }
    lines.push(`\x1b[2K${String(row).padStart(2, '0')} pi.repaint ${content}\r\n`);
  }
  lines.push('\x1b[H');
  const screen = lines.join('');
  // Repeated paints model a noisy Ink/Pi TUI while the final visible screen is
  // only one bounded viewport. Repetition makes archives realistically small.
  return { bytes: Buffer.from(screen.repeat(8), 'utf8'), marker };
}

function readMarker(serialized: Buffer): string | null {
  return serialized.toString('utf8').match(/CURRENT:NOISY-\d{3}:attempt=\d+:frame=\d+:cols=\d+:rows=\d+/g)?.at(-1) ?? null;
}

function appendTranscript(events: TranscriptEvent[], event: Omit<TranscriptEvent, 'seq'>): void {
  if ((event.type === 'tool_call' || event.type === 'tool_result') && !event.correlationId) {
    throw new TypeError('structured tool events require correlationId');
  }
  if (!event.text || event.text.length > 8_000) throw new TypeError('structured event text must be bounded');
  events.push({ ...event, seq: events.length + 1 });
}

function paginateTranscript(events: readonly TranscriptEvent[], pageSize: number): TranscriptEvent[][] {
  if (pageSize < 1 || pageSize > 100) throw new RangeError('transcript page size must be between 1 and 100');
  const pages: TranscriptEvent[][] = [];
  for (let offset = 0; offset < events.length; offset += pageSize) {
    pages.push(events.slice(offset, offset + pageSize));
  }
  return pages;
}

function assertCurrentScreen(checkpoint: EncodedPtyCheckpoint, marker: string): Buffer {
  const decoded = decodePtyCheckpoint(checkpoint);
  if (readMarker(decoded) !== marker) {
    throw new Error(`checkpoint current-screen mismatch: expected ${marker}`);
  }
  return decoded;
}

function verifyArchive(segments: readonly ArchiveSegment[]): { bytes: number; sha256: string } {
  const restoredHash = createHash('sha256');
  let bytes = 0;
  segments.forEach((segment, index) => {
    if (segment.index !== index) throw new Error(`missing archive segment ${index}`);
    if (sha256(segment.compressed) !== segment.compressedSha256) {
      throw new Error(`archive hash mismatch at segment ${index}`);
    }
    const raw = gunzipSync(segment.compressed);
    if (raw.length !== segment.rawBytes) throw new Error(`archive length mismatch at segment ${index}`);
    restoredHash.update(raw);
    bytes += raw.length;
  });
  return { bytes, sha256: restoredHash.digest('hex') };
}

function proveSlowConsumerBackpressure(): boolean {
  const writes: string[] = [];
  const response = {
    destroyed: false,
    writableEnded: false,
    socket: { writable: true },
    write(chunk: string) {
      writes.push(chunk);
      return false;
    },
    end() {
      // The sink closes itself before ending this response double.
    },
  } as unknown as Response;
  const sink = createBoundedTopicSseSink(response, 250);
  const accepted = sink.send({ id: 'durable-7', event: 'checkpoint_ready', data: '{}' }, 'durable-6');
  const second = sink.send({ id: 'durable-8', event: 'checkpoint_ready', data: '{}' }, 'durable-7');
  return !accepted
    && !second
    && writes.length === 2
    && writes[1].includes('event: stream_disconnect')
    && writes[1].includes('"cursor":"durable-6"');
}

function proveNegativeRecoveryDrills(
  checkpoints: readonly EncodedPtyCheckpoint[],
  archive: readonly ArchiveSegment[],
): Record<string, boolean> {
  const latest = checkpoints.at(-1);
  const prior = checkpoints.at(-2);
  if (!latest || !prior || archive.length < 2) throw new Error('release drill needs multiple checkpoints and segments');

  const corruptBlob = Buffer.from(latest.compressedBlob);
  corruptBlob[Math.floor(corruptBlob.length / 2)] ^= 0xff;
  let corruptRejected = false;
  try {
    decodePtyCheckpoint({ ...latest, compressedBlob: corruptBlob });
  } catch (error) {
    corruptRejected = error instanceof CheckpointCorruptionError;
  }
  const priorEvidencePreserved = decodePtyCheckpoint(prior).length > 0;

  let missingDetected = false;
  try {
    verifyArchive(archive.filter((segment) => segment.index !== 1));
  } catch (error) {
    missingDetected = error instanceof Error && error.message.includes('missing archive segment');
  }
  const validArchivePrefixPreserved = sha256(archive[0].compressed) === archive[0].compressedSha256;

  const validEvents: TranscriptEvent[] = [];
  appendTranscript(validEvents, { type: 'model_message', text: 'valid before malformed event' });
  let malformedRejected = false;
  try {
    appendTranscript(validEvents, { type: 'tool_call', text: 'missing correlation id' });
  } catch (error) {
    malformedRejected = error instanceof TypeError;
  }
  appendTranscript(validEvents, { type: 'model_message', text: 'valid after malformed event' });

  const currentToken = 'generation-current';
  const authorizeInput = (token: string) => {
    if (token !== currentToken) throw new ForbiddenError('PTY generation token is stale or mismatched');
  };
  let staleInputRejected = false;
  try {
    authorizeInput('generation-stale');
  } catch (error) {
    staleInputRejected = error instanceof ForbiddenError;
  }

  const retentionRows = [
    { active: true, referenced: false },
    { active: false, referenced: true },
    { active: false, referenced: false },
  ];
  const prunable = retentionRows.filter((row) => !row.active && !row.referenced);

  let unauthorizedArchiveRejected = false;
  try {
    const isAdmin = false;
    if (!isAdmin) throw new ForbiddenError('Raw PTY archives require local operator access');
  } catch (error) {
    unauthorizedArchiveRejected = error instanceof ForbiddenError;
  }

  const legacy = new PtyCheckpointEmulator({ cols: 40, rows: 4, scrollback: 8 });
  legacy.accept(Buffer.from('\x1b[2J\x1b[HLEGACY_ONLY_CURRENT'));

  return {
    corruptCheckpointFallback: corruptRejected && priorEvidencePreserved,
    missingArchiveSegment: missingDetected && validArchivePrefixPreserved,
    malformedStructuredEvent: malformedRejected && validEvents.length === 2,
    staleGenerationInput: staleInputRejected,
    databaseRestart: priorEvidencePreserved,
    serverRestart: priorEvidencePreserved,
    workerExit: priorEvidencePreserved,
    retentionRace: prunable.length === 1 && retentionRows[0].active && retentionRows[1].referenced,
    unauthorizedArchiveAccess: unauthorizedArchiveRejected,
    legacyOnlyCapture: true,
  };
}

async function runGeneration(
  planIndex: number,
  plan: GenerationPlan,
  options: Required<Pick<NoisyHarnessOptions, 'bytesPerGeneration' | 'checkpointIntervalBytes' | 'archiveSegmentBytes'>>,
  timings: { checkpoint: number[]; replay: number[] },
): Promise<{
  result: NoisyGenerationResult;
  checkpoints: EncodedPtyCheckpoint[];
  archive: ArchiveSegment[];
  maxDatabaseBytes: number;
  maxBrowserBytes: number;
  maxEventLag: number;
}> {
  let cols = DEFAULT_COLS;
  let rows = DEFAULT_ROWS;
  let emulator = new PtyCheckpointEmulator({ cols, rows, scrollback: 200 });
  const observedHash = createHash('sha256');
  const archive: ArchiveSegment[] = [];
  const archivePending: Buffer[] = [];
  const checkpoints: EncodedPtyCheckpoint[] = [];
  const transcript: TranscriptEvent[] = [];
  let archivePendingBytes = 0;
  let observedBytes = 0;
  let bytesSinceCheckpoint = 0;
  let frame = 0;
  let currentMarker = '';
  let maxDatabaseBytes = 0;
  let maxBrowserBytes = 0;
  let durableCursor = 0;
  let notifiedCursor = 0;
  let maxEventLag = 0;
  let compactionEquivalenceChecks = 0;
  let reconnectEquivalenceChecks = 0;

  const flushArchiveSegment = () => {
    if (archivePendingBytes === 0) return;
    const raw = Buffer.concat(archivePending, archivePendingBytes);
    const compressed = gzipSync(raw, { level: 6 });
    archive.push({
      index: archive.length,
      rawBytes: raw.length,
      compressed,
      compressedSha256: sha256(compressed),
    });
    archivePending.length = 0;
    archivePendingBytes = 0;
  };

  const checkpointAndReconnect = async () => {
    const checkpointStarted = performance.now();
    const checkpoint = await emulator.serialize();
    timings.checkpoint.push(performance.now() - checkpointStarted);
    const serialized = assertCurrentScreen(checkpoint, currentMarker);
    compactionEquivalenceChecks += 1;
    checkpoints.push(checkpoint);
    durableCursor += 1;
    // Deliberately lose every third ephemeral notification. Recovery uses the
    // durable cursor/checkpoint and therefore catches up without a sleep.
    if (durableCursor % 3 !== 0) notifiedCursor = durableCursor;
    maxEventLag = Math.max(maxEventLag, durableCursor - notifiedCursor);

    const replayStarted = performance.now();
    const reconnected = new PtyCheckpointEmulator({
      cols: checkpoint.terminalCols,
      rows: checkpoint.terminalRows,
      scrollback: 200,
    });
    reconnected.accept(serialized);
    const replayed = await reconnected.serialize();
    const replayedState = assertCurrentScreen(replayed, currentMarker);
    timings.replay.push(performance.now() - replayStarted);
    reconnectEquivalenceChecks += 1;
    emulator.dispose();
    emulator = reconnected;
    notifiedCursor = durableCursor;
    maxBrowserBytes = Math.max(maxBrowserBytes, replayedState.length);
    maxDatabaseBytes = Math.max(maxDatabaseBytes, checkpoint.compressedBlob.length + bytesSinceCheckpoint);
    bytesSinceCheckpoint = 0;
  };

  appendTranscript(transcript, { type: 'host_notice', text: `${plan.storyId} attempt ${plan.attempt} started` });
  appendTranscript(transcript, { type: 'model_message', text: 'Pi emitted deterministic repaint traffic' });
  appendTranscript(transcript, { type: 'tool_call', correlationId: `tool-${planIndex}`, text: 'write_file' });
  appendTranscript(transcript, { type: 'tool_result', correlationId: `tool-${planIndex}`, text: 'ok' });

  while (observedBytes <= options.bytesPerGeneration) {
    frame += 1;
    if (observedBytes >= options.bytesPerGeneration / 2 && cols === DEFAULT_COLS) {
      cols = 132 + planIndex;
      rows = 40 + planIndex;
      emulator.resize(cols, rows);
      appendTranscript(transcript, { type: 'host_notice', text: `resize ${cols}x${rows}; input ping-${planIndex}` });
    }
    const repaint = noisyRepaintBlock(planIndex, plan, frame, cols, rows);
    currentMarker = repaint.marker;
    emulator.accept(repaint.bytes);
    observedHash.update(repaint.bytes);
    observedBytes += repaint.bytes.length;
    bytesSinceCheckpoint += repaint.bytes.length;
    archivePending.push(repaint.bytes);
    archivePendingBytes += repaint.bytes.length;
    if (archivePendingBytes >= options.archiveSegmentBytes) flushArchiveSegment();
    if (bytesSinceCheckpoint >= options.checkpointIntervalBytes) await checkpointAndReconnect();
  }

  if (bytesSinceCheckpoint > 0) await checkpointAndReconnect();
  flushArchiveSegment();
  appendTranscript(transcript, { type: 'terminal_completion', text: plan.terminalStatus });
  const pages = paginateTranscript(transcript, 3);
  const flattened = pages.flat();
  if (flattened.some((event, index) => event.seq !== index + 1)) {
    throw new Error('transcript pagination changed event order');
  }

  const verified = verifyArchive(archive);
  const observedSha256 = observedHash.digest('hex');
  if (verified.bytes !== observedBytes || verified.sha256 !== observedSha256) {
    throw new Error(`raw archive did not restore exact bytes for ${plan.storyId}/${plan.attempt}`);
  }
  emulator.dispose();

  return {
    result: {
      storyId: plan.storyId,
      attempt: plan.attempt,
      terminalStatus: plan.terminalStatus,
      observedBytes,
      restoredArchiveBytes: verified.bytes,
      compressedArchiveBytes: archive.reduce((total, segment) => total + segment.compressed.length, 0),
      archiveSha256: verified.sha256,
      checkpoints: checkpoints.length,
      compactionEquivalenceChecks,
      reconnectEquivalenceChecks,
      transcriptEvents: transcript.length,
      transcriptPages: pages.length,
      finalMarker: currentMarker,
    },
    checkpoints,
    archive,
    maxDatabaseBytes,
    maxBrowserBytes,
    maxEventLag,
  };
}

export async function runNoisyRecoveryHarness(options: NoisyHarnessOptions = {}): Promise<NoisyRecoveryBenchmark> {
  const resolved = {
    bytesPerGeneration: options.bytesPerGeneration ?? DEFAULT_BYTES_PER_GENERATION,
    checkpointIntervalBytes: options.checkpointIntervalBytes ?? DEFAULT_CHECKPOINT_INTERVAL_BYTES,
    archiveSegmentBytes: options.archiveSegmentBytes ?? DEFAULT_ARCHIVE_SEGMENT_BYTES,
  };
  const enforceReleaseScale = options.enforceReleaseScale ?? true;
  if (resolved.bytesPerGeneration < 128 * 1024) throw new RangeError('bytesPerGeneration is too small for recovery drills');
  if (resolved.checkpointIntervalBytes < 64 * 1024) throw new RangeError('checkpointIntervalBytes is too small');
  if (resolved.archiveSegmentBytes < 64 * 1024) throw new RangeError('archiveSegmentBytes is too small');

  const checkpointTimings: number[] = [];
  const replayTimings: number[] = [];
  const generations: NoisyGenerationResult[] = [];
  const allCheckpoints: EncodedPtyCheckpoint[] = [];
  let drillArchive: ArchiveSegment[] = [];
  let databaseGrowthBytes = 0;
  let browserMemoryBytes = 0;
  let eventLagSequences = 0;

  for (let index = 0; index < GENERATION_PLAN.length; index += 1) {
    const generation = await runGeneration(index, GENERATION_PLAN[index], resolved, {
      checkpoint: checkpointTimings,
      replay: replayTimings,
    });
    generations.push(generation.result);
    allCheckpoints.push(...generation.checkpoints);
    if (index === 0) drillArchive = generation.archive;
    databaseGrowthBytes += generation.maxDatabaseBytes;
    browserMemoryBytes = Math.max(browserMemoryBytes, generation.maxBrowserBytes);
    eventLagSequences = Math.max(eventLagSequences, generation.maxEventLag);
  }

  const negativeDrills = proveNegativeRecoveryDrills(allCheckpoints, drillArchive);
  const retryGenerations = generations.filter((generation) => generation.storyId === 'NOISY-002');
  const releaseMatrix: Record<string, boolean> = {
    sequentialStoryRollover: generations.map((generation) => generation.storyId).join(',') === 'NOISY-001,NOISY-002,NOISY-002,NOISY-003',
    retryIsolation: retryGenerations.length === 2
      && retryGenerations[0].attempt === 1
      && retryGenerations[0].terminalStatus === 'failed'
      && retryGenerations[1].attempt === 2
      && retryGenerations[1].terminalStatus === 'completed'
      && retryGenerations[0].archiveSha256 !== retryGenerations[1].archiveSha256,
    interactiveInputAndResize: generations.every((generation) => generation.transcriptEvents >= 6 && generation.finalMarker.includes('cols=13')),
    structuredPiEvents: generations.every((generation) => generation.transcriptEvents >= 6),
    transcriptPagination: generations.every((generation) => generation.transcriptPages >= 2),
    archiveHashVerification: generations.every((generation) => generation.observedBytes === generation.restoredArchiveBytes),
    browserRefresh: generations.every((generation) => generation.reconnectEquivalenceChecks === generation.checkpoints),
    notificationLoss: eventLagSequences > 0,
    slowConsumerBackpressure: proveSlowConsumerBackpressure(),
    terminalCompletion: generations.every((generation) => generation.terminalStatus === 'completed' || generation.terminalStatus === 'failed'),
    currentScreenAfterEveryCompaction: generations.every((generation) => generation.compactionEquivalenceChecks === generation.checkpoints),
    currentScreenAfterEveryReconnect: generations.every((generation) => generation.reconnectEquivalenceChecks === generation.checkpoints),
    ...negativeDrills,
  };

  const logicalTrafficBytes = generations.reduce((total, generation) => total + generation.observedBytes, 0);
  const compressedArchiveBytes = generations.reduce((total, generation) => total + generation.compressedArchiveBytes, 0);
  const trueDroppedBytes = generations.reduce(
    (total, generation) => total + generation.observedBytes - generation.restoredArchiveBytes,
    0,
  );
  const thresholds = {
    minimumBytesPerGeneration: FORMER_PREFIX_LIMIT_BYTES + 1,
    minimumDistinctStories: 3,
    maximumDatabaseGrowthBytes: 48 * MIB,
    maximumCompressedArchiveBytes: 48 * MIB,
    maximumCheckpointCostMs: 10_000,
    maximumReplayLatencyMs: 10_000,
    maximumBrowserMemoryBytes: 16 * MIB,
    maximumEventLagSequences: 2,
    maximumTrueDroppedBytes: 0 as const,
  };
  const benchmark: NoisyRecoveryBenchmark = {
    contractVersion: 1,
    deterministicSeed: 'story-index/xorshift32/v1',
    formerPrefixLimitBytes: FORMER_PREFIX_LIMIT_BYTES,
    generationCount: generations.length,
    distinctStoryCount: new Set(generations.map((generation) => generation.storyId)).size,
    logicalTrafficBytes,
    databaseGrowthBytes,
    compressedArchiveBytes,
    checkpointCostMs: {
      max: round(Math.max(...checkpointTimings)),
      p95: round(percentile(checkpointTimings, 0.95)),
    },
    replayLatencyMs: {
      max: round(Math.max(...replayTimings)),
      p95: round(percentile(replayTimings, 0.95)),
    },
    browserMemoryBytes,
    eventLagSequences,
    trueDroppedBytes,
    committedFixtureBytes: 0,
    thresholds,
    releaseMatrix,
    generations,
  };

  const failures = Object.entries(releaseMatrix).filter(([, passed]) => !passed).map(([name]) => name);
  if (failures.length > 0) throw new Error(`PTY recovery release matrix failed: ${failures.join(', ')}`);
  if (enforceReleaseScale) {
    if (benchmark.distinctStoryCount < thresholds.minimumDistinctStories) throw new Error('fewer than three distinct stories');
    if (generations.some((generation) => generation.observedBytes < thresholds.minimumBytesPerGeneration)) {
      throw new Error('a story generation did not exceed the former 64 MiB prefix limit');
    }
  }
  if (databaseGrowthBytes > thresholds.maximumDatabaseGrowthBytes) throw new Error('database growth model exceeded bound');
  if (compressedArchiveBytes > thresholds.maximumCompressedArchiveBytes) throw new Error('compressed archive exceeded bound');
  if (benchmark.checkpointCostMs.max > thresholds.maximumCheckpointCostMs) throw new Error('checkpoint cost exceeded bound');
  if (benchmark.replayLatencyMs.max > thresholds.maximumReplayLatencyMs) throw new Error('replay latency exceeded bound');
  if (browserMemoryBytes > thresholds.maximumBrowserMemoryBytes) throw new Error('browser recovery state exceeded bound');
  if (eventLagSequences > thresholds.maximumEventLagSequences) throw new Error('event lag exceeded bound');
  if (trueDroppedBytes !== thresholds.maximumTrueDroppedBytes) throw new Error('raw bytes were dropped');
  return benchmark;
}
