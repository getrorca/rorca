export const TRUST_TIERS = ['untrusted', 'local', 'verified', 'privileged'] as const;

export type TrustTier = typeof TRUST_TIERS[number];

export function isTrustTier(value: unknown): value is TrustTier {
  return typeof value === 'string' && (TRUST_TIERS as readonly string[]).includes(value);
}
