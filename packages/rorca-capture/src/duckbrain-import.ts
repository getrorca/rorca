import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { CaptureConfig } from "./config.js";
import {
  CONTEXT_SAFETY_CONTRACT_VERSION,
  analyzeContextSafety,
  enforceContextSizeLimit,
  hashContextContent,
  redactContextPayload,
  redactContextText,
} from "./context-safety.js";

export const DUCKBRAIN_IMPORT_ENDPOINT = "/api/memory/candidates";
export const DUCKBRAIN_IMPORT_SOURCE_SYSTEM = "duckbrain";
export const DUCKBRAIN_IMPORT_EVENT_TYPE = "duckbrain_import";
export const DUCKBRAIN_IMPORT_SCHEMA = "rorca.duckbrain_import/v1";
export const DUCKBRAIN_IMPORT_TRUST_TIER = "working_note";

const DUCKBRAIN_MEMORY_CATEGORIES = ["Architecture", "Convention", "Bug Fix", "Decision", "Pattern", "Gotcha"] as const;
const DUCKBRAIN_MEMORY_CONFIDENCES = ["high", "medium", "low"] as const;
// Standalone sidecar mirror of shared/contracts/trust.ts; keep values aligned with the shared contract.
const DUCKBRAIN_TRUST_TIERS = [
  "agent_observation",
  "working_note",
  "engineering_decision",
  "approved_policy",
  "verified_fact",
] as const;

export type DuckBrainMemoryCategory = typeof DUCKBRAIN_MEMORY_CATEGORIES[number];
export type DuckBrainMemoryConfidence = typeof DUCKBRAIN_MEMORY_CONFIDENCES[number];
export type DuckBrainTrustTier = typeof DUCKBRAIN_TRUST_TIERS[number];

export type DuckBrainImportFilter = {
  raw: string;
  field?: "namespace" | "key" | "tag" | "content" | "metadata";
  value: string;
};

export type DuckBrainImportReasonCode =
  | "malformed_json"
  | "empty_line"
  | "missing_namespace"
  | "missing_key"
  | "missing_content"
  | "missing_tags"
  | "invalid_tags"
  | "invalid_metadata"
  | "invalid_created_at"
  | "filtered"
  | "duplicate_entry"
  | "payload_too_large";

export type DuckBrainImportReason = {
  line: number;
  code: DuckBrainImportReasonCode;
  message: string;
};

export type DuckBrainMemoryCandidatePayload = {
  workspaceId: string;
  eventType: typeof DUCKBRAIN_IMPORT_EVENT_TYPE;
  sourceSystem: typeof DUCKBRAIN_IMPORT_SOURCE_SYSTEM;
  sourceRef: string;
  actor: "duckbrain-import";
  occurredAt: string;
  suggestedCategory: DuckBrainMemoryCategory;
  title: string;
  rule: string;
  context: string;
  relatedFiles: string[];
  confidence: DuckBrainMemoryConfidence;
  trustTier: DuckBrainTrustTier;
  status: "pending";
  reviewStatus: "pending";
  idempotencyKey: string;
  provenance: Record<string, unknown>;
  metadata: Record<string, unknown>;
  securitySensitive: boolean;
  regulatedDomain: boolean;
  requiresReview: true;
};

export type DuckBrainCandidateSubmitResult = {
  status: "imported" | "duplicate" | "queued";
  candidateId?: string | null;
  queuePath?: string;
};

export type DuckBrainCandidateSubmitter = (
  payload: DuckBrainMemoryCandidatePayload,
) => Promise<DuckBrainCandidateSubmitResult>;

export type DuckBrainImportItemStatus = "dry-run" | "imported" | "duplicate" | "queued";

export type DuckBrainImportCandidateSummary = {
  line: number;
  status: DuckBrainImportItemStatus;
  namespace: string;
  key: string;
  sourceRef: string;
  entryHash: string;
  createdAt: string;
  originalTags: string[];
  idempotencyKey: string;
  title: string;
  securitySensitive: boolean;
  regulatedDomain: boolean;
  requiresReview: true;
  trustTier: DuckBrainTrustTier;
  reviewStatus: "pending";
  candidateId?: string | null;
  queuePath?: string;
  provenance: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type DuckBrainImportSummary = {
  dryRun: boolean;
  sourcePath: string;
  workspaceId: string;
  total: number;
  imported: number;
  skipped: number;
  duplicate: number;
  queued: number;
  candidates: DuckBrainImportCandidateSummary[];
  reasons: DuckBrainImportReason[];
};

export type DuckBrainImportOptions = {
  workspaceId: string;
  config: Pick<CaptureConfig, "ignore" | "redaction" | "repoPath">;
  sourcePath?: string;
  dryRun?: boolean;
  filters?: Array<DuckBrainImportFilter | string>;
  now?: Date;
  submitCandidate?: DuckBrainCandidateSubmitter;
};

type NormalizedDuckBrainRecord = {
  namespace: string;
  key: string;
  content: string;
  createdAt: string;
  originalTags: string[];
  originalMetadata: Record<string, unknown>;
  category: DuckBrainMemoryCategory;
  confidence: DuckBrainMemoryConfidence;
  trustTier: DuckBrainTrustTier;
  title?: string;
};

type NormalizeResult =
  | { ok: true; record: NormalizedDuckBrainRecord }
  | { ok: false; code: DuckBrainImportReasonCode; message: string };

export class DuckBrainImportError extends Error {
  readonly code: string;
  readonly statusCode = 400;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code = "DUCKBRAIN_IMPORT_INVALID", details?: Record<string, unknown>) {
    super(message);
    this.name = "DuckBrainImportError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { error: string; code: string; details?: Record<string, unknown> } {
    return {
      error: this.message,
      code: this.code,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export async function importDuckBrainJsonlFile(inputPath: string, options: DuckBrainImportOptions): Promise<DuckBrainImportSummary> {
  const absolutePath = path.resolve(inputPath);
  const stats = statSync(absolutePath);
  if (!stats.isFile()) {
    throw new DuckBrainImportError(`DuckBrain import path is not a file: ${inputPath}`, "DUCKBRAIN_IMPORT_NOT_FILE", {
      path: inputPath,
    });
  }
  if (!enforceContextSizeLimit(stats.size, options.config.ignore, "event")) {
    throw new DuckBrainImportError("DuckBrain JSONL file exceeds capture event size limit.", "DUCKBRAIN_IMPORT_FILE_TOO_LARGE", {
      path: inputPath,
      bytes: stats.size,
      maxBytes: options.config.ignore.maxEventBytes,
    });
  }

  return importDuckBrainJsonlText(readFileSync(absolutePath, "utf8"), {
    ...options,
    sourcePath: options.sourcePath ?? absolutePath,
  });
}

export async function importDuckBrainJsonlText(text: string, options: DuckBrainImportOptions): Promise<DuckBrainImportSummary> {
  const dryRun = options.dryRun === true;
  if (!dryRun && !options.submitCandidate) {
    throw new DuckBrainImportError("DuckBrain import requires a candidate submitter unless dryRun=true.", "DUCKBRAIN_IMPORT_NO_SUBMITTER");
  }

  const filters = normalizeDuckBrainFilters(options.filters ?? []);
  const sourcePath = options.sourcePath ?? "(inline)";
  const summarySourcePath = String(redactContextPayload(sourcePath, options.config.redaction, { repoPath: options.config.repoPath }));
  const importTime = (options.now ?? new Date()).toISOString();
  const summary: DuckBrainImportSummary = {
    dryRun,
    sourcePath: summarySourcePath,
    workspaceId: options.workspaceId,
    total: 0,
    imported: 0,
    skipped: 0,
    duplicate: 0,
    queued: 0,
    candidates: [],
    reasons: [],
  };
  const seenEntryHashes = new Set<string>();
  const lines = text.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    if (!line.trim()) continue;
    summary.total += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      addSkip(summary, lineNumber, "malformed_json", error instanceof Error ? error.message : "Malformed JSONL line");
      continue;
    }

    const normalized = normalizeDuckBrainRecord(parsed, importTime);
    if (!normalized.ok) {
      addSkip(summary, lineNumber, normalized.code, normalized.message);
      continue;
    }

    if (!matchesDuckBrainFilters(normalized.record, filters)) {
      addSkip(summary, lineNumber, "filtered", "Record did not match import filters.");
      continue;
    }

    const built = buildDuckBrainCandidatePayload({
      line: lineNumber,
      record: normalized.record,
      workspaceId: options.workspaceId,
      config: options.config,
      sourcePath,
      importTime,
      dryRun,
    });

    if (seenEntryHashes.has(built.entryHash)) {
      summary.duplicate += 1;
      summary.reasons.push({
        line: lineNumber,
        code: "duplicate_entry",
        message: `Duplicate DuckBrain entry hash ${built.entryHash}; skipped without error.`,
      });
      continue;
    }
    seenEntryHashes.add(built.entryHash);

    if (!enforceContextSizeLimit(Buffer.byteLength(JSON.stringify(built.payload), "utf8"), options.config.ignore, "event")) {
      addSkip(summary, lineNumber, "payload_too_large", "DuckBrain memory candidate exceeds capture event size limit after redaction.");
      continue;
    }

    if (dryRun) {
      summary.imported += 1;
      summary.candidates.push(toCandidateSummary(built, "dry-run"));
      continue;
    }

    const submission = await options.submitCandidate!(built.payload);
    if (submission.status === "duplicate") {
      summary.duplicate += 1;
      summary.candidates.push(toCandidateSummary(built, "duplicate", submission));
      continue;
    }
    if (submission.status === "queued") {
      summary.queued += 1;
      summary.candidates.push(toCandidateSummary(built, "queued", submission));
      continue;
    }

    summary.imported += 1;
    summary.candidates.push(toCandidateSummary(built, "imported", submission));
  }

  return summary;
}

export function normalizeDuckBrainFilters(input: Array<DuckBrainImportFilter | string>): DuckBrainImportFilter[] {
  return input.flatMap((item) => {
    if (typeof item !== "string") return [item];
    return item
      .split(",")
      .map((raw) => raw.trim())
      .filter(Boolean)
      .map((raw) => {
        const separator = raw.indexOf(":");
        if (separator <= 0) return { raw, value: raw } satisfies DuckBrainImportFilter;
        const field = raw.slice(0, separator).trim().toLowerCase();
        const value = raw.slice(separator + 1).trim();
        if (["namespace", "key", "tag", "content", "metadata"].includes(field)) {
          return { raw, field: field as DuckBrainImportFilter["field"], value };
        }
        return { raw, value: raw } satisfies DuckBrainImportFilter;
      });
  });
}

export function isDuckBrainImportDuplicateResponse(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  const record = response as { created?: unknown; idempotent?: unknown };
  return record.created === false || record.idempotent === true;
}

function normalizeDuckBrainRecord(value: unknown, importTime: string): NormalizeResult {
  if (!isJsonObject(value)) {
    return { ok: false, code: "malformed_json", message: "DuckBrain JSONL record must be an object." };
  }

  const namespace = firstString(value, ["namespace", "ns", "collection", "space"]);
  if (!namespace) {
    return { ok: false, code: "missing_namespace", message: "DuckBrain record is missing namespace." };
  }

  const key = firstString(value, ["key", "sourceRef", "source_ref", "id", "slug"]);
  if (!key) {
    return { ok: false, code: "missing_key", message: "DuckBrain record is missing key/source ref." };
  }

  const contentValue = firstDefined([
    value.content,
    value.value,
    value.text,
    value.memory,
    value.body,
    value.rule,
    isJsonObject(value.entry) ? firstDefined([value.entry.content, value.entry.value, value.entry.text]) : undefined,
  ]);
  const content = stringifyContent(contentValue);
  if (!content) {
    return { ok: false, code: "missing_content", message: "DuckBrain record is missing non-empty content." };
  }

  const tagsValue = firstDefined([
    value.original_tags,
    value.originalTags,
    value.tags,
    isJsonObject(value.metadata) ? firstDefined([value.metadata.original_tags, value.metadata.originalTags, value.metadata.tags]) : undefined,
  ]);
  if (tagsValue === undefined) {
    return { ok: false, code: "missing_tags", message: "DuckBrain record is missing original tags." };
  }
  if (!Array.isArray(tagsValue)) {
    return { ok: false, code: "invalid_tags", message: "DuckBrain original tags must be an array of strings." };
  }
  const originalTags: string[] = [];
  for (const tag of tagsValue) {
    if (typeof tag !== "string") {
      return { ok: false, code: "invalid_tags", message: "DuckBrain original tags must be an array of strings." };
    }
    const trimmed = tag.trim();
    if (trimmed) originalTags.push(trimmed);
  }

  const metadataValue = value.metadata;
  let originalMetadata: Record<string, unknown> = {};
  if (metadataValue !== undefined && metadataValue !== null) {
    if (!isJsonObject(metadataValue)) {
      return { ok: false, code: "invalid_metadata", message: "DuckBrain metadata must be a JSON object when present." };
    }
    originalMetadata = metadataValue;
  }

  const createdValue = firstDefined([
    value.created_at,
    value.createdAt,
    value.created,
    value.timestamp,
    value.ts,
    isJsonObject(value.metadata) ? firstDefined([value.metadata.created_at, value.metadata.createdAt]) : undefined,
  ]);
  const createdAt = parseDuckBrainDate(createdValue, importTime);
  if (!createdAt) {
    return { ok: false, code: "invalid_created_at", message: "DuckBrain created timestamp must be a valid date when present." };
  }

  const category = enumValue(firstString(value, ["category", "suggestedCategory", "suggested_category"]), DUCKBRAIN_MEMORY_CATEGORIES) ?? "Pattern";
  const confidence = enumValue(firstString(value, ["confidence"]), DUCKBRAIN_MEMORY_CONFIDENCES) ?? "low";
  const trustTier = enumValue(firstString(value, ["trustTier", "trust_tier"]), DUCKBRAIN_TRUST_TIERS) ?? DUCKBRAIN_IMPORT_TRUST_TIER;
  const title = firstString(value, ["title", "name"]);

  return {
    ok: true,
    record: {
      namespace,
      key,
      content,
      createdAt,
      originalTags,
      originalMetadata,
      category,
      confidence,
      trustTier,
      ...(title ? { title } : {}),
    },
  };
}

function buildDuckBrainCandidatePayload(input: {
  line: number;
  record: NormalizedDuckBrainRecord;
  workspaceId: string;
  config: Pick<CaptureConfig, "ignore" | "redaction" | "repoPath">;
  sourcePath: string;
  importTime: string;
  dryRun: boolean;
}): { payload: DuckBrainMemoryCandidatePayload; entryHash: string } {
  const { record, config } = input;
  const entryHash = hashContextContent(`${record.namespace}\0${record.key}\0${record.content}`);
  const sourceRef = `duckbrain:${record.namespace}:${record.key}`;
  const redactedNamespace = redactContextText(record.namespace, config.redaction).trim();
  const redactedKey = redactContextText(record.key, config.redaction).trim();
  const redactedSourceRef = redactContextText(sourceRef, config.redaction).trim();
  const redactedContent = truncate(redactContextText(record.content, config.redaction).trim(), 12_000);
  const title = truncate(redactContextText(record.title ?? deriveTitle(record.namespace, record.key, record.content), config.redaction).trim(), 180);
  const rule = truncate(redactedContent, 1_000);
  const redactedMetadata = redactContextPayload(record.originalMetadata, config.redaction, { repoPath: config.repoPath });
  const redactedTags = record.originalTags.map((tag) => redactContextText(tag, config.redaction).trim()).filter(Boolean);
  const safety = analyzeContextSafety({
    namespace: record.namespace,
    key: record.key,
    content: record.content,
    tags: record.originalTags,
    metadata: record.originalMetadata,
  }, config.redaction);
  const context = truncate([
    `Imported from DuckBrain namespace '${redactedNamespace}' with key '${redactedKey}'.`,
    `Created at: ${record.createdAt}.`,
    redactedTags.length > 0 ? `Original tags: ${redactedTags.join(", ")}.` : "Original tags: (empty).",
    "",
    redactedContent,
  ].join("\n"), 14_000);
  const idempotencyKey = `memory-candidate:${input.workspaceId}:duckbrain:${entryHash}`;
  const provenance = {
    command: "rorca-capture import-duckbrain",
    sourceSystem: DUCKBRAIN_IMPORT_SOURCE_SYSTEM,
    safetyContract: CONTEXT_SAFETY_CONTRACT_VERSION,
    redactionEnabled: config.redaction.enabled,
    pendingByDefault: true,
    namespace: redactedNamespace,
    key: redactedKey,
    sourceRef: redactedSourceRef,
    source_ref: redactedSourceRef,
    entryHash,
    entry_hash: entryHash,
    createdAt: record.createdAt,
    created_at: record.createdAt,
    originalTags: redactedTags,
    original_tags: redactedTags,
    line: input.line,
    sourcePath: redactContextPayload(input.sourcePath, config.redaction, { repoPath: config.repoPath }),
  };
  const metadata = {
    schema: DUCKBRAIN_IMPORT_SCHEMA,
    namespace: redactedNamespace,
    key: redactedKey,
    sourceRef: redactedSourceRef,
    source_ref: redactedSourceRef,
    entryHash,
    entry_hash: entryHash,
    createdAt: record.createdAt,
    created_at: record.createdAt,
    originalTags: redactedTags,
    original_tags: redactedTags,
    originalMetadata: redactedMetadata,
    original_metadata: redactedMetadata,
    import: {
      importedAt: input.importTime,
      dryRun: input.dryRun,
      pendingByDefault: true,
      autoApproved: false,
      sourceCanonical: false,
    },
    idempotency: {
      key: idempotencyKey,
      mode: "sha256(namespace + key + content)",
    },
    review: {
      status: "pending",
      pendingByDefault: true,
      autoApproved: false,
    },
    safety: {
      contractVersion: CONTEXT_SAFETY_CONTRACT_VERSION,
      securitySensitive: safety.securitySensitive,
      regulatedDomain: safety.regulatedDomain,
      requiresReview: true,
      findings: safety.findings,
    },
  };

  return {
    entryHash,
    payload: {
      workspaceId: input.workspaceId,
      eventType: DUCKBRAIN_IMPORT_EVENT_TYPE,
      sourceSystem: DUCKBRAIN_IMPORT_SOURCE_SYSTEM,
      sourceRef: redactedSourceRef,
      actor: "duckbrain-import",
      occurredAt: record.createdAt,
      suggestedCategory: record.category,
      title,
      rule,
      context,
      relatedFiles: [],
      confidence: record.confidence,
      trustTier: record.trustTier,
      status: "pending",
      reviewStatus: "pending",
      idempotencyKey,
      provenance,
      metadata,
      securitySensitive: safety.securitySensitive,
      regulatedDomain: safety.regulatedDomain,
      requiresReview: true,
    },
  };
}

function toCandidateSummary(
  built: { payload: DuckBrainMemoryCandidatePayload; entryHash: string },
  status: DuckBrainImportItemStatus,
  submission?: DuckBrainCandidateSubmitResult,
): DuckBrainImportCandidateSummary {
  const payload = built.payload;
  return {
    line: Number(payload.provenance.line ?? 0),
    status,
    namespace: String(payload.metadata.namespace ?? ""),
    key: String(payload.metadata.key ?? ""),
    sourceRef: payload.sourceRef,
    entryHash: built.entryHash,
    createdAt: payload.occurredAt,
    originalTags: Array.isArray(payload.metadata.originalTags) ? payload.metadata.originalTags.map(String) : [],
    idempotencyKey: payload.idempotencyKey,
    title: payload.title,
    securitySensitive: payload.securitySensitive,
    regulatedDomain: payload.regulatedDomain,
    requiresReview: true,
    trustTier: payload.trustTier,
    reviewStatus: "pending",
    ...(submission?.candidateId !== undefined ? { candidateId: submission.candidateId } : {}),
    ...(submission?.queuePath ? { queuePath: submission.queuePath } : {}),
    provenance: payload.provenance,
    metadata: payload.metadata,
  };
}

function addSkip(summary: DuckBrainImportSummary, line: number, code: DuckBrainImportReasonCode, message: string): void {
  summary.skipped += 1;
  summary.reasons.push({ line, code, message });
}

function matchesDuckBrainFilters(record: NormalizedDuckBrainRecord, filters: DuckBrainImportFilter[]): boolean {
  if (filters.length === 0) return true;
  const haystack = [
    record.namespace,
    record.key,
    record.content,
    ...record.originalTags,
    stableStringify(record.originalMetadata),
  ].join("\n").toLowerCase();

  return filters.every((filter) => {
    const value = filter.value.toLowerCase();
    if (!value) return true;
    if (filter.field === "namespace") return record.namespace.toLowerCase().includes(value);
    if (filter.field === "key") return record.key.toLowerCase().includes(value);
    if (filter.field === "tag") return record.originalTags.some((tag) => tag.toLowerCase().includes(value));
    if (filter.field === "content") return record.content.toLowerCase().includes(value);
    if (filter.field === "metadata") return stableStringify(record.originalMetadata).toLowerCase().includes(value);
    return haystack.includes(value);
  });
}

function deriveTitle(namespace: string, key: string, content: string): string {
  const firstLine = content.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  return firstLine ? `DuckBrain ${namespace}/${key}: ${firstLine}` : `DuckBrain ${namespace}/${key}`;
}

function stringifyContent(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (isJsonObject(value) || Array.isArray(value)) return stableStringify(value);
  return null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if ((typeof value === "number" || typeof value === "boolean") && String(value).trim()) return String(value).trim();
  }
  return null;
}

function firstDefined(values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function parseDuckBrainDate(value: unknown, fallback: string): string | null {
  if (value === undefined || value === null || value === "") return fallback;
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function enumValue<T extends readonly string[]>(value: string | null, allowed: T): T[number] | null {
  if (!value) return null;
  return allowed.includes(value as T[number]) ? value as T[number] : null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (isJsonObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 15)).trimEnd()}… [truncated]`;
}
