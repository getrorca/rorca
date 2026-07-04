import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CaptureConfig } from "./config.js";
import {
  hashContextContent,
  redactAbsoluteContextPaths,
  redactContextPayload,
  redactContextText,
} from "./context-safety.js";

export const CAPTURE_QUEUE_VERSION = 1 as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type CaptureQueueOperation =
  | "context-event"
  | "context-candidate"
  | "memory-candidate"
  | "candidate-approval"
  | "api-request";

export type CaptureQueueApproval = {
  endpointBase: string;
  payload?: JsonObject;
};

export type CaptureQueueEntry = {
  version: typeof CAPTURE_QUEUE_VERSION;
  key: string;
  operation: CaptureQueueOperation;
  eventType: string;
  contentFingerprint: string;
  method: "POST";
  endpoint: string;
  payload: JsonValue;
  approval?: CaptureQueueApproval;
  attempts: number;
  queuedAt: string;
  updatedAt: string;
  retryable: boolean;
  lastError?: string;
  nextRetryAt?: string;
};

export type BuildCaptureQueueEntryInput = {
  operation: CaptureQueueOperation;
  endpoint: string;
  payload: unknown;
  eventType?: string;
  contentFingerprint?: string;
  approval?: CaptureQueueApproval;
  now?: Date;
};

export type EnqueueCaptureQueueResult = {
  entry: CaptureQueueEntry;
  queued: boolean;
  duplicate: boolean;
};

export class CaptureQueueError extends Error {
  readonly code = "CAPTURE_QUEUE_ERROR";
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "CaptureQueueError";
  }

  toJSON(): { error: string; code: string } {
    return { error: this.message, code: this.code };
  }
}

export function buildCaptureQueueEntry(config: CaptureConfig, input: BuildCaptureQueueEntryInput): CaptureQueueEntry {
  const normalizedPayload = normalizeCapturePayloadForDisk(input.payload, config);
  const contentFingerprint = input.contentFingerprint ?? hashContextContent(stableStringify(normalizedPayload));
  const eventType = input.eventType ?? inferQueueEventType(input.operation, normalizedPayload);
  const now = (input.now ?? new Date()).toISOString();
  const approval = input.approval
    ? {
        endpointBase: input.approval.endpointBase,
        ...(input.approval.payload ? { payload: normalizeCapturePayloadForDisk(input.approval.payload, config) as JsonObject } : {}),
      }
    : undefined;

  return {
    version: CAPTURE_QUEUE_VERSION,
    key: buildCaptureQueueKey(eventType, contentFingerprint),
    operation: input.operation,
    eventType,
    contentFingerprint,
    method: "POST",
    endpoint: input.endpoint,
    payload: normalizedPayload,
    ...(approval ? { approval } : {}),
    attempts: 0,
    queuedAt: now,
    updatedAt: now,
    retryable: true,
  };
}

export function buildCaptureQueueKey(eventType: string, contentFingerprint: string): string {
  return `capture:${hashContextContent(`${eventType}:${contentFingerprint}`)}`;
}

export function normalizeCapturePayloadForDisk(value: unknown, config: CaptureConfig): JsonValue {
  const jsonSafe = toJsonValue(value);
  const redacted = redactContextPayload(jsonSafe, config.redaction, { repoPath: config.repoPath });
  return toJsonValue(redacted);
}

export function enqueueCaptureQueueEntry(
  queuePath: string,
  config: CaptureConfig,
  input: BuildCaptureQueueEntryInput,
): EnqueueCaptureQueueResult {
  const entry = buildCaptureQueueEntry(config, input);
  const existing = readCaptureQueue(queuePath);
  const duplicate = existing.find((item) => item.key === entry.key);
  if (duplicate) {
    return { entry: duplicate, queued: false, duplicate: true };
  }

  writeCaptureQueueAtomic(queuePath, [...existing, entry]);
  return { entry, queued: true, duplicate: false };
}

export function readCaptureQueue(queuePath: string): CaptureQueueEntry[] {
  if (!existsSync(queuePath)) return [];
  const text = readFileSync(queuePath, "utf8");
  if (!text.trim()) return [];

  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line, index) => {
    try {
      return normalizeCaptureQueueEntry(JSON.parse(line));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CaptureQueueError(`Invalid capture queue entry at line ${index + 1}: ${sanitizeCaptureErrorMessage(message)}`);
    }
  });
}

export function writeCaptureQueueAtomic(queuePath: string, entries: CaptureQueueEntry[]): void {
  mkdirSync(path.dirname(queuePath), { recursive: true });
  const tmpPath = `${queuePath}.tmp`;
  const content = entries.length > 0 ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "";
  writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // Best effort on platforms that do not support POSIX modes.
  }
  renameSync(tmpPath, queuePath);
}

export function updateCaptureQueueEntryFailure(input: {
  entry: CaptureQueueEntry;
  error: unknown;
  retryable: boolean;
  now?: Date;
}): CaptureQueueEntry {
  const attempts = input.entry.attempts + 1;
  const now = input.now ?? new Date();
  return {
    ...input.entry,
    attempts,
    retryable: input.retryable,
    lastError: sanitizeCaptureErrorMessage(input.error),
    updatedAt: now.toISOString(),
    ...(input.retryable ? { nextRetryAt: nextRetryAt(attempts, now).toISOString() } : { nextRetryAt: undefined }),
  };
}

export function sanitizeCaptureErrorMessage(error: unknown): string {
  const raw = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : String(error);
  const withoutStack = raw.split(/\r?\n/)[0] || "Unknown capture error";
  const redacted = redactContextText(redactAbsoluteContextPaths(withoutStack));
  return redacted.length > 300 ? `${redacted.slice(0, 297)}...` : redacted;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeCaptureQueueEntry(value: unknown): CaptureQueueEntry {
  if (!isPlainObject(value)) throw new Error("entry must be an object");
  if (value.version !== CAPTURE_QUEUE_VERSION) throw new Error("unsupported queue entry version");
  if (typeof value.key !== "string" || !value.key) throw new Error("entry key is required");
  if (typeof value.operation !== "string" || !isQueueOperation(value.operation)) throw new Error("entry operation is invalid");
  if (typeof value.eventType !== "string" || !value.eventType) throw new Error("entry eventType is required");
  if (typeof value.contentFingerprint !== "string" || !value.contentFingerprint) throw new Error("entry contentFingerprint is required");
  if (value.method !== "POST") throw new Error("entry method must be POST");
  if (typeof value.endpoint !== "string" || !value.endpoint.startsWith("/api/")) throw new Error("entry endpoint is invalid");
  if (!("payload" in value)) throw new Error("entry payload is required");

  return {
    version: CAPTURE_QUEUE_VERSION,
    key: value.key,
    operation: value.operation,
    eventType: value.eventType,
    contentFingerprint: value.contentFingerprint,
    method: "POST",
    endpoint: value.endpoint,
    payload: toJsonValue(value.payload),
    ...(isApproval(value.approval) ? { approval: value.approval } : {}),
    attempts: typeof value.attempts === "number" && Number.isInteger(value.attempts) && value.attempts >= 0 ? value.attempts : 0,
    queuedAt: typeof value.queuedAt === "string" ? value.queuedAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
    retryable: typeof value.retryable === "boolean" ? value.retryable : true,
    ...(typeof value.lastError === "string" ? { lastError: sanitizeCaptureErrorMessage(value.lastError) } : {}),
    ...(typeof value.nextRetryAt === "string" ? { nextRetryAt: value.nextRetryAt } : {}),
  };
}

function inferQueueEventType(operation: CaptureQueueOperation, payload: JsonValue): string {
  if (isPlainObject(payload) && typeof payload.eventType === "string" && payload.eventType.trim()) {
    return payload.eventType;
  }
  return operation;
}

function isQueueOperation(value: string): value is CaptureQueueOperation {
  return ["context-event", "context-candidate", "memory-candidate", "candidate-approval", "api-request"].includes(value);
}

function isApproval(value: unknown): value is CaptureQueueApproval {
  return isPlainObject(value)
    && typeof value.endpointBase === "string"
    && value.endpointBase.startsWith("/api/")
    && (value.payload === undefined || isPlainObject(value.payload));
}

function nextRetryAt(attempts: number, now: Date): Date {
  const delayMs = Math.min(5 * 60 * 1000, 1000 * (2 ** Math.min(attempts, 8)));
  return new Date(now.getTime() + delayMs);
}

function toJsonValue(value: unknown): JsonValue {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().flatMap((key) => {
      const item = record[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") return [];
      return [[key, toJsonValue(item)] as const];
    });
    return Object.fromEntries(entries) as JsonObject;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
