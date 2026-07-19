#!/usr/bin/env node
/* Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'wave-agent-scenarios.json'), 'utf8'));
const allowedBehaviors = new Set([
  'pass', 'reject-before-commit', 'reject-after-commit', 'dirty-worktree-rejection',
  'bounded-sleep', 'barrier-pass', 'timeout', 'cancellation', 'abrupt-exit', 'restart-resume',
]);
const sensitiveKey = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|DATABASE|PGHOST|AWS|AZURE|GOOGLE|GITHUB|GITLAB|ANTHROPIC|CLAUDE|OPENAI|OPENROUTER)/i;
let sequence = 0;
let request;
let scenario;

function emit(type, data = {}) {
  const event = {
    schemaVersion: 1,
    sequence: ++sequence,
    type,
    executionId: request?.executionId ?? 'uninitialized',
    scenarioId: request?.scenarioId ?? 'uninitialized',
    at: new Date().toISOString(),
    wallClockMs: Date.now(),
    ...data,
  };
  const line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line) > 4096) throw new Error('fixture event exceeds 4096 bytes');
  process.stdout.write(line);
}

function fail(message, exitCode = 64) {
  emit('fixture-error', { reason: message });
  process.exit(exitCode);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function strictlyContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('request must be an object');
  const allowedKeys = new Set(['executionId', 'storyId', 'scenarioId', 'seed', 'revision', 'attempt', 'barrierDirectory']);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(`request key ${key} is forbidden`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.executionId ?? '')) fail('execution identity is invalid');
  if (typeof value.storyId !== 'string' || value.storyId.length === 0 || value.storyId.length > 128) fail('story identity is invalid');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(value.scenarioId ?? '')) fail('scenario identity is invalid');
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(value.seed ?? '')) fail('seed is invalid');
  if (!/^[a-f0-9]{40,64}$/.test(value.revision ?? '')) fail('repository revision is invalid');
  if (!Number.isInteger(value.attempt) || value.attempt < 1 || value.attempt > 2) fail('attempt is invalid');
}

function assertManifestEntry(entry) {
  if (!entry || typeof entry !== 'object' || !allowedBehaviors.has(entry.behavior)) fail('scenario is not in the versioned manifest');
  for (const forbidden of ['command', 'args', 'shell', 'script', 'url', 'host']) {
    if (Object.prototype.hasOwnProperty.call(entry, forbidden)) fail(`manifest field ${forbidden} is forbidden`);
  }
  if (!/^WPE-FP-00[1-9]$/.test(entry.faultPoint ?? '')) fail('scenario fault point is invalid');
  if (!/^[A-Za-z0-9_./-]{1,128}$/.test(entry.file ?? '') || path.isAbsolute(entry.file) || entry.file.includes('..')) fail('scenario file is invalid');
  if (typeof entry.commitMessage !== 'string' || entry.commitMessage.length > 100) fail('scenario commit message is invalid');
}

async function waitAtBarrier(barrier) {
  if (!request.barrierDirectory) fail('barrier directory is required');
  const fixtureRoot = fs.realpathSync(process.env.RORCA_FIXTURE_ROOT ?? '');
  const barrierDirectory = fs.realpathSync(request.barrierDirectory);
  if (!strictlyContained(fixtureRoot, barrierDirectory)) fail('barrier escaped the fixture root');
  const arrival = path.join(barrierDirectory, `${request.executionId}.arrival.json`);
  fs.writeFileSync(arrival, `${JSON.stringify({ executionId: request.executionId, pid: process.pid })}\n`, { flag: 'wx', mode: 0o600 });
  emit('barrier-arrived', { participantCount: barrier.participants });
  const deadline = Date.now() + barrier.maxWaitMs;
  while (Date.now() <= deadline) {
    const arrivals = fs.readdirSync(barrierDirectory).filter(name => name.endsWith('.arrival.json'));
    if (arrivals.length >= barrier.participants) {
      emit('barrier-released', { observedParticipants: arrivals.length });
      return;
    }
    await sleep(barrier.pollMs);
  }
  fail('bounded barrier wait expired', 72);
}

function deterministicSource() {
  const digest = createHash('sha256')
    .update(`${request.seed}\n${request.revision}\n${request.scenarioId}\n`)
    .digest('hex');
  return `scenario=${request.scenarioId}\nseeded-change=${digest}\n`;
}

function writeSource() {
  const target = path.resolve(process.cwd(), scenario.file);
  if (!strictlyContained(process.cwd(), target)) fail('source target escaped repository');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const content = deterministicSource();
  fs.writeFileSync(target, content, 'utf8');
  emit('source-changed', {
    file: scenario.file,
    contentSha256: createHash('sha256').update(content).digest('hex'),
  });
}

function commitSource() {
  git(['add', '--', scenario.file]);
  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Rorca Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@rorca.invalid',
    GIT_COMMITTER_NAME: 'Rorca Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@rorca.invalid',
    GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z',
  };
  git(['commit', '-m', scenario.commitMessage], { env: commitEnv });
  emit('story-committed', { commit: git(['rev-parse', 'HEAD']), commitMessage: scenario.commitMessage });
}

function spawnDescendant() {
  if (!scenario.spawnDescendant) return;
  const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), '--descendant'], {
    env: { NODE_ENV: 'test' },
    detached: false,
    shell: false,
    stdio: 'ignore',
  });
  descendant.unref();
  emit('descendant-started', { descendantPid: descendant.pid });
}

if (process.argv[2] === '--descendant') {
  setInterval(() => {}, 1000);
} else {
  try {
    const encoded = process.argv[2] ?? '';
    if (!/^[A-Za-z0-9_-]{1,16384}$/.test(encoded)) process.exit(64);
    request = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    assertRequest(request);
    scenario = manifest.scenarios?.[request.scenarioId];
    assertManifestEntry(scenario);
    if (git(['rev-parse', 'HEAD']) !== request.revision) fail('repository revision does not match request');

    process.once('SIGTERM', () => {
      emit('story-signalled', { signal: 'SIGTERM' });
      process.exit(143);
    });
    process.once('SIGINT', () => {
      emit('story-signalled', { signal: 'SIGINT' });
      process.exit(130);
    });

    emit('lifecycle-initialized', {
      lifecycle: {
        started: false,
        committed: false,
        signalled: false,
        exited: false,
        hostValidation: false,
        integration: false,
        finalCloseout: false,
      },
    });
    emit('story-started', {
      pid: process.pid,
      faultPoint: scenario.faultPoint,
      inheritedSensitiveKeys: Object.keys(process.env).filter(key => sensitiveKey.test(key)),
      networkPolicy: 'external-services-disabled',
    });
    spawnDescendant();

    if (scenario.behavior === 'reject-before-commit') {
      emit('story-rejected', { phase: 'before-commit' });
      process.exit(30);
    }
    if (scenario.behavior === 'abrupt-exit') {
      emit('abrupt-exit-requested', { exitCode: 86 });
      process.exit(86);
    }
    if (scenario.behavior === 'timeout' || scenario.behavior === 'cancellation') {
      await sleep(scenario.sleepMs);
    }
    if (scenario.behavior === 'bounded-sleep') {
      await sleep(scenario.sleepMs);
      emit('bounded-sleep-completed', { configuredMs: scenario.sleepMs });
    }
    if (scenario.behavior === 'barrier-pass') await waitAtBarrier(scenario.barrier);

    if (scenario.behavior === 'restart-resume') {
      const checkpoint = path.join(process.cwd(), `.fixture-${request.scenarioId}.checkpoint.json`);
      if (request.attempt === 1) {
        writeSource();
        fs.writeFileSync(checkpoint, `${JSON.stringify({ seed: request.seed, revision: request.revision, scenarioId: request.scenarioId })}\n`, { flag: 'wx', mode: 0o600 });
        emit('restart-checkpoint-persisted', { faultPoint: scenario.faultPoint });
        process.exit(87);
      }
      const saved = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
      if (saved.seed !== request.seed || saved.revision !== request.revision || saved.scenarioId !== request.scenarioId) fail('restart checkpoint identity mismatch');
      fs.unlinkSync(checkpoint);
      emit('restart-checkpoint-resumed', { faultPoint: scenario.faultPoint });
    } else {
      writeSource();
    }

    if (scenario.behavior === 'dirty-worktree-rejection') {
      emit('story-rejected', { phase: 'dirty-worktree' });
      process.exit(32);
    }

    commitSource();
    if (scenario.behavior === 'reject-after-commit') {
      emit('story-rejected', { phase: 'after-commit' });
      process.exit(31);
    }

    emit('story-finished', { status: 'pass' });
    process.exit(0);
  } catch (error) {
    if (request) fail(error instanceof Error ? error.message : String(error));
    process.exit(64);
  }
}
