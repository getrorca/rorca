/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { AgentType } from './config';
import { detectOmp } from './omp-detector';

/**
 * MIG-001 qualification is an operator-owned deployment decision. Availability
 * alone is not qualification: the marker must be explicitly enabled and the
 * qualified v17+ binary must still be present at dispatch time.
 */
export function isOmpSandboxQualified(
  env: NodeJS.ProcessEnv = process.env,
  available: () => ReturnType<typeof detectOmp> = detectOmp,
): boolean {
  const marker = env.RORCA_OMP_SANDBOX_QUALIFIED?.trim().toLowerCase();
  if (!['1', 'true', 'yes'].includes(marker ?? '')) return false;
  const status = available();
  if (!status.ompInstalled || !status.ompVersion || !status.ompBinPath) return false;
  const [major] = status.ompVersion.split('.').map(Number);
  return Number.isFinite(major) && major >= 17;
}

/** Qualified default only; explicit request/spec/manifest choices are resolved elsewhere. */
export function qualifiedDefaultExecutor(
  fallback: AgentType,
  qualified = isOmpSandboxQualified(),
): AgentType {
  if (qualified) return 'omp';
  return fallback === 'omp' || fallback === 'pi' ? 'claude' : fallback;
}

/**
 * Retries retain the executor frozen on their parent run. In particular, an
 * explicitly declared Pi fallback must not be re-defaulted to OMP on retry.
 */
export function preserveDeclaredExecutorAcrossRetry(executor: AgentType): AgentType {
  return executor;
}
