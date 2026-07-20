/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'crypto';

// This deterministic oracle is diagnostic only. It does not execute or attest
// production-like DB/WAL, Git, independent checker, canary/soak, or rollback evidence.
export const QUALIFICATION_MODEL_AUTHORITY = 'synthetic_diagnostic' as const;

export const QUALIFICATION_FAULT_POINTS = [
  'WPE-FP-001', 'WPE-FP-002', 'WPE-FP-003', 'WPE-FP-004', 'WPE-FP-005',
  'WPE-FP-006', 'WPE-FP-007', 'WPE-FP-008', 'WPE-FP-009',
] as const;

export type QualificationFaultPoint = typeof QUALIFICATION_FAULT_POINTS[number];
export type QualificationScenario =
  | 'success'
  | 'completion-order-forward'
  | 'completion-order-reverse'
  | 'completion-order-generated'
  | 'reject-before-commit'
  | 'reject-after-commit'
  | 'dirty-rejection'
  | 'sibling-success'
  | 'dependency-chain'
  | 'conflict'
  | 'cancellation'
  | 'timeout'
  | 'duplicate-queue-delivery'
  | 'restart'
  | 'retry'
  | `crash-${QualificationFaultPoint}`;

export const QUALIFICATION_SCENARIOS: readonly QualificationScenario[] = [
  'success',
  'completion-order-forward',
  'completion-order-reverse',
  'completion-order-generated',
  'reject-before-commit',
  'reject-after-commit',
  'dirty-rejection',
  'sibling-success',
  'dependency-chain',
  'conflict',
  'cancellation',
  'timeout',
  ...QUALIFICATION_FAULT_POINTS.map(point => `crash-${point}` as const),
  'duplicate-queue-delivery',
  'restart',
  'retry',
];

export type QualificationEntity = 'story' | 'attempt' | 'integration' | 'wave' | 'run';
export type StoryState = 'queued' | 'running' | 'awaiting_integration' | 'passed' | 'failed' | 'blocked' | 'cancelled' | 'timed_out' | 'recovery';
export type AttemptState = 'queued' | 'running' | 'committed' | 'validated' | 'integrated' | 'rejected' | 'failed' | 'cancelled' | 'timed_out' | 'crashed';
export type IntegrationState = 'pending' | 'preparing' | 'applied' | 'validated' | 'finalized' | 'rejected' | 'conflicted' | 'recovery';
export type WaveState = 'pending' | 'running' | 'integrating' | 'completed' | 'failed' | 'cancelled';
export type RunState = 'queued' | 'running' | 'closing' | 'succeeded' | 'failed' | 'cancelled';
export type QualificationState = StoryState | AttemptState | IntegrationState | WaveState | RunState;

export interface QualificationTransition {
  sequence: number;
  entity: QualificationEntity;
  id: string;
  from: QualificationState;
  to: QualificationState;
  faultPoint: QualificationFaultPoint;
}

export interface StoryTerminal {
  state: StoryState;
  dependencies: string[];
  blockedBy: string[];
  started: boolean;
  finalizationCount: number;
}

export interface ResourceInventory {
  processCount: number;
  fdCount: number;
  childProcesses: number;
  worktrees: number;
  temporaryRefs: number;
  successfulTemporaryBranches: number;
  queueJobs: number;
  leases: number;
  testRows: number;
  openGitOperations: number;
  artifacts: number;
}

export const QUALIFICATION_RESOURCE_KEYS = [
  'processCount', 'fdCount', 'childProcesses', 'worktrees', 'temporaryRefs',
  'successfulTemporaryBranches', 'queueJobs', 'leases', 'testRows',
  'openGitOperations', 'artifacts',
] as const satisfies readonly (keyof ResourceInventory)[];

export type PerformanceMetric =
  | 'dispatchLatencyMs'
  | 'mergeCloseoutLatencyMs'
  | 'peakMemoryMiB'
  | 'peakDiskMiB'
  | 'peakProcessCount'
  | 'peakOutputBacklogKiB'
  | 'queueLagMs'
  | 'leaseRenewalMs'
  | 'cleanupMs';

export interface PerformanceBudget {
  baseline: number;
  absoluteCap: number;
  baselineMultiplier: number;
}

export interface QualificationBudgetSet {
  schemaVersion: 1;
  baselineVersion: string;
  metrics: Record<PerformanceMetric, PerformanceBudget>;
}

export interface DatabaseOwnershipRow {
  kind: 'workspace' | 'spec' | 'run' | 'story_result' | 'wal_event' | 'lease' | 'integration_record' | 'queue_job';
  id: string;
  qualificationNamespace: string;
  ownershipMarker: string;
}

export interface QualificationDatabaseEvidence {
  rows: DatabaseOwnershipRow[];
  protectedSentinelBefore: string;
  protectedSentinelAfter: string;
}

export interface QualificationTerminalState {
  stories: Record<string, StoryTerminal>;
  attempts: Record<string, AttemptState>;
  integrations: Record<string, IntegrationState>;
  wave: WaveState;
  run: RunState;
}

export interface NormalizedQualificationEvidence {
  authority: typeof QUALIFICATION_MODEL_AUTHORITY;
  seed: string;
  scenario: QualificationScenario;
  parallelism: 2 | 4;
  finalSourceTree: string;
  commitTopology: string[];
  acceptedStorySet: string[];
  blockedDependencySet: string[];
  semanticCloseout: RunState;
  recoveryInventory: string[];
  eventTrace: QualificationTransition[];
}

export interface QualificationResult {
  schemaVersion: 1;
  authority: typeof QUALIFICATION_MODEL_AUTHORITY;
  namespace: string;
  seed: string;
  scenario: QualificationScenario;
  parallelism: 2 | 4;
  transitions: QualificationTransition[];
  terminal: QualificationTerminalState;
  normalized: NormalizedQualificationEvidence;
  resources: { baseline: ResourceInventory; samples: ResourceInventory[]; final: ResourceInventory };
  database: QualificationDatabaseEvidence;
  queueDeliveryEvidence: { delivered: number; claimed: number; duplicateSuppressed: number };
  performance: Record<PerformanceMetric, number>;
}

const INITIAL_STATE: Record<QualificationEntity, QualificationState> = {
  story: 'queued',
  attempt: 'queued',
  integration: 'pending',
  wave: 'pending',
  run: 'queued',
};

const ALLOWED_TRANSITIONS: Record<QualificationEntity, Readonly<Record<string, readonly QualificationState[]>>> = {
  story: {
    queued: ['running', 'blocked', 'cancelled', 'recovery'],
    running: ['awaiting_integration', 'failed', 'cancelled', 'timed_out', 'recovery'],
    awaiting_integration: ['passed', 'failed', 'recovery'],
    failed: ['running'],
    recovery: ['running', 'failed'],
  },
  attempt: {
    queued: ['running'],
    running: ['committed', 'rejected', 'failed', 'cancelled', 'timed_out', 'crashed'],
    committed: ['validated', 'rejected', 'crashed'],
    validated: ['integrated', 'rejected', 'crashed'],
  },
  integration: {
    pending: ['preparing', 'rejected', 'recovery'],
    preparing: ['applied', 'conflicted', 'rejected', 'recovery'],
    applied: ['validated', 'recovery'],
    validated: ['finalized', 'recovery'],
  },
  wave: {
    pending: ['running'],
    running: ['integrating', 'failed', 'cancelled'],
    integrating: ['completed', 'failed', 'cancelled'],
  },
  run: {
    queued: ['running'],
    running: ['closing', 'failed', 'cancelled'],
    closing: ['succeeded', 'failed', 'cancelled'],
  },
};

const TERMINAL_STATES: Record<QualificationEntity, ReadonlySet<QualificationState>> = {
  story: new Set<StoryState>(['passed', 'failed', 'blocked', 'cancelled', 'timed_out', 'recovery']),
  attempt: new Set<AttemptState>(['integrated', 'rejected', 'failed', 'cancelled', 'timed_out', 'crashed']),
  integration: new Set<IntegrationState>(['finalized', 'rejected', 'conflicted', 'recovery']),
  wave: new Set<WaveState>(['completed', 'failed', 'cancelled']),
  run: new Set<RunState>(['succeeded', 'failed', 'cancelled']),
};

const DB_KINDS: readonly DatabaseOwnershipRow['kind'][] = [
  'workspace', 'spec', 'run', 'story_result', 'wal_event', 'lease', 'integration_record', 'queue_job',
];

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function namespaceFor(seed: string, scenario: string, parallelism: number): string {
  return `qrun_${hash([seed, scenario, parallelism]).slice(0, 24)}`;
}

function seededRandom(seed: string): () => number {
  let state = Number.parseInt(hash(seed).slice(0, 8), 16) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function deterministicOrder<T>(items: readonly T[], seed: string): T[] {
  const random = seededRandom(seed);
  return items.map(item => ({ item, rank: random() }))
    .sort((left, right) => left.rank - right.rank)
    .map(({ item }) => item);
}

function emptyInventory(processCount: number, fdCount: number): ResourceInventory {
  return {
    processCount,
    fdCount,
    childProcesses: 0,
    worktrees: 0,
    temporaryRefs: 0,
    successfulTemporaryBranches: 0,
    queueJobs: 0,
    leases: 0,
    testRows: 0,
    openGitOperations: 0,
    artifacts: 0,
  };
}

function scenarioFaultPoint(scenario: QualificationScenario): QualificationFaultPoint {
  if (scenario.startsWith('crash-')) return scenario.slice('crash-'.length) as QualificationFaultPoint;
  if (scenario === 'conflict') return 'WPE-FP-006';
  if (scenario === 'restart') return 'WPE-FP-008';
  if (scenario === 'reject-before-commit' || scenario === 'cancellation' || scenario === 'timeout') return 'WPE-FP-002';
  if (scenario === 'reject-after-commit' || scenario === 'dirty-rejection' || scenario === 'sibling-success' || scenario === 'retry') return 'WPE-FP-004';
  return 'WPE-FP-009';
}

interface MutableModel {
  states: Record<QualificationEntity, Map<string, QualificationState>>;
  transitions: QualificationTransition[];
  stories: Record<string, StoryTerminal>;
  attempts: Record<string, AttemptState>;
  integrations: Record<string, IntegrationState>;
  accepted: Set<string>;
  recovery: Set<string>;
  commitTopology: string[];
  wave: WaveState;
  run: RunState;
}

function createModel(storyDependencies: Record<string, string[]>): MutableModel {
  const stories = Object.fromEntries(Object.entries(storyDependencies).map(([id, dependencies]) => [id, {
    state: 'queued' as StoryState,
    dependencies: [...dependencies],
    blockedBy: [],
    started: false,
    finalizationCount: 0,
  }]));
  return {
    states: {
      story: new Map(), attempt: new Map(), integration: new Map(), wave: new Map(), run: new Map(),
    },
    transitions: [], stories, attempts: {}, integrations: {}, accepted: new Set(), recovery: new Set(),
    commitTopology: [], wave: 'pending', run: 'queued',
  };
}

function transition(
  model: MutableModel,
  entity: QualificationEntity,
  id: string,
  to: QualificationState,
  faultPoint: QualificationFaultPoint,
): void {
  const from = model.states[entity].get(id) ?? INITIAL_STATE[entity];
  const allowed = ALLOWED_TRANSITIONS[entity][from] ?? [];
  if (!allowed.includes(to)) throw new Error(`[wave-qualification-model] illegal ${entity} transition ${from} -> ${to}`);
  model.states[entity].set(id, to);
  model.transitions.push({ sequence: model.transitions.length + 1, entity, id, from, to, faultPoint });
  if (entity === 'story') model.stories[id].state = to as StoryState;
  if (entity === 'attempt') model.attempts[id] = to as AttemptState;
  if (entity === 'integration') model.integrations[id] = to as IntegrationState;
  if (entity === 'wave') model.wave = to as WaveState;
  if (entity === 'run') model.run = to as RunState;
}

function startStory(model: MutableModel, storyId: string, attempt: number, faultPoint: QualificationFaultPoint): string {
  const attemptId = `${storyId}#${attempt}`;
  transition(model, 'story', storyId, 'running', faultPoint);
  model.stories[storyId].started = true;
  transition(model, 'attempt', attemptId, 'running', faultPoint);
  return attemptId;
}

function acceptStory(model: MutableModel, storyId: string, attemptId: string): void {
  transition(model, 'attempt', attemptId, 'committed', 'WPE-FP-003');
  transition(model, 'attempt', attemptId, 'validated', 'WPE-FP-004');
  transition(model, 'story', storyId, 'awaiting_integration', 'WPE-FP-005');
  transition(model, 'integration', attemptId, 'preparing', 'WPE-FP-005');
  transition(model, 'integration', attemptId, 'applied', 'WPE-FP-006');
  transition(model, 'integration', attemptId, 'validated', 'WPE-FP-007');
  transition(model, 'attempt', attemptId, 'integrated', 'WPE-FP-007');
  transition(model, 'integration', attemptId, 'finalized', 'WPE-FP-008');
  model.stories[storyId].finalizationCount += 1;
  transition(model, 'story', storyId, 'passed', 'WPE-FP-009');
  model.accepted.add(storyId);
  model.commitTopology.push(`${storyId}:${hash(attemptId).slice(0, 12)}`);
}

function rejectStory(model: MutableModel, storyId: string, attemptId: string, afterCommit: boolean): void {
  if (afterCommit) transition(model, 'attempt', attemptId, 'committed', 'WPE-FP-003');
  transition(model, 'attempt', attemptId, 'rejected', 'WPE-FP-004');
  transition(model, 'story', storyId, 'failed', 'WPE-FP-004');
  if (afterCommit) model.recovery.add(`refs/qualification-recovery/${storyId}/${hash(attemptId).slice(0, 12)}`);
}

function blockFailedDependents(model: MutableModel): void {
  for (const [storyId, story] of Object.entries(model.stories)) {
    if (story.state !== 'queued') continue;
    const blockedBy = story.dependencies.filter(id => model.stories[id]?.state !== 'passed');
    if (blockedBy.length > 0) {
      story.blockedBy = blockedBy.sort();
      transition(model, 'story', storyId, 'blocked', 'WPE-FP-009');
    }
  }
}

function closeModel(model: MutableModel, cancelled = false): void {
  const failed = Object.values(model.stories).some(story => story.state !== 'passed');
  const waveTarget: WaveState = cancelled ? 'cancelled' : failed ? 'failed' : 'completed';
  if (model.wave === 'running') transition(model, 'wave', 'wave-0', failed || cancelled ? waveTarget : 'integrating', 'WPE-FP-005');
  if (model.wave === 'integrating') transition(model, 'wave', 'wave-0', waveTarget, 'WPE-FP-009');
  if (model.run === 'running') transition(model, 'run', 'run', cancelled ? 'cancelled' : 'closing', 'WPE-FP-009');
  if (model.run === 'closing') transition(model, 'run', 'run', failed ? 'failed' : 'succeeded', 'WPE-FP-009');
}

function dependenciesFor(scenario: QualificationScenario): Record<string, string[]> {
  if (scenario === 'dependency-chain') return { 'story-a': [], 'story-b': ['story-a'], 'story-c': ['story-b'] };
  if (scenario === 'conflict') return { 'story-a': [], 'story-b': [], 'story-c': ['story-b'] };
  if (scenario === 'sibling-success') return { 'story-a': [], 'story-b': [], 'story-c': ['story-a'] };
  if (scenario.startsWith('completion-order') || scenario === 'success' || scenario === 'duplicate-queue-delivery') {
    return { 'story-a': [], 'story-b': [], 'story-c': [], 'story-d': [] };
  }
  return { 'story-a': [] };
}

function runScenario(seed: string, scenario: QualificationScenario): MutableModel {
  const model = createModel(dependenciesFor(scenario));
  transition(model, 'run', 'run', 'running', 'WPE-FP-001');
  transition(model, 'wave', 'wave-0', 'running', 'WPE-FP-001');

  const allStoryIds = Object.keys(model.stories);
  if (scenario === 'dependency-chain') {
    for (const storyId of allStoryIds) acceptStory(model, storyId, startStory(model, storyId, 1, 'WPE-FP-002'));
  } else if (scenario === 'sibling-success') {
    const rejected = startStory(model, 'story-a', 1, 'WPE-FP-002');
    const sibling = startStory(model, 'story-b', 1, 'WPE-FP-002');
    rejectStory(model, 'story-a', rejected, true);
    acceptStory(model, 'story-b', sibling);
    blockFailedDependents(model);
  } else if (scenario === 'conflict') {
    acceptStory(model, 'story-a', startStory(model, 'story-a', 1, 'WPE-FP-002'));
    const conflicting = startStory(model, 'story-b', 1, 'WPE-FP-002');
    transition(model, 'attempt', conflicting, 'committed', 'WPE-FP-003');
    transition(model, 'attempt', conflicting, 'validated', 'WPE-FP-004');
    transition(model, 'story', 'story-b', 'awaiting_integration', 'WPE-FP-005');
    transition(model, 'integration', conflicting, 'preparing', 'WPE-FP-005');
    transition(model, 'integration', conflicting, 'conflicted', 'WPE-FP-006');
    transition(model, 'attempt', conflicting, 'rejected', 'WPE-FP-006');
    transition(model, 'story', 'story-b', 'failed', 'WPE-FP-006');
    model.recovery.add(`refs/qualification-recovery/story-b/${hash(conflicting).slice(0, 12)}`);
    blockFailedDependents(model);
  } else if (scenario === 'reject-before-commit') {
    rejectStory(model, 'story-a', startStory(model, 'story-a', 1, 'WPE-FP-002'), false);
  } else if (scenario === 'reject-after-commit' || scenario === 'dirty-rejection') {
    rejectStory(model, 'story-a', startStory(model, 'story-a', 1, 'WPE-FP-002'), true);
  } else if (scenario === 'cancellation') {
    const attempt = startStory(model, 'story-a', 1, 'WPE-FP-002');
    transition(model, 'attempt', attempt, 'cancelled', 'WPE-FP-002');
    transition(model, 'story', 'story-a', 'cancelled', 'WPE-FP-002');
  } else if (scenario === 'timeout') {
    const attempt = startStory(model, 'story-a', 1, 'WPE-FP-002');
    transition(model, 'attempt', attempt, 'timed_out', 'WPE-FP-002');
    transition(model, 'story', 'story-a', 'timed_out', 'WPE-FP-002');
  } else if (scenario.startsWith('crash-')) {
    const point = scenarioFaultPoint(scenario);
    if (point === 'WPE-FP-001') {
      // Queue-claim crash is intentionally before child/attempt creation.
      transition(model, 'story', 'story-a', 'recovery', point);
    } else {
      const attempt = startStory(model, 'story-a', 1, point);
      if (['WPE-FP-003', 'WPE-FP-004', 'WPE-FP-005', 'WPE-FP-006', 'WPE-FP-007', 'WPE-FP-008', 'WPE-FP-009'].includes(point)) {
        transition(model, 'attempt', attempt, 'committed', 'WPE-FP-003');
      }
      if (['WPE-FP-005', 'WPE-FP-006', 'WPE-FP-007', 'WPE-FP-008', 'WPE-FP-009'].includes(point)) {
        transition(model, 'attempt', attempt, 'validated', 'WPE-FP-004');
        transition(model, 'story', 'story-a', 'awaiting_integration', 'WPE-FP-005');
      }
      if (['WPE-FP-006', 'WPE-FP-007', 'WPE-FP-008', 'WPE-FP-009'].includes(point)) transition(model, 'integration', attempt, 'preparing', 'WPE-FP-005');
      if (['WPE-FP-007', 'WPE-FP-008', 'WPE-FP-009'].includes(point)) transition(model, 'integration', attempt, 'applied', 'WPE-FP-006');
      if (['WPE-FP-008', 'WPE-FP-009'].includes(point)) transition(model, 'integration', attempt, 'validated', 'WPE-FP-007');
      if (point === 'WPE-FP-009') transition(model, 'attempt', attempt, 'integrated', 'WPE-FP-007');
      const attemptState = model.attempts[attempt];
      if (!TERMINAL_STATES.attempt.has(attemptState)) transition(model, 'attempt', attempt, 'crashed', point);
      if (model.integrations[attempt] && !TERMINAL_STATES.integration.has(model.integrations[attempt])) {
        transition(model, 'integration', attempt, 'recovery', point);
      }
      transition(model, 'story', 'story-a', 'recovery', point);
    }
    model.recovery.add(`refs/qualification-recovery/story-a/${point.toLowerCase()}`);
  } else if (scenario === 'restart') {
    const first = startStory(model, 'story-a', 1, 'WPE-FP-002');
    transition(model, 'attempt', first, 'committed', 'WPE-FP-003');
    transition(model, 'attempt', first, 'crashed', 'WPE-FP-008');
    transition(model, 'story', 'story-a', 'recovery', 'WPE-FP-008');
    transition(model, 'story', 'story-a', 'running', 'WPE-FP-008');
    const second = 'story-a#2';
    transition(model, 'attempt', second, 'running', 'WPE-FP-008');
    acceptStory(model, 'story-a', second);
  } else if (scenario === 'retry') {
    const first = startStory(model, 'story-a', 1, 'WPE-FP-002');
    transition(model, 'attempt', first, 'rejected', 'WPE-FP-004');
    transition(model, 'story', 'story-a', 'failed', 'WPE-FP-004');
    // Retry is an explicit new attempt and story transition, never a hidden qualification rerun.
    acceptStory(model, 'story-a', startStory(model, 'story-a', 2, 'WPE-FP-002'));
  } else {
    let order = allStoryIds;
    if (scenario === 'completion-order-reverse') order = [...allStoryIds].reverse();
    if (scenario === 'completion-order-generated') order = deterministicOrder(allStoryIds, seed);
    for (const storyId of order) acceptStory(model, storyId, startStory(model, storyId, 1, 'WPE-FP-002'));
  }

  closeModel(model, scenario === 'cancellation');
  return model;
}

function databaseEvidence(namespace: string): QualificationDatabaseEvidence {
  const ownershipMarker = `rorca-qualification-owned:${namespace}`;
  const rows = DB_KINDS.map(kind => ({
    kind,
    id: `${namespace}:${kind}:1`,
    qualificationNamespace: namespace,
    ownershipMarker,
  }));
  const protectedSentinel = hash(['protected-production-sentinels', 'version-1']);
  return { rows, protectedSentinelBefore: protectedSentinel, protectedSentinelAfter: protectedSentinel };
}

function performanceEvidence(seed: string, scenario: string, parallelism: number): Record<PerformanceMetric, number> {
  const random = seededRandom(`${seed}:${scenario}:${parallelism}:performance`);
  const bounded = (minimum: number, range: number) => Math.round((minimum + random() * range) * 100) / 100;
  return {
    dispatchLatencyMs: bounded(1, 8),
    mergeCloseoutLatencyMs: bounded(2, 15),
    peakMemoryMiB: bounded(32, 32),
    peakDiskMiB: bounded(4, 8),
    peakProcessCount: parallelism + 2,
    peakOutputBacklogKiB: bounded(1, 8),
    queueLagMs: bounded(1, 10),
    leaseRenewalMs: bounded(2, 8),
    cleanupMs: bounded(2, 12),
  };
}

export function runQualificationSchedule(input: {
  seed: string;
  scenario: QualificationScenario;
  parallelism: 2 | 4;
}): QualificationResult {
  if (!input.seed || input.seed.length > 128) throw new Error('[wave-qualification-model] seed must contain 1..128 characters');
  if (!QUALIFICATION_SCENARIOS.includes(input.scenario)) throw new Error('[wave-qualification-model] unknown scenario');
  const model = runScenario(input.seed, input.scenario);
  const namespace = namespaceFor(input.seed, input.scenario, input.parallelism);
  const processBaseline = 40 + Number.parseInt(hash(input.seed).slice(0, 2), 16) % 20;
  const fdBaseline = 80 + Number.parseInt(hash(input.scenario).slice(0, 2), 16) % 40;
  const baseline = emptyInventory(processBaseline, fdBaseline);
  const peak = {
    ...baseline,
    processCount: baseline.processCount + input.parallelism,
    fdCount: baseline.fdCount + input.parallelism * 3,
    childProcesses: input.parallelism,
    worktrees: input.parallelism,
    temporaryRefs: input.parallelism,
    successfulTemporaryBranches: input.parallelism,
    queueJobs: input.parallelism,
    leases: input.parallelism,
    testRows: DB_KINDS.length,
    openGitOperations: 1,
    artifacts: model.recovery.size,
  };
  const terminal: QualificationTerminalState = {
    stories: model.stories,
    attempts: model.attempts,
    integrations: model.integrations,
    wave: model.wave,
    run: model.run,
  };
  const acceptedStorySet = [...model.accepted].sort();
  const blockedDependencySet = Object.entries(model.stories)
    .filter(([, story]) => story.state === 'blocked')
    .map(([id, story]) => `${id}<-${story.blockedBy.join('+')}`)
    .sort();
  const canonicalTopology = [...model.commitTopology].sort();
  const normalized: NormalizedQualificationEvidence = {
    authority: QUALIFICATION_MODEL_AUTHORITY,
    seed: input.seed,
    scenario: input.scenario,
    parallelism: input.parallelism,
    finalSourceTree: hash(canonicalTopology),
    commitTopology: canonicalTopology,
    acceptedStorySet,
    blockedDependencySet,
    semanticCloseout: model.run,
    recoveryInventory: [...model.recovery].sort(),
    eventTrace: model.transitions.map(item => ({ ...item })),
  };
  const claimedQueueJobs = Object.values(model.stories).filter(story => story.started).length
    + (input.scenario === 'crash-WPE-FP-001' ? 1 : 0);
  const result: QualificationResult = {
    schemaVersion: 1,
    authority: QUALIFICATION_MODEL_AUTHORITY,
    namespace,
    ...input,
    transitions: model.transitions,
    terminal,
    normalized,
    resources: { baseline, samples: [baseline, peak, baseline], final: { ...baseline } },
    database: databaseEvidence(namespace),
    queueDeliveryEvidence: input.scenario === 'duplicate-queue-delivery'
      ? { delivered: claimedQueueJobs * 2, claimed: claimedQueueJobs, duplicateSuppressed: claimedQueueJobs }
      : { delivered: claimedQueueJobs, claimed: claimedQueueJobs, duplicateSuppressed: 0 },
    performance: performanceEvidence(input.seed, input.scenario, input.parallelism),
  };
  assertQualificationResult(result);
  return result;
}

export function assertDatabaseOwnership(result: QualificationResult): void {
  const marker = `rorca-qualification-owned:${result.namespace}`;
  if (result.database.rows.length !== DB_KINDS.length) throw new Error('[wave-qualification-model] database resource inventory is incomplete');
  const observedKinds = new Set<DatabaseOwnershipRow['kind']>();
  for (const row of result.database.rows) {
    if (row.qualificationNamespace !== result.namespace || row.ownershipMarker !== marker || !row.id.startsWith(`${result.namespace}:`)) {
      throw new Error('[wave-qualification-model] database row escaped qualification namespace');
    }
    if (observedKinds.has(row.kind)) throw new Error('[wave-qualification-model] duplicate database resource ownership proof');
    observedKinds.add(row.kind);
  }
  if (DB_KINDS.some(kind => !observedKinds.has(kind))) throw new Error('[wave-qualification-model] database resource kind is missing');
  if (result.database.protectedSentinelBefore !== result.database.protectedSentinelAfter) {
    throw new Error('[wave-qualification-model] protected production sentinel changed');
  }
}

export function assertPerformanceBudgets(result: QualificationResult, budgets: QualificationBudgetSet): void {
  if (budgets.schemaVersion !== 1 || !/^wave-stress-v\d+$/.test(budgets.baselineVersion)) {
    throw new Error('[wave-qualification-model] performance baseline is not versioned');
  }
  for (const [metric, observed] of Object.entries(result.performance) as [PerformanceMetric, number][]) {
    const budget = budgets.metrics[metric];
    if (!budget || budget.baseline <= 0 || budget.absoluteCap <= 0 || budget.baselineMultiplier < 1) {
      throw new Error(`[wave-qualification-model] invalid performance budget for ${metric}`);
    }
    const cap = Math.min(budget.absoluteCap, budget.baseline * budget.baselineMultiplier);
    if (observed > cap) throw new Error(`[wave-qualification-model] ${metric} ${observed} exceeded checked cap ${cap}`);
  }
}

export function assertLeakFree(result: QualificationResult): void {
  const exactZero: readonly (keyof ResourceInventory)[] = [
    'childProcesses', 'worktrees', 'temporaryRefs', 'successfulTemporaryBranches', 'queueJobs',
    'leases', 'testRows', 'openGitOperations', 'artifacts',
  ];
  for (const key of exactZero) {
    if (result.resources.final[key] !== 0) throw new Error(`[wave-qualification-model] leaked ${key}`);
  }
  for (const key of ['processCount', 'fdCount'] as const) {
    if (result.resources.final[key] > result.resources.baseline[key]) {
      throw new Error(`[wave-qualification-model] monotonic ${key} growth`);
    }
  }
}

export function assertRepeatedRunLeakSentinel(results: readonly QualificationResult[]): void {
  if (results.length < 2) throw new Error('[wave-qualification-model] leak sentinel requires repeated runs');
  for (const result of results) assertLeakFree(result);
  for (const key of QUALIFICATION_RESOURCE_KEYS) {
    const deltas = results.map(result => result.resources.final[key] - result.resources.baseline[key]);
    if (deltas.every((delta, index) => index === 0 || delta > deltas[index - 1])) {
      throw new Error(`[wave-qualification-model] repeated-run monotonic growth in ${key}`);
    }
  }
}

export function assertQualificationResult(result: QualificationResult): void {
  if (result.authority !== QUALIFICATION_MODEL_AUTHORITY || result.normalized.authority !== QUALIFICATION_MODEL_AUTHORITY) {
    throw new Error('[wave-qualification-model] synthetic diagnostic authority is required');
  }
  const current: Record<QualificationEntity, Map<string, QualificationState>> = {
    story: new Map(), attempt: new Map(), integration: new Map(), wave: new Map(), run: new Map(),
  };
  for (const [index, observed] of result.transitions.entries()) {
    if (observed.sequence !== index + 1) throw new Error('[wave-qualification-model] event sequence diverged');
    const expectedFrom = current[observed.entity].get(observed.id) ?? INITIAL_STATE[observed.entity];
    if (observed.from !== expectedFrom) throw new Error('[wave-qualification-model] observed transition source diverged from reference model');
    if (!(ALLOWED_TRANSITIONS[observed.entity][observed.from] ?? []).includes(observed.to)) {
      throw new Error(`[wave-qualification-model] observed illegal ${observed.entity} transition`);
    }
    current[observed.entity].set(observed.id, observed.to);
  }

  for (const [storyId, story] of Object.entries(result.terminal.stories)) {
    if (current.story.get(storyId) !== story.state) throw new Error('[wave-qualification-model] story terminal state diverged');
    if (story.state === 'passed') {
      const integrations = Object.entries(result.terminal.integrations).filter(([id]) => id.startsWith(`${storyId}#`));
      if (story.finalizationCount !== 1 || integrations.filter(([, state]) => state === 'finalized').length !== 1) {
        throw new Error('[wave-qualification-model] pass before exactly-once integration');
      }
    }
    if (story.state === 'blocked') {
      if (story.started || story.blockedBy.length === 0 || story.blockedBy.some(id => result.terminal.stories[id]?.state === 'passed')) {
        throw new Error('[wave-qualification-model] missing dependency blocking');
      }
    }
    if (story.finalizationCount > 1) throw new Error('[wave-qualification-model] duplicate finalization');
  }
  for (const [attemptId, state] of Object.entries(result.terminal.attempts)) {
    if (current.attempt.get(attemptId) !== state || !TERMINAL_STATES.attempt.has(state)) {
      throw new Error('[wave-qualification-model] attempt terminal state diverged');
    }
  }
  for (const [integrationId, state] of Object.entries(result.terminal.integrations)) {
    if (current.integration.get(integrationId) !== state || !TERMINAL_STATES.integration.has(state)) {
      throw new Error('[wave-qualification-model] integration terminal state diverged');
    }
  }
  if (current.wave.get('wave-0') !== result.terminal.wave || current.run.get('run') !== result.terminal.run) {
    throw new Error('[wave-qualification-model] wave or run terminal state diverged');
  }
  const allPassed = Object.values(result.terminal.stories).every(story => story.state === 'passed');
  if ((result.terminal.run === 'succeeded') !== allPassed || result.normalized.semanticCloseout !== result.terminal.run) {
    throw new Error('[wave-qualification-model] false successful closeout');
  }
  const accepted = Object.entries(result.terminal.stories).filter(([, story]) => story.state === 'passed').map(([id]) => id).sort();
  if (JSON.stringify(accepted) !== JSON.stringify(result.normalized.acceptedStorySet)) {
    throw new Error('[wave-qualification-model] accepted story set diverged');
  }
  const blocked = Object.entries(result.terminal.stories)
    .filter(([, story]) => story.state === 'blocked')
    .map(([id, story]) => `${id}<-${story.blockedBy.join('+')}`)
    .sort();
  if (JSON.stringify(blocked) !== JSON.stringify(result.normalized.blockedDependencySet)) {
    throw new Error('[wave-qualification-model] blocked dependency set diverged');
  }
  if (result.normalized.finalSourceTree !== hash(result.normalized.commitTopology)) {
    throw new Error('[wave-qualification-model] normalized source tree diverged from commit topology');
  }
  const delivery = result.queueDeliveryEvidence;
  const expectedClaims = Object.values(result.terminal.stories).filter(story => story.started).length
    + (result.scenario === 'crash-WPE-FP-001' ? 1 : 0);
  if (delivery.delivered !== delivery.claimed + delivery.duplicateSuppressed || delivery.claimed !== expectedClaims) {
    throw new Error('[wave-qualification-model] duplicate queue delivery was not claimed exactly once');
  }
  if (result.scenario === 'duplicate-queue-delivery' && delivery.duplicateSuppressed <= 0) {
    throw new Error('[wave-qualification-model] duplicate queue delivery evidence is missing');
  }
  if (JSON.stringify(result.transitions) !== JSON.stringify(result.normalized.eventTrace)) {
    throw new Error('[wave-qualification-model] normalized event trace diverged');
  }
  assertLeakFree(result);
  assertDatabaseOwnership(result);
}

export function buildQualificationFailureDiagnostic(result: QualificationResult, faultPoint = scenarioFaultPoint(result.scenario)): Record<string, unknown> {
  return {
    schemaVersion: 1,
    seed: result.seed,
    scenario: result.scenario,
    parallelism: result.parallelism,
    faultPoint,
    normalizedEventTrace: result.normalized.eventTrace,
    repositoryBundle: {
      kind: 'safe-recovery-references',
      references: result.normalized.recoveryInventory,
    },
    resourceSamples: result.resources.samples,
    rerunCommand: `npm run qualify:wave:diagnostic -- --seed=${result.seed} --scenario=${result.scenario} --parallelism=${result.parallelism}`,
  };
}
