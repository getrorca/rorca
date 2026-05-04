/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

export function formatPiProviderCostLabel(provider: string, cost: number): string {
  if (cost === 0 && provider !== 'omlx') {
    return 'Sub';
  }

  return `$${cost.toFixed(2)}`;
}
