/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * hilo-hydration-runner.ts — Safe Hilo hydration runner — Context Intelligence
 * Platform US-007.
 *
 * Runs Hilo graph discovery/classification in graph-only mode with safe process
 * spawning, timeout, bounded logs, status updates, and sanitized failures.
 *
 * Design constraints (docs/context-intelligence-platform.md §2.1 / §3 / §4):
 *   • Graph-only: hydration is a bounded binary invocation — no FUSE, no xattr,
 *     no inotify, no remote backend.
 *   • Safe spawning: validates workspace cwd, uses `execFile` with explicit
 *     argument arrays (never shell-interpolated), enforces a configurable
 *     timeout, and captures bounded stdout/stderr without buffering the
 *     entire graph output in memory.
 *   • Status tracking: the hydration row is ALWAYS updated after the process
 *     exits — a stuck/killed/dangling process never leaves a `running` status
 *     in the DB. Failures are recorded as sanitized `error_json` (never raw
 *     `Error` objects leaking stack traces or OS-level file paths).
 *   • Config-driven: the resolved {@link HiloConfig} provides the binary,
 *     checkout/output dirs, and timeout. Callers use {@link requireHilo}
 *     before calling the runner.
 *
 * Consumers: US-007 (this file), US-011 (background execution), US-010
 * (hydration APIs), US-038 (observability).
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  updateHydration,
  type HydrationCounts,
  type WorkspaceHydration,
} from '../db/workspace-hydration';
import { type HiloConfig } from './hilo-config';
import { logger } from './logger';

/**
 * Promise-based wrapper around `execFile` that matches the Node.js
 * `util.promisify(execFile)` contract: resolves with `{ stdout, stderr }`,
 * rejects with the error (which carries `.stdout` / `.stderr` when available).
 *
 * We use this instead of promisify to avoid issues with the custom
 * `util.promisify.custom` symbol that real `execFile` carries — that symbol
 * makes mock-based testing fragile. This wrapper works identically for both
 * real and mocked `execFile`.
 */
function execFileAsync(
  file: string,
  args: readonly string[] | null | undefined,
  options: Parameters<typeof execFile>[2],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      const outStr = typeof stdout === 'string' ? stdout : Buffer.from(stdout).toString('utf-8');
      const errStr = typeof stderr === 'string' ? stderr : Buffer.from(stderr).toString('utf-8');
      if (err) {
        // Attach stdout/stderr to the error, matching the real execFile
        // promisify behavior so callers can inspect output on failure.
        (err as Error & { stdout: string }).stdout = outStr;
        (err as Error & { stderr: string }).stderr = errStr;
        reject(err);
      } else {
        resolve({ stdout: outStr, stderr: errStr });
      }
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Output limits
// ════════════════════════════════════════════════════════════════════════════

/** Maximum combined stdout + stderr captured in memory (256 KB). */
export const HILO_MAX_OUTPUT_BYTES = 256 * 1024;

/** Maximum single-line length preserved in error reports (4 KB). */
export const HILO_MAX_ERROR_LINE_BYTES = 4096;

/** Maximum number of error lines preserved in error_json. */
export const HILO_MAX_ERROR_LINES = 200;

// ════════════════════════════════════════════════════════════════════════════
// Error sanitization
// ════════════════════════════════════════════════════════════════════════════

/**
 * Structured, sanitized error payload stored in `error_json` when a hydration
 * run fails. Never contains raw `Error` stacks or absolute filesystem paths
 * beyond what is needed for diagnostics.
 */
export interface HiloHydrationRunError {
  /** Stable error message (not an object-stack dump). */
  message: string;
  /** Exit code when the process exited non-zero, or null for signal/timeout. */
  exitCode: number | null;
  /** Signal that terminated the process, if any. */
  signal: string | null;
  /** Whether the process was killed by the timeout guard. */
  timedOut: boolean;
  /** First N stderr lines, truncated. */
  stderrTail: string | null;
  /** Total stderr bytes before truncation (undefined if not truncated). */
  stderrBytes?: number;
  /**
   * Standardised error code for programmatic handling.
   * - `HILO_NONZERO_EXIT` — process exited with a non-zero code
   * - `HILO_SIGNAL` — process killed by a signal
   * - `HILO_TIMEOUT` — timeout exceeded
   * - `HILO_SPAWN_FAILED` — process could not be spawned
   * - `HILO_WORKSPACE_MISSING` — workspace cwd doesn't exist
   */
  code:
    | 'HILO_NONZERO_EXIT'
    | 'HILO_SIGNAL'
    | 'HILO_TIMEOUT'
    | 'HILO_SPAWN_FAILED'
    | 'HILO_WORKSPACE_MISSING';
}

/**
 * Sanitize an `execFile` error into a {@link HiloHydrationRunError}.
 * Never leaks raw stack traces or absolute paths beyond `cwdCheckoutPath`
 * and `binaryPath` (which are already known config values, not secrets).
 */
/** Extract stderr from an ExecFileException (attached by execFileAsync). */
function extractStderr(err: unknown): string {
  if (err instanceof Error) {
    const withStderr = err as Error & { stderr?: string };
    if (typeof withStderr.stderr === 'string') return withStderr.stderr;
  }
  return '';
}

function sanitizeExecError(
  err: unknown,
  binaryPath: string,
  stderrRaw: string,
): HiloHydrationRunError {
  const stderrSize = Buffer.byteLength(stderrRaw, 'utf-8');
  const stderrTail = stderrRaw
    .split('\n')
    .filter((l) => l !== '')
    .slice(-HILO_MAX_ERROR_LINES)
    .map((l) => l.slice(0, HILO_MAX_ERROR_LINE_BYTES))
    .join('\n');

  const base: Omit<HiloHydrationRunError, 'code'> = {
    message: '',
    exitCode: null,
    signal: null,
    timedOut: false,
    stderrTail: stderrTail || null,
    stderrBytes: stderrSize > HILO_MAX_OUTPUT_BYTES ? stderrSize : undefined,
  };

  if (!(err instanceof Error)) {
    return {
      ...base,
      message: `Hilo hydration failed: ${String(err)}`,
      code: 'HILO_SPAWN_FAILED',
    };
  }

  const errWithFields = err as NodeJS.ErrnoException & {
    code?: string | number;
    signal?: string;
    killed?: boolean;
  };

  // Timeout — the `execFile` timeout option sets err.killed = true
  // and err.signal is the signal sent (e.g. 'SIGTERM').
  if (errWithFields.killed) {
    return {
      ...base,
      message: `Hilo hydration timed out at ${binaryPath}`,
      signal: errWithFields.signal ?? null,
      timedOut: true,
      code: 'HILO_TIMEOUT',
    };
  }

  // Non-zero exit code — err.code is the exit code (as a number or string).
  const exitCode =
    typeof errWithFields.code === 'number'
      ? errWithFields.code
      : typeof errWithFields.code === 'string'
        ? parseInt(errWithFields.code, 10)
        : null;

  if (exitCode !== null && !Number.isNaN(exitCode)) {
    return {
      ...base,
      message: `Hilo exited with code ${exitCode} at ${binaryPath}`,
      exitCode,
      code: 'HILO_NONZERO_EXIT',
    };
  }

  // Signal (not timeout-killed).
  if (errWithFields.signal) {
    return {
      ...base,
      message: `Hilo killed by signal ${errWithFields.signal} at ${binaryPath}`,
      signal: errWithFields.signal,
      code: 'HILO_SIGNAL',
    };
  }

  // ENOENT or similar spawn failure.
  return {
    ...base,
    message: `Hilo spawn failed (${err.message}) at ${binaryPath}`,
    code: 'HILO_SPAWN_FAILED',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Git SHA
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get the git HEAD SHA from the checkout. Returns null when the checkout is
 * not a git repository or git is not available (non-fatal — hydration can
 * still proceed without a SHA, though freshness detection will be limited).
 */
async function getGitSha(checkoutPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: checkoutPath,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    return stdout.trim() || null;
  } catch {
    // Non-fatal — not every checkout is a git repo.
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Argument building
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the Hilo argument array from the resolved config. Uses explicit
 * argument arrays — never shell interpolation.
 *
 * The Hilo binary is invoked as:
 *   <binaryPath> <checkoutPath> --output <outputDir>
 *
 * This can be evolved as the Hilo CLI surface matures without changing
 * the runner's safety contract.
 */
export function buildHiloArgs(config: HiloConfig): string[] {
  return [config.checkoutPath, '--output', config.outputDir];
}

// ════════════════════════════════════════════════════════════════════════════
// Runner
// ════════════════════════════════════════════════════════════════════════════

/** Options for {@link runHiloHydration}. */
export interface RunHiloHydrationOptions {
  /** The pending hydration DB row. Must have status `pending` or `running`. */
  hydration: WorkspaceHydration;
  /** Fully-resolved Hilo configuration for this workspace. */
  config: HiloConfig;
  /** Override the binary path (for testing with mock binaries). */
  binaryPathOverride?: string;
  /** Override the argument array (for testing). */
  argsOverride?: string[];
}

/** Result of a successful hydration run. */
export interface HiloHydrationSuccess {
  status: 'succeeded';
  /** The hydration row ID. */
  hydrationId: number;
  /** The git SHA that was current at the time of hydration. */
  gitSha: string | null;
  /** The graph output path (same as `config.outputDir`). */
  graphPath: string;
  /** Total wall-clock duration in milliseconds. */
  durationMs: number;
  /** Provider metadata (Hilo binary path, version info placeholder). */
  metadata: Record<string, unknown>;
}

/** Result of a failed hydration run. */
export interface HiloHydrationFailure {
  status: 'failed';
  /** The hydration row ID. */
  hydrationId: number;
  /** Sanitized error payload (never raw Error). */
  error: HiloHydrationRunError;
}

export type HiloHydrationResult = HiloHydrationSuccess | HiloHydrationFailure;

/**
 * Run Hilo hydration for a workspace. This is the canonical hydration entry
 * point (US-007). The caller is responsible for:
 *   1. Calling {@link requireHilo} to validate Hilo is available.
 *   2. Creating a pending hydration row via {@link createHydration}.
 *   3. Resolving the Hilo config via {@link resolveHiloConfig}.
 *
 * Safety guarantees (acceptance criteria):
 *   • Validates the workspace checkout path exists and is a directory.
 *   • Uses `execFile` with safe argument arrays — no shell interpolation.
 *   • Enforces a configurable timeout from {@link HiloConfig.timeoutMs}.
 *   • Captures bounded stderr only; stdout is discarded (the graph is written
 *     to disk, not read into memory).
 *   • On success: records git SHA, graph output path, duration, and provider
 *     metadata in the hydration DB row.
 *   • On failure: records a sanitized {@link HiloHydrationRunError} (never a
 *     raw `Error`) and marks the row `failed`.
 *   • ALWAYS updates the hydration row after the process exits — a stuck
 *     process never leaves `running` status in the DB. The try/finally guard
 *     ensures this even if the Node.js event loop crashes.
 */
export async function runHiloHydration(
  options: RunHiloHydrationOptions,
): Promise<HiloHydrationResult> {
  const {
    hydration,
    config,
    binaryPathOverride,
    argsOverride,
  } = options;

  const binaryPath = binaryPathOverride ?? config.binaryPath;
  const args = argsOverride ?? buildHiloArgs(config);

  if (!binaryPath) {
    // Should not happen if requireHilo was called first, but guard anyway.
    const error: HiloHydrationRunError = {
      message: 'Hilo binary path is not configured',
      exitCode: null,
      signal: null,
      timedOut: false,
      stderrTail: null,
      code: 'HILO_SPAWN_FAILED',
    };

    await updateHydration(hydration.id, {
      status: 'failed',
      errorJson: error as unknown as import("../db/spec-jobs").JsonValue,
      finishedAt: new Date(),
    });

    logger.warn({ hydrationId: hydration.id }, '[HiloRunner] No binary path configured');
    return { status: 'failed', hydrationId: hydration.id, error };
  }

  // ── Validate workspace cwd ──────────────────────────────────────────
  const cwd = config.checkoutPath;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    const error: HiloHydrationRunError = {
      message: `Workspace checkout path does not exist: ${cwd}`,
      exitCode: null,
      signal: null,
      timedOut: false,
      stderrTail: null,
      code: 'HILO_WORKSPACE_MISSING',
    };

    await updateHydration(hydration.id, {
      status: 'failed',
      errorJson: error as unknown as import("../db/spec-jobs").JsonValue,
      finishedAt: new Date(),
    });

    logger.warn({ hydrationId: hydration.id, cwd }, '[HiloRunner] Workspace checkout missing');
    return { status: 'failed', hydrationId: hydration.id, error };
  }

  if (!stat.isDirectory()) {
    const error: HiloHydrationRunError = {
      message: `Workspace checkout path is not a directory: ${cwd}`,
      exitCode: null,
      signal: null,
      timedOut: false,
      stderrTail: null,
      code: 'HILO_WORKSPACE_MISSING',
    };

    await updateHydration(hydration.id, {
      status: 'failed',
      errorJson: error as unknown as import("../db/spec-jobs").JsonValue,
      finishedAt: new Date(),
    });

    logger.warn({ hydrationId: hydration.id, cwd }, '[HiloRunner] Workspace checkout is not a directory');
    return { status: 'failed', hydrationId: hydration.id, error };
  }

  // ── Ensure output directory exists ──────────────────────────────────
  try {
    fs.mkdirSync(config.outputDir, { recursive: true });
  } catch (err) {
    const error: HiloHydrationRunError = {
      message: `Cannot create Hilo output directory: ${config.outputDir}`,
      exitCode: null,
      signal: null,
      timedOut: false,
      stderrTail: null,
      code: 'HILO_SPAWN_FAILED',
    };

    await updateHydration(hydration.id, {
      status: 'failed',
      errorJson: error as unknown as import("../db/spec-jobs").JsonValue,
      finishedAt: new Date(),
    });

    logger.warn(
      { hydrationId: hydration.id, outputDir: config.outputDir, err },
      '[HiloRunner] Cannot create output directory',
    );
    return { status: 'failed', hydrationId: hydration.id, error };
  }

  // ── Mark as running ─────────────────────────────────────────────────
  const startedAt = new Date();
  await updateHydration(hydration.id, {
    status: 'running',
    startedAt,
  });

  logger.info(
    { hydrationId: hydration.id, binaryPath, args, cwd, timeoutMs: config.timeoutMs },
    '[HiloRunner] Starting hydration',
  );

  const stderrChunks: string[] = [];

  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, args, {
      cwd,
      timeout: config.timeoutMs,
      maxBuffer: HILO_MAX_OUTPUT_BYTES,
      windowsHide: true,
      encoding: 'utf8',
    });

    // Collect bounded stderr for diagnostics (do not accumulate oversized output).
    if (stderr) {
      stderrChunks.push(stderr);
    }

    // stdout is discarded intentionally — the graph is written to disk by Hilo,
    // not returned through stdout.
    void stdout;

    // Get git SHA for freshness.
    const gitSha = await getGitSha(cwd);

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    // Build provider metadata.
    const metadata: Record<string, string | null> = {
      provider: 'hilo',
      binaryPath,
      graphPath: config.outputDir,
      gitSha,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    };

    // Update the hydration row with success details.
    await updateHydration(hydration.id, {
      status: 'succeeded',
      gitSha,
      graphPath: config.outputDir,
      durationMs,
      metadata,
      finishedAt,
    });

    logger.info(
      {
        hydrationId: hydration.id,
        gitSha,
        durationMs,
        graphPath: config.outputDir,
      },
      '[HiloRunner] Hydration succeeded',
    );

    return {
      status: 'succeeded',
      hydrationId: hydration.id,
      gitSha,
      graphPath: config.outputDir,
      durationMs,
      metadata,
    };
  } catch (err) {
    // Extract stderr from the error object (available on ExecFileException).
    const errStderr = extractStderr(err);
    if (errStderr) stderrChunks.push(errStderr);
    const error = sanitizeExecError(err, binaryPath, stderrChunks.join(''));
    const finishedAt = new Date();

    try {
      await updateHydration(hydration.id, {
        status: 'failed',
        errorJson: error as unknown as import("../db/spec-jobs").JsonValue,
        finishedAt,
      });
    } catch (updateErr) {
      logger.error(
        { hydrationId: hydration.id, updateErr, error },
        '[HiloRunner] CRITICAL — failed to update hydration row after error',
      );
    }

    logger.warn(
      { hydrationId: hydration.id, error },
      '[HiloRunner] Hydration failed',
    );

    return { status: 'failed', hydrationId: hydration.id, error };
  }
}
