// ─── Pi CLI Binary Detection ────────────────────────────────────────────────
// Detect whether the Pi CLI binary is installed and accessible.
// Used at startup (fail-fast) and by health endpoint (runtime check).

import { execSync } from 'child_process';
import { logger } from './logger';

export interface PiStatus {
  piInstalled: boolean;
  piVersion: string | null;
  piBinPath: string | null;
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

/**
 * Resolve the pi binary path.
 * Priority: PI_BIN env var → `which pi`.
 */
function resolveBinPath(): string | null {
  const envBin = process.env.PI_BIN?.trim();
  if (envBin) return envBin;

  try {
    return execSync('which pi', { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
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
  return normalized === '✓' || normalized === 'true';
}

/**
 * Detect pi binary: resolve path, run --version, parse output.
 * Never throws — returns a status object.
 */
export function detectPi(): PiStatus {
  const binPath = resolveBinPath();
  if (!binPath) {
    return { piInstalled: false, piVersion: null, piBinPath: null };
  }

  try {
    const raw = execSync(`"${binPath}" --version`, { encoding: 'utf8', timeout: 5000 });
    const version = parseVersion(raw);
    return {
      piInstalled: true,
      piVersion: version,
      piBinPath: binPath,
    };
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
      .map((line) => line.trim())
      .filter(
        (line) => line.length > 0 && !line.startsWith('─') && !line.startsWith('│ Provider')
      )
      .map((line) => line.replace(/^│\s*/, '').replace(/\s*│$/, ''))
      .map((line) => line.split(/ {2,}/).map((part) => part.trim()))
      .filter((parts) => parts.length >= 6)
      .map(([provider, model, contextTokens, maxOutTokens, thinking, images]) => ({
        provider,
        model,
        contextTokens: Number(contextTokens) || 0,
        maxOutTokens: Number(maxOutTokens) || 0,
        thinking: parseBoolean(thinking),
        images: parseBoolean(images),
      }));
  } catch {
    return [];
  }
}

export function listPiModels(binPath: string): PiModel[] {
  try {
    const stdout = execSync(`"${binPath}" --list-models`, {
      encoding: 'utf8',
      timeout: 10000,
    });
    return parsePiModelTable(stdout);
  } catch {
    return [];
  }
}
