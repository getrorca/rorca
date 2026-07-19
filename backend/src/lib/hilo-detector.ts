/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * hilo-detector.ts — Hilo graph-provider detection — Context Intelligence
 * Platform US-006.
 *
 * Reports, **safely and without throwing**, whether a usable Hilo codegraph
 * binary is present for a workspace. Mirrors the {@link ./codex-detector} pattern
 * (resolve binary → probe `--version` → parse a version-like string) but is
 * config-driven (honors the pinned `binaryPath` / `enabled` flag from
 * {@link ./hilo-config}) and async.
 *
 * Detection contract (US-006 acceptance):
 *   • status is one of `available` | `unavailable` | `disabled`.
 *   • a missing binary, a broken binary, a non-zero `--version`, a timeout, or an
 *     unparseable version are all handled — `detectHilo` never throws.
 *   • every non-available result carries a `message` with **setup guidance** and
 *     **disable instructions** (or enable guidance, when disabled).
 *
 * Graph-only constraint (design doc §2.1 / §4): detection runs a bounded child
 * process and reads the filesystem. It installs **no FUSE mount, no xattr probe,
 * no inotify / file watcher, and no remote backend**. Only `child_process`, `fs`,
 * and `path` are used.
 */

import * as fs from 'fs';
import * as path from 'path';

import { UnprocessableError } from './errors';
import { probeAutonomousCli } from './autonomous-cli-probe';
import { HILO_ENV, type HiloConfig } from './hilo-config';

/** How long to wait for a `--version` probe before giving up (independent of the hydration timeout). */
export const HILO_VERSION_PROBE_TIMEOUT_MS = 5_000;

/** Default binary name resolved from PATH when no explicit path is configured. */
export const DEFAULT_HILO_BINARY_NAME = 'hilo';

// ════════════════════════════════════════════════════════════════════════════
// Guidance (setup / enable / disable) — embedded in every non-available message
// ════════════════════════════════════════════════════════════════════════════

/** How to install and point Rorca at a Hilo binary. */
export const HILO_SETUP_GUIDANCE =
  'Setup: install the Hilo codegraph binary, then point Rorca at it — set ' +
  `"hilo.binaryPath" in the workspace .rorca/config.json (or export ${HILO_ENV.binaryPath}=/path/to/hilo) ` +
  'and set "hilo.enabled": true. Hilo is graph-only: it requires no FUSE mount, no extended ' +
  'attributes, no file watcher, and no remote backend.';

/** How to enable Hilo when it is currently disabled. */
export const HILO_ENABLE_GUIDANCE =
  'To enable: set "hilo.enabled": true in the workspace .rorca/config.json ' +
  `(or export ${HILO_ENV.enabled}=true) and configure a Hilo binary.`;

/** How to turn Hilo off so retrieval/composition degrade cleanly. */
export const HILO_DISABLE_GUIDANCE =
  'To disable: set "hilo.enabled": false in the workspace .rorca/config.json ' +
  `(or export ${HILO_ENV.enabled}=false). Retrieval and composition degrade cleanly when Hilo is absent.`;

// ════════════════════════════════════════════════════════════════════════════
// Detection result
// ════════════════════════════════════════════════════════════════════════════

/**
 * - `available`   — a binary responded to `--version` (version may be unparseable).
 * - `unavailable` — enabled, but no runnable binary was found / it failed to probe.
 * - `disabled`    — Hilo is turned off for this workspace.
 */
export type HiloDetectionStatus = 'available' | 'unavailable' | 'disabled';

export interface HiloDetection {
  status: HiloDetectionStatus;
  /** Convenience flag: `status === 'available'`. */
  available: boolean;
  /** Whether Hilo is enabled in config (false ⇒ `disabled`). */
  enabled: boolean;
  /** Resolved binary path that was probed, or null. */
  binaryPath: string | null;
  /** Parsed version-like string (e.g. `0.4.2`), or null when unparseable/absent. */
  version: string | null;
  /** Trimmed, truncated raw `--version` output, for diagnostics. */
  versionRaw: string | null;
  /** Human-readable status plus setup/enable/disable guidance. */
  message: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parse a version-like token out of arbitrary `--version` output. Accepts
 * `1.2`, `1.2.3`, `0.4.2-beta.1`, `hilo v0.1.0`, etc. Returns null safely when
 * nothing version-like is present (the "version-like status safely" requirement).
 */
export function parseHiloVersion(output: string): string | null {
  if (typeof output !== 'string') return null;
  const match = output.match(/(\d+\.\d+(?:\.\d+)?(?:[-.][0-9A-Za-z]+)*)/);
  return match ? match[1] : null;
}

/** True iff `p` exists, is a regular file, and is executable by this process. */
function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether a configured value looks like a path rather than a bare command name. */
function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || path.isAbsolute(value);
}

/** Resolve a bare command name through PATH (`which` / `where`). Null on failure. */
async function resolveFromPath(
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
    if (isExecutableFile(candidate)) return fs.realpathSync(candidate);
  }
  return null;
}

/**
 * Resolve the binary to probe: an explicit path is verified as executable; an
 * explicit bare name and the default name are resolved through PATH.
 */
async function resolveBinaryPath(
  config: HiloConfig,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const explicit = config.binaryPath;
  if (explicit) {
    if (looksLikePath(explicit)) {
      const abs = path.resolve(explicit);
      return isExecutableFile(abs) ? abs : null;
    }
    return resolveFromPath(explicit, env);
  }
  return resolveFromPath(DEFAULT_HILO_BINARY_NAME, env);
}

// ════════════════════════════════════════════════════════════════════════════
// detectHilo
// ════════════════════════════════════════════════════════════════════════════

/** Options for {@link detectHilo} (override env / probe timeout in tests). */
export interface DetectHiloOptions {
  env?: NodeJS.ProcessEnv;
  /** Override the `--version` probe timeout (ms). Bounded by the config timeout. */
  probeTimeoutMs?: number;
}

/**
 * Detect Hilo for a resolved {@link HiloConfig}. Never throws — every failure mode
 * maps to a `status` + a guidance-bearing `message`.
 */
export async function detectHilo(
  config: HiloConfig,
  options: DetectHiloOptions = {},
): Promise<HiloDetection> {
  const env = options.env ?? process.env;

  if (!config.enabled) {
    return {
      status: 'disabled',
      available: false,
      enabled: false,
      binaryPath: config.binaryPath,
      version: null,
      versionRaw: null,
      message: `Hilo hydration is disabled for this workspace. ${HILO_ENABLE_GUIDANCE}`,
    };
  }

  const binaryPath = await resolveBinaryPath(config, env);
  if (!binaryPath) {
    const configured = config.binaryPath ? ` (configured: "${config.binaryPath}")` : '';
    return {
      status: 'unavailable',
      available: false,
      enabled: true,
      binaryPath: null,
      version: null,
      versionRaw: null,
      message:
        `Hilo is enabled but no runnable binary was found${configured}. ` +
        `${HILO_SETUP_GUIDANCE} ${HILO_DISABLE_GUIDANCE}`,
    };
  }

  const probeTimeout = Math.max(
    1,
    Math.min(options.probeTimeoutMs ?? HILO_VERSION_PROBE_TIMEOUT_MS, config.timeoutMs),
  );

  try {
    const result = await probeAutonomousCli(binaryPath, ['--version'], { timeoutMs: probeTimeout, env });
    if (result.status !== 0) throw result.error ?? new Error('Hilo version probe failed');
    const raw = (result.stdout || result.stderr || '').trim();
    const version = parseHiloVersion(raw);
    return {
      status: 'available',
      available: true,
      enabled: true,
      binaryPath,
      version,
      versionRaw: raw ? raw.slice(0, 200) : null,
      message: version
        ? `Hilo ${version} detected at ${binaryPath}.`
        : `Hilo binary detected at ${binaryPath} (version not parseable).`,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      status: 'unavailable',
      available: false,
      enabled: true,
      binaryPath,
      version: null,
      versionRaw: null,
      message:
        `Hilo binary at ${binaryPath} did not respond to --version (${reason}). ` +
        `${HILO_SETUP_GUIDANCE} ${HILO_DISABLE_GUIDANCE}`,
    };
  }
}

/**
 * Assert Hilo is usable; throw {@link UnprocessableError} (HTTP 422) carrying the
 * detection guidance when it is not. For runner / route call-sites (US-007+) that
 * need to fail a hydration request with an actionable, guidance-bearing error.
 */
export function requireHilo(detection: HiloDetection): void {
  if (detection.available) return;
  throw new UnprocessableError(detection.message, 'HILO_UNAVAILABLE', {
    status: detection.status,
    enabled: detection.enabled,
    binaryPath: detection.binaryPath,
  });
}
