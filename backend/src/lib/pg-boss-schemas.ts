/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
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
  autoWorktree: z.boolean().optional().default(false),
  autoMerge: z.boolean().optional().default(false),
  mergeStrategy: MergeStrategyEnum.optional().default('direct'),
  envOverrides: z.record(z.string(), z.string()).optional().default({}),
  startFromStoryId: z.string().optional(),
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
}).strict();

export type SpecJobPayloadType = z.infer<typeof SpecJobPayload>;
