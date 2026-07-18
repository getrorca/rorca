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
import { ExecutionEnvironmentSchema } from './execution-environment';
export type { UnifiedContextEventPayloadType } from './context-capture-contracts';

const ExecutionSecretReferencesSchema = z.object({
  version: z.literal('v1'),
  workspaceId: z.string().min(1),
  vaultUserId: z.string().min(1).optional(),
  providers: z.array(z.enum(['anthropic', 'openrouter', 'openai-compat'])),
  includeWorkspaceEnv: z.boolean(),
}).strict();

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
  executionEnvironment: ExecutionEnvironmentSchema.optional().default('remote-rorca'),
  autoWorktree: z.boolean().optional().default(false),
  autoMerge: z.boolean().optional().default(false),
  mergeStrategy: MergeStrategyEnum.optional().default('direct'),
  safetyOptions: z.object({
    deploy: z.boolean(),
    externalSend: z.boolean(),
    policyLocked: z.boolean(),
  }).strict().optional().default({ deploy: true, externalSend: true, policyLocked: false }),
  /** Host-resolved immutable story manifests. Optional only for audited legacy jobs. */
  executionManifestPath: z.string().min(1).optional(),
  // Non-secret execution options only. Credentials and workspace values are
  // referenced below and resolved by the worker immediately before spawn.
  envOverrides: z.record(z.string(), z.string()).optional().default({}),
  secretReferences: ExecutionSecretReferencesSchema.optional(),
  startFromStoryId: z.string().optional(),
  specificStory: z.string().optional(),
  triggeredVia: z.enum(['queue', 'run_now']).default('run_now'),
  includeGraph: z.boolean().optional().default(false),
  agentOverride: z.enum(['claude', 'opencode', 'codex', 'pi']).optional(),
  thinkingEnabled: z.boolean().optional(),
  thinkingBudget: z.number().int().positive().optional(),
  effortLevel: z.enum(['low', 'medium', 'high', 'max', 'xhigh']).optional(),
  reasoningEffort: z.string().optional(),
  idempotencyKey: z.string().optional(),
  manifestId: z.string().optional(),
  taskManifestArtifacts: z.record(z.string(), z.unknown()).optional(),
  taskManifestArtifactRefs: z.array(z.record(z.string(), z.unknown())).optional(),
  // Persisted request metadata is supplied by the pipeline route for worker
  // correlation. It is not an execution authority, but strict schema parsing
  // must preserve it rather than rejecting an otherwise valid run job.
  triggerOptions: z.record(z.string(), z.unknown()).optional(),
  executionEnvironmentId: z.string().optional(),
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
  scopeHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  previewHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  approvedPreview: z.record(z.string(), z.unknown()),
  generatedPlanHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  workspacePath: z.string().min(1),
  specPath: z.string().min(1),
  retrySpecPath: z.string().min(1),
  agent: z.enum(['claude', 'opencode', 'codex', 'pi']),
  model: z.string().nullable(),
  worktreePath: z.string().nullable(),
  branchName: z.string().nullable(),
  sequenceOffset: z.number().int().min(0),
  /** Host-resolved immutable retry manifests. Optional only for audited legacy jobs. */
  executionManifestPath: z.string().min(1).optional(),
  envOverrides: z.record(z.string(), z.string()).optional().default({}),
  secretReferences: ExecutionSecretReferencesSchema.optional(),
  includeGraph: z.boolean().optional().default(false),
  terminalMode: TerminalModeSchema.optional().default('ansi-html'),
  thinkingEnabled: z.boolean().optional(),
  thinkingBudget: z.number().int().positive().optional(),
  effortLevel: z.enum(['low', 'medium', 'high', 'max', 'xhigh']).optional(),
  reasoningEffort: z.string().optional(),
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
  // Posture is non-secret persisted metadata. The worker re-verifies it from
  // pipeline_runs before any semantic retry; old jobs may omit it.
  posture: z.object({
    agent: z.enum(['claude', 'opencode', 'codex', 'pi']),
    model: z.string().nullable(),
    source: z.literal('manual-retry'),
  }).optional(),
}).strict();

export type PipelineMergeJobPayloadType = z.infer<typeof PipelineMergeJobPayload>;

// ── pipeline:pr-delivery ─────────────────────────────────────────────────────

/** One bounded observation/actuation step for an existing reviewed PR. */
export const AutonomousPrDeliveryJobPayload = z.object({
  deliveryId: z.string().uuid(),
  expectedHeadSha: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
}).strict();

export type AutonomousPrDeliveryJobPayloadType = z.infer<typeof AutonomousPrDeliveryJobPayload>;

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
