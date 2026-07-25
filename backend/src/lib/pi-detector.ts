/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// ─── Pi CLI Binary Detection ────────────────────────────────────────────────
// Detect whether the Pi CLI binary is installed and accessible.
// Used at startup (fail-fast) and by health endpoint (runtime check).

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';
import { probeAutonomousCli, probeAutonomousCliSync } from './autonomous-cli-probe';
import {
  ORDINARY_LOCAL_PI_PROFILE_ENV,
  RorcaExecutionSandboxError,
  ordinaryLocalPiRuntimeProfileFromEnv,
  type RorcaExecutionSandboxFailureCode,
  type RorcaExecutionSandboxMode,
} from './ordinary-local-pi-profile';

export interface PiStatus {
  piInstalled: boolean;
  piVersion: string | null;
  piBinPath: string | null;
}

/** Detailed result for a run preflight; legacy callers continue to receive PiStatus only. */
export interface PiInspection {
  status: PiStatus;
  failureCode?: RorcaExecutionSandboxFailureCode;
}

export interface PiInspectionOptions {
  /** Use only after the route/worker has frozen the ordinary local Pi profile. */
  sandboxMode?: RorcaExecutionSandboxMode;
}

export interface PiModel {
  provider: string;
  model: string;
  contextTokens: number;
  maxOutTokens: number;
  thinking: boolean;
  images: boolean;
}

export const PI_INSTALL_METHODS = {
  npm: 'npm install -g @mariozechner/pi-coding-agent',
  pnpm: 'pnpm add -g @mariozechner/pi-coding-agent',
  bun: 'bun add -g @mariozechner/pi-coding-agent',
  curl: 'curl -fsSL https://pi.mariozechner.com/install.sh | sh',
} as const;

export const MIN_PI_VERSION = '0.67.0';

// Explicit version probes must not load extensions that could call back into a
// backend currently waiting for the diagnostic. Keep request-path availability
// checks process-free instead (see detectPiAvailability).
const PI_VERSION_ARGS = ['--no-extensions', '--offline', '--version'] as const;
const PI_PROBE_TIMEOUT_MS = 2_000;

/**
 * Resolve the pi binary path.
 * Priority: PI_BIN env var → `which pi`.
 */
function resolveBinPath(requireExplicit = false): string | null {
  const envBin = process.env.PI_BIN?.trim();
  if (envBin) {
    try {
      if (!path.isAbsolute(envBin)) return null;
      fs.accessSync(envBin, fs.constants.X_OK);
      return fs.realpathSync(envBin);
    } catch { return null; }
  }

  return requireExplicit ? null : detectPiAvailability().piBinPath;
}

/**
 * Parse semver-like version from `pi --version` output.
 */
function parseVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === '✓' || normalized === 'true' || normalized === 'yes';
}

/**
 * Process-free Pi availability check for request paths. It intentionally does
 * not run Pi or load extensions; explicit detailed diagnostics use detectPi.
 */
export function detectPiAvailability(): PiStatus {
  const configuredPath = process.env.PI_BIN?.trim();
  const candidates = configuredPath
    ? [configuredPath]
    : (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((entry) => path.join(entry, process.platform === 'win32' ? 'pi.cmd' : 'pi'));

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return { piInstalled: true, piVersion: null, piBinPath: candidate };
    } catch {
      // Continue searching PATH entries.
    }
  }
  return { piInstalled: false, piVersion: null, piBinPath: null };
}

function parseTokenCount(value: string): number {
  const normalized = value.trim().toUpperCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)([KM])?$/);
  if (!match) {
    const fallback = Number(normalized);
    return Number.isFinite(fallback) ? fallback : 0;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;

  switch (match[2]) {
    case 'M': return Math.round(amount * 1_000_000);
    case 'K': return Math.round(amount * 1_000);
    default: return Math.round(amount);
  }
}

/** Resolve the probe posture inherited from a worker-issued ordinary local profile. */
function inheritedPiProbeMode(): RorcaExecutionSandboxMode | undefined {
  if (!process.env[ORDINARY_LOCAL_PI_PROFILE_ENV]) return undefined;
  ordinaryLocalPiRuntimeProfileFromEnv();
  return 'darwin-local-pi';
}

function emptyInspection(failureCode?: RorcaExecutionSandboxFailureCode): PiInspection {
  return {
    status: { piInstalled: false, piVersion: null, piBinPath: null },
    ...(failureCode ? { failureCode } : {}),
  };
}

function failureCodeForProbe(error: unknown, sandboxMode?: RorcaExecutionSandboxMode): RorcaExecutionSandboxFailureCode {
  if (error instanceof RorcaExecutionSandboxError) return error.code;
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/linux-bwrap|bubblewrap|sandbox|isolation/i.test(message)) {
    return 'linux_bwrap_required_for_requested_mode';
  }
  if (sandboxMode === 'darwin-local-pi') return 'unsupported_sandbox_mode';
  return 'pi_not_installed';
}

function probeOptions(timeoutMs: number, sandboxMode?: RorcaExecutionSandboxMode) {
  return sandboxMode ? { timeoutMs, sandboxMode } : { timeoutMs };
}

/**
 * Detect Pi with a typed failure cause. Ordinary local Pi discovery is allowed
 * only through the no-network Darwin probe selected by the frozen profile.
 */
export function inspectPi(options: PiInspectionOptions = {}): PiInspection {
  let sandboxMode: RorcaExecutionSandboxMode | undefined;
  try {
    sandboxMode = options.sandboxMode ?? inheritedPiProbeMode();
  } catch (error) {
    return emptyInspection(failureCodeForProbe(error, options.sandboxMode));
  }
  const binPath = resolveBinPath(sandboxMode === 'darwin-local-pi');
  if (!binPath) return emptyInspection('pi_not_installed');

  const result = probeAutonomousCliSync(binPath, PI_VERSION_ARGS, probeOptions(PI_PROBE_TIMEOUT_MS, sandboxMode));
  if (result.status !== 0) return emptyInspection(failureCodeForProbe(result.error, sandboxMode));
  const raw = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return {
    status: {
      piInstalled: true,
      piVersion: parseVersion(raw),
      piBinPath: binPath,
    },
  };
}

/**
 * Detect pi binary: resolve path, run --version, parse output.
 * Never throws — returns a status object for legacy callers.
 */
export function detectPi(): PiStatus {
  return inspectPi().status;
}

/** Non-blocking detector for request/diagnostic paths. */
export async function detectPiAsync(timeoutMs = 1_000): Promise<PiStatus> {
  let sandboxMode: RorcaExecutionSandboxMode | undefined;
  try {
    sandboxMode = inheritedPiProbeMode();
  } catch {
    return { piInstalled: false, piVersion: null, piBinPath: null };
  }
  const binPath = resolveBinPath(sandboxMode === 'darwin-local-pi');
  if (!binPath) return { piInstalled: false, piVersion: null, piBinPath: null };
  try {
    const result = await probeAutonomousCli(
      binPath,
      PI_VERSION_ARGS,
      probeOptions(Math.min(timeoutMs, PI_PROBE_TIMEOUT_MS), sandboxMode),
    );
    if (result.status !== 0) throw result.error ?? new Error('Pi version probe failed');
    const raw = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    return { piInstalled: true, piVersion: parseVersion(raw), piBinPath: binPath };
  } catch {
    return { piInstalled: false, piVersion: null, piBinPath: null };
  }
}

/**
 * Startup guard: call when RORCA_AGENT=pi.
 * Logs a clear error and exits with code 1 if pi is not found.
 */
export function requirePi(): PiStatus {
  const status = detectPi();

  if (!status.piInstalled) {
    console.error(
      `\x1b[31m[FATAL] Pi CLI not installed. Run: ${PI_INSTALL_METHODS.npm}\x1b[0m`
    );
    console.error(
      'Set RORCA_AGENT=claude to use Claude subscription instead, ' +
      'or set PI_BIN=/path/to/pi if installed in a non-standard location.'
    );
    process.exit(1);
  }

  logger.info(
    `[pi] Detected pi ${status.piVersion ?? '(unknown version)'} at ${status.piBinPath}`
  );

  return status;
}

export function parsePiModelTable(stdout: string): PiModel[] {
  try {
    return stdout
      .split('\n')
      .map((line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').trim())
      .filter((line) => line.length > 0 && !line.startsWith('─'))
      .map((line) => line.replace(/^│\s*/, '').replace(/\s*│$/, ''))
      .map((line) => line.split(/ {2,}/).map((part) => part.trim()))
      .filter((parts) => parts.length >= 6)
      .filter(([provider, model]) => {
        const normalizedProvider = provider.toLowerCase();
        const normalizedModel = model.toLowerCase();
        return normalizedProvider !== 'provider' && normalizedModel !== 'model';
      })
      .map(([provider, model, contextTokens, maxOutTokens, thinking, images]) => ({
        provider,
        model,
        contextTokens: parseTokenCount(contextTokens),
        maxOutTokens: parseTokenCount(maxOutTokens),
        thinking: parseBoolean(thinking),
        images: parseBoolean(images),
      }));
  } catch {
    return [];
  }
}

export function listPiModels(binPath: string, options: PiInspectionOptions = {}): PiModel[] {
  try {
    const sandboxMode = options.sandboxMode ?? inheritedPiProbeMode();
    const result = probeAutonomousCliSync(binPath, ['--list-models'], probeOptions(10_000, sandboxMode));

    if (result.error || result.status !== 0) {
      return [];
    }

    const raw = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    return parsePiModelTable(raw);
  } catch {
    return [];
  }
}

