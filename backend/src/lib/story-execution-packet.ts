/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import type { AgentType } from './config';
import type { TerminalMode } from './terminal-mode';
import {
  buildPiDoneChecklist,
  inferPiCandidateTests,
  inferPiValidationCommands,
} from './pi-autonomous-runner';

export type StoryExecutionMode = 'impl' | 'qa' | 'journey';

export interface ExecutionPacketStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  acceptance?: string;
  dependsOn?: string[];
  files?: string[];
}

/**
 * CTM-006: Minimal workspace-context signal consumed by readiness scoring.
 *
 * This is intentionally a structural subset of the canonical
 * `WorkspaceContextRouting.contract` + `richnessScore` shape so callers can pass
 * the canonical routing decision straight through without this pure lib importing
 * route/echolocation code. Keeping it deterministic means a context-blind
 * workspace is flagged the same way everywhere.
 */
export interface WorkspaceContextSignal {
  /** 0–100 context richness from the canonical routing path. */
  richnessScore?: number;
  /** Whether the .rorca / AGENTS.md / MEMORY.md routing contract is satisfied. */
  contractSatisfied?: boolean;
}

export interface StoryExecutionReadiness {
  score: number;
  grade: 'strong' | 'fair' | 'weak';
  strengths: string[];
  warnings: string[];
  recommendedFallbackEngine: AgentType | null;
  expectedArtifacts: string[];
}

export interface StoryExecutionPacket {
  candidateFiles: string[];
  candidateTests: string[];
  validationCommands: string[];
  doneChecklist: string[];
  expectedArtifacts: string[];
  readiness: StoryExecutionReadiness;
}

/**
 * LFC-008: Immutable contract handed from lifecycle/policy resolution to the
 * execution engine. The engine may consume these values, but must not infer a
 * broader policy from story prose or mutate the resolved options.
 */
export const STORY_EXECUTION_MANIFEST_VERSION = 'rorca.story-execution-manifest.v1' as const;
export const STORY_EXECUTION_MANIFEST_HASH_PREFIX = 'sha256:' as const;

export type StoryChangePolicy = 'code_required' | 'no_code_allowed';
export type BaselineFailurePolicy = 'block' | 'allow_with_host_evidence';

export interface StoryManifestIdentity {
  workspaceId: string;
  specId: string;
  storyId: string;
  runId: number;
  attempt: number;
}

export interface StoryManifestRevisions {
  /** Immutable canonical spec content hash/revision. */
  specRevision: string;
  /** Immutable canonical story content hash/revision. */
  storyRevision: string;
}

export interface StoryManifestWorktreeOptions {
  enabled: boolean;
  path: string | null;
  branch: string | null;
  baseRevision: string;
}

export interface StoryManifestMergeOptions {
  enabled: boolean;
  strategy: 'direct' | 'pr' | 'draft-pr' | 'branch-only';
  targetBranch: string | null;
}

export interface StoryManifestExecutionOptions {
  agent: AgentType;
  model: string | null;
  effort: string | null;
  terminal: TerminalMode;
  worktree: StoryManifestWorktreeOptions;
  merge: StoryManifestMergeOptions;
}

export interface StoryValidationRequirement {
  id: string;
  command: string;
  args: string[];
  /** Hash of only the canonical executable and arguments, never shell output. */
  commandHash: string;
  required: boolean;
  revisionSensitive: boolean;
  timeoutMs: number;
}

export interface StoryEvidenceExpectation {
  criterionId: string;
  description: string;
  requiredEvidenceKinds: Array<'validation' | 'revision' | 'completion' | 'qa' | 'journey'>;
}

export interface StoryRepositoryProfile {
  profileId: string;
  changePolicy: StoryChangePolicy;
  /** Mandatory explanation when no code output is a legitimate result. */
  noCodeReason: string | null;
  runtimeMetadataPaths: string[];
}

export interface StoryCommandSafetyProfile {
  profileId: string;
  guardVersion: string;
  guardedWorkingDirectory: string;
  allowedWorkingDirectories: string[];
  blockedCommandPatterns: string[];
  redactedEnvironmentKeys: string[];
  allowBackendJest: boolean;
  baselineFailurePolicy: BaselineFailurePolicy;
}

export interface StoryExecutionManifestInput {
  identity: StoryManifestIdentity;
  revisions: StoryManifestRevisions;
  executionMode: StoryExecutionMode;
  execution: StoryManifestExecutionOptions;
  validationPlan: Array<Omit<StoryValidationRequirement, 'commandHash'> & { commandHash?: string }>;
  evidenceExpectations: StoryEvidenceExpectation[];
  repositoryProfile: StoryRepositoryProfile;
  commandSafety: StoryCommandSafetyProfile;
}

export interface StoryExecutionManifest extends Omit<StoryExecutionManifestInput, 'validationPlan'> {
  schemaVersion: typeof STORY_EXECUTION_MANIFEST_VERSION;
  validationPlan: StoryValidationRequirement[];
  manifestHash: string;
}

export type ImmutableStoryExecutionManifest = Readonly<{
  [K in keyof StoryExecutionManifest]: DeepReadonly<StoryExecutionManifest[K]>;
}>;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    );
  }
  return value;
}

/** Stable JSON used for command and manifest identities. */
export function canonicalizeStoryContract(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function sha256(value: unknown): string {
  return `${STORY_EXECUTION_MANIFEST_HASH_PREFIX}${crypto
    .createHash('sha256')
    .update(canonicalizeStoryContract(value), 'utf8')
    .digest('hex')}`;
}

/** Immutable content revision for canonical spec/story snapshots. */
export function deriveStoryContractRevision(value: unknown): string {
  return sha256(value);
}

function requiredManifestText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function sortedUnique(items: string[], field: string): string[] {
  return [...new Set(items.map((item, index) => requiredManifestText(item, `${field}.${index}`)))]
    .sort((left, right) => left.localeCompare(right));
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  }
  return value as DeepReadonly<T>;
}

export function deriveStoryCommandHash(command: string, args: readonly string[]): string {
  return sha256({
    command: requiredManifestText(command, 'command'),
    args: args.map((arg) => String(arg).normalize('NFKC')),
  });
}

function normalizeManifestInput(input: StoryExecutionManifestInput): Omit<StoryExecutionManifest, 'schemaVersion' | 'manifestHash'> {
  if (!(['impl', 'qa', 'journey'] as const).includes(input.executionMode)) {
    throw new TypeError('executionMode must be impl, qa, or journey');
  }
  if (!(['claude', 'opencode', 'codex', 'pi'] as const).includes(input.execution.agent)) {
    throw new TypeError('execution.agent is invalid');
  }
  if (!(['ansi-html', 'pty'] as const).includes(input.execution.terminal)) {
    throw new TypeError('execution.terminal is invalid');
  }
  if (!(['direct', 'pr', 'draft-pr', 'branch-only'] as const).includes(input.execution.merge.strategy)) {
    throw new TypeError('execution.merge.strategy is invalid');
  }
  if (!(['code_required', 'no_code_allowed'] as const).includes(input.repositoryProfile.changePolicy)) {
    throw new TypeError('repositoryProfile.changePolicy is invalid');
  }
  if (!(['block', 'allow_with_host_evidence'] as const).includes(input.commandSafety.baselineFailurePolicy)) {
    throw new TypeError('commandSafety.baselineFailurePolicy is invalid');
  }
  if (!Number.isSafeInteger(input.identity.runId) || input.identity.runId <= 0) {
    throw new TypeError('identity.runId must be a positive safe integer');
  }
  if (!Number.isSafeInteger(input.identity.attempt) || input.identity.attempt <= 0) {
    throw new TypeError('identity.attempt must be a positive safe integer');
  }
  if (input.repositoryProfile.changePolicy === 'no_code_allowed' && !input.repositoryProfile.noCodeReason?.trim()) {
    throw new TypeError('repositoryProfile.noCodeReason is required when changePolicy is no_code_allowed');
  }
  if (input.execution.worktree.enabled && (!input.execution.worktree.path || !input.execution.worktree.branch)) {
    throw new TypeError('enabled worktree options require path and branch');
  }

  const guardedWorkingDirectory = requiredManifestText(input.commandSafety.guardedWorkingDirectory, 'commandSafety.guardedWorkingDirectory');
  if (!input.commandSafety.allowedWorkingDirectories.map((item) => item.trim()).includes(guardedWorkingDirectory)) {
    throw new TypeError('commandSafety.allowedWorkingDirectories must include guardedWorkingDirectory');
  }

  const validationIds = new Set<string>();
  const validationPlan = input.validationPlan.map((requirement, index): StoryValidationRequirement => {
    const id = requiredManifestText(requirement.id, `validationPlan.${index}.id`);
    if (validationIds.has(id)) throw new TypeError(`validationPlan contains duplicate id ${id}`);
    validationIds.add(id);
    const command = requiredManifestText(requirement.command, `validationPlan.${index}.command`);
    const args = requirement.args.map((arg) => String(arg).normalize('NFKC'));
    const commandHash = deriveStoryCommandHash(command, args);
    if (requirement.commandHash && requirement.commandHash !== commandHash) {
      throw new TypeError(`validationPlan.${index}.commandHash does not match command and args`);
    }
    if (typeof requirement.required !== 'boolean' || typeof requirement.revisionSensitive !== 'boolean') {
      throw new TypeError(`validationPlan.${index} required/revisionSensitive must be boolean`);
    }
    if (!Number.isSafeInteger(requirement.timeoutMs) || requirement.timeoutMs <= 0) {
      throw new TypeError(`validationPlan.${index}.timeoutMs must be a positive safe integer`);
    }
    return {
      id,
      command,
      args,
      commandHash,
      required: requirement.required,
      revisionSensitive: requirement.revisionSensitive,
      timeoutMs: requirement.timeoutMs,
    };
  });

  const criterionIds = new Set<string>();
  const evidenceExpectations = input.evidenceExpectations.map((expectation, index) => {
    const criterionId = requiredManifestText(expectation.criterionId, `evidenceExpectations.${index}.criterionId`);
    if (criterionIds.has(criterionId)) throw new TypeError(`evidenceExpectations contains duplicate criterionId ${criterionId}`);
    criterionIds.add(criterionId);
    if (expectation.requiredEvidenceKinds.length === 0) {
      throw new TypeError(`evidenceExpectations.${index}.requiredEvidenceKinds must not be empty`);
    }
    if (expectation.requiredEvidenceKinds.some((kind) => !(['validation', 'revision', 'completion', 'qa', 'journey'] as const).includes(kind))) {
      throw new TypeError(`evidenceExpectations.${index}.requiredEvidenceKinds contains an invalid kind`);
    }
    return {
      criterionId,
      description: requiredManifestText(expectation.description, `evidenceExpectations.${index}.description`),
      requiredEvidenceKinds: [...new Set(expectation.requiredEvidenceKinds)].sort(),
    };
  }).sort((left, right) => left.criterionId.localeCompare(right.criterionId));

  return {
    identity: {
      workspaceId: requiredManifestText(input.identity.workspaceId, 'identity.workspaceId'),
      specId: requiredManifestText(input.identity.specId, 'identity.specId'),
      storyId: requiredManifestText(input.identity.storyId, 'identity.storyId'),
      runId: input.identity.runId,
      attempt: input.identity.attempt,
    },
    revisions: {
      specRevision: requiredManifestText(input.revisions.specRevision, 'revisions.specRevision'),
      storyRevision: requiredManifestText(input.revisions.storyRevision, 'revisions.storyRevision'),
    },
    executionMode: input.executionMode,
    execution: {
      agent: input.execution.agent,
      model: input.execution.model?.trim() || null,
      effort: input.execution.effort?.trim() || null,
      terminal: input.execution.terminal,
      worktree: {
        enabled: input.execution.worktree.enabled,
        path: input.execution.worktree.path?.trim() || null,
        branch: input.execution.worktree.branch?.trim() || null,
        baseRevision: requiredManifestText(input.execution.worktree.baseRevision, 'execution.worktree.baseRevision'),
      },
      merge: {
        enabled: input.execution.merge.enabled,
        strategy: input.execution.merge.strategy,
        targetBranch: input.execution.merge.targetBranch?.trim() || null,
      },
    },
    validationPlan,
    evidenceExpectations,
    repositoryProfile: {
      profileId: requiredManifestText(input.repositoryProfile.profileId, 'repositoryProfile.profileId'),
      changePolicy: input.repositoryProfile.changePolicy,
      noCodeReason: input.repositoryProfile.noCodeReason?.trim() || null,
      runtimeMetadataPaths: sortedUnique(input.repositoryProfile.runtimeMetadataPaths, 'repositoryProfile.runtimeMetadataPaths'),
    },
    commandSafety: {
      profileId: requiredManifestText(input.commandSafety.profileId, 'commandSafety.profileId'),
      guardVersion: requiredManifestText(input.commandSafety.guardVersion, 'commandSafety.guardVersion'),
      guardedWorkingDirectory,
      allowedWorkingDirectories: sortedUnique(input.commandSafety.allowedWorkingDirectories, 'commandSafety.allowedWorkingDirectories'),
      blockedCommandPatterns: sortedUnique(input.commandSafety.blockedCommandPatterns, 'commandSafety.blockedCommandPatterns'),
      redactedEnvironmentKeys: sortedUnique(input.commandSafety.redactedEnvironmentKeys, 'commandSafety.redactedEnvironmentKeys'),
      allowBackendJest: input.commandSafety.allowBackendJest,
      baselineFailurePolicy: input.commandSafety.baselineFailurePolicy,
    },
  };
}

export function deriveStoryExecutionManifestHash(
  manifest: StoryExecutionManifestInput | StoryExecutionManifest | ImmutableStoryExecutionManifest | Omit<StoryExecutionManifest, 'manifestHash'>,
): string {
  const normalized = 'schemaVersion' in manifest
    ? manifest
    : { schemaVersion: STORY_EXECUTION_MANIFEST_VERSION, ...normalizeManifestInput(manifest) };
  const { schemaVersion: _schemaVersion, manifestHash: _manifestHash, ...candidate } = normalized as unknown as StoryExecutionManifest;
  return sha256({ schemaVersion: STORY_EXECUTION_MANIFEST_VERSION, ...candidate });
}

/** Resolve only already-authorized policy/profile values into an immutable manifest. */
export function createStoryExecutionManifest(input: StoryExecutionManifestInput): ImmutableStoryExecutionManifest {
  const normalized = normalizeManifestInput(input);
  const withoutHash = { schemaVersion: STORY_EXECUTION_MANIFEST_VERSION, ...normalized };
  return deepFreeze({
    ...withoutHash,
    manifestHash: deriveStoryExecutionManifestHash(withoutHash),
  });
}

export function verifyStoryExecutionManifest(manifest: StoryExecutionManifest | ImmutableStoryExecutionManifest): boolean {
  if (manifest.schemaVersion !== STORY_EXECUTION_MANIFEST_VERSION) return false;
  try {
    return manifest.manifestHash === deriveStoryExecutionManifestHash(manifest);
  } catch {
    return false;
  }
}

/** Create a retry manifest without re-resolving or broadening any policy. */
export function deriveRetryStoryExecutionManifest(
  manifest: StoryExecutionManifest | ImmutableStoryExecutionManifest,
  attempt: number,
): ImmutableStoryExecutionManifest {
  if (!verifyStoryExecutionManifest(manifest)) throw new TypeError('Cannot retry a stale or invalid story execution manifest');
  const input: StoryExecutionManifestInput = {
    identity: { ...manifest.identity, attempt },
    revisions: { ...manifest.revisions },
    executionMode: manifest.executionMode,
    execution: {
      ...manifest.execution,
      worktree: { ...manifest.execution.worktree },
      merge: { ...manifest.execution.merge },
    },
    validationPlan: manifest.validationPlan.map((item) => ({ ...item, args: [...item.args] })),
    evidenceExpectations: manifest.evidenceExpectations.map((item) => ({
      ...item,
      requiredEvidenceKinds: [...item.requiredEvidenceKinds],
    })),
    repositoryProfile: {
      ...manifest.repositoryProfile,
      runtimeMetadataPaths: [...manifest.repositoryProfile.runtimeMetadataPaths],
    },
    commandSafety: {
      ...manifest.commandSafety,
      allowedWorkingDirectories: [...manifest.commandSafety.allowedWorkingDirectories],
      blockedCommandPatterns: [...manifest.commandSafety.blockedCommandPatterns],
      redactedEnvironmentKeys: [...manifest.commandSafety.redactedEnvironmentKeys],
    },
  };
  return createStoryExecutionManifest(input);
}

export type StoryManifestExecutionContext = DeepReadonly<{
  identity: StoryManifestIdentity;
  executionMode: StoryExecutionMode;
  execution: StoryManifestExecutionOptions;
  validationPlan: StoryValidationRequirement[];
  manifestHash: string;
}>;

/** Execution-safe subset for prompt/engine consumption; lifecycle policy stays opaque. */
export function getManifestExecutionContext(manifest: StoryExecutionManifest | ImmutableStoryExecutionManifest): StoryManifestExecutionContext {
  if (!verifyStoryExecutionManifest(manifest)) throw new TypeError('Cannot consume a stale or invalid story execution manifest');
  return deepFreeze({
    identity: { ...manifest.identity },
    executionMode: manifest.executionMode,
    execution: {
      ...manifest.execution,
      worktree: { ...manifest.execution.worktree },
      merge: { ...manifest.execution.merge },
    },
    validationPlan: manifest.validationPlan.map((requirement) => ({ ...requirement, args: [...requirement.args] })),
    manifestHash: manifest.manifestHash,
  });
}

const IMPLEMENTATION_VERB_PATTERN = /\b(add|build|create|fix|implement|patch|refactor|update|wire|persist|introduce|remove)\b/i;
const META_FIRST_PATTERN = /\b(investigate|analy(?:s|z)e|baseline|research|explore|review|audit|understand|document|plan|discover)\b/i;
const TEST_SIGNAL_PATTERN = /\b(test|spec|assert|snapshot|fixture|regression|jest|vitest|playwright|integration)\b/i;
const FILE_PATH_PATTERN = /(?:src|backend|frontend|lib|components|routes|hooks|panels|db|migrations|tests?|docs|\.pi\/extensions)\/[\w\-\/.]+\.[a-z]+/g;

function unique(items: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of items) {
    const value = typeof item === 'string' ? item.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

function getAcceptanceLines(story: ExecutionPacketStory): string[] {
  if (Array.isArray(story.acceptanceCriteria) && story.acceptanceCriteria.length > 0) {
    return story.acceptanceCriteria;
  }
  if (typeof story.acceptance === 'string' && story.acceptance.trim().length > 0) {
    return story.acceptance
      .split('\n')
      .map(line => line.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean);
  }
  return [];
}

function lowerStoryText(story: ExecutionPacketStory): string {
  return [story.title, story.description, ...getAcceptanceLines(story)].join('\n').toLowerCase();
}

function inferExpectedArtifacts(story: ExecutionPacketStory, candidateFiles: string[]): string[] {
  const text = lowerStoryText(story);
  const artifacts: string[] = [];

  if (TEST_SIGNAL_PATTERN.test(text)) artifacts.push('tests');
  if (/\bfixture\b/i.test(text)) artifacts.push('fixtures');
  if (/\b(route|endpoint|api)\b/i.test(text) || candidateFiles.some(file => file.includes('/routes/'))) artifacts.push('backend route changes');
  if (/\b(component|ui|panel|sidebar|slideover)\b/i.test(text) || candidateFiles.some(file => file.includes('/components/') || file.includes('/panels/'))) artifacts.push('UI changes');
  if (/\b(migration|sql|database|schema)\b/i.test(text) || candidateFiles.some(file => file.includes('/migrations') || file.includes('/db/'))) artifacts.push('database changes');
  if (/\b(doc|docs|readme|changelog|jsdoc)\b/i.test(text) || candidateFiles.some(file => /(^|\/)docs?\//i.test(file) || /readme/i.test(file))) artifacts.push('documentation updates');
  if (/\b(config|env|settings|tailwind|vite|package\.json)\b/i.test(text) || candidateFiles.some(file => /package\.json$|tailwind|vite|config/i.test(file))) artifacts.push('configuration changes');

  return unique(artifacts);
}

export function detectExecutionModeFromSpec(spec: { mode?: string; phases?: unknown }): StoryExecutionMode {
  if (spec.mode === 'journey') return 'journey';
  if (spec.mode === 'qa') return 'qa';
  if (Array.isArray(spec.phases) && spec.phases.length > 0) return 'qa';
  return 'impl';
}

export function extractExecutionCandidateFiles(story: ExecutionPacketStory): string[] {
  const text = [story.description ?? '', ...getAcceptanceLines(story)].join('\n');
  const matches = text.match(FILE_PATH_PATTERN) ?? [];
  const explicitFiles = Array.isArray(story.files)
    ? story.files.filter((file): file is string => typeof file === 'string' && file.trim().length > 0)
    : [];
  return unique([...explicitFiles, ...matches]);
}

function recommendFallbackEngine(
  story: ExecutionPacketStory,
  candidateFiles: string[],
  expectedArtifacts: string[],
): AgentType | null {
  const text = lowerStoryText(story);

  if (/\b(architect|architecture|research|explore|design system|core engine|cross-cutting)\b/i.test(text)) {
    return 'claude';
  }

  if (
    expectedArtifacts.some(artifact => artifact === 'tests' || artifact === 'fixtures' || artifact === 'backend route changes' || artifact === 'UI changes')
    || candidateFiles.length > 0
  ) {
    return 'codex';
  }

  return null;
}

export function assessStoryExecutionReadiness(
  story: ExecutionPacketStory,
  mode: StoryExecutionMode,
  candidateFiles: string[],
  candidateTests: string[],
  workspaceContext?: WorkspaceContextSignal,
): StoryExecutionReadiness {
  const text = lowerStoryText(story);
  const strengths: string[] = [];
  const warnings: string[] = [];
  let score = 0;

  if (candidateFiles.length > 0) {
    score += 25;
    strengths.push(`Names ${candidateFiles.length} likely file target${candidateFiles.length === 1 ? '' : 's'}.`);
  } else if (mode !== 'journey') {
    score -= 20;
    warnings.push('No concrete file targets were named.');
  }

  if (candidateTests.length > 0) {
    score += 15;
    strengths.push(`Suggests ${candidateTests.length} likely existing test target${candidateTests.length === 1 ? '' : 's'}.`);
  } else if (mode === 'qa' || TEST_SIGNAL_PATTERN.test(text)) {
    score -= 12;
    warnings.push('Test-oriented story lacks concrete test file targets.');
  }

  const acCount = getAcceptanceLines(story).length;
  if (acCount > 0) {
    score += Math.min(15, acCount * 5);
    strengths.push(`Defines ${acCount} acceptance criteria.`);
  } else {
    score -= 10;
    warnings.push('Story has no explicit acceptance criteria.');
  }

  if (IMPLEMENTATION_VERB_PATTERN.test(text)) {
    score += 10;
    strengths.push('Uses concrete implementation verbs.');
  }

  if (META_FIRST_PATTERN.test(text)) {
    score -= 20;
    warnings.push('Story reads like analysis/baseline work and may cause non-edit attempts.');
  }

  if ((story.description ?? '').trim().length < 60) {
    score -= 8;
    warnings.push('Story description is short on executable detail.');
  }

  const expectedArtifacts = inferExpectedArtifacts(story, candidateFiles);
  if (expectedArtifacts.length > 0) {
    score += 10;
    strengths.push(`Implies concrete outputs: ${expectedArtifacts.join(', ')}.`);
  } else if (mode !== 'journey') {
    score -= 8;
    warnings.push('Expected output artifacts are not obvious.');
  }

  // CTM-006: Fold the canonical workspace-context signal into readiness so a
  // context-blind workspace is flagged here instead of being re-derived ad hoc.
  if (workspaceContext) {
    const { richnessScore, contractSatisfied } = workspaceContext;
    if (contractSatisfied === true || (typeof richnessScore === 'number' && richnessScore >= 60)) {
      score += 8;
      strengths.push('Workspace carries rich routing context (stack, .rorca, governance).');
    } else if (contractSatisfied === false || (typeof richnessScore === 'number' && richnessScore < 30)) {
      score -= 8;
      warnings.push('Workspace is context blind — missing .rorca / AGENTS.md / MEMORY.md routing context.');
    }
  }

  score = Math.max(0, Math.min(100, score));
  const grade: StoryExecutionReadiness['grade'] = score >= 55 ? 'strong' : score >= 30 ? 'fair' : 'weak';

  return {
    score,
    grade,
    strengths: unique(strengths),
    warnings: unique(warnings),
    expectedArtifacts,
    recommendedFallbackEngine: recommendFallbackEngine(story, candidateFiles, expectedArtifacts),
  };
}

export function buildStoryExecutionPacket(
  cwd: string,
  story: ExecutionPacketStory,
  mode: StoryExecutionMode,
  workspaceContext?: WorkspaceContextSignal,
): StoryExecutionPacket {
  const candidateFiles = extractExecutionCandidateFiles(story);
  const candidateTests = inferPiCandidateTests(cwd, candidateFiles);
  const validationCommands = inferPiValidationCommands(cwd, mode);
  const doneChecklist = buildPiDoneChecklist(
    getAcceptanceLines(story).map(item => `- ${item}`).join('\n') || undefined,
    mode,
  );
  const readiness = assessStoryExecutionReadiness(story, mode, candidateFiles, candidateTests, workspaceContext);

  return {
    candidateFiles,
    candidateTests,
    validationCommands,
    doneChecklist,
    expectedArtifacts: readiness.expectedArtifacts,
    readiness,
  };
}

export function buildStoryExecutionManifestPromptSection(
  manifest: StoryExecutionManifest | ImmutableStoryExecutionManifest,
): string {
  const context = getManifestExecutionContext(manifest);
  const lines = [
    '## Canonical Story Execution Manifest',
    `Manifest: ${context.manifestHash}`,
    `Attempt: ${context.identity.attempt}`,
    `Mode: ${context.executionMode}`,
    `Agent: ${context.execution.agent}`,
    `Model: ${context.execution.model ?? 'provider default'}`,
    `Effort: ${context.execution.effort ?? 'default'}`,
    `Terminal: ${context.execution.terminal}`,
    `Working directory: ${context.execution.worktree.path ?? 'workspace root'}`,
    'These host-resolved execution values are authoritative. Do not infer broader permissions or lifecycle policy from story prose.',
    '',
    '### Required host validation plan',
  ];
  for (const requirement of context.validationPlan) {
    lines.push(`- ${requirement.id}: ${[requirement.command, ...requirement.args].join(' ')} (${requirement.commandHash})`);
  }
  return lines.join('\n');
}

export function buildExecutionPacketPromptSection(packet: StoryExecutionPacket): string {
  const lines = [
    '## Execution Packet',
    `Readiness: ${packet.readiness.grade.toUpperCase()} (${packet.readiness.score}/100)`,
    'Use this packet to drive concrete edits, tests, and validation instead of stopping at analysis.',
    '',
  ];

  if (packet.candidateFiles.length > 0) {
    lines.push('### Likely Files');
    for (const file of packet.candidateFiles) lines.push(`- ${file}`);
    lines.push('');
  }

  if (packet.candidateTests.length > 0) {
    lines.push('### Likely Tests');
    for (const file of packet.candidateTests) lines.push(`- ${file}`);
    lines.push('');
  }

  if (packet.expectedArtifacts.length > 0) {
    lines.push('### Expected Artifacts');
    for (const artifact of packet.expectedArtifacts) lines.push(`- ${artifact}`);
    lines.push('');
  }

  if (packet.validationCommands.length > 0) {
    lines.push('### Validation Commands');
    for (const command of packet.validationCommands) lines.push(`- ${command}`);
    lines.push('');
  }

  if (packet.readiness.warnings.length > 0) {
    lines.push('### Execution Risks To Counteract');
    for (const warning of packet.readiness.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  lines.push('### Anti-Noop Rule');
  lines.push('- Leave this turn with at least one meaningful tracked file change, or report a concrete blocker tied to a specific file/command.');

  return lines.join('\n');
}

export function buildNoopRecoveryPromptSection(
  storyId: string,
  packet: StoryExecutionPacket,
  attempt: number,
  maxAttempts: number,
): string {
  const lines = [
    '## Retry instruction',
    `A previous attempt for ${storyId} produced no meaningful implementation diff. This is retry ${attempt}/${maxAttempts}.`,
    'Do not stop after reading generic docs or summarizing the task.',
    'Open a concrete target file from the execution packet, make the smallest correct implementation change, then run the narrowest relevant validation.',
    'If you truly cannot change code, report the exact blocker and the specific file or command that proved it.',
  ];

  if (packet.candidateFiles.length > 0) {
    lines.push(`Concrete file targets: ${packet.candidateFiles.join(', ')}`);
  }
  if (packet.expectedArtifacts.length > 0) {
    lines.push(`Expected outputs: ${packet.expectedArtifacts.join(', ')}`);
  }
  if (packet.validationCommands.length > 0) {
    lines.push(`Validation focus: ${packet.validationCommands.slice(0, 3).join(' | ')}`);
  }

  return lines.join('\n');
}
