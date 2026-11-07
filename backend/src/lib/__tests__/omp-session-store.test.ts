/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  defaultOperatorHomeDir,
  OmpSessionStore,
  OMP_SESSION_FILE_MODE,
  OMP_SESSION_STORE_ROOT_ENV,
  ompSessionFileName,
  ompSessionNamespaceDir,
} from '../omp-session-store';

describe('omp-session-store', () => {
  const sessionId = '019fee5a-51ed-7000-a759-a20a97e3e1ee';
  const startedAt = new Date('2026-08-11T01:05:24.461Z');

  let root: string;
  let home: string;
  let tmp: string;
  let sessionsRoot: string;
  let store: OmpSessionStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-omp-session-store-'));
    home = path.join(root, 'home');
    tmp = path.join(root, 'tmp');
    sessionsRoot = path.join(root, 'sessions');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(tmp, { recursive: true });
    store = new OmpSessionStore({
      sessionsRoot,
      homeDir: home,
      tmpDir: tmp,
      now: () => startedAt,
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('names session files with omp convention in the per-cwd namespace dir', () => {
    const cwd = path.join(home, 'proj', 'my-app');
    fs.mkdirSync(cwd, { recursive: true });

    const filePath = store.open(sessionId, cwd);

    expect(path.dirname(filePath)).toBe(path.join(sessionsRoot, '-proj-my-app'));
    expect(path.basename(filePath)).toBe('2026-08-11T01-05-24-461Z_019fee5a-51ed-7000-a759-a20a97e3e1ee.jsonl');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(store.filePathFor(sessionId)).toBe(filePath);
    // omp's session listings require a `session` header entry first (within
    // the first 4096 bytes) — the store writes it on creation.
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8').split('\n')[0])).toEqual({
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-08-11T01:05:24.461Z',
      cwd: cwd,
    });
  });

  test('default sessions root resolves to the operator home, not a redirected $HOME', () => {
    const previousRoot = process.env[OMP_SESSION_STORE_ROOT_ENV];
    delete process.env[OMP_SESSION_STORE_ROOT_ENV];
    try {
      const defaults = new OmpSessionStore();
      const operatorHome = defaultOperatorHomeDir();
      expect(defaults.sessionsRoot).toBe(path.join(operatorHome, '.omp', 'profiles', 'rorca', 'agent', 'sessions'));
      expect(operatorHome).not.toBe('');
    } finally {
      if (previousRoot === undefined) delete process.env[OMP_SESSION_STORE_ROOT_ENV];
      else process.env[OMP_SESSION_STORE_ROOT_ENV] = previousRoot;
    }
  });

  test('RORCA_OMP_SESSION_STORE_ROOT overrides the default sessions root', () => {
    const previousRoot = process.env[OMP_SESSION_STORE_ROOT_ENV];
    const tempRoot = path.join(root, 'env-store-root');
    process.env[OMP_SESSION_STORE_ROOT_ENV] = tempRoot;
    try {
      const storeWithOverride = new OmpSessionStore();
      expect(storeWithOverride.sessionsRoot).toBe(tempRoot);
      expect(path.resolve(storeWithOverride.sessionsRoot)).toBe(path.resolve(tempRoot));
    } finally {
      if (previousRoot === undefined) delete process.env[OMP_SESSION_STORE_ROOT_ENV];
      else process.env[OMP_SESSION_STORE_ROOT_ENV] = previousRoot;
    }
  });

  test('ompSessionFileName matches the omp timestamp_sessionId.jsonl convention', () => {
    expect(ompSessionFileName(sessionId, startedAt)).toBe(
      '2026-08-11T01-05-24-461Z_019fee5a-51ed-7000-a759-a20a97e3e1ee.jsonl',
    );
  });

  test('ompSessionNamespaceDir mirrors omp home/tmp/absolute encodings', () => {
    expect(ompSessionNamespaceDir(path.join(home, 'a', 'b'), home, tmp)).toBe('-a-b');
    expect(ompSessionNamespaceDir(home, home, tmp)).toBe('-');
    expect(ompSessionNamespaceDir(path.join(tmp, 'lane-x'), home, tmp)).toBe('-tmp-lane-x');
    expect(ompSessionNamespaceDir(tmp, home, tmp)).toBe('-tmp');

    const outside = path.join(root, 'elsewhere', 'deep');
    fs.mkdirSync(outside, { recursive: true });
    const expected = `--${outside.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
    expect(ompSessionNamespaceDir(outside, home, tmp)).toBe(expected);
  });

  test('creates session files with 0600 permissions', () => {
    const cwd = path.join(home, 'proj');
    fs.mkdirSync(cwd, { recursive: true });

    const filePath = store.open(sessionId, cwd);

    expect(fs.statSync(filePath).mode & 0o777).toBe(OMP_SESSION_FILE_MODE);
  });

  test('open/close are idempotent: duplicate session_started never duplicates content', () => {
    const cwd = path.join(home, 'proj');
    fs.mkdirSync(cwd, { recursive: true });

    const first = store.open(sessionId, cwd);
    const duplicate = store.open(sessionId, cwd); // duplicate session_started
    expect(duplicate).toBe(first);

    store.append(sessionId, '{"type":"evt","n":1}\n');
    store.append(sessionId, '{"type":"evt","n":2}\n');

    store.close(sessionId);
    store.close(sessionId); // second close is a no-op

    const reopened = store.open(sessionId, cwd); // same session, same clock
    expect(reopened).toBe(first);
    store.append(sessionId, '{"type":"evt","n":3}\n');
    store.close(sessionId);

    store.append(sessionId, '{"type":"evt","n":4}\n'); // append after close is dropped

    const lines = fs.readFileSync(first, 'utf8').split('\n').filter(Boolean);
    expect(lines.filter((line) => JSON.parse(line).type === 'session')).toHaveLength(1);
    expect(lines).toEqual([
      '{"type":"session","version":3,"id":"019fee5a-51ed-7000-a759-a20a97e3e1ee","timestamp":"2026-08-11T01:05:24.461Z","cwd":"' + cwd + '"}',
      '{"type":"evt","n":1}',
      '{"type":"evt","n":2}',
      '{"type":"evt","n":3}',
    ]);
  });

  test('preserves append ordering', () => {
    const cwd = path.join(home, 'proj');
    fs.mkdirSync(cwd, { recursive: true });

    const filePath = store.open(sessionId, cwd);
    const lines = Array.from({ length: 200 }, (_, i) => `{"type":"evt","n":${i}}`);
    for (const line of lines) {
      store.append(sessionId, `${line}\n`);
    }
    store.close(sessionId);

    const written = fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .filter((line) => JSON.parse(line).type !== 'session');
    expect(written).toEqual(lines);
  });

  test('refuses to follow symlinks for the namespace dir and the session file', () => {
    const cwd = path.join(home, 'proj');
    fs.mkdirSync(cwd, { recursive: true });

    // Namespace dir is a symlink -> open refuses.
    const namespaceDir = path.join(sessionsRoot, '-proj');
    fs.mkdirSync(sessionsRoot, { recursive: true });
    fs.symlinkSync(home, namespaceDir);
    expect(() => store.open(sessionId, cwd)).toThrow(/symlink/i);
    fs.unlinkSync(namespaceDir);

    // Session file path is a symlink -> open refuses (and does not write through it).
    const filePath = store.open(sessionId, cwd);
    store.close(sessionId);
    const target = path.join(home, 'outside.jsonl');
    fs.unlinkSync(filePath);
    fs.symlinkSync(target, filePath);
    expect(() => store.open(sessionId, cwd)).toThrow(/symlink/i);
    expect(fs.existsSync(target)).toBe(false);
  });
});
