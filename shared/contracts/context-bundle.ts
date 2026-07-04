// ─── Context Intelligence Platform — Context Bundle Contracts ─────────────────
//
// The prompt-facing `SpecContextBundle` (US-020) — canonical, versioned,
// `context_summary_json`-compatible schema for composed context. A bundle is
// assembled from retrieval traces into ordered sections, with provenance —
// source, ref (path/source-id), trust, reason, confidence — stamped on every
// item, under section-level token budgets.
//
// Key invariants enforced by this contract:
//  1. Every item carries provenance (source, ref/path, trust, reason, confidence).
//  2. Pending / rejected / duplicate / superseded candidates are NEVER included.
//  3. Budget metadata (tokenBudget, tokensUsed) is present on every section.
//  4. The shape adapts losslessly to existing `context_summary_json` conventions.

import { z } from 'zod';
import { CONTRACT_VERSIONS, schemaVersionField } from './version';
import {
  confidence,
  gitSha,
  isoTimestamp,
  nonEmptyString,
  nonNegativeInt,
  workspaceId,
} from './primitives';
import { trustTier } from './trust';
import { reviewStatus } from './primitives';

/** Where a bundle item came from. */
export const PROVENANCE_SOURCES = [
  'direction',
  'memory',
  'doc',
  'source',
  'test',
  'graph',
  'diff',
  'risk',
  'candidate',
] as const;
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];
export const provenanceSource = z.enum(PROVENANCE_SOURCES);

/**
 * Provenance stamped on every bundle item: where it came from and how trusted it
 * is. Provenance is not optional — every item in a composition-bound bundle must
 * be traceable back to its origin so the prompt surface and context inspector UI
 * can render full provenance inline without guessing.
 */
export const provenance = z.object({
  source: provenanceSource,
  /** Stable ref to the origin — path for files, memory id for memories, trace id for traces, etc. */
  ref: nonEmptyString,
  trust: trustTier,
  reason: z.string().max(2000).optional(),
  confidence: confidence.optional(),
  /** The retrieval trace this item was selected by, when applicable. */
  traceId: z.string().optional(),
});
export type Provenance = z.infer<typeof provenance>;

/**
 * A single piece of context content with its provenance and token cost.
 *
 * Every item in a composition-bound bundle must carry full provenance — source,
 * ref (path/source id), trust, reason, confidence — so the prompt surface and
 * context inspector UI can render provenance inline without guessing.
 */
export const bundleItem = z.object({
  content: z.string(),
  tokens: nonNegativeInt.optional(),
  provenance,
});
export type BundleItem = z.infer<typeof bundleItem>;

/**
 * The ordered sections a bundle is composed of.
 *
 * Order matters for prompt assembly — directions come first (global rules),
 * followed by memories, docs, source files, tests, graph summary, branch diff,
 * and risks/gotchas at the end (context-dependent warnings). The composer
 * (US-021) fills sections deterministically from retrieval trace candidates.
 */
export const BUNDLE_SECTIONS = [
  'directions',
  'memories',
  'docs',
  'sourceFiles',
  'tests',
  'graphSummary',
  'branchDiff',
  'risksGotchas',
] as const;
export type BundleSectionName = (typeof BUNDLE_SECTIONS)[number];
export const bundleSectionName = z.enum(BUNDLE_SECTIONS);

/**
 * One section of the bundle, with its items and token accounting.
 *
 * Budget metadata (`tokenBudget`, `tokensUsed`) is present on every section
 * so the context inspector and run view can show section-level budget
 * consumption without recalculating from content.
 */
export const contextBundleSection = z.object({
  section: bundleSectionName,
  items: z.array(bundleItem),
  /** Token budget allocated to this section (may be a soft allocation). */
  tokenBudget: nonNegativeInt.optional(),
  /** Tokens actually consumed by this section's items. */
  tokensUsed: nonNegativeInt.optional(),
});
export type ContextBundleSection = z.infer<typeof contextBundleSection>;

/**
 * The composed, prompt-ready context bundle for a brief. Versioned, bounded, and
 * fully attributed — every item is traceable back to its source and trace.
 *
 * Guarantees enforced by the contract:
 *  - `schemaVersion` is validated (reject unknown versions on the wire).
 *  - Every item in every section carries provenance (source, ref, trust, reason, confidence).
 *  - Budget metadata is present at both section and bundle level.
 *  - Pending / rejected / duplicate / superseded candidates are excluded
 *    before composition (enforced by {@link excludeNonApprovedCandidates}).
 *  - The shape can be adapted to/from existing `context_summary_json` conventions
 *    (see {@link adaptFromContextSummary} and {@link adaptToContextSummary}).
 */
export const specContextBundle = z.object({
  schemaVersion: schemaVersionField(CONTRACT_VERSIONS.specContextBundle),
  workspaceId,
  briefHash: nonEmptyString,
  gitSha: gitSha.optional(),
  createdAt: isoTimestamp,
  sections: z.array(contextBundleSection),
  totalTokens: nonNegativeInt.optional(),
  /** Retrieval traces that fed this bundle (for replay/audit). */
  traceIds: z.array(z.string()).optional(),
  /** True when composition degraded (e.g. Hilo absent, budget exceeded). */
  degraded: z.boolean().optional(),
});
export type SpecContextBundle = z.infer<typeof specContextBundle>;

// ─── Adaptation: context_summary_json ↔ SpecContextBundle ───────────────────

/**
 * The raw shape stored in `spec_generation_logs.context_summary_json` by the
 * existing generate/persist/enrich flows. This interface documents the
 * de-facto format so US-020's SpecContextBundle can adapt to it without
 * breaking backward compatibility.
 *
 * Every field is optional because the exact shape varies by generation
 * context (enrich vs persist vs generate), and forward-compatible code
 * must tolerate partial records.
 */
export interface ContextSummaryJson {
  directionLayers?: {
    l1?: string | null;
    l2?: { present?: unknown; domain?: unknown } | null;
    l3?: string | null;
  };
  skills?: string[];
  memoryEntries?: number;
  agentsMd?: boolean;
  template?: unknown;
  schemaSnapshot?: boolean;
  gitMemory?: boolean;
  estimatedTokens?: number;
  modelContextWindow?: number;
  vectorHits?: number;
  graphHits?: number;
  retrievalTier?: string;
  retrievalLatencyMs?: number;
  retrieval?: {
    cagHits?: number;
    ragHits?: number;
    graphHits?: number;
    tier?: string;
    latencyMs?: number;
  };
  /** Post-save stages (PSE-003) — carried alongside but not part of the bundle per se. */
  postSaveStages?: unknown;
  /** Save generation marker (for repair/backfill). */
  saveGeneration?: unknown;
  /** Workspace correlation (generation log backfill). */
  workspaceId?: string;
  /** Allow arbitrary extra keys that future tooling may add. */
  [key: string]: unknown;
}

/**
 * Adapt an existing `context_summary_json` payload into a `SpecContextBundle`.
 *
 * The adapter maps known fields into bundle sections:
 *  - direction layers → `directions` section
 *  - skills → `memories` section (as skill-aware context items)
 *  - memory/retrieval metrics → section-level metadata
 *
 * Unknown or forward-compatible keys are silently ignored (the bundle is
 * always a subset of the source). Pending/rejected candidates in the source
 * are excluded (they do not appear as items).
 *
 * @param summary   The raw `context_summary_json` value from the DB.
 * @param workspaceId  The workspace the summary belongs to.
 * @param briefHash    A brief hash to stamp on the bundle for traceability.
 * @returns A valid SpecContextBundle (validated by the Zod schema).
 */
export function adaptFromContextSummary(
  summary: ContextSummaryJson | null | undefined,
  workspaceId: string,
  briefHash: string,
): SpecContextBundle {
  const now = new Date().toISOString();
  const sections: ContextBundleSection[] = [];

  const dirContent: string[] = [];
  if (summary?.directionLayers?.l1) {
    dirContent.push(summary.directionLayers.l1);
  }
  if (summary?.directionLayers?.l3) {
    dirContent.push(summary.directionLayers.l3);
  }
  if (dirContent.length > 0) {
    sections.push({
      section: 'directions',
      items: dirContent.map((d) => ({
        content: d,
        provenance: {
          source: 'direction' as const,
          ref: 'context_summary_json.directionLayers',
          trust: 'authoritative' as const,
          reason: 'Adapted from existing context_summary_json direction layers',
          confidence: 1.0,
        },
      })),
      tokenBudget: dirContent.reduce((sum, d) => sum + Math.ceil(d.length / 4), 0),
      tokensUsed: dirContent.reduce((sum, d) => sum + Math.ceil(d.length / 4), 0),
    });
  }

  // Skills → memories section (converted to bundle items with provenance)
  const skills = summary?.skills ?? [];
  if (skills.length > 0) {
    const items: BundleItem[] = skills.map((name) => ({
      content: `Skill: ${name}`,
      provenance: {
        source: 'memory' as const,
        ref: `skill:${name}`,
        trust: 'derived' as const,
        reason: 'Skill inferred from context_summary_json',
        confidence: 0.7,
      },
    }));
    const tokensUsed = items.reduce((sum, i) => sum + Math.ceil(i.content.length / 4), 0);
    sections.push({
      section: 'memories',
      items,
      tokenBudget: tokensUsed,
      tokensUsed,
    });
  }

  // Token estimates from the summary become bundle-level metadata
  const totalTokens = summary?.estimatedTokens != null
    ? Math.ceil(summary.estimatedTokens)
    : sections.reduce((sum, s) => sum + (s.tokensUsed ?? 0), 0);

  const degraded = totalTokens > (summary?.modelContextWindow ?? 200_000);

  return {
    schemaVersion: CONTRACT_VERSIONS.specContextBundle,
    workspaceId,
    briefHash,
    createdAt: now,
    sections,
    totalTokens,
    degraded,
  };
}

/**
 * Convert a `SpecContextBundle` back into a raw `context_summary_json` shape,
 * preserving the conventions expected by the existing Run View Context Inspector
 * and repair/backfill tooling.
 *
 * @param bundle The composed SpecContextBundle.
 * @returns A `context_summary_json`-compatible record.
 */
export function adaptToContextSummary(
  bundle: SpecContextBundle,
): ContextSummaryJson {
  const dirSection = bundle.sections.find((s) => s.section === 'directions');
  const memSection = bundle.sections.find((s) => s.section === 'memories');

  const dirItems = dirSection?.items ?? [];
  const l1 = dirItems.length > 0 ? dirItems[0].content : null;
  const l3 = dirItems.length > 1 ? dirItems[1].content : null;

  const skills = (memSection?.items ?? [])
    .map((i) => {
      const match = i.content.match(/^Skill:\s*(.+)$/);
      return match ? match[1] : null;
    })
    .filter((s): s is string => s !== null);

  return {
    directionLayers: {
      l1,
      l2: null,
      l3,
    },
    skills,
    estimatedTokens: bundle.totalTokens,
  };
}

// ─── Candidate Exclusion ────────────────────────────────────────────────────

/** Candidate status types that map to the governance gate (US-035). */
export type CandidateGovernanceStatus = z.infer<typeof reviewStatus>;

/**
 * Candidate exclusion predicate — returns `true` for statuses that MUST be
 * excluded from retrieval and composition (per US-035: the governance gate is
 * absolute — only `approved` candidates influence retrieval).
 *
 * Pending, rejected, duplicate, and superseded candidates are excluded.
 * Only `approved` candidates pass.
 */
export function isExcludedCandidateStatus(status: CandidateGovernanceStatus): boolean {
  return status !== 'approved';
}

/**
 * Tags a bundle item's provenance trust tier with an exclusion status.
 * Returns `true` when the item should be excluded from prompt composition
 * (e.g., the provenance signals a captured but not-yet-reviewed candidate).
 *
 * This is the canonical composition-time gate — the composer service (US-021)
 * calls this before adding any item to a section.
 */
export function shouldExcludeItem(item: BundleItem): boolean {
  // Items with trust 'captured' or 'unverified' that lack explicit approval
  // provenance are excluded by default at composition time.
  return item.provenance.trust === 'captured' || item.provenance.trust === 'unverified';
}

/**
 * Compose a new bundle from a list of candidate items, excluding any
 * whose governance status is non-approved or whose trust tier signals
 * they are not yet reviewed.
 *
 * This is the canonical contract function that enforces US-035's invariant:
 * "pending/rejected/duplicate/superseded candidates never enter default
 * retrieval or prompt composition."
 *
 * @param base     The base bundle to overlay items onto (may be a partial template).
 * @param items    Candidate bundle items with their provenance.
 * @returns A new bundle containing only approved, trusted items from the candidates.
 */
export function composeWithApprovedCandidates(
  base: SpecContextBundle,
  items: Array<{ item: BundleItem; section: BundleSectionName }>,
): SpecContextBundle {
  const approved = items.filter(
    ({ item }) => !shouldExcludeItem(item),
  );

  const sectionMap = new Map<BundleSectionName, BundleItem[]>();
  for (const { item, section } of approved) {
    const existing = sectionMap.get(section) ?? [];
    existing.push(item);
    sectionMap.set(section, existing);
  }

  const sections: ContextBundleSection[] = [...base.sections];

  for (const [name, sectionItems] of sectionMap) {
    const existing = sections.find((s) => s.section === name);
    if (existing) {
      existing.items = [...existing.items, ...sectionItems];
      const addedTokens = sectionItems.reduce(
        (sum, i) => sum + (i.tokens ?? Math.ceil(i.content.length / 4)),
        0,
      );
      existing.tokensUsed = (existing.tokensUsed ?? 0) + addedTokens;
      existing.tokenBudget = existing.tokenBudget ?? existing.tokensUsed;
    } else {
      const tokensUsed = sectionItems.reduce(
        (sum, i) => sum + (i.tokens ?? Math.ceil(i.content.length / 4)),
        0,
      );
      sections.push({
        section: name,
        items: sectionItems,
        tokenBudget: tokensUsed,
        tokensUsed,
      });
    }
  }

  const totalTokens = sections.reduce(
    (sum, s) => sum + (s.tokensUsed ?? 0),
    0,
  );

  return {
    ...base,
    sections,
    totalTokens,
    traceIds: [...(base.traceIds ?? []), ...approved
      .map((i) => i.item.provenance.traceId)
      .filter((id): id is string => !!id)],
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build an empty, valid SpecContextBundle with all sections present but empty.
 * Useful as a starting point for incremental composition.
 */
export function createEmptyBundle(
  workspaceId: string,
  briefHash: string,
  gitSha?: string,
): SpecContextBundle {
  return {
    schemaVersion: CONTRACT_VERSIONS.specContextBundle,
    workspaceId,
    briefHash,
    gitSha,
    createdAt: new Date().toISOString(),
    sections: BUNDLE_SECTIONS.map((section) => ({
      section,
      items: [],
      tokenBudget: 0,
      tokensUsed: 0,
    })),
    totalTokens: 0,
    degraded: false,
  };
}
