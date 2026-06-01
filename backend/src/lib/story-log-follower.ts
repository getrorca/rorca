/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * story-log-follower.ts — WAL subscriber that tails story log files during
 * execution, extracts human-readable prose from stream-json output, and writes
 * it to the story_output_chunks table.
 *
 * On story_started: starts a 200ms setInterval tail loop reading new bytes from
 * the log file referenced in the WAL payload's log_file field.
 *
 * Stream-json lines with type=assistant are parsed and
 * event.message.content[].text blocks are concatenated into prose.
 * Non-JSON lines pass through verbatim. Lines with no extractable text are
 * silently skipped.
 *
 * On story_passed/story_failed/story_skipped: performs one final drain read of
 * remaining log bytes then clears the tail interval for that (run_id, story_id).
 */

import * as fs from 'node:fs';
import { subscribe, type WalEvent } from './sse-hub';
import { execute, query, queryOne } from '../db/index';
import { logger } from './logger';

const TAIL_INTERVAL_MS = 200;

/** Tracks per-(run_id, story_id) tail state. */
interface TailState {
  logFile: string;
  offset: number;
  sequence: number;
  timer: ReturnType<typeof setInterval>;
  lineBuf: string;
}

/** Composite key for the active tails map. */
function tailKey(runId: number, storyId: string): string {
  return `${runId}:${storyId}`;
}

/**
 * Extract prose text from a single line of log output.
 *
 * - If the line is valid JSON with type=assistant and message.content[].text,
 *   concatenates all text blocks into a single string.
 * - If the line is valid JSON with type=tool_use, produces a human-readable
 *   description like "Read src/foo.ts" or "Editing backend/server.ts".
 * - If the line is valid JSON with type=result, produces a completion line.
 * - If the line is non-JSON, returns it verbatim.
 * - If the line is JSON but has no extractable text, returns null (skip).
 */
function extractProse(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const event = JSON.parse(trimmed);

    // assistant message → extract text blocks
    if (event.type === 'assistant' && event.message?.content) {
      const parts: string[] = [];
      for (const block of event.message.content as { type: string; text?: string }[]) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text);
        }
      }
      return parts.length > 0 ? parts.join('') : null;
    }

    // tool_use → human-readable tool description
    if (event.type === 'tool_use') {
      const name: string = event.name ?? '';
      const input = event.input ?? {};
      switch (name) {
        case 'Read':
        case 'WebFetch':
          return `Reading ${input.file_path ?? input.url ?? ''}`;
        case 'Write':
          return `Writing ${input.file_path ?? ''}`;
        case 'Edit':
        case 'NotebookEdit':
          return `Editing ${input.file_path ?? input.notebook_path ?? ''}`;
        case 'Bash':
          return input.description ?? `Running: ${(input.command ?? '').slice(0, 120)}`;
        case 'Glob':
          return `Searching files: ${input.pattern ?? ''}`;
        case 'Grep':
          return `Searching for: ${input.pattern ?? ''}`;
        case 'Task':
          return `Task: ${input.description ?? ''}`;
        default:
          return name ? `${name}` : null;
      }
    }

    // result → completion line
    if (event.type === 'result') {
      if (event.subtype === 'success') return 'Completed successfully';
      if (event.subtype === 'error') return `Error: ${(event.error ?? '').slice(0, 200)}`;
      return null;
    }

    // Valid JSON but not a recognized event — skip silently
    return null;
  } catch {
    // Not valid JSON — pass through verbatim
    return trimmed;
  }
}

/**
 * Write a prose chunk to story_output_chunks. Non-fatal on failure.
 */
async function writeChunk(
  runId: number,
  storyId: string,
  sequence: number,
  chunk: string,
): Promise<void> {
  try {
    await execute(
      `INSERT INTO story_output_chunks (run_id, story_id, chunk, sequence)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (run_id, story_id, sequence) DO NOTHING`,
      [runId, storyId, chunk, sequence],
    );
  } catch (err) {
    logger.warn({ err, runId, storyId, sequence }, '[story-log-follower] Failed to write chunk');
  }
}

export class StoryLogFollower {
  private activeTails = new Map<string, TailState>();
  private unsubscribe: (() => void) | null = null;

  /**
   * Start subscribing to WAL events. Call once at startup.
   */
  start(): void {
    if (this.unsubscribe) return; // already started
    this.unsubscribe = subscribe((event) => {
      this.handleEvent(event).catch((err) => {
        logger.warn({ err }, '[story-log-follower] Error handling WAL event');
      });
    });
  }

  /**
   * Stop all active tail loops and unsubscribe from WAL events.
   */
  stop(): void {
    // Clear all active tail intervals
    for (const [key, state] of this.activeTails) {
      clearInterval(state.timer);
      this.activeTails.delete(key);
    }
    // Unsubscribe from SSE hub
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Recover in-flight stories on server startup.
   *
   * Queries WAL events for story_started events on currently running
   * pipeline_runs that have no matching completion event
   * (story_passed/story_failed/story_skipped). For each in-flight story,
   * resumes tailing from where story_output_chunks left off.
   */
  async recover(): Promise<void> {
    // Find story_started events for running runs that have no completion event
    const inFlightRows = await query<{
      run_id: number;
      story_id: string;
      payload: string;
    }>(
      `SELECT
         (ws.payload->>'run_id')::bigint AS run_id,
         COALESCE(ws.payload->>'story_id', ws.story_id) AS story_id,
         ws.payload::text AS payload
       FROM wal_events ws
       WHERE ws.event_type = 'story_started'
         AND (ws.payload->>'run_id')::bigint IN (
           SELECT id FROM pipeline_runs WHERE status = 'running'
         )
         AND NOT EXISTS (
           SELECT 1 FROM wal_events wc
           WHERE wc.event_type IN ('story_passed', 'story_failed', 'story_skipped')
             AND (wc.payload->>'run_id')::bigint = (ws.payload->>'run_id')::bigint
             AND COALESCE(wc.payload->>'story_id', wc.story_id)
               = COALESCE(ws.payload->>'story_id', ws.story_id)
         )`,
    );

    let recovered = 0;

    for (const row of inFlightRows) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(row.payload ?? '{}');
      } catch {
        continue;
      }

      const logFile = parsed.log_file as string | undefined;
      const runId = row.run_id;
      const storyId = row.story_id;

      if (!logFile || !runId || !storyId) continue;

      // Check that the log file exists on disk
      if (!fs.existsSync(logFile)) {
        logger.warn(
          { runId, storyId, logFile },
          '[story-log-follower] Log file not found on disk during recovery, skipping',
        );
        continue;
      }

      const key = tailKey(runId, storyId);
      if (this.activeTails.has(key)) continue;

      // Determine resume offset from existing chunks
      const resumeRow = await queryOne<{ max_seq: number; total_bytes: string }>(
        `SELECT
           COALESCE(MAX(sequence), 0) AS max_seq,
           COALESCE(SUM(LENGTH(chunk)), 0)::text AS total_bytes
         FROM story_output_chunks
         WHERE run_id = $1 AND story_id = $2`,
        [runId, storyId],
      );

      const maxSeq = resumeRow?.max_seq ?? 0;
      // total_bytes comes back as string from SUM — coerce to number
      const totalBytes = Number(resumeRow?.total_bytes ?? '0');

      // Resume sequence is max_seq + 1 (or 1 if no chunks exist)
      const resumeSequence = maxSeq > 0 ? maxSeq + 1 : 1;
      // Resume byte offset: best-effort estimate from stored chunk sizes.
      // Falls back to 0 if no chunks exist.
      const resumeOffset = totalBytes > 0 ? totalBytes : 0;

      const state: TailState = {
        logFile,
        offset: resumeOffset,
        sequence: resumeSequence,
        timer: null!,
        lineBuf: '',
      };

      state.timer = setInterval(() => {
        this.tailRead(runId, storyId, state).catch((err) => {
          logger.warn({ err, runId, storyId }, '[story-log-follower] Tail read error');
        });
      }, TAIL_INTERVAL_MS);

      this.activeTails.set(key, state);
      recovered++;
    }

    logger.info(`StoryLogFollower: recovered ${recovered} in-flight stories`);
  }

  private async handleEvent(event: WalEvent): Promise<void> {
    const { event_type } = event;

    if (event_type === 'story_started') {
      await this.onStoryStarted(event);
    } else if (
      event_type === 'story_passed' ||
      event_type === 'story_failed' ||
      event_type === 'story_skipped'
    ) {
      await this.onStoryFinished(event);
    }
  }

  private async onStoryStarted(event: WalEvent): Promise<void> {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(event.payload ?? '{}');
    } catch {
      return;
    }

    const logFile = payload.log_file as string | undefined;
    const runId = payload.run_id as number | undefined;
    const storyId = (payload.story_id as string) || event.story_id;

    if (!logFile || !runId || !storyId) return;

    const key = tailKey(runId, storyId);

    // If already tailing this story, skip (idempotency for rebroadcast)
    if (this.activeTails.has(key)) return;

    const state: TailState = {
      logFile,
      offset: 0,
      sequence: 1,
      timer: null!,  // assigned immediately below
      lineBuf: '',
    };

    state.timer = setInterval(() => {
      this.tailRead(runId, storyId, state).catch((err) => {
        logger.warn({ err, runId, storyId }, '[story-log-follower] Tail read error');
      });
    }, TAIL_INTERVAL_MS);

    this.activeTails.set(key, state);
  }

  private async onStoryFinished(event: WalEvent): Promise<void> {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(event.payload ?? '{}');
    } catch {
      return;
    }

    const runId = (payload.run_id ?? payload.runId) as number | undefined;
    const storyId = (payload.story_id as string) || event.story_id;

    if (!runId || !storyId) return;

    const key = tailKey(runId, storyId);
    const state = this.activeTails.get(key);
    if (!state) return;

    // Stop the interval
    clearInterval(state.timer);

    // Final drain: read remaining bytes
    await this.tailRead(runId, storyId, state);

    // Flush any remaining partial line in the buffer
    if (state.lineBuf.trim()) {
      const prose = extractProse(state.lineBuf);
      if (prose) {
        await writeChunk(runId, storyId, state.sequence, prose);
        state.sequence++;
      }
    }

    this.activeTails.delete(key);
  }

  /**
   * Read new bytes from the log file starting at the tracked offset,
   * split into lines, extract prose, and write chunks.
   */
  private async tailRead(
    runId: number,
    storyId: string,
    state: TailState,
  ): Promise<void> {
    let fd: number | undefined;
    try {
      fd = fs.openSync(state.logFile, 'r');
      const stat = fs.fstatSync(fd);

      if (stat.size <= state.offset) return; // no new data

      const bytesToRead = stat.size - state.offset;
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, state.offset);
      state.offset = stat.size;

      // Append to line buffer and split
      state.lineBuf += buf.toString('utf8');
      const lines = state.lineBuf.split('\n');
      // Last element is an incomplete line (or empty string if ends with \n)
      state.lineBuf = lines.pop() ?? '';

      for (const line of lines) {
        const prose = extractProse(line);
        if (prose) {
          await writeChunk(runId, storyId, state.sequence, prose);
          state.sequence++;
        }
      }
    } catch (err) {
      // File might not exist yet (race between WAL event and file creation)
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn({ err, runId, storyId, logFile: state.logFile }, '[story-log-follower] File read error');
      }
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }
}
