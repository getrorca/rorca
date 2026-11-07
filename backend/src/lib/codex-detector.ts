/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// ─── Codex CLI Binary Detection ─────────────────────────────────────────────
// OC-024: Detect whether the Codex CLI binary is installed and accessible.
// Used at startup (fail-fast) and by health endpoint (runtime check).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from './logger';
import { probeAutonomousCli, probeAutonomousCliSync } from './autonomous-cli-probe';

export interface CodexStatus {
  codexInstalled: boolean;
  codexVersion: string | null;
  codexBinPath: string | null;
}

/**
 * Resolve the codex binary path.
 * Priority: CODEX_BIN env var → `which codex`.
 */
function resolveBinPath(): string | null {
  const envBin = process.env.CODEX_BIN?.trim();
  if (envBin) {
    try {
      fs.accessSync(envBin, fs.constants.X_OK);
      return fs.realpathSync(envBin);
    } catch { return null; }
  }

  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'codex');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch { /* continue */ }
  }
  return null;
}

/**
 * Parse semver-like version from `codex --version` output.
 * Accepts formats like "codex v0.1.0", "0.1.0", "codex 0.1.0-beta.1".
 */
function parseVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
  return match ? match[1] : null;
}

/**
 * Detect codex binary: resolve path, run --version, parse output.
 * Never throws — returns a status object.
 */
export function detectCodex(): CodexStatus {
  const binPath = resolveBinPath();
  if (!binPath) {
    return { codexInstalled: false, codexVersion: null, codexBinPath: null };
  }

  try {
    const result = probeAutonomousCliSync(binPath, ['--version'], { timeoutMs: 5_000 });
    if (result.status !== 0) throw result.error ?? new Error('Codex version probe failed');
    const version = parseVersion(`${result.stdout}\n${result.stderr}`);
    return {
      codexInstalled: true,
      codexVersion: version,
      codexBinPath: binPath,
    };
  } catch {
    // Binary exists but --version failed — installed but possibly broken
    return { codexInstalled: true, codexVersion: null, codexBinPath: binPath };
  }
}

/** Non-blocking detector for request/diagnostic paths. */
export async function detectCodexAsync(timeoutMs = 1_000): Promise<CodexStatus> {
  const binPath = resolveBinPath();
  if (!binPath) return { codexInstalled: false, codexVersion: null, codexBinPath: null };
  try {
    const result = await probeAutonomousCli(binPath, ['--version'], { timeoutMs });
    if (result.status !== 0) throw result.error ?? new Error('Codex version probe failed');
    return { codexInstalled: true, codexVersion: parseVersion(`${result.stdout}\n${result.stderr}`), codexBinPath: binPath };
  } catch {
    return { codexInstalled: true, codexVersion: null, codexBinPath: binPath };
  }
}

/**
 * Startup guard: call when RORCA_AGENT=codex.
 * Logs a clear error and exits with code 1 if codex is not found.
 */
export function requireCodex(): CodexStatus {
  const status = detectCodex();

  if (!status.codexInstalled) {
    logger.error(
      '\x1b[31m[FATAL] Codex CLI not installed. Run: npm i -g @openai/codex\x1b[0m'
    );
    logger.error(
      'Set RORCA_AGENT=claude to use Claude subscription instead, ' +
      'or set CODEX_BIN=/path/to/codex if installed in a non-standard location.'
    );
    process.exit(1);
  }

  logger.info(
    `[codex] Detected codex ${status.codexVersion ?? '(unknown version)'} at ${status.codexBinPath}`
  );

  return status;
}
