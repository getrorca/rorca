/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { UnprocessableError } from '../errors';
import {
  DEFAULT_HILO_OUTPUT_DIR,
  DEFAULT_HILO_TIMEOUT_MS,
  HILO_ENV,
  HILO_TIMEOUT_MAX_MS,
  HILO_TIMEOUT_MIN_MS,
  hiloConfigSchema,
  loadHiloConfig,
  resolveHiloConfig,
} from '../hilo-config';
import {
  HILO_DISABLE_GUIDANCE,
  HILO_ENABLE_GUIDANCE,
  HILO_SETUP_GUIDANCE,
  detectHilo,
  parseHiloVersion,
  requireHilo,
} from '../hilo-detector';

describe('hilo-config', () => {
  const root = path.resolve('/tmp/ws');
  const emptyEnv: NodeJS.ProcessEnv = {};

  describe('resolveHiloConfig — defaults', () => {
    it('disabled with safe defaults when nothing is configured', () => {
      const cfg = resolveHiloConfig({ workspaceRoot: root, env: emptyEnv });
      expect(cfg.enabled).toBe(false);
      expect(cfg.binaryPath).toBeNull();
      // checkout defaults to the workspace root; output defaults under .rorca/.
      expect(cfg.checkoutPath).toBe(root);
      expect(cfg.outputDir).toBe(path.resolve(root, DEFAULT_HILO_OUTPUT_DIR));
      expect(cfg.timeoutMs).toBe(DEFAULT_HILO_TIMEOUT_MS);
      // The resolved shape always satisfies the validator.
      expect(hiloConfigSchema.safeParse(cfg).success).toBe(true);
    });
  });

  describe('resolveHiloConfig — config section', () => {
    it('applies values from the workspace `hilo` config section', () => {
      const cfg = resolveHiloConfig({
        workspaceRoot: root,
        env: emptyEnv,
        config: {
          hilo: {
            enabled: true,
            binaryPath: '/opt/hilo/bin/hilo',
            checkoutPath: 'checkouts/main',
            outputDir: 'build/hilo-graph',
            timeoutMs: 60_000,
          },
        },
      });
      expect(cfg.enabled).toBe(true);
      expect(cfg.binaryPath).toBe('/opt/hilo/bin/hilo');
      expect(cfg.checkoutPath).toBe(path.resolve(root, 'checkouts/main'));
      expect(cfg.outputDir).toBe(path.resolve(root, 'build/hilo-graph'));
      expect(cfg.timeoutMs).toBe(60_000);
    });

    it('accepts the section passed directly (no nested `hilo` key)', () => {
      const cfg = resolveHiloConfig({
        workspaceRoot: root,
        env: emptyEnv,
        config: { enabled: true, timeoutMs: 5_000 },
      });
      expect(cfg.enabled).toBe(true);
      expect(cfg.timeoutMs).toBe(5_000);
    });

    it('coerces string booleans for `enabled`', () => {
      expect(
        resolveHiloConfig({ workspaceRoot: root, env: emptyEnv, config: { hilo: { enabled: 'true' } } })
          .enabled,
      ).toBe(true);
      expect(
        resolveHiloConfig({ workspaceRoot: root, env: emptyEnv, config: { hilo: { enabled: 'no' } } })
          .enabled,
      ).toBe(false);
    });
  });

  describe('resolveHiloConfig — env overrides win', () => {
    it('env overrides the config section', () => {
      const env: NodeJS.ProcessEnv = {
        [HILO_ENV.enabled]: 'true',
        [HILO_ENV.binaryPath]: '/usr/local/bin/hilo',
        [HILO_ENV.outputDir]: 'env-out',
        [HILO_ENV.timeoutMs]: '90000',
      };
      const cfg = resolveHiloConfig({
        workspaceRoot: root,
        env,
        config: { hilo: { enabled: false, binaryPath: '/cfg/hilo', outputDir: 'cfg-out', timeoutMs: 1234 } },
      });
      expect(cfg.enabled).toBe(true);
      expect(cfg.binaryPath).toBe('/usr/local/bin/hilo');
      expect(cfg.outputDir).toBe(path.resolve(root, 'env-out'));
      expect(cfg.timeoutMs).toBe(90_000);
    });
  });

  describe('resolveHiloConfig — robustness', () => {
    it('clamps the timeout into the supported window', () => {
      expect(
        resolveHiloConfig({ workspaceRoot: root, env: emptyEnv, config: { hilo: { timeoutMs: 1 } } })
          .timeoutMs,
      ).toBe(HILO_TIMEOUT_MIN_MS);
      expect(
        resolveHiloConfig({
          workspaceRoot: root,
          env: emptyEnv,
          config: { hilo: { timeoutMs: HILO_TIMEOUT_MAX_MS * 10 } },
        }).timeoutMs,
      ).toBe(HILO_TIMEOUT_MAX_MS);
    });

    it('falls back to the default timeout for non-numeric / negative values', () => {
      for (const bad of ['abc', -5, 0, null, {}]) {
        const cfg = resolveHiloConfig({
          workspaceRoot: root,
          env: emptyEnv,
          config: { hilo: { timeoutMs: bad } },
        });
        expect(cfg.timeoutMs).toBe(DEFAULT_HILO_TIMEOUT_MS);
      }
    });

    it('never throws on malformed config shapes', () => {
      for (const bad of [null, undefined, 'a string', 42, ['arr'], { hilo: 'nope' }, { hilo: ['x'] }]) {
        expect(() =>
          resolveHiloConfig({ workspaceRoot: root, env: emptyEnv, config: bad }),
        ).not.toThrow();
      }
    });
  });

  describe('loadHiloConfig — disk', () => {
    let tmp: string;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hilo-cfg-'));
    });
    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('returns defaults when no .rorca/config.json exists', () => {
      const cfg = loadHiloConfig(tmp, emptyEnv);
      expect(cfg.enabled).toBe(false);
      expect(cfg.checkoutPath).toBe(path.resolve(tmp));
    });

    it('reads the hilo section from .rorca/config.json', () => {
      fs.mkdirSync(path.join(tmp, '.rorca'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, '.rorca', 'config.json'),
        JSON.stringify({ hilo: { enabled: true, timeoutMs: 30_000 } }),
      );
      const cfg = loadHiloConfig(tmp, emptyEnv);
      expect(cfg.enabled).toBe(true);
      expect(cfg.timeoutMs).toBe(30_000);
    });

    it('degrades to defaults on malformed JSON (never throws)', () => {
      fs.mkdirSync(path.join(tmp, '.rorca'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.rorca', 'config.json'), '{ not valid json');
      expect(() => loadHiloConfig(tmp, emptyEnv)).not.toThrow();
      expect(loadHiloConfig(tmp, emptyEnv).enabled).toBe(false);
    });
  });
});

describe('hilo-detector', () => {
  const root = path.resolve('/tmp/ws');
  const emptyEnv: NodeJS.ProcessEnv = {};

  describe('parseHiloVersion', () => {
    it('extracts version-like tokens from arbitrary output', () => {
      expect(parseHiloVersion('hilo v0.4.2')).toBe('0.4.2');
      expect(parseHiloVersion('0.1.0-beta.1')).toBe('0.1.0-beta.1');
      expect(parseHiloVersion('version 1.2')).toBe('1.2');
    });

    it('returns null safely when there is nothing version-like', () => {
      expect(parseHiloVersion('no numbers here')).toBeNull();
      expect(parseHiloVersion('')).toBeNull();
      expect(parseHiloVersion(undefined as unknown as string)).toBeNull();
    });
  });

  describe('detectHilo', () => {
    it('reports `disabled` (with enable guidance) when not enabled — never throws', async () => {
      const cfg = resolveHiloConfig({ workspaceRoot: root, env: emptyEnv });
      const det = await detectHilo(cfg, { env: emptyEnv });
      expect(det.status).toBe('disabled');
      expect(det.available).toBe(false);
      expect(det.message).toContain(HILO_ENABLE_GUIDANCE);
    });

    it('reports `unavailable` with setup + disable guidance for a missing binary', async () => {
      const cfg = resolveHiloConfig({
        workspaceRoot: root,
        env: emptyEnv,
        config: { hilo: { enabled: true, binaryPath: '/nonexistent/path/to/hilo-binary' } },
      });
      const det = await detectHilo(cfg, { env: emptyEnv });
      expect(det.status).toBe('unavailable');
      expect(det.available).toBe(false);
      expect(det.message).toContain(HILO_SETUP_GUIDANCE);
      expect(det.message).toContain(HILO_DISABLE_GUIDANCE);
    });

    it('reports `available` and parses a version from a real binary probe', async () => {
      // Use the running Node binary as a stand-in: it responds to --version.
      const cfg = resolveHiloConfig({
        workspaceRoot: root,
        env: emptyEnv,
        config: { hilo: { enabled: true, binaryPath: process.execPath } },
      });
      const det = await detectHilo(cfg, { env: emptyEnv });
      expect(det.status).toBe('available');
      expect(det.available).toBe(true);
      expect(det.binaryPath).toBe(path.resolve(process.execPath));
      // Node prints e.g. "v22.3.0" → a version-like token is parsed.
      expect(det.version).toMatch(/^\d+\.\d+/);
    });
  });

  describe('requireHilo', () => {
    it('throws UnprocessableError (with guidance) when unavailable', async () => {
      const cfg = resolveHiloConfig({ workspaceRoot: root, env: emptyEnv });
      const det = await detectHilo(cfg, { env: emptyEnv });
      try {
        requireHilo(det);
        throw new Error('expected requireHilo to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(UnprocessableError);
        expect((err as UnprocessableError).code).toBe('HILO_UNAVAILABLE');
        expect((err as UnprocessableError).statusCode).toBe(422);
      }
    });

    it('does not throw when available', async () => {
      const cfg = resolveHiloConfig({
        workspaceRoot: root,
        env: emptyEnv,
        config: { hilo: { enabled: true, binaryPath: process.execPath } },
      });
      const det = await detectHilo(cfg, { env: emptyEnv });
      expect(() => requireHilo(det)).not.toThrow();
    });
  });
});

describe('hilo — graph-only constraint (no FUSE / xattr / inotify)', () => {
  it('introduces no filesystem-trigger or remote-backend dependency', () => {
    const files = ['hilo-config.ts', 'hilo-detector.ts'].map((f) =>
      fs.readFileSync(path.join(__dirname, '..', f), 'utf-8'),
    );
    // Strip comments so the design-doc prose ("no FUSE mount …") doesn't match.
    const code = files
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const forbidden of [/\bfuse\b/i, /xattr/i, /inotify/i, /chokidar/i, /fs\.watch\b/i, /\.watch\(/]) {
      expect(code).not.toMatch(forbidden);
    }
  });
});
