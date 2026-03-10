import { query, queryOne } from '../db/index';
import { hybridSearch, type SearchResult } from './search';
import { logger } from './logger';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SynthesizeParams {
  l1?: string;           // Global Brain YAML
  l2?: string;           // Domain Profile YAML
  l3?: string;           // Project Brief YAML
  specBrief: string;     // L4 — always required
  storyAnnotations?: string; // L5 — optional per-story overrides
  // Team-scoped layers (override global, overridden by workspace)
  teamL1?: string;       // Team-level L1 override
  teamL2?: string;       // Team-level L2 override
  // Auto-injected by hydration engine:
  schemaSnapshot?: string;  // Raw CREATE TABLE blocks
  gitMemory?: string;       // Synthesized memory.yaml
}

export interface SynthesizeMeta {
  standards: boolean;
  conventions: boolean;
  project: boolean;
  memory: boolean;
  schema: boolean;
  totalTokens: number;
}

export interface SynthesizeResult {
  text: string;
  meta: SynthesizeMeta;
}

/** PG-012: ContextMetadata returned by semantic-aware synthesize() */
export interface ContextMetadata {
  totalTokens: number;
  layers: {
    standards: boolean;
    conventions: boolean;
    project: boolean;
  };
  memoryEntries: {
    included: number;
    total: number;
    relevanceRange: [number, number];
  };
  droppedItems: Array<{ type: string; reason: string }>;
  searchMode: 'semantic' | 'keyword' | 'full-dump';
}

/** PG-012: Return type from semantic-aware synthesize() */
export interface SynthesizedContext {
  text: string;
  metadata: ContextMetadata;
}

/** Options for PG-012 semantic-aware synthesis */
export interface SynthesizeOptions {
  storyText?: string;
  maxTokens?: number;
}

// ─── Token Estimation ────────────────────────────────────────────────────────

/** Estimate tokens from text length (~4 chars per token). Consistent with context-router.ts. */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ─── Legacy Sync Functions ───────────────────────────────────────────────────

/**
 * Synchronous direction stack synthesis from pre-fetched layers.
 * Returns the synthesized text string directly.
 */
export function synthesizeLayers(params: SynthesizeParams): string {
  return synthesizeLayersWithMeta(params).text;
}

/**
 * Synchronous direction stack synthesis with metadata.
 * Returns { text, meta } from pre-fetched layer content.
 */
export function synthesizeLayersWithMeta(params: SynthesizeParams): SynthesizeResult {
  const sections: string[] = [];
  const effectiveL1 = params.teamL1?.trim() || params.l1?.trim();
  const effectiveL2 = params.teamL2?.trim() || params.l2?.trim();
  if (effectiveL1) sections.push(`=== GLOBAL STANDARDS (L1) ===\n${effectiveL1}`);
  if (effectiveL2) sections.push(`=== DOMAIN PROFILE (L2) ===\n${effectiveL2}`);
  if (params.l3?.trim()) sections.push(`=== PROJECT CONTEXT (L3) ===\n${params.l3.trim()}`);
  if (params.schemaSnapshot?.trim()) {
    sections.push(`=== DATABASE SCHEMA (Auto-Hydrated) ===\n${params.schemaSnapshot.trim()}`);
  }
  if (params.gitMemory?.trim()) {
    sections.push(`=== PROJECT MEMORY (Git History) ===\n${params.gitMemory.trim()}`);
  }
  sections.push(`=== SPEC BRIEF (L4) ===\n${params.specBrief.trim()}`);
  if (params.storyAnnotations?.trim()) sections.push(`=== STORY ANNOTATIONS (L5) ===\n${params.storyAnnotations.trim()}`);

  const text = sections.join('\n\n');
  const totalTokens = Math.ceil(text.length / 4);

  return {
    text,
    meta: {
      standards: !!effectiveL1,
      conventions: !!effectiveL2,
      project: !!params.l3?.trim(),
      memory: !!params.gitMemory?.trim(),
      schema: !!params.schemaSnapshot?.trim(),
      totalTokens,
    },
  };
}

// Backward-compatible aliases
export const synthesize = synthesizeLayers;
export const synthesizeWithMeta = synthesizeLayersWithMeta;

// ─── PG-012: Semantic-Aware Synthesis ────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 32000;
const SEMANTIC_RELEVANCE_THRESHOLD = 0.3;
const RECENCY_LIMIT = 20;
const SEMANTIC_MEMORY_LIMIT = 15;

/**
 * Fetch direction layers from DB for a workspace.
 * Returns the raw layer content ready for assembly.
 */
async function fetchDirectionLayers(workspaceId: string): Promise<{
  l1?: string;
  l2?: string;
  l3?: string;
  teamL1?: string;
  teamL2?: string;
  schemaSnapshot?: string;
  gitMemory?: string;
}> {
  // L1: global standards
  const l1Row = await queryOne<{ content_yaml: string }>(
    `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
  );

  // Get workspace domain
  const wsRow = await queryOne<{ domain: string | null }>(
    'SELECT domain FROM workspaces WHERE id = $1',
    [workspaceId]
  );
  const domain = wsRow?.domain;

  // L2: domain conventions
  const l2Row = domain
    ? await queryOne<{ content_yaml: string }>(
        `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND domain = $1 AND COALESCE(workspace_id, '') = ''`,
        [domain]
      )
    : undefined;

  // L3: project context
  const l3Row = await queryOne<{ content_yaml: string }>(
    `SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain, '') = ''`,
    [workspaceId]
  );

  // Auto-hydrated context
  const ctx = await queryOne<{ schema_snapshot: string | null; git_memory: string | null }>(
    `SELECT schema_snapshot, git_memory FROM workspace_context WHERE workspace_id = $1`,
    [workspaceId]
  );

  // Team layers
  const access = await queryOne<{ team_id: string }>(
    'SELECT team_id FROM workspace_access WHERE workspace_id = $1 LIMIT 1',
    [workspaceId]
  );

  let teamL1: string | undefined;
  let teamL2: string | undefined;
  if (access) {
    const tl1 = await queryOne<{ content_yaml: string }>(
      `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND team_id = $1 AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = ''`,
      [access.team_id]
    );
    const tl2 = await queryOne<{ content_yaml: string }>(
      `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND team_id = $1 AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = ''`,
      [access.team_id]
    );
    teamL1 = tl1?.content_yaml;
    teamL2 = tl2?.content_yaml;
  }

  return {
    l1: l1Row?.content_yaml,
    l2: l2Row?.content_yaml,
    l3: l3Row?.content_yaml,
    teamL1,
    teamL2,
    schemaSnapshot: ctx?.schema_snapshot || undefined,
    gitMemory: ctx?.git_memory || undefined,
  };
}

/**
 * Fetch memory entries using semantic search when storyText is provided,
 * or recency-based fallback otherwise.
 */
async function fetchMemoryEntries(
  workspaceId: string,
  storyText?: string,
): Promise<{
  entries: Array<{ text: string; score: number }>;
  total: number;
  searchMode: 'semantic' | 'keyword' | 'full-dump';
}> {
  // Check if embeddings exist for fallback detection
  const countRow = await queryOne<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM embeddings');
  const embeddingCount = parseInt(countRow?.cnt || '0', 10);

  // Get total memory entry count from wal_events
  const totalRow = await queryOne<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM wal_events WHERE event_type IN ('memory_created', 'memory_updated') AND workspace_id = $1`,
    [workspaceId],
  );
  const total = parseInt(totalRow?.cnt || '0', 10);

  if (total === 0) {
    return { entries: [], total: 0, searchMode: 'full-dump' };
  }

  // No embeddings → full-dump mode with recency limit
  if (embeddingCount === 0) {
    logger.warn('[direction-stack] No embeddings configured — using full memory dump with token budget cap');

    const rows = await query<{ payload: string }>(
      `SELECT payload FROM wal_events
       WHERE event_type IN ('memory_created', 'memory_updated') AND workspace_id = $1
       ORDER BY ts DESC LIMIT $2`,
      [workspaceId, RECENCY_LIMIT],
    );

    const entries = rows.map(r => {
      try {
        const p = JSON.parse(r.payload || '{}');
        return { text: p.text || p.content || p.rule || '', score: 0 };
      } catch {
        return { text: '', score: 0 };
      }
    }).filter(e => e.text.length > 0);

    return { entries, total, searchMode: 'full-dump' };
  }

  // With storyText: use hybrid search for semantic relevance
  if (storyText) {
    const results: SearchResult[] = await hybridSearch(storyText, {
      sourceTypes: ['memory'],
      workspaceId,
      limit: SEMANTIC_MEMORY_LIMIT,
    });

    // Filter by relevance threshold
    const filtered = results.filter(r => r.score > SEMANTIC_RELEVANCE_THRESHOLD);

    const entries = filtered.map(r => ({
      text: r.snippet || r.title,
      score: r.score,
    }));

    return {
      entries,
      total,
      searchMode: results.some(r => r.matchType === 'semantic' || r.matchType === 'hybrid') ? 'semantic' : 'keyword',
    };
  }

  // No storyText: recency-based selection
  const rows = await query<{ payload: string }>(
    `SELECT payload FROM wal_events
     WHERE event_type IN ('memory_created', 'memory_updated') AND workspace_id = $1
     ORDER BY ts DESC LIMIT $2`,
    [workspaceId, RECENCY_LIMIT],
  );

  const entries = rows.map(r => {
    try {
      const p = JSON.parse(r.payload || '{}');
      return { text: p.text || p.content || p.rule || '', score: 0 };
    } catch {
      return { text: '', score: 0 };
    }
  }).filter(e => e.text.length > 0);

  return { entries, total, searchMode: 'full-dump' };
}

/**
 * PG-012: Semantic-aware direction stack synthesis.
 *
 * Fetches direction layers from DB, uses hybrid search for relevant memory entries,
 * and enforces a token budget on the assembled context.
 *
 * Priority order: (1) Direction layers — NEVER dropped.
 * (2) Memory entries — sorted by relevance, included until budget exhausted.
 * (3) Schema/Git context — included if budget allows.
 */
export async function synthesizeDirectionStack(
  workspaceId: string,
  options?: SynthesizeOptions,
): Promise<SynthesizedContext> {
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const storyText = options?.storyText;
  const droppedItems: Array<{ type: string; reason: string }> = [];

  // 1. Fetch direction layers (always included)
  const layers = await fetchDirectionLayers(workspaceId);

  // 2. Build direction layer sections (NEVER dropped)
  const directionSections: string[] = [];
  const effectiveL1 = layers.teamL1?.trim() || layers.l1?.trim();
  const effectiveL2 = layers.teamL2?.trim() || layers.l2?.trim();

  if (effectiveL1) directionSections.push(`=== GLOBAL STANDARDS (L1) ===\n${effectiveL1}`);
  if (effectiveL2) directionSections.push(`=== DOMAIN PROFILE (L2) ===\n${effectiveL2}`);
  if (layers.l3?.trim()) directionSections.push(`=== PROJECT CONTEXT (L3) ===\n${layers.l3.trim()}`);

  const directionText = directionSections.join('\n\n');
  let usedTokens = estimateTokens(directionText);

  // 3. Fetch memory entries (semantic or recency-based)
  const memoryResult = await fetchMemoryEntries(workspaceId, storyText);
  const includedMemory: Array<{ text: string; score: number }> = [];

  for (const entry of memoryResult.entries) {
    const entryTokens = estimateTokens(entry.text);
    if (usedTokens + entryTokens <= maxTokens) {
      includedMemory.push(entry);
      usedTokens += entryTokens;
    } else {
      droppedItems.push({ type: 'memory_entry', reason: 'token_budget_exceeded' });
    }
  }

  // Track entries dropped by relevance threshold (only for semantic mode)
  if (storyText && memoryResult.searchMode !== 'full-dump') {
    const droppedByRelevance = memoryResult.total - memoryResult.entries.length;
    if (droppedByRelevance > 0) {
      droppedItems.push({
        type: `memory_entries(${droppedByRelevance})`,
        reason: 'below_relevance_threshold',
      });
    }
  }

  // 4. Include schema snapshot if budget allows
  let schemaIncluded = false;
  if (layers.schemaSnapshot?.trim()) {
    const schemaTokens = estimateTokens(layers.schemaSnapshot);
    if (usedTokens + schemaTokens <= maxTokens) {
      schemaIncluded = true;
      usedTokens += schemaTokens;
    } else {
      droppedItems.push({ type: 'schema_snapshot', reason: 'token_budget_exceeded' });
    }
  }

  // 5. Include git memory if budget allows
  let gitMemoryIncluded = false;
  if (layers.gitMemory?.trim()) {
    const gitTokens = estimateTokens(layers.gitMemory);
    if (usedTokens + gitTokens <= maxTokens) {
      gitMemoryIncluded = true;
      usedTokens += gitTokens;
    } else {
      droppedItems.push({ type: 'git_memory', reason: 'token_budget_exceeded' });
    }
  }

  // 6. Assemble final text
  const sections: string[] = [];

  // Direction layers (always first)
  if (directionText) sections.push(directionText);

  // Schema snapshot
  if (schemaIncluded && layers.schemaSnapshot?.trim()) {
    sections.push(`=== DATABASE SCHEMA (Auto-Hydrated) ===\n${layers.schemaSnapshot.trim()}`);
  }

  // Git memory (hydrated)
  if (gitMemoryIncluded && layers.gitMemory?.trim()) {
    sections.push(`=== PROJECT MEMORY (Git History) ===\n${layers.gitMemory.trim()}`);
  }

  // Semantic memory entries
  if (includedMemory.length > 0) {
    const memoryLines = includedMemory.map(m => `- ${m.text}`).join('\n');
    sections.push(`=== RELEVANT MEMORY (${memoryResult.searchMode}) ===\n${memoryLines}`);
  }

  const text = sections.join('\n\n');
  const finalTokens = estimateTokens(text);

  // Compute relevance range
  const scores = includedMemory.map(m => m.score).filter(s => s > 0);
  const relevanceRange: [number, number] = scores.length > 0
    ? [Math.min(...scores), Math.max(...scores)]
    : [0, 0];

  return {
    text,
    metadata: {
      totalTokens: finalTokens,
      layers: {
        standards: !!effectiveL1,
        conventions: !!effectiveL2,
        project: !!layers.l3?.trim(),
      },
      memoryEntries: {
        included: includedMemory.length,
        total: memoryResult.total,
        relevanceRange,
      },
      droppedItems,
      searchMode: memoryResult.searchMode,
    },
  };
}
