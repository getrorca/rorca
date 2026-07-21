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
export const PI_INSTALL_METHODS = {
    npm: 'npm install -g @mariozechner/pi-coding-agent',
    pnpm: 'pnpm add -g @mariozechner/pi-coding-agent',
    bun: 'bun add -g @mariozechner/pi-coding-agent',
    curl: 'curl -fsSL https://pi.mariozechner.com/install.sh | sh',
};
export const MIN_PI_VERSION = '0.67.0';
// Explicit version probes must not load extensions that could call back into a
// backend currently waiting for the diagnostic. Keep request-path availability
// checks process-free instead (see detectPiAvailability).
const PI_VERSION_ARGS = ['--no-extensions', '--offline', '--version'];
const PI_PROBE_TIMEOUT_MS = 2_000;
/**
 * Resolve the pi binary path.
 * Priority: PI_BIN env var → `which pi`.
 */
function resolveBinPath() {
    const envBin = process.env.PI_BIN?.trim();
    if (envBin) {
        try {
            fs.accessSync(envBin, fs.constants.X_OK);
            return fs.realpathSync(envBin);
        }
        catch {
            return null;
        }
    }
    return detectPiAvailability().piBinPath;
}
/**
 * Parse semver-like version from `pi --version` output.
 */
function parseVersion(output) {
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
}
function parseBoolean(value) {
    const normalized = value.trim().toLowerCase();
    return normalized === '✓' || normalized === 'true' || normalized === 'yes';
}
/**
 * Process-free Pi availability check for request paths. It intentionally does
 * not run Pi or load extensions; explicit detailed diagnostics use detectPi.
 */
export function detectPiAvailability() {
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
        }
        catch {
            // Continue searching PATH entries.
        }
    }
    return { piInstalled: false, piVersion: null, piBinPath: null };
}
function parseTokenCount(value) {
    const normalized = value.trim().toUpperCase();
    const match = normalized.match(/^(\d+(?:\.\d+)?)([KM])?$/);
    if (!match) {
        const fallback = Number(normalized);
        return Number.isFinite(fallback) ? fallback : 0;
    }
    const amount = Number(match[1]);
    if (!Number.isFinite(amount))
        return 0;
    switch (match[2]) {
        case 'M': return Math.round(amount * 1_000_000);
        case 'K': return Math.round(amount * 1_000);
        default: return Math.round(amount);
    }
}
/**
 * Detect pi binary: resolve path, run --version, parse output.
 * Never throws — returns a status object.
 */
export function detectPi() {
    const binPath = resolveBinPath();
    if (!binPath) {
        return { piInstalled: false, piVersion: null, piBinPath: null };
    }
    try {
        const result = probeAutonomousCliSync(binPath, PI_VERSION_ARGS, { timeoutMs: PI_PROBE_TIMEOUT_MS });
        if (result.status !== 0) {
            return { piInstalled: false, piVersion: null, piBinPath: null };
        }
        const raw = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
        const version = parseVersion(raw);
        return {
            piInstalled: true,
            piVersion: version,
            piBinPath: binPath,
        };
    }
    catch {
        return { piInstalled: false, piVersion: null, piBinPath: null };
    }
}
/** Non-blocking detector for request/diagnostic paths. */
export async function detectPiAsync(timeoutMs = 1_000) {
    const binPath = resolveBinPath();
    if (!binPath)
        return { piInstalled: false, piVersion: null, piBinPath: null };
    try {
        const result = await probeAutonomousCli(binPath, PI_VERSION_ARGS, {
            timeoutMs: Math.min(timeoutMs, PI_PROBE_TIMEOUT_MS),
        });
        if (result.status !== 0)
            throw result.error ?? new Error('Pi version probe failed');
        const raw = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
        return { piInstalled: true, piVersion: parseVersion(raw), piBinPath: binPath };
    }
    catch {
        return { piInstalled: false, piVersion: null, piBinPath: null };
    }
}
/**
 * Startup guard: call when RORCA_AGENT=pi.
 * Logs a clear error and exits with code 1 if pi is not found.
 */
export function requirePi() {
    const status = detectPi();
    if (!status.piInstalled) {
        console.error(`\x1b[31m[FATAL] Pi CLI not installed. Run: ${PI_INSTALL_METHODS.npm}\x1b[0m`);
        console.error('Set RORCA_AGENT=claude to use Claude subscription instead, ' +
            'or set PI_BIN=/path/to/pi if installed in a non-standard location.');
        process.exit(1);
    }
    logger.info(`[pi] Detected pi ${status.piVersion ?? '(unknown version)'} at ${status.piBinPath}`);
    return status;
}
export function parsePiModelTable(stdout) {
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
    }
    catch {
        return [];
    }
}
export function listPiModels(binPath) {
    try {
        const result = probeAutonomousCliSync(binPath, ['--list-models'], { timeoutMs: 10_000 });
        if (result.error) {
            return [];
        }
        const raw = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
        return parsePiModelTable(raw);
    }
    catch {
        return [];
    }
}
