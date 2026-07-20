#!/usr/bin/env node
// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profiles = {
  ci: { timeoutMs: 60_000, seeds: 3, repeats: 2 },
  soak: { timeoutMs: 840_000, seeds: 100, repeats: 5 },
  diagnostic: { timeoutMs: 60_000, seeds: 1, repeats: 2 },
};
const maxCaptureBytes = 256 * 1024;

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find(argument => argument.startsWith(prefix))?.slice(prefix.length);
}

function safeToken(value, fallback) {
  return value && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : fallback;
}

const profileName = safeToken(option('profile'), 'ci');
const profile = profiles[profileName];
if (!profile) {
  console.error('[wave-stress] profile must be ci, soak, or diagnostic');
  process.exitCode = 2;
} else {
  const seed = safeToken(option('seed'), `${profileName}-matrix`);
  const scenario = safeToken(option('scenario'), 'all');
  const parallelism = safeToken(option('parallelism'), '2-and-4');
  const startedAt = new Date().toISOString();
  const baselineMemory = process.memoryUsage().rss;
  const tsx = path.join(root, 'backend', 'node_modules', '.bin', 'tsx');
  const testFile = path.join(root, 'backend', 'src', 'lib', '__tests__', 'wave-qualification-model.node.test.ts');
  const childEnv = {
    NODE_ENV: 'test',
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
    ...(process.env.CI ? { CI: process.env.CI } : {}),
    RORCA_WAVE_QUALIFICATION_PROFILE: profileName,
    RORCA_WAVE_SOAK_SEEDS: String(profile.seeds),
    RORCA_WAVE_SOAK_REPEATS: String(profile.repeats),
    RORCA_WAVE_DIAGNOSTIC_SEED: seed,
    RORCA_WAVE_DIAGNOSTIC_SCENARIO: scenario,
    RORCA_WAVE_DIAGNOSTIC_PARALLELISM: parallelism,
  };
  const child = spawn(tsx, ['--test', testFile], {
    cwd: root,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  });

  const terminate = signal => {
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, signal); } catch { /* already exited */ }
    }
    try { child.kill(signal); } catch { /* already exited */ }
  };
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let captureOverflow = false;
  let forceTimer;
  const beginBoundedTeardown = () => {
    terminate('SIGTERM');
    forceTimer ??= setTimeout(() => terminate('SIGKILL'), 1_000);
    forceTimer.unref?.();
  };
  const append = (current, chunk) => {
    const combined = Buffer.concat([current, chunk]);
    if (combined.length <= maxCaptureBytes) return combined;
    captureOverflow = true;
    return combined.subarray(combined.length - maxCaptureBytes);
  };
  child.stdout.on('data', chunk => {
    stdout = append(stdout, chunk);
    if (captureOverflow) beginBoundedTeardown();
  });
  child.stderr.on('data', chunk => {
    stderr = append(stderr, chunk);
    if (captureOverflow) beginBoundedTeardown();
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    beginBoundedTeardown();
  }, profile.timeoutMs);
  timer.unref?.();

  const exit = await new Promise(resolve => {
    child.once('error', () => resolve({ code: 1, signal: null }));
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
  clearTimeout(timer);
  if (forceTimer) clearTimeout(forceTimer);

  // Report generation is a separate blocking phase. Child terminal output is never
  // accepted as evidence and is not supplied to the builder.
  const testPassed = exit.code === 0 && !timedOut && !captureOverflow;
  const artifactId = createHash('sha256').update(`${startedAt}:${seed}:${profileName}`).digest('hex').slice(0, 16);
  const artifactDirectory = path.join('.rorca', 'qualification', artifactId);
  const evidenceBuilder = path.join(root, 'backend', 'src', 'scripts', 'build-wave-qualification-evidence.ts');
  const evidenceEnv = { ...childEnv };
  for (const key of ['RORCA_QUALIFICATION_SIGNING_KEY', 'RORCA_QUALIFICATION_ISSUER_ID', 'RORCA_QUALIFICATION_KEY_ID', 'RORCA_QUALIFICATION_POSTGRES_VERSION', 'RORCA_QUALIFICATION_TEST_DATABASE_IDENTITY_HASH']) {
    if (process.env[key]) evidenceEnv[key] = process.env[key];
  }
  const evidenceChild = spawn(tsx, [
    evidenceBuilder,
    `--output=${artifactDirectory}`,
    `--issued-at=${startedAt}`,
    `--seed=${seed}`,
    `--test-verdict=${testPassed ? 'passed' : 'failed'}`,
  ], {
    cwd: root,
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: evidenceEnv,
  });
  let evidenceOutput = Buffer.alloc(0);
  let evidenceOverflow = false;
  evidenceChild.stdout.on('data', chunk => {
    evidenceOutput = Buffer.concat([evidenceOutput, chunk]);
    if (evidenceOutput.length > 16 * 1024) {
      evidenceOverflow = true;
      try { evidenceChild.kill('SIGKILL'); } catch { /* already exited */ }
    }
  });
  let evidenceTimedOut = false;
  const evidenceTimer = setTimeout(() => {
    evidenceTimedOut = true;
    try { evidenceChild.kill('SIGKILL'); } catch { /* already exited */ }
  }, 30_000);
  evidenceTimer.unref?.();
  const evidenceExit = await new Promise(resolve => {
    evidenceChild.once('error', () => resolve(1));
    evidenceChild.once('close', code => resolve(code ?? 1));
  });
  clearTimeout(evidenceTimer);
  let evidenceSummary;
  try {
    evidenceSummary = evidenceOverflow ? undefined : JSON.parse(evidenceOutput.toString('utf8'));
  } catch {
    evidenceSummary = undefined;
  }
  let canonicalTraceabilityPassed = false;
  try {
    const artifact = JSON.parse(fs.readFileSync(path.join(root, artifactDirectory, 'qualification.json'), 'utf8'));
    const crossReference = JSON.parse(fs.readFileSync(
      path.join(root, 'docs', 'qualification', 'wave-parallel-v1', 'cross-reference.json'),
      'utf8',
    ));
    const requiredAssertionIds = crossReference.entries.flatMap(entry => entry.assertionIds).sort();
    const observedAssertionIds = artifact.report.evidenceAssertions.map(assertion => assertion.id).sort();
    const scenarioBindings = new Map(artifact.report.scenarioResults.map(result => [result.id, new Set(result.assertionIds)]));
    canonicalTraceabilityPassed = JSON.stringify(requiredAssertionIds) === JSON.stringify(observedAssertionIds)
      && crossReference.entries.every(entry => entry.scenarioIds.some(scenarioId =>
        entry.assertionIds.every(assertionId => scenarioBindings.get(scenarioId)?.has(assertionId)),
      ));
  } catch {
    canonicalTraceabilityPassed = false;
  }
  const evidencePassed = evidenceExit === 0
    && !evidenceTimedOut
    && evidenceSummary?.schemaVersion === 1
    && typeof evidenceSummary?.artifactDigest === 'string'
    && canonicalTraceabilityPassed;

  const firstAttempt = true;
  const summary = {
    schemaVersion: 1,
    profile: profileName,
    firstAttempt: true,
    // `passed` is only the provider-free diagnostic execution result. It is never
    // a production qualification result: the portable report decides that gate.
    passed: testPassed && evidencePassed,
    syntheticDiagnostic: true,
    qualificationGatePassed: evidencePassed ? evidenceSummary.productionEnableAvailable === true : false,
    exitCode: exit.code,
    timedOut,
    captureOverflow,
    evidencePublicationPassed: evidencePassed,
    artifactDigest: evidencePassed ? evidenceSummary.artifactDigest : null,
    productionEnableAvailable: evidencePassed ? evidenceSummary.productionEnableAvailable === true : false,
    portableArtifact: evidencePassed ? artifactDirectory : null,
    seedCount: profile.seeds,
    scenario: scenario === 'all' ? 'versioned-matrix' : scenario,
    parallelism,
    startedAt,
    finishedAt: new Date().toISOString(),
  };

  if (summary.passed) {
    process.stdout.write(stdout);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } else {
    const failureId = createHash('sha256').update(`${startedAt}:${seed}:${scenario}:${parallelism}`).digest('hex').slice(0, 16);
    const relativeDirectory = path.join('.rorca', 'qualification-failures', failureId);
    const outputDirectory = path.join(root, relativeDirectory);
    fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
    const report = {
      ...summary,
      seed,
      faultPoint: 'WPE-FP-009',
      normalizedEventTrace: [{ sequence: 1, type: timedOut ? 'qualification-timeout' : 'qualification-child-failed' }],
      repositoryBundle: { kind: 'safe-recovery-references', references: [] },
      resourceSamples: [
        { phase: 'baseline', rssBytes: baselineMemory },
        { phase: 'final', rssBytes: process.memoryUsage().rss },
      ],
      exactRerunCommand: `npm run qualify:wave:diagnostic -- --seed=${seed} --scenario=${scenario} --parallelism=${parallelism}`,
      preservedArtifact: relativeDirectory,
      firstAttemptAuthoritative: firstAttempt,
      note: 'The diagnostic rerun is separate and never replaces this first-attempt result.',
    };
    fs.writeFileSync(path.join(outputDirectory, 'failure.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    // Child output is intentionally not persisted: stack paths and inherited tool output
    // are not portable qualification evidence. The bounded bytes are only counted.
    report.capturedStdoutBytes = stdout.length;
    report.capturedStderrBytes = stderr.length;
    process.stderr.write(`${JSON.stringify(report)}\n`);
    process.exitCode = 1;
  }
}
