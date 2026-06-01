/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * file-watcher.ts — CIE-009: Chokidar-based context/intent file watcher.
 *
 * Watches all registered context files (routing.global from .rorca/config.json)
 * plus the entire .rorca/ directory for every registered workspace.
 * External edits are detected, debounced (300ms), and surfaced as WAL events
 * + SSE broadcasts within 2 seconds.
 *
 * Key behaviors:
 * - Echo suppression: Rorca-initiated writes are ignored (markWriting/unmarkWriting)
 * - .gitignore-aware: node_modules, .git, dist/ are never watched
 * - Survives backend restarts: startFileWatcher() re-attaches on startup
 * - Per-workspace watchers: each workspace gets its own chokidar instance
 */

import * as fs from 'fs';
import * as path from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import { query, queryOne } from '../db/index';
import { broadcastAll, type WalEvent } from './sse-hub';
import { loadRorcaConfig } from './rorca-config';
import { computeHealthReport } from './workspace-echolocation';
import { logger } from './logger';

// ─── Types ───────────────────────────────────────────────────────────────────

interface WatcherEntry {
  watcher: FSWatcher;
  workspaceId: string;
  workspacePath: string;
  watchedFiles: string[];
}

interface FileWatchStatus {
  active: boolean;
  watchers: Array<{
    workspaceId: string;
    workspacePath: string;
    watchedFiles: string[];
    ready: boolean;
  }>;
  suppressedPaths: string[];
}

// ─── State ───────────────────────────────────────────────────────────────────

const watchers = new Map<string, WatcherEntry>();

/** Paths currently being written by Rorca — suppress change events for these */
const writingPaths = new Set<string>();

/** Debounce timers per absolute file path */
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Track watcher ready state */
const watcherReady = new Map<string, boolean>();

// Default ignore patterns (always applied)
const IGNORED_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/coverage/**',
  '**/__pycache__/**',
  '**/target/**',  // Rust/Java build output
  '**/.rorca-results.jsonl',
];

// ─── Echo Suppression ────────────────────────────────────────────────────────

const SUPPRESS_TTL_MS = 2000;

/**
 * Mark a file as being written by Rorca. Call before any Rorca-initiated
 * file write to suppress the resulting chokidar event.
 */
export function markWriting(absPath: string): void {
  writingPaths.add(absPath);
  setTimeout(() => writingPaths.delete(absPath), SUPPRESS_TTL_MS);
}

/**
 * Explicitly unmark a path (e.g. after write completes).
 */
export function unmarkWriting(absPath: string): void {
  writingPaths.delete(absPath);
}

// ─── Core Logic ──────────────────────────────────────────────────────────────

function resolveWatchPaths(workspacePath: string): string[] {
  const config = loadRorcaConfig(workspacePath);
  const paths: string[] = [];

  // 1. Global routing files (CLAUDE.md, AGENTS.md, etc.)
  for (const globalFile of config.routing.global) {
    const abs = path.resolve(workspacePath, globalFile);
    paths.push(abs);
  }

  // 2. .rorca/ directory (always watched)
  const rorcaDir = path.join(workspacePath, '.rorca');
  if (fs.existsSync(rorcaDir)) {
    paths.push(rorcaDir);
  }

  // 3. Files from routing scopes
  for (const scope of config.routing.scopes) {
    for (const injectFile of scope.inject) {
      const abs = path.resolve(workspacePath, injectFile);
      paths.push(abs);
    }
  }

  // 4. Files from file registry
  for (const entry of config.context.fileRegistry) {
    const abs = path.resolve(workspacePath, entry.path);
    paths.push(abs);
  }

  // Deduplicate
  return [...new Set(paths)];
}

function computeChangeSize(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    return stat.size;
  } catch {
    return 0; // File was deleted
  }
}

function isManagedFile(filePath: string, workspacePath: string): boolean {
  const config = loadRorcaConfig(workspacePath);
  const relPath = path.relative(workspacePath, filePath);

  // Check routing.global
  if (config.routing.global.includes(relPath)) return true;

  // Check .rorca/ directory
  if (relPath.startsWith('.rorca/') || relPath === '.rorca') return true;

  // Check file registry
  for (const entry of config.context.fileRegistry) {
    if (entry.path === relPath && entry.managed === 'rorca') return true;
  }

  return false;
}

function handleFileChange(
  absPath: string,
  workspaceId: string,
  workspacePath: string,
  eventKind: 'add' | 'change' | 'unlink',
): void {
  // Echo suppression: skip if Rorca is writing this file
  if (writingPaths.has(absPath)) return;

  // Clear existing debounce timer for this path
  const existing = debounceTimers.get(absPath);
  if (existing) clearTimeout(existing);

  // Debounce 300ms
  const timer = setTimeout(async () => {
    debounceTimers.delete(absPath);

    const relPath = path.relative(workspacePath, absPath);
    const changeSize = eventKind === 'unlink' ? 0 : computeChangeSize(absPath);
    const managed = isManagedFile(absPath, workspacePath);

    // Write WAL event
    const payload = {
      path: relPath,
      absolutePath: absPath,
      managed,
      changeSize,
      eventKind,
    };

    try {
      const walEvent = await queryOne<WalEvent>(
        `INSERT INTO wal_events (event_type, workspace_id, payload)
         VALUES ('context_file_changed', $1, $2) RETURNING *`,
        [workspaceId, JSON.stringify(payload)],
      );

      // Broadcast to SSE subscribers
      if (walEvent) {
        broadcastAll(walEvent);
      }

      // CIE-012: Recalculate health score on context file change
      try {
        const health = computeHealthReport(workspacePath);
        const healthWal = await queryOne<WalEvent>(
          `INSERT INTO wal_events (event_type, workspace_id, payload)
           VALUES ('health_recalculated', $1, $2) RETURNING *`,
          [workspaceId, JSON.stringify({ score: health.score, trigger: relPath })],
        );
        if (healthWal) {
          broadcastAll(healthWal);
        }
      } catch (healthErr) {
        logger.error({ err: healthErr }, '[file-watcher] Health recalc failed');
      }
    } catch (err) {
      logger.error({ err }, '[file-watcher] Failed to emit WAL event');
    }
  }, 300);

  debounceTimers.set(absPath, timer);
}

// ─── Watcher Lifecycle ───────────────────────────────────────────────────────

function createWatcher(workspaceId: string, workspacePath: string): WatcherEntry | null {
  const watchPaths = resolveWatchPaths(workspacePath);
  if (watchPaths.length === 0) return null;

  const watcher = chokidar.watch(watchPaths, {
    persistent: true,
    ignoreInitial: true,
    ignored: IGNORED_PATTERNS,
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    },
  });

  const entry: WatcherEntry = {
    watcher,
    workspaceId,
    workspacePath,
    watchedFiles: watchPaths.map((p) => path.relative(workspacePath, p)),
  };

  watcherReady.set(workspaceId, false);

  watcher.on('ready', () => {
    watcherReady.set(workspaceId, true);
    logger.info(
      `[file-watcher] Watching ${watchPaths.length} paths for workspace "${workspaceId}"`,
    );
  });

  watcher.on('add', (filePath: string) => {
    handleFileChange(filePath, workspaceId, workspacePath, 'add');
  });

  watcher.on('change', (filePath: string) => {
    handleFileChange(filePath, workspaceId, workspacePath, 'change');
  });

  watcher.on('unlink', (filePath: string) => {
    handleFileChange(filePath, workspaceId, workspacePath, 'unlink');
  });

  watcher.on('error', (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ message }, `[file-watcher] Error for workspace "${workspaceId}"`);
  });

  return entry;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Start file watchers for all registered workspaces.
 * Called on backend startup. Safe to call multiple times (idempotent).
 */
export async function startFileWatcher(): Promise<void> {
  interface WorkspaceRow {
    id: string;
    path: string;
  }

  const workspaces = await query<WorkspaceRow>('SELECT id, path FROM workspaces');

  for (const ws of workspaces) {
    if (watchers.has(ws.id)) continue; // Already watching
    if (!fs.existsSync(ws.path)) {
      logger.warn(`[file-watcher] Workspace "${ws.id}" path does not exist: ${ws.path}`);
      continue;
    }

    const entry = createWatcher(ws.id, ws.path);
    if (entry) {
      watchers.set(ws.id, entry);
    }
  }

  logger.info(`[file-watcher] Started watchers for ${watchers.size} workspaces`);
}

/**
 * Add a file watcher for a newly registered workspace.
 */
export function addWorkspaceWatcher(workspaceId: string, workspacePath: string): void {
  if (watchers.has(workspaceId)) {
    removeWorkspaceWatcher(workspaceId);
  }

  if (!fs.existsSync(workspacePath)) return;

  const entry = createWatcher(workspaceId, workspacePath);
  if (entry) {
    watchers.set(workspaceId, entry);
  }
}

/**
 * Remove and close a watcher for a workspace.
 */
export function removeWorkspaceWatcher(workspaceId: string): void {
  const entry = watchers.get(workspaceId);
  if (!entry) return;

  entry.watcher.close();
  watchers.delete(workspaceId);
  watcherReady.delete(workspaceId);
}

/**
 * Reload watched paths for a workspace (e.g. after .rorca/config.json changes).
 */
export function reloadWorkspaceWatcher(workspaceId: string): void {
  const entry = watchers.get(workspaceId);
  if (!entry) return;

  removeWorkspaceWatcher(workspaceId);
  addWorkspaceWatcher(workspaceId, entry.workspacePath);
}

/**
 * Stop all file watchers. Called on graceful shutdown.
 */
export function stopFileWatcher(): void {
  for (const [id, entry] of watchers) {
    entry.watcher.close();
    watcherReady.delete(id);
  }
  watchers.clear();

  // Clear any pending debounce timers
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();

  logger.info('[file-watcher] All watchers stopped');
}

/**
 * Get current file watcher status (for health endpoint).
 */
export function getFileWatchStatus(): FileWatchStatus {
  const watcherList = Array.from(watchers.entries()).map(([id, entry]) => ({
    workspaceId: id,
    workspacePath: entry.workspacePath,
    watchedFiles: entry.watchedFiles,
    ready: watcherReady.get(id) ?? false,
  }));

  return {
    active: watchers.size > 0,
    watchers: watcherList,
    suppressedPaths: Array.from(writingPaths),
  };
}
