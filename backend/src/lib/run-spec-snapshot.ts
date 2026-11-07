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

export interface StoryExecutionManifestPathOptions {
  runId: number;
  executionRoot: string;
}

function assertRunId(runId: number): void {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error('Invalid run ID for run artifact');
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

/** Deterministically derive the immutable execution-manifest bundle owned by one run. */
export function deriveStoryExecutionManifestPath(options: StoryExecutionManifestPathOptions): string {
  assertRunId(options.runId);
  const root = path.resolve(options.executionRoot);
  const manifest = path.resolve(
    root,
    '.rorca',
    'runtime',
    `run-${options.runId}-story-execution-manifests.json`,
  );
  if (!contained(root, manifest)) throw new Error('Story execution manifest escaped its run root');
  return manifest;
}

/** Recognize only the deterministic per-run artifacts published before worker preflight. */
export function isDeterministicRunArtifactPath(candidate: string): boolean {
  const normalized = candidate.replaceAll('\\', '/');
  return /^\.rorca\/run-specs\/run-[1-9]\d*\.json$/.test(normalized)
    || /^\.rorca\/runtime\/run-[1-9]\d*-story-execution-manifests\.json$/.test(normalized)
    // archiveRunState() archives the run-state ledger per run; it is engine-owned
    // checkpoint metadata, never operator work.
    || /^\.rorca\/memory\/runs\/[1-9]\d*\.json$/.test(normalized)
    // The ordinary-local-Pi runner persists one session transcript and one
    // autonomous-runner markdown per run+story; both are engine-owned and
    // deterministic (execution-engine.ts / pi-autonomous-runner.ts).
    || /^\.rorca\/ordinary-local-pi-tmp\/rorca-pi-session-[1-9]\d*-[A-Za-z0-9_-]+\/[^/]+\.jsonl$/.test(normalized)
    || /^\.rorca\/runtime\/rorca-pi-autonomous-runner-[1-9]\d*(-[A-Za-z0-9_-]+)?\.md$/.test(normalized);
}

export function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * Create a directory hierarchy and durably publish every new directory entry.
 * fsyncing a new child is insufficient: the parent containing its name is the
 * metadata authority that must reach stable storage before success is exposed.
 */
export function durableEnsureDirectory(directory: string): void {
  const target = path.resolve(directory);
  const missing: string[] = [];
  let cursor = target;
  while (!fs.existsSync(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`Cannot resolve durable directory parent for ${target}`);
    cursor = parent;
  }
  if (!fs.statSync(cursor).isDirectory()) {
    throw new Error(`Durable directory ancestor is not a directory: ${cursor}`);
  }

  for (const nextDirectory of missing.reverse()) {
    try {
      fs.mkdirSync(nextDirectory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' || !fs.statSync(nextDirectory).isDirectory()) throw error;
    }
    fsyncDirectory(nextDirectory);
    fsyncDirectory(path.dirname(nextDirectory));
  }
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
    if (process.env.NODE_ENV === 'test'
      && process.env.RORCA_DURABLE_ATOMIC_WRITE_FAILPOINT === 'after_temp_write_before_fsync') {
      throw new Error('durable_atomic_write_failpoint:after_temp_write_before_fsync');
    }
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
    // The projection can never CREATE pass authority: a flag the host does
    // not hold is forgery. A missing flag is staleness, not forgery — frozen
    // mode keeps passes in memory until the engine flush, so an exact
    // two-way match would fail every frozen-mode closeout.
    if (story.passes === true && !passed.has(storyId)) {
      throw new Error(`run spec projection claims pass authority the host lacks for ${storyId}`);
    }
    if (story.excluded === true) throw new Error(`run spec projection excludes a frozen executable story ${storyId}`);
  }
  for (const storyId of excluded) {
    const matches = byId.get(storyId) ?? [];
    if (matches.length !== 1 || matches[0].excluded !== true || matches[0].passes === true) {
      throw new Error(`run spec exclusion differs from frozen host policy for ${storyId}`);
    }
  }
}

const CHILD_SPEC_REFERENCE_PATTERN = /\bchild\s+([a-z][a-z0-9-]*)\s+spec\b|\bchild\s+spec\s+([a-z][a-z0-9-]*)\b/g;

/**
 * Every "child spec <slug>" acceptance-criterion reference must resolve to a
 * real spec file in the workspace. A dangling reference ships an impossible
 * story: the agent burns a full run discovering the referenced spec never
 * existed (the CRG-000 regression). Fail at launch instead.
 */
export function assertChildSpecReferencesResolvable(input: {
  specJson: Record<string, unknown>;
  workspacePath: string;
}): void {
  const stories = Array.isArray(input.specJson.userStories)
    ? input.specJson.userStories
    : Array.isArray(input.specJson.phases)
      ? (input.specJson.phases as Array<{ stories?: unknown }>).flatMap(phase => Array.isArray(phase.stories) ? phase.stories : [])
      : [];
  const missing = new Map<string, string>();
  for (const story of stories as Array<Record<string, unknown>>) {
    const storyId = typeof story.id === 'string' ? story.id : '?';
    const criteria = Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [];
    for (const criterion of criteria) {
      if (typeof criterion !== 'string') continue;
      CHILD_SPEC_REFERENCE_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = CHILD_SPEC_REFERENCE_PATTERN.exec(criterion)) !== null) {
        const slug = match[1] ?? match[2];
        if (!slug) continue;
        const approved = path.join(input.workspacePath, 'forge', 'specs', 'approved', `${slug}.json`);
        const pending = path.join(input.workspacePath, 'forge', 'specs', 'pending', `${slug}.json`);
        if (!fs.existsSync(approved) && !fs.existsSync(pending)) {
          missing.set(slug, storyId);
        }
      }
    }
  }
  if (missing.size > 0) {
    const details = [...missing.entries()].map(([slug, storyId]) => `${slug} (referenced by ${storyId})`).join(', ');
    throw new Error(
      `Acceptance criteria reference child spec(s) that do not exist under forge/specs/{approved,pending}: ${details}. `
      + 'Author and commit the child spec before launching the parent program.',
    );
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
