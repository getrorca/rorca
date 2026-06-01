/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export function formatPiProviderCostLabel(provider: string, cost: number): string {
  if (cost === 0 && provider !== 'omlx') {
    return 'Sub';
  }

  return `$${cost.toFixed(2)}`;
}
