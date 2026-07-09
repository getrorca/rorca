/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { CaptureConfig } from "./config.js";
import {
  CONTEXT_SAFETY_CONTRACT_VERSION,
  analyzeContextSafety,
  enforceContextSizeLimit,
  hashContextContent,
  redactContextText,
  safeNormalizeWorkspaceRelativePath,
  shouldCapturePath,
} from "./context-safety.js";

export const PR_INGEST_ENDPOINT = "/api/memory/candidates";
export const PR_INGEST_SOURCE_SYSTEM = "rorca-capture";
export const PR_INGEST_EVENT_TYPE = "pr_merge";
export const PR_INGEST_SCHEMA = "rorca.pr_merge/v1";
export const PR_INGEST_IDEMPOTENCY_NAMESPACE = "8c6f216b-b96e-5e5f-9b15-0d6cd16b5f40";

const PR_EVENT_KINDS = ["pr_merge", "release", "hotfix"] as const;
const PR_MEMORY_CATEGORIES = ["Architecture", "Convention", "Bug Fix", "Decision", "Pattern", "Gotcha"] as const;
const PR_MEMORY_CONFIDENCES = ["high", "medium", "low"] as const;
const PR_TRUST_TIERS = ["agent_observation", "working_note", "engineering_decision", "approved_policy", "verified_fact"] as const;

export type PrEventKind = typeof PR_EVENT_KINDS[number];
export type PrMemoryCategory = typeof PR_MEMORY_CATEGORIES[number];
export type PrMemoryConfidence = typeof PR_MEMORY_CONFIDENCES[number];
export type PrTrustTier = typeof PR_TRUST_TIERS[number];
export type PrInputSource = "flag" | "json" | "env" | "derived";

export type RawPrCiInput = {
  provider?: unknown;
  runId?: unknown;
  runUrl?: unknown;
  workflow?: unknown;
  job?: unknown;
  runNumber?: unknown;
  attempt?: unknown;
  ref?: unknown;
  sha?: unknown;
};

export type RawPrIngestInput = {
  provider?: unknown;
  repo?: unknown;
  prNumber?: unknown;
  prUrl?: unknown;
  mergeSha?: unknown;
  author?: unknown;
  title?: unknown;
  body?: unknown;
  changedFiles?: unknown;
  ci?: RawPrCiInput;
  ciProvider?: unknown;
  ciRunId?: unknown;
  ciRunUrl?: unknown;
  ciWorkflow?: unknown;
  ciJob?: unknown;
  ciRunNumber?: unknown;
  ciAttempt?: unknown;
  ciRef?: unknown;
  ciSha?: unknown;
  eventKind?: unknown;
  occurredAt?: unknown;
  category?: unknown;
  confidence?: unknown;
  trustTier?: unknown;
};

export type ParsedPrIngestInput = {
  input: RawPrIngestInput;
  sources: Record<string, PrInputSource>;
  jsonFile?: string;
};

export type NormalizedPrCiMetadata = {
  provider: string;
  runId: string;
  runUrl?: string;
  workflow?: string;
  job?: string;
  runNumber?: string;
  attempt?: string;
  ref?: string;
  sha?: string;
};

export type NormalizedPrIngestInput = {
  provider: string;
  repo: string;
  prNumber: number;
  prUrl?: string;
  mergeSha: string;
  author: string;
  title: string;
  body: string;
  changedFiles: string[];
  ci: NormalizedPrCiMetadata;
  eventKind: PrEventKind;
  occurredAt?: string;
  category: PrMemoryCategory;
  confidence: PrMemoryConfidence;
  trustTier: PrTrustTier;
  sources: Record<string, PrInputSource>;
};

export type PrChangedFile = {
  path: string;
  captured: boolean;
  ignoredReason?: "path-ignored" | "file-too-large" | "not-a-file";
  sizeBytes?: number;
};

export type PrMemoryCandidatePayload = {
  workspaceId: string;
  eventType: typeof PR_INGEST_EVENT_TYPE;
  sourceSystem: typeof PR_INGEST_SOURCE_SYSTEM;
  sourceRef: string;
  actor: string;
  occurredAt?: string;
  suggestedCategory: PrMemoryCategory;
  title: string;
  rule: string;
  context: string;
  relatedFiles: string[];
  confidence: PrMemoryConfidence;
  trustTier: PrTrustTier;
  idempotencyKey: string;
  provenance: Record<string, unknown>;
  metadata: Record<string, unknown>;
  securitySensitive: boolean;
  regulatedDomain: boolean;
  requiresReview: true;
};

export type BuiltPrMemoryCandidate = {
  input: NormalizedPrIngestInput;
  payload: PrMemoryCandidatePayload;
  idempotencyKey: string;
  contentHash: string;
  relatedFiles: string[];
  changedFiles: PrChangedFile[];
};

export class PrIngestInputError extends Error {
  readonly code: string;
  readonly statusCode = 400;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code = "PR_INPUT_INVALID", details?: Record<string, unknown>) {
    super(message);
    this.name = "PrIngestInputError";
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

export class PrIngestDuplicateError extends Error {
  readonly code = "PR_DUPLICATE";
  readonly statusCode = 409;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PrIngestDuplicateError";
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

export function parsePrIngestInput(args: string[], env: NodeJS.ProcessEnv = process.env): ParsedPrIngestInput {
  const parsed = parsePrFlags(args);
  const envInput = normalizePrInputShape(readEnvPrInput(env));
  const jsonInput = parsed.jsonFile ? normalizePrInputShape(readJsonInputFile(parsed.jsonFile)) : {};
  const flagInput = normalizePrInputShape(parsed.flags);
  const merged = mergePrInputs([
    { source: "flag", input: flagInput },
    { source: "json", input: jsonInput },
    { source: "env", input: envInput },
  ]);

  return {
    input: merged.input,
    sources: merged.sources,
    ...(parsed.jsonFile ? { jsonFile: parsed.jsonFile } : {}),
  };
}

export function buildPrMemoryCandidatePayload(input: ParsedPrIngestInput, config: CaptureConfig, workspaceId: string): BuiltPrMemoryCandidate {
  const normalized = normalizePrInput(input.input, input.sources);
  const changedFiles = validatePrChangedFiles(normalized.changedFiles, config);
  const relatedFiles = changedFiles.filter((file) => file.captured).map((file) => file.path);
  const titleText = redactContextText(normalized.title, config.redaction).trim();
  const bodyText = truncate(redactContextText(normalized.body, config.redaction).trim(), 12_000);
  const author = redactContextText(normalized.author, config.redaction).trim();
  const prUrl = normalized.prUrl ? redactContextText(normalized.prUrl, config.redaction).trim() : undefined;
  const sourceRef = `pr:${normalized.provider}:${normalized.repo}#${normalized.prNumber}:${normalized.mergeSha}`;
  const actor = author ? `pr:${author}` : "pr";
  const idempotencyName = `${normalized.mergeSha}:${normalized.ci.runId}`;
  const idempotencyKey = uuidV5(idempotencyName, PR_INGEST_IDEMPOTENCY_NAMESPACE);
  const prDisplay = prUrl ? `#${normalized.prNumber} (${prUrl})` : `#${normalized.prNumber}`;
  const candidateTitle = truncate(`PR ${prDisplay} merged: ${titleText}`, 180);
  const rule = truncate(`Merged PR #${normalized.prNumber} in ${normalized.repo}: ${titleText}`, 500);
  const context = formatPrContext({ normalized, titleText, bodyText, author, prUrl, changedFiles });
  const contentHash = hashContextContent(JSON.stringify({
    provider: normalized.provider,
    repo: normalized.repo,
    prNumber: normalized.prNumber,
    prUrl,
    mergeSha: normalized.mergeSha,
    title: titleText,
    body: bodyText,
    author,
    changedFiles,
    ci: normalized.ci,
    eventKind: normalized.eventKind,
  }));
  const safety = analyzeContextSafety({
    title: candidateTitle,
    rule,
    context,
    changedFiles,
    ci: normalized.ci,
    prUrl,
  }, config.redaction);

  const payload: PrMemoryCandidatePayload = {
    workspaceId,
    eventType: PR_INGEST_EVENT_TYPE,
    sourceSystem: PR_INGEST_SOURCE_SYSTEM,
    sourceRef,
    actor,
    ...(normalized.occurredAt ? { occurredAt: normalized.occurredAt } : {}),
    suggestedCategory: normalized.category,
    title: candidateTitle,
    rule,
    context,
    relatedFiles,
    confidence: normalized.confidence,
    trustTier: normalized.trustTier,
    idempotencyKey,
    provenance: {
      command: "rorca-capture ingest-pr",
      sourceSystem: PR_INGEST_SOURCE_SYSTEM,
      safetyContract: CONTEXT_SAFETY_CONTRACT_VERSION,
      pathFiltering: "context-safety",
      redactionEnabled: config.redaction.enabled,
      inputPrecedence: ["flags", "json", "env"],
      inputSources: normalized.sources,
      ...(input.jsonFile ? { jsonFile: path.resolve(input.jsonFile) } : {}),
    },
    metadata: {
      schema: PR_INGEST_SCHEMA,
      eventKind: normalized.eventKind,
      contentHash,
      idempotency: {
        key: idempotencyKey,
        namespace: PR_INGEST_IDEMPOTENCY_NAMESPACE,
        mode: "uuidv5(mergeSha:ciRunId)",
        mergeShaCiRunIdHash: hashContextContent(idempotencyName),
      },
      pr: {
        provider: normalized.provider,
        repo: normalized.repo,
        number: normalized.prNumber,
        ...(prUrl ? { url: prUrl } : {}),
        mergeSha: normalized.mergeSha,
        author,
        title: titleText,
        body: bodyText,
      },
      files: {
        changed: changedFiles,
        captured: relatedFiles,
        ignored: changedFiles.filter((file) => !file.captured).map((file) => ({ path: file.path, reason: file.ignoredReason ?? "path-ignored" })),
        changedCount: changedFiles.length,
        capturedCount: relatedFiles.length,
        ignoredCount: changedFiles.filter((file) => !file.captured).length,
      },
      ci: normalized.ci,
      review: {
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
    },
    securitySensitive: safety.securitySensitive,
    regulatedDomain: safety.regulatedDomain,
    requiresReview: true,
  };

  const eventBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (!enforceContextSizeLimit(eventBytes, config.ignore, "event")) {
    throw new PrIngestInputError("PR ingestion payload exceeds capture event size limit.", "PR_PAYLOAD_TOO_LARGE", {
      bytes: eventBytes,
      maxBytes: config.ignore.maxEventBytes,
    });
  }

  return {
    input: normalized,
    payload,
    idempotencyKey,
    contentHash,
    relatedFiles,
    changedFiles,
  };
}

export function isPrIngestDuplicateResponse(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  const record = response as { created?: unknown; idempotent?: unknown };
  return record.created === false || record.idempotent === true;
}

function parsePrFlags(args: string[]): { flags: RawPrIngestInput; jsonFile?: string } {
  const flags: RawPrIngestInput = {};
  const changedFiles: string[] = [];
  let jsonFile: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--input" || arg === "--json-file" || arg === "--metadata-file") {
      jsonFile = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--provider") {
      flags.provider = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--repo" || arg === "--repository") {
      flags.repo = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--pr-number" || arg === "--number") {
      flags.prNumber = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--pr-url" || arg === "--url") {
      flags.prUrl = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--merge-sha" || arg === "--sha") {
      flags.mergeSha = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--author") {
      flags.author = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--title") {
      flags.title = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--body") {
      flags.body = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--body-file") {
      flags.body = readTextFile(requirePrValue(args, ++index, arg));
      continue;
    }
    if (arg === "--changed-files" || arg === "--files") {
      changedFiles.push(...splitChangedFiles(requirePrValue(args, ++index, arg)));
      continue;
    }
    if (arg === "--changed-file" || arg === "--file") {
      changedFiles.push(requirePrValue(args, ++index, arg));
      continue;
    }
    if (arg === "--ci-provider") {
      flags.ciProvider = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--ci-run-id") {
      flags.ciRunId = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--ci-run-url") {
      flags.ciRunUrl = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--ci-workflow") {
      flags.ciWorkflow = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--ci-job") {
      flags.ciJob = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--ci-run-number") {
      flags.ciRunNumber = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--ci-attempt") {
      flags.ciAttempt = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--ci-ref") {
      flags.ciRef = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--ci-sha") {
      flags.ciSha = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--event-kind") {
      flags.eventKind = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--occurred-at") {
      flags.occurredAt = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--category") {
      flags.category = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--confidence") {
      flags.confidence = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg === "--trust" || arg === "--trust-tier") {
      flags.trustTier = requirePrValue(args, ++index, arg);
      continue;
    }
    if (arg.startsWith("--")) {
      throw new PrIngestInputError(`Unknown ingest-pr option: ${arg}`, "PR_UNKNOWN_OPTION", { option: arg });
    }
    throw new PrIngestInputError(`Unexpected ingest-pr argument: ${arg}`, "PR_UNEXPECTED_ARGUMENT", { argument: arg });
  }

  if (changedFiles.length > 0) {
    flags.changedFiles = changedFiles;
  }

  return { flags, ...(jsonFile ? { jsonFile } : {}) };
}

function readEnvPrInput(env: NodeJS.ProcessEnv): RawPrIngestInput {
  const githubEvent = readGithubEventInput(env.GITHUB_EVENT_PATH);
  const derivedProvider = env.RORCA_PR_PROVIDER ?? env.RORCA_PROVIDER ?? (env.GITHUB_ACTIONS === "true" ? "github" : env.GITLAB_CI === "true" ? "gitlab" : undefined);
  const githubPr = githubEvent.pull_request && typeof githubEvent.pull_request === "object"
    ? githubEvent.pull_request as Record<string, unknown>
    : undefined;
  const githubRepo = githubEvent.repository && typeof githubEvent.repository === "object"
    ? githubEvent.repository as Record<string, unknown>
    : undefined;
  const prNumber = env.RORCA_PR_NUMBER
    ?? env.GITHUB_PR_NUMBER
    ?? env.CI_MERGE_REQUEST_IID
    ?? stringFromUnknown(githubPr?.number)
    ?? parseGithubPrNumberFromRef(env.GITHUB_REF);
  const repo = env.RORCA_PR_REPO
    ?? env.RORCA_REPO
    ?? env.GITHUB_REPOSITORY
    ?? env.CI_PROJECT_PATH
    ?? stringFromUnknown(githubRepo?.full_name)
    ?? stringFromUnknown(githubRepo?.name);
  const ciRunId = env.RORCA_CI_RUN_ID ?? env.GITHUB_RUN_ID ?? env.CI_PIPELINE_ID ?? env.BUILD_BUILDID;
  const ciRunUrl = env.RORCA_CI_RUN_URL
    ?? env.CI_PIPELINE_URL
    ?? env.BUILD_BUILDURI
    ?? deriveCiRunUrl({ provider: derivedProvider, repo, runId: ciRunId, env });
  const gitlabPrUrl = env.CI_MERGE_REQUEST_PROJECT_URL && prNumber
    ? `${env.CI_MERGE_REQUEST_PROJECT_URL}/-/merge_requests/${prNumber}`
    : undefined;
  const githubUrl = stringFromUnknown(githubPr?.html_url);

  return {
    provider: derivedProvider,
    repo,
    prNumber,
    prUrl: env.RORCA_PR_URL ?? githubUrl ?? gitlabPrUrl ?? derivePrUrl({ provider: derivedProvider, repo, prNumber, env }),
    mergeSha: env.RORCA_PR_MERGE_SHA ?? env.RORCA_MERGE_SHA ?? env.GITHUB_SHA ?? env.CI_COMMIT_SHA ?? stringFromUnknown(githubPr?.merge_commit_sha),
    author: env.RORCA_PR_AUTHOR ?? env.GITHUB_ACTOR ?? env.GITLAB_USER_LOGIN ?? stringFromUnknown((githubPr?.user as Record<string, unknown> | undefined)?.login),
    title: env.RORCA_PR_TITLE ?? env.CI_MERGE_REQUEST_TITLE ?? stringFromUnknown(githubPr?.title),
    body: env.RORCA_PR_BODY ?? env.CI_MERGE_REQUEST_DESCRIPTION ?? stringFromUnknown(githubPr?.body),
    changedFiles: splitChangedFiles(env.RORCA_PR_CHANGED_FILES ?? env.RORCA_CHANGED_FILES),
    ciProvider: env.RORCA_CI_PROVIDER ?? (env.GITHUB_ACTIONS === "true" ? "github" : env.GITLAB_CI === "true" ? "gitlab" : env.TF_BUILD === "True" ? "azure" : undefined),
    ciRunId,
    ciRunUrl,
    ciWorkflow: env.RORCA_CI_WORKFLOW ?? env.GITHUB_WORKFLOW ?? env.CI_PIPELINE_NAME,
    ciJob: env.RORCA_CI_JOB ?? env.GITHUB_JOB ?? env.CI_JOB_NAME,
    ciRunNumber: env.RORCA_CI_RUN_NUMBER ?? env.GITHUB_RUN_NUMBER ?? env.CI_PIPELINE_IID,
    ciAttempt: env.RORCA_CI_ATTEMPT ?? env.GITHUB_RUN_ATTEMPT,
    ciRef: env.RORCA_CI_REF ?? env.GITHUB_REF_NAME ?? env.CI_COMMIT_REF_NAME,
    ciSha: env.RORCA_CI_SHA ?? env.GITHUB_SHA ?? env.CI_COMMIT_SHA,
    eventKind: env.RORCA_PR_EVENT_KIND,
    occurredAt: env.RORCA_PR_OCCURRED_AT ?? stringFromUnknown(githubPr?.merged_at),
    category: env.RORCA_PR_MEMORY_CATEGORY,
    confidence: env.RORCA_PR_CONFIDENCE,
    trustTier: env.RORCA_PR_TRUST_TIER,
  };
}

function mergePrInputs(inputs: Array<{ source: PrInputSource; input: RawPrIngestInput }>): { input: RawPrIngestInput; sources: Record<string, PrInputSource> } {
  const output: RawPrIngestInput = {};
  const sources: Record<string, PrInputSource> = {};
  const fields: Array<keyof RawPrIngestInput> = [
    "provider",
    "repo",
    "prNumber",
    "prUrl",
    "mergeSha",
    "author",
    "title",
    "body",
    "changedFiles",
    "eventKind",
    "occurredAt",
    "category",
    "confidence",
    "trustTier",
  ];
  const ciFields: Array<keyof RawPrCiInput> = ["provider", "runId", "runUrl", "workflow", "job", "runNumber", "attempt", "ref", "sha"];

  for (const field of fields) {
    for (const candidate of inputs) {
      const value = candidate.input[field];
      if (hasInputValue(value)) {
        output[field] = value as never;
        sources[field] = candidate.source;
        break;
      }
    }
  }

  const ci: RawPrCiInput = {};
  for (const field of ciFields) {
    for (const candidate of inputs) {
      const value = candidate.input.ci?.[field] ?? topLevelCiValue(candidate.input, field);
      if (hasInputValue(value)) {
        ci[field] = value as never;
        sources[`ci.${field}`] = candidate.source;
        break;
      }
    }
  }
  if (Object.keys(ci).length > 0) {
    output.ci = ci;
  }

  return { input: output, sources };
}

function normalizePrInputShape(value: unknown): RawPrIngestInput {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const pullRequest = objectFrom(record.pull_request ?? record.pullRequest ?? record.pr);
  const repository = objectFrom(record.repository);
  const authorObject = objectFrom(record.author) ?? objectFrom(pullRequest?.user);
  const ciObject = objectFrom(record.ci) ?? objectFrom(record.ciMetadata) ?? objectFrom(record.ci_metadata);

  return {
    provider: pick(record, "provider", "vcsProvider", "vcs_provider") ?? pick(repository, "provider"),
    repo: pick(record, "repo", "repository", "repositoryFullName", "repository_full_name") ?? pick(repository, "full_name", "fullName", "name"),
    prNumber: pick(record, "prNumber", "pr_number", "number", "pullRequestNumber", "pull_request_number") ?? pick(pullRequest, "number", "prNumber", "pr_number"),
    prUrl: pick(record, "prUrl", "pr_url", "url", "html_url") ?? pick(pullRequest, "html_url", "url"),
    mergeSha: pick(record, "mergeSha", "merge_sha", "mergeCommitSha", "merge_commit_sha", "sha") ?? pick(pullRequest, "merge_commit_sha", "mergeCommitSha"),
    author: pick(record, "author", "user", "actor") ?? pick(authorObject, "login", "name", "username"),
    title: pick(record, "title") ?? pick(pullRequest, "title"),
    body: pick(record, "body", "description") ?? pick(pullRequest, "body", "description"),
    changedFiles: pick(record, "changedFiles", "changed_files", "files") ?? pick(pullRequest, "changedFiles", "changed_files", "files"),
    ci: ciObject ? {
      provider: pick(ciObject, "provider"),
      runId: pick(ciObject, "runId", "run_id", "id"),
      runUrl: pick(ciObject, "runUrl", "run_url", "url"),
      workflow: pick(ciObject, "workflow"),
      job: pick(ciObject, "job"),
      runNumber: pick(ciObject, "runNumber", "run_number"),
      attempt: pick(ciObject, "attempt"),
      ref: pick(ciObject, "ref"),
      sha: pick(ciObject, "sha"),
    } : undefined,
    ciProvider: pick(record, "ciProvider", "ci_provider"),
    ciRunId: pick(record, "ciRunId", "ci_run_id"),
    ciRunUrl: pick(record, "ciRunUrl", "ci_run_url"),
    ciWorkflow: pick(record, "ciWorkflow", "ci_workflow"),
    ciJob: pick(record, "ciJob", "ci_job"),
    ciRunNumber: pick(record, "ciRunNumber", "ci_run_number"),
    ciAttempt: pick(record, "ciAttempt", "ci_attempt"),
    ciRef: pick(record, "ciRef", "ci_ref"),
    ciSha: pick(record, "ciSha", "ci_sha"),
    eventKind: pick(record, "eventKind", "event_kind", "kind"),
    occurredAt: pick(record, "occurredAt", "occurred_at", "mergedAt", "merged_at"),
    category: pick(record, "category", "suggestedCategory", "suggested_category"),
    confidence: pick(record, "confidence"),
    trustTier: pick(record, "trustTier", "trust_tier"),
  };
}

function normalizePrInput(input: RawPrIngestInput, sources: Record<string, PrInputSource>): NormalizedPrIngestInput {
  const provider = requiredString(input.provider, "provider");
  const repo = requiredString(input.repo, "repo");
  const prNumber = requiredPositiveInteger(input.prNumber, "prNumber");
  const prUrl = optionalString(input.prUrl);
  const mergeSha = requiredShaLike(input.mergeSha, "mergeSha");
  const author = requiredString(input.author, "author");
  const title = requiredString(input.title, "title");
  const body = optionalString(input.body) ?? "";
  const changedFiles = normalizeChangedFiles(input.changedFiles);
  if (changedFiles.length === 0) {
    throw new PrIngestInputError("ingest-pr requires at least one changed file via --changed-files, JSON changedFiles, or RORCA_PR_CHANGED_FILES.", "PR_REQUIRED_FIELD_MISSING", {
      field: "changedFiles",
    });
  }
  const ciProvider = optionalString(input.ci?.provider ?? input.ciProvider) ?? provider;
  const ciRunId = requiredString(input.ci?.runId ?? input.ciRunId, "ci.runId");
  const eventKind = validateEnum(optionalString(input.eventKind) ?? "pr_merge", PR_EVENT_KINDS, "eventKind");
  const category = validateEnum(optionalString(input.category) ?? "Decision", PR_MEMORY_CATEGORIES, "category");
  const confidence = validateEnum(optionalString(input.confidence) ?? "low", PR_MEMORY_CONFIDENCES, "confidence");
  const trustTier = validateEnum(optionalString(input.trustTier) ?? "agent_observation", PR_TRUST_TIERS, "trustTier");
  const occurredAt = normalizeOptionalIsoDate(input.occurredAt, "occurredAt");

  return {
    provider,
    repo,
    prNumber,
    ...(prUrl ? { prUrl } : {}),
    mergeSha,
    author,
    title,
    body,
    changedFiles,
    ci: {
      provider: ciProvider,
      runId: ciRunId,
      ...optionalField("runUrl", input.ci?.runUrl ?? input.ciRunUrl),
      ...optionalField("workflow", input.ci?.workflow ?? input.ciWorkflow),
      ...optionalField("job", input.ci?.job ?? input.ciJob),
      ...optionalField("runNumber", input.ci?.runNumber ?? input.ciRunNumber),
      ...optionalField("attempt", input.ci?.attempt ?? input.ciAttempt),
      ...optionalField("ref", input.ci?.ref ?? input.ciRef),
      ...optionalField("sha", input.ci?.sha ?? input.ciSha),
    },
    eventKind,
    ...(occurredAt ? { occurredAt } : {}),
    category,
    confidence,
    trustTier,
    sources,
  };
}

function validatePrChangedFiles(files: string[], config: CaptureConfig): PrChangedFile[] {
  const unique = new Set<string>();
  const result: PrChangedFile[] = [];

  for (const rawFile of files) {
    const normalized = safeNormalizeWorkspaceRelativePath(config.repoPath, rawFile);
    if (unique.has(normalized)) continue;
    unique.add(normalized);

    if (!shouldCapturePath(normalized, config.ignore)) {
      result.push({ path: normalized, captured: false, ignoredReason: "path-ignored" });
      continue;
    }

    const absolute = path.resolve(config.repoPath, normalized);
    if (existsSync(absolute)) {
      const stats = statSync(absolute);
      if (!stats.isFile()) {
        result.push({ path: normalized, captured: false, ignoredReason: "not-a-file" });
        continue;
      }
      if (!enforceContextSizeLimit(stats.size, config.ignore, "file")) {
        result.push({ path: normalized, captured: false, ignoredReason: "file-too-large", sizeBytes: stats.size });
        continue;
      }
      result.push({ path: normalized, captured: true, sizeBytes: stats.size });
      continue;
    }

    result.push({ path: normalized, captured: true });
  }

  return result;
}

function formatPrContext(input: {
  normalized: NormalizedPrIngestInput;
  titleText: string;
  bodyText: string;
  author: string;
  prUrl?: string;
  changedFiles: PrChangedFile[];
}): string {
  const { normalized, titleText, bodyText, author, prUrl, changedFiles } = input;
  const ci = normalized.ci;
  const lines = [
    `PR event kind: ${normalized.eventKind}`,
    `Provider/repo: ${normalized.provider}/${normalized.repo}`,
    `PR: #${normalized.prNumber}${prUrl ? ` ${prUrl}` : ""}`,
    `Merge SHA: ${normalized.mergeSha}`,
    `Author: ${author}`,
    `Title: ${titleText}`,
    `CI: ${ci.provider} run ${ci.runId}${ci.runUrl ? ` (${ci.runUrl})` : ""}`,
    ...(ci.workflow ? [`Workflow: ${ci.workflow}`] : []),
    ...(ci.job ? [`Job: ${ci.job}`] : []),
    ...(ci.ref ? [`Ref: ${ci.ref}`] : []),
    "Changed files:",
    ...changedFiles.map((file) => `- ${file.path}${file.captured ? "" : ` (${file.ignoredReason ?? "ignored"})`}`),
    "Body:",
    bodyText || "(empty)",
  ];
  return lines.join("\n");
}

function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = uuidToBytes(namespace);
  const hash = createHash("sha1").update(Buffer.from(namespaceBytes)).update(name).digest();
  const bytes = Uint8Array.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuid(bytes);
}

function uuidToBytes(uuid: string): Uint8Array {
  const compact = uuid.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new PrIngestInputError(`Invalid UUID namespace for PR ingestion: ${uuid}`, "PR_INVALID_NAMESPACE");
  }
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readJsonInputFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PrIngestInputError(`Invalid ingest-pr JSON file '${filePath}': ${message}`, "PR_JSON_INVALID", { filePath });
  }
}

function readGithubEventInput(filePath: string | undefined): Record<string, unknown> {
  if (!filePath || !existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function readTextFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PrIngestInputError(`Cannot read ${filePath}: ${message}`, "PR_FILE_READ_FAILED", { filePath });
  }
}

function requirePrValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new PrIngestInputError(`${flag} requires a value.`, "PR_REQUIRED_OPTION_VALUE", { option: flag });
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) {
    throw new PrIngestInputError(`ingest-pr requires ${field}.`, "PR_REQUIRED_FIELD_MISSING", { field });
  }
  return normalized;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const raw = requiredString(value, field);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw.replace(/^0+/, "") && raw !== "0") {
    throw new PrIngestInputError(`${field} must be a positive integer.`, "PR_FIELD_INVALID", { field });
  }
  return parsed;
}

function requiredShaLike(value: unknown, field: string): string {
  const raw = requiredString(value, field).toLowerCase();
  if (!/^[0-9a-f]{7,64}$/.test(raw)) {
    throw new PrIngestInputError(`${field} must be a git SHA-like hexadecimal string.`, "PR_FIELD_INVALID", { field });
  }
  return raw;
}

function optionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).trim();
  }
  return undefined;
}

function optionalField<T extends string>(key: T, value: unknown): Record<T, string> | Record<string, never> {
  const normalized = optionalString(value);
  return normalized ? { [key]: normalized } as Record<T, string> : {};
}

function normalizeChangedFiles(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((item) => {
      if (typeof item === "string") return splitChangedFiles(item);
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const file = optionalString(record.path ?? record.filename ?? record.name);
        return file ? [file] : [];
      }
      return [];
    }))];
  }
  return [...new Set(splitChangedFiles(optionalString(value)))];
}

function splitChangedFiles(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[\n,]/u).map((item) => item.trim()).filter(Boolean);
}

function hasInputValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function topLevelCiValue(input: RawPrIngestInput, field: keyof RawPrCiInput): unknown {
  switch (field) {
    case "provider": return input.ciProvider;
    case "runId": return input.ciRunId;
    case "runUrl": return input.ciRunUrl;
    case "workflow": return input.ciWorkflow;
    case "job": return input.ciJob;
    case "runNumber": return input.ciRunNumber;
    case "attempt": return input.ciAttempt;
    case "ref": return input.ciRef;
    case "sha": return input.ciSha;
  }
}

function validateEnum<T extends readonly string[]>(value: string, allowed: T, field: string): T[number] {
  if ((allowed as readonly string[]).includes(value)) return value as T[number];
  throw new PrIngestInputError(`${field} must be one of: ${allowed.join(", ")}.`, "PR_FIELD_INVALID", { field, allowed });
}

function normalizeOptionalIsoDate(value: unknown, field: string): string | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new PrIngestInputError(`${field} must be a valid ISO timestamp.`, "PR_FIELD_INVALID", { field });
  }
  return date.toISOString();
}

function objectFrom(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function pick(record: Record<string, unknown> | undefined, ...keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (hasInputValue(value)) return value;
  }
  return undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  return optionalString(value);
}

function parseGithubPrNumberFromRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const match = ref.match(/^refs\/pull\/(\d+)\//u);
  return match?.[1];
}

function derivePrUrl(input: { provider?: string; repo?: string; prNumber?: string; env: NodeJS.ProcessEnv }): string | undefined {
  if (!input.provider || !input.repo || !input.prNumber) return undefined;
  if (input.provider === "github") {
    const server = input.env.GITHUB_SERVER_URL ?? "https://github.com";
    return `${server.replace(/\/$/u, "")}/${input.repo}/pull/${input.prNumber}`;
  }
  if (input.provider === "gitlab" && input.env.CI_PROJECT_URL) {
    return `${input.env.CI_PROJECT_URL.replace(/\/$/u, "")}/-/merge_requests/${input.prNumber}`;
  }
  return undefined;
}

function deriveCiRunUrl(input: { provider?: string; repo?: string; runId?: string; env: NodeJS.ProcessEnv }): string | undefined {
  if (input.provider === "github" && input.repo && input.runId) {
    const server = input.env.GITHUB_SERVER_URL ?? "https://github.com";
    return `${server.replace(/\/$/u, "")}/${input.repo}/actions/runs/${input.runId}`;
  }
  return undefined;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}
