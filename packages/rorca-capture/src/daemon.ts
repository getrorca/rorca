import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import path from "node:path";
import {
  CaptureApiError,
  CaptureNetworkError,
  createApiClient,
  createCaptureClient,
  formatCaptureError,
  resolveWorkspace,
  type CaptureFetch,
  type ResolvedWorkspace,
  type ReusableCaptureClient,
} from "./api.js";
import type { CaptureConfig } from "./config.js";
import { readCaptureQueue, enqueueCaptureQueueEntry, sanitizeCaptureErrorMessage } from "./queue.js";
import { buildGitCommitContextEvent, readGitCommit, type BuiltGitCommitEvent, type GitCommitContextEventPayload } from "./git-ingest.js";
import type { CaptureApiReachabilityStatus, CaptureOperationalStatus } from "./status.js";

export const DEFAULT_DAEMON_INTERVAL_MS = 30_000;
export const DEFAULT_DAEMON_MAX_COMMITS_PER_SCAN = 50;
export const DEFAULT_DAEMON_MAX_CONCURRENT_SUBMISSIONS = 2;
export const DAEMON_BACKOFF_BASE_MS = 2_000;
export const DAEMON_BACKOFF_MAX_MS = 5 * 60 * 1000;
export const DAEMON_STALE_AFTER_MS = 90_000;

const DAEMON_STATUS_VERSION = 1 as const;
const CURSOR_VERSION = 1 as const;
const RORCA_HOOK_SENTINEL = "# RORCA MANAGED HOOK";

export type CaptureDaemonAction = "run" | "scan-once" | "status" | "stop";

export type CaptureDaemonOptions = {
  config: CaptureConfig;
  workspace?: ResolvedWorkspace;
  tokenPath?: string;
  fetchImpl?: CaptureFetch;
  dryRun?: boolean;
  intervalMs?: number;
  maxCommitsPerScan?: number;
  maxConcurrentSubmissions?: number;
  homeDir?: string;
  now?: Date;
  random?: () => number;
  logger?: (entry: CaptureDaemonLogEntry) => void;
};

export type CaptureDaemonLoopOptions = CaptureDaemonOptions & {
  signal?: AbortSignal;
  maxIterations?: number;
};

export type CaptureDaemonLogEntry = {
  ts: string;
  level: "info" | "warn" | "error";
  event: string;
  workspaceId?: string;
  message?: string;
  data?: Record<string, unknown>;
};

export type CaptureCursorFile = {
  version: typeof CURSOR_VERSION;
  workspaceId: string;
  repoPath: string;
  lastReconciledSha: string | null;
  updatedAt: string;
};

export type CaptureDaemonBackoffState = {
  active: boolean;
  consecutiveErrorCount: number;
  nextRetryAt?: string;
  delayMs?: number;
};

export type CaptureDaemonScanSummary = {
  startedAt: string;
  finishedAt: string;
  cursorBefore: string | null;
  cursorAfter: string | null;
  planned: number;
  submitted: number;
  queued: number;
  duplicate: number;
  skippedNoise: number;
  dryRun: number;
  failed: number;
  maxConcurrentSubmissions: number;
  dryRunMode: boolean;
};

export type CaptureDaemonFlushSummary = {
  startedAt: string;
  finishedAt: string;
  submitted: number;
  failed: number;
  skipped: number;
  remaining: number;
};

export type CaptureDaemonStatusFile = {
  version: typeof DAEMON_STATUS_VERSION;
  worker_id: string;
  workspaceId: string;
  repoPath: string;
  apiUrl: string;
  queuePath: string;
  pid: number;
  hostname: string;
  running: boolean;
  last_seen: string;
  last_error?: string;
  intervalMs: number;
  maxCommitsPerScan: number;
  dryRun: boolean;
  apiReachable: boolean | null;
  queueDepth: number;
  cursor: {
    path: string;
    lastReconciledSha: string | null;
    updatedAt?: string;
  };
  hookState: ReturnType<typeof inspectHookState>;
  consecutiveErrorCount: number;
  backoff: CaptureDaemonBackoffState;
  lastScan?: CaptureDaemonScanSummary;
  lastFlush?: CaptureDaemonFlushSummary;
};

export type CaptureDaemonScanResult = {
  workspaceId: string;
  repoPath: string;
  apiUrl: string;
  queuePath: string;
  apiReachability: CaptureApiReachabilityStatus;
  cursorPath: string;
  cursorBefore: string | null;
  cursorAfter: string | null;
  queueDepth: number;
  scan: CaptureDaemonScanSummary;
  flush?: CaptureDaemonFlushSummary;
  statusPath: string;
  backoff: CaptureDaemonBackoffState;
  lastError?: string;
};

export type StopCaptureDaemonResult = {
  stopped: boolean;
  pid: number | null;
  statusPath: string;
  message: string;
};

export async function runCaptureDaemon(options: CaptureDaemonLoopOptions): Promise<CaptureDaemonScanResult | null> {
  const intervalMs = normalizePositiveInt(options.intervalMs, DEFAULT_DAEMON_INTERVAL_MS);
  const signal = options.signal;
  let iteration = 0;
  let last: CaptureDaemonScanResult | null = null;

  while (!signal?.aborted) {
    iteration += 1;
    last = await runDaemonScanOnce(options);
    options.logger?.({
      ts: new Date().toISOString(),
      level: last.lastError ? "warn" : "info",
      event: "daemon.scan",
      workspaceId: last.workspaceId,
      data: { scan: last.scan, flush: last.flush, backoff: last.backoff },
    });
    if (options.maxIterations && iteration >= options.maxIterations) break;
    await sleep(intervalMs, signal);
  }

  if (last) {
    const status = readCaptureDaemonStatus(last.workspaceId, options.homeDir);
    if (status) {
      writeCaptureDaemonStatus(last.workspaceId, {
        ...status,
        running: false,
        last_seen: new Date().toISOString(),
      }, options.homeDir);
    }
  }
  return last;
}

export async function runDaemonScanOnce(options: CaptureDaemonOptions): Promise<CaptureDaemonScanResult> {
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  const intervalMs = normalizePositiveInt(options.intervalMs, DEFAULT_DAEMON_INTERVAL_MS);
  const maxCommitsPerScan = normalizePositiveInt(options.maxCommitsPerScan, DEFAULT_DAEMON_MAX_COMMITS_PER_SCAN);
  const maxConcurrentSubmissions = normalizePositiveInt(options.maxConcurrentSubmissions, DEFAULT_DAEMON_MAX_CONCURRENT_SUBMISSIONS);
  const dryRun = options.dryRun === true;
  const previousWorkspaceId = options.workspace?.id ?? options.config.workspaceId ?? "unresolved";
  const previousStatus = readCaptureDaemonStatus(previousWorkspaceId, options.homeDir);
  const backoffBefore = normalizeBackoff(previousStatus?.backoff, now);
  const backoffActive = isBackoffActive(backoffBefore, now);
  const apiReachability = backoffActive
    ? {
        reachable: false,
        checkedAt: now.toISOString(),
        skipped: true,
        error: `API checks are in backoff until ${backoffBefore.nextRetryAt}`,
      }
    : await checkApiReachability(options.config, { fetchImpl: options.fetchImpl, dryRun });

  const workspace = await resolveDaemonWorkspace(options, apiReachability);
  const workspaceId = workspace.id;
  const cursorPath = getCaptureCursorPath(workspaceId, options.homeDir);
  const statusPath = getCaptureDaemonStatusPath(workspaceId, options.homeDir);
  const cursor = readCaptureCursor(workspaceId, options.homeDir);
  const cursorBefore = cursor?.lastReconciledSha ?? null;
  const hookState = inspectHookState(options.config.repoPath);
  const initialQueueDepth = safeQueueDepth(options.config.queuePath);
  const baseStatus: CaptureDaemonStatusFile = {
    version: DAEMON_STATUS_VERSION,
    worker_id: daemonWorkerId(workspaceId),
    workspaceId,
    repoPath: options.config.repoPath,
    apiUrl: options.config.apiUrl,
    queuePath: options.config.queuePath,
    pid: process.pid,
    hostname: hostname(),
    running: true,
    last_seen: now.toISOString(),
    intervalMs,
    maxCommitsPerScan,
    dryRun,
    apiReachable: apiReachability.reachable,
    queueDepth: initialQueueDepth,
    cursor: {
      path: cursorPath,
      lastReconciledSha: cursorBefore,
      ...(cursor?.updatedAt ? { updatedAt: cursor.updatedAt } : {}),
    },
    hookState,
    consecutiveErrorCount: backoffBefore.consecutiveErrorCount,
    backoff: backoffBefore,
    ...(previousStatus?.lastScan ? { lastScan: previousStatus.lastScan } : {}),
    ...(previousStatus?.lastFlush ? { lastFlush: previousStatus.lastFlush } : {}),
    ...(previousStatus?.last_error ? { last_error: previousStatus.last_error } : {}),
  };
  if (!dryRun) {
    writeCaptureDaemonPid(workspaceId, process.pid, options.homeDir);
    writeCaptureDaemonStatus(workspaceId, baseStatus, options.homeDir);
  }

  let lastError: string | undefined;
  let flush: CaptureDaemonFlushSummary | undefined;
  let client: ReusableCaptureClient | undefined;

  if (!dryRun && apiReachability.reachable) {
    client = createCaptureClient(options.config, { tokenPath: options.tokenPath, fetchImpl: options.fetchImpl });
    try {
      const flushStartedAt = new Date().toISOString();
      const flushResult = await client.flushQueue({ now });
      flush = {
        startedAt: flushStartedAt,
        finishedAt: new Date().toISOString(),
        submitted: flushResult.submitted,
        failed: flushResult.failed,
        skipped: flushResult.skipped,
        remaining: flushResult.remaining,
      };
      if (flushResult.failed > 0) {
        lastError = flushResult.failures[0]?.message ?? "Capture queue flush failed.";
      }
    } catch (error) {
      lastError = formatCaptureError(error);
    }
  } else if (apiReachability.reachable === false) {
    lastError = apiReachability.error ?? "Rorca API is unreachable.";
  }

  const refs = listCommitsForScan(options.config.repoPath, cursorBefore, maxCommitsPerScan);
  const scanResults = await scanCommitRefs(refs, {
    config: options.config,
    workspace,
    client,
    apiReachable: apiReachability.reachable === true,
    dryRun,
    maxConcurrentSubmissions,
  });

  const firstFailed = scanResults.find((item) => item.status === "failed");
  if (firstFailed) {
    lastError = firstFailed.error ?? "Commit reconciliation failed.";
  }

  const cursorAfter = dryRun ? cursorBefore : lastAccountedSha(scanResults, cursorBefore);
  const finishedAt = new Date().toISOString();
  const scan: CaptureDaemonScanSummary = {
    startedAt,
    finishedAt,
    cursorBefore,
    cursorAfter,
    planned: scanResults.length,
    submitted: scanResults.filter((item) => item.status === "submitted").length,
    queued: scanResults.filter((item) => item.status === "queued").length,
    duplicate: scanResults.filter((item) => item.status === "duplicate").length,
    skippedNoise: scanResults.filter((item) => item.status === "skipped-noise").length,
    dryRun: scanResults.filter((item) => item.status === "dry-run").length,
    failed: scanResults.filter((item) => item.status === "failed").length,
    maxConcurrentSubmissions,
    dryRunMode: dryRun,
  };

  if (!dryRun && cursorAfter && cursorAfter !== cursorBefore) {
    writeCaptureCursor(workspaceId, {
      version: CURSOR_VERSION,
      workspaceId,
      repoPath: options.config.repoPath,
      lastReconciledSha: cursorAfter,
      updatedAt: finishedAt,
    }, options.homeDir);
  }

  const queueDepth = safeQueueDepth(options.config.queuePath);
  const backoff = lastError
    ? backoffActive
      ? backoffBefore
      : computeBackoff((previousStatus?.consecutiveErrorCount ?? 0) + 1, new Date(finishedAt), options.random)
    : { active: false, consecutiveErrorCount: 0 };
  const finalStatus: CaptureDaemonStatusFile = {
    ...baseStatus,
    last_seen: finishedAt,
    apiReachable: apiReachability.reachable,
    queueDepth,
    cursor: {
      path: cursorPath,
      lastReconciledSha: cursorAfter,
      ...(cursorAfter ? { updatedAt: finishedAt } : cursor?.updatedAt ? { updatedAt: cursor.updatedAt } : {}),
    },
    hookState: inspectHookState(options.config.repoPath),
    consecutiveErrorCount: backoff.consecutiveErrorCount,
    backoff,
    lastScan: scan,
    ...(flush ? { lastFlush: flush } : previousStatus?.lastFlush ? { lastFlush: previousStatus.lastFlush } : {}),
    last_error: lastError ? sanitizeCaptureErrorMessage(lastError) : undefined,
  };
  if (!dryRun) {
    writeCaptureDaemonStatus(workspaceId, finalStatus, options.homeDir);
  }

  return {
    workspaceId,
    repoPath: options.config.repoPath,
    apiUrl: options.config.apiUrl,
    queuePath: options.config.queuePath,
    apiReachability,
    cursorPath,
    cursorBefore,
    cursorAfter,
    queueDepth,
    scan,
    ...(flush ? { flush } : {}),
    statusPath,
    backoff,
    ...(lastError ? { lastError: sanitizeCaptureErrorMessage(lastError) } : {}),
  };
}

export async function buildOperationalStatus(input: {
  config: CaptureConfig;
  workspaceId?: string | null;
  fetchImpl?: CaptureFetch;
  dryRun?: boolean;
  homeDir?: string;
}): Promise<CaptureOperationalStatus> {
  const workspaceId = input.workspaceId ?? input.config.workspaceId ?? null;
  const apiReachability = await checkApiReachability(input.config, {
    fetchImpl: input.fetchImpl,
    dryRun: input.dryRun,
  });
  const queue = {
    path: input.config.queuePath,
    depth: safeQueueDepth(input.config.queuePath),
  };
  const cursor = workspaceId
    ? readCaptureCursor(workspaceId, input.homeDir)
    : null;
  const daemon = workspaceId
    ? readCaptureDaemonStatus(workspaceId, input.homeDir)
    : null;
  const running = daemon ? isProcessRunning(daemon.pid) : false;
  const stale = daemon?.last_seen ? Date.now() - Date.parse(daemon.last_seen) > DAEMON_STALE_AFTER_MS : false;

  return {
    apiReachability,
    queue,
    cursor: {
      path: workspaceId ? getCaptureCursorPath(workspaceId, input.homeDir) : undefined,
      lastReconciledSha: cursor?.lastReconciledSha ?? daemon?.cursor.lastReconciledSha ?? null,
      ...(cursor?.updatedAt ? { updatedAt: cursor.updatedAt } : daemon?.cursor.updatedAt ? { updatedAt: daemon.cursor.updatedAt } : {}),
    },
    hook: inspectHookState(input.config.repoPath),
    daemon: {
      workerId: workspaceId ? daemonWorkerId(workspaceId) : null,
      pid: daemon?.pid ?? null,
      running: running && !stale && daemon?.running !== false,
      hostname: daemon?.hostname,
      lastSeen: daemon?.last_seen,
      stale,
      statusPath: workspaceId ? getCaptureDaemonStatusPath(workspaceId, input.homeDir) : undefined,
      consecutiveErrorCount: daemon?.consecutiveErrorCount ?? 0,
      backoff: daemon?.backoff ?? { active: false },
      ...(daemon?.lastScan ? { lastScan: daemon.lastScan as unknown as Record<string, unknown> } : {}),
      ...(daemon?.lastFlush ? { lastFlush: daemon.lastFlush as unknown as Record<string, unknown> } : {}),
      ...(daemon?.last_error ? { lastError: daemon.last_error } : {}),
    },
  };
}

export async function checkApiReachability(config: CaptureConfig, options: {
  fetchImpl?: CaptureFetch;
  dryRun?: boolean;
} = {}): Promise<CaptureApiReachabilityStatus> {
  const checkedAt = new Date().toISOString();
  if (options.dryRun) {
    return { reachable: null, checkedAt, skipped: true };
  }

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${config.apiUrl.replace(/\/$/, "")}/api/health`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    return {
      reachable: response.ok,
      checkedAt,
      statusCode: response.status,
      ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
    };
  } catch (error) {
    return {
      reachable: false,
      checkedAt,
      error: sanitizeCaptureErrorMessage(error),
    };
  }
}

export function readCaptureCursor(workspaceId: string, homeDir?: string): CaptureCursorFile | null {
  const filePath = getCaptureCursorPath(workspaceId, homeDir);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<CaptureCursorFile>;
    if (parsed.version !== CURSOR_VERSION || parsed.workspaceId !== workspaceId) return null;
    return {
      version: CURSOR_VERSION,
      workspaceId,
      repoPath: typeof parsed.repoPath === "string" ? parsed.repoPath : "",
      lastReconciledSha: typeof parsed.lastReconciledSha === "string" ? parsed.lastReconciledSha : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

export function writeCaptureCursor(workspaceId: string, cursor: CaptureCursorFile, homeDir?: string): void {
  writeJsonAtomic(getCaptureCursorPath(workspaceId, homeDir), cursor);
}

export function readCaptureDaemonStatus(workspaceId: string, homeDir?: string): CaptureDaemonStatusFile | null {
  const filePath = getCaptureDaemonStatusPath(workspaceId, homeDir);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as CaptureDaemonStatusFile;
    if (parsed.version !== DAEMON_STATUS_VERSION || parsed.workspaceId !== workspaceId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeCaptureDaemonStatus(workspaceId: string, status: CaptureDaemonStatusFile, homeDir?: string): void {
  writeJsonAtomic(getCaptureDaemonStatusPath(workspaceId, homeDir), status);
}

export function stopCaptureDaemon(workspaceId: string, homeDir?: string): StopCaptureDaemonResult {
  const statusPath = getCaptureDaemonStatusPath(workspaceId, homeDir);
  const status = readCaptureDaemonStatus(workspaceId, homeDir);
  const pid = status?.pid ?? readCaptureDaemonPid(workspaceId, homeDir);
  if (!pid) {
    return { stopped: false, pid: null, statusPath, message: "No daemon PID recorded." };
  }

  const running = isProcessRunning(pid);
  if (running && pid !== process.pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The status file is still marked stopped below so a stale PID does not keep reporting as live.
    }
  }

  if (status) {
    writeCaptureDaemonStatus(workspaceId, {
      ...status,
      running: false,
      last_seen: new Date().toISOString(),
    }, homeDir);
  }
  rmSync(getCaptureDaemonPidPath(workspaceId, homeDir), { force: true });
  return { stopped: running, pid, statusPath, message: running ? `Stopped daemon pid ${pid}.` : `Daemon pid ${pid} was not running.` };
}

export function getCaptureCursorPath(workspaceId: string, homeDir = homedir()): string {
  return path.join(homeDir, ".rorca", `capture-cursor-${safeWorkspaceId(workspaceId)}.json`);
}

export function getCaptureDaemonStatusPath(workspaceId: string, homeDir = homedir()): string {
  return path.join(homeDir, ".rorca", `capture-daemon-${safeWorkspaceId(workspaceId)}.json`);
}

export function getCaptureDaemonPidPath(workspaceId: string, homeDir = homedir()): string {
  return path.join(homeDir, ".rorca", `capture-daemon-${safeWorkspaceId(workspaceId)}.pid`);
}

function writeCaptureDaemonPid(workspaceId: string, pid: number, homeDir?: string): void {
  const pidPath = getCaptureDaemonPidPath(workspaceId, homeDir);
  mkdirSync(path.dirname(pidPath), { recursive: true });
  writeFileSync(`${pidPath}.tmp`, `${pid}\n`, { encoding: "utf8", mode: 0o600 });
  chmodBestEffort(`${pidPath}.tmp`, 0o600);
  renameSync(`${pidPath}.tmp`, pidPath);
}

function readCaptureDaemonPid(workspaceId: string, homeDir?: string): number | null {
  const pidPath = getCaptureDaemonPidPath(workspaceId, homeDir);
  if (!existsSync(pidPath)) return null;
  const parsed = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function resolveDaemonWorkspace(options: CaptureDaemonOptions, apiReachability: CaptureApiReachabilityStatus): Promise<ResolvedWorkspace> {
  if (options.workspace) return options.workspace;
  if (options.config.workspaceId) {
    return {
      id: options.config.workspaceId,
      path: options.config.repoPath,
      resolvedBy: "config",
    };
  }
  if (options.dryRun) {
    return {
      id: "dry-run-workspace",
      path: options.config.repoPath,
      resolvedBy: "path",
    };
  }
  if (apiReachability.reachable === false) {
    throw new Error("Rorca API is unreachable and no workspace ID is configured; pass --workspace <id> for daemon reconciliation.");
  }

  const client = createApiClient(options.config, { tokenPath: options.tokenPath, fetchImpl: options.fetchImpl });
  return await resolveWorkspace(options.config, client);
}

type ScanCommitStatus = "submitted" | "queued" | "duplicate" | "skipped-noise" | "dry-run" | "failed";

type ScanCommitResult = {
  sha: string;
  status: ScanCommitStatus;
  error?: string;
};

async function scanCommitRefs(refs: string[], input: {
  config: CaptureConfig;
  workspace: ResolvedWorkspace;
  client?: ReusableCaptureClient;
  apiReachable: boolean;
  dryRun: boolean;
  maxConcurrentSubmissions: number;
}): Promise<ScanCommitResult[]> {
  const results: ScanCommitResult[] = [];
  for (let index = 0; index < refs.length; index += input.maxConcurrentSubmissions) {
    const batch = refs.slice(index, index + input.maxConcurrentSubmissions);
    const settled = await Promise.all(batch.map((ref) => scanOneCommit(ref, input)));
    results.push(...settled);
    if (settled.some((item) => item.status === "failed")) break;
  }
  return results;
}

async function scanOneCommit(ref: string, input: {
  config: CaptureConfig;
  workspace: ResolvedWorkspace;
  client?: ReusableCaptureClient;
  apiReachable: boolean;
  dryRun: boolean;
}): Promise<ScanCommitResult> {
  try {
    const commit = readGitCommit(input.config, ref);
    const built = buildGitCommitContextEvent(input.config, input.workspace, commit);
    if (built.noisy) return { sha: commit.sha, status: "skipped-noise" };
    if (input.dryRun) return { sha: commit.sha, status: "dry-run" };

    const payload = buildDaemonGitCommitPayload(built);
    if (!input.apiReachable || !input.client) {
      const queued = enqueueCaptureQueueEntry(input.config.queuePath, input.config, {
        operation: "context-event",
        endpoint: "/api/context-events",
        payload,
        eventType: "git_commit",
        contentFingerprint: commit.sha,
      });
      return { sha: commit.sha, status: queued.duplicate ? "duplicate" : "queued" };
    }

    try {
      const submission = await input.client.submitContextEvent<{ created?: boolean; idempotent?: boolean }>(payload, {
        eventType: "git_commit",
        contentFingerprint: commit.sha,
      });
      if (submission.status === "queued") {
        return { sha: commit.sha, status: submission.duplicate ? "duplicate" : "queued" };
      }
      if (submission.response.created === false || submission.response.idempotent === true) {
        return { sha: commit.sha, status: "duplicate" };
      }
      return { sha: commit.sha, status: "submitted" };
    } catch (error) {
      if (error instanceof CaptureApiError && error.statusCode === 409) {
        return { sha: commit.sha, status: "duplicate" };
      }
      if (error instanceof CaptureNetworkError) {
        const queued = enqueueCaptureQueueEntry(input.config.queuePath, input.config, {
          operation: "context-event",
          endpoint: "/api/context-events",
          payload,
          eventType: "git_commit",
          contentFingerprint: commit.sha,
        });
        return { sha: commit.sha, status: queued.duplicate ? "duplicate" : "queued" };
      }
      return { sha: commit.sha, status: "failed", error: formatCaptureError(error) };
    }
  } catch (error) {
    return { sha: ref, status: "failed", error: formatCaptureError(error) };
  }
}

function buildDaemonGitCommitPayload(built: BuiltGitCommitEvent): GitCommitContextEventPayload {
  return {
    ...built.payload,
    provenance: {
      ...built.payload.provenance,
      command: "rorca-capture daemon",
      deduplicationKey: built.commit.sha,
    },
    metadata: {
      ...built.payload.metadata,
      deduplicationKey: built.commit.sha,
      daemonReconciled: true,
    },
  };
}

function lastAccountedSha(results: ScanCommitResult[], cursorBefore: string | null): string | null {
  let cursor = cursorBefore;
  for (const result of results) {
    if (result.status === "failed" || result.status === "dry-run") break;
    cursor = result.sha;
  }
  return cursor;
}

function listCommitsForScan(repoPath: string, cursor: string | null, maxCommits: number): string[] {
  try {
    if (cursor) {
      return gitLines(repoPath, ["log", "--reverse", "--format=%H", `${cursor}..HEAD`]).slice(0, maxCommits);
    }
    const latest = gitLines(repoPath, ["log", "--format=%H", `-${maxCommits}`]);
    return latest.reverse();
  } catch {
    return [];
  }
}

function gitLines(repoPath: string, args: string[]): string[] {
  const output = execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function safeQueueDepth(queuePath: string): number {
  try {
    return readCaptureQueue(queuePath).length;
  } catch {
    return 0;
  }
}

function inspectHookState(repoPath: string): { path: string; installed: boolean; managed: boolean; mode?: "best-effort" | "strict" | "unmanaged" } {
  const hookPath = path.join(repoPath, ".git", "hooks", "post-commit");
  if (!existsSync(hookPath)) return { path: hookPath, installed: false, managed: false };
  const contents = readFileSync(hookPath, "utf8");
  const managed = contents.includes(RORCA_HOOK_SENTINEL);
  if (!managed) return { path: hookPath, installed: true, managed: false, mode: "unmanaged" };
  const mode = contents.includes("# RORCA_HOOK_MODE: strict") ? "strict" : "best-effort";
  return { path: hookPath, installed: true, managed: true, mode };
}

function computeBackoff(consecutiveErrorCount: number, now: Date, random = Math.random): CaptureDaemonBackoffState {
  const exp = Math.min(DAEMON_BACKOFF_MAX_MS, DAEMON_BACKOFF_BASE_MS * (2 ** Math.max(0, consecutiveErrorCount - 1)));
  const jitter = Math.floor(exp * 0.25 * random());
  const delayMs = Math.min(DAEMON_BACKOFF_MAX_MS, exp + jitter);
  return {
    active: true,
    consecutiveErrorCount,
    delayMs,
    nextRetryAt: new Date(now.getTime() + delayMs).toISOString(),
  };
}

function normalizeBackoff(backoff: CaptureDaemonBackoffState | undefined, now: Date): CaptureDaemonBackoffState {
  if (!backoff?.active) return { active: false, consecutiveErrorCount: backoff?.consecutiveErrorCount ?? 0 };
  if (!backoff.nextRetryAt || Date.parse(backoff.nextRetryAt) <= now.getTime()) {
    return { active: false, consecutiveErrorCount: backoff.consecutiveErrorCount };
  }
  return backoff;
}

function isBackoffActive(backoff: CaptureDaemonBackoffState, now: Date): boolean {
  return backoff.active && Boolean(backoff.nextRetryAt) && Date.parse(backoff.nextRetryAt ?? "") > now.getTime();
}

function daemonWorkerId(workspaceId: string): string {
  return `rorca-capture:${workspaceId}`;
}

function safeWorkspaceId(workspaceId: string): string {
  return workspaceId.replace(/[^a-zA-Z0-9_.-]/g, "_") || "workspace";
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodBestEffort(tmpPath, 0o600);
  renameSync(tmpPath, filePath);
  chmodBestEffort(filePath, 0o600);
}

function chmodBestEffort(filePath: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(filePath, mode);
  } catch {
    // Best effort on platforms without POSIX chmod support.
  }
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && (error as { code?: string }).code === "EPERM";
  }
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}
