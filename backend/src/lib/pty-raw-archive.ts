/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { gunzipSync, gzipSync } from 'zlib';
import { execute, query, queryOne, transaction } from '../db/index';
import { hashContent, hashFileContent } from './context-safety';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RawArchiveIntegrityError,
  RawArchiveWriteError,
} from './errors';
import { logger } from './logger';
import { recordPtyByteTelemetry } from './pty-operational-telemetry';
import type { PtyGenerationRef } from './run-pty-store';

export const PTY_RAW_ARCHIVE_CONTRACT_VERSION = 1 as const;
export const PTY_RAW_ARCHIVE_ROOT = path.join('.rorca', 'pty-archives');
const DEFAULT_SEGMENT_MAX_RAW_BYTES = 8 * 1024 * 1024;
const DEFAULT_RAW_ARCHIVE_RETENTION_DAYS = 30;
const MIN_SEGMENT_BYTES = 4 * 1024;
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

export type RawArchiveCompletionState = 'writing' | 'complete' | 'failed' | 'interrupted' | 'corrupt' | 'pruned';
export type RawArchiveSegmentState = 'complete' | 'missing' | 'corrupt' | 'pruned';

interface ArchiveManifestRow {
  id: string;
  generation_id: string;
  run_id: number | string;
  workspace_id: string;
  story_id: string;
  archive_root_relative: string;
  segment_max_raw_bytes: number;
  next_raw_offset: number | string;
  completion_state: RawArchiveCompletionState;
  retention_days: number;
  retention_expires_at: string;
  gaps: unknown;
  started_at: string;
  completed_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  workspace_path?: string;
  generation_active?: boolean;
  generation_status?: string;
}

interface ArchiveSegmentRow {
  id: string;
  manifest_id: string;
  generation_id: string;
  segment_index: number;
  relative_path: string;
  raw_start: number | string;
  raw_end: number | string;
  raw_size: number | string;
  compressed_size: number | string;
  sha256: string;
  completion_state: RawArchiveSegmentState;
  first_byte_at: string;
  completed_at: string | null;
  verified_at: string | null;
}

export interface RawArchiveSegment {
  segmentIndex: number;
  relativePath: string;
  rawStart: number;
  rawEnd: number;
  rawSize: number;
  compressedSize: number;
  sha256: string;
  completionState: RawArchiveSegmentState;
  firstByteAt: string;
  completedAt: string | null;
  verifiedAt: string | null;
}

export interface RawArchiveManifest {
  contractVersion: number;
  manifestId: string;
  generationId: string;
  runId: number;
  workspaceId: string;
  storyId: string;
  compression: 'gzip';
  nextRawOffset: number;
  completionState: RawArchiveCompletionState;
  restrictedEvidence: true;
  retentionDays: number;
  retentionExpiresAt: string;
  gaps: unknown[];
  startedAt: string;
  completedAt: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  segments: RawArchiveSegment[];
}

export interface VerifiedRawArchive extends RawArchiveManifest {
  workspacePath: string;
  archiveRootRelative: string;
  archiveRoot: string;
  verifiedPaths: string[];
}

interface PendingSegment {
  segmentIndex: number;
  relativePath: string;
  absolutePath: string;
  rawStart: number;
  rawEnd: number;
  firstByteAt: string;
}

function boundedIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function getRawArchiveSegmentMaxBytes(): number {
  return boundedIntegerEnv(
    'RORCA_PTY_ARCHIVE_SEGMENT_BYTES',
    DEFAULT_SEGMENT_MAX_RAW_BYTES,
    MIN_SEGMENT_BYTES,
    MAX_SEGMENT_BYTES,
  );
}

export function getRawArchiveRetentionDays(): number {
  return boundedIntegerEnv(
    'RORCA_PTY_ARCHIVE_RETENTION_DAYS',
    DEFAULT_RAW_ARCHIVE_RETENTION_DAYS,
    1,
    3650,
  );
}

/**
 * Resolve a database segment path below the workspace archive root. Logical and
 * real-path checks prevent traversal and symlink escape; callers never receive
 * arbitrary filesystem paths from request parameters.
 */
export function resolveRawArchiveSegmentPath(
  workspacePath: string,
  archiveRootRelative: string,
  segmentRelativePath: string,
  requireExisting = true,
): string {
  const workspaceRoot = path.resolve(workspacePath);
  const archiveRoot = path.resolve(workspaceRoot, archiveRootRelative);
  const workspaceRelative = path.relative(workspaceRoot, archiveRoot);
  if (workspaceRelative.startsWith('..') || path.isAbsolute(workspaceRelative)) {
    throw new ForbiddenError('Raw archive root escapes its workspace');
  }

  const candidate = path.resolve(archiveRoot, segmentRelativePath);
  const archiveRelative = path.relative(archiveRoot, candidate);
  if (!archiveRelative || archiveRelative.startsWith('..') || path.isAbsolute(archiveRelative)) {
    throw new ForbiddenError('Raw archive segment path escapes its archive root');
  }

  if (requireExisting) {
    let realRoot: string;
    let realCandidate: string;
    try {
      realRoot = fs.realpathSync(archiveRoot);
      realCandidate = fs.realpathSync(candidate);
    } catch (error) {
      throw new RawArchiveIntegrityError('Raw archive segment is missing', {
        segment: segmentRelativePath,
        cause: error instanceof Error && 'code' in error ? String((error as NodeJS.ErrnoException).code) : 'unavailable',
      });
    }
    const realRelative = path.relative(realRoot, realCandidate);
    if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new ForbiddenError('Raw archive segment resolves outside its archive root');
    }
    return realCandidate;
  }

  return candidate;
}

function mapSegment(row: ArchiveSegmentRow): RawArchiveSegment {
  return {
    segmentIndex: Number(row.segment_index),
    relativePath: row.relative_path,
    rawStart: Number(row.raw_start),
    rawEnd: Number(row.raw_end),
    rawSize: Number(row.raw_size),
    compressedSize: Number(row.compressed_size),
    sha256: row.sha256,
    completionState: row.completion_state,
    firstByteAt: row.first_byte_at,
    completedAt: row.completed_at,
    verifiedAt: row.verified_at,
  };
}

function mapManifest(row: ArchiveManifestRow, segments: ArchiveSegmentRow[]): RawArchiveManifest {
  return {
    contractVersion: PTY_RAW_ARCHIVE_CONTRACT_VERSION,
    manifestId: row.id,
    generationId: row.generation_id,
    runId: Number(row.run_id),
    workspaceId: row.workspace_id,
    storyId: row.story_id,
    compression: 'gzip',
    nextRawOffset: Number(row.next_raw_offset),
    completionState: row.completion_state,
    restrictedEvidence: true,
    retentionDays: Number(row.retention_days),
    retentionExpiresAt: row.retention_expires_at,
    gaps: Array.isArray(row.gaps) ? row.gaps : [],
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    segments: segments.map(mapSegment),
  };
}

async function getManifestRow(runId: number, generationId: string): Promise<ArchiveManifestRow | undefined> {
  return queryOne<ArchiveManifestRow>(
    `SELECT m.*, w.path AS workspace_path, g.is_active AS generation_active,
            g.status AS generation_status
     FROM pty_raw_archive_manifests m
     JOIN pty_generations g ON g.id = m.generation_id AND g.run_id = m.run_id
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.run_id = $1 AND m.generation_id = $2`,
    [runId, generationId],
  );
}

async function listSegmentRows(manifestId: string): Promise<ArchiveSegmentRow[]> {
  return query<ArchiveSegmentRow>(
    `SELECT * FROM pty_raw_archive_segments
     WHERE manifest_id = $1 ORDER BY segment_index ASC`,
    [manifestId],
  );
}

async function persistCompleteSegment(manifest: ArchiveManifestRow, segment: PendingSegment): Promise<void> {
  const compressed = fs.readFileSync(segment.absolutePath);
  const compressedSize = compressed.length;
  const digest = hashContent(compressed);
  const rawSize = segment.rawEnd - segment.rawStart;
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO pty_raw_archive_segments
        (manifest_id, generation_id, segment_index, relative_path, raw_start, raw_end,
         raw_size, compressed_size, sha256, completion_state, first_byte_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'complete', $10, NOW())
       ON CONFLICT (manifest_id, segment_index) DO UPDATE SET
         relative_path = EXCLUDED.relative_path, raw_start = EXCLUDED.raw_start,
         raw_end = EXCLUDED.raw_end, raw_size = EXCLUDED.raw_size,
         compressed_size = EXCLUDED.compressed_size, sha256 = EXCLUDED.sha256,
         completion_state = 'complete', first_byte_at = EXCLUDED.first_byte_at,
         completed_at = NOW(), verified_at = NULL, pruned_at = NULL`,
      [manifest.id, manifest.generation_id, segment.segmentIndex, segment.relativePath,
        segment.rawStart, segment.rawEnd, rawSize, compressedSize, digest, segment.firstByteAt],
    );
    await client.query(
      `UPDATE pty_raw_archive_manifests
       SET next_raw_offset = GREATEST(next_raw_offset, $2), updated_at = NOW()
       WHERE id = $1`,
      [manifest.id, segment.rawEnd],
    );
  });
  recordPtyByteTelemetry(
    { generationId: manifest.generation_id, runId: Number(manifest.run_id), storyId: manifest.story_id },
    'archived',
    'archive',
    rawSize,
  );
}

/** Exact synchronous file writes plus serialized asynchronous manifest commits. */
export class RawPtyArchiveWriter {
  private current: PendingSegment | null = null;
  private nextSegmentIndex: number;
  private rawOffset: number;
  private pendingPersistence: Promise<void> = Promise.resolve();
  private failure: RawArchiveWriteError | null = null;
  private closed = false;

  constructor(
    private readonly manifest: ArchiveManifestRow,
    nextSegmentIndex: number,
    rawOffset: number,
  ) {
    this.nextSegmentIndex = nextSegmentIndex;
    this.rawOffset = rawOffset;
  }

  append(bytes: Buffer): void {
    if (bytes.length === 0) return;
    if (this.closed) throw new RawArchiveWriteError('Raw PTY archive is already closed');
    if (this.failure) throw this.failure;

    let offset = 0;
    try {
      while (offset < bytes.length) {
        if (!this.current) this.current = this.createSegment();
        const currentSize = this.current.rawEnd - this.current.rawStart;
        const take = Math.min(
          bytes.length - offset,
          Number(this.manifest.segment_max_raw_bytes) - currentSize,
        );
        const slice = bytes.subarray(offset, offset + take);
        // Each append is a complete gzip member. Concatenated members preserve
        // exact byte order and remain standards-compliant gzip streams.
        fs.appendFileSync(this.current.absolutePath, gzipSync(slice, { level: 6 }));
        this.current.rawEnd += slice.length;
        this.rawOffset += slice.length;
        offset += slice.length;
        if (this.current.rawEnd - this.current.rawStart >= Number(this.manifest.segment_max_raw_bytes)) {
          this.finalizeCurrentSegment();
        }
      }
    } catch (error) {
      this.failure = error instanceof RawArchiveWriteError
        ? error
        : new RawArchiveWriteError(undefined, {
            runId: Number(this.manifest.run_id),
            generationId: this.manifest.generation_id,
            segmentIndex: this.current?.segmentIndex,
          });
      void this.markFailed(this.failure);
      throw this.failure;
    }
  }

  async drain(): Promise<void> {
    if (this.closed) {
      if (this.failure) throw this.failure;
      return;
    }
    this.closed = true;
    if (this.current && this.current.rawEnd > this.current.rawStart) this.finalizeCurrentSegment();
    await this.pendingPersistence;
    if (this.failure) {
      await this.markFailed(this.failure);
      throw this.failure;
    }
    await execute(
      `UPDATE pty_raw_archive_manifests
       SET next_raw_offset = $2, completion_state = 'complete', completed_at = NOW(),
           failure_code = NULL, failure_message = NULL, updated_at = NOW()
       WHERE id = $1 AND completion_state <> 'pruned'`,
      [this.manifest.id, this.rawOffset],
    );
  }

  private createSegment(): PendingSegment {
    const segmentIndex = this.nextSegmentIndex++;
    const relativePath = path.posix.join(
      this.manifest.generation_id,
      `segment-${String(segmentIndex).padStart(6, '0')}.gz`,
    );
    const absolutePath = resolveRawArchiveSegmentPath(
      this.manifest.workspace_path!,
      this.manifest.archive_root_relative,
      relativePath,
      false,
    );
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
    // Exclusive creation prevents a resumed writer from overwriting evidence.
    const fd = fs.openSync(absolutePath, 'wx', 0o600);
    fs.closeSync(fd);
    return {
      segmentIndex,
      relativePath,
      absolutePath,
      rawStart: this.rawOffset,
      rawEnd: this.rawOffset,
      firstByteAt: new Date().toISOString(),
    };
  }

  private finalizeCurrentSegment(): void {
    const segment = this.current;
    if (!segment) return;
    this.current = null;
    this.pendingPersistence = this.pendingPersistence
      .then(() => persistCompleteSegment(this.manifest, segment))
      .catch(async (error) => {
        this.failure = error instanceof RawArchiveWriteError
          ? error
          : new RawArchiveWriteError('Raw PTY archive manifest persistence failed', {
              runId: Number(this.manifest.run_id),
              generationId: this.manifest.generation_id,
              segmentIndex: segment.segmentIndex,
            });
        await this.markFailed(this.failure);
      });
  }

  private async markFailed(error: RawArchiveWriteError): Promise<void> {
    try {
      await execute(
        `UPDATE pty_raw_archive_manifests
         SET completion_state = 'failed', failure_code = $2, failure_message = $3,
             updated_at = NOW() WHERE id = $1 AND completion_state <> 'pruned'`,
        [this.manifest.id, error.code ?? 'RAW_ARCHIVE_WRITE_FAILED', error.message.slice(0, 1000)],
      );
    } catch (manifestError) {
      logger.error({ error: manifestError, manifestId: this.manifest.id }, '[pty-archive] unable to persist archive failure state');
    }
  }
}

/** Create or safely resume a generation archive after reconciling prior files. */
export async function openRawPtyArchive(generation: PtyGenerationRef): Promise<RawPtyArchiveWriter> {
  const identity = await queryOne<{
    workspace_id: string;
    story_id: string;
    workspace_path: string;
    is_active: boolean;
  }>(
    `SELECT g.workspace_id, g.story_id, g.is_active, w.path AS workspace_path
     FROM pty_generations g JOIN workspaces w ON w.id = g.workspace_id
     WHERE g.id = $1 AND g.run_id = $2 AND g.generation_token = $3`,
    [generation.generationId, generation.runId, generation.generationToken],
  );
  if (!identity) throw new ConflictError('PTY generation identity is stale or mismatched');
  if (!identity.is_active) throw new ConflictError('Cannot open a raw archive writer for a closed PTY generation');

  const archiveRoot = path.resolve(identity.workspace_path, PTY_RAW_ARCHIVE_ROOT);
  const generationDir = path.resolve(archiveRoot, generation.generationId);
  fs.mkdirSync(generationDir, { recursive: true, mode: 0o700 });
  const retentionDays = getRawArchiveRetentionDays();
  const rows = await query<ArchiveManifestRow>(
    `INSERT INTO pty_raw_archive_manifests
      (generation_id, run_id, workspace_id, story_id, archive_root_relative,
       segment_max_raw_bytes, retention_days, retention_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($7 * INTERVAL '1 day'))
     ON CONFLICT (generation_id) DO UPDATE SET reconciled_at = NOW(), updated_at = NOW()
     RETURNING *`,
    [generation.generationId, generation.runId, identity.workspace_id, identity.story_id,
      PTY_RAW_ARCHIVE_ROOT.split(path.sep).join('/'), getRawArchiveSegmentMaxBytes(), retentionDays],
  );
  let manifest = rows[0];
  if (!manifest) throw new RawArchiveWriteError('Raw PTY archive manifest could not be initialized');
  manifest = { ...manifest, workspace_path: identity.workspace_path, generation_active: true };

  await reconcileRawPtyArchive(manifest);
  const reconciled = await queryOne<Pick<ArchiveManifestRow, 'completion_state' | 'gaps'>>(
    `SELECT completion_state, gaps FROM pty_raw_archive_manifests WHERE id = $1`,
    [manifest.id],
  );
  if (reconciled?.completion_state === 'corrupt' || reconciled?.completion_state === 'failed') {
    throw new RawArchiveWriteError('A corrupt raw archive cannot be resumed', {
      generationId: generation.generationId,
      gaps: reconciled.gaps,
    });
  }
  const segments = await listSegmentRows(manifest.id);
  const rawOffset = segments.reduce((max, segment) => Math.max(max, Number(segment.raw_end)), 0);
  const nextIndex = segments.reduce((max, segment) => Math.max(max, segment.segment_index + 1), 0);
  await execute(
    `UPDATE pty_raw_archive_manifests SET completion_state = 'writing',
     next_raw_offset = $2, completed_at = NULL, failure_code = NULL,
     failure_message = NULL, updated_at = NOW() WHERE id = $1`,
    [manifest.id, rawOffset],
  );
  return new RawPtyArchiveWriter(manifest, nextIndex, rawOffset);
}

/** Rebuild segment metadata from disk and make every missing/corrupt range explicit. */
async function reconcileRawPtyArchive(manifest: ArchiveManifestRow): Promise<void> {
  const workspacePath = manifest.workspace_path;
  if (!workspacePath) throw new RawArchiveIntegrityError('Archive workspace path is unavailable');
  const archiveRoot = path.resolve(workspacePath, manifest.archive_root_relative);
  const generationDir = path.resolve(archiveRoot, manifest.generation_id);
  fs.mkdirSync(generationDir, { recursive: true, mode: 0o700 });

  const names = fs.readdirSync(generationDir)
    .filter((name) => /^segment-\d{6}\.gz$/.test(name))
    .sort();
  const existingRows = await listSegmentRows(manifest.id);
  const knownByPath = new Map(existingRows.map((row) => [row.relative_path, row]));
  const observedPaths = new Set<string>();
  const gaps: Array<Record<string, unknown>> = [];
  let rawOffset = 0;

  for (const name of names) {
    const segmentIndex = Number(name.slice('segment-'.length, -'.gz'.length));
    const relativePath = path.posix.join(manifest.generation_id, name);
    observedPaths.add(relativePath);
    const absolutePath = resolveRawArchiveSegmentPath(workspacePath, manifest.archive_root_relative, relativePath);
    const known = knownByPath.get(relativePath);
    const knownStart = known ? Number(known.raw_start) : rawOffset;
    const knownEnd = known ? Number(known.raw_end) : knownStart;
    try {
      const compressed = fs.readFileSync(absolutePath);
      const raw = gunzipSync(compressed);
      const digest = hashContent(compressed);
      if (known && (
        compressed.length !== Number(known.compressed_size)
        || digest !== known.sha256
        || raw.length !== Number(known.raw_size)
      )) {
        gaps.push({
          segmentIndex,
          relativePath,
          reason: 'segment_integrity_mismatch',
          rawStart: knownStart,
          rawEnd: knownEnd,
        });
        await execute(
          `UPDATE pty_raw_archive_segments SET completion_state = 'corrupt', verified_at = NOW()
           WHERE id = $1`,
          [known.id],
        );
        rawOffset = Math.max(rawOffset, knownEnd);
        continue;
      }

      const rawStart = knownStart;
      const rawEnd = rawStart + raw.length;
      const firstByteAt = known?.first_byte_at ?? fs.statSync(absolutePath).birthtime.toISOString();
      await execute(
        `INSERT INTO pty_raw_archive_segments
          (manifest_id, generation_id, segment_index, relative_path, raw_start, raw_end,
           raw_size, compressed_size, sha256, completion_state, first_byte_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'complete', $10, NOW())
         ON CONFLICT (manifest_id, segment_index) DO UPDATE SET
           relative_path = EXCLUDED.relative_path, raw_start = EXCLUDED.raw_start,
           raw_end = EXCLUDED.raw_end, raw_size = EXCLUDED.raw_size,
           compressed_size = EXCLUDED.compressed_size, sha256 = EXCLUDED.sha256,
           completion_state = 'complete', completed_at = COALESCE(pty_raw_archive_segments.completed_at, NOW()),
           verified_at = NULL`,
        [manifest.id, manifest.generation_id, segmentIndex, relativePath, rawStart,
          rawEnd, raw.length, compressed.length, digest, firstByteAt],
      );
      rawOffset = Math.max(rawOffset, rawEnd);
    } catch (error) {
      gaps.push({
        segmentIndex,
        relativePath,
        reason: 'corrupt_segment',
        rawStart: knownStart,
        rawEnd: known ? knownEnd : null,
      });
      await execute(
        `UPDATE pty_raw_archive_segments SET completion_state = 'corrupt', verified_at = NOW()
         WHERE manifest_id = $1 AND segment_index = $2`,
        [manifest.id, segmentIndex],
      );
      rawOffset = Math.max(rawOffset, knownEnd);
      logger.warn({ error, manifestId: manifest.id, segmentIndex }, '[pty-archive] corrupt segment found during reconciliation');
    }
  }

  for (const known of existingRows) {
    if (known.completion_state !== 'pruned' && !observedPaths.has(known.relative_path)) {
      gaps.push({
        segmentIndex: known.segment_index,
        relativePath: known.relative_path,
        reason: 'missing_segment',
        rawStart: Number(known.raw_start),
        rawEnd: Number(known.raw_end),
      });
      await execute(
        `UPDATE pty_raw_archive_segments SET completion_state = 'missing', verified_at = NOW()
         WHERE id = $1`,
        [known.id],
      );
      rawOffset = Math.max(rawOffset, Number(known.raw_end));
    }
  }

  const nextState: RawArchiveCompletionState = gaps.length > 0
    ? 'corrupt'
    : manifest.completion_state === 'complete'
      ? 'complete'
      : manifest.generation_active === false
        ? 'interrupted'
        : 'writing';
  await execute(
    `UPDATE pty_raw_archive_manifests
     SET next_raw_offset = $2, completion_state = $3, gaps = $4::jsonb,
         reconciled_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [manifest.id, rawOffset, nextState, JSON.stringify(gaps)],
  );
}

export async function reconcileInterruptedRawPtyArchives(limit = 100): Promise<number> {
  const boundedLimit = Math.min(500, Math.max(1, Math.floor(limit)));
  const manifests = await query<ArchiveManifestRow>(
    `SELECT m.*, w.path AS workspace_path, g.is_active AS generation_active,
            g.status AS generation_status
     FROM pty_raw_archive_manifests m
     JOIN pty_generations g ON g.id = m.generation_id
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.completion_state = 'writing' AND g.is_active = FALSE
     ORDER BY m.started_at ASC LIMIT $1`,
    [boundedLimit],
  );
  let reconciled = 0;
  for (const manifest of manifests) {
    try {
      await reconcileRawPtyArchive(manifest);
      reconciled += 1;
    } catch (error) {
      logger.error({ error, manifestId: manifest.id }, '[pty-archive] restart reconciliation failed');
      await execute(
        `UPDATE pty_raw_archive_manifests SET completion_state = 'failed',
         failure_code = 'ARCHIVE_RECONCILIATION_FAILED', failure_message = $2,
         updated_at = NOW() WHERE id = $1`,
        [manifest.id, 'Raw PTY archive restart reconciliation failed'],
      );
    }
  }
  return reconciled;
}

export async function getRawPtyArchiveManifest(runId: number, generationId: string): Promise<RawArchiveManifest> {
  const row = await getManifestRow(runId, generationId);
  if (!row) throw new NotFoundError('Raw PTY archive');
  const segments = await listSegmentRows(row.id);
  return mapManifest(row, segments);
}

async function markIntegrityFailure(
  manifest: ArchiveManifestRow,
  segment: ArchiveSegmentRow,
  state: 'missing' | 'corrupt',
  reason: string,
): Promise<void> {
  const gap = {
    segmentIndex: segment.segment_index,
    relativePath: segment.relative_path,
    rawStart: Number(segment.raw_start),
    rawEnd: Number(segment.raw_end),
    reason,
  };
  await transaction(async (client) => {
    await client.query(
      `UPDATE pty_raw_archive_segments SET completion_state = $2, verified_at = NOW()
       WHERE id = $1`,
      [segment.id, state],
    );
    await client.query(
      `UPDATE pty_raw_archive_manifests SET completion_state = 'corrupt',
       gaps = gaps || $2::jsonb, failure_code = 'RAW_ARCHIVE_INTEGRITY_FAILED',
       failure_message = $3, updated_at = NOW() WHERE id = $1`,
      [manifest.id, JSON.stringify([gap]), reason.slice(0, 1000)],
    );
  });
}

/** Verify all paths, contiguous ranges, sizes, and hashes before any response bytes are sent. */
export async function verifyRawPtyArchive(runId: number, generationId: string): Promise<VerifiedRawArchive> {
  const manifest = await getManifestRow(runId, generationId);
  if (!manifest || !manifest.workspace_path) throw new NotFoundError('Raw PTY archive');
  if (manifest.completion_state === 'writing') {
    throw new ConflictError('Raw PTY archive is still being written');
  }
  if (manifest.completion_state === 'pruned') {
    throw new NotFoundError('Raw PTY archive has expired');
  }
  if (manifest.completion_state === 'corrupt' || manifest.completion_state === 'failed') {
    throw new RawArchiveIntegrityError('Raw PTY archive has recorded integrity or write failures', {
      state: manifest.completion_state,
      gaps: manifest.gaps,
    });
  }
  const segments = await listSegmentRows(manifest.id);
  const verifiedPaths: string[] = [];
  let expectedRawStart = 0;

  for (const segment of segments) {
    if (segment.completion_state !== 'complete' || Number(segment.raw_start) !== expectedRawStart) {
      throw new RawArchiveIntegrityError('Raw PTY archive reports an explicit segment gap', {
        segmentIndex: segment.segment_index,
        state: segment.completion_state,
        expectedRawStart,
        actualRawStart: Number(segment.raw_start),
      });
    }
    let absolutePath: string;
    try {
      absolutePath = resolveRawArchiveSegmentPath(
        manifest.workspace_path,
        manifest.archive_root_relative,
        segment.relative_path,
      );
    } catch (error) {
      if (error instanceof ForbiddenError) throw error;
      await markIntegrityFailure(manifest, segment, 'missing', 'segment_missing');
      throw error;
    }
    let actualSize: number;
    let digest: string;
    try {
      actualSize = fs.statSync(absolutePath).size;
      digest = await hashFileContent(absolutePath);
    } catch {
      await markIntegrityFailure(manifest, segment, 'missing', 'segment_disappeared_during_verification');
      throw new RawArchiveIntegrityError('Raw PTY archive segment disappeared during verification', {
        segmentIndex: segment.segment_index,
      });
    }
    if (actualSize !== Number(segment.compressed_size) || digest !== segment.sha256) {
      await markIntegrityFailure(manifest, segment, 'corrupt', 'segment_size_or_hash_mismatch');
      throw new RawArchiveIntegrityError('Raw PTY archive segment hash mismatch', {
        segmentIndex: segment.segment_index,
      });
    }
    await execute(
      `UPDATE pty_raw_archive_segments SET verified_at = NOW() WHERE id = $1`,
      [segment.id],
    );
    verifiedPaths.push(absolutePath);
    expectedRawStart = Number(segment.raw_end);
  }

  if (expectedRawStart !== Number(manifest.next_raw_offset)) {
    throw new RawArchiveIntegrityError('Raw PTY archive terminal byte range is incomplete', {
      expectedRawStart,
      manifestRawEnd: Number(manifest.next_raw_offset),
    });
  }
  const refreshedSegments = await listSegmentRows(manifest.id);
  return {
    ...mapManifest(manifest, refreshedSegments),
    workspacePath: manifest.workspace_path,
    archiveRootRelative: manifest.archive_root_relative,
    archiveRoot: path.resolve(manifest.workspace_path, manifest.archive_root_relative),
    verifiedPaths,
  };
}

export async function pruneExpiredRawPtyArchives(limit = 100): Promise<{ pruned: number; failed: number }> {
  const boundedLimit = Math.min(500, Math.max(1, Math.floor(limit)));
  const manifests = await query<ArchiveManifestRow>(
    `SELECT m.*, w.path AS workspace_path
     FROM pty_raw_archive_manifests m
     JOIN workspaces w ON w.id = m.workspace_id
     JOIN pty_generations g ON g.id = m.generation_id
     WHERE m.completed_at IS NOT NULL AND NOT m.referenced_by_manifest
       AND g.is_active = FALSE
       AND m.retention_expires_at <= NOW() AND m.completion_state <> 'pruned'
     ORDER BY m.retention_expires_at ASC LIMIT $1`,
    [boundedLimit],
  );
  let pruned = 0;
  let failed = 0;
  for (const manifest of manifests) {
    try {
      const archiveRoot = path.resolve(manifest.workspace_path!, manifest.archive_root_relative);
      const generationDir = path.resolve(archiveRoot, manifest.generation_id);
      if (!generationDir.startsWith(`${archiveRoot}${path.sep}`)) {
        throw new ForbiddenError('Archive prune path escapes archive root');
      }
      fs.rmSync(generationDir, { recursive: true, force: true });
      await transaction(async (client) => {
        await client.query(
          `UPDATE pty_raw_archive_segments SET completion_state = 'pruned', pruned_at = NOW()
           WHERE manifest_id = $1`,
          [manifest.id],
        );
        await client.query(
          `UPDATE pty_raw_archive_manifests SET completion_state = 'pruned', pruned_at = NOW(),
           updated_at = NOW() WHERE id = $1`,
          [manifest.id],
        );
      });
      pruned += 1;
    } catch (error) {
      failed += 1;
      logger.error({ error, manifestId: manifest.id }, '[pty-archive] retention prune failed');
      await execute(
        `UPDATE pty_raw_archive_manifests SET completion_state = 'failed',
         failure_code = 'ARCHIVE_RETENTION_PRUNE_FAILED', failure_message = $2,
         updated_at = NOW() WHERE id = $1`,
        [manifest.id, 'Raw PTY archive retention prune failed'],
      );
    }
  }
  return { pruned, failed };
}
