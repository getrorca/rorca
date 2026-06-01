/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export function isPiExternalOrchestrationEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.RORCA_PI_EXTERNAL_ORCHESTRATION ?? '').trim().toLowerCase() === 'true';
}
