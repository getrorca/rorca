/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import {
  ContextBundleV1Schema,
  ContextCheckpointV1Schema,
  ContextPolicyActivationV1Schema,
  ContinuationDispatchV1Schema,
  ExecutionLeaseV1Schema,
  MissionContractV1Schema,
  RetrievalReceiptV1Schema,
  WorkPackageV1Schema,
  assertNoForbiddenGovernedFields,
  governedHash,
  type ExecutionLeaseV1,
  type MissionContractV1,
  type WorkPackageV1,
} from './governed-contracts';
import type { Wave3AImplementationGate } from './wave3a-managed-executor-gate';

export const RORCA_MANAGED_EXECUTOR_VERSION = 'rorca.managed-executor.v1' as const;
export const MANAGED_EXECUTION_ADAPTER = Symbol('rorca.execution-adapter.nominal');

export type ManagedAgent = 'claude' | 'opencode' | 'codex' | 'pi' | 'omp';
export type DependencyRequirement = 'required' | 'advisory';
export type DependencyHealth = 'healthy' | 'degraded' | 'unavailable' | 'unknown';
export type ManagedQuotaDimension =
  | 'cpuMillis' | 'memoryBytes' | 'executionConcurrency' | 'continuationConcurrency'
  | 'eventCount' | 'contextBytes' | 'contextTokens' | 'storageBytes' | 'storageObjects'
  | 'retrySpend' | 'providerTokens' | 'providerMicrounits';

export type ManagedQuotaVector = Readonly<Record<ManagedQuotaDimension, number>>;

export interface ManagedDependencyCapability {
  readonly dependencyId: string;
  readonly requirement: DependencyRequirement;
  readonly contractVersion: string;
  readonly compatibleContractVersions: readonly string[];
  readonly status: DependencyHealth;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly rateLimit: Readonly<{ remaining: number; resetAt: string }>;
  readonly circuit: Readonly<{ state: 'closed' | 'half_open' | 'open'; revision: number }>;
  readonly quota: Readonly<{ available: boolean; headroom: number }>;
  readonly fallback: Readonly<{ eligible: boolean; runtimeId: string | null }>;
}

export interface ManagedCapabilitySnapshot {
  readonly schemaVersion: 'rorca.managed-capability-snapshot.v1';
  readonly snapshotId: string;
  readonly snapshotHash: string;
  readonly policyVersion: string;
  readonly workspaceId: string;
  readonly runtimeId: string;
  readonly providerId: string;
  readonly role: 'worker' | 'supervisor';
  readonly principalId: string;
  readonly providerAuthReferenceId: string;
  readonly providerBudgetId: string;
  readonly rateLimitIdentity: string;
  readonly circuitIdentity: string;
  readonly processIdentity: string;
  readonly queueIdentity: string;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly dependencies: readonly ManagedDependencyCapability[];
  readonly decisionSource: 'canonical_snapshot';
}

export interface ManagedDegradationPolicy {
  readonly policyVersion: string;
  readonly allowed: Readonly<Record<string, readonly string[]>>;
}

export interface ManagedCapabilityRequirements {
  readonly required: readonly Readonly<{ dependencyId: string; compatibleContractVersions: readonly string[] }>[];
  readonly advisory: readonly Readonly<{ dependencyId: string; compatibleContractVersions: readonly string[] }>[];
}

export interface ManagedExecutorCanonicalInput {
  readonly mission: MissionContractV1;
  readonly workPackage: WorkPackageV1;
  readonly lease: ExecutionLeaseV1;
  readonly policyActivation: unknown;
  readonly checkpoint: unknown;
  readonly retrievalReceipt: unknown;
  readonly contextBundle: unknown;
  readonly continuationDispatch?: unknown;
  readonly capabilitySnapshot: ManagedCapabilitySnapshot;
  readonly degradationPolicy: ManagedDegradationPolicy;
  readonly capabilityRequirements: ManagedCapabilityRequirements;
  readonly quotaPolicyVersion: string;
  readonly quotaReservationId: string;
  readonly quota: ManagedQuotaVector;
  readonly generation: number;
  readonly agent: ManagedAgent;
  readonly model: string | null;
  readonly terminalMode: 'pipe' | 'pty' | 'native-pty';
  readonly timeoutMs: number;
  readonly retryLimit: number;
  readonly canonicalSpecPath: string;
  readonly repositoryPath: string;
  readonly worktreePath: string;
  readonly branchName: string;
  /** Compile-time tombstone: deprecated ContextEpoch can never be adapter input. */
  readonly contextEpoch?: never;
}

export type ManagedAdmissionBlockReason =
  | 'invalid_contract' | 'scope_mismatch' | 'revision_drift' | 'lease_inactive' | 'lease_expired'
  | 'capability_snapshot_stale' | 'capability_snapshot_mismatch' | 'dependency_missing'
  | 'dependency_unknown' | 'dependency_unavailable' | 'dependency_incompatible'
  | 'dependency_rate_limited' | 'dependency_circuit_open' | 'dependency_quota_exhausted'
  | 'dependency_degradation_forbidden' | 'quota_exhausted' | 'reservation_replay_conflict'
  | 'fence_lost' | 'cancelled' | 'dirty_worktree' | 'duplicate_launch' | 'passed_story';

export class ManagedAdmissionError extends Error {
  constructor(readonly reason: ManagedAdmissionBlockReason, message: string) {
    super(message);
    this.name = 'ManagedAdmissionError';
  }
}

export interface ManagedEngineRequest {
  readonly schemaVersion: typeof RORCA_MANAGED_EXECUTOR_VERSION;
  readonly requestHash: string;
  readonly workspaceId: string;
  readonly missionId: string;
  readonly missionRevision: number;
  readonly missionHash: string;
  readonly workPackageId: string;
  readonly workPackageRevision: number;
  readonly workPackageHash: string;
  readonly runId: number | string;
  readonly specId: string;
  readonly specVersion: number;
  readonly specHash: string;
  readonly storyId: string;
  readonly storyVersion: number;
  readonly storyHash: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly leaseExpiresAt: string;
  readonly runtimeId: string;
  readonly providerId: string;
  readonly agent: ManagedAgent;
  readonly model: string | null;
  readonly terminalMode: 'pipe' | 'pty' | 'native-pty';
  readonly timeoutMs: number;
  readonly retryLimit: number;
  readonly repositoryId: string;
  readonly baseSha: string;
  readonly currentSha: string;
  readonly expectedHeadSha: string;
  readonly worktreeId: string;
  readonly repositoryPath: string;
  readonly worktreePath: string;
  readonly canonicalSpecPath: string;
  readonly branchName: string;
  readonly allowedPathManifestHash: string;
  readonly requiredPathManifestHash: string;
  readonly changedPathManifestHash: string;
  readonly forbiddenPathManifestHash: string;
  readonly policyDefinitionHash: string;
  readonly policyActivationId: string;
  readonly policyActivationHash: string;
  readonly checkpointId: string;
  readonly checkpointHash: string;
  readonly retrievalReceiptId: string;
  readonly retrievalReceiptHash: string;
  readonly bundleId: string;
  readonly bundleHash: string;
  readonly continuationDispatchId: string | null;
  readonly continuationDispatchHash: string | null;
  readonly capabilitySnapshotId: string;
  readonly capabilitySnapshotHash: string;
  readonly capabilityPolicyVersion: string;
  readonly capabilityRequirementsHash: string;
  readonly quotaPolicyVersion: string;
  readonly quotaReservationId: string;
  readonly quota: ManagedQuotaVector;
  readonly degradedDependencies: readonly Readonly<{ dependencyId: string; dimensions: readonly string[] }>[];
  readonly parallelism: 1;
  readonly isolatedWorktree: true;
  readonly branchOnly: true;
  readonly autoMerge: false;
  readonly deploymentAuthority: false;
  readonly memoryAuthority: 'advisory_only';
}

export interface ManagedPreparation {
  readonly request: ManagedEngineRequest;
  readonly launchToken: string;
  readonly released: boolean;
  readonly replayed: boolean;
}

export type ManagedAttemptState =
  | 'prepared' | 'released' | 'running' | 'result_persisted' | 'closeout_pending'
  | 'cancelled' | 'expired' | 'lost' | 'conflicting' | 'quarantined';

export interface ManagedHostObservation {
  readonly live: boolean;
  readonly processIdentity: string | null;
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly outputHash: string | null;
  /** Durable process-group death receipt once quiescence is proven. */
  readonly deathReceiptHash?: string | null;
  readonly diagnosticCode: string | null;
}

export interface ManagedResultProposal {
  readonly schemaVersion: 'rorca.managed-result-proposal.v1';
  readonly requestHash: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'output_limited' | 'provider_failed' | 'validation_failed' | 'fenced';
  readonly evidenceHash: string;
  readonly hostObservationHash: string;
  readonly closeoutAuthority: 'none';
  readonly storyLifecycleAuthority: 'none';
  readonly mergeAuthority: 'none';
  readonly deploymentAuthority: 'none';
}

export interface ManagedRecoveryRecord {
  readonly request: ManagedEngineRequest;
  readonly state: ManagedAttemptState;
  readonly launchToken: string;
  readonly processIdentity: string | null;
  readonly resultProposal: ManagedResultProposal | null;
  readonly quarantined: boolean;
}

export interface ManagedExecutorStore {
  prepare(request: ManagedEngineRequest): Promise<ManagedPreparation>;
  revalidate(request: ManagedEngineRequest, phase: 'launch' | 'commit' | 'result' | 'closeout'): Promise<void>;
  transition(requestHash: string, from: readonly ManagedAttemptState[], to: ManagedAttemptState, evidenceHash?: string): Promise<boolean>;
  bindProcess(requestHash: string, processIdentity: string): Promise<void>;
  load(requestHash: string): Promise<ManagedRecoveryRecord | null>;
  listRecoverable(limit: number): Promise<readonly ManagedRecoveryRecord[]>;
  persistResult(proposal: ManagedResultProposal): Promise<{ duplicate: boolean }>;
}

export interface CurrentExecutionEngineBridge {
  launch(request: ManagedEngineRequest, launchToken: string): Promise<{ processIdentity: string }>;
  cancel(request: ManagedEngineRequest, reasonCode: string): Promise<ManagedHostObservation>;
  observe(request: ManagedEngineRequest): Promise<ManagedHostObservation>;
  terminate(request: ManagedEngineRequest, reasonCode: string): Promise<ManagedHostObservation>;
}

export interface ExecutionAdapter {
  readonly [MANAGED_EXECUTION_ADAPTER]: true;
  readonly name: string;
  readonly version: typeof RORCA_MANAGED_EXECUTOR_VERSION;
  prepare(input: ManagedExecutorCanonicalInput): Promise<ManagedPreparation>;
  launch(preparation: ManagedPreparation): Promise<{ processIdentity: string }>;
  cancel(requestHash: string, reasonCode: string): Promise<ManagedHostObservation>;
  observe(requestHash: string): Promise<ManagedHostObservation>;
  revalidateMutation(requestHash: string, phase: 'commit' | 'closeout'): Promise<void>;
  recover(limit?: number): Promise<readonly Readonly<{ requestHash: string; action: string }>[] >;
  proposeResult(requestHash: string, status: ManagedResultProposal['status'], evidenceHash: string): Promise<ManagedResultProposal>;
}

function sameRepository(left: MissionContractV1['repository'], right: MissionContractV1['repository']): boolean {
  return governedHash('rorca.managed-repository-scope.v1', left) === governedHash('rorca.managed-repository-scope.v1', right);
}

function asRunId(value: number | string): number | string { return value; }
function validTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ManagedAdmissionError('invalid_contract', 'canonical timestamp is invalid');
  return parsed;
}

function validateCapabilitySnapshot(
  snapshot: ManagedCapabilitySnapshot,
  policy: ManagedDegradationPolicy,
  requirements: ManagedCapabilityRequirements,
  now: number,
): readonly Readonly<{ dependencyId: string; dimensions: readonly string[] }>[] {
  if (snapshot.schemaVersion !== 'rorca.managed-capability-snapshot.v1' || snapshot.decisionSource !== 'canonical_snapshot') {
    throw new ManagedAdmissionError('capability_snapshot_mismatch', 'runtime selection requires a canonical capability snapshot');
  }
  if (validTime(snapshot.observedAt) > now || validTime(snapshot.validUntil) <= now) {
    throw new ManagedAdmissionError('capability_snapshot_stale', 'capability snapshot is outside its admission window');
  }
  const seen = new Set<string>();
  const degraded: Array<Readonly<{ dependencyId: string; dimensions: readonly string[] }>> = [];
  const expected = new Map<string, Readonly<{ requirement: DependencyRequirement; compatibleContractVersions: readonly string[] }>>();
  for (const item of requirements.required) {
    if (expected.has(item.dependencyId) || item.compatibleContractVersions.length === 0) throw new ManagedAdmissionError('invalid_contract', 'required capability expectations are duplicated or empty');
    expected.set(item.dependencyId,{ requirement:'required',compatibleContractVersions:item.compatibleContractVersions });
  }
  for (const item of requirements.advisory) {
    if (expected.has(item.dependencyId) || item.compatibleContractVersions.length === 0) throw new ManagedAdmissionError('invalid_contract', 'advisory capability expectations are duplicated or empty');
    expected.set(item.dependencyId,{ requirement:'advisory',compatibleContractVersions:item.compatibleContractVersions });
  }
  for (const dependency of snapshot.dependencies) {
    if (seen.has(dependency.dependencyId)) throw new ManagedAdmissionError('invalid_contract', 'duplicate dependency capability');
    seen.add(dependency.dependencyId);
    const expectedDependency = expected.get(dependency.dependencyId);
    if (!expectedDependency || expectedDependency.requirement !== dependency.requirement) {
      throw new ManagedAdmissionError('invalid_contract', `dependency ${dependency.dependencyId} is not declared with the exact requirement`);
    }
    if (validTime(dependency.observedAt) > now || validTime(dependency.validUntil) <= now) {
      throw new ManagedAdmissionError('capability_snapshot_stale', `dependency ${dependency.dependencyId} is stale`);
    }
    if (!expectedDependency.compatibleContractVersions.includes(dependency.contractVersion)) {
      throw new ManagedAdmissionError('dependency_incompatible', `dependency ${dependency.dependencyId} does not satisfy the adapter requirement`);
    }
    if (!dependency.compatibleContractVersions.includes(dependency.contractVersion)) {
      throw new ManagedAdmissionError('dependency_incompatible', `dependency ${dependency.dependencyId} contract is incompatible`);
    }
    if (dependency.status === 'unknown') throw new ManagedAdmissionError('dependency_unknown', `dependency ${dependency.dependencyId} status is unknown`);
    if (dependency.status === 'unavailable') throw new ManagedAdmissionError('dependency_unavailable', `dependency ${dependency.dependencyId} is unavailable`);
    if (dependency.rateLimit.remaining <= 0 && validTime(dependency.rateLimit.resetAt) > now) {
      throw new ManagedAdmissionError('dependency_rate_limited', `dependency ${dependency.dependencyId} has no rate-limit headroom`);
    }
    if (dependency.circuit.state === 'open') throw new ManagedAdmissionError('dependency_circuit_open', `dependency ${dependency.dependencyId} circuit is open`);
    if (!dependency.quota.available || dependency.quota.headroom <= 0) {
      throw new ManagedAdmissionError('dependency_quota_exhausted', `dependency ${dependency.dependencyId} quota is exhausted`);
    }
    if (dependency.status === 'degraded') {
      const dimensions = policy.allowed[dependency.dependencyId] ?? [];
      if (dimensions.length === 0) {
        throw new ManagedAdmissionError('dependency_degradation_forbidden', `dependency ${dependency.dependencyId} degradation is not policy-permitted`);
      }
      degraded.push(Object.freeze({ dependencyId: dependency.dependencyId, dimensions: Object.freeze([...dimensions].sort()) }));
    }
  }
  for (const [dependencyId, expectation] of expected) {
    if (seen.has(dependencyId)) continue;
    if (expectation.requirement === 'required') throw new ManagedAdmissionError('dependency_missing', `required dependency ${dependencyId} is missing`);
    const dimensions = policy.allowed[dependencyId] ?? [];
    if (!dimensions.includes('availability')) throw new ManagedAdmissionError('dependency_degradation_forbidden', `missing advisory dependency ${dependencyId} is not policy-permitted`);
    degraded.push(Object.freeze({ dependencyId,dimensions:Object.freeze([...dimensions].sort()) }));
  }
  return Object.freeze(degraded.sort((a, b) => a.dependencyId.localeCompare(b.dependencyId)));
}

export function normalizeManagedEngineRequest(input: ManagedExecutorCanonicalInput, now = Date.now()): ManagedEngineRequest {
  let mission: MissionContractV1;
  let workPackage: WorkPackageV1;
  let lease: ExecutionLeaseV1;
  let activation: ReturnType<typeof ContextPolicyActivationV1Schema.parse>;
  let checkpoint: ReturnType<typeof ContextCheckpointV1Schema.parse>;
  let receipt: ReturnType<typeof RetrievalReceiptV1Schema.parse>;
  let bundle: ReturnType<typeof ContextBundleV1Schema.parse>;
  let dispatch: ReturnType<typeof ContinuationDispatchV1Schema.parse> | undefined;
  try {
    mission = MissionContractV1Schema.parse(input.mission);
    workPackage = WorkPackageV1Schema.parse(input.workPackage);
    lease = ExecutionLeaseV1Schema.parse(input.lease);
    activation = ContextPolicyActivationV1Schema.parse(input.policyActivation);
    checkpoint = ContextCheckpointV1Schema.parse(input.checkpoint);
    receipt = RetrievalReceiptV1Schema.parse(input.retrievalReceipt);
    bundle = ContextBundleV1Schema.parse(input.contextBundle);
    dispatch = input.continuationDispatch === undefined ? undefined : ContinuationDispatchV1Schema.parse(input.continuationDispatch);
    assertNoForbiddenGovernedFields({ mission, workPackage, lease, activation, checkpoint, receipt, bundle, dispatch });
  } catch (error) {
    throw new ManagedAdmissionError('invalid_contract', error instanceof Error ? error.message : 'governed contract validation failed');
  }
  if (mission.contractVersion !== '1.0.0' || workPackage.contractVersion !== '1.0.0' || lease.contractVersion !== '1.0.0') {
    throw new ManagedAdmissionError('invalid_contract', 'unsupported managed-executor contract version');
  }
  if (mission.workspaceId !== workPackage.workspaceId || mission.workspaceId !== lease.workspaceId
      || mission.missionId !== workPackage.missionId || mission.missionId !== lease.missionId
      || mission.missionRevision !== workPackage.missionRevision || mission.missionRevision !== lease.missionRevision
      || mission.missionHash !== workPackage.missionHash || mission.missionHash !== lease.missionHash
      || workPackage.workPackageId !== lease.workPackageId || workPackage.workPackageRevision !== lease.workPackageRevision
      || workPackage.workPackageHash !== lease.workPackageHash) {
    throw new ManagedAdmissionError('scope_mismatch', 'mission, work-package, and lease identities differ');
  }
  if (!sameRepository(mission.repository, workPackage.repository) || !sameRepository(mission.repository, lease.repository)
      || mission.canonicalSpec.specHash !== workPackage.spec.specHash || mission.canonicalSpec.storyHash !== workPackage.spec.storyHash
      || mission.canonicalSpec.criteriaManifestHash !== workPackage.spec.criteriaManifestHash
      || mission.canonicalSpec.specHash !== lease.spec.specHash || mission.canonicalSpec.storyHash !== lease.spec.storyHash) {
    throw new ManagedAdmissionError('revision_drift', 'canonical spec, story, criteria, repository, or Git revision drifted');
  }
  if (lease.state !== 'active') throw new ManagedAdmissionError('lease_inactive', 'execution lease is not active');
  if (validTime(lease.expiresAt) <= now) throw new ManagedAdmissionError('lease_expired', 'execution lease expired before admission');
  if (activation.state !== 'active' || activation.workspaceId !== mission.workspaceId
      || activation.activationId !== lease.policyActivationId || activation.activationRevision !== lease.policyActivationRevision
      || activation.activationHash !== lease.policyActivationHash || activation.definitionHash !== lease.policyDefinitionHash) {
    throw new ManagedAdmissionError('scope_mismatch', 'active policy activation does not match lease');
  }
  if (checkpoint.scope.workspaceId !== mission.workspaceId || checkpoint.checkpointId !== lease.checkpointId
      || checkpoint.contentHash !== lease.checkpointHash || receipt.checkpointId !== checkpoint.checkpointId
      || receipt.scope.workspaceId !== mission.workspaceId || bundle.scope.workspaceId !== mission.workspaceId
      || bundle.checkpointId !== checkpoint.checkpointId || bundle.receiptId !== receipt.receiptId
      || bundle.bundleId !== lease.bundleId || bundle.bundleHash !== lease.bundleHash
      || bundle.activationHash !== activation.activationHash || receipt.activationHash !== activation.activationHash
      || bundle.state !== 'active' || validTime(bundle.expiresAt) <= now || !receipt.requiredComplete) {
    throw new ManagedAdmissionError('scope_mismatch', 'checkpoint, receipt, bundle, policy, or lease identity does not match');
  }
  if (dispatch && (dispatch.scope.workspaceId !== mission.workspaceId
      || dispatch.checkpointId !== checkpoint.checkpointId || dispatch.receiptId !== receipt.receiptId
      || dispatch.bundleId !== bundle.bundleId || dispatch.activationHash !== activation.activationHash
      || dispatch.targetSessionId !== checkpoint.scope.sessionId || dispatch.scope.leaseId !== lease.leaseId
      || dispatch.scope.fencingToken !== lease.fencingToken || dispatch.scope.attemptId !== lease.attemptId
      || dispatch.scope.runtimeGeneration !== input.generation)) {
    throw new ManagedAdmissionError('scope_mismatch', 'continuation dispatch is not bound to the exact managed generation');
  }
  if (input.capabilitySnapshot.workspaceId !== mission.workspaceId
      || input.capabilitySnapshot.runtimeId !== lease.runtimeId || input.capabilitySnapshot.role !== 'worker') {
    throw new ManagedAdmissionError('capability_snapshot_mismatch', 'worker capability snapshot scope does not match lease');
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 0 || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1
      || !Number.isSafeInteger(input.retryLimit) || input.retryLimit < 0 || input.retryLimit > workPackage.retryLimit) {
    throw new ManagedAdmissionError('invalid_contract', 'generation, timeout, or retry limit is invalid');
  }
  for (const [dimension, amount] of Object.entries(input.quota)) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new ManagedAdmissionError('invalid_contract', `${dimension} quota reservation is invalid`);
  }
  const degradedDependencies = validateCapabilitySnapshot(input.capabilitySnapshot, input.degradationPolicy, input.capabilityRequirements, now);
  const withoutHash = {
    schemaVersion: RORCA_MANAGED_EXECUTOR_VERSION,
    workspaceId: mission.workspaceId,
    missionId: mission.missionId,
    missionRevision: mission.missionRevision,
    missionHash: mission.missionHash,
    workPackageId: workPackage.workPackageId,
    workPackageRevision: workPackage.workPackageRevision,
    workPackageHash: workPackage.workPackageHash,
    runId: asRunId(lease.runId),
    specId: mission.canonicalSpec.specId,
    specVersion: mission.canonicalSpec.specVersion,
    specHash: mission.canonicalSpec.specHash,
    storyId: mission.canonicalSpec.storyId,
    storyVersion: mission.canonicalSpec.storyVersion,
    storyHash: mission.canonicalSpec.storyHash,
    attemptId: lease.attemptId,
    generation: input.generation,
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    leaseExpiresAt: lease.expiresAt,
    runtimeId: lease.runtimeId,
    providerId: input.capabilitySnapshot.providerId,
    agent: input.agent,
    model: input.model,
    terminalMode: input.terminalMode,
    timeoutMs: input.timeoutMs,
    retryLimit: input.retryLimit,
    repositoryId: lease.repository.repositoryId,
    baseSha: lease.repository.baseSha,
    currentSha: lease.repository.currentSha,
    expectedHeadSha: lease.repository.expectedHeadSha,
    worktreeId: lease.repository.worktreeId,
    repositoryPath: input.repositoryPath,
    worktreePath: input.worktreePath,
    canonicalSpecPath: input.canonicalSpecPath,
    branchName: input.branchName,
    allowedPathManifestHash: lease.repository.allowedPathManifestHash,
    requiredPathManifestHash: lease.repository.requiredPathManifestHash,
    changedPathManifestHash: lease.repository.changedPathManifestHash,
    forbiddenPathManifestHash: lease.repository.forbiddenPathManifestHash,
    policyDefinitionHash: lease.policyDefinitionHash,
    policyActivationId: activation.activationId,
    policyActivationHash: activation.activationHash,
    checkpointId: checkpoint.checkpointId,
    checkpointHash: checkpoint.contentHash,
    retrievalReceiptId: receipt.receiptId,
    retrievalReceiptHash: receipt.contentHash,
    bundleId: bundle.bundleId,
    bundleHash: bundle.bundleHash,
    continuationDispatchId: dispatch?.dispatchId ?? null,
    continuationDispatchHash: dispatch?.contentHash ?? null,
    capabilitySnapshotId: input.capabilitySnapshot.snapshotId,
    capabilitySnapshotHash: input.capabilitySnapshot.snapshotHash,
    capabilityPolicyVersion: input.capabilitySnapshot.policyVersion,
    capabilityRequirementsHash: governedHash('rorca.managed-capability-requirements.v1',input.capabilityRequirements as never),
    quotaPolicyVersion: input.quotaPolicyVersion,
    quotaReservationId: input.quotaReservationId,
    quota: Object.freeze({ ...input.quota }),
    degradedDependencies,
    parallelism: 1 as const,
    isolatedWorktree: true as const,
    branchOnly: true as const,
    autoMerge: false as const,
    deploymentAuthority: false as const,
    memoryAuthority: 'advisory_only' as const,
  };
  return Object.freeze({ ...withoutHash, requestHash: governedHash('rorca.managed-engine-request.v1', withoutHash as never) });
}

export class RorcaManagedExecutor implements ExecutionAdapter {
  readonly [MANAGED_EXECUTION_ADAPTER] = true as const;
  readonly name = 'RorcaManagedExecutor' as const;
  readonly version = RORCA_MANAGED_EXECUTOR_VERSION;
  constructor(
    private readonly store: ManagedExecutorStore,
    private readonly engine: CurrentExecutionEngineBridge,
    private readonly implementationGate: Wave3AImplementationGate,
    private readonly now: () => number = Date.now,
  ) {}

  async prepare(input: ManagedExecutorCanonicalInput): Promise<ManagedPreparation> {
    if (!this.implementationGate.accepted || this.implementationGate.executionAuthority !== 'none') {
      throw new ManagedAdmissionError('invalid_contract', 'Wave 3A exact prerequisite gate is not accepted');
    }
    return this.store.prepare(normalizeManagedEngineRequest(input, this.now()));
  }

  async launch(preparation: ManagedPreparation): Promise<{ processIdentity: string }> {
    if (!preparation.released) throw new ManagedAdmissionError('duplicate_launch', 'preparation has no released launch token');
    await this.store.revalidate(preparation.request, 'launch');
    if (!await this.store.transition(preparation.request.requestHash, ['released'], 'running')) {
      throw new ManagedAdmissionError('duplicate_launch', 'managed generation is already launched or fenced');
    }
    try {
      const launched = await this.engine.launch(preparation.request, preparation.launchToken);
      await this.store.bindProcess(preparation.request.requestHash, launched.processIdentity);
      return launched;
    } catch (error) {
      let observation: ManagedHostObservation;
      try {
        observation=await this.engine.terminate(preparation.request,'launch_or_process_binding_failed');
      } catch {
        await this.store.transition(preparation.request.requestHash,['running'],'conflicting');
        throw new ManagedAdmissionError('fence_lost','managed launch failed and process quiescence could not be proven');
      }
      if(observation.live){
        await this.store.transition(preparation.request.requestHash,['running'],'conflicting',observation.outputHash??undefined);
        throw new ManagedAdmissionError('fence_lost','managed launch failed while a child may still be live');
      }
      await this.store.transition(preparation.request.requestHash, ['running'], 'lost',observation.outputHash??undefined);
      throw error;
    }
  }

  private async exactRecord(requestHash: string): Promise<ManagedRecoveryRecord> {
    const record = await this.store.load(requestHash);
    if (!record || record.request.requestHash !== requestHash) throw new ManagedAdmissionError('fence_lost', 'managed attempt identity is unavailable');
    return record;
  }

  async cancel(requestHash: string, reasonCode: string): Promise<ManagedHostObservation> {
    const record = await this.exactRecord(requestHash);
    const observation = await this.engine.cancel(record.request, reasonCode);
    if(observation.live){
      await this.store.transition(requestHash,['prepared','released','running','lost'],'conflicting',observation.outputHash??undefined);
      throw new ManagedAdmissionError('fence_lost','managed cancellation could not prove process quiescence');
    }
    await this.store.transition(requestHash, ['prepared', 'released', 'running', 'lost'], 'cancelled', observation.outputHash ?? undefined);
    return observation;
  }

  async observe(requestHash: string): Promise<ManagedHostObservation> {
    return this.engine.observe((await this.exactRecord(requestHash)).request);
  }

  async revalidateMutation(requestHash: string, phase: 'commit' | 'closeout'): Promise<void> {
    const record=await this.exactRecord(requestHash);
    await this.store.revalidate(record.request,phase);
  }

  async proposeResult(requestHash: string, status: ManagedResultProposal['status'], evidenceHash: string): Promise<ManagedResultProposal> {
    const record = await this.exactRecord(requestHash);
    await this.store.revalidate(record.request, 'result');
    const observation = await this.engine.observe(record.request);
    if (record.state === 'cancelled' || record.state === 'expired' || record.state === 'conflicting' || record.state === 'quarantined') {
      throw new ManagedAdmissionError('fence_lost', 'fenced generation cannot propose a result');
    }
    if (observation.live) throw new ManagedAdmissionError('fence_lost', 'live process cannot propose a settled result');
    const hostObservationHash = governedHash('rorca.managed-host-observation.v1', observation as never);
    const proposal: ManagedResultProposal = Object.freeze({
      schemaVersion: 'rorca.managed-result-proposal.v1', requestHash, attemptId: record.request.attemptId,
      generation: record.request.generation, leaseId: record.request.leaseId, fencingToken: record.request.fencingToken,
      status, evidenceHash, hostObservationHash, closeoutAuthority: 'none', storyLifecycleAuthority: 'none',
      mergeAuthority: 'none', deploymentAuthority: 'none',
    });
    await this.store.persistResult(proposal);
    await this.store.transition(requestHash, ['running', 'lost'], 'result_persisted', evidenceHash);
    return proposal;
  }

  async recover(limit = 100): Promise<readonly Readonly<{ requestHash: string; action: string }>[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const actions: Array<Readonly<{ requestHash: string; action: string }>> = [];
    for (const record of await this.store.listRecoverable(boundedLimit)) {
      const requestHash = record.request.requestHash;
      if (record.quarantined || record.state === 'conflicting') { actions.push({ requestHash, action: 'blocked_for_reconciliation' }); continue; }
      if (record.state === 'result_persisted' || record.state === 'closeout_pending') { actions.push({ requestHash, action: 'resume_idempotent_closeout' }); continue; }
      if (record.state === 'prepared') { actions.push({ requestHash, action: 'prepared_not_released' }); continue; }
      if (record.state === 'cancelled' || record.state === 'expired') { actions.push({ requestHash, action: 'terminal_no_relaunch' }); continue; }
      const observation = await this.engine.observe(record.request);
      if (record.state === 'running' && observation.live && record.processIdentity !== null && observation.processIdentity === record.processIdentity) {
        actions.push({ requestHash, action: 'observe_live' });
      } else if (record.state === 'running' || record.state === 'lost') {
        if (observation.live) await this.engine.terminate(record.request, 'stale_or_ambiguous_generation');
        await this.store.transition(requestHash, ['running', 'lost'], 'expired', observation.outputHash ?? undefined);
        actions.push({ requestHash, action: 'expire_preserve_evidence' });
      }
    }
    return Object.freeze(actions);
  }
}

export interface ManagedFallbackInput {
  readonly prior: ManagedEngineRequest;
  readonly fallbackSnapshot: ManagedCapabilitySnapshot;
  readonly newAttemptId: string;
  readonly newGeneration: number;
  readonly newLeaseId: string;
  readonly newFence: number;
  readonly exactCompatiblePassExists: boolean;
  readonly supervisorSnapshot?: ManagedCapabilitySnapshot;
}

/** Provider fallback is a new fenced attempt, never an in-attempt provider switch. */
export function authorizeConservativeManagedFallback(input: ManagedFallbackInput, now = Date.now()): Readonly<{
  allowed: true; attemptId: string; generation: number; leaseId: string; fencingToken: number; providerId: string;
  branchOnly: true; autoMerge: false; deploymentAuthority: false;
}> {
  if (input.exactCompatiblePassExists) throw new ManagedAdmissionError('passed_story', 'exact compatible passed story cannot be retried');
  if (input.newAttemptId === input.prior.attemptId || input.newGeneration <= input.prior.generation
      || input.newLeaseId === input.prior.leaseId || input.newFence <= input.prior.fencingToken) {
    throw new ManagedAdmissionError('fence_lost', 'fallback requires a new attempt, generation, lease, and fence');
  }
  if (input.fallbackSnapshot.role !== 'worker' || input.fallbackSnapshot.workspaceId !== input.prior.workspaceId
      || input.fallbackSnapshot.providerId === input.prior.providerId) {
    throw new ManagedAdmissionError('capability_snapshot_mismatch', 'fallback requires its own worker provider snapshot');
  }
  if (input.supervisorSnapshot && (
      input.fallbackSnapshot.principalId === input.supervisorSnapshot.principalId
      || input.fallbackSnapshot.providerAuthReferenceId === input.supervisorSnapshot.providerAuthReferenceId
      || input.fallbackSnapshot.providerBudgetId === input.supervisorSnapshot.providerBudgetId
      || input.fallbackSnapshot.rateLimitIdentity === input.supervisorSnapshot.rateLimitIdentity
      || input.fallbackSnapshot.circuitIdentity === input.supervisorSnapshot.circuitIdentity
      || input.fallbackSnapshot.processIdentity === input.supervisorSnapshot.processIdentity
      || input.fallbackSnapshot.queueIdentity === input.supervisorSnapshot.queueIdentity)) {
    throw new ManagedAdmissionError('capability_snapshot_mismatch', 'worker fallback cannot reuse supervisor identity, auth reference, budget, rate-limit, circuit, process, or queue');
  }
  validateCapabilitySnapshot(input.fallbackSnapshot, { policyVersion: input.fallbackSnapshot.policyVersion, allowed: {} }, {
    required:input.fallbackSnapshot.dependencies.filter((dependency)=>dependency.requirement==='required').map((dependency)=>({dependencyId:dependency.dependencyId,compatibleContractVersions:dependency.compatibleContractVersions})),
    advisory:input.fallbackSnapshot.dependencies.filter((dependency)=>dependency.requirement==='advisory').map((dependency)=>({dependencyId:dependency.dependencyId,compatibleContractVersions:dependency.compatibleContractVersions})),
  }, now);
  return Object.freeze({ allowed: true, attemptId: input.newAttemptId, generation: input.newGeneration,
    leaseId: input.newLeaseId, fencingToken: input.newFence, providerId: input.fallbackSnapshot.providerId,
    branchOnly: true, autoMerge: false, deploymentAuthority: false });
}
