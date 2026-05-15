/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

export function isPiExternalOrchestrationEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.RORCA_PI_EXTERNAL_ORCHESTRATION ?? '').trim().toLowerCase() === 'true';
}
