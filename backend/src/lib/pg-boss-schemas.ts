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
export const PipelineRunJobPayload = z.object({
  runId: z.coerce.number().int().positive(),
  specPath: z.string().min(1),
  workspacePath: z.string().min(1),
  agent: z.enum(['claude', 'opencode', 'codex']),
  model: z.string().nullable(),
  worktreePath: z.string().nullable(),
  branchName: z.string().nullable(),
  autoWorktree: z.boolean().optional().default(false),
  autoMerge: z.boolean().optional().default(false),
  envOverrides: z.record(z.string(), z.string()).optional().default({}),
  startFromStoryId: z.string().optional(),
  triggeredVia: z.enum(['queue', 'run_now']).default('run_now'),
  includeGraph: z.boolean().optional().default(false),
  agentOverride: z.enum(['claude', 'opencode', 'codex']).optional(),
  thinkingEnabled: z.boolean().optional(),
  thinkingBudget: z.number().int().positive().optional(),
  effortLevel: z.enum(['low', 'medium', 'high', 'max']).optional(),
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
  agent: z.enum(['claude', 'opencode', 'codex']),
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
