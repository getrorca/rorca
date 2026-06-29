/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * reconcile-daemon.ts — US-031: bounded daemon mode for local repo reconciliation.
 *
 * Runs where Rorca's working copy lives and periodically reconciles local git
 * history with the Context Intelligence Platform ingestion API (US-032). Each
 * scan:
 *
 *   1. Resolves a `since` ref from the persisted cursor (US-031) or, on the
 *      first run, from the configured {@link SincePolicy}.
 *   2. Lists *new* commits in `since..HEAD`, oldest-first, bounded by
 *      `maxCommits` so a single scan never does unbounded work.
 *   3. Drains the offline {@link CaptureQueue} when the backend is reachable,
 *      then ingests each new commit via {@link ingestCommit} (US-029), which
 *      submits online or queues offline automatically.
 *   4. Advances the cursor to the last commit it accounted for, so the next
 *      scan resumes exactly where this one stopped (no re-processing, no skips).
 *
 * Idempotency is layered:
 *   - the cursor avoids re-listing already-seen commits;
 *   - SHA-based idempotency keys (`commit:<ws>:<sha>` / `candidate:<ws>:<sha>`)
 *     make any accidental re-submission a no-op at the API.
 *
 * Resilience:
 *   - When the API is down, new events/candidates are queued to the local JSONL
 *     buffer and the cursor still advances, so a long outage does not stall
 *     forward progress; the backlog flushes on the next healthy scan.
 *   - `stop()` is graceful: it clears the timer, waits for any in-flight scan
 *     to finish, and (optionally) performs a final queue flush.
 *
 * Status/log output is structured ({@link DaemonLogEntry}) so it is suitable for
 * running under a service supervisor (systemd, launchd, pm2, …).
 *
 * Design doc: docs/context-intelligence-platform.md §2.4, §5 (data flow), §7
 * (local reconciliation daemon).
 */

import * as fs from 'fs';
import * as path from 'path';
import simpleGit, { SimpleGit } from 'simple-git';

import { ingestCommit, type IngestCommitResult } from './ingest-commit';
import { CaptureClient, CaptureQueue, type FlushResult } from './capture-client';
import type { IgnoreMatcher } from './context-safety';

// ════════════════════════════════════════════════════════════════════════════
// Configuration types
// ════════════════════════════════════════════════════════════════════════════

/**
 * Policy that decides the *initial* `since` ref for the very first scan, before
 * a cursor exists. Once a cursor is recorded, subsequent scans always resume
 * from the cursor and this policy is no longer consulted (unless the cursor SHA
 * becomes unreachable, e.g. after a hard reset, in which case it is re-applied).
 *
 *   - `head`  — anchor at the current HEAD and only reconcile commits created
 *               *after* the daemon starts. No backlog is ingested. (default)
 *   - `ref`   — reconcile everything in `<ref>..HEAD` (e.g. `main`, a tag, a SHA).
 *   - `count` — reconcile the most recent `<count>` commits reachable from HEAD.
 *   - `all`   — reconcile the entire history reachable from HEAD.
 */
export interface SincePolicy {
  mode: 'head' | 'ref' | 'count' | 'all';
  /** Required when `mode === 'ref'`. */
  ref?: string;
  /** Required when `mode === 'count'`; must be a positive integer. */
  count?: number;
}

/** Severity for a structured daemon log entry. */
export type DaemonLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** A single structured log line emitted by the daemon. */
export interface DaemonLogEntry {
  /** ISO-8601 timestamp. */
  ts: string;
  level: DaemonLogLevel;
  /** Stable event code (e.g. `scan.start`, `scan.done`, `api.down`). */
  event: string;
  /** Human-readable message. */
  message: string;
  /** Workspace this entry pertains to. */
  workspaceId: string;
  /** Optional structured fields for machine consumption. */
  fields?: Record<string, unknown>;
}

/** Sink for structured log entries. Defaults to a console JSON-line writer. */
export type DaemonLogger = (entry: DaemonLogEntry) => void;

/** Options for {@link ReconcileDaemon}. */
export interface ReconcileDaemonOptions {
  /** Workspace ID this daemon reconciles. */
  workspaceId: string;
  /** Absolute path to the local git repository to scan. */
  repoPath: string;
  /** Rorca backend base URL (e.g. `http://localhost:3030`). */
  apiUrl: string;
  /** Optional API key for auth-gated deployments. */
  apiKey?: string;
  /** Poll interval in milliseconds. Default 60_000. Floored at 1_000. */
  intervalMs?: number;
  /** Initial `since` policy (used until a cursor exists). Default `{ mode: 'head' }`. */
  since?: SincePolicy;
  /** Max commits ingested per scan. Default 100. Floored at 1. */
  maxCommits?: number;
  /**
   * Stop automatically after this many scans (bounded operation). When omitted
   * the daemon runs until {@link ReconcileDaemon.stop} is called.
   */
  maxScans?: number;
  /**
   * Directory for the cursor file. Defaults to `repoPath`. Useful in tests or
   * when the repo working tree must stay pristine.
   */
  cursorDir?: string;
  /** Optional ignore matcher passed through to commit metadata extraction. */
  ignoreMatcher?: IgnoreMatcher;
  /** Structured log sink. Defaults to a console JSON-line writer. */
  logger?: DaemonLogger;
  /** Injected git factory (testing). Defaults to `simple-git`. */
  gitFactory?: (repoPath: string) => SimpleGit;
  /** Injected clock (testing). Defaults to `() => new Date()`. */
  now?: () => Date;
}

// ════════════════════════════════════════════════════════════════════════════
// Cursor persistence
// ════════════════════════════════════════════════════════════════════════════

const CURSOR_FILENAME = '.rorca-reconcile-cursor.json';
const CURSOR_FORMAT_VERSION = 1;

/** Persisted reconciliation cursor for a workspace. */
export interface ReconcileCursor {
  version: number;
  workspaceId: string;
  /** Last commit SHA the daemon has accounted for (ingested or anchored). */
  lastSha: string;
  /** ISO-8601 timestamp of the last cursor update. */
  updatedAt: string;
  /** Total scans recorded against this cursor. */
  scans: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Result / status types
// ════════════════════════════════════════════════════════════════════════════

/** Result of a single scan cycle. */
export interface ScanResult {
  /** The `since` ref used for this scan (a SHA, a ref name, or `null` for full history). */
  since: string | null;
  /** Whether the backend was reachable at scan time. */
  apiHealthy: boolean;
  /** Number of new commits discovered in range (before the maxCommits bound). */
  discovered: number;
  /** Number of commits actually processed this scan (≤ maxCommits). */
  processed: number;
  /** True if more new commits remained than `maxCommits` and were deferred. */
  truncated: boolean;
  /** Context events submitted online this scan. */
  eventsSubmitted: number;
  /** Memory candidates submitted online this scan. */
  candidatesSubmitted: number;
  /** Items (events + candidates) queued offline this scan. */
  queued: number;
  /** Result of draining the offline queue at scan start (null if API was down). */
  flush: FlushResult | null;
  /** The cursor SHA after this scan (unchanged if nothing was accounted for). */
  cursor: string | null;
  /** Per-commit ingest results. */
  commits: IngestCommitResult[];
  /** Non-fatal errors encountered during the scan. */
  errors: string[];
}

/** Operational status snapshot, suitable for a status endpoint or log line. */
export interface DaemonStatus {
  workspaceId: string;
  repoPath: string;
  running: boolean;
  /** Total scans completed since start. */
  scans: number;
  /** ISO-8601 timestamp of the last completed scan, or null. */
  lastScanAt: string | null;
  /** Whether the backend was reachable on the most recent scan. */
  apiHealthy: boolean;
  /** Current cursor SHA, or null if none recorded yet. */
  cursor: string | null;
  /** Cumulative counters across the daemon's lifetime. */
  totals: {
    commitsProcessed: number;
    eventsSubmitted: number;
    candidatesSubmitted: number;
    queued: number;
    errors: number;
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Default logger
// ════════════════════════════════════════════════════════════════════════════

/** Console JSON-line logger — one structured object per line, stable for log shippers. */
export const defaultDaemonLogger: DaemonLogger = (entry) => {
  const line = JSON.stringify(entry);
  if (entry.level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
};

// ════════════════════════════════════════════════════════════════════════════
// ReconcileDaemon
// ════════════════════════════════════════════════════════════════════════════

/**
 * Bounded local-repo reconciliation daemon. Construct with options, then either
 * call {@link scanOnce} for a single cycle or {@link start} to run on an
 * interval until {@link stop} (or `maxScans`) is reached.
 */
export class ReconcileDaemon {
  readonly workspaceId: string;
  readonly repoPath: string;
  readonly apiUrl: string;

  private readonly apiKey?: string;
  private readonly intervalMs: number;
  private readonly since: SincePolicy;
  private readonly maxCommits: number;
  private readonly maxScans?: number;
  private readonly cursorPath: string;
  private readonly ignoreMatcher?: IgnoreMatcher;
  private readonly log: DaemonLogger;
  private readonly gitFactory: (repoPath: string) => SimpleGit;
  private readonly now: () => Date;
  private readonly client: CaptureClient;
  private readonly queue: CaptureQueue;

  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private startResolve: (() => void) | undefined;
  private scanInFlight: Promise<ScanResult> | null = null;
  private scansCompleted = 0;
  private lastScanAt: string | null = null;
  private lastApiHealthy = false;
  private readonly totals = {
    commitsProcessed: 0,
    eventsSubmitted: 0,
    candidatesSubmitted: 0,
    queued: 0,
    errors: 0,
  };

  constructor(options: ReconcileDaemonOptions) {
    this.workspaceId = options.workspaceId;
    this.repoPath = options.repoPath;
    this.apiUrl = options.apiUrl;
    this.apiKey = options.apiKey;
    this.intervalMs = Math.max(1_000, options.intervalMs ?? 60_000);
    this.since = options.since ?? { mode: 'head' };
    this.maxCommits = Math.max(1, Math.floor(options.maxCommits ?? 100));
    this.maxScans = options.maxScans;
    this.cursorPath = path.join(options.cursorDir ?? options.repoPath, CURSOR_FILENAME);
    this.ignoreMatcher = options.ignoreMatcher;
    this.log = options.logger ?? defaultDaemonLogger;
    this.gitFactory = options.gitFactory ?? ((p) => simpleGit(p));
    this.now = options.now ?? (() => new Date());

    if (this.since.mode === 'ref' && !this.since.ref) {
      throw new Error("SincePolicy mode 'ref' requires a 'ref' value");
    }
    if (this.since.mode === 'count' && !(this.since.count && this.since.count > 0)) {
      throw new Error("SincePolicy mode 'count' requires a positive 'count' value");
    }

    this.client = new CaptureClient({ baseUrl: this.apiUrl, apiKey: this.apiKey });
    // The offline queue lives alongside the repo because `ingestCommit` writes
    // its fallback entries to `workspacePath`; the daemon must drain that same
    // file, independent of where the cursor is stored.
    this.queue = new CaptureQueue(options.repoPath);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** True while the interval loop is active. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Start the interval loop. Runs one scan immediately, then every
   * `intervalMs`. Overlapping scans are suppressed (a tick that fires while a
   * scan is still running is skipped). Auto-stops after `maxScans` scans.
   *
   * Resolves once the loop has stopped (either via `maxScans` or {@link stop}).
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.emit('info', 'daemon.start', 'reconcile daemon started', {
      repoPath: this.repoPath,
      intervalMs: this.intervalMs,
      maxCommits: this.maxCommits,
      maxScans: this.maxScans ?? null,
      since: this.since,
    });

    // Fire the first scan immediately rather than waiting a full interval.
    await this.tick();

    if (!this.running) return; // maxScans may have been reached on the first tick

    await new Promise<void>((resolve) => {
      // Stash the resolver so stop() (which clears the timer out-of-band) can
      // settle this promise too — otherwise `await start()` would hang once the
      // interval is cleared.
      this.startResolve = resolve;

      this.timer = setInterval(() => {
        // Suppress overlap: skip this tick if a scan is still running.
        if (this.scanInFlight) {
          this.emit('debug', 'scan.skip', 'previous scan still in flight; skipping tick', {});
          return;
        }
        void this.tick().then(() => {
          if (!this.running) this.settleStart();
        });
      }, this.intervalMs);

      // If stop() ran during the first await, settle immediately.
      if (!this.running) this.settleStart();
    });
  }

  /** Resolve the pending start() promise exactly once and clear the timer. */
  private settleStart(): void {
    this.clearTimer();
    const resolve = this.startResolve;
    this.startResolve = undefined;
    resolve?.();
  }

  /**
   * Gracefully stop the daemon: clear the timer, wait for any in-flight scan to
   * complete, and optionally flush the offline queue one last time.
   */
  async stop(options: { finalFlush?: boolean } = {}): Promise<void> {
    if (!this.running && !this.scanInFlight) return;
    this.running = false;
    this.clearTimer();
    this.emit('info', 'daemon.stopping', 'reconcile daemon stopping; draining in-flight scan', {});

    // Wait for any in-flight scan to settle so we never tear down mid-write.
    if (this.scanInFlight) {
      try {
        await this.scanInFlight;
      } catch {
        /* errors are already logged inside scanOnce */
      }
    }

    if (options.finalFlush) {
      try {
        const healthy = await this.client.health();
        if (healthy) {
          const flush = await this.client.flushQueue(this.queue);
          this.emit('info', 'queue.flush', 'final queue flush on shutdown', {
            succeeded: flush.succeeded,
            failed: flush.failed,
          });
        }
      } catch (err) {
        this.emit('warn', 'queue.flush.error', 'final queue flush failed', {
          error: errMsg(err),
        });
      }
    }

    this.emit('info', 'daemon.stopped', 'reconcile daemon stopped', {
      scans: this.scansCompleted,
      totals: this.totals,
    });

    // Settle any pending start() promise so `await start()` returns after stop().
    this.settleStart();
  }

  /** One interval tick: run a scan, track it, and honor `maxScans`. */
  private async tick(): Promise<void> {
    const p = this.scanOnce();
    this.scanInFlight = p;
    try {
      await p;
    } finally {
      this.scanInFlight = null;
    }
    if (this.maxScans !== undefined && this.scansCompleted >= this.maxScans) {
      this.emit('info', 'daemon.bounded', 'maxScans reached; stopping', {
        maxScans: this.maxScans,
      });
      this.running = false;
      this.clearTimer();
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // ── Scan ──────────────────────────────────────────────────────────────────

  /**
   * Execute a single reconciliation cycle and return its result. Safe to call
   * directly (without {@link start}) for one-shot reconciliation or tests.
   */
  async scanOnce(): Promise<ScanResult> {
    const errors: string[] = [];
    this.emit('debug', 'scan.start', 'scan starting', {});

    // 1. Resolve the `since` ref from the cursor (or the initial policy).
    let since: string | null;
    let headSha: string;
    try {
      headSha = await this.resolveRef('HEAD');
      since = await this.resolveSince();
    } catch (err) {
      const msg = errMsg(err);
      errors.push(msg);
      this.totals.errors += 1;
      this.emit('error', 'scan.error', 'failed to resolve scan range', { error: msg });
      const result = this.emptyResult(null, false, errors);
      this.finishScan(result);
      return result;
    }

    // 2. Check API reachability and drain the offline backlog when healthy.
    const apiHealthy = await this.client.health();
    this.lastApiHealthy = apiHealthy;
    let flush: FlushResult | null = null;
    if (apiHealthy && !this.queue.isEmpty) {
      try {
        flush = await this.client.flushQueue(this.queue);
        this.emit('info', 'queue.flush', 'drained offline queue', {
          succeeded: flush.succeeded,
          failed: flush.failed,
        });
      } catch (err) {
        const msg = errMsg(err);
        errors.push(msg);
        this.emit('warn', 'queue.flush.error', 'queue flush failed', { error: msg });
      }
    } else if (!apiHealthy) {
      this.emit('warn', 'api.down', 'backend unreachable; new commits will be queued offline', {});
    }

    // 3. List new commits, oldest-first, bounded by maxCommits.
    let discovered: string[];
    try {
      discovered = await this.listNewCommits(since);
    } catch (err) {
      const msg = errMsg(err);
      errors.push(msg);
      this.totals.errors += 1;
      this.emit('error', 'scan.error', 'failed to list commits', { error: msg, since });
      const result = this.emptyResult(since, apiHealthy, errors);
      result.flush = flush;
      this.finishScan(result);
      return result;
    }

    const truncated = discovered.length > this.maxCommits;
    const batch = discovered.slice(0, this.maxCommits);
    if (truncated) {
      this.emit('info', 'scan.truncated', 'more new commits than maxCommits; deferring remainder', {
        discovered: discovered.length,
        processing: batch.length,
        maxCommits: this.maxCommits,
      });
    }

    // 4. Ingest each commit (ingestCommit submits online or queues offline).
    const commits: IngestCommitResult[] = [];
    let eventsSubmitted = 0;
    let candidatesSubmitted = 0;
    let queued = 0;
    let lastAccounted: string | null = null;

    for (const sha of batch) {
      try {
        const res = await ingestCommit({
          workspaceId: this.workspaceId,
          workspacePath: this.repoPath,
          backendUrl: this.apiUrl,
          apiKey: this.apiKey,
          sha,
          ignoreMatcher: this.ignoreMatcher,
        });
        commits.push(res);
        if (res.event.created) eventsSubmitted += 1;
        if (res.event.queued) queued += 1;
        for (const c of res.candidates) {
          if (c.created) candidatesSubmitted += 1;
          if (c.queued) queued += 1;
        }
        // Account for this commit even when queued offline — the queue
        // guarantees eventual delivery, so the cursor may safely advance.
        lastAccounted = sha;
      } catch (err) {
        const msg = errMsg(err);
        errors.push(`commit ${sha.slice(0, 8)}: ${msg}`);
        this.totals.errors += 1;
        this.emit('error', 'commit.error', 'failed to ingest commit', {
          sha,
          error: msg,
        });
        // Stop advancing past a commit we failed to account for, so the next
        // scan retries it instead of silently skipping.
        break;
      }
    }

    // 5. Advance the cursor.
    //    - If we accounted for commits, the cursor moves to the last of them.
    //    - If nothing was processed and no cursor exists yet, anchor at HEAD so
    //      future scans only see genuinely new commits (matches `head` policy).
    let cursorSha: string | null = lastAccounted;
    const existing = this.readCursor();
    if (!cursorSha) {
      cursorSha = existing?.lastSha ?? (errors.length === 0 ? headSha : null);
    }
    if (cursorSha) {
      this.writeCursor(cursorSha, (existing?.scans ?? 0) + 1);
    }

    this.totals.commitsProcessed += commits.length;
    this.totals.eventsSubmitted += eventsSubmitted;
    this.totals.candidatesSubmitted += candidatesSubmitted;
    this.totals.queued += queued;

    const result: ScanResult = {
      since,
      apiHealthy,
      discovered: discovered.length,
      processed: batch.length,
      truncated,
      eventsSubmitted,
      candidatesSubmitted,
      queued,
      flush,
      cursor: cursorSha,
      commits,
      errors,
    };

    this.emit('info', 'scan.done', 'scan complete', {
      since,
      apiHealthy,
      discovered: discovered.length,
      processed: batch.length,
      truncated,
      eventsSubmitted,
      candidatesSubmitted,
      queued,
      cursor: cursorSha,
      errors: errors.length,
    });

    this.finishScan(result);
    return result;
  }

  private finishScan(_result: ScanResult): void {
    this.scansCompleted += 1;
    this.lastScanAt = this.now().toISOString();
  }

  // ── Status ────────────────────────────────────────────────────────────────

  /** Snapshot of operational status, suitable for logs or a status endpoint. */
  getStatus(): DaemonStatus {
    return {
      workspaceId: this.workspaceId,
      repoPath: this.repoPath,
      running: this.running,
      scans: this.scansCompleted,
      lastScanAt: this.lastScanAt,
      apiHealthy: this.lastApiHealthy,
      cursor: this.readCursor()?.lastSha ?? null,
      totals: { ...this.totals },
    };
  }

  // ── Git helpers ─────────────────────────────────────────────────────────────

  /** Resolve a ref to a full SHA, throwing if the repo or ref is invalid. */
  private async resolveRef(ref: string): Promise<string> {
    const git = this.gitFactory(this.repoPath);
    if (!(await git.checkIsRepo())) {
      throw new Error(`Not a git repository: ${this.repoPath}`);
    }
    const sha = (await git.raw(['rev-parse', '--verify', ref])).trim();
    if (!sha) throw new Error(`Cannot resolve ref: ${ref}`);
    return sha;
  }

  /** True if a SHA is a real, reachable object in the repo. */
  private async shaExists(sha: string): Promise<boolean> {
    try {
      const git = this.gitFactory(this.repoPath);
      const type = (await git.raw(['cat-file', '-t', sha])).trim();
      return type === 'commit';
    } catch {
      return false;
    }
  }

  /**
   * Resolve the `since` boundary for this scan. Prefer the persisted cursor;
   * fall back to the configured policy when there is no cursor (first run) or
   * when the cursor SHA is no longer reachable (e.g. after a hard reset).
   * Returns `null` to mean "entire history reachable from HEAD".
   */
  private async resolveSince(): Promise<string | null> {
    const cursor = this.readCursor();
    if (cursor?.lastSha && (await this.shaExists(cursor.lastSha))) {
      return cursor.lastSha;
    }
    if (cursor?.lastSha) {
      this.emit('warn', 'cursor.stale', 'cursor SHA unreachable; re-applying since policy', {
        cursor: cursor.lastSha,
      });
    }
    return this.resolveInitialSince();
  }

  /** Resolve the initial `since` ref from the configured policy. */
  private async resolveInitialSince(): Promise<string | null> {
    switch (this.since.mode) {
      case 'head':
        // Anchor at HEAD: nothing before "now" is reconciled.
        return this.resolveRef('HEAD');
      case 'ref':
        return this.since.ref!;
      case 'count': {
        // HEAD~count, clamped to the root if history is shorter.
        try {
          return await this.resolveRef(`HEAD~${this.since.count}`);
        } catch {
          // Fewer than `count` commits exist — reconcile the whole history.
          return null;
        }
      }
      case 'all':
        return null;
      default:
        return this.resolveRef('HEAD');
    }
  }

  /**
   * List new commit SHAs in `since..HEAD`, oldest-first and de-duplicated.
   * `since === null` lists the full history reachable from HEAD. The result is
   * NOT bounded here — the caller slices it to `maxCommits`.
   */
  private async listNewCommits(since: string | null): Promise<string[]> {
    const git = this.gitFactory(this.repoPath);
    if (!(await git.checkIsRepo())) {
      throw new Error(`Not a git repository: ${this.repoPath}`);
    }

    const log = since === null
      ? await git.log()
      : await git.log({ from: since, to: 'HEAD' });

    // `git.log` returns newest-first; reverse to oldest-first so the cursor
    // advances monotonically as commits are ingested.
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const c of [...log.all].reverse()) {
      if (!seen.has(c.hash)) {
        seen.add(c.hash);
        ordered.push(c.hash);
      }
    }
    return ordered;
  }

  // ── Cursor persistence ──────────────────────────────────────────────────────

  /** Read the persisted cursor, or null if none/invalid. */
  readCursor(): ReconcileCursor | null {
    try {
      const raw = fs.readFileSync(this.cursorPath, 'utf8');
      const parsed = JSON.parse(raw) as ReconcileCursor;
      if (
        parsed &&
        typeof parsed.lastSha === 'string' &&
        parsed.workspaceId === this.workspaceId
      ) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Atomically persist the cursor (temp-file + rename). */
  private writeCursor(lastSha: string, scans: number): void {
    const cursor: ReconcileCursor = {
      version: CURSOR_FORMAT_VERSION,
      workspaceId: this.workspaceId,
      lastSha,
      updatedAt: this.now().toISOString(),
      scans,
    };
    const tmp = this.cursorPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cursor, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, this.cursorPath);
  }

  // ── Logging ─────────────────────────────────────────────────────────────────

  private emit(
    level: DaemonLogLevel,
    event: string,
    message: string,
    fields: Record<string, unknown>,
  ): void {
    this.log({
      ts: this.now().toISOString(),
      level,
      event,
      message,
      workspaceId: this.workspaceId,
      fields,
    });
  }

  private emptyResult(
    since: string | null,
    apiHealthy: boolean,
    errors: string[],
  ): ScanResult {
    return {
      since,
      apiHealthy,
      discovered: 0,
      processed: 0,
      truncated: false,
      eventsSubmitted: 0,
      candidatesSubmitted: 0,
      queued: 0,
      flush: null,
      cursor: this.readCursor()?.lastSha ?? null,
      commits: [],
      errors,
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
