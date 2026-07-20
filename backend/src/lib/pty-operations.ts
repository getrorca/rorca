/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import { execute, query, queryOne } from '../db/index';
import { safePtyTelemetryLabels } from './context-safety';
import { UnprocessableError } from './errors';
import { getPtyFeatureControls } from './pty-feature-flags';
import { getLastPtyReplayLatencyMs, publishPtyOperationsHealthEvent } from './pty-operational-telemetry';
import { resolveRawArchiveSegmentPath } from './pty-raw-archive';

export const PTY_RECOVERY_SCHEMA_VERSION = 1;

interface RecoverySchemaRow {
  schema_version: number | string;
  minimum_reader_version: number | string;
  mutation_state: 'ready' | 'blocked';
  diagnostic: string;
  updated_at: string;
}

export interface PtyRecoverySchemaHealth {
  supported: boolean;
  schemaVersion: number | null;
  minimumReaderVersion: number | null;
  mutationState: 'ready' | 'blocked' | 'unavailable';
  diagnostic: string;
}

async function getSchemaHealth(): Promise<PtyRecoverySchemaHealth> {
  let row: RecoverySchemaRow | undefined;
  try {
    row = await queryOne<RecoverySchemaRow>(
      `SELECT schema_version, minimum_reader_version, mutation_state, diagnostic, updated_at
       FROM pty_recovery_schema_state WHERE singleton = TRUE`,
    );
  } catch {
    return {
      supported: false,
      schemaVersion: null,
      minimumReaderVersion: null,
      mutationState: 'unavailable',
      diagnostic: 'Apply migration 20260719090000_pty_recovery_operations before PTY operations mutation.',
    };
  }
  if (!row) {
    return {
      supported: false,
      schemaVersion: null,
      minimumReaderVersion: null,
      mutationState: 'unavailable',
      diagnostic: 'PTY recovery schema state is missing; rerun database migrations.',
    };
  }
  const schemaVersion = Number(row.schema_version);
  const minimumReaderVersion = Number(row.minimum_reader_version);
  const supported = schemaVersion === PTY_RECOVERY_SCHEMA_VERSION
    && minimumReaderVersion <= PTY_RECOVERY_SCHEMA_VERSION
    && row.mutation_state === 'ready';
  return {
    supported,
    schemaVersion,
    minimumReaderVersion,
    mutationState: row.mutation_state,
    diagnostic: supported
      ? 'PTY recovery operations schema is compatible.'
      : `${row.diagnostic} Expected schema ${PTY_RECOVERY_SCHEMA_VERSION}; mutation was not attempted.`,
  };
}

export async function assertPtyRecoveryMutationSupported(): Promise<void> {
  const schema = await getSchemaHealth();
  if (!schema.supported) {
    throw new UnprocessableError(
      schema.diagnostic,
      'PTY_RECOVERY_SCHEMA_UNSUPPORTED',
      {
        expectedSchemaVersion: PTY_RECOVERY_SCHEMA_VERSION,
        actualSchemaVersion: schema.schemaVersion,
        minimumReaderVersion: schema.minimumReaderVersion,
        action: 'Apply compatible additive PTY migrations or set mutation_state=ready after repair.',
      },
    );
  }
}

interface ByteAggregateRow {
  observed_bytes: number | string;
  archived_bytes: number | string;
  transcripted_bytes: number | string;
  compacted_bytes: number | string;
  dropped_bytes: number | string;
  unrecoverable_bytes: number | string;
  retained_replay_bytes: number | string;
  checkpoint_age_ms: number | string | null;
  transcript_lag_ms: number | string | null;
  replay_storage_bytes: number | string;
  checkpoint_storage_bytes: number | string;
  transcript_storage_bytes: number | string;
  archive_storage_bytes: number | string;
  archive_complete_segments: number | string;
  archive_missing_segments: number | string;
  archive_corrupt_segments: number | string;
}

function numeric(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export async function getPtyOperationsHealth(): Promise<Record<string, unknown>> {
  const schema = await getSchemaHealth();
  const controls = getPtyFeatureControls();
  if (!schema.supported) {
    const degraded = {
      contractVersion: 1,
      status: 'degraded',
      schema,
      controls,
      byteMetrics: [],
      diagnostics: ['PTY operational aggregates unavailable until the additive migration is compatible.'],
      capturedAt: new Date().toISOString(),
    };
    publishPtyOperationsHealthEvent({ event: 'health', ...degraded });
    return degraded;
  }

  const row = await queryOne<ByteAggregateRow>(
    `SELECT
       COALESCE((SELECT SUM(total_output_bytes) FROM pty_generations), 0) AS observed_bytes,
       COALESCE((SELECT SUM(next_raw_offset) FROM pty_raw_archive_manifests
                 WHERE completion_state IN ('complete', 'interrupted')), 0) AS archived_bytes,
       COALESCE((SELECT SUM(payload_bytes) FROM pty_transcript_events), 0) AS transcripted_bytes,
       COALESCE((SELECT SUM(compacted_byte_count) FROM pty_generations), 0) AS compacted_bytes,
       COALESCE((SELECT SUM(dropped_output_bytes) FROM pty_generations), 0) AS dropped_bytes,
       COALESCE((SELECT SUM(byte_count) FROM pty_capture_telemetry
                 WHERE byte_class = 'unrecoverable'), 0) AS unrecoverable_bytes,
       COALESCE((SELECT SUM(byte_length) FROM run_pty_output_chunks), 0) AS retained_replay_bytes,
       (SELECT EXTRACT(EPOCH FROM (NOW() - MAX(checkpoint_at))) * 1000
          FROM pty_generations WHERE checkpoint_at IS NOT NULL) AS checkpoint_age_ms,
       (SELECT GREATEST(0, EXTRACT(EPOCH FROM MAX(g.last_output_at - transcript.last_event_at)) * 1000)
          FROM pty_generations g
          JOIN (SELECT generation_id, MAX(created_at) AS last_event_at
                FROM pty_transcript_events GROUP BY generation_id) transcript
            ON transcript.generation_id = g.id
          WHERE g.last_output_at IS NOT NULL) AS transcript_lag_ms,
       COALESCE((SELECT SUM(stored_byte_length) FROM run_pty_output_chunks), 0) AS replay_storage_bytes,
       COALESCE((SELECT SUM(OCTET_LENGTH(compressed_blob)) FROM pty_checkpoints), 0) AS checkpoint_storage_bytes,
       COALESCE((SELECT SUM(payload_bytes) FROM pty_transcript_events), 0) AS transcript_storage_bytes,
       COALESCE((SELECT SUM(compressed_size) FROM pty_raw_archive_segments
                 WHERE completion_state = 'complete'), 0) AS archive_storage_bytes,
       COALESCE((SELECT COUNT(*) FROM pty_raw_archive_segments
                 WHERE completion_state = 'complete'), 0) AS archive_complete_segments,
       COALESCE((SELECT COUNT(*) FROM pty_raw_archive_segments
                 WHERE completion_state = 'missing'), 0) AS archive_missing_segments,
       COALESCE((SELECT COUNT(*) FROM pty_raw_archive_segments
                 WHERE completion_state = 'corrupt'), 0) AS archive_corrupt_segments`,
  );
  const aggregates = row ?? {} as ByteAggregateRow;
  const byteMetrics = [
    ['observed', 'capture', aggregates.observed_bytes],
    ['archived', 'archive', aggregates.archived_bytes],
    ['transcripted', 'transcript', aggregates.transcripted_bytes],
    ['compacted', 'checkpoint', aggregates.compacted_bytes],
    ['dropped', 'capture', aggregates.dropped_bytes],
    ['unrecoverable', 'capture', aggregates.unrecoverable_bytes],
  ].map(([byteClass, component, value]) => ({
    labels: safePtyTelemetryLabels(
      byteClass as Parameters<typeof safePtyTelemetryLabels>[0],
      component as Parameters<typeof safePtyTelemetryLabels>[1],
    ),
    bytes: numeric(value as number | string),
  }));
  const missing = numeric(aggregates.archive_missing_segments);
  const corrupt = numeric(aggregates.archive_corrupt_segments);
  const health = {
    contractVersion: 1,
    status: missing + corrupt > 0 ? 'degraded' : 'healthy',
    schema,
    controls,
    byteMetrics,
    retainedReplayBytes: numeric(aggregates.retained_replay_bytes),
    checkpointAgeMs: aggregates.checkpoint_age_ms == null ? null : numeric(aggregates.checkpoint_age_ms),
    replayLatencyMs: getLastPtyReplayLatencyMs(),
    transcriptLagMs: aggregates.transcript_lag_ms == null ? null : numeric(aggregates.transcript_lag_ms),
    archiveIntegrity: {
      completeSegments: numeric(aggregates.archive_complete_segments),
      missingSegments: missing,
      corruptSegments: corrupt,
    },
    storageBytes: {
      replay: numeric(aggregates.replay_storage_bytes),
      checkpoints: numeric(aggregates.checkpoint_storage_bytes),
      transcripts: numeric(aggregates.transcript_storage_bytes),
      rawArchives: numeric(aggregates.archive_storage_bytes),
    },
    capturedAt: new Date().toISOString(),
  };
  publishPtyOperationsHealthEvent({ event: 'health', ...health });
  return health;
}

function retentionDays(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(3650, Math.max(1, parsed)) : fallback;
}

export function getPtyRetentionPolicy() {
  return {
    replayDays: retentionDays('RORCA_PTY_REPLAY_RETENTION_DAYS', 14),
    checkpointDays: retentionDays('RORCA_PTY_CHECKPOINT_RETENTION_DAYS', 14),
    transcriptDays: retentionDays('RORCA_PTY_TRANSCRIPT_RETENTION_DAYS', 30),
    rawArchiveDays: retentionDays('RORCA_PTY_ARCHIVE_RETENTION_DAYS', 30),
  };
}

interface RawSegmentPruneRow {
  id: string;
  manifest_id: string;
  workspace_path: string;
  archive_root_relative: string;
  relative_path: string;
}

async function pruneRawSegments(retentionDaysValue: number, dryRun: boolean): Promise<number> {
  const segments = await query<RawSegmentPruneRow>(
    `SELECT segment.id, segment.manifest_id, workspace.path AS workspace_path,
            manifest.archive_root_relative, segment.relative_path
     FROM pty_raw_archive_segments segment
     JOIN pty_raw_archive_manifests manifest ON manifest.id = segment.manifest_id
     JOIN pty_generations generation ON generation.id = segment.generation_id
     JOIN workspaces workspace ON workspace.id = manifest.workspace_id
     WHERE segment.completed_at IS NOT NULL AND NOT segment.referenced_by_manifest
       AND generation.is_active = FALSE
       AND segment.completion_state = 'complete'
       AND segment.completed_at < NOW() - ($1 * INTERVAL '1 day')
     ORDER BY segment.completed_at ASC LIMIT 500`,
    [retentionDaysValue],
  );
  if (dryRun) return segments.length;
  let pruned = 0;
  for (const segment of segments) {
    const file = resolveRawArchiveSegmentPath(
      segment.workspace_path,
      segment.archive_root_relative,
      segment.relative_path,
      false,
    );
    fs.rmSync(file, { force: true });
    const result = await execute(
      `UPDATE pty_raw_archive_segments
       SET completion_state = 'pruned', pruned_at = NOW()
       WHERE id = $1 AND completed_at IS NOT NULL AND NOT referenced_by_manifest`,
      [segment.id],
    );
    pruned += result.rowCount;
    await execute(
      `UPDATE pty_raw_archive_manifests manifest
       SET completion_state = 'pruned', pruned_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND completed_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM pty_raw_archive_segments segment
           WHERE segment.manifest_id = manifest.id AND segment.completion_state = 'complete'
         )`,
      [segment.manifest_id],
    );
  }
  return pruned;
}

async function countRetentionCandidates(table: 'run_pty_output_chunks' | 'pty_checkpoints' | 'pty_transcript_events', days: number): Promise<number> {
  const row = await queryOne<{ count: number | string }>(
    `SELECT COUNT(*) AS count FROM ${table} artifact
     JOIN pty_generations generation ON generation.id = artifact.generation_id
     WHERE artifact.completed_at IS NOT NULL AND NOT artifact.referenced_by_manifest
       AND generation.is_active = FALSE
       AND artifact.completed_at < NOW() - ($1 * INTERVAL '1 day')`,
    [days],
  );
  return numeric(row?.count);
}

async function deleteRetentionCandidates(table: 'run_pty_output_chunks' | 'pty_checkpoints' | 'pty_transcript_events', days: number): Promise<number> {
  const result = await execute(
    `DELETE FROM ${table} artifact USING pty_generations generation
     WHERE artifact.generation_id = generation.id
       AND artifact.completed_at IS NOT NULL AND NOT artifact.referenced_by_manifest
       AND generation.is_active = FALSE
       AND artifact.completed_at < NOW() - ($1 * INTERVAL '1 day')`,
    [days],
  );
  return result.rowCount;
}

export async function runPtyRetention(dryRun = true): Promise<Record<string, unknown>> {
  await assertPtyRecoveryMutationSupported();
  const policy = getPtyRetentionPolicy();
  const [replayChunks, checkpoints, transcriptEvents, rawSegments] = await Promise.all([
    dryRun
      ? countRetentionCandidates('run_pty_output_chunks', policy.replayDays)
      : deleteRetentionCandidates('run_pty_output_chunks', policy.replayDays),
    dryRun
      ? countRetentionCandidates('pty_checkpoints', policy.checkpointDays)
      : deleteRetentionCandidates('pty_checkpoints', policy.checkpointDays),
    dryRun
      ? countRetentionCandidates('pty_transcript_events', policy.transcriptDays)
      : deleteRetentionCandidates('pty_transcript_events', policy.transcriptDays),
    pruneRawSegments(policy.rawArchiveDays, dryRun),
  ]);
  const result = { dryRun, policy, pruned: { replayChunks, checkpoints, transcriptEvents, rawSegments } };
  publishPtyOperationsHealthEvent({ event: 'retention', dryRun, pruned: result.pruned });
  return result;
}

export async function simulatePtyLegacyRollback(): Promise<Record<string, unknown>> {
  const schema = await getSchemaHealth();
  let counts = { generations: 0, transcriptEvents: 0, archiveManifests: 0, validRawSegments: 0 };
  let legacyReplayAvailable = false;
  let generationOnlyCaptures = false;
  if (schema.supported) {
    const row = await queryOne<{
      generations: number | string;
      transcript_events: number | string;
      archive_manifests: number | string;
      valid_raw_segments: number | string;
      legacy_replay_available: boolean;
      generation_only_captures: boolean;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM pty_generations) AS generations,
         (SELECT COUNT(*) FROM pty_transcript_events) AS transcript_events,
         (SELECT COUNT(*) FROM pty_raw_archive_manifests) AS archive_manifests,
         (SELECT COUNT(*) FROM pty_raw_archive_segments WHERE completion_state = 'complete') AS valid_raw_segments,
         (EXISTS(SELECT 1 FROM run_output_chunks)
           OR EXISTS(SELECT 1 FROM run_pty_output_chunks WHERE generation_id IS NULL)) AS legacy_replay_available,
         EXISTS(SELECT 1 FROM run_pty_output_chunks WHERE generation_id IS NOT NULL) AS generation_only_captures`,
    );
    counts = {
      generations: numeric(row?.generations),
      transcriptEvents: numeric(row?.transcript_events),
      archiveManifests: numeric(row?.archive_manifests),
      validRawSegments: numeric(row?.valid_raw_segments),
    };
    legacyReplayAvailable = Boolean(row?.legacy_replay_available);
    generationOnlyCaptures = Boolean(row?.generation_only_captures);
  }
  return {
    contractVersion: 1,
    simulation: true,
    mutationPerformed: false,
    readerAfterRollback: 'legacy',
    legacyReplayAvailable,
    expectedPresentation: generationOnlyCaptures && !legacyReplayAvailable ? 'blank-terminal' : 'legacy-terminal-replay',
    temporarilyUnavailable: ['generation selection', 'checkpoint restore', 'structured transcript presentation'],
    preserved: counts,
    schema,
    instructions: 'Set RORCA_DISABLE_PTY_GENERATION_READER=true. Do not drop tables, delete evidence, or change lifecycle authority.',
  };
}
