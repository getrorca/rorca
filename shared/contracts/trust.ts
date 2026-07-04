// ─── Context Intelligence Platform — Trust Tiers ──────────────────────────────
//
// Trust/authority is one of the ranker's signals (US-016) and is stamped on every
// bundle item and retrieval candidate as provenance. The tiers are ordered from
// most to least authoritative; `TRUST_TIER_WEIGHT` gives the ranker a normalized
// authority weight in [0, 1].

import { z } from 'zod';

/**
 * Ordered trust tiers (most → least authoritative):
 * - `authoritative` — human-curated durable truth (directions, curated memory).
 * - `reviewed`      — captured knowledge a human approved and promoted (US-035).
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
