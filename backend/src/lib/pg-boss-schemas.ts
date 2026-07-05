/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * pg-boss-schemas.ts — Zod schemas for pg-boss job payloads.
 *
 * All schemas use .strict() to reject extra fields, ensuring that callers
 * (pipeline trigger route, retry route, cancel) pass exactly the expected
 * shape and nothing more. Any drift in the caller surfaces immediately as a
 * ZodError at parse time rather than silently being ignored.
 *
 * Exported as named const/type pairs so consumers can both validate at
 * runtime and get TypeScript inferred types via z.infer<>.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { TerminalModeSchema } from './terminal-mode';

// ── pipeline:run ─────────────────────────────────────────────────────────────

/**
 * Payload for the `pipeline:run` pg-boss queue.
 * Sent by POST /api/pipeline/trigger, consumed by worker handlePipelineRun.
 */
/**
 * Merge strategy for worktree runs — controls what happens after all stories pass.
 *   - direct:      merge to main + push (maximum velocity, default)
 *   - pr:          push branch + create PR (CI-gated)
 *   - draft-pr:    push branch + create Draft PR (review-first)
 *   - branch-only: push branch to remote, no PR, no merge (manual control)
 */
export const MergeStrategyEnum = z.enum(['direct', 'pr', 'draft-pr', 'branch-only']);
export type MergeStrategy = z.infer<typeof MergeStrategyEnum>;

export const PipelineRunJobPayload = z.object({
  runId: z.number().int().positive(),
  specPath: z.string().min(1),
  workspacePath: z.string().min(1),
  agent: z.enum(['claude', 'opencode', 'codex', 'pi']),
  model: z.string().nullable(),
  worktreePath: z.string().nullable(),
  branchName: z.string().nullable(),
  terminalMode: TerminalModeSchema.optional().default('ansi-html'),
  autoWorktree: z.boolean().optional().default(false),
  autoMerge: z.boolean().optional().default(false),
  mergeStrategy: MergeStrategyEnum.optional().default('direct'),
  envOverrides: z.record(z.string(), z.string()).optional().default({}),
  startFromStoryId: z.string().optional(),
  specificStory: z.string().optional(),
  triggeredVia: z.enum(['queue', 'run_now']).default('run_now'),
  includeGraph: z.boolean().optional().default(false),
  agentOverride: z.enum(['claude', 'opencode', 'codex', 'pi']).optional(),
  thinkingEnabled: z.boolean().optional(),
  thinkingBudget: z.number().int().positive().optional(),
  effortLevel: z.enum(['low', 'medium', 'high', 'max']).optional(),
  reasoningEffort: z.string().optional(),
}).strict();

export type PipelineRunJobPayloadType = z.infer<typeof PipelineRunJobPayload>;

// ── pipeline:retry ───────────────────────────────────────────────────────────

/**
 * Payload for the `pipeline:retry` pg-boss queue.
 * Sent by POST /api/pipeline/runs/:id/retry, consumed by worker handlePipelineRetry.
 */
export const PipelineRetryJobPayload = z.object({
  runId: z.number().int().positive(),
  originalRunId: z.number().int().positive(),
  storyIds: z.array(z.string()),
  workspacePath: z.string().min(1),
  specPath: z.string().min(1),
  retrySpecPath: z.string().min(1),
  agent: z.enum(['claude', 'opencode', 'codex', 'pi']),
  model: z.string().nullable(),
  worktreePath: z.string().nullable(),
  sequenceOffset: z.number().int().min(0),
  envOverrides: z.record(z.string(), z.string()).optional().default({}),
  includeGraph: z.boolean().optional().default(false),
}).strict();

export type PipelineRetryJobPayloadType = z.infer<typeof PipelineRetryJobPayload>;

// ── pipeline:cancel ──────────────────────────────────────────────────────────

/**
 * Payload for the `pipeline:cancel` pg-boss queue.
 * Sent by DELETE /api/pipeline/runs/:id/cancel when the run is actively executing.
 */
export const PipelineCancelJobPayload = z.object({
  runId: z.number().int().positive(),
}).strict();

export type PipelineCancelJobPayloadType = z.infer<typeof PipelineCancelJobPayload>;

// ── pipeline:merge ──────────────────────────────────────────────────────────

/**
 * Payload for the `pipeline:merge` pg-boss queue.
 * Sent by POST /api/pipeline/runs/:id/retry-merge, consumed by worker handlePipelineMerge.
 */
export const PipelineMergeJobPayload = z.object({
  runId: z.number().int().positive(),
  branch: z.string().min(1),
  workspaceId: z.string().min(1),
}).strict();

export type PipelineMergeJobPayloadType = z.infer<typeof PipelineMergeJobPayload>;

// ── spec jobs ────────────────────────────────────────────────────────────────

export const SpecJobPayload = z.object({
  jobId: z.string().uuid(),
  specId: z.string().min(1),
  workspaceId: z.string().min(1),
  storyId: z.string().min(1).nullable().optional(),
  mode: z.enum(['fetchAll', 'recent', 'semantic']).optional(),
  currentTask: z.string().min(1).optional(),
  storyText: z.string().min(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  includeGraph: z.boolean().optional(),
}).strict();

export type SpecJobPayloadType = z.infer<typeof SpecJobPayload>;

// ── context:capture ─────────────────────────────────────────────────────────

export const CONTEXT_EVENT_PAYLOAD_SCHEMA_VERSION = '2026-07-ucc-007.v1' as const;

export const CapturePolicyModeEnum = z.enum(['off', 'metadata-only', 'command-summary', 'explicit-transcript-import']);
export const CaptureSourceEnum = z.enum([
  'repoDaemon',
  'gitHook',
  'shellIntegration',
  'vscodeExtension',
  'agentAdapter',
  'mcpSlashCommand',
  'ciPrIngestion',
  'externalImport',
]);
export const SourceSystemEnum = z.enum(['shell', 'ide', 'vscode', 'vscode-fork', 'agent_adapter', 'repo_daemon', 'git_hook', 'ci', 'mcp', 'external_import']);
export const ContextEventTypeEnum = z.enum(['agent_cli_session', 'ide_session', 'shell_command', 'editor_activity', 'explicit_memory', 'git_commit', 'ci_pr']);
export const AgentBinaryEnum = z.enum(['claude', 'codex', 'opencode', 'pi', 'aider', 'cursor', 'custom', 'unknown']);

// Keep values in sync with shared/contracts/trust.ts. The strings are intentionally
// low-granularity so capture can classify provenance without implying memory truth.
export const TrustTierEnum = z.enum(['untrusted', 'local', 'verified', 'privileged']);

const nullableString = () => z.string().nullish().transform((value) => value ?? null);
const sha256String = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const ContextEventIdempotencyGuidance = {
  agent_cli_session: 'sha256:event_type + source_system + tool_name + session_id + workspace_id + occurred_at_minute + command_hash',
  ide_session: 'sha256:event_type + source_system + host_application + session_id + workspace_id + occurred_at_hour',
  shell_command: 'sha256:event_type + source_system + session_id + workspace_id + occurred_at + phase + command_hash + exit_code',
  editor_activity: 'sha256:event_type + source_system + host_application + session_id + workspace_id + occurred_at + activity_type + related_file_paths',
  explicit_memory: 'sha256:event_type + source_system + tool_name + session_id + workspace_id + memory_hash + occurred_at',
  git_commit: 'sha256:event_type + source_system + workspace_id + git_sha',
  ci_pr: 'sha256:event_type + source_system + workspace_id + provider + repository + pr_number + head_sha + run_id',
} as const satisfies Record<z.infer<typeof ContextEventTypeEnum>, string>;

export const RelatedFileSchema = z.object({
  path: z.string().min(1),
  role: z.enum(['opened', 'saved', 'changed', 'mentioned', 'diagnostic', 'reviewed']).nullish().transform((value) => value ?? null),
  hash: nullableString(),
}).strict();

export const SourceIdentitySchema = z.object({
  source_system: SourceSystemEnum,
  tool_name: z.string().min(1),
  host_application: nullableString(),
  session_id: nullableString(),
  workspace_id: z.string().min(1),
  repo_path_hash: nullableString(),
}).strict();

export const CapturePolicySchema = z.object({
  policy_version: z.string().min(1),
  mode: CapturePolicyModeEnum,
  raw_content: z.enum(['off', 'metadata', 'summary', 'explicit']).default('metadata'),
}).strict();

export const EventProvenanceSchema = z.object({
  capture_source: CaptureSourceEnum,
  source_event_id: nullableString(),
  adapter_version: nullableString(),
  emitted_at: z.string().datetime().nullish().transform((value) => value ?? null),
  received_at: z.string().datetime().nullish().transform((value) => value ?? null),
  local_only: z.boolean().default(true),
}).strict();

const UnifiedContextEventBase = z.object({
  payload_schema_version: z.literal(CONTEXT_EVENT_PAYLOAD_SCHEMA_VERSION),
  source_identity: SourceIdentitySchema,
  source_system: SourceSystemEnum,
  tool_name: z.string().min(1),
  host_application: nullableString(),
  session_id: nullableString(),
  workspace_id: z.string().min(1),
  repo_path_hash: nullableString(),
  git_branch: nullableString(),
  git_sha: nullableString(),
  related_files: z.array(RelatedFileSchema).default([]),
  capture_policy: CapturePolicySchema,
  trust_tier: TrustTierEnum,
  idempotency_key: sha256String,
  provenance: EventProvenanceSchema,
});

export const ShellCommandContextEventPayload = UnifiedContextEventBase.extend({
  eventType: z.literal('shell_command'),
  phase: z.enum(['start', 'end']).default('end'),
  policyMode: CapturePolicyModeEnum.default('metadata-only'),
  command_summary: nullableString(),
  command_hash: z.string().min(16),
  cwd: nullableString(),
  exit_code: z.number().int().nullish().transform((value) => value ?? null),
  duration_ms: z.number().int().nonnegative().nullish().transform((value) => value ?? null),
  agent: z.object({
    recognized: z.boolean(),
    binary: AgentBinaryEnum,
    matchedPattern: z.string().nullish().transform((value) => value ?? null),
  }).strict(),
  regulated_signals: z.array(z.string()).default([]),
}).strict();

export const AgentCliSessionContextEventPayload = ShellCommandContextEventPayload.extend({
  eventType: z.literal('agent_cli_session'),
  agent: z.object({
    recognized: z.literal(true),
    binary: AgentBinaryEnum.exclude(['unknown']),
    matchedPattern: z.string().nullish().transform((value) => value ?? null),
  }).strict(),
}).strict();

export const IdeSessionContextEventPayload = UnifiedContextEventBase.extend({
  eventType: z.literal('ide_session'),
  ide_session_state: z.enum(['started', 'active', 'ended']).default('active'),
  workspace_folders: z.array(z.string()).default([]),
  extension_version: nullableString(),
}).strict();

export const EditorActivityContextEventPayload = UnifiedContextEventBase.extend({
  eventType: z.literal('editor_activity'),
  activity_type: z.enum(['open', 'save', 'close', 'diagnostic', 'selection', 'command']),
  document_uri_hash: nullableString(),
  language_id: nullableString(),
  summary: nullableString(),
}).strict();

export const ExplicitMemoryContextEventPayload = UnifiedContextEventBase.extend({
  eventType: z.literal('explicit_memory'),
  memory_hash: z.string().min(16),
  memory_summary: z.string().min(1),
  category: nullableString(),
  requested_by: z.enum(['human', 'agent', 'system']).default('human'),
}).strict();

export const GitCommitContextEventPayload = UnifiedContextEventBase.extend({
  eventType: z.literal('git_commit'),
  git_sha: z.string().min(7),
  commit_subject: nullableString(),
  committed_at: z.string().datetime().nullish().transform((value) => value ?? null),
  author_hash: nullableString(),
  changed_files: z.array(RelatedFileSchema).default([]),
}).strict();

export const CiPrContextEventPayload = UnifiedContextEventBase.extend({
  eventType: z.literal('ci_pr'),
  provider: z.enum(['github', 'gitlab', 'circleci', 'buildkite', 'jenkins', 'other']),
  repository: z.string().min(1),
  pr_number: z.union([z.string().min(1), z.number().int().positive()]).transform(String),
  head_sha: z.string().min(7),
  base_branch: nullableString(),
  status: z.enum(['queued', 'running', 'success', 'failure', 'cancelled', 'unknown']).default('unknown'),
  run_id: nullableString(),
}).strict();

export const UnifiedContextEventPayload = z.discriminatedUnion('eventType', [
  AgentCliSessionContextEventPayload,
  IdeSessionContextEventPayload,
  ShellCommandContextEventPayload,
  EditorActivityContextEventPayload,
  ExplicitMemoryContextEventPayload,
  GitCommitContextEventPayload,
  CiPrContextEventPayload,
]);

export const ContextCaptureEventJobPayload = z.object({
  workspaceId: z.string().min(1),
  source: CaptureSourceEnum,
  occurredAt: z.string().datetime(),
  payload: UnifiedContextEventPayload,
  safety: z.object({
    contextSafetyModule: z.literal('backend/src/lib/context-safety.ts'),
    policyVersion: z.string().min(1),
    redactionCount: z.number().int().nonnegative(),
    ignoredPathCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    hashAlgorithm: z.literal('sha256'),
    contentHash: z.string().min(16),
  }).strict(),
}).strict();

function stableStringifyContext(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringifyContext).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableStringifyContext(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function deriveContextEventIdempotencyKey(input: {
  eventType: z.infer<typeof ContextEventTypeEnum>;
  source_system: string;
  tool_name?: string | null;
  host_application?: string | null;
  session_id?: string | null;
  workspace_id: string;
  occurred_at?: string | null;
  command_hash?: string | null;
  phase?: string | null;
  exit_code?: number | null;
  git_sha?: string | null;
  memory_hash?: string | null;
  activity_type?: string | null;
  related_files?: Array<{ path: string }>;
  provider?: string | null;
  repository?: string | null;
  pr_number?: string | number | null;
  head_sha?: string | null;
  run_id?: string | null;
}): string {
  const bucketMinute = input.occurred_at ? input.occurred_at.slice(0, 16) : null;
  const bucketHour = input.occurred_at ? input.occurred_at.slice(0, 13) : null;
  const materialByType: Record<z.infer<typeof ContextEventTypeEnum>, unknown> = {
    agent_cli_session: [input.eventType, input.source_system, input.tool_name, input.session_id, input.workspace_id, bucketMinute, input.command_hash],
    ide_session: [input.eventType, input.source_system, input.host_application, input.session_id, input.workspace_id, bucketHour],
    shell_command: [input.eventType, input.source_system, input.session_id, input.workspace_id, input.occurred_at, input.phase, input.command_hash, input.exit_code],
    editor_activity: [input.eventType, input.source_system, input.host_application, input.session_id, input.workspace_id, input.occurred_at, input.activity_type, (input.related_files ?? []).map((file) => file.path).sort()],
    explicit_memory: [input.eventType, input.source_system, input.tool_name, input.session_id, input.workspace_id, input.memory_hash, input.occurred_at],
    git_commit: [input.eventType, input.source_system, input.workspace_id, input.git_sha],
    ci_pr: [input.eventType, input.source_system, input.workspace_id, input.provider, input.repository, input.pr_number == null ? null : String(input.pr_number), input.head_sha, input.run_id],
  };
  return `sha256:${crypto.createHash('sha256').update(stableStringifyContext(materialByType[input.eventType])).digest('hex')}`;
}

export type CapturePolicyModeType = z.infer<typeof CapturePolicyModeEnum>;
export type CaptureSourceType = z.infer<typeof CaptureSourceEnum>;
export type SourceSystemType = z.infer<typeof SourceSystemEnum>;
export type TrustTierType = z.infer<typeof TrustTierEnum>;
export type ShellCommandContextEventPayloadType = z.infer<typeof ShellCommandContextEventPayload>;
export type AgentCliSessionContextEventPayloadType = z.infer<typeof AgentCliSessionContextEventPayload>;
export type UnifiedContextEventPayloadType = z.infer<typeof UnifiedContextEventPayload>;
export type ContextCaptureEventJobPayloadType = z.infer<typeof ContextCaptureEventJobPayload>;
