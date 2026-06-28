// ─── Context Intelligence Platform — Context Bundle Contracts ─────────────────
//
// The prompt-facing `SpecContextBundle` base shape (US-020 refines and owns the
// canonical, `context_summary_json`-compatible schema; this is the shared,
// versioned foundation US-002 provides for it). A bundle is composed from a
// retrieval trace into ordered sections, with provenance — source, trust, reason,
// confidence — stamped on every item, under section-level token budgets.

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

/** Provenance stamped on every bundle item: where it came from and how trusted it is. */
export const provenance = z.object({
  source: provenanceSource,
  /** Stable ref to the origin (path, memory id, trace id, etc.). */
  ref: nonEmptyString,
  trust: trustTier,
  reason: z.string().max(2000).optional(),
  confidence: confidence.optional(),
  /** The retrieval trace this item was selected by, when applicable. */
  traceId: z.string().optional(),
});
export type Provenance = z.infer<typeof provenance>;

/** A single piece of context content with its provenance and token cost. */
export const bundleItem = z.object({
  content: z.string(),
  tokens: nonNegativeInt.optional(),
  provenance,
});
export type BundleItem = z.infer<typeof bundleItem>;

/** The ordered sections a bundle is composed of. */
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

/** One section of the bundle, with its items and token accounting. */
export const contextBundleSection = z.object({
  section: bundleSectionName,
  items: z.array(bundleItem),
  tokenBudget: nonNegativeInt.optional(),
  tokensUsed: nonNegativeInt.optional(),
});
export type ContextBundleSection = z.infer<typeof contextBundleSection>;

/**
 * The composed, prompt-ready context bundle for a brief. Versioned, bounded, and
 * fully attributed — every item is traceable back to its source and trace.
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
