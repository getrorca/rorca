/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
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
} from './knowledge-graph';
import { queryOne } from '../db/index';
import { logger } from './logger';

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
      await handleMemoryCreated(event);
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

async function handleMemoryCreated(event: WalEvent): Promise<void> {
  logger.info(
    { eventType: event.event_type, storyId: event.story_id, specId: event.spec_id },
    '[graph-populator] handleMemoryCreated received WAL event',
  );
  if (!(await isGraphAvailable())) return;

  let payload: { storyId?: string; categories?: string[]; id?: string; category?: string; relatedFiles?: string[]; related_files?: string[]; specId?: string; source_spec_id?: string };
  try {
    payload = JSON.parse(event.payload || '{}');
  } catch {
    return;
  }

  const sourceStoryId = event.story_id || payload.storyId || '';
  const sourceSpecId = event.spec_id || payload.specId || payload.source_spec_id || '';
  const workspaceId = event.workspace_id || '';
  if (!sourceStoryId && !sourceSpecId) return;
  if (!workspaceId) {
    logger.warn({ memoryId: payload.id || `mem-${event.id}` }, '[graph-populator] skipping memory graph write without workspaceId');
    return;
  }

  // memory_auto_saved has categories array; memory_created may have a single category
  const categories = payload.categories || (payload.category ? [payload.category] : ['unknown']);
  const memoryId = payload.id || `mem-${event.id}`;
  const relatedFiles = [...new Set([...(payload.relatedFiles ?? []), ...(payload.related_files ?? [])])].filter(Boolean);

  if (sourceStoryId) {
    for (const category of categories) {
      await addMemoryLink(memoryId, sourceStoryId, sourceSpecId, workspaceId, category);
    }
  }

  if (sourceSpecId) {
    await addMemorySourceSpec(memoryId, sourceSpecId, workspaceId);
  }

  for (const filePath of relatedFiles) {
    await addMemoryAboutFile(memoryId, filePath, workspaceId);
  }

  logger.info(
    { memoryId, sourceStoryId, sourceSpecId, categories, relatedFiles },
    '[graph-populator] Memory graph edges created',
  );
}

// ── Existing handlers ───────────────────────────────────────────────────────

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
}

async function handleSpecApproved(event: WalEvent): Promise<void> {
  logger.info(
    { eventType: event.event_type, specId: event.spec_id, workspaceId: event.workspace_id },
    '[graph-populator] handleSpecApproved received WAL event',
  );
  if (!(await isGraphAvailable())) return;

  if (!event.spec_id || !event.workspace_id) return;

  // Try to load spec stories from the database (spec_versions table)
  const version = await queryOne<{ content: string }>(
    `SELECT content FROM spec_versions
     WHERE spec_id = $1
     ORDER BY version DESC LIMIT 1`,
    [event.spec_id],
  );

  if (!version?.content) return;

  let parsed: { userStories?: Array<{ id: string; title: string; dependsOn?: string[] }> };
  try {
    parsed = JSON.parse(version.content);
  } catch {
    return;
  }

  if (!parsed.userStories || parsed.userStories.length === 0) return;

  await populateFromSpec(
    event.spec_id,
    event.workspace_id,
    parsed.userStories.map(s => ({
      id: s.id,
      title: s.title,
      dependsOn: s.dependsOn,
    })),
  );

  // SW-008: Populate convention nodes from .rorca/config.json
  const workspace = await queryOne<{ path: string }>(
    'SELECT path FROM workspaces WHERE id = $1',
    [event.workspace_id],
  );
  if (workspace?.path) {
    await populateConventionsFromConfig(event.workspace_id, workspace.path);
  }
}

function extractSpecId(specPath: string): string {
  if (!specPath) return '';
  // "forge/specs/approved/my-spec.json" → "my-spec"
  const basename = specPath.split('/').pop() || '';
  return basename.replace(/\.json$/, '');
}
