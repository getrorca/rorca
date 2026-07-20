/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { z } from 'zod';

export const CONTEXT_EVENT_PAYLOAD_SCHEMA_VERSION = '2026-07-ucc-007.v1' as const;
export const CapturePolicyModeEnum = z.enum(['off', 'metadata-only', 'repo-and-command', 'ide-assisted', 'full']);
export const CaptureSourceEnum = z.enum([
  'repoDaemon', 'gitHook', 'shellIntegration', 'vscodeExtension',
  'agentAdapter', 'mcpSlashCommand', 'ciPrIngestion', 'externalImport',
]);
export const SourceSystemEnum = z.enum([
  'shell', 'ide', 'vscode', 'vscode-fork', 'agent_adapter', 'repo_daemon',
  'git_hook', 'ci', 'mcp', 'external_import', 'pi', 'claude_code',
  'codex', 'opencode', 'daemon',
]);
export const ContextEventTypeEnum = z.enum([
  'agent_cli_session', 'ide_session', 'shell_command', 'editor_activity',
  'explicit_memory', 'git_commit', 'ci_pr',
]);

/** Stable public guidance for constructing source-owned idempotency material. */
export const ContextEventIdempotencyGuidance = Object.freeze({
  agent_cli_session: 'source_system + tool_name + session_id + workspace_id + occurred_at minute + command_hash',
  ide_session: 'source_system + host_application + session_id + workspace_id + occurred_at hour',
  shell_command: 'source_system + session_id + workspace_id + occurred_at + phase + command_hash + exit_code',
  editor_activity: 'source_system + host_application + session_id + workspace_id + occurred_at + activity_type + sorted related_files',
  explicit_memory: 'source_system + tool_name + session_id + workspace_id + memory_hash + occurred_at',
  git_commit: 'source_system + workspace_id + git_sha',
  ci_pr: 'source_system + workspace_id + provider + repository + pr_number + head_sha + run_id',
} satisfies Record<z.infer<typeof ContextEventTypeEnum>, string>);
export const TrustTierEnum = z.enum(['untrusted', 'local', 'verified', 'privileged']);
export const AgentBinaryEnum = z.enum(['claude', 'codex', 'opencode', 'pi', 'aider', 'cursor', 'custom', 'unknown']);

const nullableString = () => z.string().nullish().transform((value) => value ?? null);
const sha256String = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const RelatedFileSchema = z.object({
  path: z.string().min(1),
  role: z.enum(['opened', 'saved', 'changed', 'mentioned', 'diagnostic', 'reviewed']).nullish().transform((value) => value ?? null),
  hash: nullableString(),
}).strict();

const SourceIdentitySchema = z.object({
  source_system: SourceSystemEnum,
  tool_name: z.string().min(1),
  host_application: nullableString(),
  session_id: nullableString(),
  workspace_id: z.string().min(1),
  repo_path_hash: nullableString(),
}).strict();

const CapturePolicySchema = z.object({
  policy_version: z.string().min(1),
  mode: CapturePolicyModeEnum,
  raw_content: z.enum(['off', 'metadata', 'summary', 'explicit']).default('metadata'),
}).strict();

const EventProvenanceSchema = z.object({
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

const commandEventFields = {
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
    matchedPattern: nullableString(),
  }).strict(),
  regulated_signals: z.array(z.string()).default([]),
};

export const ShellCommandContextEventPayload = UnifiedContextEventBase.extend({
  eventType: z.literal('shell_command'),
  ...commandEventFields,
}).strict();

export const AgentCliSessionContextEventPayload = UnifiedContextEventBase.extend({
  eventType: z.literal('agent_cli_session'),
  ...commandEventFields,
  agent: z.object({
    recognized: z.literal(true),
    binary: AgentBinaryEnum.exclude(['unknown']),
    matchedPattern: nullableString(),
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
    redactionTypes: z.array(z.string()).optional(),
    regulatedSignals: z.array(z.string()).optional(),
  }).strict(),
}).strict();

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
  const minute = input.occurred_at?.slice(0, 16) ?? null;
  const hour = input.occurred_at?.slice(0, 13) ?? null;
  const material: Record<z.infer<typeof ContextEventTypeEnum>, unknown> = {
    agent_cli_session: [input.eventType, input.source_system, input.tool_name, input.session_id, input.workspace_id, minute, input.command_hash],
    ide_session: [input.eventType, input.source_system, input.host_application, input.session_id, input.workspace_id, hour],
    shell_command: [input.eventType, input.source_system, input.session_id, input.workspace_id, input.occurred_at, input.phase, input.command_hash, input.exit_code],
    editor_activity: [input.eventType, input.source_system, input.host_application, input.session_id, input.workspace_id, input.occurred_at, input.activity_type, (input.related_files ?? []).map((file) => file.path).sort()],
    explicit_memory: [input.eventType, input.source_system, input.tool_name, input.session_id, input.workspace_id, input.memory_hash, input.occurred_at],
    git_commit: [input.eventType, input.source_system, input.workspace_id, input.git_sha],
    ci_pr: [input.eventType, input.source_system, input.workspace_id, input.provider, input.repository, input.pr_number == null ? null : String(input.pr_number), input.head_sha, input.run_id],
  };
  return `sha256:${crypto.createHash('sha256').update(stableStringify(material[input.eventType])).digest('hex')}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export type CaptureSourceType = z.infer<typeof CaptureSourceEnum>;
export type UnifiedContextEventPayloadType = z.infer<typeof UnifiedContextEventPayload>;
export type ContextCaptureEventJobPayloadType = z.infer<typeof ContextCaptureEventJobPayload>;
