/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * run-state.ts — Typed event ledger for deterministic run resumption.
 *
 * Replaces freeform progress.txt with .rorca/run-state.json — a strictly-typed
 * JSON file enabling deterministic resume after crashes, compaction, or restarts.
 *
 * Writes are atomic (tmp file rename) to prevent partial writes.
 * Spec JSON remains the source of truth for story pass/fail; run-state.json
 * is a parallel audit trail with richer metadata.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RunStateDecision {
  storyId: string;
  timestamp: string;
  type: 'escalation' | 'reroute' | 'retry' | 'skip' | 'gate_pass' | 'gate_fail' | 'capability_reroute';
  description: string;
}

export interface StoryEntry {
  storyId: string;
  title: string;
  status: 'passed' | 'failed' | 'skipped';
  startedAt: string;
  finishedAt: string;
  agentType: string;
  model?: string;
  retries?: number;
  elapsedMs?: number;
  failReason?: string;
}

export interface RunState {
  specId: string;
  runId: number;
  startedAt: string;
  lastUpdatedAt: string;
  completedStories: StoryEntry[];
  failedStories: StoryEntry[];
  skippedStories: StoryEntry[];
  currentStory: string | null;
  decisions: RunStateDecision[];
  /** Story the run was resumed from (set when resuming from a previous run-state) */
  resumedFromStory?: string | null;
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const RUN_STATE_FILENAME = 'run-state.json';
const RORCA_DIR = '.rorca';
const MEMORY_DIR = 'memory';
const RUNS_DIR = 'runs';

function getRunStatePath(cwd: string): string {
  return path.join(cwd, RORCA_DIR, RUN_STATE_FILENAME);
}

function getArchiveDir(cwd: string): string {
  return path.join(cwd, RORCA_DIR, MEMORY_DIR, RUNS_DIR);
}

// ─── Atomic Write ────────────────────────────────────────────────────────────

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpFile = path.join(dir, `.tmp-${process.pid}-${Date.now()}.json`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpFile, filePath);
  } catch (err) {
    // Clean up tmp file on failure
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    throw err;
  }
}

// ─── Read ────────────────────────────────────────────────────────────────────

export function readRunState(cwd: string): RunState | null {
  const filePath = getRunStatePath(cwd);
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    // Validate it's a proper RunState (not the old empty scaffold)
    if (!parsed.specId || !parsed.runId) return null;

    return parsed as RunState;
  } catch {
    return null;
  }
}

// ─── Initialize ──────────────────────────────────────────────────────────────

export function initRunState(cwd: string, specId: string, runId: number): RunState {
  const existing = readRunState(cwd);

  // Check if we're resuming a previous run of the same spec
  let resumedFromStory: string | null = null;
  if (existing && existing.specId === specId) {
    // Same spec — this is a resume. Find the last completed story.
    const allFinished = [
      ...existing.completedStories,
      ...existing.failedStories,
      ...existing.skippedStories,
    ].sort((a, b) => new Date(b.finishedAt).getTime() - new Date(a.finishedAt).getTime());

    if (allFinished.length > 0) {
      resumedFromStory = allFinished[0].storyId;
    }
  }

  const now = new Date().toISOString();
  const state: RunState = {
    specId,
    runId,
    startedAt: now,
    lastUpdatedAt: now,
    completedStories: existing && existing.specId === specId ? existing.completedStories : [],
    failedStories: [],
    skippedStories: [],
    currentStory: null,
    decisions: existing && existing.specId === specId ? existing.decisions : [],
    resumedFromStory,
  };

  atomicWriteJson(getRunStatePath(cwd), state);
  if (resumedFromStory) {
    logger.info(`[run-state] Resumed from story ${resumedFromStory} (${state.completedStories.length} stories carried forward)`);
  } else {
    logger.info(`[run-state] Initialized for spec ${specId}, run ${runId}`);
  }
  return state;
}

// ─── Update Helpers ──────────────────────────────────────────────────────────

export function markStoryStarted(cwd: string, storyId: string): void {
  const state = readRunState(cwd);
  if (!state) return;

  state.currentStory = storyId;
  state.lastUpdatedAt = new Date().toISOString();
  atomicWriteJson(getRunStatePath(cwd), state);
}

export function markStoryCompleted(
  cwd: string,
  entry: StoryEntry,
): void {
  const state = readRunState(cwd);
  if (!state) return;

  state.completedStories.push(entry);
  state.currentStory = null;
  state.lastUpdatedAt = new Date().toISOString();
  atomicWriteJson(getRunStatePath(cwd), state);
}

export function markStoryFailed(
  cwd: string,
  entry: StoryEntry,
): void {
  const state = readRunState(cwd);
  if (!state) return;

  state.failedStories.push(entry);
  state.currentStory = null;
  state.lastUpdatedAt = new Date().toISOString();
  atomicWriteJson(getRunStatePath(cwd), state);
}

export function markStorySkipped(
  cwd: string,
  entry: StoryEntry,
): void {
  const state = readRunState(cwd);
  if (!state) return;

  state.skippedStories.push(entry);
  state.currentStory = null;
  state.lastUpdatedAt = new Date().toISOString();
  atomicWriteJson(getRunStatePath(cwd), state);
}

export function recordDecision(
  cwd: string,
  decision: RunStateDecision,
): void {
  const state = readRunState(cwd);
  if (!state) return;

  state.decisions.push(decision);
  state.lastUpdatedAt = new Date().toISOString();
  atomicWriteJson(getRunStatePath(cwd), state);
}

// ─── Resume Logic ────────────────────────────────────────────────────────────

export interface ResumeContext {
  /** Story IDs that already passed in a previous run of the same spec */
  passedStoryIds: Set<string>;
  /** Story that was last completed (for UI "Resumed from story N" indicator) */
  resumedFromStory: string | null;
  /** Whether this is a resumed run */
  isResume: boolean;
}

export function getResumeContext(cwd: string, specId: string): ResumeContext {
  const state = readRunState(cwd);

  if (!state || state.specId !== specId) {
    return { passedStoryIds: new Set(), resumedFromStory: null, isResume: false };
  }

  const passedIds = new Set(state.completedStories.map(s => s.storyId));
  const resumedFrom = state.resumedFromStory ?? null;

  return {
    passedStoryIds: passedIds,
    resumedFromStory: resumedFrom,
    isResume: passedIds.size > 0,
  };
}

// ─── Archive ─────────────────────────────────────────────────────────────────

export function archiveRunState(cwd: string, runId: number): string | null {
  const state = readRunState(cwd);
  if (!state) return null;

  const archiveDir = getArchiveDir(cwd);
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const archivePath = path.join(archiveDir, `${runId}.json`);
  atomicWriteJson(archivePath, state);
  logger.info(`[run-state] Archived to ${archivePath}`);

  // Reset run-state.json to empty scaffold
  const empty: RunState = {
    specId: '',
    runId: 0,
    startedAt: '',
    lastUpdatedAt: new Date().toISOString(),
    completedStories: [],
    failedStories: [],
    skippedStories: [],
    currentStory: null,
    decisions: [],
  };
  atomicWriteJson(getRunStatePath(cwd), empty);

  return archivePath;
}

// ─── Progress.txt Compatibility Writer ───────────────────────────────────────

export function writeProgressTxt(cwd: string): void {
  const state = readRunState(cwd);
  if (!state || !state.specId) return;

  const lines: string[] = [
    `# Run State Summary`,
    ``,
    `Spec: ${state.specId}`,
    `Run ID: ${state.runId}`,
    `Started: ${state.startedAt}`,
    `Last Updated: ${state.lastUpdatedAt}`,
    ``,
  ];

  if (state.completedStories.length > 0) {
    lines.push(`## Completed Stories (${state.completedStories.length})`);
    for (const s of state.completedStories) {
      lines.push(`- ${s.storyId}: ${s.title} — DONE (${s.agentType}${s.model ? ', ' + s.model : ''}${s.elapsedMs ? ', ' + Math.round(s.elapsedMs / 1000) + 's' : ''})`);
    }
    lines.push('');
  }

  if (state.failedStories.length > 0) {
    lines.push(`## Failed Stories (${state.failedStories.length})`);
    for (const s of state.failedStories) {
      lines.push(`- ${s.storyId}: ${s.title} — FAILED (${s.failReason ?? 'unknown'})`);
    }
    lines.push('');
  }

  if (state.skippedStories.length > 0) {
    lines.push(`## Skipped Stories (${state.skippedStories.length})`);
    for (const s of state.skippedStories) {
      lines.push(`- ${s.storyId}: ${s.title} — SKIPPED (${s.failReason ?? 'unknown'})`);
    }
    lines.push('');
  }

  if (state.decisions.length > 0) {
    lines.push(`## Decisions (${state.decisions.length})`);
    for (const d of state.decisions) {
      lines.push(`- [${d.timestamp}] ${d.storyId}: ${d.type} — ${d.description}`);
    }
    lines.push('');
  }

  if (state.currentStory) {
    lines.push(`## Current Story`);
    lines.push(`In progress: ${state.currentStory}`);
    lines.push('');
  }

  const progressPath = path.join(cwd, 'progress.txt');
  fs.writeFileSync(progressPath, lines.join('\n'), 'utf8');
}

// ─── Migration: progress.txt → run-state.json ───────────────────────────────

export function migrateProgressTxt(cwd: string, specId: string, runId: number): RunState | null {
  const progressPath = path.join(cwd, 'progress.txt');
  if (!fs.existsSync(progressPath)) return null;

  // Only migrate if run-state.json doesn't already have data
  const existing = readRunState(cwd);
  if (existing && existing.specId) return null;

  try {
    const content = fs.readFileSync(progressPath, 'utf8');
    const completedStories: StoryEntry[] = [];
    const decisions: RunStateDecision[] = [];

    // Parse "## Story [ID]: [Title] — DONE" blocks
    const storyDonePattern = /^## Story\s+([\w-]+):\s*(.+?)\s*—\s*DONE/gm;
    let match: RegExpExecArray | null;
    while ((match = storyDonePattern.exec(content)) !== null) {
      completedStories.push({
        storyId: match[1],
        title: match[2].trim(),
        status: 'passed',
        startedAt: '',
        finishedAt: '',
        agentType: 'claude',
      });
    }

    if (completedStories.length === 0) return null;

    const now = new Date().toISOString();
    const state: RunState = {
      specId,
      runId,
      startedAt: now,
      lastUpdatedAt: now,
      completedStories,
      failedStories: [],
      skippedStories: [],
      currentStory: null,
      decisions,
    };

    atomicWriteJson(getRunStatePath(cwd), state);
    logger.info(`[run-state] Migrated ${completedStories.length} stories from progress.txt`);
    return state;
  } catch {
    return null;
  }
}
