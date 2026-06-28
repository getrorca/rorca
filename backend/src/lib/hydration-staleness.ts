/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-009: Hydration Staleness Detection
 *
 * Detects whether the Hilo graph context for a workspace is stale by comparing
 * the current git HEAD against the git SHA stored in the latest hydration record,
 * checking for dirty working tree state, and handling non-git workspaces.
 *
 * Returns a machine-readable status with per-check details and a human-readable
 * summary suitable for UI indicators and observability dashboards.
 *
 * The Hilo graph is rebuildable and is NOT durable truth (§3 of the Context
 * Intelligence Platform design doc). Staleness detection is the guard that tells
 * operators when the graph is out of date and a re-hydration is warranted.
 */

import simpleGit from 'simple-git';
import { getLatestHydration } from '../db/workspace-hydration';
import { getCurrentHead } from './git-hydrator';
import { logger } from './logger';

// ─── Machine-Readable Staleness Status ──────────────────────────────────────

/**
 * Coarse staleness status. Consumers switch on this for UI indicators and
 * re-hydration gating decisions. The exact reasons are in `checks`.
 *
 * - `clean`     — graph is fresh; HEAD matches hydrated SHA, tree is clean.
 * - `stale`     — HEAD differs from hydrated SHA (new commits on the branch).
 * - `dirty`     — tree has uncommitted changes (graph may be stale too).
 * - `unknown`   — workspace is not a git repo; git-based staleness cannot be computed.
 * - `missing`   — no hydration record exists yet (graph was never built).
 */
export type HydrationStalenessStatus = 'clean' | 'stale' | 'dirty' | 'unknown' | 'missing';

/**
 * Machine-readable staleness check result. Each boolean pairs with a reason
 * string so consumers can enumerate why staleness was detected without parsing
 * the human summary.
 */
export interface HydrationStalenessChecks {
  /** True when the workspace is inside a git repository. */
  gitRepo: boolean;
  /** True when the latest hydration record exists for this workspace. */
  hasHydration: boolean;
  /**
   * True when the latest hydration's git SHA matches the current HEAD.
   * Only meaningful when `gitRepo` and `hasHydration` are both true.
   */
  headMatches: boolean;
  /**
   * True when the working tree has uncommitted changes (modified, staged, or
   * untracked files). Only meaningful when `gitRepo` is true.
   */
  dirtyTree: boolean;
}

/**
 * Full staleness detection result for a workspace hydration.
 */
export interface HydrationStalenessResult {
  /** Workspace identifier used for the hydration DB lookup. */
  workspaceId: string;
  /** Workspace filesystem path used for git inspection. */
  workspacePath: string;
  /** Coarse status for UI indicator and re-hydration gating. */
  status: HydrationStalenessStatus;
  /** Per-check boolean + reason details. */
  checks: HydrationStalenessChecks;
  /** The current git HEAD SHA, or null if not a git repo. */
  currentHead: string | null;
  /** The git SHA stored in the latest hydration, or null if missing. */
  hydratedSha: string | null;
  /**
   * Human-readable summary sentence. Suitable for tooltips, logs, and
   * non-blocking nudges. Stable enough for snapshot testing within a
   * workspace but not a contract.
   */
  humanSummary: string;
}

// ─── Status Derivation ──────────────────────────────────────────────────────

/**
 * Derive the coarse staleness status from the per-check booleans.
 * Priority order: missing → unknown → dirty → stale → clean.
 */
export function deriveStalenessStatus(checks: HydrationStalenessChecks): HydrationStalenessStatus {
  if (!checks.hasHydration) return 'missing';
  if (!checks.gitRepo) return 'unknown';
  if (checks.dirtyTree) return 'dirty';
  if (!checks.headMatches) return 'stale';
  return 'clean';
}

// ─── Summary Builder ────────────────────────────────────────────────────────

function buildHumanSummary(checks: HydrationStalenessChecks): string {
  if (!checks.hasHydration) {
    return 'No hydration record exists for this workspace. The graph has never been built.';
  }
  if (!checks.gitRepo) {
    return 'This workspace is not a git repository. Git-based staleness detection is unavailable.';
  }
  if (checks.dirtyTree) {
    return 'The working tree has uncommitted changes. The graph may not reflect the current state of the codebase.';
  }
  if (!checks.headMatches) {
    return 'New commits exist since the last hydration. The graph is stale and should be re-hydrated.';
  }
  return 'The graph is fresh. HEAD matches the hydrated SHA and the working tree is clean.';
}

// ─── Core Detection ─────────────────────────────────────────────────────────

/**
 * Detect hydration staleness for a workspace.
 *
 * - Inspects the local git repository (HEAD SHA, dirty tree status).
 * - Looks up the latest hydration record for the workspace.
 * - Compares the hydrated git SHA against the current HEAD.
 * - Derives a coarse status and builds a human-readable summary.
 *
 * Non-fatal: all errors are caught and degrade to `unknown` status. Never throws.
 *
 * @param workspaceId - The workspace ID used for hydration DB lookups.
 * @param workspacePath - Filesystem path to the workspace.
 */
export async function detectHydrationStaleness(
  workspaceId: string,
  workspacePath: string,
): Promise<HydrationStalenessResult> {
  const checks: HydrationStalenessChecks = {
    gitRepo: false,
    hasHydration: false,
    headMatches: false,
    dirtyTree: false,
  };

  let currentHead: string | null = null;
  let hydratedSha: string | null = null;

  // ── Git repo check + HEAD ──────────────────────────────────────────────
  try {
    const git = simpleGit(workspacePath);
    checks.gitRepo = await git.checkIsRepo();
    if (checks.gitRepo) {
      currentHead = await getCurrentHead(workspacePath);

      // Check working tree status for uncommitted changes.
      try {
        const status = await git.status();
        checks.dirtyTree = !status.isClean();
      } catch (statusErr) {
        logger.warn(
          { err: statusErr, workspaceId },
          '[hydration-staleness] git status check failed — assuming clean',
        );
      }
    }
  } catch (gitErr) {
    logger.warn(
      { err: gitErr, workspaceId },
      '[hydration-staleness] git repo check failed — treating as non-git workspace',
    );
  }

  // ── Latest hydration lookup ────────────────────────────────────────────
  try {
    const latest = await getLatestHydration(workspaceId);
    if (latest) {
      checks.hasHydration = true;
      hydratedSha = latest.gitSha ?? null;
      checks.headMatches = checks.gitRepo && currentHead !== null && hydratedSha !== null
        ? currentHead === hydratedSha
        : false;
    }
  } catch (dbErr) {
    logger.warn(
      { err: dbErr, workspaceId },
      '[hydration-staleness] hydration lookup failed — treating as missing',
    );
  }

  const status = deriveStalenessStatus(checks);
  const humanSummary = buildHumanSummary(checks);

  return {
    workspaceId,
    workspacePath,
    status,
    checks,
    currentHead,
    hydratedSha,
    humanSummary,
  };
}

// ─── Quick Helpers ──────────────────────────────────────────────────────────

/**
 * Returns true when the graph is neither clean nor missing — i.e. re-hydration
 * may be warranted. Convenience for gating decisions without inspecting the
 * full result shape.
 */
export function isStaleOrDirty(result: HydrationStalenessResult): boolean {
  return result.status === 'stale' || result.status === 'dirty';
}

/**
 * Returns true when staleness detection is unavailable (non-git workspace)
 * and the caller should fall back to time-based freshness or skip staleness
 * gating entirely.
 */
export function isStalenessUnknown(result: HydrationStalenessResult): boolean {
  return result.status === 'unknown';
}
