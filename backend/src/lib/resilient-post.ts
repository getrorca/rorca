/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * resilient-post.ts — Retry wrapper + fallback file writer for backend POST calls.
 *
 * When execution-engine.ts or run-loop.ts POST story results / WAL events to the
 * backend, network hiccups or backend restarts can silently drop results.
 *
 * This module provides:
 *   retryPost()          — 3 attempts, 1s backoff between retries
 *   writeFallbackResult() — writes to <worktree>/.rorca-results.jsonl on total failure
 *
 * pipeline.ts polls for .rorca-results.jsonl files and syncs them to DB on exit.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

// ─── Constants ───────────────────────────────────────────────────────────────

const POST_MAX_RETRIES = 3;
const POST_RETRY_DELAY_MS = 1_000;
const POST_TIMEOUT_MS = 10_000;
const FALLBACK_FILENAME = '.rorca-results.jsonl';

// ─── Retry POST ──────────────────────────────────────────────────────────────

/**
 * POST to a URL with retry. Returns true if any attempt succeeded, false if all failed.
 */
export async function retryPost(
  url: string,
  body: Record<string, unknown>,
  label: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= POST_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (resp.ok) return true;
      // Non-2xx but server responded — log and retry
      logger.error(`[resilient-post] ${label} attempt ${attempt}/${POST_MAX_RETRIES}: HTTP ${resp.status}`);
    } catch (err: any) {
      const message = err?.name === 'AbortError'
        ? `timed out after ${POST_TIMEOUT_MS}ms`
        : (err.message ?? err);
      logger.error(`[resilient-post] ${label} attempt ${attempt}/${POST_MAX_RETRIES}: ${message}`);
    } finally {
      clearTimeout(timeoutId);
    }
    if (attempt < POST_MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, POST_RETRY_DELAY_MS));
    }
  }
  return false;
}

// ─── Fallback Result Entry ───────────────────────────────────────────────────

export interface FallbackResultEntry {
  /** 'wal' for WAL events, 'story_result' for story-result POST */
  type: 'wal' | 'story_result';
  storyId: string | null;
  status: string | null;
  runId: number;
  retries: number;
  ts: string;
  /** Original POST body — replayed verbatim when syncing */
  payload: Record<string, unknown>;
}

// ─── Fallback File Writer ────────────────────────────────────────────────────

/**
 * Append a fallback result entry as a JSONL line to `<cwd>/.rorca-results.jsonl`.
 * Called when all POST retries are exhausted.
 */
export function writeFallbackResult(cwd: string, entry: FallbackResultEntry): void {
  const filePath = path.join(cwd, FALLBACK_FILENAME);
  try {
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
    logger.info(`[resilient-post] Wrote fallback result: ${entry.type} ${entry.storyId ?? 'n/a'} → ${filePath}`);
  } catch (err: any) {
    logger.error(`[resilient-post] Failed to write fallback file ${filePath}: ${err.message ?? err}`);
  }
}

// ─── Fallback File Reader (used by pipeline.ts poller) ───────────────────────

/**
 * Read all entries from a `.rorca-results.jsonl` file.
 * Returns parsed entries. Malformed lines are skipped.
 */
export function readFallbackResults(cwd: string): FallbackResultEntry[] {
  const filePath = path.join(cwd, FALLBACK_FILENAME);
  if (!fs.existsSync(filePath)) return [];

  const entries: FallbackResultEntry[] = [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      logger.error(`[resilient-post] Skipping malformed fallback line: ${line.slice(0, 100)}`);
    }
  }
  return entries;
}

/**
 * Delete the fallback file after successful sync.
 */
export function deleteFallbackFile(cwd: string): void {
  const filePath = path.join(cwd, FALLBACK_FILENAME);
  try {
    fs.unlinkSync(filePath);
  } catch { /* file already gone or never existed */ }
}

/**
 * Get the fallback filename constant (for pipeline.ts to check existence).
 */
export function getFallbackFilename(): string {
  return FALLBACK_FILENAME;
}
