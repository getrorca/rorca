/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Linux X-High acceptance for the production launcher -> boundary probe ->
 * bwrap -> relay -> operation broker -> real child-process seam. Nothing in
 * autonomous-sandbox, autonomous-model-egress, child_process, or the four
 * launchers is mocked. The provider protocol is implemented by regular files
 * installed into an invocation-owned root-owned fixture tool root.
 */

import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV,
  AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV,
  AUTONOMOUS_EGRESS_OPERATION_ID_ENV,
  AUTONOMOUS_EGRESS_RUN_ID_ENV,
  closeAutonomousModelEgress,
  closeAutonomousModelEgressForTests,
  ensureAutonomousModelEgress,
  type AutonomousModelEgressRunIdentity,
} from '../autonomous-model-egress';
import {
  assertAutonomousExecutionBoundary,
  resetAutonomousSandboxProbeForTests,
} from '../autonomous-sandbox';

jest.setTimeout(90_000);

const fixtureRoot = String(process.env.RORCA_XHIGH_MODEL_FIXTURE_ROOT ?? '').trim();
const fixtureBins = Object.fromEntries(['claude', 'pi', 'codex', 'opencode']
  .map(kind => [kind, path.join(fixtureRoot || '/', `xhigh-${kind}`)])) as Record<string, string>;
const requiredLinuxToolGroups = [
  ['/usr/local/bin/rorca-sandbox-launcher'],
  ['/usr/local/bin/node', '/usr/bin/node'],
  ['/usr/local/bin/python3', '/usr/bin/python3'],
  ['/usr/local/bin/git', '/usr/bin/git'],
  ['/usr/local/bin/gh', '/usr/bin/gh'],
  ['/usr/local/bin/npm', '/usr/bin/npm'],
  ['/usr/local/bin/npx', '/usr/bin/npx'],
];
const fixtureRootTrusted = (() => {
  if (!fixtureRoot || !path.isAbsolute(fixtureRoot) || !fs.existsSync(fixtureRoot)) return false;
  const stat = fs.statSync(fixtureRoot);
  return stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o022) === 0
    && Object.values(fixtureBins).every(candidate => {
      try {
        const candidateStat = fs.statSync(candidate);
        return candidateStat.isFile() && candidateStat.uid === 0
          && (candidateStat.mode & 0o022) === 0
          && (candidateStat.mode & 0o111) !== 0;
      } catch { return false; }
    });
})();
const canRunNativeLinuxPath = process.platform === 'linux'
  && fixtureRootTrusted
  && requiredLinuxToolGroups.every(candidates => candidates.some(candidate => fs.existsSync(candidate)));
const linuxTest = canRunNativeLinuxPath ? test : test.skip;

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function initializeRepository(cwd: string): void {
  execFileSync('git', ['init', '--initial-branch=main'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'linux-cert@rorca.invalid'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Rorca Linux Certification'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'linux certification fixture'], { cwd, stdio: 'ignore' });
}

function brokerRoots(): string[] {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  return fs.readdirSync(temporaryRoot)
    .filter(name => name.startsWith('rorca-model-egress-run-'))
    .map(name => path.join(temporaryRoot, name))
    .sort();
}

async function waitForFiles(files: readonly string[], timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (files.every(file => fs.existsSync(file))) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for real launcher fixtures: ${files.filter(file => !fs.existsSync(file)).join(', ')}`);
}

function configureFixtureEnvironment(): void {
  process.env.NODE_ENV = 'test';
  process.env.CLAUDE_BIN = fixtureBins.claude;
  process.env.PI_BIN = fixtureBins.pi;
  process.env.CODEX_BIN = fixtureBins.codex;
  process.env.OPENCODE_BIN = fixtureBins.opencode;
  process.env.RORCA_AUTONOMOUS_ISOLATION = 'linux-bwrap';
  process.env.RORCA_BWRAP_BIN = '/usr/local/bin/rorca-sandbox-launcher';
  const nodeRuntimeRoot = path.dirname(path.dirname(fs.realpathSync(process.execPath)));
  const defaultToolRoots = ['/usr', '/bin', '/lib', '/lib64'].filter(root => fs.existsSync(root));
  process.env.RORCA_AUTONOMOUS_TOOL_ROOTS = [...new Set([...defaultToolRoots, nodeRuntimeRoot, fixtureRoot])].join(':');
  process.env.RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS = 'model-api.example.invalid';
}

function restoreEnvironment(original: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, original);
}

async function loadLaunchers() {
  const { draftSpecWithCodex } = await import('../codex-spec-drafter');
  const { draftSpecWithPi } = await import('../pi-spec-drafter');
  const { generateSpecViaOpenCode } = await import('../opencode-spec-gen');
  const { chatComplete } = await import('../llm-client');
  return { draftSpecWithCodex, draftSpecWithPi, generateSpecViaOpenCode, chatComplete };
}

linuxTest('all four real launchers concurrently receive immutable isolated operation brokers while a run broker remains independent', async () => {
  const originalEnv = { ...process.env };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-xhigh-linux-launchers-'));
  initializeRepository(cwd);
  const rootsBefore = brokerRoots();
  const runIdentity: AutonomousModelEgressRunIdentity = {
    runId: 900_001,
    authorityHash: sha256('xhigh-concurrent-run-authority'),
  };
  let runSocket: string | null = null;
  try {
    configureFixtureEnvironment();
    assertAutonomousExecutionBoundary({ cwd, providerCapable: true });
    const runEnv: NodeJS.ProcessEnv = {
      ...process.env,
      RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS: 'run-model.example.invalid',
    };
    runSocket = await ensureAutonomousModelEgress(runEnv, 'linux-bwrap', runIdentity);
    if (!runSocket) throw new Error('run broker fixture was not created');

    // Prove the API launch helper does not inherit a valid ambient run broker.
    process.env.RORCA_AUTONOMOUS_EGRESS_SOCKET = runEnv.RORCA_AUTONOMOUS_EGRESS_SOCKET;
    process.env[AUTONOMOUS_EGRESS_RUN_ID_ENV] = runEnv[AUTONOMOUS_EGRESS_RUN_ID_ENV];
    process.env[AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV] = runEnv[AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV];
    process.env[AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV] = runEnv[AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV];
    process.env[AUTONOMOUS_EGRESS_OPERATION_ID_ENV] = 'operation:caller-controlled-identity-is-never-used';

    const launchers = await loadLaunchers();
    // Attach all rejection handlers before inspecting the live overlap so an
    // early launcher failure cannot become an unhandled operation promise.
    const operations = Promise.all([
      launchers.draftSpecWithCodex({ cwd, prompt: 'draft' }),
      launchers.draftSpecWithPi({ cwd, prompt: 'draft' }),
      launchers.generateSpecViaOpenCode({
        workspacePath: cwd,
        title: 'X-High Linux', brief: 'Real launcher seam', storyCount: 1,
        storyPrefix: 'US', directionContext: '',
      }),
      launchers.chatComplete([{ role: 'user', content: 'hello' }], { cwd }),
    ] as const);

    const started = ['claude', 'pi', 'codex', 'opencode']
      .map(kind => path.join(cwd, `.xhigh-${kind}-started`));
    await waitForFiles(started);

    const liveRoots = brokerRoots().filter(root => !rootsBefore.includes(root));
    expect(liveRoots).toHaveLength(5);
    const metadata = liveRoots.map(root => JSON.parse(fs.readFileSync(path.join(root, 'broker.json'), 'utf8')) as {
      ownerType: string; operationId?: string; runId?: number; allowedHosts: string[]; socketPath: string;
    });
    const operationMetadata = metadata.filter(item => item.ownerType === 'operation');
    const runMetadata = metadata.filter(item => item.ownerType === 'run');
    expect(operationMetadata).toHaveLength(4);
    expect(new Set(operationMetadata.map(item => item.operationId)).size).toBe(4);
    expect(operationMetadata.every(item => item.allowedHosts.join(',') === 'model-api.example.invalid')).toBe(true);
    expect(runMetadata).toEqual([expect.objectContaining({
      runId: runIdentity.runId,
      allowedHosts: ['run-model.example.invalid'],
      socketPath: runSocket,
    })]);
    expect(new Set(metadata.map(item => path.dirname(item.socketPath))).size).toBe(5);

    fs.writeFileSync(path.join(cwd, '.xhigh-release'), 'release\n', { mode: 0o600 });
    const [codex, pi, opencode, claude] = await operations;
    expect(codex.text).toBe('{"stories":[]}');
    expect(pi.sessionId).toBe('xhigh-linux-session');
    expect(opencode).toEqual(expect.objectContaining({ stories: expect.any(Array) }));
    expect(claude.text).toBe('xhigh-claude-ok');

    expect(fs.existsSync(runSocket)).toBe(true);
    expect(brokerRoots()).toEqual([...rootsBefore, path.dirname(runSocket)].sort());
  } finally {
    if (runSocket) await closeAutonomousModelEgress(runIdentity);
    await closeAutonomousModelEgressForTests();
    resetAutonomousSandboxProbeForTests();
    restoreEnvironment(originalEnv);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  expect(brokerRoots()).toEqual(rootsBefore);
});

linuxTest('real child failures from all four launchers reach terminal exact-owner cleanup', async () => {
  const originalEnv = { ...process.env };
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-xhigh-linux-failures-'));
  initializeRepository(cwd);
  const rootsBefore = brokerRoots();
  try {
    configureFixtureEnvironment();
    assertAutonomousExecutionBoundary({ cwd, providerCapable: true });
    fs.writeFileSync(path.join(cwd, '.xhigh-fail'), 'fail\n', { mode: 0o600 });
    const launchers = await loadLaunchers();

    await expect(launchers.draftSpecWithCodex({ cwd, prompt: 'draft' }))
      .rejects.toThrow(/xhigh codex operation failure/);
    expect(brokerRoots()).toEqual(rootsBefore);
    await expect(launchers.draftSpecWithPi({ cwd, prompt: 'draft' }))
      .rejects.toThrow(/xhigh pi operation failure/);
    expect(brokerRoots()).toEqual(rootsBefore);
    await expect(launchers.generateSpecViaOpenCode({
      workspacePath: cwd,
      title: 'X-High Linux', brief: 'Failure', storyCount: 1,
      storyPrefix: 'US', directionContext: '',
    })).resolves.toEqual(expect.objectContaining({ error: expect.stringContaining('code 23') }));
    expect(brokerRoots()).toEqual(rootsBefore);
    await expect(launchers.chatComplete([{ role: 'user', content: 'hello' }], { cwd }))
      .rejects.toThrow(/code 23/);
    expect(brokerRoots()).toEqual(rootsBefore);
  } finally {
    await closeAutonomousModelEgressForTests();
    resetAutonomousSandboxProbeForTests();
    restoreEnvironment(originalEnv);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
