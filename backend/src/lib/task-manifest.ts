/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * task-manifest.ts — canonical Rorca-side contract for bounded Hermes task manifests.
 *
 * Authority boundary:
 * - `workspaceId` is the Rorca authority anchor. Rorca resolves workspace ownership,
 *   execution settings, provider/model availability, and durable run state from it.
 * - `manifestId` and `idempotencyKey` are Hermes-issued correlation handles. The
 *   idempotency key is intentionally a UUID because pg-boss job ids must be UUIDs
 *   if a later route forwards the key as a queue id.
 * - `source` records provenance from Rorca, GitHub, Linear, Slack, an operator, or
 *   CLI invocation, but none of those external references become canonical state.
 * - `tasks[]` is an execution-envelope list, not a spec ledger. Do not add
 *   `userStories`, `passes`, `generatedAt`, or other spec-authoring fields here;
 *   those belong to `backend/src/lib/spec-types.ts` / persisted Rorca specs.
 * - `tasks.md` is only a projection for agent readability and must never be
 *   treated as the durable source of truth. The manifest JSON is the contract.
 */

import { z } from 'zod';
import {
  collectContextSafetyIssues,
  CONTEXT_SAFETY_LIMITS,
  getUnsafePathReason,
} from './context-safety';

export const TASK_MANIFEST_VERSION = 1 as const;

export const TASK_MANIFEST_LIMITS = {
  maxManifestBytes: CONTEXT_SAFETY_LIMITS.maxSerializedBytes,
  maxStringChars: CONTEXT_SAFETY_LIMITS.maxStringChars,
  maxShortStringChars: 128,
  maxMediumStringChars: 512,
  maxLongStringChars: 2_000,
  maxPathChars: 512,
  maxTaskCount: 50,
  maxContextRefCount: 50,
  maxEvidenceCount: 50,
  maxCommandCount: 50,
  maxValidationCount: 20,
  maxScopeItemCount: 30,
  maxPathCount: 100,
  maxStringArrayItems: 100,
} as const;

export const DEFAULT_TASK_MANIFEST_COMMAND_DENYLIST = [
  'rm -rf /',
  'rm -rf --no-preserve-root /',
  'mkfs',
  'dd if=',
  'sudo',
  'docker login',
  'kubectl apply',
  'kubectl delete',
  'terraform apply',
  'git push --force',
  'curl | sh',
  'wget | sh',
] as const;

export const DEFAULT_TASK_MANIFEST_REQUIRED_VALIDATION = [
  'typecheck',
] as const;

function addCustomIssue(ctx: z.RefinementCtx, path: Array<string | number>, message: string): void {
  ctx.addIssue({
    code: 'custom',
    path,
    message,
  });
}

function boundedString(max: number, label: string) {
  return z.string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`);
}

const shortString = (label: string) => boundedString(TASK_MANIFEST_LIMITS.maxShortStringChars, label);
const mediumString = (label: string) => boundedString(TASK_MANIFEST_LIMITS.maxMediumStringChars, label);
const longString = (label: string) => boundedString(TASK_MANIFEST_LIMITS.maxLongStringChars, label);

const identifierString = (label: string) => shortString(label)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, `${label} must be a bounded identifier`);

const safeRelativePath = boundedString(TASK_MANIFEST_LIMITS.maxPathChars, 'workspace-relative path')
  .superRefine((value, ctx) => {
    const reason = getUnsafePathReason(value);
    if (reason) {
      addCustomIssue(ctx, [], reason);
    }
  });

const boundedStringArray = (itemLabel: string, maxItems: number = TASK_MANIFEST_LIMITS.maxStringArrayItems) => z.array(
  mediumString(itemLabel),
).max(maxItems, `${itemLabel} list must contain at most ${maxItems} items`);

const boundedPathArray = z.array(safeRelativePath)
  .max(TASK_MANIFEST_LIMITS.maxPathCount, `Path list must contain at most ${TASK_MANIFEST_LIMITS.maxPathCount} items`);

export const TaskManifestSourceSchema = z.object({
  rorca: z.object({
    specId: identifierString('Rorca spec id').optional(),
    storyId: identifierString('Rorca story id').optional(),
    runId: z.union([z.number().int().positive(), shortString('Rorca run id')]).optional(),
    specPath: safeRelativePath.optional(),
  }).strict().optional(),
  github: z.object({
    owner: identifierString('GitHub owner').optional(),
    repo: identifierString('GitHub repository').optional(),
    pullRequestNumber: z.number().int().positive().optional(),
    pullRequestUrl: mediumString('GitHub pull request URL').optional(),
    headSha: shortString('GitHub head SHA').optional(),
  }).strict().optional(),
  linear: z.object({
    issueId: identifierString('Linear issue id').optional(),
    issueKey: identifierString('Linear issue key').optional(),
    issueUrl: mediumString('Linear issue URL').optional(),
  }).strict().optional(),
  slack: z.object({
    teamId: identifierString('Slack team id').optional(),
    channelId: identifierString('Slack channel id').optional(),
    threadTs: shortString('Slack thread timestamp').optional(),
    messageTs: shortString('Slack message timestamp').optional(),
    threadUrl: mediumString('Slack thread URL').optional(),
  }).strict().optional(),
  operator: z.object({
    intentId: identifierString('operator intent id').optional(),
    actor: mediumString('operator actor').optional(),
    summary: longString('operator intent summary').optional(),
  }).strict().optional(),
  cli: z.object({
    invocationId: identifierString('CLI invocation id').optional(),
    command: mediumString('CLI command').optional(),
    args: boundedStringArray('CLI argument', 30).optional(),
  }).strict().optional(),
}).strict();

export const TaskManifestRouteDecisionSchema = z.object({
  route: identifierString('route decision'),
  reason: longString('route decision reason').optional(),
  confidence: z.number().min(0).max(1).optional(),
  decidedAt: mediumString('route decision timestamp').optional(),
}).strict();

export const TaskManifestBoundedScopeSchema = z.object({
  summary: longString('bounded scope summary'),
  allowedPaths: boundedPathArray.default([]),
  forbiddenPaths: boundedPathArray.default([]),
  inScope: boundedStringArray('in-scope item', TASK_MANIFEST_LIMITS.maxScopeItemCount).default([]),
  outOfScope: boundedStringArray('out-of-scope item', TASK_MANIFEST_LIMITS.maxScopeItemCount).default([]),
}).strict();

export const TaskManifestTaskSchema = z.object({
  taskId: identifierString('task id'),
  title: mediumString('task title'),
  description: longString('task description').optional(),
  acceptanceCriteria: boundedStringArray('task acceptance criterion', TASK_MANIFEST_LIMITS.maxValidationCount).default([]),
  targetPaths: boundedPathArray.default([]),
  commands: z.array(mediumString('task command'))
    .max(TASK_MANIFEST_LIMITS.maxCommandCount, `Task command list must contain at most ${TASK_MANIFEST_LIMITS.maxCommandCount} items`)
    .default([]),
  dependsOn: z.array(identifierString('task dependency'))
    .max(TASK_MANIFEST_LIMITS.maxTaskCount, `Task dependency list must contain at most ${TASK_MANIFEST_LIMITS.maxTaskCount} items`)
    .default([]),
}).strict();

export const TaskManifestContextRefSchema = z.object({
  kind: z.enum([
    'artifact',
    'diff',
    'file',
    'memory',
    'pr',
    'spec',
    'story',
    'symbol',
    'tasks-md-projection',
    'trace',
    'url',
  ]),
  ref: mediumString('context reference'),
  path: safeRelativePath.optional(),
  title: mediumString('context reference title').optional(),
  digest: shortString('context reference digest').optional(),
  excerpt: longString('context reference excerpt').optional(),
}).strict();

export const TaskManifestTasksMdProjectionSchema = z.object({
  path: z.literal('tasks.md').default('tasks.md'),
  generatedFrom: z.literal('manifest').default('manifest'),
  durableSourceOfTruth: z.literal(false).default(false),
  note: mediumString('tasks.md projection note').optional(),
}).strict();

export const TaskManifestContextSchema = z.object({
  summary: longString('context summary').optional(),
  contextRefs: z.array(TaskManifestContextRefSchema)
    .max(TASK_MANIFEST_LIMITS.maxContextRefCount, `Context refs must contain at most ${TASK_MANIFEST_LIMITS.maxContextRefCount} items`)
    .default([]),
  tasksMdProjection: TaskManifestTasksMdProjectionSchema.optional(),
}).strict();

export const TaskManifestPolicySchema = z.object({
  dryRun: z.boolean().default(false),
  branchPrOnly: z.literal(true).default(true),
  autoMerge: z.literal(false).default(false),
  deploysAllowed: z.literal(false).default(false),
  credentialCopyingAllowed: z.literal(false).default(false),
  commandDenylist: z.array(mediumString('command denylist item'))
    .max(TASK_MANIFEST_LIMITS.maxCommandCount, `Command denylist must contain at most ${TASK_MANIFEST_LIMITS.maxCommandCount} items`)
    .default(() => [...DEFAULT_TASK_MANIFEST_COMMAND_DENYLIST])
    .transform((values) => [...new Set([...DEFAULT_TASK_MANIFEST_COMMAND_DENYLIST, ...values])]),
  requiredValidation: z.array(identifierString('required validation'))
    .max(TASK_MANIFEST_LIMITS.maxValidationCount, `Required validation must contain at most ${TASK_MANIFEST_LIMITS.maxValidationCount} items`)
    .default(() => [...DEFAULT_TASK_MANIFEST_REQUIRED_VALIDATION]),
}).strict();

export const TaskManifestExecutionSchema = z.object({
  agentOverride: z.enum(['claude', 'opencode', 'codex', 'pi']).optional(),
  modelOverride: mediumString('model override').optional(),
  effortLevel: z.enum(['low', 'medium', 'high', 'max']).optional(),
  terminalMode: z.enum(['ansi-html', 'pty']).optional(),
  mergeStrategy: z.enum(['pr', 'draft-pr', 'branch-only']).default('draft-pr'),
  executionEnvironment: mediumString('execution environment').optional(),
  executionEnvironmentId: identifierString('execution environment id').optional(),
}).strict();

export const TaskManifestValidationSchema = z.object({
  requiredCommands: z.array(mediumString('validation command'))
    .max(TASK_MANIFEST_LIMITS.maxCommandCount, `Validation command list must contain at most ${TASK_MANIFEST_LIMITS.maxCommandCount} items`)
    .default([]),
  successCriteria: boundedStringArray('validation success criterion', TASK_MANIFEST_LIMITS.maxValidationCount).default([]),
  artifactRefs: z.array(TaskManifestContextRefSchema)
    .max(TASK_MANIFEST_LIMITS.maxEvidenceCount, `Validation artifact refs must contain at most ${TASK_MANIFEST_LIMITS.maxEvidenceCount} items`)
    .default([]),
}).strict();

export const TaskManifestEvidenceSchema = z.object({
  kind: z.enum(['artifact', 'commit', 'diff', 'log-ref', 'pr', 'test', 'trace', 'validation']),
  ref: mediumString('evidence reference'),
  path: safeRelativePath.optional(),
  digest: shortString('evidence digest').optional(),
  summary: longString('evidence summary').optional(),
}).strict();

const isoTimestamp = shortString('createdAt')
  .refine((value) => /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)), {
    message: 'createdAt must be an ISO-8601 timestamp',
  });

function normalizedScopePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function pathWithinScope(candidate: string, scope: string): boolean {
  const path = normalizedScopePath(candidate);
  const root = normalizedScopePath(scope);
  return path === root || path.startsWith(`${root}/`);
}

export const TaskManifestSchema = z.object({
  manifestVersion: z.literal(TASK_MANIFEST_VERSION),
  manifestId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  workspaceId: identifierString('workspace id'),
  source: TaskManifestSourceSchema,
  routeDecision: TaskManifestRouteDecisionSchema,
  objective: longString('objective'),
  boundedScope: TaskManifestBoundedScopeSchema,
  tasks: z.array(TaskManifestTaskSchema)
    .min(1, 'tasks must contain at least one execution-envelope task')
    .max(TASK_MANIFEST_LIMITS.maxTaskCount, `tasks must contain at most ${TASK_MANIFEST_LIMITS.maxTaskCount} items`),
  context: TaskManifestContextSchema,
  policy: TaskManifestPolicySchema,
  execution: TaskManifestExecutionSchema,
  validation: TaskManifestValidationSchema,
  evidence: z.array(TaskManifestEvidenceSchema)
    .max(TASK_MANIFEST_LIMITS.maxEvidenceCount, `evidence must contain at most ${TASK_MANIFEST_LIMITS.maxEvidenceCount} items`),
  createdAt: isoTimestamp,
}).strict().superRefine((manifest, ctx) => {
  if (manifest.boundedScope.allowedPaths.length === 0) {
    addCustomIssue(ctx, ['boundedScope', 'allowedPaths'], 'Direct task-manifest execution requires at least one host-enforced allowed path');
  }
  const allowed = manifest.boundedScope.allowedPaths;
  for (const [taskIndex, task] of manifest.tasks.entries()) {
    if (task.targetPaths.length === 0) {
      addCustomIssue(ctx, ['tasks', taskIndex, 'targetPaths'], 'Every direct task-manifest task requires an explicit target path');
    }
    for (const [pathIndex, target] of task.targetPaths.entries()) {
      if (!allowed.some((scope) => pathWithinScope(target, scope))) {
        addCustomIssue(ctx, ['tasks', taskIndex, 'targetPaths', pathIndex], 'Task target path is outside the declared allowed paths');
      }
    }
  }
  // Forbidden scopes may intentionally carve a sensitive subtree out of an
  // allowed parent; host closeout always evaluates forbidden paths first.
  const denylist = manifest.policy.commandDenylist.map((value) => value.toLowerCase().trim());
  // Schema transformation unions the immutable host denylist with caller
  // additions, so a caller can add restrictions but can never remove defaults.
  const declaredCommands = [
    ...manifest.tasks.flatMap((task) => task.commands),
    ...manifest.validation.requiredCommands,
  ];
  for (const [index, command] of declaredCommands.entries()) {
    const normalized = command.toLowerCase();
    if (denylist.some((denied) => denied && normalized.includes(denied))) {
      addCustomIssue(ctx, ['policy', 'commandDenylist', index], 'A declared command matches the immutable command denylist');
    }
  }
  for (const issue of collectContextSafetyIssues(manifest, {
    maxStringChars: TASK_MANIFEST_LIMITS.maxStringChars,
    maxArrayItems: TASK_MANIFEST_LIMITS.maxStringArrayItems,
    maxSerializedBytes: TASK_MANIFEST_LIMITS.maxManifestBytes,
  })) {
    addCustomIssue(ctx, issue.path, issue.message);
  }
});

/**
 * A parsed, policy-defaulted task manifest. This type is the route-boundary
 * contract later endpoints should consume instead of ad hoc
 * `Record<string, unknown>` payload parsing.
 */
export type TaskManifest = z.infer<typeof TaskManifestSchema>;
export type TaskManifestSource = z.infer<typeof TaskManifestSourceSchema>;
export type TaskManifestPolicy = z.infer<typeof TaskManifestPolicySchema>;
export type TaskManifestExecution = z.infer<typeof TaskManifestExecutionSchema>;
export type TaskManifestTask = z.infer<typeof TaskManifestTaskSchema>;
export type TaskManifestContextRef = z.infer<typeof TaskManifestContextRefSchema>;

export function parseTaskManifest(input: unknown): TaskManifest {
  return TaskManifestSchema.parse(input);
}

export function safeParseTaskManifest(input: unknown) {
  return TaskManifestSchema.safeParse(input);
}
