/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// ─── Oh My Pi (omp) CLI Binary Detection ───────────────────────────────────
// Detect whether the omp CLI binary is installed and accessible, and pin its
// version for managed-executor evidence. Mirrors the pi-detector contract so
// the engine and the managed executor share one fail-closed resolution path.
// omp v17+ is the primary execution shim (W5-007..W5-009).

import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export interface OmpStatus {
  ompInstalled: boolean;
  ompVersion: string | null;
  ompBinPath: string | null;
}

/** Minimum omp release that carries the rpc-jsonl-v1 profile and omp manifests. */
export const MIN_OMP_VERSION = '17.0.0';

// Version probes must not load extensions that could call back into a backend
// currently waiting for the diagnostic. Keep the probe argument list minimal.
const OMP_VERSION_ARGS = ['--version'] as const;
const OMP_PROBE_TIMEOUT_MS = 5_000;

/**
 * Resolve the omp binary path.
 * Priority: OMP_BIN env var → `which omp`.
 */
function resolveBinPath(): string | null {
  const configured = process.env.OMP_BIN?.trim();
  if (configured) return configured;
  try {
    const resolved = execFileSync('which', ['omp'], { encoding: 'utf8', timeout: OMP_PROBE_TIMEOUT_MS }).trim();
    return resolved || null;
  } catch {
    return null;
  }
}

/** Parse the semver from `omp --version` output (`omp/17.0.9` or `omp v17.0.9`). */
export function parseOmpVersion(output: string): string | null {
  const match = output.match(/(?:omp\/?|omp\s+v)?(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

function semverLt(left: string, right: string): boolean {
  const l = left.split('.').map(Number);
  const r = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const lv = l[index] ?? 0;
    const rv = r[index] ?? 0;
    if (lv !== rv) return lv < rv;
  }
  return false;
}

/**
 * Detect the omp binary: resolve path, run `--version`, parse output.
 * Never throws — returns a status object for callers.
 */
export function detectOmp(): OmpStatus {
  const binPath = resolveBinPath();
  if (!binPath || !fs.existsSync(binPath)) {
    return { ompInstalled: false, ompVersion: null, ompBinPath: null };
  }
  try {
    const stdout = execFileSync(binPath, [...OMP_VERSION_ARGS], { encoding: 'utf8', timeout: OMP_PROBE_TIMEOUT_MS });
    return { ompInstalled: true, ompVersion: parseOmpVersion(stdout), ompBinPath: binPath };
  } catch {
    return { ompInstalled: true, ompVersion: null, ompBinPath: binPath };
  }
}

/** Non-blocking detector for request/diagnostic paths. */
export async function detectOmpAsync(_timeoutMs = 1_000): Promise<OmpStatus> {
  return detectOmp();
}

/**
 * Startup guard: call when a managed/omp path requires the shim.
 * Fails closed with an actionable error when omp is missing or below v17.
 */
export function requireOmp(): OmpStatus {
  const status = detectOmp();
  if (!status.ompInstalled || !status.ompBinPath) {
    throw new Error('omp binary not found. Set OMP_BIN or install omp (v17+); omp is the primary execution shim.');
  }
  if (!status.ompVersion || semverLt(status.ompVersion, MIN_OMP_VERSION)) {
    throw new Error(
      `omp version ${status.ompVersion ?? 'unknown'} is below the minimum supported version ${MIN_OMP_VERSION}; ` +
      'managed dispatch remains fail closed.',
    );
  }
  return status;
}
