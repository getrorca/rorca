/**
 * memory-synthesis.ts — Post-Run Memory Synthesis (CIE-005)
 *
 * Subscribes to WAL events. When a run finishes successfully,
 * reviews story results and proposes new memory ledger entries.
 * Proposals are stored as pending WAL events for the Hub to surface.
 */

import { db } from '../db/index';
import { subscribe, type WalEvent } from './sse-hub';
import {
  readMemory,
  buildSynthesisPrompt,
  parseSynthesisResponse,
  type ProposedMemoryEntry,
} from './memory-ledger';
import { chatComplete } from './llm-client';

interface StoryResult {
  story_id: string;
  status: string;
}

/**
 * Start the memory synthesis subscriber.
 * Listens for run_finished events and triggers synthesis for successful runs.
 */
export function startMemorySynthesis(): void {
  subscribe((event: WalEvent) => {
    if (event.event_type !== 'run_finished') return;

    let payload: { run_id?: number; status?: string };
    try {
      payload = JSON.parse(event.payload || '{}');
    } catch {
      return;
    }

    // Only synthesize on successful completions
    if (payload.status !== 'done' || !payload.run_id) return;

    const workspaceId = event.workspace_id;
    if (!workspaceId) return;

    // Fire and forget — async synthesis runs in the background
    synthesizeMemory(workspaceId, payload.run_id).catch(err => {
      console.error(`[memory-synthesis] Error for run ${payload.run_id}:`, err);
    });
  });
}

/**
 * Synthesize memory entries from a completed run.
 * Fetches story results, builds a synthesis prompt, calls LLM,
 * and emits proposed entries as a WAL event for the Hub.
 */
async function synthesizeMemory(workspaceId: string, runId: number): Promise<void> {
  const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(workspaceId) as { path: string } | undefined;
  if (!ws) return;

  // Get story results for this run
  const storyResults = db.prepare(
    'SELECT story_id, status FROM story_results WHERE run_id = ?'
  ).all(runId) as StoryResult[];

  if (storyResults.length === 0) return;

  // Get existing memory entries
  const existingEntries = readMemory(ws.path);

  // Build synthesis prompt
  const storyData = storyResults.map(sr => ({
    id: sr.story_id,
    title: sr.story_id,
    status: sr.status,
  }));

  const prompt = buildSynthesisPrompt(storyData, existingEntries);

  // Call LLM for synthesis (single user message)
  let result;
  try {
    result = await chatComplete([{ role: 'user', content: prompt }]);
  } catch (err) {
    console.error('[memory-synthesis] LLM call failed:', err);
    return;
  }

  // Parse proposed entries
  const proposed = parseSynthesisResponse(result.text);
  if (proposed.length === 0) return;

  // Build proposals with IDs
  const today = new Date().toISOString().slice(0, 10);
  const proposals: ProposedMemoryEntry[] = proposed.map((entry, i) => ({
    ...entry,
    date: today,
    proposalId: `run-${runId}-${i}`,
    status: 'pending' as const,
  }));

  // Emit as WAL event for Hub to pick up
  const walPayload = JSON.stringify({
    run_id: runId,
    workspace_id: workspaceId,
    proposals,
  });

  db.prepare(
    `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('memory_proposals', ?, ?)`
  ).run(workspaceId, walPayload);

  console.log(`[memory-synthesis] Proposed ${proposals.length} memory entries for run ${runId}`);
}
