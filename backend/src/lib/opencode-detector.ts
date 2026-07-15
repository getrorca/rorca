/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// ─── OpenCode Binary Detection ──────────────────────────────────────────────
// OC-002: Detect whether the opencode binary is installed and accessible.
// Used at startup (fail-fast) and by health endpoint (runtime check).

import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger';

export const MIN_OPENCODE_VERSION = '0.1.0';
const execFileAsync = promisify(execFile);

export interface OpenCodeStatus {
  opencodeInstalled: boolean;
  opencodeVersion: string | null;
  opencodeBinPath: string | null;
}

/**
 * Resolve the opencode binary path.
 * Priority: OPENCODE_BIN env var → `which opencode`.
 */
function resolveBinPath(): string | null {
  const envBin = process.env.OPENCODE_BIN?.trim();
  if (envBin) return envBin;

  try {
    return execSync('which opencode', { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

/**
 * Parse semver-like version from `opencode --version` output.
 * Accepts formats like "opencode v0.1.0", "0.1.0", "opencode 0.1.0-beta.1".
 */
function parseVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
  return match ? match[1] : null;
}

/**
 * Compare two semver strings (major.minor.patch only).
 * Returns true if `version` >= `minVersion`.
 */
export function semverGte(version: string, minVersion: string): boolean {
  const parse = (v: string) => v.split('-')[0].split('.').map(Number);
  const [aMaj, aMin, aPat] = parse(version);
  const [bMaj, bMin, bPat] = parse(minVersion);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat >= bPat;
}

/**
 * Detect opencode binary: resolve path, run --version, parse output.
 * Never throws — returns a status object.
 */
export function detectOpenCode(): OpenCodeStatus {
  const binPath = resolveBinPath();
  if (!binPath) {
    return { opencodeInstalled: false, opencodeVersion: null, opencodeBinPath: null };
  }

  try {
    const raw = execSync(`"${binPath}" --version`, { encoding: 'utf-8', timeout: 5000 });
    const version = parseVersion(raw);
    return {
      opencodeInstalled: true,
      opencodeVersion: version,
      opencodeBinPath: binPath,
    };
  } catch {
    // Binary exists but --version failed — installed but possibly broken
    return { opencodeInstalled: true, opencodeVersion: null, opencodeBinPath: binPath };
  }
}

/** Non-blocking detector for request/diagnostic paths. */
export async function detectOpenCodeAsync(timeoutMs = 1_000): Promise<OpenCodeStatus> {
  let binPath = process.env.OPENCODE_BIN?.trim() || null;
  if (!binPath) {
    try {
      const result = await execFileAsync('which', ['opencode'], { encoding: 'utf8', timeout: timeoutMs });
      binPath = result.stdout.trim() || null;
    } catch {
      return { opencodeInstalled: false, opencodeVersion: null, opencodeBinPath: null };
    }
  }
  if (!binPath) return { opencodeInstalled: false, opencodeVersion: null, opencodeBinPath: null };
  try {
    const result = await execFileAsync(binPath, ['--version'], { encoding: 'utf8', timeout: timeoutMs });
    return { opencodeInstalled: true, opencodeVersion: parseVersion(result.stdout), opencodeBinPath: binPath };
  } catch {
    return { opencodeInstalled: true, opencodeVersion: null, opencodeBinPath: binPath };
  }
}

/**
 * Startup guard: call when RORCA_AGENT=opencode.
 * Logs a clear error and exits with code 1 if opencode is not found.
 */
export function requireOpenCode(): OpenCodeStatus {
  const status = detectOpenCode();

  if (!status.opencodeInstalled) {
    logger.error(
      '\x1b[31m[FATAL] OpenCode not installed. Run: npm i -g opencode-ai\x1b[0m'
    );
    logger.error(
      'Set RORCA_AGENT=claude to use Claude subscription instead, ' +
      'or set OPENCODE_BIN=/path/to/opencode if installed in a non-standard location.'
    );
    process.exit(1);
  }

  if (status.opencodeVersion && !semverGte(status.opencodeVersion, MIN_OPENCODE_VERSION)) {
    logger.error(
      `\x1b[31m[FATAL] OpenCode version ${status.opencodeVersion} is below minimum required ${MIN_OPENCODE_VERSION}.\x1b[0m`
    );
    logger.error('Run: npm i -g opencode-ai@latest');
    process.exit(1);
  }

  logger.info(
    `[opencode] Detected opencode ${status.opencodeVersion ?? '(unknown version)'} at ${status.opencodeBinPath}`
  );

  return status;
}
