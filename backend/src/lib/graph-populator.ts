/**
 * PG-015: Graph Populator — WAL event subscriber for knowledge graph population
 *
 * Listens to WAL events and populates the Apache AGE knowledge graph:
 *   - run_finished → parse story_commits for file paths → Story-[:TOUCHES]->File edges
 *   - spec_approved → parse spec JSON → Story-[:BELONGS_TO]->Spec, Story-[:DEPENDS_ON]->Story
 *   - Memory synthesis → Memory-[:LEARNED_FROM]->Story edges
 */

import { subscribe, type WalEvent } from './sse-hub';
import { populateFromRun, populateFromSpec, addMemoryLink } from './knowledge-graph';
import { query, queryOne } from '../db/index';
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
    default:
      break;
  }
}

async function handleRunFinished(event: WalEvent): Promise<void> {
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
}

function extractSpecId(specPath: string): string {
  if (!specPath) return '';
  // "forge/specs/approved/my-spec.json" → "my-spec"
  const basename = specPath.split('/').pop() || '';
  return basename.replace(/\.json$/, '');
}
