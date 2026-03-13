/**
 * auto-hydrate.ts — Git-based memory auto-hydration (US-002)
 *
 * hydrateGitMemory(workspaceId) orchestrates the full pipeline:
 *   1. gitReduceStep()         — produce YAML from workspace git history
 *   2. parseGitReduceYaml()    — parse YAML into MemoryEntry objects
 *   3. embed + dedup           — generate embeddings and skip near-duplicates (≥ 0.92 cosine similarity)
 *   4. INSERT INTO memories    — persist new entries with source='git_hydration'
 *   5. update last_ingested_commit_hash in workspace_context
 *
 * Fire-and-forget safe: all errors are caught and logged, never propagated.
 */

import { execSync } from 'child_process';
import { query, queryOne, execute } from '../db/index';
import { logger } from './logger';
import { gitMapStep, gitReduceStep, getLatestHash } from './git-hydrator';
import { parseGitReduceYaml } from './git-yaml-parser';
import { getProvider, prepareText } from './embedding-pipeline';

// ─── Types ───────────────────────────────────────────────────────────────────

interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
}

interface WorkspaceContextRow {
  last_ingested_commit_hash: string | null;
}

// ─── Cosine similarity ───────────────────────────────────────────────────────

/** Cosine similarity between two equal-length vectors (range -1..1). */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ─── Deduplication check ─────────────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.92;

/**
 * Returns true if there is already a memory in the DB for this workspace
 * whose embedding has cosine similarity ≥ 0.92 with the given embedding.
 *
 * Uses pgvector's <=> (cosine distance) operator: distance = 1 - similarity.
 * Threshold 0.92 similarity → distance ≤ 0.08.
 */
async function isDuplicate(
  workspaceId: string,
  embedding: number[]
): Promise<boolean> {
  const vectorLiteral = `[${embedding.join(',')}]`;
  const row = await queryOne<{ similarity: number }>(
    `SELECT 1 - (embedding <=> $1::vector) AS similarity
     FROM memories
     WHERE workspace_id = $2 AND deleted_at IS NULL
     ORDER BY embedding <=> $1::vector
     LIMIT 1`,
    [vectorLiteral, workspaceId]
  );
  if (!row) return false;
  return row.similarity >= SIMILARITY_THRESHOLD;
}

// ─── Get current HEAD commit hash ────────────────────────────────────────────

function getCurrentHeadHash(workspacePath: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: workspacePath, stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Hydrate the memories table from the workspace's git history.
 *
 * Fire-and-forget safe — all errors are caught and logged, never thrown.
 */
export async function hydrateGitMemory(workspaceId: string): Promise<void> {
  try {
    // 1. Fetch workspace
    const workspace = await queryOne<WorkspaceRow>(
      'SELECT id, label, path FROM workspaces WHERE id = $1',
      [workspaceId]
    );
    if (!workspace) {
      logger.warn({ workspaceId }, '[AutoHydrate] Workspace not found — skipping');
      return;
    }

    // 2. Get last ingested hash for delta hydration
    const ctx = await queryOne<WorkspaceContextRow>(
      'SELECT last_ingested_commit_hash FROM workspace_context WHERE workspace_id = $1',
      [workspaceId]
    );
    const fromHash = ctx?.last_ingested_commit_hash ?? undefined;

    // 3. Map git history into chunk summaries
    let summaries;
    try {
      summaries = await gitMapStep({ workspacePath: workspace.path, fromHash });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ workspaceId, err: msg }, '[AutoHydrate] gitMapStep failed — skipping');
      return;
    }

    if (summaries.length === 0) {
      logger.info({ workspaceId }, '[AutoHydrate] No new commits — nothing to hydrate');
      return;
    }

    // 4. Reduce summaries into a single YAML document
    let yaml: string;
    try {
      yaml = await gitReduceStep({ summaries, workspaceLabel: workspace.label });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ workspaceId, err: msg }, '[AutoHydrate] gitReduceStep failed — skipping');
      return;
    }

    if (!yaml || !yaml.trim()) {
      logger.info({ workspaceId }, '[AutoHydrate] gitReduceStep returned empty YAML — nothing to insert');
      return;
    }

    // 5. Parse YAML → MemoryEntry objects
    const entries = parseGitReduceYaml(yaml);
    if (entries.length === 0) {
      logger.info({ workspaceId }, '[AutoHydrate] No parseable entries from YAML — nothing to insert');
      return;
    }

    // 6. Embed, deduplicate, and insert
    const provider = getProvider(workspace.path);
    let inserted = 0;
    let skipped = 0;

    for (const entry of entries) {
      try {
        const text = prepareText('memory', `${entry.category}: ${entry.title}\n${entry.rule}`);
        const embedResult = await provider.embed([text]);
        const embedding = embedResult.embeddings[0];

        const dup = await isDuplicate(workspaceId, embedding);
        if (dup) {
          skipped++;
          continue;
        }

        const vectorLiteral = `[${embedding.join(',')}]`;
        const content = entry.context
          ? `${entry.rule}\nContext: ${entry.context}`
          : entry.rule;

        await execute(
          `INSERT INTO memories
             (workspace_id, category, content, source, embedding, confidence)
           VALUES ($1, $2, $3, $4, $5::vector, 'medium')`,
          [workspaceId, entry.category, content, 'git_hydration', vectorLiteral]
        );
        inserted++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ workspaceId, entry: entry.title, err: msg }, '[AutoHydrate] Failed to insert entry — skipping');
      }
    }

    logger.info({ workspaceId, inserted, skipped, total: entries.length }, '[AutoHydrate] Hydration complete');

    // 7. Update last_ingested_commit_hash to current HEAD
    const headHash = getCurrentHeadHash(workspace.path);
    if (headHash) {
      await execute(
        `INSERT INTO workspace_context (workspace_id, last_ingested_commit_hash)
         VALUES ($1, $2)
         ON CONFLICT (workspace_id) DO UPDATE SET
           last_ingested_commit_hash = EXCLUDED.last_ingested_commit_hash`,
        [workspaceId, headHash]
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ workspaceId, err: msg }, '[AutoHydrate] Unexpected error — suppressed');
  }
}
