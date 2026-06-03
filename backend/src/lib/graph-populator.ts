/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-015 / SW-005: Graph Populator — WAL event subscriber for knowledge graph population
 *
 * Listens to WAL events and populates the Apache AGE knowledge graph:
 *   - run_finished → mine story_output_chunks for file paths → Story-[:TOUCHES]->File edges
 *   - spec_approved → parse spec JSON → Story-[:BELONGS_TO]->Spec, Story-[:DEPENDS_ON]->Story
 *   - story_passed / story_failed → per-story graph population (nodes + file-touch + skills)
 *   - memory_created / memory_auto_saved → Memory-[:LEARNED_FROM]->Story and Memory-[:FROM_SPEC]->Spec edges
 */

import * as fs from 'fs';
import * as path from 'path';
import { subscribe, type WalEvent } from './sse-hub';
import {
  isGraphAvailable,
  populateFromRun,
  populateFromSpec,
  populateConventionsFromConfig,
  addStoryNode,
  addFileTouch,
  addSkillUsage,
  addMemoryLink,
  addMemoryAboutFile,
  addMemorySourceSpec,
  collectStoryFileTouches,
  normalizeGraphFilePath,
  reconcileWorkspaceGraphProjection,
} from './knowledge-graph';
import { queryOne } from '../db/index';
import { logger } from './logger';
import { reconcileMemoryRelationProjection } from './memory-relations';

/**
 * Start the graph populator subscriber.
 * Call once at server startup (alongside other WAL subscribers).
 */
export function startGraphPopulator(): void {
  subscribe((event: WalEvent) => {
    handleWalEvent(event).catch((err) => {
      logger.error({ err, eventType: event.event_type }, '[graph-populator] Error handling WAL event');
    });
  });
  logger.info('[graph-populator] Subscribed to WAL events');
}

async function handleWalEvent(event: WalEvent): Promise<void> {
  switch (event.event_type) {
    case 'run_finished':
      await handleRunFinished(event);
      break;
    case 'spec_approved':
      await handleSpecApproved(event);
      break;
    case 'story_passed':
      await handleStoryCompleted(event, 'pass');
      break;
    case 'story_failed':
      await handleStoryCompleted(event, 'fail');
      break;
    case 'memory_created':
    case 'memory_auto_saved':
    case 'memory_restored':
      await handleMemoryCreated(event);
      break;
    case 'story_deleted':
      await handleStoryDeleted(event);
      break;
    case 'spec_deleted':
    case 'memory_deleted':
      await handleWorkspaceCleanup(event);
      break;
    default:
      break;
  }
}

// ── Per-story graph population (SW-005) ─────────────────────────────────────

async function handleStoryCompleted(event: WalEvent, status: 'pass' | 'fail'): Promise<void> {
  logger.info(
    { eventType: event.event_type, storyId: event.story_id, specId: event.spec_id, status },
    '[graph-populator] handleStoryCompleted received WAL event',
  );
  if (!(await isGraphAvailable())) return;

  let payload: { run_id?: number; story_id?: string; story_title?: string };
  try {
    payload = JSON.parse(event.payload || '{}');
  } catch {
    return;
  }

  const storyId = event.story_id || payload.story_id;
  if (!storyId) return;

  const runId = payload.run_id;
  let workspaceId = event.workspace_id || '';
  let specId = event.spec_id || '';
  const title = payload.story_title || storyId;

  if (runId && (!workspaceId || !specId)) {
    const run = await queryOne<{ spec_path: string; workspace_id: string }>(
      'SELECT spec_path, workspace_id FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    workspaceId = workspaceId || run?.workspace_id || '';
    specId = specId || extractSpecId(run?.spec_path || '');
  }

  if (!specId || !workspaceId) {
    logger.warn({ storyId, runId, specId, workspaceId }, '[graph-populator] skipping story graph write without canonical scope');
    return;
  }

  let nodesCreated = 0;
  let edgesCreated = 0;

  // 1. Add story node
  await addStoryNode({ id: storyId, specId, workspaceId, title, status });
  nodesCreated++;

  // 2. Mine real file paths from story output chunks instead of commit SHAs.
  if (runId) {
    const filePaths = await collectStoryFileTouches(runId, storyId);
    for (const filePath of filePaths) {
      await addFileTouch(storyId, filePath, workspaceId, specId);
      edgesCreated++;
    }
  }

  // 3. Check active_skills from story_results for matched skills
  if (runId) {
    const sr = await queryOne<{ active_skills: string | null }>(
      'SELECT active_skills FROM story_results WHERE run_id = $1 AND story_id = $2 ORDER BY id DESC LIMIT 1',
      [runId, storyId],
    );
    if (sr?.active_skills) {
      try {
        const skills: string[] = JSON.parse(sr.active_skills);
        for (const skillName of skills) {
          await addSkillUsage(skillName, storyId, specId, workspaceId, 'auto-match');
          edgesCreated++;
        }
      } catch {
        // Malformed JSON in active_skills — skip
      }
    }
  }

  logger.info(
    { storyId, status, nodesCreated, edgesCreated },
    '[graph-populator] Story graph populated',
  );
}

// ── Memory graph population (SW-005) ────────────────────────────────────────

interface MemoryProjectionRow {
  category: string | null;
  source_story_id: string | null;
  source_spec_id: string | null;
  related_files: string[] | string | null;
  pinned: boolean | null;
  created_at: string | null;
  updated_at: string | null;
}

function parseMemoryRelatedFiles(value: string[] | string | null | undefined): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? (() => {
          try {
            const parsed = JSON.parse(value) as unknown;
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })()
      : [];

  return [...new Set(raw
    .filter((file): file is string => typeof file === 'string' && file.trim().length > 0)
    .map(file => normalizeGraphFilePath(file))
    .filter(Boolean))];
}

export function projectMemoryRelationships(row: MemoryProjectionRow): Array<
  | { type: 'LEARNED_FROM'; target: string }
  | { type: 'FROM_SPEC'; target: string }
  | { type: 'ABOUT'; target: string }
> {
  const relationships: Array<
    | { type: 'LEARNED_FROM'; target: string }
    | { type: 'FROM_SPEC'; target: string }
    | { type: 'ABOUT'; target: string }
  > = [];

  if (row.source_story_id) {
    relationships.push({ type: 'LEARNED_FROM', target: row.source_story_id });
  }
  if (row.source_spec_id) {
    relationships.push({ type: 'FROM_SPEC', target: row.source_spec_id });
  }
  for (const filePath of parseMemoryRelatedFiles(row.related_files)) {
    relationships.push({ type: 'ABOUT', target: filePath });
  }

  return relationships;
}

async function handleMemoryCreated(event: WalEvent): Promise<void> {
  logger.info(
    { eventType: event.event_type, storyId: event.story_id, specId: event.spec_id },
    '[graph-populator] handleMemoryCreated received WAL event',
  );
  if (!(await isGraphAvailable())) return;

  let payload: { storyId?: string; categories?: string[]; id?: string | number; category?: string; relatedFiles?: string[]; related_files?: string[]; specId?: string; source_spec_id?: string };
  try {
    payload = JSON.parse(event.payload || '{}');
  } catch {
    return;
  }

  const workspaceId = event.workspace_id || '';
  const memoryId = String(payload.id || `mem-${event.id}`);
  if (!workspaceId) {
    logger.warn({ memoryId }, '[graph-populator] skipping memory graph write without workspaceId');
    return;
  }

  const persisted = /^\d+$/.test(memoryId)
    ? await queryOne<MemoryProjectionRow>(
      `SELECT category, source_story_id, source_spec_id, related_files,
              COALESCE(pinned, false) AS pinned,
              created_at,
              updated_at
         FROM memories
        WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
      [memoryId, workspaceId],
    )
    : undefined;

  const fallbackRow: MemoryProjectionRow = {
    category: payload.category ?? null,
    source_story_id: event.story_id || payload.storyId || null,
    source_spec_id: event.spec_id || payload.specId || payload.source_spec_id || null,
    related_files: [
      ...(payload.relatedFiles ?? []),
      ...(payload.related_files ?? []),
    ],
    pinned: false,
    created_at: null,
    updated_at: null,
  };

  const projection = projectMemoryRelationships(persisted ?? fallbackRow);
  const sourceStoryId = projection.find((edge) => edge.type === 'LEARNED_FROM')?.target || '';
  const sourceSpecId = projection.find((edge) => edge.type === 'FROM_SPEC')?.target || '';
  const relatedFiles = projection
    .filter((edge): edge is { type: 'ABOUT'; target: string } => edge.type === 'ABOUT')
    .map(edge => edge.target);

  if (!sourceStoryId && !sourceSpecId) return;

  // memory_auto_saved has categories array; memory_created may have a single category
  const categories = persisted?.category
    ? [persisted.category]
    : payload.categories || (payload.category ? [payload.category] : ['unknown']);

  const metadata = {
    pinned: Boolean((persisted ?? fallbackRow).pinned),
    createdAt: (persisted ?? fallbackRow).created_at,
    updatedAt: (persisted ?? fallbackRow).updated_at,
  };

  if (sourceStoryId) {
    for (const category of categories) {
      await addMemoryLink(memoryId, sourceStoryId, sourceSpecId, workspaceId, category, metadata);
    }
  }

  if (sourceSpecId) {
    await addMemorySourceSpec(memoryId, sourceSpecId, workspaceId, metadata);
  }

  for (const filePath of relatedFiles) {
    await addMemoryAboutFile(memoryId, filePath, workspaceId, metadata);
  }

  await reconcileMemoryRelationProjection(workspaceId);

  logger.info(
    { memoryId, sourceStoryId, sourceSpecId, categories, relatedFiles, provenance: persisted ? 'db' : 'wal' },
    '[graph-populator] Memory graph edges created',
  );
}

// ── Existing handlers ───────────────────────────────────────────────────────

function resolveWorkspaceIdFromEvent(event: WalEvent, payload?: Record<string, unknown>): string {
  return event.workspace_id || String(payload?.workspaceId || payload?.workspace_id || '');
}

async function getWorkspacePath(workspaceId: string): Promise<string> {
  if (!workspaceId) return '';
  const workspace = await queryOne<{ path: string }>(
    'SELECT path FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  return workspace?.path || '';
}

async function reconcileWorkspaceProjection(workspaceId: string): Promise<void> {
  const workspacePath = await getWorkspacePath(workspaceId);
  if (!workspacePath) return;
  await reconcileWorkspaceGraphProjection(workspaceId, workspacePath);
}

async function syncSpecProjectionFromWorkspace(workspaceId: string, specId: string): Promise<boolean> {
  const workspacePath = await getWorkspacePath(workspaceId);
  if (!workspacePath || !specId) return false;

  const approvedPath = path.join(workspacePath, 'forge', 'specs', 'approved', `${specId}.json`);
  const pendingPath = path.join(workspacePath, 'forge', 'specs', 'pending', `${specId}.json`);
  const specPath = fs.existsSync(approvedPath) ? approvedPath : pendingPath;
  if (!fs.existsSync(specPath)) return false;

  try {
    const parsed = JSON.parse(fs.readFileSync(specPath, 'utf-8')) as {
      userStories?: Array<{ id: string; title: string; dependsOn?: string[] }>;
    };
    if (!parsed.userStories || parsed.userStories.length === 0) return false;

    await populateFromSpec(
      specId,
      workspaceId,
      parsed.userStories.map((story) => ({
        id: story.id,
        title: story.title,
        dependsOn: story.dependsOn,
      })),
    );
    await populateConventionsFromConfig(workspaceId, workspacePath);
    return true;
  } catch (err) {
    logger.warn({ err, workspaceId, specId, specPath }, '[graph-populator] Failed to sync spec projection from workspace file');
    return false;
  }
}

async function handleStoryDeleted(event: WalEvent): Promise<void> {
  if (!(await isGraphAvailable())) return;

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(event.payload || '{}') as Record<string, unknown>;
  } catch {
    // ignore malformed payloads
  }

  const workspaceId = resolveWorkspaceIdFromEvent(event, payload);
  const specId = event.spec_id || String(payload.specId || payload.spec_id || '');
  if (!workspaceId || !specId) return;

  await syncSpecProjectionFromWorkspace(workspaceId, specId);
  await reconcileWorkspaceProjection(workspaceId);
}

async function handleWorkspaceCleanup(event: WalEvent): Promise<void> {
  if (!(await isGraphAvailable())) return;

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(event.payload || '{}') as Record<string, unknown>;
  } catch {
    // ignore malformed payloads
  }

  const workspaceId = resolveWorkspaceIdFromEvent(event, payload);
  if (!workspaceId) return;

  await reconcileWorkspaceProjection(workspaceId);
  await reconcileMemoryRelationProjection(workspaceId);
}

async function handleRunFinished(event: WalEvent): Promise<void> {
  logger.info(
    { eventType: event.event_type, specId: event.spec_id, workspaceId: event.workspace_id },
    '[graph-populator] handleRunFinished received WAL event',
  );
  if (!(await isGraphAvailable())) return;

  let payload: { run_id?: number; status?: string };
  try {
    payload = JSON.parse(event.payload || '{}');
  } catch {
    return;
  }

  if (!payload.run_id) return;
  // Only populate graph for successful or failed runs (not cancelled)
  if (payload.status !== 'done' && payload.status !== 'failed') return;

  // Look up the run to get spec_id and workspace_id
  const run = await queryOne<{ id: number; spec_path: string; workspace_id: string }>(
    'SELECT id, spec_path, workspace_id FROM pipeline_runs WHERE id = $1',
    [payload.run_id],
  );
  if (!run) return;

  // Extract spec ID from spec_path (e.g. "forge/specs/approved/my-spec.json" → "my-spec")
  const specId = event.spec_id || extractSpecId(run.spec_path);
  if (!specId) return;

  await populateFromRun(payload.run_id, specId, run.workspace_id);
  await reconcileWorkspaceProjection(run.workspace_id);
}

async function handleSpecApproved(event: WalEvent): Promise<void> {
  logger.info(
    { eventType: event.event_type, specId: event.spec_id, workspaceId: event.workspace_id },
    '[graph-populator] handleSpecApproved received WAL event',
  );
  if (!(await isGraphAvailable())) return;

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(event.payload || '{}') as Record<string, unknown>;
  } catch {
    // ignore malformed payloads
  }

  const workspaceId = resolveWorkspaceIdFromEvent(event, payload);
  const specId = event.spec_id || String(payload.specId || payload.spec_id || '');
  if (!workspaceId || !specId) return;

  await syncSpecProjectionFromWorkspace(workspaceId, specId);
  await reconcileWorkspaceProjection(workspaceId);
}

function extractSpecId(specPath: string): string {
  if (!specPath) return '';
  // "forge/specs/approved/my-spec.json" → "my-spec"
  const basename = specPath.split('/').pop() || '';
  return basename.replace(/\.json$/, '');
}

export const __testables = {
  handleMemoryCreated,
  projectMemoryRelationships,
};
