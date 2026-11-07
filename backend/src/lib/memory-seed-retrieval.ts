/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-014 — Memory & prior-spec seed retrieval (Context Intelligence Platform)
 *
 * Second of the three retrieval signals (design doc §2.2 "Retrieval / Ranking"):
 * blends durable Rorca memories and prior specs/stories into a bounded set of
 * *seed* candidates that later feed graph expansion (US-015) and the explainable
 * ranker (US-016).
 *
 * Lives in its own file (`memory-seed-retrieval.ts`) rather than the generic
 * `seed-retrieval.ts` owned by the sibling Wave-2 story US-013 (brief→file/doc
 * seeds), so the two parallel worktrees compose at merge instead of colliding.
 *
 * Invariants this module enforces (so callers cannot accidentally violate them):
 *
 *  1. **Governance gate (design doc §2.5 / US-035), on by default.** Captured
 *     knowledge enters Rorca as a reviewable `memory_candidate`, never as durable
 *     memory. Pending / rejected / duplicate / superseded / revisit candidates
 *     MUST NEVER seed retrieval. Only durable memories (already promoted through
 *     the existing memory path) seed by default. `includeApprovedCandidates`
 *     relaxes the gate to also surface `approved` candidates (e.g. for an
 *     inspector preview), and nothing else.
 *
 *  2. **No memory dumps.** Memory and spec contributions are EACH capped by both
 *     a count limit and a token budget. Whatever is dropped is reported in
 *     `meta` so the UX can be honest about truncation rather than silently
 *     hiding it.
 *
 *  3. **Explainable memory seeds.** Every memory seed carries
 *     category / title / confidence / trust / reason, matching the retrieval
 *     candidate contract (shared/contracts/retrieval.ts).
 *
 * Data is queried through the same `memories` / `memory_candidates` tables and
 * `forge/specs/{approved,pending}` layout the rest of the backend already uses
 * (memory-router.ts, memory-graph.ts), so this story adds no new source of truth.
 *
 * NOTE ON TRUST VOCABULARY: the CIP retrieval contract (shared/contracts/trust.ts)
 * uses the tiers below. The US-004 `memory_candidates` table predates that
 * contract and stores a different vocabulary
 * (`authoritative|trusted|community|unverified`); `mapCandidateTrust()` bridges
 * the two. Backend consumes the shared contracts only as a built artifact, which
 * is not wired in yet, so the tiers are mirrored locally on purpose.
 */

import * as fs from 'fs';
import * as path from 'path';

import { estimateTokens } from './context-router';
import { query } from '../db/index';
import { logger } from './logger';

// ─── Trust tiers (mirror of shared/contracts/trust.ts) ────────────────────────

/** Ordered most → least authoritative; mirror of the CIP trust contract. */
export const SEED_TRUST_TIERS = ['authoritative', 'reviewed', 'derived', 'captured', 'unverified'] as const;
export type SeedTrustTier = (typeof SEED_TRUST_TIERS)[number];

/** Normalized authority weight per tier (higher = more trusted). */
export const SEED_TRUST_WEIGHT: Record<SeedTrustTier, number> = {
  authoritative: 1.0,
  reviewed: 0.8,
  derived: 0.6,
  captured: 0.3,
  unverified: 0.1,
};

/** review_status values as stored by US-004 `memory_candidates` (includes `revisit`). */
export const CANDIDATE_REVIEW_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'duplicate',
  'superseded',
  'revisit',
] as const;
export type CandidateReviewStatus = (typeof CANDIDATE_REVIEW_STATUSES)[number];

// ─── Input records (DB-agnostic so the core stays pure & unit-testable) ───────

/** Subset of a `memories` table row needed to build a durable-memory seed. */
export interface DurableMemoryRecord {
  id: string | number;
  category: string | null;
  content: string;
  /** 'high' | 'medium' | 'low' | a numeric string | null. */
  confidence: string | number | null;
  sourceType?: string | null;
  source?: string | null;
  pinned?: boolean;
  relatedFiles?: string[];
  sourceStoryId?: string | null;
  sourceSpecId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** Subset of a `memory_candidates` row needed to apply the governance gate. */
export interface MemoryCandidateRecord {
  id: string | number;
  reviewStatus: CandidateReviewStatus | string;
  category?: string | null;
  title: string;
  /** The candidate body / actionable rule. */
  rule: string;
  context?: string | null;
  confidence?: string | number | null;
  /** US-004 DB trust vocabulary (authoritative|trusted|community|unverified). */
  trustTier?: string | null;
  promotedMemoryId?: string | number | null;
  relatedFiles?: string[];
  createdAt?: string | null;
}

/** A prior spec + its stories, as read from `forge/specs/{approved,pending}`. */
export interface PriorSpecRecord {
  specId: string;
  title: string;
  /** Disk location: 'approved' or 'pending'. */
  status: string;
  stories: Array<{ id: string; title?: string }>;
}

/** All inputs the pure selector needs. */
export interface SeedRetrievalInputs {
  durableMemories: DurableMemoryRecord[];
  memoryCandidates: MemoryCandidateRecord[];
  priorSpecs: PriorSpecRecord[];
}

// ─── Output seeds ─────────────────────────────────────────────────────────────

/** An explainable memory seed (durable memory or, if opted in, approved candidate). */
export interface MemorySeed {
  id: string;
  kind: 'memory';
  /** Reference to the underlying datum (memory id, or `candidate:<id>`). */
  ref: string;
  category: string;
  title: string;
  /** Normalized confidence in [0, 1]. */
  confidence: number;
  trust: SeedTrustTier;
  /** Human-readable explanation of why this seed was selected. */
  reason: string;
  /** Normalized relevance score in [0, 1]. */
  score: number;
  tokenEstimate: number;
  /** The text used for budgeting (memory content / candidate rule). */
  text: string;
}

/** A prior-spec / prior-story seed. */
export interface SpecSeed {
  /** `specId` for a spec seed, `specId#storyId` for a story seed. */
  id: string;
  kind: 'spec' | 'story';
  ref: string;
  specId: string;
  storyId?: string;
  title: string;
  /** Spec disk status ('approved' | 'pending'). */
  status: string;
  trust: SeedTrustTier;
  reason: string;
  score: number;
  tokenEstimate: number;
}

export interface SeedRetrievalOptions {
  /** Brief / story text the seeds should be relevant to (drives lexical scoring). */
  brief?: string;
  /** Max number of memory seeds (count cap). Default 8. */
  maxMemorySeeds?: number;
  /** Max number of spec seeds (count cap). Default 6. */
  maxSpecSeeds?: number;
  /** Combined token budget for the seed contribution. Default 4000. */
  tokenBudget?: number;
  /** Fraction of `tokenBudget` reserved for memory seeds (rest goes to specs). Default 0.65. */
  memoryBudgetRatio?: number;
  /**
   * Relax the governance gate to ALSO surface `approved` (but not-yet-promoted)
   * candidates. Pending/rejected/duplicate/superseded/revisit are still excluded.
   * Default false — the full gate.
   */
  includeApprovedCandidates?: boolean;
  /** Include specs whose disk status is not `approved` (i.e. pending/draft). Default false. */
  includeUnapprovedSpecs?: boolean;
}

export interface SeedRetrievalMeta {
  memoryCandidatesConsidered: number;
  /** Candidates the governance gate excluded (everything not surfaced as a seed). */
  memoryCandidatesExcludedByGovernance: number;
  /** Distinct review statuses that were excluded, for honest UX. */
  excludedReviewStatuses: string[];
  specsConsidered: number;
  specsExcludedByStatus: number;
  memorySeedsDroppedByCount: number;
  memorySeedsDroppedByBudget: number;
  specSeedsDroppedByCount: number;
  specSeedsDroppedByBudget: number;
  memoryTokensUsed: number;
  specTokensUsed: number;
  tokenBudget: number;
}

export interface SeedRetrievalResult {
  memorySeeds: MemorySeed[];
  specSeeds: SpecSeed[];
  meta: SeedRetrievalMeta;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_MEMORY_SEEDS = 8;
const DEFAULT_MAX_SPEC_SEEDS = 6;
const DEFAULT_TOKEN_BUDGET = 4000;
const DEFAULT_MEMORY_BUDGET_RATIO = 0.65;

/** How many rows the DB wrappers pull before the bounded selector trims them. */
const MEMORY_FETCH_LIMIT = 250;
const CANDIDATE_FETCH_LIMIT = 250;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has', 'have',
  'with', 'that', 'this', 'from', 'into', 'will', 'when', 'what', 'which', 'their',
  'them', 'then', 'they', 'would', 'about', 'could', 'should', 'must', 'where',
  'also', 'such', 'than', 'over', 'using', 'used', 'add', 'new',
]);

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Normalize a confidence value to [0, 1]. Accepts the `memories` text enum
 * ('high' | 'medium' | 'low'), a numeric value already in range, a numeric
 * string, or null. Unknown values fall back to a neutral 0.5.
 */
export function normalizeConfidence(value: string | number | null | undefined): number {
  if (typeof value === 'number') return clamp01(value);
  if (value == null) return 0.5;
  const normalized = String(value).trim().toLowerCase();
  switch (normalized) {
    case 'high': return 0.9;
    case 'medium': return 0.6;
    case 'low': return 0.3;
    default: {
      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? clamp01(parsed) : 0.5;
    }
  }
}

/**
 * Derive a CIP trust tier for a durable memory. A durable memory is, by
 * definition, already governed (only promoted knowledge reaches the `memories`
 * table), so it defaults to `reviewed`; human-curated/pinned memory is
 * `authoritative`; machine-extracted/imported memory is `derived`.
 */
export function deriveMemoryTrust(record: Pick<DurableMemoryRecord, 'sourceType' | 'pinned'>): SeedTrustTier {
  if (record.pinned) return 'authoritative';
  const sourceType = (record.sourceType ?? '').trim().toLowerCase();
  switch (sourceType) {
    case 'manual': return 'authoritative';
    case 'synthesis':
    case 'mcp': return 'reviewed';
    case 'auto-extracted':
    case 'import': return 'derived';
    default: return 'reviewed';
  }
}

/** Map the US-004 `memory_candidates.trust_tier` vocabulary onto CIP trust tiers. */
export function mapCandidateTrust(dbTier: string | null | undefined): SeedTrustTier {
  switch ((dbTier ?? '').trim().toLowerCase()) {
    case 'authoritative': return 'authoritative';
    case 'trusted': return 'reviewed';
    case 'community': return 'derived';
    case 'unverified': return 'unverified';
    default: return 'unverified';
  }
}

/** The governance gate: which candidate statuses are eligible to seed retrieval. */
export function isCandidateEligible(
  reviewStatus: string,
  includeApprovedCandidates: boolean,
): boolean {
  if (!includeApprovedCandidates) return false; // full gate: durable memory only
  return reviewStatus.trim().toLowerCase() === 'approved';
}

/** Tokenize text into a set of meaningful lowercase terms (>=3 chars, no stopwords). */
function termSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Lexical relevance of `text` to `brief` in [0, 1]: the fraction of distinct
 * brief terms that appear in the text. With no brief, relevance is neutral (0.5)
 * so ordering falls back to trust/confidence/pinned.
 */
export function lexicalRelevance(text: string, brief: string | undefined): number {
  if (!brief || !brief.trim()) return 0.5;
  const briefTerms = termSet(brief);
  if (briefTerms.size === 0) return 0.5;
  const textTerms = termSet(text);
  let hits = 0;
  for (const term of briefTerms) {
    if (textTerms.has(term)) hits += 1;
  }
  return clamp01(hits / briefTerms.size);
}

function countMatchedTerms(text: string, brief: string | undefined): number {
  if (!brief || !brief.trim()) return 0;
  const briefTerms = termSet(brief);
  const textTerms = termSet(text);
  let hits = 0;
  for (const term of briefTerms) {
    if (textTerms.has(term)) hits += 1;
  }
  return hits;
}

/**
 * Greedily apply a count cap then a token budget to score-sorted seeds. The
 * budget is a HARD ceiling — a seed that does not fit is dropped, never
 * truncated, which is what prevents memory dumps.
 */
function applyCaps<T extends { tokenEstimate: number }>(
  sorted: T[],
  maxCount: number,
  tokenBudget: number,
): { kept: T[]; droppedByCount: number; droppedByBudget: number; tokensUsed: number } {
  const countCapped = sorted.slice(0, Math.max(0, maxCount));
  const droppedByCount = sorted.length - countCapped.length;

  const kept: T[] = [];
  let tokensUsed = 0;
  let droppedByBudget = 0;
  for (const seed of countCapped) {
    if (tokensUsed + seed.tokenEstimate <= tokenBudget) {
      kept.push(seed);
      tokensUsed += seed.tokenEstimate;
    } else {
      droppedByBudget += 1;
    }
  }
  return { kept, droppedByCount, droppedByBudget, tokensUsed };
}

// ─── Seed construction ────────────────────────────────────────────────────────

function durableMemoryToSeed(record: DurableMemoryRecord, brief: string | undefined): MemorySeed {
  const text = record.content ?? '';
  const category = (record.category ?? '').trim() || 'Memory';
  const title = text.split('\n')[0].slice(0, 200) || category;
  const trust = deriveMemoryTrust(record);
  const confidence = normalizeConfidence(record.confidence);
  const relevance = lexicalRelevance(text, brief);
  const matched = countMatchedTerms(text, brief);
  const pinnedBoost = record.pinned ? 0.1 : 0;
  const score = clamp01(0.5 * relevance + 0.3 * SEED_TRUST_WEIGHT[trust] + 0.2 * confidence + pinnedBoost);

  const reasonParts = [`durable memory [${category}]`];
  if (record.pinned) reasonParts.push('pinned');
  if (matched > 0) reasonParts.push(`matched ${matched} brief term${matched === 1 ? '' : 's'}`);
  reasonParts.push(`trust=${trust}`);

  return {
    id: String(record.id),
    kind: 'memory',
    ref: String(record.id),
    category,
    title,
    confidence,
    trust,
    reason: reasonParts.join('; '),
    score,
    tokenEstimate: estimateTokens(text),
    text,
  };
}

function candidateToSeed(record: MemoryCandidateRecord, brief: string | undefined): MemorySeed {
  const text = record.rule ?? '';
  const category = (record.category ?? '').trim() || 'Candidate';
  const title = (record.title ?? '').trim() || text.split('\n')[0].slice(0, 200) || category;
  const trust = mapCandidateTrust(record.trustTier);
  const confidence = normalizeConfidence(record.confidence);
  const relevance = lexicalRelevance(`${title}\n${text}`, brief);
  const matched = countMatchedTerms(`${title}\n${text}`, brief);
  const score = clamp01(0.5 * relevance + 0.3 * SEED_TRUST_WEIGHT[trust] + 0.2 * confidence);

  const reasonParts = ['approved candidate (opted in)'];
  if (matched > 0) reasonParts.push(`matched ${matched} brief term${matched === 1 ? '' : 's'}`);
  reasonParts.push(`trust=${trust}`);

  return {
    id: `candidate:${record.id}`,
    kind: 'memory',
    ref: `candidate:${record.id}`,
    category,
    title,
    confidence,
    trust,
    reason: reasonParts.join('; '),
    score,
    tokenEstimate: estimateTokens(`${title}\n${text}`),
    text,
  };
}

function sortSeeds<T extends { score: number; id: string }>(seeds: T[]): T[] {
  return [...seeds].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ─── Pure selector ────────────────────────────────────────────────────────────

/**
 * Blend durable memories, (optionally) approved candidates, and prior
 * specs/stories into a bounded, governed, explainable set of seeds. Pure — no
 * I/O — so it is fully unit-testable and deterministic.
 */
export function selectSeeds(
  inputs: SeedRetrievalInputs,
  options: SeedRetrievalOptions = {},
): SeedRetrievalResult {
  const brief = options.brief;
  const maxMemorySeeds = options.maxMemorySeeds ?? DEFAULT_MAX_MEMORY_SEEDS;
  const maxSpecSeeds = options.maxSpecSeeds ?? DEFAULT_MAX_SPEC_SEEDS;
  const tokenBudget = Math.max(0, options.tokenBudget ?? DEFAULT_TOKEN_BUDGET);
  const ratio = Math.min(1, Math.max(0, options.memoryBudgetRatio ?? DEFAULT_MEMORY_BUDGET_RATIO));
  const memoryBudget = Math.floor(tokenBudget * ratio);
  const specBudget = tokenBudget - memoryBudget;
  const includeApprovedCandidates = options.includeApprovedCandidates ?? false;
  const includeUnapprovedSpecs = options.includeUnapprovedSpecs ?? false;

  // ── Memory seeds: durable memories are always eligible. ──
  const memorySeedPool: MemorySeed[] = inputs.durableMemories
    .filter((m) => (m.content ?? '').trim().length > 0)
    .map((m) => durableMemoryToSeed(m, brief));

  // ── Governance gate over candidates. ──
  const excludedStatuses = new Set<string>();
  let candidatesExcluded = 0;
  for (const candidate of inputs.memoryCandidates) {
    const status = String(candidate.reviewStatus ?? '').trim().toLowerCase();
    if (isCandidateEligible(status, includeApprovedCandidates) && (candidate.rule ?? '').trim().length > 0) {
      memorySeedPool.push(candidateToSeed(candidate, brief));
    } else {
      candidatesExcluded += 1;
      excludedStatuses.add(status || 'unknown');
    }
  }

  const memoryCaps = applyCaps(sortSeeds(memorySeedPool), maxMemorySeeds, memoryBudget);

  // ── Spec / story seeds. ──
  const specSeedPool: SpecSeed[] = [];
  let specsExcludedByStatus = 0;
  for (const spec of inputs.priorSpecs) {
    const status = String(spec.status ?? '').trim().toLowerCase();
    const approved = status === 'approved';
    if (!approved && !includeUnapprovedSpecs) {
      specsExcludedByStatus += 1;
      continue;
    }
    const trust: SeedTrustTier = approved ? 'authoritative' : 'captured';
    const specText = `${spec.title} ${spec.stories.map((s) => s.title ?? s.id).join(' ')}`;
    const relevance = lexicalRelevance(specText, brief);
    const score = clamp01(0.6 * relevance + 0.4 * SEED_TRUST_WEIGHT[trust]);
    const matched = countMatchedTerms(specText, brief);
    const reason =
      `prior ${approved ? 'approved' : status || 'draft'} spec "${spec.title}"` +
      (matched > 0 ? `; matched ${matched} brief term${matched === 1 ? '' : 's'}` : '') +
      `; ${spec.stories.length} stor${spec.stories.length === 1 ? 'y' : 'ies'}`;
    specSeedPool.push({
      id: spec.specId,
      kind: 'spec',
      ref: spec.specId,
      specId: spec.specId,
      title: spec.title,
      status,
      trust,
      reason,
      score,
      tokenEstimate: estimateTokens(`${spec.title}\n${reason}`),
    });
  }

  const specCaps = applyCaps(sortSeeds(specSeedPool), maxSpecSeeds, specBudget);

  return {
    memorySeeds: memoryCaps.kept,
    specSeeds: specCaps.kept,
    meta: {
      memoryCandidatesConsidered: inputs.memoryCandidates.length,
      memoryCandidatesExcludedByGovernance: candidatesExcluded,
      excludedReviewStatuses: [...excludedStatuses].sort(),
      specsConsidered: inputs.priorSpecs.length,
      specsExcludedByStatus,
      memorySeedsDroppedByCount: memoryCaps.droppedByCount,
      memorySeedsDroppedByBudget: memoryCaps.droppedByBudget,
      specSeedsDroppedByCount: specCaps.droppedByCount,
      specSeedsDroppedByBudget: specCaps.droppedByBudget,
      memoryTokensUsed: memoryCaps.tokensUsed,
      specTokensUsed: specCaps.tokensUsed,
      tokenBudget,
    },
  };
}

// ─── DB / filesystem wrappers (thin; reuse existing patterns) ─────────────────

interface DurableMemoryRow {
  id: string;
  category: string | null;
  content: string;
  confidence: string | null;
  related_files: string | null;
  source_type: string | null;
  source: string | null;
  pinned: boolean;
  created_at: string;
  updated_at: string | null;
  source_story_id: string | null;
  source_spec_id: string | null;
}

interface MemoryCandidateRow {
  id: string;
  review_status: string;
  category: string | null;
  title: string;
  rule: string;
  context: string | null;
  confidence: string | null;
  trust_tier: string | null;
  promoted_memory_id: number | null;
  related_files: string | null;
  created_at: string;
}

interface WorkspacePathRow {
  path: string;
}

function parseRelatedFiles(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

/** Load durable memories for a workspace (mirrors memory-router's hydration query). */
export async function fetchDurableMemories(workspaceId: string): Promise<DurableMemoryRecord[]> {
  try {
    const rows = await query<DurableMemoryRow>(
      `SELECT
         id::text AS id, category, content, confidence, related_files,
         source_type, source, COALESCE(pinned, false) AS pinned,
         created_at, updated_at, source_story_id, source_spec_id
       FROM memories
       WHERE workspace_id = $1 AND deleted_at IS NULL
       ORDER BY pinned DESC, COALESCE(updated_at, created_at) DESC
       LIMIT $2`,
      [workspaceId, MEMORY_FETCH_LIMIT],
    );
    return rows.map((r) => ({
      id: r.id,
      category: r.category,
      content: r.content,
      confidence: r.confidence,
      sourceType: r.source_type,
      source: r.source,
      pinned: r.pinned,
      relatedFiles: parseRelatedFiles(r.related_files),
      sourceStoryId: r.source_story_id,
      sourceSpecId: r.source_spec_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  } catch (error) {
    logger.warn({ error, workspaceId }, '[seed-retrieval] failed to load durable memories — degrading to none');
    return [];
  }
}

/**
 * Load reviewable memory candidates for a workspace. All statuses are returned;
 * the governance gate in `selectSeeds()` decides which (if any) are eligible.
 */
export async function fetchMemoryCandidates(workspaceId: string): Promise<MemoryCandidateRecord[]> {
  try {
    const rows = await query<MemoryCandidateRow>(
      `SELECT
         id::text AS id, review_status, category, title, rule, context,
         confidence, trust_tier, promoted_memory_id, related_files, created_at
       FROM memory_candidates
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [workspaceId, CANDIDATE_FETCH_LIMIT],
    );
    return rows.map((r) => ({
      id: r.id,
      reviewStatus: r.review_status,
      category: r.category,
      title: r.title,
      rule: r.rule,
      context: r.context,
      confidence: r.confidence,
      trustTier: r.trust_tier,
      promotedMemoryId: r.promoted_memory_id,
      relatedFiles: parseRelatedFiles(r.related_files),
      createdAt: r.created_at,
    }));
  } catch (error) {
    // The table may be absent on older DBs; degrade to no candidates.
    logger.warn({ error, workspaceId }, '[seed-retrieval] failed to load memory candidates — degrading to none');
    return [];
  }
}

interface RawSpecStory {
  id?: unknown;
  title?: unknown;
}

interface RawSpecFile {
  title?: unknown;
  userStories?: unknown;
}

function parsePriorSpecFile(filePath: string, specId: string, status: string): PriorSpecRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RawSpecFile;
    const stories: Array<{ id: string; title?: string }> = [];
    if (Array.isArray(raw.userStories)) {
      for (const entry of raw.userStories) {
        const story = entry as RawSpecStory;
        const id = typeof story.id === 'string' ? story.id : '';
        if (!id) continue;
        stories.push({ id, title: typeof story.title === 'string' ? story.title : undefined });
      }
    }
    return {
      specId,
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : specId,
      status,
      stories,
    };
  } catch {
    return null;
  }
}

/** Read prior specs/stories from `forge/specs/{approved,pending}` for a workspace path. */
export function fetchPriorSpecs(workspacePath: string): PriorSpecRecord[] {
  const dirs: Array<{ dir: string; status: string }> = [
    { dir: path.join(workspacePath, 'forge', 'specs', 'approved'), status: 'approved' },
    { dir: path.join(workspacePath, 'forge', 'specs', 'pending'), status: 'pending' },
  ];
  const specs: PriorSpecRecord[] = [];
  for (const { dir, status } of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of entries) {
      const specId = file.replace(/\.json$/, '');
      const parsed = parsePriorSpecFile(path.join(dir, file), specId, status);
      if (parsed) specs.push(parsed);
    }
  }
  return specs;
}

async function resolveWorkspacePath(workspaceId: string): Promise<string | undefined> {
  try {
    const rows = await query<WorkspacePathRow>('SELECT path FROM workspaces WHERE id = $1 LIMIT 1', [workspaceId]);
    return rows[0]?.path;
  } catch {
    return undefined;
  }
}

/**
 * End-to-end seed retrieval for a workspace: fetch durable memories, memory
 * candidates, and prior specs through the existing stores, then blend them with
 * the governance gate and count/token caps applied.
 */
export async function retrieveSeeds(
  workspaceId: string,
  options: SeedRetrievalOptions & { workspacePath?: string } = {},
): Promise<SeedRetrievalResult> {
  const workspacePath = options.workspacePath ?? (await resolveWorkspacePath(workspaceId));
  const [durableMemories, memoryCandidates] = await Promise.all([
    fetchDurableMemories(workspaceId),
    fetchMemoryCandidates(workspaceId),
  ]);
  const priorSpecs = workspacePath ? fetchPriorSpecs(workspacePath) : [];
  return selectSeeds({ durableMemories, memoryCandidates, priorSpecs }, options);
}
