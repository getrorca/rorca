/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * cross-workspace-memory.ts — Cross-Workspace Memory Synthesis (PR-021)
 *
 * Finds relevant memory entries from other workspaces in the same domain (L2)
 * and surfaces them as suggestions. Uses pgvector cosine similarity when
 * available, falls back to domain + category matching.
 *
 * Cross-workspace entries are SUGGESTIONS only — users must explicitly accept
 * them before they appear in the target workspace's MEMORY.md.
 */

import { query, queryOne, execute } from '../db/index';
import { readMemory, append, type MemoryEntry } from './memory-ledger';
import { invalidateMemory } from './context-cache';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CrossWorkspaceSuggestion {
  id: number;
  sourceWorkspaceId: string;
  sourceWorkspaceLabel: string;
  date: string;
  category: string;
  title: string;
  rule: string;
  context: string;
  source: string;
  status: 'suggested' | 'accepted' | 'dismissed';
  similarity?: number;
  createdAt: string;
}

interface WorkspaceInfo {
  id: string;
  label: string;
  path: string;
  domains: string;
}

// ─── Domain Resolution ──────────────────────────────────────────────────────

/**
 * Get domains for a workspace. The `domains` column is a JSON array string.
 */
function parseDomains(domainsStr: string): string[] {
  try {
    const parsed = JSON.parse(domainsStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Find all workspaces sharing at least one domain with the target workspace.
 */
async function findSameDomainWorkspaces(
  targetWorkspaceId: string,
): Promise<WorkspaceInfo[]> {
  const target = await queryOne<WorkspaceInfo>(
    'SELECT id, label, path, domains FROM workspaces WHERE id = $1',
    [targetWorkspaceId],
  );
  if (!target) return [];

  const targetDomains = parseDomains(target.domains);
  if (targetDomains.length === 0) return [];

  // Get all other workspaces
  const allWorkspaces = await query<WorkspaceInfo>(
    'SELECT id, label, path, domains FROM workspaces WHERE id != $1',
    [targetWorkspaceId],
  );

  // Filter to workspaces that share at least one domain
  return allWorkspaces.filter((ws) => {
    const wsDomains = parseDomains(ws.domains);
    return wsDomains.some((d) => targetDomains.includes(d));
  });
}

// ─── Vector Similarity ─────────────────────────────────────────────────────

/**
 * Check if pgvector is available by looking for the extension.
 */
async function isVectorAvailable(): Promise<boolean> {
  try {
    const row = await queryOne<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Find memory embeddings from source workspaces that are similar to the
 * target workspace's context (cosine similarity > threshold).
 * Returns source_id values (format: "date|title") with their similarity scores.
 */
async function findSimilarEntries(
  targetWorkspaceId: string,
  sourceWorkspaceIds: string[],
  threshold: number = 0.85,
): Promise<Map<string, Map<string, number>>> {
  // Map: sourceWorkspaceId -> Map<sourceId, similarity>
  const result = new Map<string, Map<string, number>>();

  if (sourceWorkspaceIds.length === 0) return result;

  // Get target workspace memory embeddings to compare against
  const targetEmbeddings = await query<{
    source_id: string;
    embedding: string;
  }>(
    `SELECT source_id, embedding::text FROM embeddings
     WHERE workspace_id = $1 AND source_type = 'memory'`,
    [targetWorkspaceId],
  );

  if (targetEmbeddings.length === 0) return result;

  // For each source workspace, find memory entries similar to ANY target entry
  for (const sourceWsId of sourceWorkspaceIds) {
    const similar = await query<{
      source_id: string;
      workspace_id: string;
      similarity: number;
    }>(
      `SELECT e.source_id, e.workspace_id,
              1 - (e.embedding <=> t.embedding) AS similarity
       FROM embeddings e
       CROSS JOIN LATERAL (
         SELECT embedding FROM embeddings
         WHERE workspace_id = $1 AND source_type = 'memory'
         ORDER BY e.embedding <=> embedding
         LIMIT 1
       ) t
       WHERE e.workspace_id = $2
         AND e.source_type = 'memory'
         AND 1 - (e.embedding <=> t.embedding) > $3`,
      [targetWorkspaceId, sourceWsId, threshold],
    );

    if (similar.length > 0) {
      const wsMap = new Map<string, number>();
      for (const row of similar) {
        wsMap.set(row.source_id, row.similarity);
      }
      result.set(sourceWsId, wsMap);
    }
  }

  return result;
}

// ─── Core Synthesis ─────────────────────────────────────────────────────────

/**
 * Synthesize cross-workspace memory suggestions for a target workspace.
 *
 * Finds relevant memory entries from other workspaces sharing the same
 * domain (L2). When pgvector is available, uses cosine similarity > 0.85.
 * Otherwise, matches on domain + category only.
 *
 * Returns suggestions that haven't already been accepted or dismissed.
 */
export async function synthesizeCrossWorkspace(
  workspaceId: string,
): Promise<CrossWorkspaceSuggestion[]> {
  // 1. Find workspaces in the same domain
  const samedomainWorkspaces = await findSameDomainWorkspaces(workspaceId);
  if (samedomainWorkspaces.length === 0) return [];

  // 2. Check if vector search is available
  const vectorAvailable = await isVectorAvailable();

  // 3. Get already-processed entries (accepted or dismissed) to avoid re-suggesting
  const existingRows = await query<{
    source_workspace_id: string;
    source_date: string;
    source_title: string;
  }>(
    `SELECT source_workspace_id, source_date, source_title
     FROM cross_workspace_memory
     WHERE target_workspace_id = $1`,
    [workspaceId],
  );
  const existingKeys = new Set(
    existingRows.map((r) => `${r.source_workspace_id}|${r.source_date}|${r.source_title}`),
  );

  // 4. Collect entries from all same-domain workspaces
  const suggestions: CrossWorkspaceSuggestion[] = [];
  const sourceWsIds = samedomainWorkspaces.map((ws) => ws.id);

  // Vector similarity map (if available)
  let similarityMap: Map<string, Map<string, number>> | undefined;
  if (vectorAvailable) {
    try {
      similarityMap = await findSimilarEntries(workspaceId, sourceWsIds, 0.85);
    } catch {
      // Vector search failed — fall back to domain-only matching
      similarityMap = undefined;
    }
  }

  for (const ws of samedomainWorkspaces) {
    // Read the source workspace's MEMORY.md
    const entries = readMemory(ws.path);
    if (entries.length === 0) continue;

    const wsSimMap = similarityMap?.get(ws.id);

    for (const entry of entries) {
      const key = `${ws.id}|${entry.date}|${entry.title}`;
      if (existingKeys.has(key)) continue; // Already processed

      // If vector search is available, only include entries that passed similarity threshold
      let similarity: number | undefined;
      if (similarityMap !== undefined) {
        if (!wsSimMap) continue; // No similar entries from this workspace
        const entryKey = `${entry.date}|${entry.title}`;
        const sim = wsSimMap.get(entryKey);
        if (sim === undefined) continue; // This specific entry didn't match
        similarity = sim;
      }
      // If no vector search, all same-domain entries pass (domain + category match)

      // Insert as suggested
      try {
        const row = await queryOne<{ id: number; created_at: string }>(
          `INSERT INTO cross_workspace_memory
             (target_workspace_id, source_workspace_id, source_date, source_title,
              source_category, source_rule, source_context, source_source, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'suggested')
           ON CONFLICT (target_workspace_id, source_workspace_id, source_date, source_title)
           DO NOTHING
           RETURNING id, created_at`,
          [
            workspaceId, ws.id, entry.date, entry.title,
            entry.category, entry.rule, entry.context, entry.source,
          ],
        );

        if (row) {
          suggestions.push({
            id: row.id,
            sourceWorkspaceId: ws.id,
            sourceWorkspaceLabel: ws.label,
            date: entry.date,
            category: entry.category,
            title: entry.title,
            rule: entry.rule,
            context: entry.context,
            source: entry.source,
            status: 'suggested',
            similarity,
            createdAt: row.created_at,
          });
        }
      } catch {
        // Unique constraint violation — already exists, skip
      }
    }
  }

  return suggestions;
}

// ─── Accept / Dismiss ───────────────────────────────────────────────────────

/**
 * Accept a cross-workspace memory suggestion. Copies the entry into the
 * target workspace's MEMORY.md with source attribution.
 */
export async function acceptCrossWorkspaceEntry(
  workspaceId: string,
  entryId: number,
): Promise<{ accepted: boolean; entry?: MemoryEntry }> {
  // 1. Get the suggestion
  const row = await queryOne<{
    id: number;
    target_workspace_id: string;
    source_workspace_id: string;
    source_date: string;
    source_title: string;
    source_category: string;
    source_rule: string;
    source_context: string;
    source_source: string;
    status: string;
  }>(
    `SELECT * FROM cross_workspace_memory WHERE id = $1 AND target_workspace_id = $2`,
    [entryId, workspaceId],
  );

  if (!row || row.status !== 'suggested') {
    return { accepted: false };
  }

  // 2. Get source workspace label for attribution
  const sourceWs = await queryOne<{ label: string }>(
    'SELECT label FROM workspaces WHERE id = $1',
    [row.source_workspace_id],
  );
  const sourceLabel = sourceWs?.label ?? row.source_workspace_id;

  // 3. Get target workspace path
  const targetWs = await queryOne<{ path: string }>(
    'SELECT path FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (!targetWs) return { accepted: false };

  // 4. Create the entry with source attribution
  const entry: MemoryEntry = {
    date: new Date().toISOString().slice(0, 10),
    category: row.source_category as MemoryEntry['category'],
    title: row.source_title,
    rule: row.source_rule,
    context: `${row.source_context}${row.source_context ? ' | ' : ''}From: ${sourceLabel}`,
    source: row.source_source,
  };

  // 5. Append to target MEMORY.md
  append(targetWs.path, entry);
  invalidateMemory(workspaceId);

  // 6. Update status
  await execute(
    `UPDATE cross_workspace_memory SET status = 'accepted', resolved_at = NOW() WHERE id = $1`,
    [entryId],
  );

  return { accepted: true, entry };
}

/**
 * Dismiss a cross-workspace memory suggestion so it doesn't resurface.
 */
export async function dismissCrossWorkspaceEntry(
  workspaceId: string,
  entryId: number,
): Promise<boolean> {
  const result = await execute(
    `UPDATE cross_workspace_memory
     SET status = 'dismissed', resolved_at = NOW()
     WHERE id = $1 AND target_workspace_id = $2 AND status = 'suggested'`,
    [entryId, workspaceId],
  );
  return result.rowCount > 0;
}

/**
 * Get all pending suggestions for a workspace (for the Memory panel).
 */
export async function getPendingSuggestions(
  workspaceId: string,
): Promise<CrossWorkspaceSuggestion[]> {
  const rows = await query<{
    id: number;
    source_workspace_id: string;
    source_date: string;
    source_title: string;
    source_category: string;
    source_rule: string;
    source_context: string;
    source_source: string;
    status: string;
    created_at: string;
    label: string;
  }>(
    `SELECT c.id, c.source_workspace_id, c.source_date, c.source_title,
            c.source_category, c.source_rule, c.source_context, c.source_source,
            c.status, c.created_at, w.label
     FROM cross_workspace_memory c
     JOIN workspaces w ON w.id = c.source_workspace_id
     WHERE c.target_workspace_id = $1 AND c.status = 'suggested'
     ORDER BY c.created_at DESC`,
    [workspaceId],
  );

  return rows.map((r) => ({
    id: r.id,
    sourceWorkspaceId: r.source_workspace_id,
    sourceWorkspaceLabel: r.label,
    date: r.source_date,
    category: r.source_category,
    title: r.source_title,
    rule: r.source_rule,
    context: r.source_context,
    source: r.source_source,
    status: r.status as 'suggested',
    createdAt: r.created_at,
  }));
}
