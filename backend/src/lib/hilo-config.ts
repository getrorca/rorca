/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * hilo-config.ts — Hilo graph-provider configuration — Context Intelligence
 * Platform US-006.
 *
 * Hilo is an external **codegraph** provider. Hydration (US-007/US-008) runs the
 * Hilo binary over a workspace checkout and normalizes its output into Rorca's
 * `GraphEdge` / `GraphFileNode` shapes. This module owns the *configuration* half
 * of that subsystem; {@link ./hilo-detector} owns *detection*.
 *
 * Design constraints (docs/context-intelligence-platform.md §2.1 / §4):
 *   • Graph-only. Hydration is a binary run over a checkout that writes to an
 *     output directory. There is **no FUSE mount, no extended attributes (xattr),
 *     no inotify / file-watch trigger, and no remote backend**. This module uses
 *     only `fs` + `path` and never installs a watcher or mounts a filesystem.
 *   • Pinned now, fork later. Today Hilo is a *pinned binary + checkout*. The
 *     config shape is forward-compatible: a future fork (a different build/source
 *     of the same codegraph contract) is pointed at via `binaryPath` /
 *     `checkoutPath` with no schema change.
 *
 * Configuration precedence (most specific wins):
 *   1. environment overrides (`HILO_BIN`, `RORCA_HILO_*`) — operator / CI control
 *   2. the workspace `.rorca/config.json` `hilo` section — per-workspace settings
 *   3. built-in defaults
 *
 * Resolution is **total and non-throwing**: malformed config values fall back to
 * defaults rather than raising, so a bad config file can never crash hydration
 * config loading. {@link hiloConfigSchema} is exported for callers/tests that want
 * to runtime-validate a resolved config.
 */

import * as fs from 'fs';
import * as path from 'path';

import { z } from 'zod';

// ════════════════════════════════════════════════════════════════════════════
// Defaults & limits
// ════════════════════════════════════════════════════════════════════════════

/** Default output directory (workspace-relative) for Hilo's rebuildable graph. */
export const DEFAULT_HILO_OUTPUT_DIR = '.rorca/hilo';

/** Default per-run hydration timeout (2 minutes). */
export const DEFAULT_HILO_TIMEOUT_MS = 120_000;

/** Floor for the configurable timeout (1 second). */
export const HILO_TIMEOUT_MIN_MS = 1_000;

/** Ceiling for the configurable timeout (30 minutes). */
export const HILO_TIMEOUT_MAX_MS = 30 * 60_000;

/** Filename, inside the workspace `.rorca/` dir, that carries workspace config. */
export const RORCA_CONFIG_RELATIVE_PATH = path.join('.rorca', 'config.json');

/**
 * Environment-variable override names. `HILO_BIN` mirrors the existing
 * `CODEX_BIN` / `CLAUDE_BIN` convention for binary discovery; the rest use the
 * `RORCA_HILO_` namespace.
 */
export const HILO_ENV = {
  enabled: 'RORCA_HILO_ENABLED',
  binaryPath: 'HILO_BIN',
  checkoutPath: 'RORCA_HILO_CHECKOUT',
  outputDir: 'RORCA_HILO_OUTPUT_DIR',
  timeoutMs: 'RORCA_HILO_TIMEOUT_MS',
} as const;

// ════════════════════════════════════════════════════════════════════════════
// Resolved config shape
// ════════════════════════════════════════════════════════════════════════════

/**
 * Fully-resolved, normalized Hilo configuration for a single workspace. Every
 * field is concrete: paths are absolute, the timeout is clamped, and `binaryPath`
 * is the configured value (or `null`, meaning "resolve from PATH at detection").
 */
export interface HiloConfig {
  /** Master switch. When false, hydration/detection report `disabled` and skip. */
  enabled: boolean;
  /**
   * Configured Hilo binary — an absolute/relative path or a bare command name.
   * `null` defers discovery to PATH (`which hilo`) at detection time.
   */
  binaryPath: string | null;
  /** Absolute checkout Hilo runs against. Defaults to the workspace root. */
  checkoutPath: string;
  /** Absolute directory for Hilo's rebuildable graph output (never durable truth). */
  outputDir: string;
  /** Per-run timeout in ms, clamped to [{@link HILO_TIMEOUT_MIN_MS}, {@link HILO_TIMEOUT_MAX_MS}]. */
  timeoutMs: number;
}

/** Zod validator for a {@link HiloConfig} (resolved shape). */
export const hiloConfigSchema = z.object({
  enabled: z.boolean(),
  binaryPath: z.string().min(1).nullable(),
  checkoutPath: z.string().min(1),
  outputDir: z.string().min(1),
  timeoutMs: z.number().int().min(HILO_TIMEOUT_MIN_MS).max(HILO_TIMEOUT_MAX_MS),
});

// ════════════════════════════════════════════════════════════════════════════
// Coercion helpers (lenient — untrusted JSON / env strings)
// ════════════════════════════════════════════════════════════════════════════

/** Parse a boolean from an env/config value. Returns null when not a clear boolean. */
function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'enabled'].includes(v)) return true;
    if (['false', '0', 'no', 'off', 'disabled', ''].includes(v)) return false;
  }
  return null;
}

/** Trim a string-ish value; return null for empty / non-string. */
function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** First defined, non-empty string among the candidates. */
function firstNonEmpty(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const s = nonEmptyString(candidate);
    if (s !== null) return s;
  }
  return null;
}

/** Parse a finite, positive integer from an env/config value, else null. */
function parsePositiveInt(value: unknown): number | null {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  else return null;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/** Clamp a timeout into the supported window. */
function clampTimeout(ms: number): number {
  return Math.min(Math.max(ms, HILO_TIMEOUT_MIN_MS), HILO_TIMEOUT_MAX_MS);
}

/**
 * Pull the `hilo` section out of a parsed `.rorca/config.json`. Accepts either the
 * whole config object (reads `.hilo`) or the section directly, and tolerates any
 * shape — a non-object always yields an empty section.
 */
function extractHiloSection(config: unknown): Record<string, unknown> {
  if (config === null || typeof config !== 'object') return {};
  const obj = config as Record<string, unknown>;
  const section = obj.hilo;
  if (section !== null && typeof section === 'object' && !Array.isArray(section)) {
    return section as Record<string, unknown>;
  }
  // The caller passed the section itself (no nested `hilo` key).
  if (!('hilo' in obj)) return obj;
  return {};
}

// ════════════════════════════════════════════════════════════════════════════
// Resolution
// ════════════════════════════════════════════════════════════════════════════

/** Input to {@link resolveHiloConfig}. */
export interface ResolveHiloConfigInput {
  /** Absolute or relative workspace root; relative paths resolve against it. */
  workspaceRoot: string;
  /** Parsed `.rorca/config.json` (or its `hilo` section). Optional. */
  config?: unknown;
  /** Environment map for overrides. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the effective {@link HiloConfig} from env overrides, the workspace
 * config section, and built-in defaults. Pure and non-throwing.
 */
export function resolveHiloConfig(input: ResolveHiloConfigInput): HiloConfig {
  const env = input.env ?? process.env;
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const section = extractHiloSection(input.config);

  const enabled =
    parseBoolean(env[HILO_ENV.enabled]) ?? parseBoolean(section.enabled) ?? false;

  const binaryPath = firstNonEmpty(env[HILO_ENV.binaryPath], section.binaryPath);

  const checkoutRaw = firstNonEmpty(env[HILO_ENV.checkoutPath], section.checkoutPath);
  const checkoutPath = checkoutRaw
    ? path.resolve(workspaceRoot, checkoutRaw)
    : workspaceRoot;

  const outputRaw =
    firstNonEmpty(env[HILO_ENV.outputDir], section.outputDir) ?? DEFAULT_HILO_OUTPUT_DIR;
  const outputDir = path.resolve(workspaceRoot, outputRaw);

  const timeoutRaw =
    parsePositiveInt(env[HILO_ENV.timeoutMs]) ??
    parsePositiveInt(section.timeoutMs) ??
    DEFAULT_HILO_TIMEOUT_MS;
  const timeoutMs = clampTimeout(timeoutRaw);

  return { enabled, binaryPath, checkoutPath, outputDir, timeoutMs };
}

/**
 * Read `<workspaceRoot>/.rorca/config.json` (non-fatally) and resolve the
 * effective Hilo config. A missing, unreadable, or malformed config file degrades
 * silently to env + defaults — it never throws.
 */
export function loadHiloConfig(workspaceRoot: string, env?: NodeJS.ProcessEnv): HiloConfig {
  let config: unknown = null;
  try {
    const configPath = path.join(workspaceRoot, RORCA_CONFIG_RELATIVE_PATH);
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch {
    // Non-fatal: a broken config file must never break hydration config loading.
    config = null;
  }
  return resolveHiloConfig({ workspaceRoot, config, env });
}
