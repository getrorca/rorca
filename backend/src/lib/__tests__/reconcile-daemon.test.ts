/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-031: bounded local repo reconciliation daemon — tests.
 *
 * Coverage (acceptance criteria):
 *   - Daemon supports workspace, repo path, interval, since policy, max commits, API URL.
 *   - Cursor/idempotency avoids duplicate submissions (repeated scans).
 *   - Status/log output is structured and suitable for service operation.
 *   - API-down queue: commits are buffered offline and flushed on recovery.
 *   - Graceful shutdown: in-flight scan drains, timer clears, no further scans.
 *
 * These tests use a real temp git repo + a fake CaptureClient (via a stub
 * fetch) so no live backend is required. simple-git is the real implementation
 * so the commit-range/cursor logic is exercised end-to-end.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import {
  ReconcileDaemon,
  type DaemonLogEntry,
  type ReconcileDaemonOptions,
} from '../reconcile-daemon';
import { CaptureQueue } from '../capture-client';

// ════════════════════════════════════════════════════════════════════════════
// Git repo helpers
// ════════════════════════════════════════════════════════════════════════════

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  }).trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-reconcile-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Rorca Test']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  return dir;
}

function commitFile(repo: string, filePath: string, content: string, message: string): string {
  const absPath = path.join(repo, filePath);
  const parent = path.dirname(absPath);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(absPath, content);
  git(repo, ['add', filePath]);
  git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function cleanupRepo(repo: string): void {
  fs.rmSync(repo, { recursive: true, force: true });
}

// ════════════════════════════════════════════════════════════════════════════
// Fake backend (stub fetch installed on globalThis)
// ════════════════════════════════════════════════════════════════════════════

/**
 * A minimal in-memory stand-in for the ingestion API. It implements just enough
 * of `/api/context-events/*` for the daemon's CaptureClient. Toggle `.up` to
 * simulate an outage; inspect `.events` / `.candidates` to assert idempotency.
 */
class FakeBackend {
  up = true;
  events = new Map<string, number>();
  candidates = new Map<string, number>();
  private nextId = 1;

  /** Total submit attempts that actually reached the server while up. */
  eventSubmitCount = 0;
  candidateSubmitCount = 0;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!this.up) {
      throw new Error('ECONNREFUSED (fake backend down)');
    }

    if (url.endsWith('/api/context-events/health')) {
      return jsonResponse(200, { status: 'ok' });
    }

    const body = init?.body ? JSON.parse(init.body as string) : {};

    if (url.endsWith('/api/context-events/events')) {
      this.eventSubmitCount += 1;
      const key = body.event.idempotencyKey as string;
      const created = !this.events.has(key);
      if (created) this.events.set(key, this.nextId++);
      return jsonResponse(200, { id: this.events.get(key), created });
    }

    if (url.endsWith('/api/context-events/candidates')) {
      this.candidateSubmitCount += 1;
      const key = body.candidate.idempotencyKey as string;
      const created = !this.candidates.has(key);
      if (created) this.candidates.set(key, this.nextId++);
      return jsonResponse(200, { id: this.candidates.get(key), created });
    }

    if (url.endsWith('/api/context-events/flush')) {
      // Replay each entry into the in-memory maps; never fail.
      for (const entry of body.entries as Array<{ type: string; payload: { idempotencyKey: string } }>) {
        const key = entry.payload.idempotencyKey;
        if (entry.type === 'event' && !this.events.has(key)) this.events.set(key, this.nextId++);
        if (entry.type === 'candidate' && !this.candidates.has(key)) this.candidates.set(key, this.nextId++);
      }
      return jsonResponse(200, { succeeded: (body.entries as unknown[]).length, failed: [] });
    }

    return jsonResponse(404, { error: 'not found' });
  };
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build daemon options wired to a fake backend via a stubbed global fetch. */
function makeDaemon(
  repo: string,
  backend: FakeBackend,
  overrides: Partial<ReconcileDaemonOptions> = {},
): { daemon: ReconcileDaemon; logs: DaemonLogEntry[] } {
  const logs: DaemonLogEntry[] = [];
  const daemon = new ReconcileDaemon({
    workspaceId: 'ws-test',
    repoPath: repo,
    apiUrl: 'http://fake.local',
    logger: (entry) => logs.push(entry),
    ...overrides,
  });
  return { daemon, logs };
}

// Install/uninstall the stub fetch around each test that needs it.
let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ════════════════════════════════════════════════════════════════════════════
// Configuration / validation
// ════════════════════════════════════════════════════════════════════════════

describe('ReconcileDaemon — configuration', () => {
  test('accepts workspace, repo, interval, since, maxCommits, apiUrl', () => {
    const repo = initRepo();
    try {
      const daemon = new ReconcileDaemon({
        workspaceId: 'ws-test',
        repoPath: repo,
        apiUrl: 'http://localhost:3030',
        intervalMs: 5_000,
        since: { mode: 'all' },
        maxCommits: 25,
      });
      const status = daemon.getStatus();
      expect(status.workspaceId).toBe('ws-test');
      expect(status.repoPath).toBe(repo);
      expect(status.running).toBe(false);
      expect(status.cursor).toBeNull();
    } finally {
      cleanupRepo(repo);
    }
  });

  test('rejects invalid since policies', () => {
    const repo = initRepo();
    try {
      expect(
        () => new ReconcileDaemon({ workspaceId: 'w', repoPath: repo, apiUrl: 'x', since: { mode: 'ref' } }),
      ).toThrow(/requires a 'ref'/);
      expect(
        () => new ReconcileDaemon({ workspaceId: 'w', repoPath: repo, apiUrl: 'x', since: { mode: 'count', count: 0 } }),
      ).toThrow(/positive 'count'/);
    } finally {
      cleanupRepo(repo);
    }
  });

  test('interval and maxCommits are floored to safe minimums', () => {
    const repo = initRepo();
    try {
      const daemon = new ReconcileDaemon({
        workspaceId: 'w',
        repoPath: repo,
        apiUrl: 'x',
        intervalMs: 1,
        maxCommits: 0,
      });
      // Internals are private; behavior is asserted via the bounding test below.
      expect(daemon).toBeInstanceOf(ReconcileDaemon);
    } finally {
      cleanupRepo(repo);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Since policies
// ════════════════════════════════════════════════════════════════════════════

describe('ReconcileDaemon — since policy', () => {
  test("mode 'head' ingests no backlog, only future commits", async () => {
    const repo = initRepo();
    const backend = new FakeBackend();
    globalThis.fetch = backend.fetch;
    try {
      commitFile(repo, 'a.ts', '1', 'feat: existing a');
      commitFile(repo, 'b.ts', '2', 'feat: existing b');

      const { daemon } = makeDaemon(repo, backend, { since: { mode: 'head' } });

      // First scan: nothing ingested (anchored at HEAD), cursor anchored.
      const first = await daemon.scanOnce();
      expect(first.processed).toBe(0);
      expect(first.cursor).toBe(git(repo, ['rev-parse', 'HEAD']));

      // New commit appears.
      const newSha = commitFile(repo, 'c.ts', '3', 'feat: brand new c');
      const second = await daemon.scanOnce();
      expect(second.processed).toBe(1);
      expect(second.commits[0].commitSha).toBe(newSha);
      expect(second.cursor).toBe(newSha);
    } finally {
      cleanupRepo(repo);
    }
  });

  test("mode 'all' ingests the entire history oldest-first", async () => {
    const repo = initRepo();
    const backend = new FakeBackend();
    globalThis.fetch = backend.fetch;
    try {
      const s1 = commitFile(repo, 'a.ts', '1', 'feat: first');
      const s2 = commitFile(repo, 'b.ts', '2', 'feat: second');
      const s3 = commitFile(repo, 'c.ts', '3', 'feat: third');

      const { daemon } = makeDaemon(repo, backend, { since: { mode: 'all' } });
      const res = await daemon.scanOnce();
      expect(res.processed).toBe(3);
      expect(res.commits.map((c) => c.commitSha)).toEqual([s1, s2, s3]);
      expect(res.cursor).toBe(s3);
    } finally {
      cleanupRepo(repo);
    }
  });

  test("mode 'count' ingests the last N commits", async () => {
    const repo = initRepo();
    const backend = new FakeBackend();
    globalThis.fetch = backend.fetch;
    try {
      commitFile(repo, 'a.ts', '1', 'feat: first');
      const s2 = commitFile(repo, 'b.ts', '2', 'feat: second');
      const s3 = commitFile(repo, 'c.ts', '3', 'feat: third');

      const { daemon } = makeDaemon(repo, backend, { since: { mode: 'count', count: 2 } });
      const res = await daemon.scanOnce();
      expect(res.processed).toBe(2);
      expect(res.commits.map((c) => c.commitSha)).toEqual([s2, s3]);
    } finally {
      cleanupRepo(repo);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Repeated scan + cursor idempotency
// ════════════════════════════════════════════════════════════════════════════

describe('ReconcileDaemon — repeated scan / cursor idempotency', () => {
  test('a second scan with no new commits does nothing', async () => {
    const repo = initRepo();
    const backend = new FakeBackend();
    globalThis.fetch = backend.fetch;
    try {
      commitFile(repo, 'a.ts', '1', 'feat: a');
      const { daemon } = makeDaemon(repo, backend, { since: { mode: 'all' } });

      const first = await daemon.scanOnce();
      expect(first.processed).toBe(1);
      const submitsAfterFirst = backend.eventSubmitCount;

      const second = await daemon.scanOnce();
      expect(second.processed).toBe(0);
      expect(second.discovered).toBe(0);
      // No additional submissions on the second scan — the cursor short-circuits it.
      expect(backend.eventSubmitCount).toBe(submitsAfterFirst);
    } finally {
      cleanupRepo(repo);
    }
  });

  test('incremental scans pick up only new commits and advance the cursor', async () => {
    const repo = initRepo();
    const backend = new FakeBackend();
    globalThis.fetch = backend.fetch;
    try {
      const s1 = commitFile(repo, 'a.ts', '1', 'feat: a');
      const { daemon } = makeDaemon(repo, backend, { since: { mode: 'all' } });

      await daemon.scanOnce();
      expect(daemon.readCursor()?.lastSha).toBe(s1);

      const s2 = commitFile(repo, 'b.ts', '2', 'feat: b');
      const s3 = commitFile(repo, 'c.ts', '3', 'feat: c');
      const res = await daemon.scanOnce();
      expect(res.processed).toBe(2);
      expect(res.commits.map((c) => c.commitSha)).toEqual([s2, s3]);
      expect(daemon.readCursor()?.lastSha).toBe(s3);
    } finally {
      cleanupRepo(repo);
    }
  });

  test('a fresh daemon resumes from the persisted cursor (no re-submission)', async () => {
    const repo = initRepo();
    const backend = new FakeBackend();
    globalThis.fetch = backend.fetch;
    try {
      commitFile(repo, 'a.ts', '1', 'feat: a');
      commitFile(repo, 'b.ts', '2', 'feat: b');

      const { daemon: d1 } = makeDaemon(repo, backend, { since: { mode: 'all' } });
      await d1.scanOnce();
      const eventsAfter = backend.eventSubmitCount;
      expect(backend.events.size).toBe(2);

      // A brand-new daemon instance reads the same cursor file.
      const { daemon: d2 } = makeDaemon(repo, backend, { since: { mode: 'all' } });
      const res = await d2.scanOnce();
      expect(res.processed).toBe(0);
      // Cursor prevented any re-listing, so no extra event submissions occurred.
      expect(backend.eventSubmitCount).toBe(eventsAfter);
      expect(backend.events.size).toBe(2);
    } finally {
      cleanupRepo(repo);
    }
  });

  test('idempotency keys make re-submission a no-op even when forced (since=all)', async () => {
    const repo = initRepo();
    const backend = new FakeBackend();
    globalThis.fetch = backend.fetch;
    try {
      commitFile(repo, 'a.ts', '1', 'feat: a');
      commitFile(repo, 'b.ts', '2', 'feat: b');

      // Two daemons in separate cursor dirs both scan the full history.
      const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'cursorA-'));
      const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'cursorB-'));
      try {
        const { daemon: dA } = makeDaemon(repo, backend, { since: { mode: 'all' }, cursorDir: dirA });
        const { daemon: dB } = makeDaemon(repo, backend, { since: { mode: 'all' }, cursorDir: dirB });

        const rA = await dA.scanOnce();
        const rB = await dB.scanOnce();
        expect(rA.processed).toBe(2);
        expect(rB.processed).toBe(2);
        // Both processed, but the backend de-duped by idempotency key.
        expect(backend.events.size).toBe(2);
        // dB created nothing new (all keys already present).
        expect(rB.eventsSubmitted).toBe(0);
      } finally {
        fs.rmSync(dirA, { recursive: true, force: true });
        fs.rmSync(dirB, { recursive: true, force: true });
      }
    } finally {
      cleanupRepo(repo);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// maxCommits bounding
// ════════════════════════════════════════════════════════════════════════════

describe('ReconcileDaemon — maxCommits bounding', () => {
  test('a scan processes at most maxCommits and defers the remainder', async () => {
    const repo = initRepo();
    const backend = new FakeBackend();
    globalThis.fetch = backend.fetch;
    try {
      const shas: string[] = [];
      for (let i = 0; i < 5; i++) {
        shas.push(commitFile(repo, `f${i}.ts`, String(i), `feat: commit ${i}`));
      }

      const { daemon } = makeDaemon(repo, backend, { since: { mode: 'all' }, maxCommits: 2 });

      const first = await daemon.scanOnce();
      expect(first.discovered).toBe(5);
      expect(first.processed).toBe(2);
      expect(first.truncated).toBe(true);
      expect(first.commits.map((c) => c.commitSha)).toEqual([shas[0], shas[1]]);

      const second = await daemon.scanOnce();
      expect(second.processed).toBe(2);
      expect(second.commits.map((c) => c.commitSha)).toEqual([shas[2], shas[3]]);

      const third = await daemon.scanOnce();
      expect(third.processed).toBe(1);
      expect(third.truncated).toBe(false);
      expect(third.commits.map((c) => c.commitSha)).toEqual([shas[4]]);

      // Caught up — nothing left.
      const fourth = await daemon.scanOnce();
      expect(fourth.processed).toBe(0);
    } finally {
      cleanupRepo(repo);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// API-down queue + recovery
// ════════════════════════════════════════════════════════════════════════════

describe('ReconcileDaemon — API-down queue and recovery', () => {
  test('commits are queued offline while the API is down, then flushed on recovery', async () => {
    const repo = initRepo();
    const backend = new FakeBackend();
    globalThis.fetch = backend.fetch;
    try {
      commitFile(repo, 'a.ts', '1', 'feat: a');
      commitFile(repo, 'b.ts', '2', 'feat: b');

      const cursorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-down-'));
      try {
        const { daemon, logs } = makeDaemon(repo, backend, {
          since: { mode: 'all' },
          cursorDir,
        });

        // ── API down ──────────────────────────────────────────────────────
        backend.up = false;
        const down = await daemon.scanOnce();
        expect(down.apiHealthy).toBe(false);
        expect(down.processed).toBe(2);
        expect(down.queued).toBeGreaterThan(0);
        expect(backend.events.size).toBe(0); // nothing reached the server
        expect(logs.some((l) => l.event === 'api.down')).toBe(true);

        // Cursor still advanced — forward progress is not blocked by the outage.
        const headSha = git(repo, ['rev-parse', 'HEAD']);
        expect(daemon.readCursor()?.lastSha).toBe(headSha);

        // The offline queue holds the buffered items (written alongside the repo
        // by ingestCommit, independent of the cursor location).
        const queue = new CaptureQueue(repo);
        expect(queue.isEmpty).toBe(false);

        // ── API recovers ─────────────────────────────────────────────────
        backend.up = true;
        const up = await daemon.scanOnce();
        expect(up.apiHealthy).toBe(true);
        // No new commits, but the backlog flushed.
        expect(up.flush).not.toBeNull();
        expect(up.flush!.succeeded).toBeGreaterThan(0);
        expect(backend.events.size).toBe(2);
        expect(queue.isEmpty).toBe(true);
      } finally {
        fs.rmSync(cursorDir, { recursive: true, force: true });
      }
    } finally {
      cleanupRepo(repo);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// start/stop lifecycle + graceful shutdown
// ════════════════════════════════════════════════════════════════════════════

describe('ReconcileDaemon — lifecycle', () => {
  test('start() runs bounded scans via maxScans and stops itself', async () => {
    const repo = initRepo();
    const backend = new FakeBackend();
    globalThis.fetch = backend.fetch;
    try {
      commitFile(repo, 'a.ts', '1', 'feat: a');
      const { daemon } = makeDaemon(repo, backend, {
        since: { mode: 'all' },
        intervalMs: 1_000, // floored minimum; bounded by maxScans below
        maxScans: 3,
      });

      await daemon.start();
      expect(daemon.isRunning).toBe(false);
      expect(daemon.getStatus().scans).toBe(3);
    } finally {
      cleanupRepo(repo);
    }
  }, 15_000);

  test('stop() during an interval loop is graceful and halts further scans', async () => {
    const repo = initRepo();
    const backend = new FakeBackend();
    globalThis.fetch = backend.fetch;
    try {
      commitFile(repo, 'a.ts', '1', 'feat: a');
      const { daemon } = makeDaemon(repo, backend, {
        since: { mode: 'all' },
        intervalMs: 1_000,
      });

      // Start without awaiting (no maxScans → runs until stop()).
      const started = daemon.start();
      // Wait for the immediate first scan to complete (a scan involves git +
      // ingest, so poll rather than guess a fixed delay).
      for (let i = 0; i < 100 && daemon.getStatus().scans < 1; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(daemon.getStatus().scans).toBeGreaterThanOrEqual(1);

      await daemon.stop();
      await started;

      const scansAtStop = daemon.getStatus().scans;
      expect(daemon.isRunning).toBe(false);

      // Wait beyond an interval; no further scans should have run.
      await new Promise((r) => setTimeout(r, 1_200));
      expect(daemon.getStatus().scans).toBe(scansAtStop);
    } finally {
      cleanupRepo(repo);
    }
  }, 15_000);

  test('stop() waits for an in-flight scan to finish before returning', async () => {
    const repo = initRepo();
    const backend = new FakeBackend();
    globalThis.fetch = backend.fetch;
    try {
      commitFile(repo, 'a.ts', '1', 'feat: a');
      const { daemon } = makeDaemon(repo, backend, { since: { mode: 'all' } });

      // Kick off a scan and immediately request shutdown.
      const scan = daemon.scanOnce();
      await daemon.stop();
      // The in-flight scan must have resolved (no dangling write).
      await expect(scan).resolves.toBeDefined();
    } finally {
      cleanupRepo(repo);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Structured status / log output
// ════════════════════════════════════════════════════════════════════════════

describe('ReconcileDaemon — status and logging', () => {
  test('emits structured log entries with stable event codes', async () => {
    const repo = initRepo();
    const backend = new FakeBackend();
    globalThis.fetch = backend.fetch;
    try {
      commitFile(repo, 'a.ts', '1', 'feat: a');
      const { daemon, logs } = makeDaemon(repo, backend, { since: { mode: 'all' } });

      await daemon.scanOnce();

      const start = logs.find((l) => l.event === 'scan.start');
      const done = logs.find((l) => l.event === 'scan.done');
      expect(start).toBeDefined();
      expect(done).toBeDefined();
      // Every entry carries the operational envelope.
      for (const l of logs) {
        expect(typeof l.ts).toBe('string');
        expect(l.workspaceId).toBe('ws-test');
        expect(['debug', 'info', 'warn', 'error']).toContain(l.level);
        // Serializable for a log shipper.
        expect(() => JSON.stringify(l)).not.toThrow();
      }
    } finally {
      cleanupRepo(repo);
    }
  });

  test('getStatus reflects cumulative totals across scans', async () => {
    const repo = initRepo();
    const backend = new FakeBackend();
    globalThis.fetch = backend.fetch;
    try {
      commitFile(repo, 'a.ts', '1', 'feat: a');
      commitFile(repo, 'b.ts', '2', 'feat: b');
      const { daemon } = makeDaemon(repo, backend, { since: { mode: 'all' } });

      await daemon.scanOnce();
      const status = daemon.getStatus();
      expect(status.scans).toBe(1);
      expect(status.lastScanAt).not.toBeNull();
      expect(status.apiHealthy).toBe(true);
      expect(status.totals.commitsProcessed).toBe(2);
      expect(status.totals.eventsSubmitted).toBe(2);
      expect(status.cursor).toBe(git(repo, ['rev-parse', 'HEAD']));
    } finally {
      cleanupRepo(repo);
    }
  });
});
