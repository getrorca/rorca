import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { isCaptureIgnoredPath, sanitizeCapturePayload, type SanitizedCapturePayload } from "../../../../backend/src/lib/context-safety.js";
import type { CapturePolicyMode, RorcaCaptureConfig } from "./config.js";

export type RorcaSource = "vscodeExtension";
export type RorcaCaptureEventType =
  | "ide_session"
  | "editor_activity"
  | "explicit_memory"
  | "shell_command"
  | "cli_command"
  | "agent_cli_session"
  | "git_commit"
  | "ci_pr";

export type MemoryCandidate = {
  category: "Architecture" | "Convention" | "Bug Fix" | "Decision" | "Pattern" | "Gotcha";
  title: string;
  rule: string;
  context?: string;
  source: string;
  relatedFiles?: string[];
};

export type MemoryCandidateGovernance = {
  enabled: true;
  source: "extension-default-on";
  maxCandidates: number;
  tokenCap: number;
  submittedCandidates: number;
  droppedCandidates: number;
  submittedTokens: number;
};

export type RorcaCaptureEvent = {
  id: string;
  workspaceId: string;
  source: RorcaSource;
  occurredAt: string;
  policyMode: CapturePolicyMode;
  payload: unknown;
  safety: SanitizedCapturePayload["safety"];
};

export type CaptureEventInput = {
  workspaceId: string;
  workspacePath: string;
  eventType: RorcaCaptureEventType;
  policyMode: CapturePolicyMode;
  payload: Record<string, unknown>;
  occurredAt?: string;
};

export type RorcaCapturePostResult = { ok: boolean; queued: boolean; status?: number; event: RorcaCaptureEvent };

export type RorcaCaptureClientOptions = {
  apiBaseUrl: string;
  queuePath: string;
  queueMaxSize: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export const MEMORY_CANDIDATE_GOVERNANCE_DEFAULTS = {
  maxCandidates: 8,
  tokenCap: 1_200,
} as const;

export class RorcaCaptureClient {
  private readonly apiBaseUrl: string;
  private readonly queuePath: string;
  private readonly queueMaxSize: number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: RorcaCaptureClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
    this.queuePath = options.queuePath;
    this.queueMaxSize = options.queueMaxSize;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 2_000;
  }

  buildEvent(input: CaptureEventInput): RorcaCaptureEvent {
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const rawPayload = {
      ...input.payload,
      eventType: input.eventType,
      policyMode: input.policyMode,
      repo_path_hash: `sha256:${crypto.createHash("sha256").update(path.resolve(input.workspacePath)).digest("hex")}`,
    };
    const ignoreReport = { ignoredPathCount: 0 };
    const payloadWithIgnoredPathsRedacted = redactIgnoredPaths(rawPayload, input.workspacePath, readCaptureIgnorePatterns(input.workspacePath), ignoreReport);
    const sanitized = sanitizeCapturePayload(payloadWithIgnoredPathsRedacted);
    const id = `vscode:${hashStable({ workspaceId: input.workspaceId, source: "vscodeExtension", occurredAt, payloadHash: sanitized.safety.contentHash })}`;
    return {
      id,
      workspaceId: input.workspaceId,
      source: "vscodeExtension",
      occurredAt,
      policyMode: input.policyMode,
      payload: {
        ...(typeof sanitized.payload === "object" && sanitized.payload ? sanitized.payload as Record<string, unknown> : { value: sanitized.payload }),
        source_event_id: id,
        idempotencyKey: id,
      },
      safety: { ...sanitized.safety, ignoredPathCount: sanitized.safety.ignoredPathCount + ignoreReport.ignoredPathCount },
    };
  }

  async submit(input: CaptureEventInput): Promise<RorcaCapturePostResult> {
    const event = this.buildEvent(input);
    const ok = await this.postEvent(event);
    if (ok) return { ok: true, queued: false, event };
    enqueueCaptureEvent(this.queuePath, event, this.queueMaxSize);
    return { ok: true, queued: true, event };
  }

  async flushQueued(): Promise<{ flushed: number; remaining: number }> {
    const events = readQueuedCaptureEvents(this.queuePath);
    const remaining: RorcaCaptureEvent[] = [];
    let flushed = 0;
    for (const event of events) {
      if (await this.postEvent(event)) flushed += 1;
      else remaining.push(event);
    }
    rewriteQueuedCaptureEvents(this.queuePath, remaining);
    return { flushed, remaining: remaining.length };
  }

  private async postEvent(event: RorcaCaptureEvent): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.apiBaseUrl}/api/context-capture/events`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          id: event.id,
          workspaceId: event.workspaceId,
          source: event.source,
          occurredAt: event.occurredAt,
          policyMode: event.policyMode,
          payload: event.payload,
          safety: event.safety,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export function queuePathForWorkspace(workspacePath: string): string {
  return path.join(workspacePath, ".rorca", "capture", "queue");
}

export function enqueueCaptureEvent(queuePath: string, event: RorcaCaptureEvent, maxSize: number): void {
  const events = readQueuedCaptureEvents(queuePath);
  if (events.some((existing) => existing.id === event.id)) return;
  rewriteQueuedCaptureEvents(queuePath, [...events, event].slice(Math.max(0, events.length + 1 - maxSize)));
}

export function readQueuedCaptureEvents(queuePath: string): RorcaCaptureEvent[] {
  const file = path.join(queuePath, "vscode-extension.ndjson");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as RorcaCaptureEvent]; } catch { return []; }
  });
}

export function rewriteQueuedCaptureEvents(queuePath: string, events: RorcaCaptureEvent[]): void {
  mkdirSync(queuePath, { recursive: true });
  const file = path.join(queuePath, "vscode-extension.ndjson");
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""), "utf8");
  renameSync(tmp, file);
}

export function applyMemoryCandidateGovernance(candidates: MemoryCandidate[], config: Pick<RorcaCaptureConfig, "memoryCandidateMaxCount" | "memoryCandidateTokenCap">): { candidates: MemoryCandidate[]; governance: MemoryCandidateGovernance } {
  const maxCandidates = Math.max(1, Math.floor(config.memoryCandidateMaxCount || MEMORY_CANDIDATE_GOVERNANCE_DEFAULTS.maxCandidates));
  const tokenCap = Math.max(100, Math.floor(config.memoryCandidateTokenCap || MEMORY_CANDIDATE_GOVERNANCE_DEFAULTS.tokenCap));
  const accepted: MemoryCandidate[] = [];
  let submittedTokens = 0;
  for (const candidate of candidates) {
    if (accepted.length >= maxCandidates) break;
    const tokens = estimateTokens(`${candidate.category}\n${candidate.title}\n${candidate.rule}\n${candidate.context ?? ""}`);
    if (submittedTokens + tokens > tokenCap) break;
    accepted.push(candidate);
    submittedTokens += tokens;
  }
  return {
    candidates: accepted,
    governance: {
      enabled: true,
      source: "extension-default-on",
      maxCandidates,
      tokenCap,
      submittedCandidates: accepted.length,
      droppedCandidates: Math.max(0, candidates.length - accepted.length),
      submittedTokens,
    },
  };
}

function readCaptureIgnorePatterns(workspacePath: string): string[] {
  const ignorePath = path.join(workspacePath, ".rorca-captureignore");
  if (!existsSync(ignorePath)) return [];
  return readFileSync(ignorePath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function redactIgnoredPaths(value: unknown, workspacePath: string, patterns: string[], report: { ignoredPathCount: number }): unknown {
  if (patterns.length === 0) return value;
  if (typeof value === "string") {
    if (isCaptureIgnoredPath(value, workspacePath, patterns)) {
      report.ignoredPathCount += 1;
      return "[REDACTED_PATH]";
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactIgnoredPaths(item, workspacePath, patterns, report));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, redactIgnoredPaths(child, workspacePath, patterns, report)]));
  }
  return value;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function hashStable(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex").slice(0, 32);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
}
