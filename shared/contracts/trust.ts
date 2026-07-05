// ─── Context Intelligence Platform — Trust Tiers ──────────────────────────────
//
// Trust/authority is one of the ranker's signals and is stamped on bundle items,
// retrieval candidates, and captured context/memory-candidate provenance.

import { z } from 'zod';

/**
 * Ordered retrieval trust tiers (most → least authoritative):
 * - `authoritative` — human-curated durable truth (directions, curated memory).
 * - `reviewed`      — captured knowledge a human approved and promoted.
 * - `derived`       — facts derived from code structure (Hilo graph, git).
 * - `captured`      — sidecar-captured, not yet reviewed (pending candidate).
 * - `unverified`    — lowest authority; provenance unknown or unconfirmed.
 */
export const TRUST_TIERS = ['authoritative', 'reviewed', 'derived', 'captured', 'unverified'] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];
export const trustTier = z.enum(TRUST_TIERS);

/** Normalized authority weight per tier (higher = more trusted). */
export const TRUST_TIER_WEIGHT: Record<TrustTier, number> = {
  authoritative: 1.0,
  reviewed: 0.8,
  derived: 0.6,
  captured: 0.3,
  unverified: 0.1,
};

/** Rank index of a tier (0 = most authoritative). Useful for deterministic sorts. */
export function trustTierRank(tier: TrustTier): number {
  return TRUST_TIERS.indexOf(tier);
}

/** Canonical context-capture trust tiers shared by sidecar, backend contracts, and UI filters. */
export const CONTEXT_TRUST_TIERS = [
  'agent_observation',
  'working_note',
  'engineering_decision',
  'approved_policy',
  'verified_fact',
] as const;

export type ContextTrustTier = typeof CONTEXT_TRUST_TIERS[number];

export const CONTEXT_TRUST_TIER_LABELS: Record<ContextTrustTier, string> = {
  agent_observation: 'Agent observation',
  working_note: 'Working note',
  engineering_decision: 'Engineering decision',
  approved_policy: 'Approved policy',
  verified_fact: 'Verified fact',
};
