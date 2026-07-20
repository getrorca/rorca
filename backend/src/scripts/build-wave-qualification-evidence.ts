/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildPortableQualificationArtifact,
  buildQualificationReport,
  buildQualificationTelemetry,
  canonicalJson,
  computeLocalQualificationIdentity,
  issueQualificationReceipt,
  type QualificationEvidenceAssertion,
  type QualificationReport,
} from '../lib/wave-qualification-evidence';
import {
  QUALIFICATION_SCENARIOS,
  runQualificationSchedule,
  type PerformanceMetric,
  type QualificationBudgetSet,
} from '../lib/wave-qualification-model';

function hash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(argument => argument.startsWith(prefix))?.slice(prefix.length);
}

function safeToken(value: string | undefined, fallback: string): string {
  return value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : fallback;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function writeAtomic(target: string, content: string): void {
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, target);
}

function main(): void {
  const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
  const requestedOutput = option('output') ?? '';
  const outputDirectory = path.resolve(repositoryRoot, requestedOutput);
  if (!requestedOutput || !contained(path.join(repositoryRoot, '.rorca'), outputDirectory)) {
    throw new Error('[wave-qualification-builder] output must be under .rorca');
  }
  const issuedAt = new Date(option('issued-at') ?? '');
  if (!Number.isFinite(issuedAt.getTime())) throw new Error('[wave-qualification-builder] issued-at must be an ISO timestamp');
  const expiresAt = new Date(issuedAt.getTime() + 24 * 60 * 60 * 1_000);
  const seed = safeToken(option('seed'), 'ci-matrix');
  const parentPassed = option('test-verdict') === 'passed';

  const identity = computeLocalQualificationIdentity(repositoryRoot, 'rorca');
  const registry = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'docs', 'qualification', 'wave-parallel-invariants.json'), 'utf8')) as {
    invariants: Array<{ id: string; statement: string }>;
    scenarios: Array<{ id: string; name: string }>;
  };
  const crossReference = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'docs', 'qualification', 'wave-parallel-v1', 'cross-reference.json'),
    'utf8',
  )) as {
    entries: Array<{
      requirementId: string;
      invariantIds: string[];
      scenarioIds: string[];
      assertionIds: string[];
      evidenceClasses: QualificationEvidenceAssertion['evidenceClass'][];
    }>;
  };
  const budgets = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'docs', 'qualification', 'wave-stress-baseline-v1.json'), 'utf8')) as QualificationBudgetSet;
  const results = QUALIFICATION_SCENARIOS.flatMap(scenario => ([2, 4] as const).map(parallelism => runQualificationSchedule({ seed, scenario, parallelism })));
  const normalizedDigest = hash(results.map(result => result.normalized));

  const assertions: QualificationEvidenceAssertion[] = crossReference.entries.map(entry => ({
    id: entry.assertionIds[0],
    invariantId: entry.invariantIds[0],
    scenarioId: entry.scenarioIds[0],
    evidenceClass: entry.evidenceClasses[0],
    verdict: parentPassed ? 'passed' : 'failed',
    sourceDigest: hash({ normalizedDigest, requirementId: entry.requirementId }),
    sourceRevision: identity.sourceRevision,
    authority: 'synthetic_diagnostic' as const,
    durable: false,
    assertionCode: parentPassed ? 'cross-reference-regression-passed' : 'cross-reference-regression-failed',
  }));
  const observed = {} as Record<PerformanceMetric, number>;
  for (const metric of Object.keys(budgets.metrics) as PerformanceMetric[]) {
    observed[metric] = Math.max(...results.map(result => result.performance[metric]));
  }
  const resourceBudgets: QualificationReport['resourceBudgets'] = Object.fromEntries(
    (Object.entries(budgets.metrics) as [PerformanceMetric, QualificationBudgetSet['metrics'][PerformanceMetric]][]).map(([metric, budget]) => {
      const cap = Math.min(budget.absoluteCap, budget.baseline * budget.baselineMultiplier);
      return [metric, { observed: observed[metric], cap, verdict: observed[metric] <= cap ? 'passed' : 'failed' }];
    }),
  );
  const runtimeScenarioResults = QUALIFICATION_SCENARIOS.map((scenario, index) => ({
    id: scenario,
    verdict: parentPassed ? 'passed' as const : 'failed' as const,
    assertionIds: [assertions[index % assertions.length].id],
  }));
  const canonicalScenarioResults = registry.scenarios.map(scenario => ({
    id: scenario.id,
    verdict: parentPassed ? 'passed' as const : 'failed' as const,
    assertionIds: crossReference.entries
      .filter(entry => entry.scenarioIds.includes(scenario.id))
      .flatMap(entry => entry.assertionIds)
      .sort(),
  }));
  const scenarioResults = [...runtimeScenarioResults, ...canonicalScenarioResults];
  const telemetry = buildQualificationTelemetry({
    effectiveMode: 'wave_parallel',
    requestedParallelism: 4,
    effectiveParallelism: 4,
    activeWaveCount: 0,
    activeStoryCount: 0,
    attemptIdentity: `${seed}:aggregate-attempt`,
    leaseIdentity: `${seed}:aggregate-lease`,
    rejectionCount: results.filter(result => result.scenario.includes('reject')).length,
    conflictCount: results.filter(result => result.scenario === 'conflict').length,
    blockingCount: results.reduce((count, result) => count + Object.values(result.terminal.stories).filter(story => story.state === 'blocked').length, 0),
    integrationState: parentPassed ? 'validated' : 'failed',
    cleanupOutcome: results.every(result => Object.values(result.resources.final).every((value, index) => index < 2 || value === 0)) ? 'complete' : 'failed',
    preservedRecoveryArtifactCount: results.reduce((count, result) => count + result.normalized.recoveryInventory.length, 0),
    backpressureState: 'none',
    closeoutStatus: parentPassed ? 'succeeded' : 'failed',
  });
  const report = buildQualificationReport({
    localIdentity: identity,
    testDatabaseIdentityHash: /^sha256:[0-9a-f]{64}$/.test(process.env.RORCA_QUALIFICATION_TEST_DATABASE_IDENTITY_HASH ?? '')
      ? process.env.RORCA_QUALIFICATION_TEST_DATABASE_IDENTITY_HASH!
      : hash('provider-free-test-database:none'),
    queueNamespace: `qualification:qrun_${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`,
    repositorySeed: seed,
    invariantCatalog: registry.invariants.map(invariant => ({ id: invariant.id, statementDigest: hash(invariant.statement) })),
    scenarioResults,
    commitTopologyDigest: hash(results.map(result => result.normalized.commitTopology)),
    resourceBudgets,
    evidenceAssertions: assertions,
    requiredAssertionIds: crossReference.entries.flatMap(entry => entry.assertionIds),
    telemetry: [telemetry],
    semanticCloseout: parentPassed ? 'succeeded' : 'failed',
  });
  const signingKey = process.env.RORCA_QUALIFICATION_SIGNING_KEY ?? 'rorca-local-untrusted-qualification-key-v1';
  const receipt = issueQualificationReceipt({
    report,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    issuer: {
      id: safeToken(process.env.RORCA_QUALIFICATION_ISSUER_ID, 'rorca-local-untrusted'),
      keyId: safeToken(process.env.RORCA_QUALIFICATION_KEY_ID, 'local-v1'),
    },
    platformRuntimeMatrix: [{
      platform: process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux',
      architecture: process.arch === 'arm64' ? 'arm64' : 'x64',
      node: process.versions.node,
      postgres: safeToken(process.env.RORCA_QUALIFICATION_POSTGRES_VERSION, '16'),
    }],
    signingKey,
  });
  const artifact = buildPortableQualificationArtifact(report, receipt);

  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  writeAtomic(path.join(outputDirectory, 'qualification.json'), artifact.canonicalJson);
  writeAtomic(path.join(outputDirectory, 'qualification.md'), artifact.humanReport);
  writeAtomic(path.join(outputDirectory, 'receipt.json'), canonicalJson(receipt));
  process.stdout.write(`${canonicalJson({
    schemaVersion: 1,
    artifactDigest: artifact.artifactDigest,
    reportHash: receipt.reportHash,
    productionEnableAvailable: report.productionEnableAvailable,
  })}`);
}

try {
  main();
} catch {
  process.stderr.write('[wave-qualification-builder] report generation, signing, telemetry, or publication failed (details redacted)\n');
  process.exitCode = 1;
}
