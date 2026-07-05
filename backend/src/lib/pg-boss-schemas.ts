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
  runId: z.coerce.number().int().positive(),
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
  runId: z.coerce.number().int().positive(),
  originalRunId: z.coerce.number().int().positive(),
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
  runId: z.coerce.number().int().positive(),
}).strict();

export type PipelineCancelJobPayloadType = z.infer<typeof PipelineCancelJobPayload>;

// ── pipeline:merge ──────────────────────────────────────────────────────────

/**
 * Payload for the `pipeline:merge` pg-boss queue.
 * Sent by POST /api/pipeline/runs/:id/retry-merge, consumed by worker handlePipelineMerge.
 */
export const PipelineMergeJobPayload = z.object({
  runId: z.coerce.number().int().positive(),
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

export const CapturePolicyModeEnum = z.enum(['off', 'metadata-only', 'command-summary', 'explicit-transcript-import']);
export const AgentBinaryEnum = z.enum(['claude', 'codex', 'opencode', 'pi', 'aider', 'cursor', 'custom', 'unknown']);

export const CliCommandContextEventPayload = z.object({
  eventType: z.literal('cli_command'),
  phase: z.enum(['start', 'end']).default('end'),
  policyMode: CapturePolicyModeEnum.default('metadata-only'),
  commandSummary: z.string().nullable(),
  commandHash: z.string().min(16),
  cwd: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  gitBranch: z.string().nullable(),
  gitSha: z.string().nullable(),
  agent: z.object({
    recognized: z.boolean(),
    binary: AgentBinaryEnum,
    matchedPattern: z.string().optional(),
  }).strict(),
  regulatedSignals: z.array(z.string()).default([]),
}).strict();

export const AgentCliSessionContextEventPayload = CliCommandContextEventPayload.extend({
  eventType: z.literal('agent_cli_session'),
  agent: z.object({
    recognized: z.literal(true),
    binary: AgentBinaryEnum.exclude(['unknown']),
    matchedPattern: z.string().optional(),
  }).strict(),
}).strict();

export const ContextCaptureEventJobPayload = z.object({
  workspaceId: z.string().min(1),
  source: z.enum(['shellIntegration', 'repoDaemon', 'gitHook', 'vscodeExtension', 'mcpSlashCommand']),
  occurredAt: z.string().datetime(),
  payload: z.union([CliCommandContextEventPayload, AgentCliSessionContextEventPayload]),
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

export type CapturePolicyModeType = z.infer<typeof CapturePolicyModeEnum>;
export type CliCommandContextEventPayloadType = z.infer<typeof CliCommandContextEventPayload>;
export type AgentCliSessionContextEventPayloadType = z.infer<typeof AgentCliSessionContextEventPayload>;
export type ContextCaptureEventJobPayloadType = z.infer<typeof ContextCaptureEventJobPayload>;
