/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PG-008: Hybrid Search — Keyword (tsvector) + Semantic (pgvector) with RRF merging
 *
 * hybridSearch() combines full-text keyword search (Postgres tsvector + plainto_tsquery)
 * with semantic vector similarity (pgvector cosine distance) using Reciprocal Rank Fusion.
 *
 * Graceful degradation: if no embeddings exist, falls back to keyword-only search.
 */

import { query, queryOne } from '../db/index';
import { embedText, prepareText, getProvider } from './embedding-pipeline';
import { logger } from './logger';

// ─── Types ──────────────────────────────────────────────────────────────────

export type SourceType = 'spec' | 'story' | 'memory' | 'archive';
export type MatchType = 'keyword' | 'semantic' | 'hybrid';

export interface SearchResult {
  sourceType: SourceType;
  sourceId: string;
  title: string;
  snippet: string;
  score: number;
  matchType: MatchType;
  highlights?: string[];
}

export interface SearchOptions {
  sourceTypes?: SourceType[];
  workspaceId?: number | string;
  limit?: number;
  keywordWeight?: number;
  semanticWeight?: number;
}

export interface SearchMeta {
  keywordHits: number;
  semanticHits: number;
  hybridHits: number;
  latencyMs: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const RRF_K = 60; // Standard RRF constant
const KEYWORD_CANDIDATE_LIMIT = 30;
const SEMANTIC_CANDIDATE_LIMIT = 30;
const COSINE_THRESHOLD = 0.25;
const DEFAULT_LIMIT = 20;

// Track whether we've already warned about missing embeddings
let _noEmbeddingsWarned = false;

// ─── Keyword Search Leg ─────────────────────────────────────────────────────

interface KeywordHit {
  sourceType: SourceType;
  sourceId: string;
  title: string;
  snippet: string;
  rank: number;
  highlights: string[];
}

async function keywordSearch(
  queryText: string,
  sourceTypes: SourceType[],
  workspaceId?: number | string,
): Promise<KeywordHit[]> {
  const hits: KeywordHit[] = [];

  // Search spec_search_index for spec/story/archive source types
  const searchSpecTypes = sourceTypes.filter(t => t === 'spec' || t === 'story' || t === 'archive');
  if (searchSpecTypes.length > 0) {
    const conditions: string[] = ['search_vector @@ plainto_tsquery(\'english\', $1)'];
    const params: unknown[] = [queryText];
    let paramIdx = 2;

    if (workspaceId) {
      conditions.push(`workspace_id = $${paramIdx}`);
      params.push(String(workspaceId));
      paramIdx++;
    }

    const rows = await query<{
      spec_slug: string;
      spec_title: string;
      story_titles: string;
      story_descriptions: string;
      rank: number;
      headline: string;
    }>(
      `SELECT
        spec_slug,
        spec_title,
        story_titles,
        ts_rank_cd(search_vector, plainto_tsquery('english', $1), 32) AS rank,
        ts_headline('english',
          COALESCE(spec_title, '') || ' ' || COALESCE(story_titles, '') || ' ' || COALESCE(story_descriptions, ''),
          plainto_tsquery('english', $1),
          'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15'
        ) AS headline
      FROM spec_search_index
      WHERE ${conditions.join(' AND ')}
      ORDER BY rank DESC
      LIMIT ${KEYWORD_CANDIDATE_LIMIT}`,
      params,
    );

    for (const row of rows) {
      // Determine if this is a spec or story/archive hit based on sourceTypes requested
      const sourceType: SourceType = searchSpecTypes.includes('archive') ? 'archive' : 'spec';
      const highlights = extractHighlights(row.headline);
      hits.push({
        sourceType,
        sourceId: row.spec_slug,
        title: row.spec_title || row.spec_slug,
        snippet: row.headline,
        rank: row.rank,
        highlights,
      });
    }
  }

  // Search memory entries directly from the memories table using tsvector
  if (sourceTypes.includes('memory')) {
    const memParams: unknown[] = [queryText];
    let memParamIdx = 2;

    const memConditions: string[] = [
      'deleted_at IS NULL',
      `tsv @@ plainto_tsquery('english', $1)`,
    ];

    if (workspaceId) {
      memConditions.push(`workspace_id = $${memParamIdx}`);
      memParams.push(String(workspaceId));
      memParamIdx++;
    }

    const memRows = await query<{
      source_id: string;
      title: string;
      snippet: string;
      rank: number;
    }>(
      `SELECT
        id::text AS source_id,
        category AS title,
        ts_headline('english', content, plainto_tsquery('english', $1),
          'StartSel=<mark>, StopSel=</mark>, MaxWords=35, MinWords=15'
        ) AS snippet,
        ts_rank_cd(tsv, plainto_tsquery('english', $1)) AS rank
      FROM memories
      WHERE ${memConditions.join(' AND ')}
      ORDER BY rank DESC
      LIMIT ${KEYWORD_CANDIDATE_LIMIT}`,
      memParams,
    );

    for (const row of memRows) {
      const highlights = extractHighlights(row.snippet);
      hits.push({
        sourceType: 'memory',
        sourceId: row.source_id,
        title: row.title || 'Memory Entry',
        snippet: row.snippet,
        rank: row.rank,
        highlights,
      });
    }
  }

  return hits;
}

// ─── Semantic Search Leg ────────────────────────────────────────────────────

interface SemanticHit {
  sourceType: SourceType;
  sourceId: string;
  similarity: number;
}

async function semanticSearch(
  queryText: string,
  sourceTypes: SourceType[],
  workspaceId?: number | string,
): Promise<SemanticHit[]> {
  // Check if embeddings table has any rows
  let embeddingCount = 0;
  try {
    const countRow = await queryOne<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM embeddings');
    embeddingCount = parseInt(countRow?.cnt || '0', 10);
  } catch (err: any) {
    // 42P01 = relation does not exist (pgvector extension not installed or embeddings table missing)
    if (err.code === '42P01') {
      if (!_noEmbeddingsWarned) {
        logger.warn('[Search] embeddings table not found — falling back to keyword-only search');
        _noEmbeddingsWarned = true;
      }
      return [];
    }
    throw err;
  }

  if (embeddingCount === 0) {
    if (!_noEmbeddingsWarned) {
      logger.warn('[Search] No embeddings found — search using keywords only. Run POST /api/admin/embed-all to enable semantic search');
      _noEmbeddingsWarned = true;
    }
    return [];
  }

  // Embed the query text
  let queryEmbedding: number[];
  try {
    const prepared = prepareText('query', queryText);
    queryEmbedding = await embedText(prepared);
  } catch (err) {
    logger.warn({ err }, '[Search] Failed to embed query — falling back to keyword-only');
    return [];
  }

  const vectorStr = `[${queryEmbedding.join(',')}]`;

  // Build source type filter
  const conditions: string[] = [];
  const params: unknown[] = [vectorStr];
  let paramIdx = 2;

  if (sourceTypes.length > 0) {
    const placeholders = sourceTypes.map((_, i) => `$${paramIdx + i}`);
    conditions.push(`source_type IN (${placeholders.join(', ')})`);
    params.push(...sourceTypes);
    paramIdx += sourceTypes.length;
  }

  if (workspaceId) {
    conditions.push(`workspace_id = $${paramIdx}`);
    params.push(String(workspaceId));
    paramIdx++;
  }

  // Cosine similarity: 1 - cosine_distance. Filter by threshold.
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await query<{
    source_type: SourceType;
    source_id: string;
    similarity: number;
  }>(
    `SELECT
      source_type,
      source_id,
      1 - (embedding <=> $1::vector) AS similarity
    FROM embeddings
    ${whereClause}
    ORDER BY embedding <=> $1::vector ASC
    LIMIT ${SEMANTIC_CANDIDATE_LIMIT}`,
    params,
  );

  // Check for mixed embedding models
  if (rows.length > 0) {
    const queryModel = getProvider().model;
    const storedModelRow = await queryOne<{ model: string }>(
      `SELECT DISTINCT model FROM embeddings LIMIT 1`
    );
    if (storedModelRow && storedModelRow.model !== queryModel) {
      logger.warn(
        '[search] Mixed embedding models detected (query: %s, stored: %s). Results may be degraded. Run POST /api/admin/embed-all to re-embed with current provider.',
        queryModel, storedModelRow.model,
      );
    }
  }

  // Filter by cosine threshold
  return rows
    .filter(r => r.similarity >= COSINE_THRESHOLD)
    .map(r => ({
      sourceType: r.source_type,
      sourceId: r.source_id,
      similarity: r.similarity,
    }));
}

// ─── Reciprocal Rank Fusion ─────────────────────────────────────────────────

interface RRFCandidate {
  sourceType: SourceType;
  sourceId: string;
  title: string;
  snippet: string;
  rrfScore: number;
  matchType: MatchType;
  highlights: string[];
  keywordRank?: number;
  semanticRank?: number;
}

function mergeWithRRF(
  keywordHits: KeywordHit[],
  semanticHits: SemanticHit[],
  keywordWeight: number,
  semanticWeight: number,
): RRFCandidate[] {
  const candidateMap = new Map<string, RRFCandidate>();

  // Build key: sourceType:sourceId
  const makeKey = (type: string, id: string) => `${type}:${id}`;

  // Score keyword hits by rank position
  for (let i = 0; i < keywordHits.length; i++) {
    const hit = keywordHits[i];
    const key = makeKey(hit.sourceType, hit.sourceId);
    const rrfContrib = keywordWeight / (RRF_K + (i + 1));

    const existing = candidateMap.get(key);
    if (existing) {
      existing.rrfScore += rrfContrib;
      existing.matchType = 'hybrid';
      existing.keywordRank = i + 1;
    } else {
      candidateMap.set(key, {
        sourceType: hit.sourceType,
        sourceId: hit.sourceId,
        title: hit.title,
        snippet: hit.snippet,
        rrfScore: rrfContrib,
        matchType: 'keyword',
        highlights: hit.highlights,
        keywordRank: i + 1,
      });
    }
  }

  // Score semantic hits by rank position
  for (let i = 0; i < semanticHits.length; i++) {
    const hit = semanticHits[i];
    const key = makeKey(hit.sourceType, hit.sourceId);
    const rrfContrib = semanticWeight / (RRF_K + (i + 1));

    const existing = candidateMap.get(key);
    if (existing) {
      existing.rrfScore += rrfContrib;
      existing.matchType = 'hybrid';
      existing.semanticRank = i + 1;
    } else {
      candidateMap.set(key, {
        sourceType: hit.sourceType,
        sourceId: hit.sourceId,
        title: `[${hit.sourceType}] ${hit.sourceId}`,
        snippet: '',
        rrfScore: rrfContrib,
        matchType: 'semantic',
        highlights: [],
        semanticRank: i + 1,
      });
    }
  }

  // Sort by RRF score descending
  return Array.from(candidateMap.values()).sort((a, b) => b.rrfScore - a.rrfScore);
}

// ─── Enrich Semantic-Only Hits ──────────────────────────────────────────────

async function enrichSemanticHits(candidates: RRFCandidate[]): Promise<void> {
  // Semantic-only hits lack title/snippet — fetch from source tables
  const needsEnrichment = candidates.filter(c => c.matchType === 'semantic' && !c.title.includes(c.sourceId));

  for (const candidate of needsEnrichment) {
    if (candidate.sourceType === 'spec' || candidate.sourceType === 'archive') {
      const row = await queryOne<{ spec_title: string }>(
        'SELECT spec_title FROM spec_search_index WHERE spec_slug = $1 LIMIT 1',
        [candidate.sourceId],
      );
      if (row) {
        candidate.title = row.spec_title || candidate.sourceId;
      }
    }
    // Stories/memory — title from sourceId is acceptable for now
  }
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

export async function hybridSearch(
  queryText: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const {
    sourceTypes = ['spec', 'story', 'memory', 'archive'],
    workspaceId,
    limit = DEFAULT_LIMIT,
    keywordWeight = 1.0,
    semanticWeight = 1.0,
  } = options;

  const runKeyword = keywordWeight > 0;
  const runSemantic = semanticWeight > 0;

  // Run only the enabled search legs.
  const [keywordHits, semanticHits] = await Promise.all([
    runKeyword ? keywordSearch(queryText, sourceTypes, workspaceId) : Promise.resolve([]),
    runSemantic ? semanticSearch(queryText, sourceTypes, workspaceId) : Promise.resolve([]),
  ]);

  // If only keyword search is enabled, return keyword results directly.
  if (runKeyword && !runSemantic) {
    return keywordHits.slice(0, limit).map(hit => ({
      sourceType: hit.sourceType,
      sourceId: hit.sourceId,
      title: hit.title,
      snippet: hit.snippet,
      score: hit.rank,
      matchType: 'keyword' as MatchType,
      highlights: hit.highlights,
    }));
  }

  // If only semantic search is enabled, return semantic results directly.
  if (runSemantic && !runKeyword) {
    const results: SearchResult[] = [];
    for (const hit of semanticHits.slice(0, limit)) {
      let title = `[${hit.sourceType}] ${hit.sourceId}`;
      const row = await queryOne<{ spec_title: string }>(
        'SELECT spec_title FROM spec_search_index WHERE spec_slug = $1 LIMIT 1',
        [hit.sourceId],
      );
      if (row?.spec_title) title = row.spec_title;

      results.push({
        sourceType: hit.sourceType,
        sourceId: hit.sourceId,
        title,
        snippet: '',
        score: hit.similarity,
        matchType: 'semantic',
      });
    }
    return results;
  }

  // If no semantic hits, return keyword results directly (no RRF needed)
  if (semanticHits.length === 0) {
    return keywordHits.slice(0, limit).map(hit => ({
      sourceType: hit.sourceType,
      sourceId: hit.sourceId,
      title: hit.title,
      snippet: hit.snippet,
      score: hit.rank,
      matchType: 'keyword' as MatchType,
      highlights: hit.highlights,
    }));
  }

  // If no keyword hits, return semantic results directly
  if (keywordHits.length === 0) {
    const results: SearchResult[] = [];
    for (const hit of semanticHits.slice(0, limit)) {
      let title = `[${hit.sourceType}] ${hit.sourceId}`;
      const row = await queryOne<{ spec_title: string }>(
        'SELECT spec_title FROM spec_search_index WHERE spec_slug = $1 LIMIT 1',
        [hit.sourceId],
      );
      if (row?.spec_title) title = row.spec_title;

      results.push({
        sourceType: hit.sourceType,
        sourceId: hit.sourceId,
        title,
        snippet: '',
        score: hit.similarity,
        matchType: 'semantic',
      });
    }
    return results;
  }

  // Merge with RRF
  const merged = mergeWithRRF(keywordHits, semanticHits, keywordWeight, semanticWeight);

  // Enrich semantic-only results with titles
  await enrichSemanticHits(merged);

  // Truncate to limit
  return merged.slice(0, limit).map(c => ({
    sourceType: c.sourceType,
    sourceId: c.sourceId,
    title: c.title,
    snippet: c.snippet,
    score: c.rrfScore,
    matchType: c.matchType,
    highlights: c.highlights.length > 0 ? c.highlights : undefined,
  }));
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractHighlights(headline: string): string[] {
  const matches: string[] = [];
  const regex = /<mark>(.*?)<\/mark>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(headline)) !== null) {
    const term = match[1].trim();
    if (term && !matches.includes(term)) {
      matches.push(term);
    }
  }
  return matches;
}

function generateMemorySnippet(text: string, queryText: string): string {
  const lowerText = text.toLowerCase();
  const lowerQuery = queryText.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);

  if (idx === -1) {
    return text.slice(0, 150);
  }

  const start = Math.max(0, idx - 50);
  const end = Math.min(text.length, idx + queryText.length + 100);
  let snippet = text.slice(start, end);

  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';

  return snippet;
}
