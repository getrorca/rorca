export function formatPiProviderCostLabel(provider: string, cost: number): string {
  if (cost === 0 && provider !== 'omlx') {
    return 'Sub';
  }

  return `$${cost.toFixed(2)}`;
}
