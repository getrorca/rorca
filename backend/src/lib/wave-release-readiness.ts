/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { canonicalJson } from './wave-qualification-evidence';

export const WAVE_RELEASE_READINESS_SCHEMA = 'rorca.wave-release-readiness/v1' as const;

export const WAVE_REVIEW_ROLES = [
  'architecture',
  'security-red-team',
  'database-queue',
  'git',
  'sre',
  'qa',
  'operator-ux',
] as const;
export type WaveReviewRole = typeof WAVE_REVIEW_ROLES[number];

export const WAVE_RELEASE_REQUIREMENTS = [
  'architecture-state-machine',
  'security-data-safety',
  'database-queue-safety',
  'git-sre-recovery',
  'ci-platform-matrix',
  'nonproduction-canary-soak',
  'evidence-release-checklist',
  'independent-reviewers',
  'pr-validation',
  'pr-only-delivery',
  'rollback-rehearsal',
  'zero-production-mutation',
] as const;
export type WaveReleaseRequirement = typeof WAVE_RELEASE_REQUIREMENTS[number];

export const WAVE_RELEASE_VALIDATIONS = [
  'migration-fresh-database',
  'migration-uniqueness',
  'backend-typecheck',
  'frontend-typecheck',
  'focused-tests',
  'full-tests',
  'frontend-lint',
  'backend-lint',
  'build',
  'contract-tier',
  'license',
  'secret-scan',
  'git-diff-check',
  'qualification-report-pr-head',
] as const;
export type WaveReleaseValidation = typeof WAVE_RELEASE_VALIDATIONS[number];

const INVARIANT_IDS = [
  'WPE-INV-001', 'WPE-INV-002', 'WPE-INV-003', 'WPE-INV-004',
  'WPE-INV-005', 'WPE-INV-006', 'WPE-INV-007',
] as const;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_OID = /^[0-9a-f]{40,64}$/;
const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60;

export interface WaveIndependentReview {
  role: WaveReviewRole;
  reviewerId: string;
  reviewedSourceRevision: string;
  verdict: 'approved' | 'changes-requested';
  unresolvedCriticalHighFindings: number;
  evidenceDigest: string;
}

export interface WaveReleaseChecklistItem {
  requirementId: WaveReleaseRequirement;
  critical: true;
  verdict: 'passed' | 'failed' | 'skipped' | 'ambiguous';
  invariantIds: string[];
  scenarioIds: string[];
  assertionIds: string[];
  durableEvidenceDigests: string[];
  independentCheckerId: string;
  humanReviewerId: string;
}

export interface WaveReleaseReadinessPacket {
  schemaVersion: typeof WAVE_RELEASE_READINESS_SCHEMA;
  workspaceId: string;
  qualification: {
    receiptId: string;
    reportHash: string;
    sourceRevision: string;
    issuedAt: string;
    expiresAt: string;
  };
  pullRequest: {
    number: number;
    headRevision: string;
    deliveryMode: 'reviewed-pull-request';
    reviewed: boolean;
    autoMergeEnabled: false;
    deploymentEnabled: false;
  };
  implementerId: string;
  reviews: WaveIndependentReview[];
  checklist: WaveReleaseChecklistItem[];
  platformMatrix: Array<{
    platform: 'linux' | 'darwin';
    nodeMajor: 20 | 22;
    postgresMajor: 16;
    isolatedDatabaseOwnedByTestRole: boolean;
    criticalChecksSkipped: false;
    verdict: 'passed' | 'failed';
    evidenceDigest: string;
  }>;
  canary: {
    environment: 'non-production';
    verdict: 'passed' | 'failed';
    durationSeconds: number;
    automaticFlakyRetries: number;
    leakedResourceCount: number;
    unexplainedStateDivergenceCount: number;
    unresolvedCriticalHighFindings: number;
    evidenceDigest: string;
  };
  soak: {
    environment: 'non-production';
    verdict: 'passed' | 'failed';
    durationSeconds: number;
    automaticFlakyRetries: number;
    leakedResourceCount: number;
    unexplainedStateDivergenceCount: number;
    unresolvedCriticalHighFindings: number;
    evidenceDigest: string;
  };
  rollback: {
    productionOptInDisabled: boolean;
    newParallelDispatchBlockedImmediately: boolean;
    inFlightEvidencePreserved: boolean;
    governedDrainVerified: boolean;
    governedCancelVerified: boolean;
    sequentialExecutionAvailable: boolean;
    evidenceDigest: string;
  };
  nonMutation: {
    namespacedTestDataOnly: boolean;
    protectedInventoryBeforeDigest: string;
    protectedInventoryAfterDigest: string;
    cleanupEvidenceDigest: string;
    mutations: Record<'workspaces' | 'specs' | 'runs' | 'storyEvidence' | 'queues' | 'branches' | 'operatorRecords' | 'wal' | 'receipts' | 'rolloutControls', number>;
  };
  validations: Array<{
    id: WaveReleaseValidation;
    verdict: 'passed' | 'failed' | 'skipped';
    sourceRevision: string;
    evidenceDigest: string;
  }>;
}

function fail(message: string): never {
  throw new Error(`[wave-release-readiness] ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: unknown, expected: readonly string[], label: string): Record<string, unknown> {
  const item = record(value, label);
  if (JSON.stringify(Object.keys(item).sort()) !== JSON.stringify([...expected].sort())) {
    fail(`${label} contains unknown or missing fields`);
  }
  return item;
}

function token(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(`${label} is not a bounded identifier`);
}

function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(`${label} is malformed`);
}

function revision(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !GIT_OID.test(value)) fail(`${label} is malformed`);
}

function exactInventory<T extends string>(observed: readonly T[], required: readonly T[], label: string): void {
  if (new Set(observed).size !== observed.length
    || observed.length !== required.length
    || required.some(item => !observed.includes(item))) fail(`${label} is incomplete or duplicated`);
}

function assertBoundedRun(value: unknown, label: string): void {
  const run = exactKeys(value, [
    'environment', 'verdict', 'durationSeconds', 'automaticFlakyRetries', 'leakedResourceCount',
    'unexplainedStateDivergenceCount', 'unresolvedCriticalHighFindings', 'evidenceDigest',
  ], label);
  if (run.environment !== 'non-production' || run.verdict !== 'passed') fail(`${label} did not pass in non-production`);
  for (const key of ['durationSeconds', 'automaticFlakyRetries', 'leakedResourceCount', 'unexplainedStateDivergenceCount', 'unresolvedCriticalHighFindings'] as const) {
    if (!Number.isSafeInteger(run[key]) || Number(run[key]) < 0 || Number(run[key]) > MAX_DURATION_SECONDS) fail(`${label} ${key} is unbounded`);
  }
  if (Number(run.durationSeconds) < 1) fail(`${label} duration is missing`);
  if (Number(run.leakedResourceCount) !== 0 || Number(run.unexplainedStateDivergenceCount) !== 0 || Number(run.unresolvedCriticalHighFindings) !== 0) {
    fail(`${label} has unresolved safety findings`);
  }
  digest(run.evidenceDigest, `${label} evidence`);
}

export function assertWaveReleaseReadinessPacket(value: unknown, now = new Date().toISOString()): WaveReleaseReadinessPacket {
  const packet = exactKeys(value, [
    'schemaVersion', 'workspaceId', 'qualification', 'pullRequest', 'implementerId', 'reviews',
    'checklist', 'platformMatrix', 'canary', 'soak', 'rollback', 'nonMutation', 'validations',
  ], 'packet');
  if (packet.schemaVersion !== WAVE_RELEASE_READINESS_SCHEMA) fail('unsupported packet version');
  token(packet.workspaceId, 'workspace ID');
  token(packet.implementerId, 'implementer ID');

  const qualification = exactKeys(packet.qualification, ['receiptId', 'reportHash', 'sourceRevision', 'issuedAt', 'expiresAt'], 'qualification');
  token(qualification.receiptId, 'receipt ID');
  digest(qualification.reportHash, 'report hash');
  revision(qualification.sourceRevision, 'qualification source revision');
  const issuedAt = Date.parse(String(qualification.issuedAt));
  const expiresAt = Date.parse(String(qualification.expiresAt));
  const currentTime = Date.parse(now);
  if (![issuedAt, expiresAt, currentTime].every(Number.isFinite) || expiresAt <= issuedAt || currentTime < issuedAt || currentTime >= expiresAt) {
    fail('qualification receipt is stale, not yet valid, or expired');
  }

  const pullRequest = exactKeys(packet.pullRequest, ['number', 'headRevision', 'deliveryMode', 'reviewed', 'autoMergeEnabled', 'deploymentEnabled'], 'pull request');
  if (!Number.isSafeInteger(pullRequest.number) || Number(pullRequest.number) < 1) fail('pull request number is invalid');
  revision(pullRequest.headRevision, 'pull request head');
  if (pullRequest.headRevision !== qualification.sourceRevision) fail('qualification receipt is not tied to the PR head');
  if (pullRequest.deliveryMode !== 'reviewed-pull-request' || pullRequest.reviewed !== true || pullRequest.autoMergeEnabled !== false || pullRequest.deploymentEnabled !== false) {
    fail('delivery must be reviewed PR-only with auto-merge and deployment disabled');
  }

  if (!Array.isArray(packet.reviews)) fail('reviews must be an array');
  const reviews = packet.reviews.map((value, index) => exactKeys(value, ['role', 'reviewerId', 'reviewedSourceRevision', 'verdict', 'unresolvedCriticalHighFindings', 'evidenceDigest'], `review ${index}`));
  exactInventory(reviews.map(item => item.role as WaveReviewRole), WAVE_REVIEW_ROLES, 'review role inventory');
  const reviewerIds = reviews.map(item => {
    if (!WAVE_REVIEW_ROLES.includes(item.role as WaveReviewRole)) fail('review role is unsupported');
    token(item.reviewerId, 'reviewer ID');
    revision(item.reviewedSourceRevision, 'reviewed source revision');
    digest(item.evidenceDigest, 'review evidence');
    if (item.reviewerId === packet.implementerId) fail('implementer cannot approve an independent review');
    if (item.reviewedSourceRevision !== pullRequest.headRevision || item.verdict !== 'approved' || item.unresolvedCriticalHighFindings !== 0) fail('independent review is stale or not approved');
    return item.reviewerId;
  });
  if (new Set(reviewerIds).size !== reviewerIds.length) fail('each independent review role requires a distinct named reviewer');

  if (!Array.isArray(packet.checklist)) fail('checklist must be an array');
  const checklist = packet.checklist.map((value, index) => exactKeys(value, ['requirementId', 'critical', 'verdict', 'invariantIds', 'scenarioIds', 'assertionIds', 'durableEvidenceDigests', 'independentCheckerId', 'humanReviewerId'], `checklist item ${index}`));
  exactInventory(checklist.map(item => item.requirementId as WaveReleaseRequirement), WAVE_RELEASE_REQUIREMENTS, 'release requirement inventory');
  const coveredInvariants = new Set<string>();
  for (const item of checklist) {
    if (item.critical !== true || item.verdict !== 'passed') fail('critical release requirement is skipped, failed, or ambiguous');
    for (const key of ['invariantIds', 'scenarioIds', 'assertionIds', 'durableEvidenceDigests'] as const) {
      if (!Array.isArray(item[key]) || item[key].length === 0 || item[key].length > 128) fail(`checklist ${key} is empty or unbounded`);
    }
    for (const invariant of item.invariantIds as unknown[]) {
      token(invariant, 'invariant ID');
      coveredInvariants.add(invariant);
    }
    for (const scenario of item.scenarioIds as unknown[]) token(scenario, 'scenario ID');
    for (const assertion of item.assertionIds as unknown[]) token(assertion, 'assertion ID');
    for (const evidence of item.durableEvidenceDigests as unknown[]) digest(evidence, 'durable evidence digest');
    token(item.independentCheckerId, 'independent checker ID');
    token(item.humanReviewerId, 'human reviewer ID');
    if (!reviewerIds.includes(item.humanReviewerId)) fail('checklist human reviewer is not an approved independent reviewer');
    if (item.independentCheckerId === packet.implementerId) fail('implementer cannot be the independent checker');
  }
  if (INVARIANT_IDS.some(id => !coveredInvariants.has(id))) fail('release checklist does not cover every invariant');

  if (!Array.isArray(packet.platformMatrix)) fail('platform matrix must be an array');
  const matrix = packet.platformMatrix.map((value, index) => exactKeys(value, ['platform', 'nodeMajor', 'postgresMajor', 'isolatedDatabaseOwnedByTestRole', 'criticalChecksSkipped', 'verdict', 'evidenceDigest'], `platform result ${index}`));
  const requiredMatrix = ['darwin:20', 'darwin:22', 'linux:20', 'linux:22'];
  exactInventory(matrix.map(item => `${String(item.platform)}:${String(item.nodeMajor)}`), requiredMatrix, 'platform runtime matrix');
  for (const item of matrix) {
    if (!['linux', 'darwin'].includes(String(item.platform)) || ![20, 22].includes(Number(item.nodeMajor)) || item.postgresMajor !== 16
      || item.isolatedDatabaseOwnedByTestRole !== true || item.criticalChecksSkipped !== false || item.verdict !== 'passed') fail('platform qualification is not blocking and isolated');
    digest(item.evidenceDigest, 'platform evidence');
  }

  assertBoundedRun(packet.canary, 'canary');
  assertBoundedRun(packet.soak, 'soak');

  const rollback = exactKeys(packet.rollback, ['productionOptInDisabled', 'newParallelDispatchBlockedImmediately', 'inFlightEvidencePreserved', 'governedDrainVerified', 'governedCancelVerified', 'sequentialExecutionAvailable', 'evidenceDigest'], 'rollback');
  for (const key of ['productionOptInDisabled', 'newParallelDispatchBlockedImmediately', 'inFlightEvidencePreserved', 'governedDrainVerified', 'governedCancelVerified', 'sequentialExecutionAvailable'] as const) {
    if (rollback[key] !== true) fail(`rollback ${key} is not proven`);
  }
  digest(rollback.evidenceDigest, 'rollback evidence');

  const nonMutation = exactKeys(packet.nonMutation, ['namespacedTestDataOnly', 'protectedInventoryBeforeDigest', 'protectedInventoryAfterDigest', 'cleanupEvidenceDigest', 'mutations'], 'non-mutation');
  if (nonMutation.namespacedTestDataOnly !== true) fail('qualification data was not proven namespaced');
  digest(nonMutation.protectedInventoryBeforeDigest, 'protected before inventory');
  digest(nonMutation.protectedInventoryAfterDigest, 'protected after inventory');
  digest(nonMutation.cleanupEvidenceDigest, 'cleanup evidence');
  if (nonMutation.protectedInventoryBeforeDigest !== nonMutation.protectedInventoryAfterDigest) fail('protected production inventory changed');
  const mutations = exactKeys(nonMutation.mutations, ['workspaces', 'specs', 'runs', 'storyEvidence', 'queues', 'branches', 'operatorRecords', 'wal', 'receipts', 'rolloutControls'], 'protected mutations');
  if (Object.values(mutations).some(count => count !== 0)) fail('qualification mutated protected production data');

  if (!Array.isArray(packet.validations)) fail('validations must be an array');
  const validations = packet.validations.map((value, index) => exactKeys(value, ['id', 'verdict', 'sourceRevision', 'evidenceDigest'], `validation ${index}`));
  exactInventory(validations.map(item => item.id as WaveReleaseValidation), WAVE_RELEASE_VALIDATIONS, 'PR validation inventory');
  for (const validation of validations) {
    revision(validation.sourceRevision, 'validation source revision');
    digest(validation.evidenceDigest, 'validation evidence');
    if (validation.verdict !== 'passed' || validation.sourceRevision !== pullRequest.headRevision) fail('PR validation is skipped, failed, or stale');
  }

  return value as WaveReleaseReadinessPacket;
}

export function waveReleaseReadinessPacketHash(packet: WaveReleaseReadinessPacket): string {
  assertWaveReleaseReadinessPacket(packet);
  return `sha256:${createHash('sha256').update(canonicalJson(packet)).digest('hex')}`;
}

export interface WaveProductionActivationAuthorization {
  workspaceId: string;
  packetHash: string;
  sourceRevision: string;
  operatorId: string;
  confirmation: 'AUTHORIZE_WAVE_PARALLEL_PRODUCTION';
}

export function waveProductionActivationPayload(input: WaveProductionActivationAuthorization): string {
  token(input.workspaceId, 'activation workspace ID');
  token(input.operatorId, 'activation operator ID');
  digest(input.packetHash, 'activation packet hash');
  revision(input.sourceRevision, 'activation source revision');
  if (input.confirmation !== 'AUTHORIZE_WAVE_PARALLEL_PRODUCTION') fail('production activation confirmation is invalid');
  return canonicalJson({
    schemaVersion: 'rorca.wave-production-activation/v1',
    workspaceId: input.workspaceId,
    packetHash: input.packetHash,
    sourceRevision: input.sourceRevision,
    operatorId: input.operatorId,
    confirmation: input.confirmation,
  });
}

export function signWaveProductionActivation(input: WaveProductionActivationAuthorization, key: string): string {
  if (Buffer.byteLength(key) < 32) fail('production activation key must contain at least 32 bytes');
  return createHmac('sha256', key).update(waveProductionActivationPayload(input)).digest('hex');
}

export function verifyWaveProductionActivation(input: WaveProductionActivationAuthorization & {
  authorization: string;
  trustedKey: string;
}): void {
  if (!/^[0-9a-f]{64}$/.test(input.authorization)) fail('production activation authorization is malformed');
  const expected = signWaveProductionActivation(input, input.trustedKey);
  if (!timingSafeEqual(Buffer.from(input.authorization, 'hex'), Buffer.from(expected, 'hex'))) {
    fail('production activation authorization is invalid');
  }
}
