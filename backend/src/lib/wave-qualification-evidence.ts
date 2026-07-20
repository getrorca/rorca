/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { WAVE_CANONICAL_ASSERTION_IDS } from './wave-canonical-assertions';

export const QUALIFICATION_REPORT_SCHEMA = 'rorca.wave-qualification.report/v1' as const;
export const QUALIFICATION_RECEIPT_SCHEMA = 'rorca.wave-qualification.receipt/v1' as const;
export const QUALIFICATION_POLICY_VERSION = 'wave-parallel-production-v1' as const;
export const QUALIFICATION_INVARIANT_VERSION = 'rorca-wave-parallel-qualification-v1' as const;
export const QUALIFICATION_COMPILER_VERSION = 'wave-schedule-compiler-v1' as const;
export const QUALIFICATION_ENGINE_VERSION = 'wave-integration-engine-v1' as const;
export const RECEIPT_ALGORITHM = 'hmac-sha256' as const;

export const EVIDENCE_CLASSES = [
  'automated_test_output',
  'durable_database_wal',
  'git_integration',
  'independent_checker',
  'canary_soak',
  'rollback_rehearsal',
  'operator_observation',
  'skipped_check',
  'environmental_blocker',
] as const;
export type EvidenceClass = typeof EVIDENCE_CLASSES[number];
export type EvidenceVerdict = 'passed' | 'failed' | 'skipped' | 'blocked';

const AUTHORITATIVE_CLASSES = new Set<EvidenceClass>([
  'durable_database_wal', 'git_integration', 'independent_checker', 'canary_soak', 'rollback_rehearsal',
]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_OID = /^[0-9a-f]{40,64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ABSOLUTE_OR_SECRET = /(?:^|[\s"'])(?:\/(?:[^\s"/]+\/)+[^\s"/]*|[A-Za-z]:\\|(?:postgres(?:ql)?|https?):\/\/[^\s/@:]+:[^\s/@]+@)|(?:api[_-]?key|password|credential|raw[_-]?prompt|production[_-]?payload|stack[_-]?trace)/i;
const MAX_COUNT = 65_535;
export const SYNTHETIC_DIAGNOSTIC_AUTHORITY = 'synthetic_diagnostic' as const;
export const MEASURED_EVIDENCE_AUTHORITY = 'measured' as const;
export type EvidenceAuthority = typeof SYNTHETIC_DIAGNOSTIC_AUTHORITY | typeof MEASURED_EVIDENCE_AUTHORITY;

export function loadCanonicalQualificationAssertionIds(): string[] {
  if (WAVE_CANONICAL_ASSERTION_IDS.some(id => !SAFE_ID.test(id))
    || new Set(WAVE_CANONICAL_ASSERTION_IDS).size !== WAVE_CANONICAL_ASSERTION_IDS.length) {
    fail('compiled canonical qualification assertion registry is missing, malformed, or duplicated');
  }
  return [...WAVE_CANONICAL_ASSERTION_IDS];
}

// Every transitive implementation, policy, migration, fixture, test, and artifact
// reader that can affect WPE conclusions is bound into the identity manifest.
const IDENTITY_FILES = {
  engine: [
    'backend/src/lib/execution-engine.ts',
    'backend/src/worker.ts',
    'backend/src/runner/local-runner.ts',
    'backend/src/server.ts',
    'backend/src/db/index.ts',
    'backend/src/lib/errors.ts',
    'backend/src/lib/fallback-replay.ts',
    'backend/src/lib/resilient-post.ts',
    'backend/src/lib/pg-boss-schemas.ts',
    'backend/src/routes/pipeline.ts',
    'backend/src/routes/wave-qualification.ts',
    'backend/src/lib/parallel-wave-core.ts',
    'backend/src/lib/qualification-isolation.ts',
    'backend/src/lib/rejected-wave-closeout.ts',
    'backend/src/lib/story-execution-adapter.ts',
    'backend/src/lib/story-execution-packet.ts',
    'backend/src/lib/wave-compiler.ts',
    'backend/src/lib/wave-execution-safety.ts',
    'backend/src/lib/wave-integration-protocol.ts',
    'backend/src/lib/wave-integration-store.ts',
    'backend/src/lib/story-host-validation.ts',
    'backend/src/lib/governed-retry-publication.ts',
    'backend/src/lib/wave-parallel-policy.ts',
    'backend/src/lib/wave-production-governance.ts',
    'backend/src/lib/wave-production-policy.ts',
    'backend/src/lib/wave-canonical-assertions.ts',
    'backend/src/lib/wave-qualification-evidence.ts',
    'backend/src/lib/wave-qualification-model.ts',
    'backend/src/lib/wave-release-readiness.ts',
    'backend/src/scripts/build-wave-qualification-evidence.ts',
    'backend/src/scripts/wave-qualification-runner.ts',
    'scripts/run-wave-qualification.mjs',
    'scripts/run-wave-stress-qualification.mjs',
  ],
  policy: [
    'docs/qualification/wave-parallel-invariants.json',
    'docs/qualification/wave-parallel-release-checklist.md',
    'docs/qualification/wave-production-rollout.md',
    'docs/qualification/wave-stress-baseline-v1.json',
    'docs/qualification/wave-parallel-v1/cross-reference.json',
    'docs/qualification/wave-parallel-v1/requirements.json',
    'docs/qualification/wave-parallel-v1/qualification.md',
  ],
  compiler: [
    'backend/src/lib/wave-compiler.ts',
    'backend/src/lib/wave-integration-protocol.ts',
  ],
  tests: [
    'backend/src/lib/__tests__/qualification-isolation.node.test.ts',
    'backend/src/lib/__tests__/deterministic-fixture-agent.node.test.ts',
    'backend/src/lib/__tests__/parallel-wave-core.test.ts',
    'backend/src/lib/__tests__/story-execution-packet.test.ts',
    'backend/src/lib/__tests__/wave-compiler.test.ts',
    'backend/src/lib/__tests__/wave-execution-safety.node.test.ts',
    'backend/src/lib/__tests__/wave-parallel-policy.test.ts',
    'backend/src/lib/__tests__/wave-production-policy.node.test.ts',
    'backend/src/lib/__tests__/successful-wave-integration.node.test.ts',
    'backend/src/lib/__tests__/rejected-wave-closeout.node.test.ts',
    'backend/src/lib/__tests__/conflicted-wave-integration.node.test.ts',
    'backend/src/lib/__tests__/wave-qualification-model.node.test.ts',
    'backend/src/lib/__tests__/wave-qualification-evidence.node.test.ts',
    'backend/src/lib/__tests__/wave-release-readiness.node.test.ts',
    'backend/src/lib/__tests__/wave-integration-store.test.ts',
    'backend/src/lib/__tests__/governed-retry-publication.test.ts',
    'backend/src/lib/__tests__/fallback-replay.test.ts',
    'backend/src/__tests__/fixtures/independent-wave-trace-checker.mjs',
    'backend/src/__tests__/fixtures/wave-fixture-agent.mjs',
    'backend/src/__tests__/fixtures/wave-isolation-smoke-scenario.mjs',
    'scripts/__tests__/wave-qualification-launcher.test.mjs',
    'scripts/__tests__/wave-qualification-traceability.test.mjs',
    'scripts/check-wave-qualification-invariants.mjs',
  ],
  configuration: [
    'docs/qualification/wave-stress-baseline-v1.json',
    'backend/src/__tests__/fixtures/wave-agent-scenarios.json',
    'backend/src/__tests__/fixtures/wave-fault-points.json',
    'backend/src/db/pg-migrations/20260719090500_wave_story_integration_ledger.sql',
    'backend/src/db/pg-migrations/20260719091000_wave_conflict_recovery.sql',
    'backend/src/db/pg-migrations/20260719092000_wave_execution_safety.sql',
    'backend/src/db/pg-migrations/20260719102000_wave_stress_qualification.sql',
    'backend/src/db/pg-migrations/20260719103000_wave_qualification_receipts.sql',
    'backend/src/db/pg-migrations/20260719104000_wave_production_governance.sql',
    'backend/src/db/pg-migrations/20260719105000_wave_release_readiness.sql',
    'backend/src/db/pg-migrations/20260719106000_wave_dispatch_atomicity.sql',
    'backend/src/db/pg-migrations/20260719106500_wave_release_evidence_artifacts.sql',
    'backend/src/db/pg-migrations/20260719107000_governed_retry_publication_cancellation.sql',
    '.github/workflows/ci.yml',
    '.github/workflows/wave-qualification.yml',
    'Dockerfile',
    'Dockerfile.backend',
    'package.json',
    'package-lock.json',
    'backend/package.json',
    'backend/tsconfig.json',
  ],
} as const;

export interface QualificationEvidenceAssertion {
  id: string;
  invariantId: string;
  scenarioId: string;
  evidenceClass: EvidenceClass;
  verdict: EvidenceVerdict;
  sourceDigest: string;
  sourceRevision: string;
  authority: EvidenceAuthority;
  durable: boolean;
  assertionCode: string;
}

export interface QualificationTelemetry {
  effectiveMode: 'serial' | 'wave_parallel' | 'recovery';
  requestedParallelism: number;
  effectiveParallelism: number;
  activeWaveCount: number;
  activeStoryCount: number;
  attemptIdentityHash: string;
  leaseIdentityHash: string;
  rejectionCount: number;
  conflictCount: number;
  blockingCount: number;
  integrationState: 'pending' | 'integrating' | 'validated' | 'failed' | 'recovery';
  cleanupOutcome: 'pending' | 'complete' | 'partial' | 'failed';
  preservedRecoveryArtifactCount: number;
  backpressureState: 'none' | 'queue' | 'process' | 'output' | 'database';
  closeoutStatus: 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'blocked';
}

export interface QualificationScenarioVerdict {
  id: string;
  verdict: EvidenceVerdict;
  assertionIds: string[];
}

export interface LocalQualificationIdentity {
  sourceRevision: string;
  sourceTree: string;
  repositoryIdentity: string;
  workspaceIdentity: string;
  engineDigest: string;
  policyDigest: string;
  compilerDigest: string;
  invariantDigest: string;
  testSuiteDigest: string;
  configurationDigest: string;
  gitInventories: {
    refsDigest: string;
    worktreesDigest: string;
    refCount: number;
    worktreeCount: number;
  };
}

export interface QualificationReport {
  schemaVersion: typeof QUALIFICATION_REPORT_SCHEMA;
  versions: {
    engine: typeof QUALIFICATION_ENGINE_VERSION;
    policy: typeof QUALIFICATION_POLICY_VERSION;
    compiler: typeof QUALIFICATION_COMPILER_VERSION;
    invariants: typeof QUALIFICATION_INVARIANT_VERSION;
  };
  source: {
    revision: string;
    tree: string;
    repositoryIdentity: string;
    workspaceIdentity: string;
  };
  identities: {
    engineDigest: string;
    policyDigest: string;
    compilerDigest: string;
    invariantDigest: string;
    testSuiteDigest: string;
    configurationDigest: string;
    testDatabaseIdentityHash: string;
    queueNamespaceHash: string;
  };
  repositorySeed: string;
  invariantCatalog: Array<{ id: string; statementDigest: string }>;
  scenarioResults: QualificationScenarioVerdict[];
  gitInventories: LocalQualificationIdentity['gitInventories'] & { commitTopologyDigest: string };
  resourceBudgets: Record<string, { observed: number; cap: number; verdict: 'passed' | 'failed' }>;
  evidenceAssertions: QualificationEvidenceAssertion[];
  telemetry: QualificationTelemetry[];
  semanticCloseout: 'succeeded' | 'failed' | 'cancelled';
  productionEnableAvailable: boolean;
  unavailableReasons: string[];
}

export interface QualificationReceipt {
  schemaVersion: typeof QUALIFICATION_RECEIPT_SCHEMA;
  sourceRevision: string;
  sourceTree: string;
  repositoryIdentity: string;
  workspaceIdentity: string;
  engineDigest: string;
  policyVersion: typeof QUALIFICATION_POLICY_VERSION;
  policyDigest: string;
  compilerVersion: typeof QUALIFICATION_COMPILER_VERSION;
  compilerDigest: string;
  invariantVersion: typeof QUALIFICATION_INVARIANT_VERSION;
  invariantDigest: string;
  testSuiteDigest: string;
  configurationDigest: string;
  requiredScenarios: QualificationScenarioVerdict[];
  platformRuntimeMatrix: Array<{ platform: 'linux' | 'darwin' | 'win32'; architecture: 'x64' | 'arm64'; node: string; postgres: string }>;
  issuedAt: string;
  expiresAt: string;
  issuer: { id: string; keyId: string };
  reportHash: string;
  algorithm: typeof RECEIPT_ALGORITHM;
  signature: string;
}

export interface PortableQualificationArtifact {
  report: QualificationReport;
  receipt: QualificationReceipt;
  canonicalJson: string;
  humanReport: string;
  artifactDigest: string;
}

function fail(message: string): never {
  throw new Error(`[wave-qualification-evidence] ${message}`);
}

function hashBytes(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sortedValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('non-finite numbers are not canonical');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(sortedValue);
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) fail('undefined values are not canonical');
      result[key] = sortedValue(child);
    }
    return result;
  }
  return fail('unsupported canonical value');
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortedValue(value))}\n`;
}

function digestFiles(repositoryRoot: string, files: readonly string[]): string {
  const entries = files.map(relative => {
    const absolute = path.join(repositoryRoot, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) fail(`required identity file is missing: ${relative}`);
    return [relative.replaceAll(path.sep, '/'), hashBytes(fs.readFileSync(absolute))];
  });
  return hashBytes(canonicalJson(entries));
}

function git(repositoryRoot: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fail('local Git identity could not be recomputed');
  }
}

function normalizedRemote(repositoryRoot: string): string {
  const raw = git(repositoryRoot, ['config', '--get', 'remote.origin.url']);
  if (!raw) return hashBytes(`no-remote:${path.basename(repositoryRoot)}`);
  const withoutCredentials = raw.replace(/^(https?:\/\/)[^/@]+@/, '$1').replace(/[?#].*$/, '').replace(/\.git$/, '');
  return hashBytes(withoutCredentials.toLowerCase());
}

export function computeLocalQualificationIdentity(repositoryRoot: string, workspaceId: string): LocalQualificationIdentity {
  if (!workspaceId || workspaceId.length > 256) fail('workspace identity is invalid');
  const root = fs.realpathSync(repositoryRoot);
  const sourceRevision = git(root, ['rev-parse', 'HEAD']);
  const sourceTree = git(root, ['rev-parse', 'HEAD^{tree}']);
  if (!GIT_OID.test(sourceRevision) || !GIT_OID.test(sourceTree)) fail('Git source identity is malformed');
  const refs = git(root, ['for-each-ref', '--format=%(refname):%(objectname)', 'refs/heads', 'refs/tags'])
    .split('\n').filter(Boolean).sort();
  const worktrees = git(root, ['worktree', 'list', '--porcelain'])
    .split('\n').filter(line => /^(HEAD|branch|detached|bare|locked|prunable)\b/.test(line)).sort();
  const invariantDigest = digestFiles(root, ['docs/qualification/wave-parallel-invariants.json']);
  return {
    sourceRevision,
    sourceTree,
    repositoryIdentity: normalizedRemote(root),
    workspaceIdentity: hashBytes(workspaceId),
    engineDigest: digestFiles(root, IDENTITY_FILES.engine),
    policyDigest: digestFiles(root, IDENTITY_FILES.policy),
    compilerDigest: digestFiles(root, IDENTITY_FILES.compiler),
    invariantDigest,
    testSuiteDigest: digestFiles(root, IDENTITY_FILES.tests),
    configurationDigest: digestFiles(root, IDENTITY_FILES.configuration),
    gitInventories: {
      refsDigest: hashBytes(canonicalJson(refs)),
      worktreesDigest: hashBytes(canonicalJson(worktrees)),
      refCount: Math.min(refs.length, MAX_COUNT),
      worktreeCount: Math.min(worktrees.filter(line => line.startsWith('HEAD ')).length, MAX_COUNT),
    },
  };
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_COUNT, Math.trunc(value)));
}

export function buildQualificationTelemetry(input: Omit<QualificationTelemetry, 'attemptIdentityHash' | 'leaseIdentityHash'> & {
  attemptIdentity: string;
  leaseIdentity: string;
}): QualificationTelemetry {
  return {
    effectiveMode: input.effectiveMode,
    requestedParallelism: boundedCount(input.requestedParallelism),
    effectiveParallelism: boundedCount(input.effectiveParallelism),
    activeWaveCount: boundedCount(input.activeWaveCount),
    activeStoryCount: boundedCount(input.activeStoryCount),
    attemptIdentityHash: hashBytes(input.attemptIdentity),
    leaseIdentityHash: hashBytes(input.leaseIdentity),
    rejectionCount: boundedCount(input.rejectionCount),
    conflictCount: boundedCount(input.conflictCount),
    blockingCount: boundedCount(input.blockingCount),
    integrationState: input.integrationState,
    cleanupOutcome: input.cleanupOutcome,
    preservedRecoveryArtifactCount: boundedCount(input.preservedRecoveryArtifactCount),
    backpressureState: input.backpressureState,
    closeoutStatus: input.closeoutStatus,
  };
}

function assertSafePortable(value: unknown): void {
  const serialized = canonicalJson(value);
  if (ABSOLUTE_OR_SECRET.test(serialized)) fail('portable artifact contains a forbidden path, credential, prompt, payload, or diagnostic field');
}

function validateToken(value: string, label: string): void {
  if (!SAFE_ID.test(value)) fail(`${label} is not a bounded portable identifier`);
}

function validateAssertions(assertions: readonly QualificationEvidenceAssertion[]): void {
  if (assertions.length === 0 || assertions.length > 2_048) fail('evidence assertion inventory is empty or unbounded');
  const ids = new Set<string>();
  for (const assertion of assertions) {
    validateToken(assertion.id, 'assertion ID');
    validateToken(assertion.invariantId, 'invariant ID');
    validateToken(assertion.scenarioId, 'scenario ID');
    validateToken(assertion.assertionCode, 'assertion code');
    if (ids.has(assertion.id)) fail('duplicate assertion ID');
    if (!EVIDENCE_CLASSES.includes(assertion.evidenceClass) || !DIGEST.test(assertion.sourceDigest) || !GIT_OID.test(assertion.sourceRevision)) fail('assertion evidence source is invalid');
    if (assertion.authority !== MEASURED_EVIDENCE_AUTHORITY && assertion.authority !== SYNTHETIC_DIAGNOSTIC_AUTHORITY) fail('assertion evidence authority is invalid');
    if ((assertion.evidenceClass === 'automated_test_output' || assertion.authority === SYNTHETIC_DIAGNOSTIC_AUTHORITY) && assertion.durable) fail('synthetic or terminal/test output cannot be promoted to durable proof');
    ids.add(assertion.id);
  }
}

function gateReasons(input: {
  scenarios: QualificationScenarioVerdict[];
  assertions: QualificationEvidenceAssertion[];
  semanticCloseout: QualificationReport['semanticCloseout'];
  telemetry: QualificationTelemetry[];
  budgets: QualificationReport['resourceBudgets'];
}): string[] {
  const reasons = new Set<string>();
  if (input.semanticCloseout !== 'succeeded') reasons.add('semantic-closeout-not-succeeded');
  if (input.scenarios.length === 0 || input.scenarios.some(item => item.verdict !== 'passed')) reasons.add('required-scenario-not-passed');
  for (const required of AUTHORITATIVE_CLASSES) {
    if (!input.assertions.some(item => item.evidenceClass === required && item.verdict === 'passed' && item.durable && item.authority === MEASURED_EVIDENCE_AUTHORITY)) {
      reasons.add(`missing-${required}`);
    }
  }
  if (input.assertions.some(item => item.verdict !== 'passed' && AUTHORITATIVE_CLASSES.has(item.evidenceClass))) reasons.add('authoritative-evidence-not-passed');
  if (input.assertions.some(item => item.evidenceClass === 'skipped_check')) reasons.add('skipped-check-present');
  if (input.assertions.some(item => item.evidenceClass === 'environmental_blocker')) reasons.add('environmental-blocker-present');
  if (input.telemetry.length === 0 || !input.telemetry.some(item => item.closeoutStatus === input.semanticCloseout)) reasons.add('telemetry-closeout-missing');
  if (Object.values(input.budgets).some(item => item.verdict !== 'passed' || item.observed > item.cap)) reasons.add('resource-budget-failed');
  return [...reasons].sort();
}

export function buildQualificationReport(input: {
  localIdentity: LocalQualificationIdentity;
  testDatabaseIdentityHash: string;
  queueNamespace: string;
  repositorySeed: string;
  invariantCatalog: Array<{ id: string; statementDigest: string }>;
  scenarioResults: QualificationScenarioVerdict[];
  commitTopologyDigest: string;
  resourceBudgets: QualificationReport['resourceBudgets'];
  evidenceAssertions: QualificationEvidenceAssertion[];
  requiredAssertionIds: readonly string[];
  telemetry: QualificationTelemetry[];
  semanticCloseout: QualificationReport['semanticCloseout'];
}): QualificationReport {
  if (!DIGEST.test(input.testDatabaseIdentityHash) || !DIGEST.test(input.commitTopologyDigest)) fail('qualification identity digest is malformed');
  validateToken(input.queueNamespace, 'queue namespace');
  validateToken(input.repositorySeed, 'repository seed');
  validateAssertions(input.evidenceAssertions);
  if (input.evidenceAssertions.some(assertion => assertion.sourceRevision !== input.localIdentity.sourceRevision)) fail('evidence is not bound to the exact source HEAD');
  const assertionIds = new Set(input.evidenceAssertions.map(item => item.id));
  const requiredAssertionIds = new Set(input.requiredAssertionIds);
  if (requiredAssertionIds.size === 0
    || requiredAssertionIds.size !== input.requiredAssertionIds.length
    || assertionIds.size !== requiredAssertionIds.size
    || [...requiredAssertionIds].some(id => !assertionIds.has(id))) {
    fail('qualification assertion inventory does not exactly match the canonical registry');
  }
  const scenarioResults = [...input.scenarioResults].sort((a, b) => a.id.localeCompare(b.id)).map(item => ({
    ...item,
    assertionIds: [...item.assertionIds].sort(),
  }));
  if (new Set(scenarioResults.map(item => item.id)).size !== scenarioResults.length) fail('duplicate scenario ID');
  for (const scenario of scenarioResults) {
    validateToken(scenario.id, 'scenario ID');
    if (scenario.assertionIds.length === 0 || scenario.assertionIds.some(id => !assertionIds.has(id))) fail('scenario assertion binding is incomplete');
  }
  const resourceBudgets = Object.fromEntries(Object.entries(input.resourceBudgets).sort(([a], [b]) => a.localeCompare(b)));
  const unavailableReasons = gateReasons({
    scenarios: scenarioResults,
    assertions: input.evidenceAssertions,
    semanticCloseout: input.semanticCloseout,
    telemetry: input.telemetry,
    budgets: resourceBudgets,
  });
  const report: QualificationReport = {
    schemaVersion: QUALIFICATION_REPORT_SCHEMA,
    versions: {
      engine: QUALIFICATION_ENGINE_VERSION,
      policy: QUALIFICATION_POLICY_VERSION,
      compiler: QUALIFICATION_COMPILER_VERSION,
      invariants: QUALIFICATION_INVARIANT_VERSION,
    },
    source: {
      revision: input.localIdentity.sourceRevision,
      tree: input.localIdentity.sourceTree,
      repositoryIdentity: input.localIdentity.repositoryIdentity,
      workspaceIdentity: input.localIdentity.workspaceIdentity,
    },
    identities: {
      engineDigest: input.localIdentity.engineDigest,
      policyDigest: input.localIdentity.policyDigest,
      compilerDigest: input.localIdentity.compilerDigest,
      invariantDigest: input.localIdentity.invariantDigest,
      testSuiteDigest: input.localIdentity.testSuiteDigest,
      configurationDigest: input.localIdentity.configurationDigest,
      testDatabaseIdentityHash: input.testDatabaseIdentityHash,
      queueNamespaceHash: hashBytes(input.queueNamespace),
    },
    repositorySeed: input.repositorySeed,
    invariantCatalog: [...input.invariantCatalog].sort((a, b) => a.id.localeCompare(b.id)),
    scenarioResults,
    gitInventories: { ...input.localIdentity.gitInventories, commitTopologyDigest: input.commitTopologyDigest },
    resourceBudgets,
    evidenceAssertions: [...input.evidenceAssertions].sort((a, b) => a.id.localeCompare(b.id)),
    telemetry: input.telemetry.map(item => ({ ...item })),
    semanticCloseout: input.semanticCloseout,
    productionEnableAvailable: unavailableReasons.length === 0,
    unavailableReasons,
  };
  assertSafePortable(report);
  return report;
}

function receiptUnsigned(receipt: QualificationReceipt): Omit<QualificationReceipt, 'signature'> {
  const { signature: _signature, ...unsigned } = receipt;
  return unsigned;
}

function sign(unsigned: Omit<QualificationReceipt, 'signature'>, key: string): string {
  if (Buffer.byteLength(key) < 32) fail('qualification signing key must contain at least 32 bytes');
  return createHmac('sha256', key).update(canonicalJson(unsigned)).digest('hex');
}

export function issueQualificationReceipt(input: {
  report: QualificationReport;
  issuedAt: string;
  expiresAt: string;
  issuer: { id: string; keyId: string };
  platformRuntimeMatrix: QualificationReceipt['platformRuntimeMatrix'];
  signingKey: string;
}): QualificationReceipt {
  validateToken(input.issuer.id, 'issuer ID');
  validateToken(input.issuer.keyId, 'issuer key ID');
  const issued = Date.parse(input.issuedAt);
  const expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) fail('receipt validity window is invalid');
  const receipt: QualificationReceipt = {
    schemaVersion: QUALIFICATION_RECEIPT_SCHEMA,
    sourceRevision: input.report.source.revision,
    sourceTree: input.report.source.tree,
    repositoryIdentity: input.report.source.repositoryIdentity,
    workspaceIdentity: input.report.source.workspaceIdentity,
    engineDigest: input.report.identities.engineDigest,
    policyVersion: QUALIFICATION_POLICY_VERSION,
    policyDigest: input.report.identities.policyDigest,
    compilerVersion: QUALIFICATION_COMPILER_VERSION,
    compilerDigest: input.report.identities.compilerDigest,
    invariantVersion: QUALIFICATION_INVARIANT_VERSION,
    invariantDigest: input.report.identities.invariantDigest,
    testSuiteDigest: input.report.identities.testSuiteDigest,
    configurationDigest: input.report.identities.configurationDigest,
    requiredScenarios: input.report.scenarioResults,
    platformRuntimeMatrix: [...input.platformRuntimeMatrix].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(expires).toISOString(),
    issuer: { ...input.issuer },
    reportHash: hashBytes(canonicalJson(input.report)),
    algorithm: RECEIPT_ALGORITHM,
    signature: '',
  };
  receipt.signature = sign(receiptUnsigned(receipt), input.signingKey);
  assertSafePortable(receipt);
  return receipt;
}

const REPORT_KEYS = [
  'schemaVersion', 'versions', 'source', 'identities', 'repositorySeed', 'invariantCatalog',
  'scenarioResults', 'gitInventories', 'resourceBudgets', 'evidenceAssertions', 'telemetry',
  'semanticCloseout', 'productionEnableAvailable', 'unavailableReasons',
].sort();

export function assertPortableQualificationReport(value: unknown): asserts value is QualificationReport {
  exactKeys(value, REPORT_KEYS, 'report');
  const report = value as unknown as QualificationReport;
  if (report.schemaVersion !== QUALIFICATION_REPORT_SCHEMA) fail('unsupported report version');
  exactKeys(report.versions, ['engine', 'policy', 'compiler', 'invariants'], 'report versions');
  if (report.versions.engine !== QUALIFICATION_ENGINE_VERSION || report.versions.policy !== QUALIFICATION_POLICY_VERSION || report.versions.compiler !== QUALIFICATION_COMPILER_VERSION || report.versions.invariants !== QUALIFICATION_INVARIANT_VERSION) fail('unsupported report component version');
  exactKeys(report.source, ['revision', 'tree', 'repositoryIdentity', 'workspaceIdentity'], 'report source');
  exactKeys(report.identities, ['engineDigest', 'policyDigest', 'compilerDigest', 'invariantDigest', 'testSuiteDigest', 'configurationDigest', 'testDatabaseIdentityHash', 'queueNamespaceHash'], 'report identities');
  if (!GIT_OID.test(report.source.revision) || !GIT_OID.test(report.source.tree)) fail('report Git identity is malformed');
  for (const digest of [report.source.repositoryIdentity, report.source.workspaceIdentity, ...Object.values(report.identities)]) if (!DIGEST.test(digest)) fail('report digest is malformed');
  validateToken(report.repositorySeed, 'repository seed');
  if (!Array.isArray(report.invariantCatalog) || report.invariantCatalog.length === 0 || report.invariantCatalog.length > 256) fail('invariant catalog is empty or unbounded');
  for (const invariant of report.invariantCatalog) {
    exactKeys(invariant, ['id', 'statementDigest'], 'invariant');
    validateToken(invariant.id, 'invariant ID');
    if (!DIGEST.test(invariant.statementDigest)) fail('invariant digest is malformed');
  }
  if (!Array.isArray(report.scenarioResults) || report.scenarioResults.length === 0 || report.scenarioResults.length > 512) fail('scenario results are empty or unbounded');
  if (new Set(report.scenarioResults.map(scenario => scenario.id)).size !== report.scenarioResults.length) fail('scenario IDs are duplicated');
  for (const scenario of report.scenarioResults) {
    exactKeys(scenario, ['id', 'verdict', 'assertionIds'], 'scenario result');
    validateToken(scenario.id, 'scenario ID');
    if (!['passed', 'failed', 'skipped', 'blocked'].includes(scenario.verdict) || !Array.isArray(scenario.assertionIds) || scenario.assertionIds.length === 0 || scenario.assertionIds.some(id => typeof id !== 'string' || !SAFE_ID.test(id))) fail('scenario result is malformed');
  }
  if (!Array.isArray(report.evidenceAssertions)) fail('evidence assertions must be an array');
  for (const assertion of report.evidenceAssertions) exactKeys(assertion, ['id', 'invariantId', 'scenarioId', 'evidenceClass', 'verdict', 'sourceDigest', 'sourceRevision', 'authority', 'durable', 'assertionCode'], 'evidence assertion');
  validateAssertions(report.evidenceAssertions);
  if (report.evidenceAssertions.some(assertion => assertion.sourceRevision !== report.source.revision)) fail('report evidence is not bound to the exact source HEAD');
  const assertionIds = new Set(report.evidenceAssertions.map(assertion => assertion.id));
  if (report.scenarioResults.some(scenario => scenario.assertionIds.some(id => !assertionIds.has(id)))) fail('scenario assertion binding is incomplete');
  exactKeys(report.gitInventories, ['refsDigest', 'worktreesDigest', 'refCount', 'worktreeCount', 'commitTopologyDigest'], 'Git inventories');
  if (!DIGEST.test(report.gitInventories.refsDigest) || !DIGEST.test(report.gitInventories.worktreesDigest) || !DIGEST.test(report.gitInventories.commitTopologyDigest)) fail('Git inventory digest is malformed');
  for (const count of [report.gitInventories.refCount, report.gitInventories.worktreeCount]) if (!Number.isSafeInteger(count) || count < 0 || count > MAX_COUNT) fail('Git inventory count is unbounded');
  if (!report.resourceBudgets || typeof report.resourceBudgets !== 'object' || Array.isArray(report.resourceBudgets) || Object.keys(report.resourceBudgets).length > 128) fail('resource budgets are malformed or unbounded');
  for (const [name, budget] of Object.entries(report.resourceBudgets)) {
    validateToken(name, 'resource budget');
    exactKeys(budget, ['observed', 'cap', 'verdict'], 'resource budget');
    if (!Number.isFinite(budget.observed) || !Number.isFinite(budget.cap) || budget.observed < 0 || budget.cap < 0 || !['passed', 'failed'].includes(budget.verdict)) fail('resource budget value is malformed');
  }
  if (!Array.isArray(report.telemetry) || report.telemetry.length === 0 || report.telemetry.length > 512) fail('telemetry is empty or unbounded');
  const telemetryKeys = ['effectiveMode', 'requestedParallelism', 'effectiveParallelism', 'activeWaveCount', 'activeStoryCount', 'attemptIdentityHash', 'leaseIdentityHash', 'rejectionCount', 'conflictCount', 'blockingCount', 'integrationState', 'cleanupOutcome', 'preservedRecoveryArtifactCount', 'backpressureState', 'closeoutStatus'];
  for (const sample of report.telemetry) {
    exactKeys(sample, telemetryKeys, 'telemetry sample');
    for (const digest of [sample.attemptIdentityHash, sample.leaseIdentityHash]) if (!DIGEST.test(digest)) fail('telemetry identity is malformed');
    for (const count of [sample.requestedParallelism, sample.effectiveParallelism, sample.activeWaveCount, sample.activeStoryCount, sample.rejectionCount, sample.conflictCount, sample.blockingCount, sample.preservedRecoveryArtifactCount]) if (!Number.isSafeInteger(count) || count < 0 || count > MAX_COUNT) fail('telemetry count is unbounded');
    if (!['serial', 'wave_parallel', 'recovery'].includes(sample.effectiveMode) || !['pending', 'integrating', 'validated', 'failed', 'recovery'].includes(sample.integrationState) || !['pending', 'complete', 'partial', 'failed'].includes(sample.cleanupOutcome) || !['none', 'queue', 'process', 'output', 'database'].includes(sample.backpressureState) || !['pending', 'succeeded', 'failed', 'cancelled', 'blocked'].includes(sample.closeoutStatus)) fail('telemetry enum is unsupported');
  }
  if (!['succeeded', 'failed', 'cancelled'].includes(report.semanticCloseout) || typeof report.productionEnableAvailable !== 'boolean' || !Array.isArray(report.unavailableReasons) || report.unavailableReasons.some(reason => typeof reason !== 'string' || !SAFE_ID.test(reason))) fail('report closeout is malformed');
  const recomputedReasons = gateReasons({ scenarios: report.scenarioResults, assertions: report.evidenceAssertions, semanticCloseout: report.semanticCloseout, telemetry: report.telemetry, budgets: report.resourceBudgets });
  if (canonicalJson(recomputedReasons) !== canonicalJson(report.unavailableReasons) || report.productionEnableAvailable !== (recomputedReasons.length === 0)) fail('report production gate projection is not authoritative');
  if (Buffer.byteLength(canonicalJson(report)) > 512 * 1024) fail('portable report exceeds 512 KiB');
  assertSafePortable(report);
}

const RECEIPT_KEYS = [
  'schemaVersion', 'sourceRevision', 'sourceTree', 'repositoryIdentity', 'workspaceIdentity',
  'engineDigest', 'policyVersion', 'policyDigest', 'compilerVersion', 'compilerDigest',
  'invariantVersion', 'invariantDigest', 'testSuiteDigest', 'configurationDigest',
  'requiredScenarios', 'platformRuntimeMatrix', 'issuedAt', 'expiresAt', 'issuer',
  'reportHash', 'algorithm', 'signature',
].sort();

function exactKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const observed = Object.keys(value).sort();
  if (JSON.stringify(observed) !== JSON.stringify([...expected].sort())) fail(`${label} contains unknown or missing fields`);
}

export function verifyQualificationReceipt(input: {
  receipt: unknown;
  report: QualificationReport;
  localIdentity: LocalQualificationIdentity;
  requiredScenarioIds: readonly string[];
  requiredAssertionIds: readonly string[];
  trustedIssuers: Record<string, Record<string, string>>;
  now: string;
}): QualificationReceipt {
  assertPortableQualificationReport(input.report);
  exactKeys(input.receipt, RECEIPT_KEYS, 'receipt');
  const receipt = input.receipt as unknown as QualificationReceipt;
  if (receipt.schemaVersion !== QUALIFICATION_RECEIPT_SCHEMA || receipt.algorithm !== RECEIPT_ALGORITHM) fail('unsupported receipt version or algorithm');
  if (receipt.policyVersion !== QUALIFICATION_POLICY_VERSION || receipt.compilerVersion !== QUALIFICATION_COMPILER_VERSION || receipt.invariantVersion !== QUALIFICATION_INVARIANT_VERSION) {
    fail('unsupported policy, compiler, or invariant version');
  }
  exactKeys(receipt.issuer, ['id', 'keyId'], 'issuer');
  validateToken(receipt.issuer.id, 'issuer ID');
  validateToken(receipt.issuer.keyId, 'issuer key ID');
  if (!GIT_OID.test(receipt.sourceRevision) || !GIT_OID.test(receipt.sourceTree)) fail('receipt Git identity is malformed');
  for (const digest of [receipt.repositoryIdentity, receipt.workspaceIdentity, receipt.engineDigest, receipt.policyDigest, receipt.compilerDigest, receipt.invariantDigest, receipt.testSuiteDigest, receipt.configurationDigest, receipt.reportHash]) {
    if (!DIGEST.test(digest)) fail('receipt digest is malformed');
  }
  if (!Array.isArray(receipt.requiredScenarios) || receipt.requiredScenarios.length === 0 || receipt.requiredScenarios.length > 512 || !Array.isArray(receipt.platformRuntimeMatrix) || receipt.platformRuntimeMatrix.length === 0 || receipt.platformRuntimeMatrix.length > 32) {
    fail('receipt matrices are malformed or unbounded');
  }
  for (const scenario of receipt.requiredScenarios) {
    exactKeys(scenario, ['id', 'verdict', 'assertionIds'], 'scenario verdict');
    validateToken(scenario.id, 'scenario ID');
    if (!['passed', 'failed', 'skipped', 'blocked'].includes(scenario.verdict) || !Array.isArray(scenario.assertionIds) || scenario.assertionIds.some(id => typeof id !== 'string' || !SAFE_ID.test(id))) fail('scenario verdict is malformed');
  }
  for (const runtime of receipt.platformRuntimeMatrix) {
    exactKeys(runtime, ['platform', 'architecture', 'node', 'postgres'], 'platform runtime');
    if (!['linux', 'darwin', 'win32'].includes(runtime.platform) || !['x64', 'arm64'].includes(runtime.architecture) || !/^v?\d+\.\d+\.\d+$/.test(runtime.node) || !/^\d+(?:\.\d+){0,2}$/.test(runtime.postgres)) fail('platform runtime is unsupported or malformed');
  }
  const now = Date.parse(input.now);
  const issuedAt = Date.parse(receipt.issuedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt || expiresAt - issuedAt > 7 * 24 * 60 * 60 * 1_000 || now < issuedAt || now >= expiresAt) fail('receipt is stale, not yet valid, or expired');
  const key = input.trustedIssuers[receipt.issuer.id]?.[receipt.issuer.keyId];
  if (!key) fail('receipt issuer is not trusted');
  if (!/^[0-9a-f]{64}$/.test(receipt.signature)) fail('receipt signature is malformed');
  const expectedSignature = sign(receiptUnsigned(receipt), key);
  if (!timingSafeEqual(Buffer.from(receipt.signature, 'hex'), Buffer.from(expectedSignature, 'hex'))) fail('receipt signature is invalid');
  if (receipt.reportHash !== hashBytes(canonicalJson(input.report))) fail('receipt report hash does not match canonical report');
  const reportBindings: Array<[unknown, unknown]> = [
    [receipt.sourceRevision, input.report.source.revision], [receipt.sourceTree, input.report.source.tree],
    [receipt.repositoryIdentity, input.report.source.repositoryIdentity], [receipt.workspaceIdentity, input.report.source.workspaceIdentity],
    [receipt.engineDigest, input.report.identities.engineDigest], [receipt.policyDigest, input.report.identities.policyDigest],
    [receipt.compilerDigest, input.report.identities.compilerDigest], [receipt.invariantDigest, input.report.identities.invariantDigest],
    [receipt.testSuiteDigest, input.report.identities.testSuiteDigest], [receipt.configurationDigest, input.report.identities.configurationDigest],
    [canonicalJson(receipt.requiredScenarios), canonicalJson(input.report.scenarioResults)],
  ];
  if (reportBindings.some(([receiptValue, reportValue]) => receiptValue !== reportValue)) fail('receipt identity or scenario inventory is not bound to its report');
  const identityPairs: Array<[unknown, unknown]> = [
    [receipt.sourceRevision, input.localIdentity.sourceRevision], [receipt.sourceTree, input.localIdentity.sourceTree],
    [receipt.repositoryIdentity, input.localIdentity.repositoryIdentity], [receipt.workspaceIdentity, input.localIdentity.workspaceIdentity],
    [receipt.engineDigest, input.localIdentity.engineDigest], [receipt.policyDigest, input.localIdentity.policyDigest],
    [receipt.compilerDigest, input.localIdentity.compilerDigest], [receipt.invariantDigest, input.localIdentity.invariantDigest],
    [receipt.testSuiteDigest, input.localIdentity.testSuiteDigest], [receipt.configurationDigest, input.localIdentity.configurationDigest],
  ];
  if (identityPairs.some(([receiptValue, localValue]) => receiptValue !== localValue)) fail('receipt does not match local repository, workspace, revision, policy, compiler, engine, invariant, test, or configuration identity');
  const reportAssertionIds = new Set(input.report.evidenceAssertions.map(item => item.id));
  const requiredAssertionIds = new Set(input.requiredAssertionIds);
  if (requiredAssertionIds.size === 0
    || requiredAssertionIds.size !== input.requiredAssertionIds.length
    || reportAssertionIds.size !== requiredAssertionIds.size
    || [...requiredAssertionIds].some(id => !reportAssertionIds.has(id))) {
    fail('receipt report does not contain the exact canonical assertion inventory');
  }
  const verdicts = new Map(receipt.requiredScenarios.map(item => [item.id, item.verdict]));
  if (new Set(receipt.requiredScenarios.map(item => item.id)).size !== receipt.requiredScenarios.length) fail('receipt scenario IDs are duplicated');
  if (input.requiredScenarioIds.some(id => verdicts.get(id) !== 'passed')) fail('receipt is missing a required passing scenario');
  if (receipt.requiredScenarios.some(item => item.verdict !== 'passed')) fail('receipt contains a non-passing required scenario');
  if (!input.report.productionEnableAvailable) fail('qualification report does not make the production-enable gate available');
  assertSafePortable(receipt);
  return receipt;
}

export function renderQualificationReport(report: QualificationReport, receipt: QualificationReceipt): string {
  const lines = [
    '# Wave-parallel qualification report', '',
    `- Schema: ${report.schemaVersion}`,
    `- Engine / policy / compiler / invariants: ${report.versions.engine} / ${report.versions.policy} / ${report.versions.compiler} / ${report.versions.invariants}`,
    `- Source revision / tree: ${report.source.revision} / ${report.source.tree}`,
    `- Configuration / test database / queue: ${report.identities.configurationDigest} / ${report.identities.testDatabaseIdentityHash} / ${report.identities.queueNamespaceHash}`,
    `- Repository seed: ${report.repositorySeed}`,
    `- Semantic closeout: ${report.semanticCloseout}`,
    `- Production-enable available: ${report.productionEnableAvailable ? 'yes' : 'no'}`,
    '', '## Scenario verdicts',
    ...report.scenarioResults.map(item => `- ${item.id}: ${item.verdict} (${item.assertionIds.join(', ')})`),
    '', '## Evidence assertions',
    ...EVIDENCE_CLASSES.flatMap(kind => [
      `### ${kind}`,
      ...report.evidenceAssertions.filter(item => item.evidenceClass === kind)
        .map(item => `- ${item.id}: ${item.verdict}; authority=${item.authority}; durable=${item.durable}; head=${item.sourceRevision}; source=${item.sourceDigest}`),
      ...(report.evidenceAssertions.some(item => item.evidenceClass === kind) ? [] : ['- none']),
    ]),
    '', '## Runtime telemetry',
    ...report.telemetry.map((item, index) => `- sample-${index + 1}: mode=${item.effectiveMode}; parallelism=${item.requestedParallelism}/${item.effectiveParallelism}; active=${item.activeWaveCount}/${item.activeStoryCount}; integration=${item.integrationState}; closeout=${item.closeoutStatus}; cleanup=${item.cleanupOutcome}; backpressure=${item.backpressureState}`),
    '', '## Receipt',
    `- Schema / issuer: ${receipt.schemaVersion} / ${receipt.issuer.id}:${receipt.issuer.keyId}`,
    `- Validity: ${receipt.issuedAt} to ${receipt.expiresAt}`,
    `- Report hash: ${receipt.reportHash}`,
    `- Signature: ${receipt.algorithm}:${receipt.signature}`,
    '', '## Gate limitations',
    ...(report.unavailableReasons.length ? report.unavailableReasons.map(reason => `- ${reason}`) : ['- none']),
    '',
  ];
  return lines.join('\n');
}

export function buildPortableQualificationArtifact(report: QualificationReport, receipt: QualificationReceipt): PortableQualificationArtifact {
  const canonical = canonicalJson({ report, receipt });
  const humanReport = renderQualificationReport(report, receipt);
  assertSafePortable({ canonical, humanReport });
  return { report, receipt, canonicalJson: canonical, humanReport, artifactDigest: hashBytes(canonical) };
}
