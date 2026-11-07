/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * memory-dedup.ts — Semantic Memory Deduplication (PR-018)
 *
 * Uses pgvector embedding similarity to detect duplicate memory entries.
 * When duplicates found: keeps the most recent, merges unique details from older entries.
 * Fallback: exact text comparison via Levenshtein distance when vector search unavailable.
 */

import { queryOne } from '../db/index';
import {
  readMemory,
  writeMemory,
  type MemoryEntry,
} from './memory-ledger';
import { prepareText, embedText } from './embedding-pipeline';
import { invalidateMemory } from './context-cache';
import { logger } from './logger';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DedupResult {
  /** Number of duplicate entries removed */
  removed: number;
  /** Number of entries that were merged (kept entry absorbed details from duplicates) */
  merged: number;
  /** Total entries remaining after deduplication */
  total: number;
  /** Details of what was removed/merged */
  details: DedupDetail[];
}

export interface DedupDetail {
  kept: { date: string; title: string };
  removed: Array<{ date: string; title: string }>;
  similarity: number;
}

// ─── Cosine Similarity ──────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Levenshtein Distance ───────────────────────────────────────────────────

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use two-row optimization
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

// ─── Entry Text Representation ──────────────────────────────────────────────

function entryToText(entry: MemoryEntry): string {
  return `[${entry.category}] ${entry.title}: ${entry.rule}`;
}

// ─── Vector-Based Dedup ─────────────────────────────────────────────────────

async function isVectorSearchAvailable(): Promise<boolean> {
  try {
    const result = await queryOne<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS exists`
    );
    return result?.exists ?? false;
  } catch {
    return false;
  }
}

interface EntryWithEmbedding {
  entry: MemoryEntry;
  index: number;
  embedding: number[];
}

async function getOrComputeEmbeddings(
  entries: MemoryEntry[],
  workspaceId: string,
): Promise<EntryWithEmbedding[]> {
  const results: EntryWithEmbedding[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const text = entryToText(entry);
    const sourceId = `memory-${entry.date}-${entry.category.toLowerCase().replace(/\s+/g, '-')}-${entry.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`;

    // Try to get existing embedding from DB
    const existing = await queryOne<{ embedding: string }>(
      `SELECT embedding::text FROM embeddings WHERE workspace_id = $1 AND source_type = 'memory' AND source_id = $2`,
      [workspaceId, sourceId]
    );

    if (existing?.embedding) {
      try {
        const embedding = JSON.parse(existing.embedding) as number[];
        results.push({ entry, index: i, embedding });
        continue;
      } catch {
        // Parse failed, compute fresh
      }
    }

    // Compute embedding
    try {
      const prepared = prepareText('memory', text);
      const embedding = await embedText(prepared);
      results.push({ entry, index: i, embedding });
    } catch (err) {
      logger.warn({ err, title: entry.title }, '[memory-dedup] Failed to compute embedding, skipping entry');
    }
  }

  return results;
}

// ─── Duplicate Group Detection ──────────────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.92;
const LEVENSHTEIN_THRESHOLD_RATIO = 0.15;

interface DuplicateGroup {
  /** Indices of entries in this group (first is the one to keep) */
  indices: number[];
  similarity: number;
}

function findDuplicateGroupsVector(
  entriesWithEmbeddings: EntryWithEmbedding[],
): DuplicateGroup[] {
  const n = entriesWithEmbeddings.length;
  const merged = new Set<number>();
  const groups: DuplicateGroup[] = [];

  for (let i = 0; i < n; i++) {
    if (merged.has(i)) continue;

    const group: number[] = [i];
    let maxSim = 0;

    for (let j = i + 1; j < n; j++) {
      if (merged.has(j)) continue;

      const sim = cosineSimilarity(
        entriesWithEmbeddings[i].embedding,
        entriesWithEmbeddings[j].embedding,
      );

      if (sim >= SIMILARITY_THRESHOLD) {
        group.push(j);
        if (sim > maxSim) maxSim = sim;
      }
    }

    if (group.length > 1) {
      // Sort group: most recent entry first (to keep)
      group.sort((a, b) => {
        const dateA = entriesWithEmbeddings[a].entry.date;
        const dateB = entriesWithEmbeddings[b].entry.date;
        return dateB.localeCompare(dateA); // descending — most recent first
      });

      groups.push({ indices: group, similarity: maxSim });
      for (const idx of group) merged.add(idx);
    }
  }

  return groups;
}

function findDuplicateGroupsLevenshtein(entries: MemoryEntry[]): DuplicateGroup[] {
  const n = entries.length;
  const merged = new Set<number>();
  const groups: DuplicateGroup[] = [];

  for (let i = 0; i < n; i++) {
    if (merged.has(i)) continue;

    const textI = entryToText(entries[i]);
    const group: number[] = [i];
    let maxSim = 0;

    for (let j = i + 1; j < n; j++) {
      if (merged.has(j)) continue;

      const textJ = entryToText(entries[j]);
      const maxLen = Math.max(textI.length, textJ.length);
      if (maxLen === 0) continue;

      const distance = levenshteinDistance(textI, textJ);
      const ratio = distance / maxLen;

      if (ratio < LEVENSHTEIN_THRESHOLD_RATIO) {
        group.push(j);
        const sim = 1 - ratio;
        if (sim > maxSim) maxSim = sim;
      }
    }

    if (group.length > 1) {
      group.sort((a, b) => entries[b].date.localeCompare(entries[a].date));
      groups.push({ indices: group, similarity: maxSim });
      for (const idx of group) merged.add(idx);
    }
  }

  return groups;
}

// ─── Merge Logic ────────────────────────────────────────────────────────────

function mergeEntries(kept: MemoryEntry, duplicates: MemoryEntry[]): MemoryEntry {
  const merged = { ...kept };

  // Collect unique context details from duplicates
  const contextParts = new Set<string>();
  if (kept.context) contextParts.add(kept.context.trim());

  for (const dup of duplicates) {
    if (dup.context && !contextParts.has(dup.context.trim())) {
      contextParts.add(dup.context.trim());
    }

    // If duplicate has a longer/more detailed rule, check if it adds info
    if (dup.rule && dup.rule.length > kept.rule.length && !kept.rule.includes(dup.rule)) {
      // Keep the longer rule if it's substantially longer (>20% more content)
      if (dup.rule.length > kept.rule.length * 1.2) {
        merged.rule = dup.rule;
      }
    }
  }

  // Merge contexts
  const allContexts = Array.from(contextParts);
  if (allContexts.length > 1) {
    merged.context = allContexts.join(' | ');
  }

  // Add merge note to source
  const totalMerged = duplicates.length + 1;
  if (totalMerged > 1) {
    const existingSource = merged.source ? `${merged.source}; ` : '';
    merged.source = `${existingSource}Merged from ${totalMerged} entries`;
  }

  return merged;
}

// ─── Main Dedup Function ────────────────────────────────────────────────────

export async function deduplicateMemory(
  workspacePath: string,
  workspaceId: string,
  dryRun: boolean = false,
): Promise<DedupResult> {
  const entries = readMemory(workspacePath);
  if (entries.length < 2) {
    return { removed: 0, merged: 0, total: entries.length, details: [] };
  }

  let groups: DuplicateGroup[];
  const vectorAvailable = await isVectorSearchAvailable();

  if (vectorAvailable) {
    // Try vector-based dedup
    try {
      const withEmbeddings = await getOrComputeEmbeddings(entries, workspaceId);
      if (withEmbeddings.length >= 2) {
        groups = findDuplicateGroupsVector(withEmbeddings);
      } else {
        // Not enough embeddings — fall back to Levenshtein
        groups = findDuplicateGroupsLevenshtein(entries);
      }
    } catch (err) {
      logger.warn({ err }, '[memory-dedup] Vector dedup failed, falling back to Levenshtein');
      groups = findDuplicateGroupsLevenshtein(entries);
    }
  } else {
    groups = findDuplicateGroupsLevenshtein(entries);
  }

  if (groups.length === 0) {
    return { removed: 0, merged: 0, total: entries.length, details: [] };
  }

  const details: DedupDetail[] = [];
  const indicesToRemove = new Set<number>();
  const mergedEntries = new Map<number, MemoryEntry>(); // index -> merged entry

  for (const group of groups) {
    const keptIndex = group.indices[0];
    const dupIndices = group.indices.slice(1);

    const kept = entries[keptIndex];
    const dups = dupIndices.map(i => entries[i]);

    const merged = mergeEntries(kept, dups);
    mergedEntries.set(keptIndex, merged);

    for (const idx of dupIndices) {
      indicesToRemove.add(idx);
    }

    details.push({
      kept: { date: kept.date, title: kept.title },
      removed: dups.map(d => ({ date: d.date, title: d.title })),
      similarity: group.similarity,
    });
  }

  const removed = indicesToRemove.size;
  const mergedCount = mergedEntries.size;

  if (!dryRun) {
    // Build new entries list
    const newEntries: MemoryEntry[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (indicesToRemove.has(i)) continue;
      if (mergedEntries.has(i)) {
        newEntries.push(mergedEntries.get(i)!);
      } else {
        newEntries.push(entries[i]);
      }
    }

    writeMemory(workspacePath, newEntries);
    invalidateMemory(workspaceId);

    logger.info(
      { removed, merged: mergedCount, total: newEntries.length },
      '[memory-dedup] Deduplication complete',
    );

    return { removed, merged: mergedCount, total: newEntries.length, details };
  }

  return { removed, merged: mergedCount, total: entries.length - removed, details };
}
