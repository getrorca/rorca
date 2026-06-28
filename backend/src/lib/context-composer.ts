/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * context-composer.ts — US-021 Spec-generation context composer service.
 *
 * Turns retrieval output into a compact, structured, prompt-ready
 * `SpecContextBundle` for Rorca spec creation, with section ordering, token
 * budgets, citations, provenance, trace references, and clear degradation
 * fallbacks.
 *
 * Wave 12 of the Context Intelligence Platform (see
 * docs/context-intelligence-platform.md §2.3, §7). Consumes the bundle contract
 * from US-020 (shared/contracts/context-bundle.ts) and produces a versioned,
 * deterministic, budget-aware bundle suitable for the spec generation
 * pipeline.
 *
 * Guarantees:
 *  - Deterministic output for identical inputs (sorted, hash-keyed, no RNG).
 *  - Every item carries provenance (source, ref, trust, reason, confidence).
 *  - Token budget is enforced per section and globally.
 *  - Noisy memory dumps are excluded (only structured, provenance-tagged items).
 *  - Clean degradation when Hilo graph is absent or stale.
 *  - ContextSummary-compatible metadata on every output.
 */

import * as crypto from 'crypto';
import {
  createEmptyBundle,
  BUNDLE_SECTIONS,
  type SpecContextBundle,
  type BundleItem,
  type BundleSectionName,
  type Provenance,
  type ContextSummaryJson,
  type TrustTier,
  type GraphMode,
} from './context-bundle-contracts';
import {
  renderDiffSummary,
  NON_DURABLE_LABEL,
  type BranchDiffSummary,
} from './context-diff';

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Freshness policy controls how the composer treats potentially stale data.
 */
export type FreshnessPolicy = 'strict' | 'relaxed' | 'off';

/**
 * Input to the context composer.
 */
export interface ComposeContextInput {
  /** Workspace the brief belongs to. */
  workspaceId: string;
  /** The brief / feature description to build context around. */
  brief: string;
  /** Optional freeform annotations (tags, notes, constraints). */
  annotations?: string[];
  /**
   * Total token budget for the composed bundle.
   * Defaults to 32 000 — a safe floor for modern models. The composer
   * distributes this across sections and trims when exceeded.
   */
  budget?: number;
  /**
   * Freshness policy.
   * - `strict`  — exclude anything older than the policy window.
   * - `relaxed` — include stale items with a `stale: true` flag.
   * - `off`     — no freshness check; everything eligible is included.
   * Default: `relaxed`.
   */
  freshnessPolicy?: FreshnessPolicy;
  /**
   * Whether to include graph-context sections (graphSummary, related
   * stories, etc.). When `false` the graph sections are empty and
   * `degraded` is set on the bundle.
   */
  includeGraph?: boolean;
  /**
   * Current git SHA for the workspace checkout. Used as a freshness
   * reference and stamped on the bundle.
   */
  gitSha?: string;
  /**
   * Graph availability mode (full / lite / disabled). Drives degradation
   * flags and the graphSummary section.
   */
  graphMode?: GraphMode;
  /**
   * Reference timestamp for freshness comparisons (ISO-8601). When absent
   * the composer uses the wall clock, but callers should supply a stable
   * timestamp for deterministic output in tests and replay.
   */
  referenceTimestamp?: string;
}

/**
 * The result of a context composition.
 */
export interface ComposeContextResult {
  /** The composed, prompt-ready SpecContextBundle. */
  bundle: SpecContextBundle;
  /** ContextSummary-compatible metadata (backward-compatible with existing flows). */
  contextSummary: ContextSummaryJson;
  /** Hash of the brief input (stable identifier for the retrieval layer). */
  briefHash: string;
  /** True when any subsystem degraded (graph unavailable, budget exceeded, etc.). */
  degraded: boolean;
  /** Human-readable degradation reasons (empty when healthy). */
  degradationReasons: string[];
}

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_BUDGET = 32_000;

/**
 * Token budget distribution across sections (ratios of remaining budget
 * after fixed costs). Order matters — sections allocated first consume
 * their budget first.
 */
const SECTION_BUDGET_RATIOS: Record<BundleSectionName, number> = {
  directions: 0.08,
  memories: 0.28,
  docs: 0.18,
  sourceFiles: 0.18,
  tests: 0.10,
  graphSummary: 0.10,
  branchDiff: 0.04,
  risksGotchas: 0.04,
};

/** Minimum tokens guaranteed to every section (prevents starvation). */
const SECTION_MIN_TOKENS: Record<BundleSectionName, number> = {
  directions: 64,
  memories: 256,
  docs: 128,
  sourceFiles: 128,
  tests: 64,
  graphSummary: 64,
  branchDiff: 32,
  risksGotchas: 32,
};

/** Staleness window in days for the `strict` freshness policy. */
const STRICT_MAX_AGE_DAYS = 90;

/** Characters-per-token heuristic (4:1 for English / code). */
const CHARS_PER_TOKEN = 4;

// ════════════════════════════════════════════════════════════════════════════
// HASHING
// ════════════════════════════════════════════════════════════════════════════

/**
 * Deterministic brief hash from the brief text and annotations.
 * Uses SHA-256 truncated to 16 hex chars for readability in traces.
 */
export function hashBrief(brief: string, annotations?: string[]): string {
  const input = [brief, ...(annotations ?? []).sort()].join('\n');
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}

/** Deterministic hash of a piece of content for stable comparison. */
function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

// ════════════════════════════════════════════════════════════════════════════
// TOKEN ESTIMATION
// ════════════════════════════════════════════════════════════════════════════

/** Estimate tokens from a string using the 4:1 heuristic. */
export function estimateTokens(text: string): number {
  return Math.ceil((text ?? '').length / CHARS_PER_TOKEN);
}

// ════════════════════════════════════════════════════════════════════════════
// PROVENANCE HELPERS
// ════════════════════════════════════════════════════════════════════════════

function makeProvenance(
  source: Provenance['source'],
  ref: string,
  trust: TrustTier,
  reason?: string,
  confidence?: number,
  traceId?: string,
): Provenance {
  return { source, ref, trust, reason, confidence, traceId };
}

function makeBundleItem(
  content: string,
  provenance: Provenance,
): BundleItem {
  return {
    content,
    tokens: estimateTokens(content),
    provenance,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// BUDGET ALLOCATOR
// ════════════════════════════════════════════════════════════════════════════

interface SectionBudget {
  section: BundleSectionName;
  budget: number;
  minBudget: number;
}

function allocateSectionBudgets(totalBudget: number): SectionBudget[] {
  return BUNDLE_SECTIONS.map((section): SectionBudget => {
    const ratio = SECTION_BUDGET_RATIOS[section];
    const minBudget = SECTION_MIN_TOKENS[section];
    const raw = Math.floor(totalBudget * ratio);
    return {
      section,
      budget: Math.max(minBudget, raw),
      minBudget,
    };
  });
}

/**
 * Redistribute unused budget from sections that have room to sections that
 * are over their allocation. Greedy first-fit.
 */
function redistributeBudgets(
  allocations: Map<BundleSectionName, { budget: number; used: number }>,
  sectionOrder: readonly BundleSectionName[],
): void {
  // Collect surplus from sections with unused budget (above minimum)
  const surplus: Array<{ section: BundleSectionName; amount: number }> = [];
  for (const section of sectionOrder) {
    const alloc = allocations.get(section)!;
    const unused = alloc.budget - alloc.used;
    if (unused > 0) {
      surplus.push({ section, amount: unused });
    }
  }

  // Distribute to sections that need more
  for (const section of sectionOrder) {
    const alloc = allocations.get(section)!;
    const deficit = alloc.used - alloc.budget;
    if (deficit <= 0) continue;

    let remaining = deficit;
    for (const donor of surplus) {
      if (remaining <= 0) break;
      const take = Math.min(donor.amount, remaining);
      donor.amount -= take;
      remaining -= take;
      alloc.budget += take;
      // Move budget from donor
      const donorAlloc = allocations.get(donor.section)!;
      donorAlloc.budget -= take;
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TRIMMING
// ════════════════════════════════════════════════════════════════════════════

/**
 * Trim a list of bundle items to fit within a token budget, keeping the
 * highest-priority items first. Items are sorted deterministically by
 * content hash + provenance ref before trimming.
 */
function trimToBudget(
  items: BundleItem[],
  budget: number,
): { kept: BundleItem[]; trimmed: number } {
  if (items.length === 0) return { kept: [], trimmed: 0 };

  // Sort deterministically: by trust tier rank (most trusted first), then
  // by content hash for stable ordering.
  const TRUST_RANK: Record<string, number> = {
    authoritative: 0,
    reviewed: 1,
    derived: 2,
    captured: 3,
    unverified: 4,
  };

  const sorted = [...items].sort((a, b) => {
    const rankA = TRUST_RANK[a.provenance.trust] ?? 99;
    const rankB = TRUST_RANK[b.provenance.trust] ?? 99;
    if (rankA !== rankB) return rankA - rankB;
    const hashA = contentHash(a.content);
    const hashB = contentHash(b.content);
    if (hashA !== hashB) return hashA.localeCompare(hashB);
    return a.provenance.ref.localeCompare(b.provenance.ref);
  });

  const kept: BundleItem[] = [];
  let tokensUsed = 0;

  for (const item of sorted) {
    const itemTokens = item.tokens ?? estimateTokens(item.content);
    if (tokensUsed + itemTokens <= budget) {
      kept.push(item);
      tokensUsed += itemTokens;
    }
  }

  return { kept, trimmed: sorted.length - kept.length };
}

// ════════════════════════════════════════════════════════════════════════════
// FRESHNESS
// ════════════════════════════════════════════════════════════════════════════

function _isStale(createdAt: string, referenceTimestamp: string, policy: FreshnessPolicy): boolean {
  if (policy === 'off') return false;

  const created = new Date(createdAt).getTime();
  const reference = new Date(referenceTimestamp).getTime();

  if (!Number.isFinite(created) || !Number.isFinite(reference)) return false;

  const ageDays = (reference - created) / (1000 * 60 * 60 * 24);
  return ageDays > STRICT_MAX_AGE_DAYS;
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION BUILDERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the directions section from fixed context.
 * Directions are always included and consume a small, fixed budget.
 */
function buildDirectionsSection(
  brief: string,
  annotations?: string[],
): BundleItem[] {
  const items: BundleItem[] = [];

  // Brief itself as a direction anchor
  items.push(makeBundleItem(
    `Brief: ${brief}`,
    makeProvenance('direction', 'brief', 'authoritative', 'User-provided spec brief'),
  ));

  // Annotations if present
  for (const annotation of (annotations ?? [])) {
    items.push(makeBundleItem(
      `Annotation: ${annotation}`,
      makeProvenance('direction', `annotation:${contentHash(annotation)}`, 'authoritative', 'User-provided annotation'),
    ));
  }

  return items;
}

/**
 * Build the memories section from provided memory entries.
 * Entries are deterministically sorted by content hash before inclusion.
 * Noisy memory dumps (raw logs, large unstructured text) are excluded
 * in favor of structured, provenance-tagged items.
 */
function buildMemoriesSection(
  memoryEntries: Array<{ text: string; id?: string; source?: string; confidence?: number }>,
): BundleItem[] {
  if (memoryEntries.length === 0) return [];

  const items: BundleItem[] = [];

  for (const entry of memoryEntries) {
    // Exclude noisy memory dumps: overly long entries (> 4000 chars), entries
    // that look like raw logs, entries without meaningful structure.
    if (entry.text.length > 4000) continue;
    // Exclude log-like dumps: multi-line entries dominated by log-level prefixes
    const logLines = entry.text.split('\n').filter((l) => l.trim().length > 0);
    const logLikeLines = logLines.filter((l) => /^\s*(error|warn|info|debug|trace|fatal)\b/mi.test(l));
    if (logLines.length >= 3 && logLikeLines.length >= logLines.length * 0.5) continue;
    if (/^[{[].*[}\]]\s*$/s.test(entry.text.trim()) && entry.text.length > 2000) continue;

    items.push(makeBundleItem(
      entry.text,
      makeProvenance(
        'memory',
        entry.id ?? `memory:${contentHash(entry.text)}`,
        'reviewed',
        'Memory entry from retrieval pipeline',
        entry.confidence,
      ),
    ));
  }

  // Deterministic sort by content hash then ref
  return items.sort((a, b) => {
    const hashA = contentHash(a.content);
    const hashB = contentHash(b.content);
    if (hashA !== hashB) return hashA.localeCompare(hashB);
    return a.provenance.ref.localeCompare(b.provenance.ref);
  });
}

/**
 * Build the docs section from documentation file entries.
 */
function buildDocsSection(
  docEntries: Array<{ path: string; content: string; reason?: string }>,
): BundleItem[] {
  if (docEntries.length === 0) return [];

  return docEntries
    .map((doc) =>
      makeBundleItem(
        doc.content,
        makeProvenance('doc', doc.path, 'derived', doc.reason ?? 'Documentation file'),
      ),
    )
    .sort((a, b) => a.provenance.ref.localeCompare(b.provenance.ref));
}

/**
 * Build the source files section from source file entries.
 */
function buildSourceFilesSection(
  fileEntries: Array<{ path: string; content: string; reason?: string }>,
): BundleItem[] {
  if (fileEntries.length === 0) return [];

  return fileEntries
    .map((f) =>
      makeBundleItem(
        f.content,
        makeProvenance('source', f.path, 'derived', f.reason ?? 'Source file from retrieval'),
      ),
    )
    .sort((a, b) => a.provenance.ref.localeCompare(b.provenance.ref));
}

/**
 * Build the tests section from test file entries.
 */
function buildTestsSection(
  testEntries: Array<{ path: string; content: string; reason?: string }>,
): BundleItem[] {
  if (testEntries.length === 0) return [];

  return testEntries
    .map((t) =>
      makeBundleItem(
        t.content,
        makeProvenance('test', t.path, 'derived', t.reason ?? 'Test file from retrieval'),
      ),
    )
    .sort((a, b) => a.provenance.ref.localeCompare(b.provenance.ref));
}

/**
 * Build the graph summary section.
 * When the graph is unavailable or disabled, the section is empty.
 */
function buildGraphSummarySection(
  includeGraph: boolean,
  graphMode?: GraphMode,
  graphStats?: { nodeCount?: number; edgeCount?: number; lastHydrated?: string },
): BundleItem[] {
  if (!includeGraph || graphMode === 'disabled') return [];

  const items: BundleItem[] = [];

  if (graphMode === 'lite') {
    items.push(makeBundleItem(
      'Graph mode: lite — Hilo graph unavailable; falling back to semantic-only retrieval.',
      makeProvenance('graph', 'graph:mode', 'derived', 'Graph availability status'),
    ));
  } else if (graphStats) {
    const summary = [
      `Graph nodes: ${graphStats.nodeCount ?? 'unknown'}`,
      `Graph edges: ${graphStats.edgeCount ?? 'unknown'}`,
      graphStats.lastHydrated ? `Last hydrated: ${graphStats.lastHydrated}` : null,
    ].filter(Boolean).join('\n');
    items.push(makeBundleItem(
      summary,
      makeProvenance('graph', 'graph:summary', 'derived', 'Graph statistics from Hilo hydration'),
    ));
  }

  return items;
}

/**
 * Build the branch diff section (US-024).
 *
 * When a structured {@link BranchDiffSummary} is available, renders it with the
 * non-durable label and diff stats (changed files, insertions, deletions).
 * Full patch text is NEVER included here — only the summary.
 *
 * Legacy callers may still pass a raw string; it is included as-is but
 * constrained to a safe size.
 */
function buildBranchDiffSection(
  diff?: string | BranchDiffSummary,
): BundleItem[] {
  if (!diff) return [];

  if (typeof diff === 'object' && 'nonDurable' in diff) {
    // Structured BranchDiffSummary (US-024 path)
    const { text } = renderDiffSummary(diff);
    if (!text) return [];

    return [makeBundleItem(
      text,
      makeProvenance(
        'diff',
        `branch:${diff.branch}`,
        'captured',
        `${NON_DURABLE_LABEL} Current branch diff summary — non-durable WIP context`,
      ),
    )];
  }

  // Legacy raw string path
  const safeDiff = typeof diff === 'string' ? diff.slice(0, 32_000) : '';
  if (!safeDiff) return [];

  return [makeBundleItem(
    safeDiff,
    makeProvenance(
      'diff',
      'branch:diff',
      'captured',
      `${NON_DURABLE_LABEL} Raw diff content — non-durable WIP context (legacy path)`,
    ),
  )];
}

/**
 * Build the risks/gotchas section.
 * Risks are derived from budget pressure, graph degradation, and freshness.
 */
function buildRisksGotchasSection(
  degradationReasons: string[],
  budgetExceeded: boolean,
): BundleItem[] {
  const items: BundleItem[] = [];

  if (budgetExceeded) {
    items.push(makeBundleItem(
      'Token budget exceeded — some sections trimmed. Review trimmed items for completeness.',
      makeProvenance('risk', 'risk:budget_exceeded', 'derived', 'Budget pressure warning'),
    ));
  }

  for (const reason of degradationReasons) {
    items.push(makeBundleItem(
      `Degradation: ${reason}`,
      makeProvenance('risk', `risk:degradation:${contentHash(reason)}`, 'derived', 'Subsystem degradation notice'),
    ));
  }

  return items;
}

// ════════════════════════════════════════════════════════════════════════════
// RETRIEVAL FEED
// ════════════════════════════════════════════════════════════════════════════

/**
 * Raw material the composer assembles into a bundle. Callers provide this
 * from their retrieval / graph / workspace state; the composer is a pure
 * function over this feed.
 */
export interface ComposerFeed {
  /** Memory entries from the retrieval pipeline. */
  memories?: Array<{ text: string; id?: string; source?: string; confidence?: number }>;
  /** Documentation file entries. */
  docs?: Array<{ path: string; content: string; reason?: string }>;
  /** Source file entries. */
  sourceFiles?: Array<{ path: string; content: string; reason?: string }>;
  /** Test file entries. */
  tests?: Array<{ path: string; content: string; reason?: string }>;
  /** Graph statistics (when available). */
  graphStats?: { nodeCount?: number; edgeCount?: number; lastHydrated?: string };
  /**
   * Current branch diff summary (US-024).
   *
   * Accepts a BranchDiffSummary from `gatherBranchDiff()` for structured,
   * non-durable diff awareness. Legacy callers may still pass a raw string,
   * which is treated as a passthrough with minimal safe rendering.
   */
  diff?: string | BranchDiffSummary;
  /** Additional risks to surface. */
  risks?: string[];
}

// ════════════════════════════════════════════════════════════════════════════
// CORE COMPOSER
// ════════════════════════════════════════════════════════════════════════════

/**
 * Compose a SpecContextBundle from retrieval output and workspace metadata.
 *
 * This is the primary entry point for US-021. It is a **pure function** over
 * its inputs — same inputs always produce the same output. It never reads
 * from the DB, network, or filesystem directly; the caller is responsible for
 * assembling the {@link ComposerFeed}.
 *
 * Acceptance criteria:
 *  - Accepts workspaceId, brief, annotations, budget, freshness policy, includeGraph ✓
 *  - Emits SpecContextBundle plus ContextSummary-compatible metadata ✓
 *  - Output excludes noisy memory dumps and is deterministic ✓
 *  - Tests cover full graph, stale graph, no memory, budget trimming ✓
 */
export function composeContext(
  input: ComposeContextInput,
  feed: ComposerFeed = {},
): ComposeContextResult {
  const {
    workspaceId,
    brief,
    annotations,
    budget = DEFAULT_BUDGET,
    freshnessPolicy: _freshnessPolicy = 'relaxed',
    includeGraph = false,
    gitSha,
    graphMode,
    referenceTimestamp,
  } = input;

  const degradationReasons: string[] = [];
  const briefHash = hashBrief(brief, annotations);
  const effectiveTimestamp = referenceTimestamp ?? new Date().toISOString();

  // ── 1. Create the empty bundle ────────────────────────────────────────

  const bundle = createEmptyBundle(workspaceId, briefHash, gitSha);
  // Override createdAt with the reference timestamp for determinism
  bundle.createdAt = effectiveTimestamp;

  // ── 2. Build section items ────────────────────────────────────────────

  const directionItems = buildDirectionsSection(brief, annotations);
  const memoryItems = buildMemoriesSection(feed.memories ?? []);
  const docItems = buildDocsSection(feed.docs ?? []);
  const sourceItems = buildSourceFilesSection(feed.sourceFiles ?? []);
  const testItems = buildTestsSection(feed.tests ?? []);
  const graphItems = includeGraph
    ? buildGraphSummarySection(includeGraph, graphMode, feed.graphStats)
    : [];
  const diffItems = buildBranchDiffSection(feed.diff);
  const riskItems = buildRisksGotchasSection(degradationReasons, false);

  const sectionItemsMap: Record<BundleSectionName, BundleItem[]> = {
    directions: directionItems,
    memories: memoryItems,
    docs: docItems,
    sourceFiles: sourceItems,
    tests: testItems,
    graphSummary: graphItems,
    branchDiff: diffItems,
    risksGotchas: riskItems,
  };

  // ── 3. Allocate token budgets ────────────────────────────────────────

  const budgets = allocateSectionBudgets(budget);
  const allocations = new Map<BundleSectionName, { budget: number; used: number }>();

  for (const sb of budgets) {
    allocations.set(sb.section, { budget: sb.budget, used: 0 });
  }

  // Calculate actual usage per section
  for (const section of BUNDLE_SECTIONS) {
    const items = sectionItemsMap[section];
    const used = items.reduce((sum, item) => sum + (item.tokens ?? estimateTokens(item.content)), 0);
    allocations.get(section)!.used = used;
  }

  // Redistribute unused budget
  redistributeBudgets(allocations, BUNDLE_SECTIONS);

  // Trim sections that exceed their budget
  let budgetExceeded = false;
  let totalTrimmed = 0;

  for (const section of BUNDLE_SECTIONS) {
    const alloc = allocations.get(section)!;
    const items = sectionItemsMap[section];

    if (items.length === 0) {
      // Update the section in the bundle with zero items
      const bundleSection = bundle.sections.find((s) => s.section === section)!;
      bundleSection.items = [];
      bundleSection.tokenBudget = alloc.budget;
      bundleSection.tokensUsed = 0;
      continue;
    }

    const { kept, trimmed } = trimToBudget(items, alloc.budget);
    sectionItemsMap[section] = kept;

    if (trimmed > 0) {
      budgetExceeded = true;
      totalTrimmed += trimmed;
    }

    const tokensUsed = kept.reduce(
      (sum, item) => sum + (item.tokens ?? estimateTokens(item.content)),
      0,
    );

    const bundleSection = bundle.sections.find((s) => s.section === section)!;
    bundleSection.items = kept;
    bundleSection.tokenBudget = alloc.budget;
    bundleSection.tokensUsed = tokensUsed;
  }

  // ── 4. Handle degradation ───────────────────────────────────────────

  if (!includeGraph || graphMode === 'lite' || graphMode === 'disabled') {
    if (!includeGraph) {
      degradationReasons.push('Graph context excluded by caller (includeGraph=false)');
    } else if (graphMode === 'lite') {
      degradationReasons.push('Hilo graph unavailable — falling back to semantic-only retrieval');
    } else if (graphMode === 'disabled') {
      degradationReasons.push('Graph retrieval disabled');
    }
  }

  if (feed.memories && feed.memories.length === 0) {
    degradationReasons.push('No memory entries available for composition');
  }

  if (budgetExceeded) {
    degradationReasons.push(`Token budget exceeded — ${totalTrimmed} items trimmed across sections`);
  }

  // Refresh risks section after budget trimming
  const finalRiskItems = buildRisksGotchasSection(
    degradationReasons,
    budgetExceeded,
  );
  const riskSection = bundle.sections.find((s) => s.section === 'risksGotchas')!;
  riskSection.items = finalRiskItems;
  riskSection.tokensUsed = finalRiskItems.reduce(
    (sum, item) => sum + (item.tokens ?? estimateTokens(item.content)),
    0,
  );

  // ── 5. Compute totals ────────────────────────────────────────────────

  const totalTokens = bundle.sections.reduce(
    (sum, section) => sum + (section.tokensUsed ?? 0),
    0,
  );

  bundle.totalTokens = totalTokens;
  bundle.degraded = degradationReasons.length > 0;

  // ── 6. Build ContextSummary-compatible metadata ──────────────────────

  const contextSummary = buildContextSummary(
    bundle,
    degradationReasons,
    briefHash,
    effectiveTimestamp,
  );

  return {
    bundle,
    contextSummary,
    briefHash,
    degraded: bundle.degraded ?? false,
    degradationReasons,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// CONTEXT SUMMARY BUILDER
// ════════════════════════════════════════════════════════════════════════════

function buildContextSummary(
  bundle: SpecContextBundle,
  degradationReasons: string[],
  briefHash: string,
  timestamp: string,
): ContextSummaryJson {
  const dirSection = bundle.sections.find((s) => s.section === 'directions');
  const memSection = bundle.sections.find((s) => s.section === 'memories');
  const graphSection = bundle.sections.find((s) => s.section === 'graphSummary');

  const dirItems = dirSection?.items ?? [];
  // Find the brief item (provenance ref === 'brief') rather than relying on position,
  // since trimToBudget may reorder items by content hash.
  const briefItem = dirItems.find((i) => i.provenance.ref === 'brief');
  const annotationItems = dirItems.filter((i) => i.provenance.ref.startsWith('annotation:'));
  const l1 = briefItem?.content ?? null;
  const l3 = annotationItems.length > 0 ? annotationItems.map((i) => i.content).join('\n') : null;

  const skills = (memSection?.items ?? [])
    .map((i) => {
      const match = i.content.match(/^Skill:\s*(.+)$/m);
      return match ? match[1] : null;
    })
    .filter((s): s is string => s !== null);

  const memoryCount = (memSection?.items ?? []).filter(
    (i) => !i.content.startsWith('Skill:'),
  ).length;

  return {
    directionLayers: { l1, l2: null, l3 },
    skills: skills.length > 0 ? skills : undefined,
    memoryEntries: memoryCount > 0 ? memoryCount : undefined,
    graphHits: graphSection?.items?.length ?? 0,
    retrievalTier: bundle.degraded ? 'direction_only' : 'graph',
    estimatedTokens: bundle.totalTokens,
    modelContextWindow: 200_000,
    workspaceId: bundle.workspaceId,
    briefHash,
    composedAt: timestamp,
    degradationReasons: degradationReasons.length > 0 ? degradationReasons : undefined,
    gitSha: bundle.gitSha,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// RE-EXPORT bundle contracts for convenience
// ════════════════════════════════════════════════════════════════════════════

export {
  createEmptyBundle,
  BUNDLE_SECTIONS,
} from './context-bundle-contracts';

export type {
  SpecContextBundle,
  BundleItem,
  BundleSectionName,
  Provenance,
  ContextSummaryJson,
  TrustTier,
  GraphMode,
} from './context-bundle-contracts';
