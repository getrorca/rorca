/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import {
  buildPortableQualificationArtifact,
  buildQualificationReport,
  buildQualificationTelemetry,
  canonicalJson,
  issueQualificationReceipt,
  QUALIFICATION_RECEIPT_SCHEMA,
  verifyQualificationReceipt,
  type LocalQualificationIdentity,
  type QualificationEvidenceAssertion,
  type QualificationReport,
  type QualificationReceipt,
} from '../wave-qualification-evidence';

const repositoryRoot = fs.existsSync(path.resolve(process.cwd(), 'backend', 'src'))
  ? process.cwd()
  : path.resolve(process.cwd(), '..');
const key = 'qualification-test-key-material-that-is-longer-than-thirty-two-bytes';
const sha = (character: string) => `sha256:${character.repeat(64)}`;
const localIdentity: LocalQualificationIdentity = {
  sourceRevision: 'a'.repeat(40),
  sourceTree: 'b'.repeat(40),
  repositoryIdentity: sha('1'),
  workspaceIdentity: sha('2'),
  engineDigest: sha('3'),
  policyDigest: sha('4'),
  compilerDigest: sha('5'),
  invariantDigest: sha('6'),
  testSuiteDigest: sha('7'),
  configurationDigest: sha('8'),
  gitInventories: { refsDigest: sha('9'), worktreesDigest: sha('a'), refCount: 3, worktreeCount: 1 },
};

const assertions: QualificationEvidenceAssertion[] = [
  { id: 'A-TEST', invariantId: 'WPE-INV-001', scenarioId: 'WPE-Q-001', evidenceClass: 'automated_test_output', verdict: 'passed', sourceDigest: sha('b'), sourceRevision: 'a'.repeat(40), authority: 'synthetic_diagnostic', durable: false, assertionCode: 'test-suite-passed' },
  { id: 'A-DB', invariantId: 'WPE-INV-001', scenarioId: 'WPE-Q-001', evidenceClass: 'durable_database_wal', verdict: 'passed', sourceDigest: sha('c'), sourceRevision: 'a'.repeat(40), authority: 'measured', durable: true, assertionCode: 'wal-closeout-validated' },
  { id: 'A-GIT', invariantId: 'WPE-INV-001', scenarioId: 'WPE-Q-001', evidenceClass: 'git_integration', verdict: 'passed', sourceDigest: sha('d'), sourceRevision: 'a'.repeat(40), authority: 'measured', durable: true, assertionCode: 'integration-tree-validated' },
  { id: 'A-CHECK', invariantId: 'WPE-INV-001', scenarioId: 'WPE-Q-001', evidenceClass: 'independent_checker', verdict: 'passed', sourceDigest: sha('e'), sourceRevision: 'a'.repeat(40), authority: 'measured', durable: true, assertionCode: 'checker-agreed' },
  { id: 'A-CANARY', invariantId: 'WPE-INV-007', scenarioId: 'WPE-Q-001', evidenceClass: 'canary_soak', verdict: 'passed', sourceDigest: sha('a'), sourceRevision: 'a'.repeat(40), authority: 'measured', durable: true, assertionCode: 'canary-soak-head-validated' },
  { id: 'A-ROLLBACK', invariantId: 'WPE-INV-007', scenarioId: 'WPE-Q-001', evidenceClass: 'rollback_rehearsal', verdict: 'passed', sourceDigest: sha('9'), sourceRevision: 'a'.repeat(40), authority: 'measured', durable: true, assertionCode: 'rollback-head-validated' },
  { id: 'A-OBS', invariantId: 'WPE-INV-001', scenarioId: 'WPE-Q-001', evidenceClass: 'operator_observation', verdict: 'passed', sourceDigest: sha('f'), sourceRevision: 'a'.repeat(40), authority: 'measured', durable: false, assertionCode: 'operator-noted' },
];

function telemetry(closeoutStatus: 'succeeded' | 'failed' = 'succeeded') {
  return buildQualificationTelemetry({
    effectiveMode: 'wave_parallel',
    requestedParallelism: 4,
    effectiveParallelism: 4,
    activeWaveCount: 0,
    activeStoryCount: 0,
    attemptIdentity: 'attempt-secret-local-id',
    leaseIdentity: 'lease-secret-local-id',
    rejectionCount: 0,
    conflictCount: 0,
    blockingCount: 0,
    integrationState: closeoutStatus === 'succeeded' ? 'validated' : 'failed',
    cleanupOutcome: 'complete',
    preservedRecoveryArtifactCount: 0,
    backpressureState: 'none',
    closeoutStatus,
  });
}

function report(overrides: Partial<Parameters<typeof buildQualificationReport>[0]> = {}): QualificationReport {
  return buildQualificationReport({
    localIdentity,
    testDatabaseIdentityHash: sha('0'),
    queueNamespace: 'qualification:qrun_1234567890abcdef12345678',
    repositorySeed: 'ci-seed-0001',
    invariantCatalog: [{ id: 'WPE-INV-001', statementDigest: sha('1') }],
    scenarioResults: [{ id: 'WPE-Q-001', verdict: 'passed', assertionIds: assertions.map(item => item.id) }],
    commitTopologyDigest: sha('2'),
    resourceBudgets: { peakMemoryMiB: { observed: 40, cap: 64, verdict: 'passed' } },
    evidenceAssertions: assertions,
    requiredAssertionIds: assertions.map(item => item.id),
    telemetry: [telemetry()],
    semanticCloseout: 'succeeded',
    ...overrides,
  });
}

function receipt(value: QualificationReport = report()): QualificationReceipt {
  return issueQualificationReceipt({
    report: value,
    issuedAt: '2026-07-19T12:00:00.000Z',
    expiresAt: '2026-07-20T12:00:00.000Z',
    issuer: { id: 'rorca-ci', keyId: 'qualification-v1' },
    platformRuntimeMatrix: [{ platform: 'linux', architecture: 'x64', node: '22.19.0', postgres: '16.4' }],
    signingKey: key,
  });
}

function verify(value: unknown, valueReport = report(), identity = localIdentity, required = ['WPE-Q-001']) {
  return verifyQualificationReceipt({
    receipt: value,
    report: valueReport,
    localIdentity: identity,
    requiredScenarioIds: required,
    requiredAssertionIds: assertions.map(item => item.id),
    trustedIssuers: { 'rorca-ci': { 'qualification-v1': key } },
    now: '2026-07-19T13:00:00.000Z',
  });
}

test('canonical portable JSON and human report are deterministic across independent invocations', () => {
  const value = report();
  const signed = receipt(value);
  const first = buildPortableQualificationArtifact(value, signed);
  const second = buildPortableQualificationArtifact(structuredClone(value), structuredClone(signed));
  assert.equal(second.canonicalJson, first.canonicalJson);
  assert.equal(second.humanReport, first.humanReport);
  assert.equal(second.artifactDigest, first.artifactDigest);
  assert.equal(first.canonicalJson, canonicalJson({ report: value, receipt: signed }));
  assert.match(first.humanReport, /durable_database_wal/);
  assert.match(first.humanReport, /operator_observation/);
  assert.match(first.humanReport, /skipped_check/);
  assert.match(first.humanReport, /environmental_blocker/);
  assert.doesNotMatch(first.canonicalJson, /attempt-secret-local-id|lease-secret-local-id/);
});

test('production enable requires durable database/WAL, Git, checker, telemetry and successful closeout evidence', () => {
  assert.equal(report().productionEnableAvailable, true);
  const terminalAssertions = assertions.map(item => ({
    ...item,
    evidenceClass: 'automated_test_output' as const,
    authority: 'synthetic_diagnostic' as const,
    durable: false,
  }));
  const terminalOnly = report({
    evidenceAssertions: terminalAssertions,
    scenarioResults: [{ id: 'WPE-Q-001', verdict: 'passed', assertionIds: terminalAssertions.map(item => item.id) }],
  });
  assert.equal(terminalOnly.productionEnableAvailable, false);
  assert.ok(terminalOnly.unavailableReasons.includes('missing-durable_database_wal'));
  assert.ok(terminalOnly.unavailableReasons.includes('missing-git_integration'));
  assert.ok(terminalOnly.unavailableReasons.includes('missing-independent_checker'));

  const syntheticForgery = report({ evidenceAssertions: assertions.map(item => ({ ...item, authority: 'synthetic_diagnostic' as const, durable: false })) });
  assert.equal(syntheticForgery.productionEnableAvailable, false);
  assert.ok(syntheticForgery.unavailableReasons.includes('missing-durable_database_wal'));

  const failed = report({ semanticCloseout: 'failed', telemetry: [telemetry('failed')] });
  assert.equal(failed.productionEnableAvailable, false);
  assert.ok(failed.unavailableReasons.includes('semantic-closeout-not-succeeded'));

  const skipped = report({ evidenceAssertions: assertions.map((item, index) => index === 0 ? {
    ...item, evidenceClass: 'skipped_check', verdict: 'skipped', assertionCode: 'check-skipped',
  } : item) });
  assert.equal(skipped.productionEnableAvailable, false);
  assert.ok(skipped.unavailableReasons.includes('skipped-check-present'));
});

test('telemetry hashes identities and bounds every cardinality-bearing count', () => {
  const value = buildQualificationTelemetry({
    effectiveMode: 'recovery', requestedParallelism: 1_000_000, effectiveParallelism: -4,
    activeWaveCount: Number.POSITIVE_INFINITY, activeStoryCount: 8, attemptIdentity: '/private/attempt', leaseIdentity: 'credential-value',
    rejectionCount: 2, conflictCount: 3, blockingCount: 4, integrationState: 'recovery', cleanupOutcome: 'partial',
    preservedRecoveryArtifactCount: 100_000, backpressureState: 'output', closeoutStatus: 'blocked',
  });
  assert.equal(value.requestedParallelism, 65_535);
  assert.equal(value.effectiveParallelism, 0);
  assert.equal(value.activeWaveCount, 0);
  assert.equal(value.preservedRecoveryArtifactCount, 65_535);
  assert.match(value.attemptIdentityHash, /^sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(value), /private|credential-value/);
});

test('receipt verification accepts only exact, current, trusted, locally matching authenticated receipts', () => {
  const valueReport = report();
  const signed = receipt(valueReport);
  assert.equal(verify(signed, valueReport).schemaVersion, QUALIFICATION_RECEIPT_SCHEMA);

  const unknown = { ...signed, surprise: true };
  assert.throws(() => verify(unknown, valueReport), /unknown or missing fields/);
  assert.throws(() => verify({ ...signed, schemaVersion: 'rorca.wave-qualification.receipt/v2' }, valueReport), /unsupported receipt/);
  assert.throws(() => verify({ ...signed, signature: 'bad' }, valueReport), /signature is malformed/);
  assert.throws(() => verifyQualificationReceipt({
    receipt: signed, report: valueReport, localIdentity, requiredScenarioIds: ['WPE-Q-001'], requiredAssertionIds: assertions.map(item => item.id), trustedIssuers: {}, now: '2026-07-19T13:00:00.000Z',
  }), /issuer is not trusted/);
  assert.throws(() => verifyQualificationReceipt({
    receipt: signed, report: valueReport, localIdentity, requiredScenarioIds: ['WPE-Q-001'], requiredAssertionIds: assertions.map(item => item.id), trustedIssuers: { 'rorca-ci': { 'qualification-v1': key } }, now: '2026-07-21T13:00:00.000Z',
  }), /expired/);

  for (const keyName of ['sourceRevision', 'sourceTree', 'repositoryIdentity', 'workspaceIdentity', 'engineDigest', 'policyDigest', 'compilerDigest', 'invariantDigest', 'testSuiteDigest', 'configurationDigest'] as const) {
    const changed = { ...localIdentity, [keyName]: keyName.startsWith('source') ? 'c'.repeat(40) : sha('f') };
    assert.throws(() => verify(signed, valueReport, changed), /does not match local/);
  }
  assert.throws(() => verify(signed, valueReport, localIdentity, ['WPE-Q-001', 'WPE-Q-999']), /missing a required passing scenario/);
  assert.throws(() => verifyQualificationReceipt({
    receipt: signed,
    report: valueReport,
    localIdentity,
    requiredScenarioIds: ['WPE-Q-001'],
    requiredAssertionIds: [...assertions.map(item => item.id), 'WPE-A-MISSING'],
    trustedIssuers: { 'rorca-ci': { 'qualification-v1': key } },
    now: '2026-07-19T13:00:00.000Z',
  }), /exact canonical assertion inventory/);
});

test('changed reports and malformed signatures cannot be copied into another qualification', () => {
  const firstReport = report();
  const signed = receipt(firstReport);
  const changedReport = report({ repositorySeed: 'ci-seed-0002' });
  assert.throws(() => verify(signed, changedReport), /report hash/);

  const failedGate = report({ semanticCloseout: 'failed', telemetry: [telemetry('failed')] });
  const failedReceipt = receipt(failedGate);
  assert.throws(() => verify(failedReceipt, failedGate), /does not make the production-enable gate available/);
});

test('portable report construction rejects paths, credential-shaped values, and terminal evidence promoted as durable', () => {
  assert.throws(() => report({ repositorySeed: '/Users/example/private' }), /bounded portable identifier/);
  const promoted = assertions.map(item => item.evidenceClass === 'automated_test_output' ? { ...item, durable: true } : item);
  assert.throws(() => report({ evidenceAssertions: promoted }), /cannot be promoted/);
  assert.throws(() => issueQualificationReceipt({
    report: report(), issuedAt: '2026-07-19', expiresAt: '2026-07-20', issuer: { id: 'rorca-ci', keyId: 'v1' },
    platformRuntimeMatrix: [{ platform: 'linux', architecture: 'x64', node: '22.19.0', postgres: '16' }], signingKey: 'short',
  }), /at least 32 bytes/);
});

test('publication storage is append-only and every operator endpoint is explicitly admin-tiered', () => {
  const migration = fs.readFileSync(path.join(repositoryRoot, 'backend', 'src', 'db', 'pg-migrations', '20260719103000_wave_qualification_receipts.sql'), 'utf8');
  assert.match(migration, /production_enable_available BOOLEAN NOT NULL CHECK \(production_enable_available\)/);
  assert.match(migration, /BEFORE UPDATE OR DELETE/);
  assert.match(migration, /append-only/);
  assert.doesNotMatch(migration, /(?:CREATE|ALTER|DROP|DELETE|UPDATE|INSERT)[^;]*pgboss\./i);

  const route = fs.readFileSync(path.join(repositoryRoot, 'backend', 'src', 'routes', 'wave-qualification.ts'), 'utf8');
  assert.equal((route.match(/router\.(?:get|post|put)\(/g) ?? []).length, 10);
  assert.equal((route.match(/x-rorca-tier: admin/g) ?? []).length, 10);
  assert.equal((route.match(/x-rorca-rationale:/g) ?? []).length, 10);
  assert.match(route, /router\.use\(requireWaveQualificationAdmin\)/);
  assert.match(route, /req\.user\?\.role !== 'admin'/);
  assert.doesNotMatch(route, /res\.json\([^)]*(?:path|human_report|signingKey)/);
});
