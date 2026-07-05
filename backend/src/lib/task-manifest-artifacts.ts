/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { ConflictError, NotFoundError, ValidationError } from './errors';
import { redactSecretLikeStrings } from './context-safety';
import type { TaskManifest, TaskManifestContextRef } from './task-manifest';

const TASK_MANIFEST_ARTIFACT_ROOT = path.join('forge', 'task-manifests');
const MANIFEST_FILE_NAME = 'manifest.json';
const TASKS_MD_FILE_NAME = 'tasks.md';
const SAFE_MANIFEST_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHELL_METACHAR_PATTERN = /[;&|$`!><]/;

interface JsonRecord {
  [key: string]: unknown;
}

export interface TaskManifestArtifactPaths {
  workspacePath: string;
  artifactRoot: string;
  artifactDir: string;
  manifestPath: string;
  tasksMdPath: string;
  relativeArtifactDir: string;
  relativeManifestPath: string;
  relativeTasksMdPath: string;
}

export interface WriteTaskManifestArtifactInput {
  workspacePath: string;
  manifest: TaskManifest;
}

export interface TaskManifestArtifactResult extends TaskManifestArtifactPaths {
  manifestId: string;
  idempotencyKey: string;
  manifestHash: string;
  reused: boolean;
}

export interface ReadTaskManifestArtifactResult extends TaskManifestArtifactPaths {
  manifest: TaskManifest;
  manifestHash: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableSortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableSortJson(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableSortJson(nested)]),
  );
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(stableSortJson(value), null, 2)}\n`;
}

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function decodeManifestIdForValidation(manifestId: string): string {
  try {
    return decodeURIComponent(manifestId);
  } catch {
    throw new ValidationError('Invalid task manifest id: malformed URL encoding');
  }
}

export function validateTaskManifestId(manifestId: string): string {
  if (typeof manifestId !== 'string' || manifestId.trim().length === 0) {
    throw new ValidationError('Invalid task manifest id: id is required');
  }

  if (manifestId !== manifestId.trim()) {
    throw new ValidationError('Invalid task manifest id: surrounding whitespace is not allowed');
  }

  if (manifestId.includes('\0')) {
    throw new ValidationError('Invalid task manifest id: NUL bytes are not allowed');
  }

  const decoded = decodeManifestIdForValidation(manifestId);
  if (decoded !== manifestId) {
    throw new ValidationError('Invalid task manifest id: URL-encoded characters are not allowed');
  }

  if (path.isAbsolute(manifestId) || path.posix.isAbsolute(manifestId) || path.win32.isAbsolute(manifestId)) {
    throw new ValidationError('Invalid task manifest id: absolute paths are not allowed');
  }

  if (manifestId.includes('..') || decoded.includes('..')) {
    throw new ValidationError('Invalid task manifest id: traversal segments are not allowed');
  }

  if (manifestId.includes('/') || manifestId.includes('\\')) {
    throw new ValidationError('Invalid task manifest id: path separators are not allowed');
  }

  if (SHELL_METACHAR_PATTERN.test(manifestId)) {
    throw new ValidationError('Invalid task manifest id: shell metacharacters are not allowed');
  }

  if (!SAFE_MANIFEST_ID_PATTERN.test(manifestId)) {
    throw new ValidationError('Invalid task manifest id: only alphanumeric characters, hyphen, and underscore are allowed');
  }

  return manifestId;
}

function assertContainedPath(candidate: string, root: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ValidationError('Task manifest artifact path escapes the task-manifests directory');
  }
}

export function resolveTaskManifestArtifactPaths(workspacePath: string, manifestId: string): TaskManifestArtifactPaths {
  const safeManifestId = validateTaskManifestId(manifestId);
  const workspaceRoot = path.resolve(workspacePath);
  const artifactRoot = path.resolve(workspaceRoot, TASK_MANIFEST_ARTIFACT_ROOT);
  const artifactDir = path.resolve(artifactRoot, safeManifestId);

  assertContainedPath(artifactDir, artifactRoot);

  const manifestPath = path.join(artifactDir, MANIFEST_FILE_NAME);
  const tasksMdPath = path.join(artifactDir, TASKS_MD_FILE_NAME);

  return {
    workspacePath: workspaceRoot,
    artifactRoot,
    artifactDir,
    manifestPath,
    tasksMdPath,
    relativeArtifactDir: path.join(TASK_MANIFEST_ARTIFACT_ROOT, safeManifestId),
    relativeManifestPath: path.join(TASK_MANIFEST_ARTIFACT_ROOT, safeManifestId, MANIFEST_FILE_NAME),
    relativeTasksMdPath: path.join(TASK_MANIFEST_ARTIFACT_ROOT, safeManifestId, TASKS_MD_FILE_NAME),
  };
}

export function canonicalTaskManifestJson(manifest: TaskManifest): string {
  return stableJson(manifest);
}

export function computeTaskManifestHash(manifest: TaskManifest): string {
  return sha256(canonicalTaskManifestJson(manifest));
}

function markdownText(value: string | number | boolean | undefined | null): string {
  if (value === undefined || value === null || value === '') {
    return '_Not provided._';
  }
  return redactSecretLikeStrings(String(value)).replace(/\r\n/g, '\n').trim();
}

function inlineValue(value: string | number | boolean | undefined | null): string {
  const text = markdownText(value);
  if (text === '_Not provided._') {
    return text;
  }
  return `\`${text.replace(/`/g, '\\`')}\``;
}

function renderStringList(items: readonly string[] | undefined, emptyLabel = '_None._'): string[] {
  if (!items || items.length === 0) {
    return [`- ${emptyLabel}`];
  }
  return items.map((item) => `- ${markdownText(item)}`);
}

function contextRefSortKey(ref: TaskManifestContextRef): string {
  return [ref.kind, ref.ref, ref.path ?? '', ref.title ?? '', ref.digest ?? ''].join('\0');
}

function renderContextRefs(refs: readonly TaskManifestContextRef[] | undefined, emptyLabel = '_None._'): string[] {
  if (!refs || refs.length === 0) {
    return [`- ${emptyLabel}`];
  }

  return [...refs]
    .sort((left, right) => contextRefSortKey(left).localeCompare(contextRefSortKey(right)))
    .map((ref) => {
      const details = [
        `kind=${markdownText(ref.kind)}`,
        `ref=${markdownText(ref.ref)}`,
        ref.path ? `path=${markdownText(ref.path)}` : undefined,
        ref.title ? `title=${markdownText(ref.title)}` : undefined,
        ref.digest ? `digest=${markdownText(ref.digest)}` : undefined,
        ref.excerpt ? `excerpt=${markdownText(ref.excerpt)}` : undefined,
      ].filter(Boolean).join('; ');
      return `- ${details}`;
    });
}

function renderEvidence(manifest: TaskManifest): string[] {
  if (manifest.evidence.length === 0) {
    return ['- _No evidence requirements provided._'];
  }

  return [...manifest.evidence]
    .sort((left, right) => [left.kind, left.ref, left.path ?? '', left.digest ?? ''].join('\0')
      .localeCompare([right.kind, right.ref, right.path ?? '', right.digest ?? ''].join('\0')))
    .map((evidence) => {
      const details = [
        `kind=${markdownText(evidence.kind)}`,
        `ref=${markdownText(evidence.ref)}`,
        evidence.path ? `path=${markdownText(evidence.path)}` : undefined,
        evidence.digest ? `digest=${markdownText(evidence.digest)}` : undefined,
        evidence.summary ? `summary=${markdownText(evidence.summary)}` : undefined,
      ].filter(Boolean).join('; ');
      return `- ${details}`;
    });
}

function renderSourceRefs(manifest: TaskManifest): string[] {
  const { source } = manifest;
  const lines = [
    '## Source Refs',
    '',
    '### Rorca',
    `- Spec ID: ${inlineValue(source.rorca?.specId)}`,
    `- Run ID: ${inlineValue(source.rorca?.runId)}`,
    `- Story ID: ${inlineValue(source.rorca?.storyId)}`,
    `- Spec Path: ${inlineValue(source.rorca?.specPath)}`,
    '',
    '### External Refs',
  ];

  if (source.github) {
    lines.push(
      `- GitHub Owner: ${inlineValue(source.github.owner)}`,
      `- GitHub Repo: ${inlineValue(source.github.repo)}`,
      `- GitHub PR Number: ${inlineValue(source.github.pullRequestNumber)}`,
      `- GitHub PR URL: ${inlineValue(source.github.pullRequestUrl)}`,
      `- GitHub Head SHA: ${inlineValue(source.github.headSha)}`,
    );
  }

  if (source.linear) {
    lines.push(
      `- Linear Issue ID: ${inlineValue(source.linear.issueId)}`,
      `- Linear Issue Key: ${inlineValue(source.linear.issueKey)}`,
      `- Linear Issue URL: ${inlineValue(source.linear.issueUrl)}`,
    );
  }

  if (source.slack) {
    lines.push(
      `- Slack Channel ID: ${inlineValue(source.slack.channelId)}`,
      `- Slack Thread TS: ${inlineValue(source.slack.threadTs)}`,
      `- Slack Message TS: ${inlineValue(source.slack.messageTs)}`,
      `- Slack Thread URL: ${inlineValue(source.slack.threadUrl)}`,
    );
  }

  if (source.operator) {
    lines.push(
      `- Operator Intent ID: ${inlineValue(source.operator.intentId)}`,
      `- Operator Actor: ${inlineValue(source.operator.actor)}`,
      `- Operator Summary: ${markdownText(source.operator.summary)}`,
    );
  }

  if (source.cli) {
    lines.push(
      `- CLI Invocation ID: ${inlineValue(source.cli.invocationId)}`,
      `- CLI Command: ${inlineValue(source.cli.command)}`,
      '- CLI Args:',
      ...renderStringList(source.cli.args),
    );
  }

  if (!source.github && !source.linear && !source.slack && !source.operator && !source.cli) {
    lines.push('- _None._');
  }

  return lines;
}

function renderGuardrails(manifest: TaskManifest): string[] {
  return [
    '## Guardrails',
    '',
    '### Bounded Scope',
    `- Summary: ${markdownText(manifest.boundedScope.summary)}`,
    '- Allowed Paths:',
    ...renderStringList(manifest.boundedScope.allowedPaths),
    '- Forbidden Paths:',
    ...renderStringList(manifest.boundedScope.forbiddenPaths),
    '- In Scope:',
    ...renderStringList(manifest.boundedScope.inScope),
    '- Out Of Scope:',
    ...renderStringList(manifest.boundedScope.outOfScope),
    '',
    '### Policy',
    `- Dry Run: ${inlineValue(manifest.policy.dryRun)}`,
    `- Branch PR Only: ${inlineValue(manifest.policy.branchPrOnly)}`,
    `- Auto Merge: ${inlineValue(manifest.policy.autoMerge)}`,
    `- Deploys Allowed: ${inlineValue(manifest.policy.deploysAllowed)}`,
    `- Credential Copying Allowed: ${inlineValue(manifest.policy.credentialCopyingAllowed)}`,
    '- Command Denylist:',
    ...renderStringList(manifest.policy.commandDenylist),
    '- Required Validation:',
    ...renderStringList(manifest.policy.requiredValidation),
    '',
    '### Execution',
    `- Agent Override: ${inlineValue(manifest.execution.agentOverride)}`,
    `- Model Override: ${inlineValue(manifest.execution.modelOverride)}`,
    `- Effort Level: ${inlineValue(manifest.execution.effortLevel)}`,
    `- Terminal Mode: ${inlineValue(manifest.execution.terminalMode)}`,
    `- Merge Strategy: ${inlineValue(manifest.execution.mergeStrategy)}`,
    `- Execution Environment: ${inlineValue(manifest.execution.executionEnvironment)}`,
    `- Execution Environment ID: ${inlineValue(manifest.execution.executionEnvironmentId)}`,
  ];
}

function renderTasks(manifest: TaskManifest): string[] {
  const lines = ['## Tasks', ''];
  const tasks = [...manifest.tasks]
    .sort((left, right) => left.taskId.localeCompare(right.taskId) || left.title.localeCompare(right.title));

  for (const task of tasks) {
    lines.push(
      `### ${markdownText(task.taskId)} — ${markdownText(task.title)}`,
      `- Description: ${markdownText(task.description)}`,
      '- Depends On:',
      ...renderStringList(task.dependsOn),
      '- Target Paths:',
      ...renderStringList(task.targetPaths),
      '- Commands:',
      ...renderStringList(task.commands),
      '- Acceptance Criteria:',
      ...renderStringList(task.acceptanceCriteria),
      '',
    );
  }

  return lines;
}

function renderValidation(manifest: TaskManifest): string[] {
  return [
    '## Validation',
    '',
    '- Required Commands:',
    ...renderStringList(manifest.validation.requiredCommands),
    '- Success Criteria:',
    ...renderStringList(manifest.validation.successCriteria),
    '- Artifact Refs:',
    ...renderContextRefs(manifest.validation.artifactRefs),
  ];
}

export function renderTaskManifestTasksMarkdown(manifest: TaskManifest): string {
  const lines = [
    '# Task Manifest Projection',
    '',
    '> Deterministic projection for operator and agent readability only. `manifest.json` is the durable source of truth; do not treat `tasks.md` as canonical state.',
    '',
    '## Manifest ID',
    inlineValue(manifest.manifestId),
    '',
    '## Idempotency Key',
    inlineValue(manifest.idempotencyKey),
    '',
    '## Workspace ID',
    inlineValue(manifest.workspaceId),
    '',
    ...renderSourceRefs(manifest),
    '',
    '## Objective',
    markdownText(manifest.objective),
    '',
    ...renderGuardrails(manifest),
    '',
    ...renderTasks(manifest),
    ...renderValidation(manifest),
    '',
    '## Evidence',
    '',
    ...renderEvidence(manifest),
    '',
  ];

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

async function readExistingManifest(manifestPath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function idempotencyKeyFromManifest(value: unknown): string | undefined {
  return isRecord(value) && typeof value.idempotencyKey === 'string' ? value.idempotencyKey : undefined;
}

function hashStoredManifest(value: unknown): string {
  return sha256(stableJson(value));
}

function conflictForExistingManifest(manifest: TaskManifest, existing: unknown, existingHash: string, manifestHash: string): ConflictError {
  const existingKey = idempotencyKeyFromManifest(existing);
  if (existingKey === manifest.idempotencyKey) {
    return new ConflictError(
      `Task manifest artifact '${manifest.manifestId}' already exists for idempotency key '${manifest.idempotencyKey}' with a different manifest hash`,
    );
  }

  return new ConflictError(
    `Task manifest artifact '${manifest.manifestId}' already exists with a different idempotency key or manifest hash (${existingHash} != ${manifestHash})`,
  );
}

export async function writeTaskManifestArtifact(input: WriteTaskManifestArtifactInput): Promise<TaskManifestArtifactResult> {
  const { manifest } = input;
  const paths = resolveTaskManifestArtifactPaths(input.workspacePath, manifest.manifestId);
  const manifestJson = canonicalTaskManifestJson(manifest);
  const manifestHash = sha256(manifestJson);
  const existing = await readExistingManifest(paths.manifestPath);

  if (existing) {
    const existingHash = hashStoredManifest(existing);
    const existingKey = idempotencyKeyFromManifest(existing);
    if (existingKey === manifest.idempotencyKey && existingHash === manifestHash) {
      return {
        ...paths,
        manifestId: manifest.manifestId,
        idempotencyKey: manifest.idempotencyKey,
        manifestHash,
        reused: true,
      };
    }
    throw conflictForExistingManifest(manifest, existing, existingHash, manifestHash);
  }

  await fs.mkdir(paths.artifactDir, { recursive: true });

  try {
    await fs.writeFile(paths.tasksMdPath, renderTaskManifestTasksMarkdown(manifest), { flag: 'wx' });
    await fs.writeFile(paths.manifestPath, manifestJson, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const racedManifest = await readExistingManifest(paths.manifestPath);
      if (racedManifest) {
        const racedHash = hashStoredManifest(racedManifest);
        if (idempotencyKeyFromManifest(racedManifest) === manifest.idempotencyKey && racedHash === manifestHash) {
          return {
            ...paths,
            manifestId: manifest.manifestId,
            idempotencyKey: manifest.idempotencyKey,
            manifestHash,
            reused: true,
          };
        }
        throw conflictForExistingManifest(manifest, racedManifest, racedHash, manifestHash);
      }
      throw new ConflictError(`Task manifest artifact '${manifest.manifestId}' already has files but no readable manifest.json`);
    }
    await fs.rm(paths.tasksMdPath, { force: true }).catch(() => undefined);
    await fs.rm(paths.manifestPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    ...paths,
    manifestId: manifest.manifestId,
    idempotencyKey: manifest.idempotencyKey,
    manifestHash,
    reused: false,
  };
}

export async function readTaskManifestArtifact(workspacePath: string, manifestId: string): Promise<ReadTaskManifestArtifactResult> {
  const paths = resolveTaskManifestArtifactPaths(workspacePath, manifestId);
  const manifest = await readExistingManifest(paths.manifestPath);
  if (!manifest) {
    throw new NotFoundError('Task manifest artifact', manifestId);
  }

  return {
    ...paths,
    manifest: manifest as TaskManifest,
    manifestHash: hashStoredManifest(manifest),
  };
}
