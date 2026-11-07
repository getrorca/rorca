/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  assertNonEmptyExactIdentity,
  boundedRedactedObservation,
  governedOperationsHash,
  requireExactHash,
  type Sha256,
} from './governed-operations-primitives';

export const DOCTOR_TRANSITIONS = [
  'detect', 'classify', 'propose', 'authority', 'execute', 'verify', 'outcome', 'escalate',
] as const;
export type DoctorTransitionName = typeof DOCTOR_TRANSITIONS[number];
export type DoctorCondition = 'healthy' | 'drifted' | 'missing' | 'stale' | 'indeterminate';
export type DoctorSeverity = 'info' | 'warning' | 'error' | 'critical';
export type DoctorCapability = 'observe' | 'rebuild_projection' | 'fence_ephemeral_state';
export type DoctorMutationClass = 'rebuildable_projection' | 'fenced_ephemeral_runtime_state';
export type DoctorObserveOnlyClass =
  | 'canonical_mission' | 'canonical_spec' | 'canonical_evidence' | 'canonical_closeout'
  | 'canonical_lifecycle' | 'human_decision' | 'immutable_artifact';
export type DoctorSubjectClass = DoctorMutationClass | DoctorObserveOnlyClass;
export type DoctorOutcome = 'healthy' | 'fixed' | 'dry_run' | 'observe_only' | 'compensated' | 'indeterminate' | 'quarantined';

export interface DoctorEvidenceDefinition {
  sourceId: string;
  sourceRevision: string;
  maximumAgeMs: number;
}

export interface DoctorConditionDefinition {
  condition: DoctorCondition;
  predicateId: string;
  predicateRevision: string;
}

export interface DoctorCheckDefinition {
  schemaVersion: 'rorca.governed-doctor-check.v1';
  checkId: string;
  workspaceId: string;
  subjectId: string;
  subjectRevision: string;
  subjectClass: DoctorSubjectClass;
  severity: DoctorSeverity;
  capability: DoctorCapability;
  evidence: DoctorEvidenceDefinition;
  precondition: DoctorConditionDefinition;
  postcondition: DoctorConditionDefinition;
  definitionHash: Sha256;
}

export interface DoctorMutationBounds {
  maximumAttempts: number;
  wallClockMs: number;
  providerCostMicros: number;
  resourceUnits: number;
  rateLimitPerMinute: number;
  cooldownMs: number;
}

export interface DoctorFixDefinition {
  schemaVersion: 'rorca.governed-doctor-fix.v1';
  fixId: string;
  checkId: string;
  workspaceId: string;
  subjectId: string;
  subjectRevision: string;
  mutationClass: DoctorMutationClass;
  capability: Exclude<DoctorCapability, 'observe'>;
  precondition: DoctorConditionDefinition;
  postcondition: DoctorConditionDefinition;
  compensationId: string;
  safeNextAction: string;
  bounds: DoctorMutationBounds;
  definitionHash: Sha256;
}

export interface DoctorObservation {
  sourceId: string;
  sourceRevision: string;
  observedAt: string;
  condition: DoctorCondition;
  evidenceHash: Sha256;
  summary: string;
}

export interface DoctorPreview {
  schemaVersion: 'rorca.governed-doctor-preview.v1';
  previewId: string;
  workspaceId: string;
  subjectId: string;
  subjectRevision: string;
  checkDefinitionHash: Sha256;
  fixDefinitionHash: Sha256 | null;
  requestHash: Sha256;
  fence: number;
  expiresAt: string;
  dryRun: true;
  previewHash: Sha256;
}

export interface DoctorInvocationInput {
  invocationId: string;
  idempotencyKey: string;
  workspaceId: string;
  subjectId: string;
  subjectRevision: string;
  check: DoctorCheckDefinition;
  fix?: DoctorFixDefinition;
  preview: DoctorPreview;
  apply?: boolean;
  fence: number;
  requestedAt: string;
  expectedProviderCostMicros: number;
  expectedResourceUnits: number;
}

export interface DoctorTransition {
  sequence: number;
  transition: DoctorTransitionName;
  status: 'recorded' | 'permitted' | 'denied' | 'skipped' | 'verified' | 'failed';
  observationHash: Sha256;
  recordedAt: string;
  detail: string;
}

export interface DoctorInvocationResult {
  invocationId: string;
  workspaceId: string;
  subjectId: string;
  subjectRevision: string;
  requestHash: Sha256;
  transitions: readonly DoctorTransition[];
  outcome: DoctorOutcome;
  mutated: boolean;
  compensated: boolean;
  quarantined: boolean;
  escalation: null | { reasonCode: string; safeNextAction: string; detail: string };
  resultHash: Sha256;
}

export interface DoctorExecutionReceipt {
  executorSourceId: string;
  status: 'applied' | 'failed' | 'indeterminate';
  providerCostMicros: number;
  resourceUnits: number;
  detail: string;
}

export interface DoctorCallbacks {
  detect(check: DoctorCheckDefinition): Promise<DoctorObservation>;
  execute(fix: DoctorFixDefinition): Promise<DoctorExecutionReceipt>;
  verify(check: DoctorCheckDefinition): Promise<DoctorObservation>;
  compensate(fix: DoctorFixDefinition): Promise<'compensated' | 'failed' | 'indeterminate'>;
}

interface ReplayEntry { requestHash: Sha256; result: DoctorInvocationResult }
interface AggregateBudget {
  attempts: number;
  providerCostMicros: number;
  resourceUnits: number;
  lastAttemptAt: number;
  rateWindowStartedAt: number;
  rateWindowAttempts: number;
}

const MUTABLE_CLASSES = new Set<DoctorSubjectClass>(['rebuildable_projection', 'fenced_ephemeral_runtime_state']);

function definitionMaterial<T extends { definitionHash: Sha256 }>(definition: T): Omit<T, 'definitionHash'> {
  const { definitionHash: _definitionHash, ...material } = definition;
  return material;
}

export function sealDoctorCheck(input: Omit<DoctorCheckDefinition, 'definitionHash'>): DoctorCheckDefinition {
  const definitionHash = governedOperationsHash(input);
  return Object.freeze({ ...input, definitionHash });
}

export function sealDoctorFix(input: Omit<DoctorFixDefinition, 'definitionHash'>): DoctorFixDefinition {
  const definitionHash = governedOperationsHash(input);
  return Object.freeze({ ...input, definitionHash });
}

export function validateDoctorDefinitions(check: DoctorCheckDefinition, fix?: DoctorFixDefinition): void {
  for (const [value, label] of [[check.checkId, 'checkId'], [check.workspaceId, 'workspaceId'],
    [check.subjectId, 'subjectId'], [check.subjectRevision, 'subjectRevision'],
    [check.evidence.sourceId, 'evidence source'], [check.evidence.sourceRevision, 'evidence revision'],
    [check.precondition.predicateId, 'precondition'], [check.postcondition.predicateId, 'postcondition']] as const) {
    assertNonEmptyExactIdentity(value, label);
  }
  if (check.evidence.maximumAgeMs <= 0) throw new Error('Doctor evidence freshness must be positive');
  requireExactHash(check.definitionHash, 'check definition hash');
  if (governedOperationsHash(definitionMaterial(check)) !== check.definitionHash) throw new Error('Doctor check definition hash mismatch');
  if (!fix) return;
  for (const [value, label] of [[fix.fixId, 'fixId'], [fix.compensationId, 'compensationId'],
    [fix.safeNextAction, 'safeNextAction']] as const) assertNonEmptyExactIdentity(value, label);
  requireExactHash(fix.definitionHash, 'fix definition hash');
  if (governedOperationsHash(definitionMaterial(fix)) !== fix.definitionHash) throw new Error('Doctor fix definition hash mismatch');
  const expectedCapability: Exclude<DoctorCapability, 'observe'> =
    fix.mutationClass === 'rebuildable_projection' ? 'rebuild_projection' : 'fence_ephemeral_state';
  if (fix.checkId !== check.checkId || fix.workspaceId !== check.workspaceId || fix.subjectId !== check.subjectId
    || fix.subjectRevision !== check.subjectRevision || fix.capability !== expectedCapability
    || check.capability !== expectedCapability
    || governedOperationsHash(fix.precondition) !== governedOperationsHash(check.precondition)
    || governedOperationsHash(fix.postcondition) !== governedOperationsHash(check.postcondition)) {
    throw new Error('Doctor fix does not bind the exact check capability, subject, and complete conditions');
  }
  if (!MUTABLE_CLASSES.has(check.subjectClass) || fix.mutationClass !== check.subjectClass) {
    throw new Error('Canonical truth and immutable artifacts are observe-only');
  }
  const bounds = fix.bounds;
  if (!Number.isInteger(bounds.maximumAttempts) || bounds.maximumAttempts < 1 || bounds.maximumAttempts > 10
    || bounds.wallClockMs < 1 || bounds.providerCostMicros < 0 || bounds.resourceUnits < 1
    || bounds.rateLimitPerMinute < 1 || bounds.cooldownMs < 0) throw new Error('Doctor fix has invalid bounded execution limits');
}


export function createDoctorPreview(input: Omit<DoctorPreview, 'schemaVersion' | 'dryRun' | 'previewHash'>): DoctorPreview {
  const material: Omit<DoctorPreview, 'previewHash'> = {
    schemaVersion: 'rorca.governed-doctor-preview.v1', ...input, dryRun: true,
  };
  return Object.freeze({ ...material, previewHash: governedOperationsHash(material) });
}

export function doctorInvocationRequestHash(input: Omit<DoctorInvocationInput, 'preview'>): Sha256 {
  return governedOperationsHash({
    invocationId: input.invocationId, workspaceId: input.workspaceId, subjectId: input.subjectId,
    subjectRevision: input.subjectRevision, checkDefinitionHash: input.check.definitionHash,
    fixDefinitionHash: input.fix?.definitionHash ?? null, apply: input.apply ?? false,
    fence: input.fence, requestedAt: input.requestedAt,
    expectedProviderCostMicros: input.expectedProviderCostMicros, expectedResourceUnits: input.expectedResourceUnits,
  });
}

function verifyObservation(check: DoctorCheckDefinition, observation: DoctorObservation, now: number): void {
  requireExactHash(observation.evidenceHash, 'observation evidence hash');
  if (observation.sourceId !== check.evidence.sourceId || observation.sourceRevision !== check.evidence.sourceRevision) {
    throw new Error('Doctor evidence source or revision mismatch');
  }
  const observedAt = Date.parse(observation.observedAt);
  if (!Number.isFinite(observedAt) || observedAt > now || now - observedAt > check.evidence.maximumAgeMs) {
    throw new Error('Doctor evidence is stale or future-dated');
  }
}

export class PermanentDoctorReplayError extends Error {
  readonly retryable = false;
}

export class GovernedDoctorController {
  private readonly replays = new Map<string, ReplayEntry>();
  private readonly locks = new Set<string>();
  private readonly aggregateBudgets = new Map<string, AggregateBudget>();
  private readonly audit: DoctorTransition[] = [];

  constructor(private readonly callbacks: DoctorCallbacks, private readonly now: () => number = Date.now) {}

  getAudit(workspaceId: string): readonly DoctorTransition[] {
    return this.audit.filter(entry => entry.detail.startsWith(`${workspaceId}:`)).slice(-256);
  }

  async invoke(input: DoctorInvocationInput): Promise<DoctorInvocationResult> {
    validateDoctorDefinitions(input.check, input.fix);
    for (const [actual, expected, label] of [[input.workspaceId, input.check.workspaceId, 'workspace'],
      [input.subjectId, input.check.subjectId, 'subject'], [input.subjectRevision, input.check.subjectRevision, 'revision']] as const) {
      if (actual !== expected) throw new Error(`Doctor invocation ${label} mismatch`);
    }
    if (!input.idempotencyKey || input.idempotencyKey.length > 256) throw new Error('Complete idempotency key required');
    if (!Number.isSafeInteger(input.fence) || input.fence < 1) throw new Error('One positive exact fence required');
    if (!Number.isSafeInteger(input.expectedProviderCostMicros) || input.expectedProviderCostMicros < 0
      || !Number.isSafeInteger(input.expectedResourceUnits) || input.expectedResourceUnits < 0) {
      throw new Error('Doctor expected provider cost and resource units must be non-negative safe integers');
    }
    const requestedAt = Date.parse(input.requestedAt);
    if (!Number.isFinite(requestedAt) || requestedAt > this.now()) throw new Error('Doctor request time must be exact and not future-dated');
    const requestHash = doctorInvocationRequestHash(input);
    const replayKey = `${input.workspaceId}:${input.idempotencyKey}`;
    const replay = this.replays.get(replayKey);
    if (replay) {
      if (replay.requestHash !== requestHash) {
        this.audit.push(this.auditTransition(input, 'escalate', 'failed', governedOperationsHash({ replay: requestHash }), 'changed_replay_permanently_rejected'));
        throw new PermanentDoctorReplayError('Changed Doctor replay permanently rejected and audited');
      }
      return replay.result;
    }
    this.validatePreview(input, requestHash);
    const lockKey = `${input.workspaceId}:${input.subjectId}:${input.subjectRevision}:${input.fix?.fixId ?? input.check.checkId}`;
    if (this.locks.has(lockKey)) throw new Error('Doctor invocation already owns the PostgreSQL-equivalent scoped lock');
    this.locks.add(lockKey);
    try {
      const result = await this.runLocked(input, requestHash, lockKey);
      this.replays.set(replayKey, { requestHash, result });
      return result;
    } finally {
      this.locks.delete(lockKey);
    }
  }

  private validatePreview(input: DoctorInvocationInput, requestHash: Sha256): void {
    const preview = input.preview;
    const { previewHash: _hash, ...material } = preview;
    if (governedOperationsHash(material) !== preview.previewHash || preview.requestHash !== requestHash
      || preview.workspaceId !== input.workspaceId || preview.subjectId !== input.subjectId
      || preview.subjectRevision !== input.subjectRevision || preview.checkDefinitionHash !== input.check.definitionHash
      || preview.fixDefinitionHash !== (input.fix?.definitionHash ?? null) || preview.fence !== input.fence
      || Date.parse(preview.expiresAt) <= this.now()) throw new Error('Unexpired exact Doctor preview required');
  }

  private async runLocked(input: DoctorInvocationInput, requestHash: Sha256, lockKey: string): Promise<DoctorInvocationResult> {
    const transitions: DoctorTransition[] = [];
    const append = (transition: DoctorTransitionName, status: DoctorTransition['status'], hash: Sha256, detail: string) => {
      if (transition !== DOCTOR_TRANSITIONS[transitions.length]) throw new Error('Doctor transition attempted to skip a governed phase');
      const row = this.auditTransition(input, transition, status, hash, detail, transitions.length + 1);
      transitions.push(row); this.audit.push(row);
    };
    const now = this.now();
    let observed: DoctorObservation;
    try {
      observed = await this.callbacks.detect(input.check);
      verifyObservation(input.check, observed, now);
      append('detect', 'recorded', observed.evidenceHash, boundedRedactedObservation(`${input.workspaceId}:${observed.summary}`));
    } catch {
      observed = { sourceId: input.check.evidence.sourceId, sourceRevision: input.check.evidence.sourceRevision,
        observedAt: new Date(now).toISOString(), condition: 'indeterminate', evidenceHash: governedOperationsHash({ error: 'detect_failed' }), summary: 'detect_failed' };
      append('detect', 'failed', observed.evidenceHash, `${input.workspaceId}:detect_failed`);
    }
    const mutable = MUTABLE_CLASSES.has(input.check.subjectClass) && Boolean(input.fix);
    append('classify', 'recorded', governedOperationsHash({ condition: observed.condition, class: input.check.subjectClass }), `${input.workspaceId}:${mutable ? 'bounded_mutation' : 'observe_only'}`);
    append('propose', 'recorded', input.preview.previewHash, `${input.workspaceId}:${input.apply === true ? 'apply_requested' : 'dry_run'}`);
    let authority = input.apply === true && mutable && observed.condition === input.check.precondition.condition;
    const fix = input.fix;
    const budget = this.aggregateBudgets.get(lockKey) ?? { attempts: 0, providerCostMicros: 0,
      resourceUnits: 0, lastAttemptAt: 0, rateWindowStartedAt: now, rateWindowAttempts: 0 };
    if (now - budget.rateWindowStartedAt >= 60_000) {
      budget.rateWindowStartedAt = now;
      budget.rateWindowAttempts = 0;
    }
    if (authority && fix) {
      const cooldownReady = now - budget.lastAttemptAt >= fix.bounds.cooldownMs;
      authority = cooldownReady && now - Date.parse(input.requestedAt) <= fix.bounds.wallClockMs
        && budget.attempts < fix.bounds.maximumAttempts && budget.rateWindowAttempts < fix.bounds.rateLimitPerMinute
        && budget.providerCostMicros + input.expectedProviderCostMicros <= fix.bounds.providerCostMicros
        && budget.resourceUnits + input.expectedResourceUnits <= fix.bounds.resourceUnits;
    }
    append('authority', authority ? 'permitted' : 'denied', governedOperationsHash({ authority, fence: input.fence }), `${input.workspaceId}:${authority ? 'exact_preview_and_bounds' : 'no_mutation_authority'}`);

    let execution: DoctorExecutionReceipt | null = null;
    let compensated = false;
    let quarantined = false;
    if (authority && fix) {
      budget.attempts += 1; budget.rateWindowAttempts += 1; budget.lastAttemptAt = now;
      execution = await this.callbacks.execute(fix);
      const receiptAmountsValid = Number.isSafeInteger(execution.providerCostMicros) && execution.providerCostMicros >= 0
        && Number.isSafeInteger(execution.resourceUnits) && execution.resourceUnits >= 0;
      if (!receiptAmountsValid) {
        execution = { ...execution, status: 'indeterminate', providerCostMicros: 0, resourceUnits: 0,
          detail: 'invalid_execution_budget_receipt' };
      }
      budget.providerCostMicros += execution.providerCostMicros;
      budget.resourceUnits += execution.resourceUnits;
      this.aggregateBudgets.set(lockKey, budget);
      const withinReceipt = receiptAmountsValid && execution.providerCostMicros <= input.expectedProviderCostMicros
        && execution.resourceUnits <= input.expectedResourceUnits
        && this.now() - now <= fix.bounds.wallClockMs;
      if (!withinReceipt) execution = { ...execution, status: 'indeterminate', detail: 'execution_budget_receipt_exceeded' };
      append('execute', execution.status === 'applied' ? 'recorded' : 'failed', governedOperationsHash(execution), `${input.workspaceId}:${boundedRedactedObservation(execution.detail)}`);
    } else {
      append('execute', 'skipped', governedOperationsHash({ dryRun: input.apply !== true }), `${input.workspaceId}:zero_mutation`);
    }

    let verification: DoctorObservation;
    try {
      verification = await this.callbacks.verify(input.check);
      verifyObservation(input.check, verification, this.now());
      if (execution && verification.sourceId === execution.executorSourceId) throw new Error('Postcondition verification must be independently sourced');
      const healthy = verification.condition === input.check.postcondition.condition;
      append('verify', healthy ? 'verified' : 'failed', verification.evidenceHash, `${input.workspaceId}:${healthy ? 'postcondition_observed' : 'postcondition_not_observed'}`);
    } catch {
      verification = { sourceId: input.check.evidence.sourceId, sourceRevision: input.check.evidence.sourceRevision,
        observedAt: new Date(this.now()).toISOString(), condition: 'indeterminate', evidenceHash: governedOperationsHash({ error: 'verify_failed' }), summary: 'verify_failed' };
      append('verify', 'failed', verification.evidenceHash, `${input.workspaceId}:independent_verify_failed`);
    }

    let outcome: DoctorOutcome;
    const fixed = Boolean(execution?.status === 'applied' && verification.condition === input.check.postcondition.condition);
    if (!mutable) outcome = 'observe_only';
    else if (input.apply !== true) outcome = 'dry_run';
    else if (fixed) outcome = 'fixed';
    else if (!authority) { outcome = 'quarantined'; quarantined = true; }
    else if (fix) {
      const compensation = await this.callbacks.compensate(fix);
      compensated = compensation === 'compensated';
      quarantined = compensation !== 'compensated';
      outcome = compensated ? 'compensated' : compensation === 'indeterminate' ? 'indeterminate' : 'quarantined';
    } else outcome = observed.condition === 'healthy' ? 'healthy' : 'indeterminate';
    append('outcome', outcome === 'fixed' || outcome === 'healthy' ? 'verified' : 'recorded', governedOperationsHash({ outcome, compensated, quarantined }), `${input.workspaceId}:${outcome}`);
    const escalation = outcome === 'fixed' || outcome === 'healthy'
      ? null
      : { reasonCode: `doctor_${outcome}`, safeNextAction: boundedRedactedObservation(fix?.safeNextAction ?? 'governed operator review'), detail: 'bounded redacted operational observation; no canonical or provider authority' };
    append('escalate', escalation ? 'recorded' : 'skipped', governedOperationsHash(escalation ?? { escalation: false }), `${input.workspaceId}:${escalation?.reasonCode ?? 'none'}`);
    const material = { invocationId: input.invocationId, workspaceId: input.workspaceId, subjectId: input.subjectId,
      subjectRevision: input.subjectRevision, requestHash, transitions, outcome, mutated: fixed,
      compensated, quarantined, escalation };
    return Object.freeze({ ...material, transitions: Object.freeze(transitions), resultHash: governedOperationsHash(material) });
  }

  private auditTransition(input: DoctorInvocationInput, transition: DoctorTransitionName,
    status: DoctorTransition['status'], observationHash: Sha256, detail: string, sequence = 1): DoctorTransition {
    return Object.freeze({ sequence, transition, status, observationHash,
      recordedAt: new Date(this.now()).toISOString(), detail: boundedRedactedObservation(`${input.workspaceId}:${detail}`) });
  }
}
