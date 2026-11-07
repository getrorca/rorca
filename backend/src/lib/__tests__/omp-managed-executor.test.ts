/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ContextBundleV1Schema, ContextCheckpointV1Schema, ContextPolicyActivationV1Schema, ExecutionLeaseV1Schema,
  MissionContractV1Schema, RetrievalReceiptV1Schema, WorkPackageV1Schema,
} from '../governed-contracts';
import {
  MANAGED_EXECUTION_ADAPTER, ManagedAdmissionError, normalizeManagedEngineRequest,
  type ManagedCapabilitySnapshot, type ManagedExecutorCanonicalInput, type ManagedExecutorStore,
  type ManagedPreparation, type ManagedRecoveryRecord, type ManagedResultProposal,
} from '../rorca-managed-executor';
import {
  buildOmpChildEnv, OmpManagedExecutor, OmpManagedProcessBridge, type OmpManagedLaunchOptions,
} from '../omp-managed-executor';
import {
  projectOmpOrchestrationEvent, type OmpOrchestrationInput, type OrchestrationEventV1, type OrchestrationEventWriter,
} from '../omp-orchestration-events';
import {
  WAVE3A_COMPLETION_MIGRATION, WAVE3A_CONTRACT_PACKAGE_VERSION, WAVE3A_CONTRACT_SOURCE_SHA, WAVE3A_SPEC_SHA,
  WAVE3A_WAVE2_IMPLEMENTATION_SHA, WAVE3A_WAVE2_MIGRATION_HEAD, WAVE3A_WAVE2_SPEC_SHA,
  verifyWave3AImplementationPrerequisites, type Wave3AExactPrerequisitePacket, type Wave3AImplementationGate,
} from '../wave3a-managed-executor-gate';

// The central sandbox seam: record every launch request (env + args) and pass
// the launch through unchanged so the fake omp fixture still exercises the
// real RPC transport.
let sandboxLaunchError: Error | null = null;
let lastModelLaunch: {
  modelEgressSocket: string; closeModelEgress: () => Promise<void>;
  args: readonly string[]; env: Record<string, string>; modelCredentials?: boolean;
} | null = null;
const mockPrepareAutonomousSandboxLaunch = jest.fn((options: {
  command: string; args: readonly string[]; cwd: string; env: Record<string, string>; modelCredentials?: boolean;
}) => {
  if (sandboxLaunchError) throw sandboxLaunchError;
  const launch = {
    command: options.command, args: [...options.args], cwd: options.cwd, env: options.env, isolated: true,
    modelCredentials: options.modelCredentials,
    modelEgressSocket: '/tmp/fake-omp-egress.sock',
    closeModelEgress: jest.fn(async () => {}),
  };
  lastModelLaunch = launch;
  return launch;
});
jest.mock('../autonomous-sandbox', () => ({
  prepareAutonomousSandboxLaunch: (options: {
    command: string; args: readonly string[]; cwd: string; env: Record<string, string>; modelCredentials?: boolean;
  }) => mockPrepareAutonomousSandboxLaunch(options),
}));

const hash = (digit: string) => `sha256:${digit.repeat(64)}`;
const git = (digit: string) => digit.repeat(40);
const now = '2026-08-05T10:00:00.000Z';
const future = '2026-08-05T11:00:00.000Z';
const workspaceId = 'workspace-omp-test';
const attemptId = 'attempt:omp-test';

function header(schemaVersion: string, artifactId: string, contentHash: string) {
  return { schemaVersion, contractId: schemaVersion, contractVersion: '1.0.0', artifactId, contentHash, createdAt: now, createdBy: 'host:omp-test' };
}

const spec = { specId: 'spec:omp-test', specVersion: 1, specHash: hash('1'), canonicalSpecPath: 'forge/specs/managed.json',
  storyId: 'story:omp-test', storyVersion: 1, storyHash: hash('2'), criteriaManifestHash: hash('3') };
const repository = { repositoryId: 'repository:omp-test', remoteAuthorityHash: hash('4'), gitObjectFormat: 'sha1' as const,
  baseSha: git('a'), currentSha: git('a'), expectedHeadSha: git('a'), worktreeId: 'worktree:omp-test',
  allowedPathManifestHash: hash('5'), requiredPathManifestHash: hash('6'), changedPathManifestHash: hash('7'), forbiddenPathManifestHash: hash('8') };
const missionHash = hash('9');
const workPackageHash = hash('a');
const policyDefinitionHash = hash('b');
const activationHash = hash('c');
const checkpointHash = hash('d');
const receiptHash = hash('e');
const bundleHash = hash('f');

const mission = MissionContractV1Schema.parse({
  ...header('rorca.mission-contract.v1', 'artifact:mission', missionHash), missionId: 'mission:omp-test', missionRevision: 1, missionHash, workspaceId, canonicalSpec: spec,
  requirements: { ids: ['requirement:one'], hash: hash('1') }, criteria: { ids: ['criterion:one'], hash: hash('2') }, objectivesHash: hash('3'),
  invariantsHash: hash('4'), constraintsHash: hash('5'), prohibitedOutcomesHash: hash('6'), evidenceObligationsHash: hash('7'), completionDefinitionHash: hash('8'),
  repository, compiler: { id: 'compiler:v1', revision: 1, hash: hash('9') }, policy: { id: 'policy:mission', revision: 1, hash: hash('a') },
  contextPolicyDefinition: { id: 'policy:context', revision: 1, hash: policyDefinitionHash }, approvedDecisionReferences: [],
  allowedExecutionPosture: { sequential: true, branchOnly: true, autoMerge: false, deployment: false, providerMutation: false, execution: 'execute_bounded' },
  directionLayerHashes: [], sourceManifestHash: hash('b'), creationProvenanceHash: hash('c'),
});
const workPackage = WorkPackageV1Schema.parse({
  ...header('rorca.work-package.v1', 'artifact:work-package', workPackageHash), workspaceId, missionId: mission.missionId, missionRevision: 1, missionHash,
  workPackageId: 'work-package:omp-test', workPackageRevision: 1, workPackageHash, spec, objectiveHash: hash('d'), dependencies: [], repository,
  allowedPaths: ['backend/src/lib'], requiredPaths: ['backend/src/lib'], validationObligationsHash: hash('e'), evidenceObligationsHash: hash('f'),
  executionPostureHash: hash('1'), lifecycleProjectionRef: 'lifecycle:omp-test', authorityCeilings: { delivery: 'execute_bounded', operational: 'none', knowledge: 'none', interactive: 'none' },
  resourceLimitsHash: hash('2'), retryLimit: 2, planRevision: 1, state: 'active', proposalId: 'proposal:omp-test',
});
const lease = ExecutionLeaseV1Schema.parse({
  ...header('rorca.execution-lease.v1', 'artifact:lease', hash('3')), workspaceId, missionId: mission.missionId, missionRevision: 1, missionHash,
  workPackageId: workPackage.workPackageId, workPackageRevision: 1, workPackageHash, spec, leaseId: 'lease:omp-test', attemptId, runId: 41, fencingToken: 3,
  runtimeId: 'runtime:omp-test', runtimeCapabilityRevision: 1, repository,
  policyDefinitionId: 'policy:context', policyDefinitionVersion: '1.0.0', policyDefinitionHash, policyActivationId: 'activation:omp-test', policyActivationRevision: 1,
  policyActivationHash: activationHash, checkpointId: 'checkpoint:omp-test', checkpointHash, bundleId: 'bundle:omp-test', bundleHash,
  cancellationId: 'cancellation:none', issuedAt: now, observedAt: now, expiresAt: future, resourceLimitsHash: hash('4'), evidenceObligationDigest: hash('5'),
  authorityCeilings: { mutation: 'execute_bounded', delivery: 'execute_bounded', operational: 'none', knowledge: 'none', interactive: 'none' }, state: 'active', reasonCode: 'lease:active',
});
const activationScope = { workspaceId, missionId: mission.missionId, missionRevision: 1, missionHash, workPackageId: workPackage.workPackageId, workPackageRevision: 1, workPackageHash, spec, runId: 41, attemptId,
  leaseId: lease.leaseId, fencingToken: 3, cancellationId: 'cancellation:none', runtimeId: lease.runtimeId, repositoryId: repository.repositoryId, remoteAuthorityHash: repository.remoteAuthorityHash,
  baseSha: repository.baseSha, worktreeId: repository.worktreeId, allowedPathManifestHash: repository.allowedPathManifestHash,
  requiredPathManifestHash: repository.requiredPathManifestHash, policyDefinitionId: 'policy:context', policyDefinitionVersion: '1.0.0', policyDefinitionHash };
const activation = ContextPolicyActivationV1Schema.parse({
  ...header('rorca.context-continuation-policy-activation.v1', 'artifact:activation', activationHash), workspaceId, activationId: 'activation:omp-test',
  activationRevision: 1, activationHash, definitionId: 'policy:context', definitionVersion: '1.0.0', definitionHash: policyDefinitionHash, scope: activationScope,
  effectiveValuesHash: hash('6'), authorityReceiptId: 'receipt:policy-activation', activatedAt: now, expiresAt: future, state: 'active',
});
const continuationScope = { workspaceId, missionId: mission.missionId, missionRevision: 1, missionHash, workPackageId: workPackage.workPackageId, workPackageRevision: 1, workPackageHash, spec, runId: 41, attemptId,
  leaseId: lease.leaseId, fencingToken: 3, leaseExpiresAt: future, cancellationId: 'cancellation:none', runtimeId: lease.runtimeId, controllerGeneration: 0, runtimeGeneration: 0,
  sessionId: 'session:omp-test', sessionFileHash: hash('7'), turnId: 'turn:omp-test', turnAttempt: 1, originatingGeneration: 0, cursor: 1, cursorHash: hash('8'),
  priorEntryId: 'entry:prior', repository, validationStateHash: hash('9'), rootCauseClassification: 'root-cause:none', rootCauseHash: hash('a'),
  policyDefinitionId: 'policy:context', policyDefinitionVersion: '1.0.0', policyDefinitionHash, policyActivationId: 'activation:omp-test', policyActivationRevision: 1, policyActivationHash: activationHash };
const checkpoint = ContextCheckpointV1Schema.parse({
  ...header('rorca.context-checkpoint.v1', 'artifact:checkpoint', checkpointHash), scope: continuationScope, checkpointId: 'checkpoint:omp-test', checkpointSequence: 1,
  priorCheckpointId: 'not_applicable', reasonCode: 'initial:dispatch', trigger: { type: 'initial_dispatch', launchRequestId: 'launch:omp-test', launchRequestHash: hash('b'),
    engineRequestId: 'engine-request:omp-test', engineRequestHash: hash('c'), sourceManifestHash: hash('d') }, eventHighWaterMark: 0, planCursorHash: hash('e'),
  completedWorkHash: hash('f'), pendingWorkHash: hash('1'), boundedReferences: [], retry: { retryCycleId: 'not_applicable', phase: 'none', attempt: 0, maximum: 2,
    startEventHash: 'not_applicable', endEventHash: 'not_applicable', settledEventHash: 'not_applicable', generation: 0 },
  completionCandidate: { state: 'absent', hash: 'not_applicable' }, redactionManifestHash: hash('2'), state: 'current',
});
const source = { contextClass: 'required' as const, sourceType: 'source:spec', stableSourceId: 'source:omp-test', sourceVersion: '1', contentHash: hash('3'),
  freshness: 'current' as const, excluded: false, redactionHash: hash('4') };
const receipt = RetrievalReceiptV1Schema.parse({
  ...header('rorca.retrieval-receipt.v1', 'artifact:receipt', receiptHash), scope: continuationScope, requestId: 'retrieval:omp-test', receiptId: 'receipt:omp-test',
  checkpointId: checkpoint.checkpointId, definitionHash: policyDefinitionHash, activationHash, retrievalKey: hash('5'), sources: [source], requiredComplete: true,
  tokenAccounting: { required: 10, advisory: 0, instructions: 2, total: 12 }, outputId: 'output:omp-test', outputHash: hash('6'), startedAt: now, finishedAt: now,
  status: 'completed', reasonCode: 'retrieval:complete', retryable: false, retryBudgetId: 'retry-budget:omp-test',
});
const bundle = ContextBundleV1Schema.parse({
  ...header('rorca.context-bundle.v1', 'artifact:bundle', bundleHash), scope: continuationScope, bundleId: 'bundle:omp-test', bundleVersion: 1, bundleHash,
  checkpointId: checkpoint.checkpointId, checkpointHash, receiptId: receipt.receiptId, receiptHash, definitionHash: policyDefinitionHash, activationHash,
  requiredContext: [source], advisoryMemory: [], orderedSourceHash: hash('7'), redactionManifestHash: hash('8'), tokenAllocationHash: hash('9'),
  tokenAccounting: { required: 10, advisory: 0, instructions: 2, total: 12 }, serializedBytes: 200, expiresAt: future, state: 'active',
});

function capability(): ManagedCapabilitySnapshot {
  return {
    schemaVersion: 'rorca.managed-capability-snapshot.v1', snapshotId: 'snapshot:worker', snapshotHash: hash('a'), policyVersion: 'capability-policy:1', workspaceId,
    runtimeId: lease.runtimeId, providerId: 'provider:omp', role: 'worker', principalId: 'principal:worker', providerAuthReferenceId: 'auth-ref:worker',
    providerBudgetId: 'budget:worker', rateLimitIdentity: 'rate:worker', circuitIdentity: 'circuit:worker', processIdentity: 'process:worker', queueIdentity: 'queue:worker',
    observedAt: now, validUntil: future, decisionSource: 'canonical_snapshot', dependencies: [{ dependencyId: 'dependency:context', requirement: 'required', contractVersion: '1.0.0', compatibleContractVersions: ['1.0.0'],
      status: 'healthy', observedAt: now, validUntil: future, rateLimit: { remaining: 10, resetAt: future }, circuit: { state: 'closed', revision: 1 }, quota: { available: true, headroom: 10 },
      fallback: { eligible: false, runtimeId: null } }],
  };
}
const quota = { cpuMillis: 100, memoryBytes: 1024, executionConcurrency: 1, continuationConcurrency: 1, eventCount: 100, contextBytes: 4096, contextTokens: 100,
  storageBytes: 4096, storageObjects: 5, retrySpend: 1, providerTokens: 100, providerMicrounits: 100 } as const;

function canonicalInput(agent: ManagedExecutorCanonicalInput['agent'] = 'omp'): ManagedExecutorCanonicalInput {
  return { mission, workPackage, lease, policyActivation: activation, checkpoint, retrievalReceipt: receipt, contextBundle: bundle, capabilitySnapshot: capability(),
    degradationPolicy: { policyVersion: 'capability-policy:1', allowed: {} }, capabilityRequirements: { required: [{ dependencyId: 'dependency:context', compatibleContractVersions: ['1.0.0'] }], advisory: [] },
    quotaPolicyVersion: 'quota-policy:1', quotaReservationId: 'reservation:omp-test', quota,
    generation: 0, agent, model: null, terminalMode: 'pipe', timeoutMs: 1000, retryLimit: 2, canonicalSpecPath: spec.canonicalSpecPath,
    repositoryPath: '/tmp/repository-omp', worktreePath: '/tmp/repository-omp/worktree', branchName: 'wave5b-omp-test' };
}

const packet: Wave3AExactPrerequisitePacket = {
  schemaVersion: 'rorca.wave3a-prerequisite-packet.v1', wave2SpecSha: WAVE3A_WAVE2_SPEC_SHA, contractPackageVersion: WAVE3A_CONTRACT_PACKAGE_VERSION,
  contractSourceSha: WAVE3A_CONTRACT_SOURCE_SHA, migrationHead: WAVE3A_WAVE2_MIGRATION_HEAD, completionMigration: WAVE3A_COMPLETION_MIGRATION,
  implementationGitSha: WAVE3A_WAVE2_IMPLEMENTATION_SHA, conformance: { outcome: 'passed', receiptHash: hash('b'), exactSha: WAVE3A_WAVE2_IMPLEMENTATION_SHA },
  independentReview: { outcome: 'accepted', receiptHash: hash('c'), reviewerId: 'reviewer:independent', implementationActorId: 'actor:implementer', exactSha: WAVE3A_WAVE2_IMPLEMENTATION_SHA },
  activeImplementationWaves: ['ROR-25', 'ROR-28'], ownership: { ror28Root: '/private/tmp/rorca-wave3a-ror28-20260805',
    serializedPaths: ['packages/rorca-public-contract', 'scripts/generate-governed-contract-artifacts.ts', 'generated schemas', 'docs/implementation/governed-mission-waves-coverage.json'],
    overlapDecision: 'serialized_integration_only' }, wave3aSpecSha: WAVE3A_SPEC_SHA,
};

class CaptureOrchestrationWriter implements OrchestrationEventWriter {
  readonly records: OrchestrationEventV1[] = [];
  async append(input: OmpOrchestrationInput) {
    const payload = projectOmpOrchestrationEvent(input, this.records.length + 1);
    this.records.push(payload);
    return { payload, duplicate: false, walEventId: this.records.length };
  }
}

class MemoryStore implements ManagedExecutorStore {
  record: ManagedRecoveryRecord | null = null;
  async prepare(request: Parameters<ManagedExecutorStore['prepare']>[0]): Promise<ManagedPreparation> {
    if (this.record) return { request, launchToken: this.record.launchToken, released: true, replayed: true };
    this.record = { request, state: 'released', launchToken: '11111111-1111-4111-8111-111111111111', processIdentity: null, resultProposal: null, quarantined: false };
    return { request, launchToken: this.record.launchToken, released: true, replayed: false };
  }
  async revalidate(): Promise<void> {}
  async transition(_hash: string, from: readonly string[], to: Parameters<ManagedExecutorStore['transition']>[2]): Promise<boolean> {
    if (!this.record || !from.includes(this.record.state)) return false;
    this.record = { ...this.record, state: to };
    return true;
  }
  async bindProcess(_hash: string, processIdentity: string): Promise<void> { if (this.record) this.record = { ...this.record, processIdentity }; }
  async load(): Promise<ManagedRecoveryRecord | null> { return this.record; }
  async listRecoverable(): Promise<readonly ManagedRecoveryRecord[]> { return this.record ? [this.record] : []; }
  async persistResult(proposal: ManagedResultProposal): Promise<{ duplicate: boolean }> { if (this.record) this.record = { ...this.record, resultProposal: proposal }; return { duplicate: false }; }
}

const fakeOmpBin = path.join(__dirname, 'fixtures', 'fake-omp.sh');

function bridgeOptions(overrides: Partial<OmpManagedLaunchOptions> = {}): OmpManagedLaunchOptions {
  return {
    bin: fakeOmpBin,
    ompVersion: '17.0.9',
    trustedEnvironment: { ...process.env, GITHUB_TOKEN: 'must-be-removed', RORCA_WAVE_PRODUCTION_ACTIVATION_KEY: 'must-be-removed' },
    terminationGraceMs: 500,
    killProofTimeoutMs: 500,
    ...overrides,
  };
}

async function worktreeFixture(): Promise<string> {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-omp-managed-test-'));
}

/** Drive the fake omp fixture through a control file in the worktree. */
function writeFakeControl(root: string, mode: string): void {
  fs.mkdirSync(path.join(root, '.rorca'), { recursive: true });
  fs.writeFileSync(path.join(root, '.rorca', 'fake-omp-control'), `${mode}\n`);
}

describe('OmpManagedExecutor canonical boundary', () => {
  test('launches through the fake omp rpc handshake and pins the omp version in the process identity', async () => {
    const root = await worktreeFixture();
    try {
      const store = new MemoryStore();
      const executor = new OmpManagedExecutor(store, new OmpManagedProcessBridge(bridgeOptions()), verifyWave3AImplementationPrerequisites(packet), {
        ompInstalled: true, ompVersion: '17.0.9', ompBinPath: fakeOmpBin,
      }, () => Date.parse(now) + 1);
      const prepared = await executor.prepare({ ...canonicalInput(), repositoryPath: root, worktreePath: root });
      const launched = await executor.launch(prepared);
      expect(launched.processIdentity).toMatch(/^managed-omp:v17\.0\.9:\d+:/);
      // The managed story message file was materialized inside the worktree.
      expect(fs.readdirSync(path.join(root, '.rorca', 'omp-managed')).length).toBeGreaterThan(0);
      // The fake self-exits after the handshake; the observed close is hashed
      // and the child is quiesced.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const observation = await executor.observe(prepared.request.requestHash);
      expect(observation.live).toBe(false);
      expect(observation.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('is an ExecutionAdapter with the omp name and nominal symbol', () => {
    const executor = new OmpManagedExecutor(new MemoryStore(), new OmpManagedProcessBridge(bridgeOptions()), verifyWave3AImplementationPrerequisites(packet), {
      ompInstalled: true, ompVersion: '17.0.9', ompBinPath: fakeOmpBin,
    });
    expect(executor[MANAGED_EXECUTION_ADAPTER]).toBe(true);
    expect(executor.name).toBe('OmpManagedExecutor');
    expect(executor.version).toBe('rorca.managed-executor.v1');
  });

  test('normalizes omp symmetrically with ROR-28 admission and no raw context in the request', () => {
    const first = normalizeManagedEngineRequest(canonicalInput('omp'), Date.parse(now) + 1);
    const second = normalizeManagedEngineRequest(canonicalInput('omp'), Date.parse(now) + 1);
    expect(second.requestHash).toBe(first.requestHash);
    expect(first).toMatchObject({ agent: 'omp', parallelism: 1, isolatedWorktree: true, branchOnly: true, autoMerge: false });
    expect(JSON.stringify(first)).not.toMatch(/contextEpoch|password|secret|authorization|rawPrompt|rawTranscript/i);
  });

  test('builds an explicit minimal child env allowlist with no worker secrets', () => {
    const env = buildOmpChildEnv(bridgeOptions().trustedEnvironment, {
      workspaceId, requestHash: hash('1'), attemptId, generation: 0, leaseId: lease.leaseId, fencingToken: 3,
      capabilitySnapshotHash: hash('2'), quotaReservationId: 'reservation:omp-test',
    });
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.RORCA_WAVE_PRODUCTION_ACTIVATION_KEY).toBeUndefined();
    expect(env.OMP_PROFILE).toBeUndefined();
    expect(env.PI_SMOL_MODEL).toBeUndefined();
  });
  test.each([
    ['Darwin ordinary-local', 'darwin-profile-v3'],
    ['Linux bwrap', undefined],
  ])('crosses the Pi sandbox seam for %s with brokered model credentials', async (_posture, ordinaryProfile) => {

    const root = await worktreeFixture();
    try {
      const request = normalizeManagedEngineRequest({ ...canonicalInput(), repositoryPath: root, worktreePath: root }, Date.parse(now) + 1);
      const bridge = new OmpManagedProcessBridge(bridgeOptions({ trustedEnvironment: {
        ...process.env,
        GITHUB_TOKEN: 'secret',
        ANTHROPIC_API_KEY: 'brokered-key',
        // Override any profile inherited by the focused test runner so the
        // Linux case verifies an actually profile-free bwrap request.
        RORCA_ORDINARY_LOCAL_PI_PROFILE: ordinaryProfile,
      } }));
      await bridge.launch(request, 'launch-token:seam');
      const launch = lastModelLaunch!;
      // The launch crosses the central model-egress broker (async sandbox
      // seam), which supplies the operation-owned egress socket.
      expect(launch.modelEgressSocket).toBe('/tmp/fake-omp-egress.sock');
      expect(launch.modelCredentials).toBe(true);
      expect(launch.env.RORCA_ORDINARY_LOCAL_PI_PROFILE).toBe(ordinaryProfile);
      expect(launch.args).toContain('--no-extensions');
      expect(launch.args).toContain('--mode');
      // Worker secrets never enter the child env fixture; only the brokered
      // model credential may cross.
      expect(launch.env.GITHUB_TOKEN).toBeUndefined();
      expect(launch.env.RORCA_WAVE_PRODUCTION_ACTIVATION_KEY).toBeUndefined();
      expect(launch.env.ANTHROPIC_API_KEY).toBe('brokered-key');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed with a durable diagnostic when sandbox preparation refuses launch', async () => {
    const root = await worktreeFixture();
    try {
      const request = normalizeManagedEngineRequest({ ...canonicalInput(), repositoryPath: root, worktreePath: root }, Date.parse(now) + 1);
      const bridge = new OmpManagedProcessBridge(bridgeOptions());
      mockPrepareAutonomousSandboxLaunch.mockClear();
      sandboxLaunchError = new Error('sandbox boundary unavailable');
      await expect(bridge.launch(request, 'launch-token:denied')).rejects.toThrow('sandbox boundary unavailable');
      const diagnostic = fs.readdirSync(path.join(root, '.rorca', 'omp-managed'))
        .find((filename) => filename.endsWith('.launch-failure.json'));
      expect(diagnostic).toBeDefined();
      expect(JSON.parse(fs.readFileSync(path.join(root, '.rorca', 'omp-managed', diagnostic!), 'utf8')))
        .toMatchObject({ schemaVersion: 'rorca.omp-launch-failure.v1', code: 'omp_sandbox_launch_failed', requestHash: request.requestHash });
      // A refusal never falls through to a second/raw launch attempt.
      expect(mockPrepareAutonomousSandboxLaunch).toHaveBeenCalledTimes(1);
    } finally {
      sandboxLaunchError = null;
      mockPrepareAutonomousSandboxLaunch.mockClear();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when omp crashes during startup', async () => {
    const root = await worktreeFixture();
    try {
      writeFakeControl(root, 'crash');
      const store = new MemoryStore();
      const executor = new OmpManagedExecutor(store, new OmpManagedProcessBridge(bridgeOptions()),
        verifyWave3AImplementationPrerequisites(packet), { ompInstalled: true, ompVersion: '17.0.9', ompBinPath: fakeOmpBin }, () => Date.parse(now) + 1);
      const prepared = await executor.prepare({ ...canonicalInput(), repositoryPath: root, worktreePath: root });
      await expect(executor.launch(prepared)).rejects.toThrow();
      expect(store.record?.state).toBe('lost');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('cancel proves quiescence and transitions to cancelled with hashed output evidence', async () => {
    const root = await worktreeFixture();
    try {
      const store = new MemoryStore();
      const executor = new OmpManagedExecutor(store, new OmpManagedProcessBridge(bridgeOptions()), verifyWave3AImplementationPrerequisites(packet), {
        ompInstalled: true, ompVersion: '17.0.9', ompBinPath: fakeOmpBin,
      }, () => Date.parse(now) + 1);
      const prepared = await executor.prepare({ ...canonicalInput(), repositoryPath: root, worktreePath: root });
      await executor.launch(prepared);
      const observation = await executor.cancel(prepared.request.requestHash, 'operator-cancel');
      expect(observation.live).toBe(false);
      expect(observation.diagnosticCode).toMatch(/^cancelled:operator-cancel/);
      expect(observation.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(observation.deathReceiptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(store.record?.state).toBe('cancelled');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a child that ignores TERM yields dead:false until the observed KILL close', async () => {
    const root = await worktreeFixture();
    try {
      writeFakeControl(root, 'ignore-term');
      const request = normalizeManagedEngineRequest({ ...canonicalInput(), repositoryPath: root, worktreePath: root }, Date.parse(now) + 1);
      const bridge = new OmpManagedProcessBridge(bridgeOptions({ terminationGraceMs: 300, killProofTimeoutMs: 500 }));
      await bridge.launch(request, 'launch-token:death');
      // Protocol has not settled and the OS child is still alive.
      let observation = await bridge.observe(request);
      expect(observation.live).toBe(true);
      // TERM is ignored: quiescence cannot be proven by TERM alone — the bridge
      // must escalate to KILL and wait for the observed close before death.
      observation = await bridge.cancel(request, 'term-ignored');
      expect(observation.live).toBe(false);
      expect(observation.deathReceiptHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(observation.diagnosticCode).not.toContain('quiescence_unproven');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('proposes a fenced result with evidence after the child settles', async () => {
    const root = await worktreeFixture();
    try {
      const store = new MemoryStore();
      const executor = new OmpManagedExecutor(store, new OmpManagedProcessBridge(bridgeOptions()), verifyWave3AImplementationPrerequisites(packet), {
        ompInstalled: true, ompVersion: '17.0.9', ompBinPath: fakeOmpBin,
      }, () => Date.parse(now) + 1);
      const prepared = await executor.prepare({ ...canonicalInput(), repositoryPath: root, worktreePath: root });
      await executor.launch(prepared);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const observation = await executor.observe(prepared.request.requestHash);
      expect(observation.live).toBe(false);
      const proposal = await executor.proposeResult(prepared.request.requestHash, 'succeeded', hash('e'));
      expect(proposal).toMatchObject({
        requestHash: prepared.request.requestHash,
        fencingToken: 3,
        status: 'succeeded',
        closeoutAuthority: 'none',
        storyLifecycleAuthority: 'none',
        mergeAuthority: 'none',
        deploymentAuthority: 'none',
      });
      expect(proposal.hostObservationHash).toMatch(/^sha256:/);
      expect(store.record?.state).toBe('result_persisted');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('proposeResult rejects a live child as fence_lost', async () => {
    const root = await worktreeFixture();
    try {
      writeFakeControl(root, 'stay');
      const store = new MemoryStore();
      const executor = new OmpManagedExecutor(store, new OmpManagedProcessBridge(bridgeOptions()), verifyWave3AImplementationPrerequisites(packet), {
        ompInstalled: true, ompVersion: '17.0.9', ompBinPath: fakeOmpBin,
      }, () => Date.parse(now) + 1);
      const prepared = await executor.prepare({ ...canonicalInput(), repositoryPath: root, worktreePath: root });
      await executor.launch(prepared);
      await expect(executor.proposeResult(prepared.request.requestHash, 'succeeded', hash('e')))
        .rejects.toMatchObject({ reason: 'fence_lost' });
      // Quiesce the live fake child so jest can exit.
      await executor.cancel(prepared.request.requestHash, 'test-cleanup');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects managed admission when the prerequisite gate is not accepted', async () => {
    const executor = new OmpManagedExecutor(new MemoryStore(), new OmpManagedProcessBridge(bridgeOptions()), {
      schemaVersion: 'rorca.wave3a-implementation-gate.v1', accepted: false, packetHash: hash('1'),
      executionAuthority: 'none', approvalAuthority: 'none', mergeAuthority: 'none', deploymentAuthority: 'none', productionActivationAuthority: 'none',
    } as unknown as Wave3AImplementationGate, { ompInstalled: true, ompVersion: '17.0.9', ompBinPath: fakeOmpBin });
    await expect(executor.prepare(canonicalInput())).rejects.toBeInstanceOf(ManagedAdmissionError);
  });

  test('recover expires a stale lost generation without relaunch', async () => {
    const store = new MemoryStore();
    const prepared = await store.prepare(normalizeManagedEngineRequest({ ...canonicalInput(), repositoryPath: '/tmp/x', worktreePath: '/tmp/x' }, Date.parse(now) + 1));
    await store.transition(prepared.request.requestHash, ['released'], 'running');
    const executor = new OmpManagedExecutor(store, new OmpManagedProcessBridge(bridgeOptions()), verifyWave3AImplementationPrerequisites(packet), {
      ompInstalled: true, ompVersion: '17.0.9', ompBinPath: fakeOmpBin,
    }, () => Date.parse(now) + 1);
    const actions = await executor.recover(10);
    expect(actions).toEqual([{ requestHash: prepared.request.requestHash, action: 'expire_preserve_evidence' }]);
    expect(store.record?.state).toBe('expired');
  });
});

describe('OmpManagedProcessBridge launch contract', () => {
  test('ingests the live instrumented OMP RPC stream rather than TUI output', async () => {
    const root = await worktreeFixture();
    try {
      writeFakeControl(root, 'events');
      const writer = new CaptureOrchestrationWriter();
      const bridge = new OmpManagedProcessBridge(bridgeOptions({ orchestrationEvents: writer }));
      const request = normalizeManagedEngineRequest({ ...canonicalInput(), repositoryPath: root, worktreePath: root }, Date.parse(now) + 1);
      await bridge.launch(request, 'launch-token:events');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(writer.records.map((event) => event.kind)).toEqual([
        'agent_started', 'task_started', 'agent_progress', null, 'agent_completed',
      ]);
      expect(writer.records.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(writer.records[1].parentEventId).toBe('omp:event:1');
      expect(writer.records[3].omp).toMatchObject({ rpcType: 'future_omp_signal', raw: { detail: 'retained' } });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('spawns omp with --mode rpc --profile rorca --no-extensions --cwd <worktree> and the positional story message', async () => {
    const root = await worktreeFixture();
    try {
      const bridge = new OmpManagedProcessBridge(bridgeOptions({ trustedEnvironment: { ...process.env } }));
      const request = normalizeManagedEngineRequest({ ...canonicalInput(), repositoryPath: root, worktreePath: root }, Date.parse(now) + 1);
      await bridge.launch(request, 'launch-token:args');
      const launch = mockPrepareAutonomousSandboxLaunch.mock.calls.at(-1)![0];
      const args = launch.args as string[];
      expect(args).toContain('--mode');
      expect(args[args.indexOf('--mode') + 1]).toBe('rpc');
      expect(args).toContain('--profile');
      expect(args[args.indexOf('--profile') + 1]).toBe('rorca');
      expect(args).toContain('--no-extensions');
      expect(args).toContain('--cwd');
      expect(args[args.indexOf('--cwd') + 1]).toBe(root);
      expect(args.some((arg) => arg.startsWith('@'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
