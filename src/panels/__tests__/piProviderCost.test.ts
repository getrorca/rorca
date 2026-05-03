import { describe, expect, it } from 'vitest';
import { formatPiProviderCostLabel } from '../finops/piProviderCost';

describe('formatPiProviderCostLabel', () => {
  it('returns Sub for zero-cost subscription-backed providers', () => {
    expect(formatPiProviderCostLabel('openai', 0)).toBe('Sub');
    expect(formatPiProviderCostLabel('claude', 0)).toBe('Sub');
  });

  it('returns $0.00 for local omlx', () => {
    expect(formatPiProviderCostLabel('omlx', 0)).toBe('$0.00');
  });

  it('formats non-zero cost as USD', () => {
    expect(formatPiProviderCostLabel('google', 1.234)).toBe('$1.23');
  });
});
