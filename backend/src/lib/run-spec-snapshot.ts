/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface RunSpecPathOptions {
  runId: number;
  sourceSpecPath: string;
  workspacePath?: string;
  worktreePath: string | null;
  /** Retries always own an isolated snapshot, even in direct execution mode. */
  retry?: boolean;
}

function assertRunId(runId: number): void {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('Invalid run ID for spec snapshot');
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Deterministically derive the only mutable spec path a run may own. */
export function deriveRunSpecPath(options: RunSpecPathOptions): string {
  assertRunId(options.runId);
  const source = path.resolve(options.sourceSpecPath);
  if (!options.worktreePath && !options.retry) {
    if (!options.workspacePath) return source;
    const workspace = path.resolve(options.workspacePath);
    if (!contained(workspace, source)) throw new Error('Direct run spec escaped the workspace');
    return source;
  }
  const rootInput = options.worktreePath ?? options.workspacePath;
  if (!rootInput) throw new Error('Run snapshot root is required');
  const root = path.resolve(rootInput);
  const snapshot = path.resolve(root, '.rorca', 'run-specs', `run-${options.runId}.json`);
  if (!contained(root, snapshot)) throw new Error('Run spec snapshot escaped its run root');
  return snapshot;
}

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Atomically replace and durably flush a bounded local JSON projection. */
export function durableAtomicWriteFile(filePath: string, content: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

interface ProjectionStory {
  id?: unknown;
  passes?: unknown;
  excluded?: unknown;
}

function projectionStories(value: unknown): ProjectionStory[] {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('run spec projection must be a JSON object');
  }
  const spec = value as { userStories?: unknown; phases?: unknown };
  if (Array.isArray(spec.userStories)) return spec.userStories as ProjectionStory[];
  if (Array.isArray(spec.phases)) {
    return spec.phases.flatMap((phase) => {
      if (!phase || Array.isArray(phase) || typeof phase !== 'object') return [];
      const stories = (phase as { stories?: unknown }).stories;
      return Array.isArray(stories) ? stories as ProjectionStory[] : [];
    });
  }
  throw new Error('run spec projection has no story collection');
}

/**
 * Verify lifecycle flags in the agent-writable file against frozen host scope.
 * The file is a projection only: it can never create pass or exclusion authority.
 */
export function assertRunSpecAuthorityProjection(input: {
  specPath: string;
  expectedStoryIds: readonly string[];
  excludedStoryIds?: readonly string[];
  authoritativePassedStoryIds: readonly string[];
}): void {
  const expected = new Set(input.expectedStoryIds);
  const excluded = new Set(input.excludedStoryIds ?? []);
  const passed = new Set(input.authoritativePassedStoryIds);
  if (expected.size !== input.expectedStoryIds.length
    || excluded.size !== (input.excludedStoryIds ?? []).length
    || [...expected].some(id => excluded.has(id))
    || [...passed].some(id => !expected.has(id))) {
    throw new Error('frozen run scope is internally inconsistent');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(input.specPath, 'utf8')) as unknown; }
  catch { throw new Error('run spec projection is unavailable or invalid'); }
  const stories = projectionStories(parsed);
  const byId = new Map<string, ProjectionStory[]>();
  for (const story of stories) {
    if (typeof story.id !== 'string' || !story.id.trim()) continue;
    const id = story.id.trim();
    const group = byId.get(id) ?? [];
    group.push(story);
    byId.set(id, group);
  }
  for (const storyId of expected) {
    const matches = byId.get(storyId) ?? [];
    if (matches.length !== 1) throw new Error(`run spec projection differs from frozen story ${storyId}`);
    const story = matches[0];
    if (story.excluded === true || (story.passes === true) !== passed.has(storyId)) {
      throw new Error(`run spec projection lifecycle flags lack host authority for ${storyId}`);
    }
  }
  for (const storyId of excluded) {
    const matches = byId.get(storyId) ?? [];
    if (matches.length !== 1 || matches[0].excluded !== true || matches[0].passes === true) {
      throw new Error(`run spec exclusion differs from frozen host policy for ${storyId}`);
    }
  }
}

/**
 * Worktree and retry runs mutate only a deterministic ignored snapshot. Direct
 * non-retry runs retain the historical canonical-spec contract.
 */
export function prepareRunSpecSnapshot(options: RunSpecPathOptions): string {
  const source = path.resolve(options.sourceSpecPath);
  if (!fs.existsSync(source)) throw new Error(`Run spec not found: ${source}`);
  const destination = deriveRunSpecPath(options);
  if (destination === source) return source;
  durableAtomicWriteFile(destination, fs.readFileSync(source, 'utf8'));
  return destination;
}
