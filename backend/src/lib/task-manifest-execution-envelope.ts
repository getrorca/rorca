/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'fs/promises';
import path from 'path';

import { ConflictError, ValidationError } from './errors';
import type { TaskManifest, TaskManifestContextRef, TaskManifestTask } from './task-manifest';
import {
  computeTaskManifestHash,
  resolveTaskManifestArtifactPaths,
  writeTaskManifestArtifact,
} from './task-manifest-artifacts';
import {
  compileSpecExportKit,
  publishSpecExportKit,
  sealSpecExportKit,
  type SpecExportKitIdentity,
} from './spec-export-kit';

export const HERMES_TASK_MANIFEST_SOURCE = 'hermes-task-manifest' as const;
export const TASK_MANIFEST_EXECUTION_ENVELOPE_VERSION = 1 as const;

const DIRECT_TASK_MANIFEST_ROUTES = new Set([
  'rorca.pipeline.story',
  'rorca.pipeline.task-manifest',
  'hermes.task-manifest.direct',
  'hermes.hrc.task-manifest',
  'task-manifest.direct',
  'direct-task-manifest',
]);

const BROAD_OR_HIGH_RISK_ROUTE_PATTERNS = [
  /\bbroad\b/i,
  /\bhigh[-_\s]?risk\b/i,
  /\bfull[-_\s]?spec\b/i,
  /\bnormal[-_\s]?spec\b/i,
  /\bspec[-_\s]?run\b/i,
  /\bmanual[-_\s]?review\b/i,
  /\boperator[-_\s]?review\b/i,
];

interface JsonRecord {
  [key: string]: unknown;
}

export interface SyntheticTaskManifestStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  files?: string[];
  agent?: TaskManifest['execution']['agentOverride'];
  model?: string;
  timeoutMinutes?: number;
}

export interface SyntheticTaskManifestSpec extends JsonRecord {
  id: string;
  title: string;
  brief: string;
  generatedAt: string;
  internal: true;
  source: typeof HERMES_TASK_MANIFEST_SOURCE;
  manifestId: string;
  idempotencyKey: string;
  manifestHash: string;
  sourceSpecId?: string;
  sourceRunId?: string | number;
  sourceStoryIds: string[];
  mergeStrategy: TaskManifest['execution']['mergeStrategy'];
  model?: string;
  agentOverride?: TaskManifest['execution']['agentOverride'];
  reasoning?: { enabled: true; effort: NonNullable<TaskManifest['execution']['effortLevel']> };
  taskManifestExecution: {
    version: typeof TASK_MANIFEST_EXECUTION_ENVELOPE_VERSION;
    source: typeof HERMES_TASK_MANIFEST_SOURCE;
    manifestId: string;
    idempotencyKey: string;
    routeDecision: TaskManifest['routeDecision'];
    sourceSpecId?: string;
    sourceRunId?: string | number;
    sourceStoryIds: string[];
    validationCommands: string[];
    commandDenylist: string[];
    internal: true;
  };
  userStories: SyntheticTaskManifestStory[];
  exportKitIdentity: SpecExportKitIdentity;
}

export interface WriteTaskManifestExecutionEnvelopeInput {
  workspacePath: string;
  manifest: TaskManifest;
  exportKitApproval?: {
    actorId: string;
    approvalReceiptId: string;
  };
}

export interface WriteTaskManifestExecutionEnvelopeResult {
  spec: SyntheticTaskManifestSpec;
  specPath: string;
  relativeSpecPath: string;
  artifactDir: string;
  relativeArtifactDir: string;
  manifestPath: string;
  tasksMdPath: string;
  manifestHash: string;
  syntheticSpecHash: string;
  artifactReused: boolean;
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '_Not provided._';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function bulletList(items: readonly string[] | undefined, empty = '_None._'): string {
  if (!items || items.length === 0) return `- ${empty}`;
  return items.map((item) => `- ${item}`).join('\n');
}

function inlineList(items: readonly string[] | undefined): string {
  if (!items || items.length === 0) return '_None._';
  return items.join(', ');
}

function contextRefLine(ref: TaskManifestContextRef): string {
  const fields = [
    `kind=${ref.kind}`,
    `ref=${ref.ref}`,
    ref.path ? `path=${ref.path}` : undefined,
    ref.title ? `title=${ref.title}` : undefined,
    ref.digest ? `digest=${ref.digest}` : undefined,
    ref.excerpt ? `excerpt=${ref.excerpt}` : undefined,
  ].filter(Boolean);
  return `- ${fields.join('; ')}`;
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function routeText(manifest: TaskManifest): string {
  return [manifest.routeDecision.route, manifest.routeDecision.reason ?? ''].join('\n');
}

export function assertTaskManifestDirectExecutionAllowed(manifest: TaskManifest): void {
  const route = manifest.routeDecision.route;
  if (!DIRECT_TASK_MANIFEST_ROUTES.has(route)) {
    throw new ValidationError(
      `Task manifest routeDecision '${route}' is not eligible for direct task-manifest execution; route it through the normal Rorca spec/run flow instead.`,
    );
  }

  const decisionText = routeText(manifest);
  if (BROAD_OR_HIGH_RISK_ROUTE_PATTERNS.some((pattern) => pattern.test(decisionText))) {
    throw new ValidationError(
      `Task manifest routeDecision '${route}' is broad or high-risk and cannot execute in direct task-manifest mode.`,
    );
  }
}

export function taskManifestSpecId(manifestId: string): string {
  return `hermes-task-manifest-${manifestId}`;
}

const LIFECYCLE_STORY_REFERENCE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;

function canonicalTaskStoryId(taskId: string): string {
  const normalized = taskId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (normalized.length <= 128 && LIFECYCLE_STORY_REFERENCE.test(normalized)) return normalized;
  return `HMT-${crypto.createHash('sha256').update(taskId, 'utf8').digest('hex').slice(0, 16).toUpperCase()}`;
}

function taskStoryIdMap(manifest: TaskManifest): ReadonlyMap<string, string> {
  const byTaskId = new Map<string, string>();
  const byStoryId = new Map<string, string>();
  for (const task of manifest.tasks) {
    const storyId = canonicalTaskStoryId(task.taskId);
    const existingTaskId = byStoryId.get(storyId);
    if (existingTaskId && existingTaskId !== task.taskId) {
      throw new ValidationError(
        `Task manifest task IDs '${existingTaskId}' and '${task.taskId}' map to the same lifecycle story ID '${storyId}'.`,
      );
    }
    byTaskId.set(task.taskId, storyId);
    byStoryId.set(storyId, task.taskId);
  }
  return byTaskId;
}

export function collectSourceStoryIds(manifest: TaskManifest): string[] {
  return uniqueStrings([
    manifest.source.rorca?.storyId,
    ...manifest.context.contextRefs
      .filter((ref) => ref.kind === 'story')
      .map((ref) => ref.ref),
  ]);
}

function renderSourceSection(manifest: TaskManifest, sourceStoryIds: string[]): string {
  return [
    '## Source Metadata',
    `- Source: ${HERMES_TASK_MANIFEST_SOURCE}`,
    `- Manifest ID: ${manifest.manifestId}`,
    `- Idempotency Key: ${manifest.idempotencyKey}`,
    `- Route Decision: ${manifest.routeDecision.route}`,
    `- Route Reason: ${formatValue(manifest.routeDecision.reason)}`,
    `- Source Spec ID: ${formatValue(manifest.source.rorca?.specId)}`,
    `- Source Run ID: ${formatValue(manifest.source.rorca?.runId)}`,
    `- Source Story IDs: ${inlineList(sourceStoryIds)}`,
  ].join('\n');
}

function renderTaskSummary(task: TaskManifestTask): string {
  return [
    `### ${task.taskId} — ${task.title}`,
    `- Description: ${formatValue(task.description)}`,
    `- Depends On: ${inlineList(task.dependsOn)}`,
    `- Target Paths: ${inlineList(task.targetPaths)}`,
    '- Commands:',
    bulletList(task.commands),
    '- Acceptance Criteria:',
    bulletList(task.acceptanceCriteria),
  ].join('\n');
}

function renderAllTasks(manifest: TaskManifest): string {
  return manifest.tasks.map(renderTaskSummary).join('\n\n');
}

function renderGuardrails(manifest: TaskManifest): string {
  return [
    '## Bounded Scope',
    `- Summary: ${manifest.boundedScope.summary}`,
    '- Allowed Paths:',
    bulletList(manifest.boundedScope.allowedPaths),
    '- Forbidden Paths:',
    bulletList(manifest.boundedScope.forbiddenPaths),
    '- In Scope:',
    bulletList(manifest.boundedScope.inScope),
    '- Non-Goals / Out Of Scope:',
    bulletList(manifest.boundedScope.outOfScope),
    '',
    '## Policy Guardrails',
    `- Dry Run: ${manifest.policy.dryRun}`,
    `- Branch PR Only: ${manifest.policy.branchPrOnly}`,
    `- Auto Merge: ${manifest.policy.autoMerge}`,
    `- Deploys Allowed: ${manifest.policy.deploysAllowed}`,
    `- Credential Copying Allowed: ${manifest.policy.credentialCopyingAllowed}`,
    '- Command Denylist:',
    bulletList(manifest.policy.commandDenylist),
    '- Required Validation:',
    bulletList(manifest.policy.requiredValidation),
  ].join('\n');
}

function renderContextRefs(manifest: TaskManifest): string {
  return [
    '## Context References',
    `- Summary: ${formatValue(manifest.context.summary)}`,
    ...(manifest.context.contextRefs.length > 0
      ? manifest.context.contextRefs.map(contextRefLine)
      : ['- _None._']),
    manifest.context.tasksMdProjection
      ? `- tasks.md projection: ${manifest.context.tasksMdProjection.path} (durableSourceOfTruth=${manifest.context.tasksMdProjection.durableSourceOfTruth})`
      : '- tasks.md projection: _None._',
  ].join('\n');
}

function renderValidation(manifest: TaskManifest): string {
  return [
    '## Validation Commands',
    bulletList(manifest.validation.requiredCommands),
    '',
    '## Validation Success Criteria',
    bulletList(manifest.validation.successCriteria),
    '',
    '## Validation Artifact References',
    ...(manifest.validation.artifactRefs.length > 0
      ? manifest.validation.artifactRefs.map(contextRefLine)
      : ['- _None._']),
  ].join('\n');
}

function renderEvidence(manifest: TaskManifest): string {
  const evidenceLines = manifest.evidence.length > 0
    ? manifest.evidence.map((evidence) => {
      const fields = [
        `kind=${evidence.kind}`,
        `ref=${evidence.ref}`,
        evidence.path ? `path=${evidence.path}` : undefined,
        evidence.digest ? `digest=${evidence.digest}` : undefined,
        evidence.summary ? `summary=${evidence.summary}` : undefined,
      ].filter(Boolean);
      return `- ${fields.join('; ')}`;
    })
    : ['- _No evidence requirements provided._'];

  return [
    '## Evidence and Writeback Expectations',
    ...evidenceLines,
    '- At completion, report changed files, validation commands run, outcomes, and any remaining risks in the normal Rorca story result output.',
    '- Preserve `manifest.json` and `tasks.md` as input artifacts; do not treat `tasks.md` as durable state.',
    '- If a required validation command cannot run, record the concrete blocker and the safest fallback evidence.',
  ].join('\n');
}

function renderTaskDescription(manifest: TaskManifest, task: TaskManifestTask, sourceStoryIds: string[]): string {
  return [
    '=== HERMES TASK MANIFEST EXECUTION ENVELOPE ===',
    '',
    '## Objective',
    manifest.objective,
    '',
    renderSourceSection(manifest, sourceStoryIds),
    '',
    '## Current Task',
    renderTaskSummary(task),
    '',
    '## Full Manifest Task List',
    renderAllTasks(manifest),
    '',
    renderGuardrails(manifest),
    '',
    renderContextRefs(manifest),
    '',
    renderValidation(manifest),
    '',
    renderEvidence(manifest),
    '',
    '=== END HERMES TASK MANIFEST EXECUTION ENVELOPE ===',
  ].join('\n');
}

function storyAcceptanceCriteria(manifest: TaskManifest, task: TaskManifestTask): string[] {
  const validationCommands = manifest.validation.requiredCommands.map((command) => `Validation command completed or explicitly blocked with evidence: ${command}`);
  const requiredValidation = manifest.policy.requiredValidation.map((name) => `Required validation satisfied: ${name}`);
  return uniqueStrings([
    ...task.acceptanceCriteria,
    ...manifest.validation.successCriteria,
    ...requiredValidation,
    ...validationCommands,
    'Evidence/writeback summary includes changed files, validations run, outcomes, and remaining risks.',
    'Implementation stayed inside bounded scope and respected non-goals/forbidden paths.',
  ]);
}

function storyFiles(manifest: TaskManifest, task: TaskManifestTask): string[] {
  return uniqueStrings([
    ...task.targetPaths,
    ...manifest.boundedScope.allowedPaths,
    ...manifest.context.contextRefs.map((ref) => ref.path),
    ...manifest.validation.artifactRefs.map((ref) => ref.path),
    ...manifest.evidence.map((evidence) => evidence.path),
  ]);
}

export function computeSyntheticTaskManifestSpecHash(spec: SyntheticTaskManifestSpec): string {
  return `sha256:${crypto.createHash('sha256').update(`${JSON.stringify(spec, null, 2)}\n`, 'utf8').digest('hex')}`;
}

export function createTaskManifestExecutionEnvelope(manifest: TaskManifest): SyntheticTaskManifestSpec {
  assertTaskManifestDirectExecutionAllowed(manifest);

  const sourceStoryIds = collectSourceStoryIds(manifest);
  const specId = taskManifestSpecId(manifest.manifestId);
  const manifestHash = computeTaskManifestHash(manifest);
  const storyIds = taskStoryIdMap(manifest);
  const stories = manifest.tasks.map((task): SyntheticTaskManifestStory => {
    const files = storyFiles(manifest, task);
    return {
      id: storyIds.get(task.taskId)!,
      title: task.title,
      description: renderTaskDescription(manifest, task, sourceStoryIds),
      acceptanceCriteria: storyAcceptanceCriteria(manifest, task),
      dependsOn: task.dependsOn.map((dependency) => {
        const storyId = storyIds.get(dependency);
        if (!storyId) throw new ValidationError(`Task manifest dependency '${dependency}' does not identify a task in this manifest.`);
        return storyId;
      }),
      ...(files.length > 0 ? { files } : {}),
    };
  });

  const unboundSpec = {
    id: specId,
    title: `Hermes Task Manifest ${manifest.manifestId}`,
    brief: manifest.objective,
    generatedAt: manifest.createdAt,
    internal: true as const,
    source: HERMES_TASK_MANIFEST_SOURCE,
    manifestId: manifest.manifestId,
    idempotencyKey: manifest.idempotencyKey,
    manifestHash,
    ...(manifest.source.rorca?.specId ? { sourceSpecId: manifest.source.rorca.specId } : {}),
    ...(manifest.source.rorca?.runId !== undefined ? { sourceRunId: manifest.source.rorca.runId } : {}),
    sourceStoryIds,
    mergeStrategy: manifest.execution.mergeStrategy,
    ...(manifest.execution.modelOverride ? { model: manifest.execution.modelOverride } : {}),
    ...(manifest.execution.agentOverride ? { agentOverride: manifest.execution.agentOverride } : {}),
    ...(manifest.execution.effortLevel ? { reasoning: { enabled: true as const, effort: manifest.execution.effortLevel } } : {}),
    taskManifestExecution: {
      version: TASK_MANIFEST_EXECUTION_ENVELOPE_VERSION,
      source: HERMES_TASK_MANIFEST_SOURCE,
      manifestId: manifest.manifestId,
      idempotencyKey: manifest.idempotencyKey,
      routeDecision: manifest.routeDecision,
      ...(manifest.source.rorca?.specId ? { sourceSpecId: manifest.source.rorca.specId } : {}),
      ...(manifest.source.rorca?.runId !== undefined ? { sourceRunId: manifest.source.rorca.runId } : {}),
      sourceStoryIds,
      validationCommands: [...manifest.validation.requiredCommands],
      commandDenylist: [...manifest.policy.commandDenylist],
      internal: true as const,
    },
    userStories: stories,
  };
  return {
    ...unboundSpec,
    exportKitIdentity: compileSpecExportKit(unboundSpec).identity,
  };
}

async function writeSyntheticSpecExclusive(input: {
  workspacePath: string;
  artifactRoot: string;
  artifactDir: string;
  specPath: string;
  content: string;
}): Promise<void> {
  for (const component of [
    path.join(input.workspacePath, 'forge'),
    input.artifactRoot,
    input.artifactDir,
  ]) {
    const stat = await fs.lstat(component);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ConflictError('Synthetic task-manifest spec has a symlink or non-directory ancestor');
    }
  }

  try {
    const stat = await fs.lstat(input.specPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ConflictError('Synthetic task-manifest spec authority must be a regular non-symlink file');
    }
    const handle = await fs.open(input.specPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const existing = await handle.readFile('utf8');
      if (existing === input.content) return;
    } finally {
      await handle.close();
    }
    throw new ConflictError('Synthetic task-manifest spec already exists with different content');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      input.specPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(input.content, 'utf8');
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ConflictError('Synthetic task-manifest spec publication lost exclusive filesystem authority');
    }
    throw error;
  } finally {
    await handle?.close();
  }
  const directory = await fs.open(input.artifactDir, fsConstants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function writeTaskManifestExecutionEnvelope(
  input: WriteTaskManifestExecutionEnvelopeInput,
): Promise<WriteTaskManifestExecutionEnvelopeResult> {
  const spec = createTaskManifestExecutionEnvelope(input.manifest);
  const artifact = await writeTaskManifestArtifact({
    workspacePath: input.workspacePath,
    manifest: input.manifest,
  });
  const paths = resolveTaskManifestArtifactPaths(input.workspacePath, input.manifest.manifestId);
  const publishedExportKit = publishSpecExportKit(input.workspacePath, spec);
  if (publishedExportKit.manifestHash !== spec.exportKitIdentity.manifestHash) {
    throw new ConflictError('Synthetic task-manifest export kit differs from its planned immutable identity');
  }
  if (input.exportKitApproval) {
    sealSpecExportKit(input.workspacePath, spec, input.exportKitApproval);
  }
  const fileName = `${spec.id}.json`;
  const specPath = path.join(paths.artifactDir, fileName);
  const relativeSpecPath = path.join(paths.relativeArtifactDir, fileName);

  await writeSyntheticSpecExclusive({
    workspacePath: paths.workspacePath,
    artifactRoot: paths.artifactRoot,
    artifactDir: paths.artifactDir,
    specPath,
    content: `${JSON.stringify(spec, null, 2)}\n`,
  });

  return {
    spec,
    specPath,
    relativeSpecPath,
    artifactDir: paths.artifactDir,
    relativeArtifactDir: paths.relativeArtifactDir,
    manifestPath: paths.manifestPath,
    tasksMdPath: paths.tasksMdPath,
    manifestHash: artifact.manifestHash,
    syntheticSpecHash: computeSyntheticTaskManifestSpecHash(spec),
    artifactReused: artifact.reused,
  };
}
