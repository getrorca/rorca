/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash, randomUUID } from 'node:crypto';
import { PHASES, type Phase } from '../schema/control-schema';

export const LEARN_CANDIDATE_TYPES = [
  'test-class-failed-to-predict-defect',
  'exception-caused-rework',
  'control-produced-no-signal',
  'model-underperformed-on-task-class',
] as const;

export type LearnCandidateType = (typeof LEARN_CANDIDATE_TYPES)[number];
export type LearnCandidateStatus = 'pending-review' | 'approved' | 'rejected';

/** The sole candidate contract shared by the SSDLC learn loop and AAV adapters. */
export interface LearnCandidate {
  candidateId: string;
  type: LearnCandidateType;
  controlId: string;
  phase: Phase;
  evidenceRef: string;
  signalCount: number;
  status: LearnCandidateStatus;
  /** Immutable producer lineage retained for governed review and qualification. */
  provenance?: Readonly<Record<string, unknown>>;
}

/**
 * Canonical input accepted from production evaluation and AAV heal/run adapters.
 * Producers should set candidateType when they have already normalized the signal;
 * the semantic fields allow production records to be classified at this boundary.
 */
export interface ProductionOutcome {
  source?: 'production' | 'aav-heal' | 'aav-run';
  outcomeType?: 'production' | 'healing' | 'run' | 'control-evaluation' | 'model-performance';
  candidateType?: LearnCandidateType;
  controlId: string;
  phase: Phase;
  evidenceRef: string;
  defectReachedProduction?: boolean;
  validationTestsPassed?: boolean;
  reworkCausedByGrantedException?: boolean;
  grantedExceptionCausedRework?: boolean;
  evaluatedGateCount?: number;
  gatesEvaluated?: number;
  producedSignalCount?: number;
  signalsProduced?: number;
  noSignalGateCount?: number;
  modelUnderperformed?: boolean;
  taskClassUnderperformed?: boolean;
  taskClass?: string;
  provenance?: Readonly<Record<string, unknown>>;
}

export interface LearnLoopConfiguration {
  /** Minimum all-zero gate observations required before proposing a no-signal candidate. */
  noSignalThreshold: number;
}

export interface AuthorizedActor {
  actorId: string;
  authorized: true;
}

export interface CandidateApplicationReceipt {
  candidateId: string;
  actorId: string;
  applied: true;
  /** Catalog changes remain a separate, explicit governed operation. */
  catalogMutated: false;
}

export class LearnLoopError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'LearnLoopError';
  }
}

type StoredCandidate = LearnCandidate & { evidenceRefHash: string };

const DEFAULT_CONFIGURATION: LearnLoopConfiguration = { noSignalThreshold: 3 };
let configuration = { ...DEFAULT_CONFIGURATION };
const candidatesByKey = new Map<string, StoredCandidate>();
const candidateKeyById = new Map<string, string>();

function freezeCandidate(candidate: StoredCandidate): StoredCandidate {
  return Object.freeze(candidate);
}

function publicCandidate(candidate: StoredCandidate): LearnCandidate {
  const { evidenceRefHash: _evidenceRefHash, ...result } = candidate;
  return Object.freeze(result);
}

function evidenceHash(evidenceRef: string): string {
  return createHash('sha256').update(evidenceRef, 'utf8').digest('hex');
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new LearnLoopError('INVALID_CONFIGURATION', `${name} must be a positive integer`);
  }
  return value;
}

function assertOutcome(outcome: ProductionOutcome): void {
  if (!outcome || typeof outcome !== 'object') throw new LearnLoopError('INVALID_OUTCOME', 'outcome is required');
  if (typeof outcome.controlId !== 'string' || !outcome.controlId.trim()) {
    throw new LearnLoopError('INVALID_OUTCOME', 'controlId is required');
  }
  if (!PHASES.includes(outcome.phase)) throw new LearnLoopError('INVALID_OUTCOME', `unknown phase '${String(outcome.phase)}'`);
  if (typeof outcome.evidenceRef !== 'string' || !outcome.evidenceRef.trim()) {
    throw new LearnLoopError('INVALID_OUTCOME', 'evidenceRef is required');
  }
  if (outcome.candidateType && !LEARN_CANDIDATE_TYPES.includes(outcome.candidateType)) {
    throw new LearnLoopError('INVALID_OUTCOME', `unknown candidateType '${String(outcome.candidateType)}'`);
  }
}

function classify(outcome: ProductionOutcome): LearnCandidateType | undefined {
  if (outcome.candidateType) {
    if (outcome.candidateType !== 'control-produced-no-signal') return outcome.candidateType;
    return meetsNoSignalThreshold(outcome) ? outcome.candidateType : undefined;
  }
  if (outcome.defectReachedProduction === true && outcome.validationTestsPassed === true) {
    return 'test-class-failed-to-predict-defect';
  }
  if (outcome.reworkCausedByGrantedException === true || outcome.grantedExceptionCausedRework === true) {
    return 'exception-caused-rework';
  }
  if (meetsNoSignalThreshold(outcome)) return 'control-produced-no-signal';
  if (outcome.modelUnderperformed === true || outcome.taskClassUnderperformed === true) {
    return 'model-underperformed-on-task-class';
  }
  return undefined;
}

function meetsNoSignalThreshold(outcome: ProductionOutcome): boolean {
  const evaluated = outcome.evaluatedGateCount ?? outcome.gatesEvaluated;
  const produced = outcome.producedSignalCount ?? outcome.signalsProduced;
  const noSignalCount = outcome.noSignalGateCount;

  if (evaluated !== undefined && (!Number.isInteger(evaluated) || evaluated < 0)) {
    throw new LearnLoopError('INVALID_OUTCOME', 'evaluated gate count must be a non-negative integer');
  }
  if (produced !== undefined && (!Number.isInteger(produced) || produced < 0)) {
    throw new LearnLoopError('INVALID_OUTCOME', 'produced signal count must be a non-negative integer');
  }
  if (noSignalCount !== undefined && (!Number.isInteger(noSignalCount) || noSignalCount < 0)) {
    throw new LearnLoopError('INVALID_OUTCOME', 'no-signal gate count must be a non-negative integer');
  }
  if (evaluated === undefined || evaluated < configuration.noSignalThreshold) return false;
  if (produced !== undefined && produced !== 0) return false;

  // The release must explicitly account for every evaluated gate. A zero signal
  // total is sufficient unless a supplied per-gate count contradicts that total.
  return produced === 0
    ? noSignalCount === undefined || noSignalCount === evaluated
    : noSignalCount === evaluated;
}

/** Configure classification policy without creating another candidate store. */
export function configureLearnLoop(next: Partial<LearnLoopConfiguration>): Readonly<LearnLoopConfiguration> {
  configuration = {
    noSignalThreshold: next.noSignalThreshold === undefined
      ? configuration.noSignalThreshold
      : positiveInteger(next.noSignalThreshold, 'noSignalThreshold'),
  };
  return Object.freeze({ ...configuration });
}

/**
 * Classify and store one production/healing signal. All new candidates are pending
 * review. Repeated evidence increments the existing candidate atomically in-memory.
 */
export function consumeProductionOutcome(outcome: ProductionOutcome): LearnCandidate | undefined {
  assertOutcome(outcome);
  const type = classify(outcome);
  if (!type) return undefined;

  const hash = evidenceHash(outcome.evidenceRef);
  const key = `${type}\u0000${outcome.controlId}\u0000${hash}`;
  const existing = candidatesByKey.get(key);
  if (existing) {
    const updated = freezeCandidate({ ...existing, signalCount: existing.signalCount + 1 });
    candidatesByKey.set(key, updated);
    return publicCandidate(updated);
  }

  const candidate = freezeCandidate({
    candidateId: `GEN-CAND-${randomUUID()}`,
    type,
    controlId: outcome.controlId,
    phase: outcome.phase,
    evidenceRef: outcome.evidenceRef,
    signalCount: 1,
    status: 'pending-review',
    ...(outcome.provenance ? { provenance: Object.freeze({ ...outcome.provenance }) } : {}),
    evidenceRefHash: hash,
  });
  candidatesByKey.set(key, candidate);
  candidateKeyById.set(candidate.candidateId, key);
  return publicCandidate(candidate);
}

export function getCandidate(candidateId: string): LearnCandidate | undefined {
  const key = candidateKeyById.get(candidateId);
  const candidate = key ? candidatesByKey.get(key) : undefined;
  return candidate && publicCandidate(candidate);
}

export function listCandidates(): LearnCandidate[] {
  return [...candidatesByKey.values()].map(publicCandidate);
}

/** Record an explicit authorized review decision; generation itself never approves. */
export function reviewCandidate(
  candidateId: string,
  status: Exclude<LearnCandidateStatus, 'pending-review'>,
  actor: AuthorizedActor,
): LearnCandidate {
  assertAuthorizedActor(actor);
  if (status !== 'approved' && status !== 'rejected') {
    throw new LearnLoopError('INVALID_REVIEW_STATUS', "review status must be 'approved' or 'rejected'");
  }
  const key = candidateKeyById.get(candidateId);
  const candidate = key ? candidatesByKey.get(key) : undefined;
  if (!candidate || !key) throw new LearnLoopError('CANDIDATE_NOT_FOUND', `candidate '${candidateId}' was not found`);
  const reviewed = freezeCandidate({ ...candidate, status });
  candidatesByKey.set(key, reviewed);
  return publicCandidate(reviewed);
}

function assertAuthorizedActor(actor: AuthorizedActor | undefined): asserts actor is AuthorizedActor {
  if (!actor || actor.authorized !== true || typeof actor.actorId !== 'string' || !actor.actorId.trim()) {
    throw new LearnLoopError('UNAUTHORIZED_ACTOR', 'an explicit authorized actor is required');
  }
}

/**
 * Apply only an approved canonical candidate. This returns an authorization receipt;
 * it deliberately never writes controls.json or any other catalog artifact.
 */
export function applyCandidate(
  candidateOrId: LearnCandidate | string,
  actor?: AuthorizedActor,
): CandidateApplicationReceipt {
  assertAuthorizedActor(actor);
  const candidateId = typeof candidateOrId === 'string' ? candidateOrId : candidateOrId.candidateId;
  const candidate = getCandidate(candidateId);
  if (!candidate) throw new LearnLoopError('CANDIDATE_NOT_FOUND', `candidate '${candidateId}' was not found`);
  if (candidate.status !== 'approved') {
    throw new LearnLoopError('REVIEW_REQUIRED', `candidate '${candidateId}' requires approved review before application`);
  }
  return Object.freeze({ candidateId, actorId: actor.actorId, applied: true, catalogMutated: false });
}

/** Test isolation seam; production consumers should never clear governance history. */
export function resetLearnLoopForTests(): void {
  candidatesByKey.clear();
  candidateKeyById.clear();
  configuration = { ...DEFAULT_CONFIGURATION };
}
