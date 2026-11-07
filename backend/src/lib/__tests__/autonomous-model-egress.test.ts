/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV,
  AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV,
  AUTONOMOUS_EGRESS_OPERATION_ID_ENV,
  AUTONOMOUS_EGRESS_RUN_ID_ENV,
  assertAutonomousModelEgressBinding,
  assertAutonomousModelEgressRunBinding,
  closeAutonomousModelEgressForTests,
  createAutonomousModelEgressOperationIdentity,
  ensureAutonomousModelEgress,
  resolveModelEgressHosts,
  sweepStaleAutonomousModelEgressState,
  type AutonomousModelEgressRunIdentity,
} from '../autonomous-model-egress';

function hash(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function identity(runId: number, label = String(runId)): AutonomousModelEgressRunIdentity {
  return { runId, authorityHash: hash(`authority:${label}`) };
}

function brokerEnv(host: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    RORCA_AUTONOMOUS_ISOLATION: 'linux-bwrap',
    RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS: host,
  };
}

async function request(socketPath: string, authority: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = net.connect({ path: socketPath });
    let output = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.on('data', chunk => { output += chunk; });
    socket.on('end', () => resolve(output));
    socket.on('error', reject);
  });
}

afterEach(async () => {
  await closeAutonomousModelEgressForTests();
});

test('known provider models derive a minimal egress policy instead of inheriting ambient hosts', () => {
  expect(resolveModelEgressHosts(
    ['openai-codex/gpt-5.6-sol'],
    'api.openai.com,api.deepseek.com',
  )).toEqual(['auth.openai.com', 'chatgpt.com']);
  expect(resolveModelEgressHosts(
    ['openai-codex/gpt-5.6-sol', 'deepseek/deepseek-chat'],
    'api.openai.com',
  )).toEqual(['api.deepseek.com', 'auth.openai.com', 'chatgpt.com']);
  expect(resolveModelEgressHosts(
    ['custom-router/model'],
    'router.example.com',
  )).toEqual(['router.example.com']);
});

test('non-isolated local development and caller-spoofed Darwin mode start no trusted model egress broker', async () => {
  await expect(ensureAutonomousModelEgress({
    NODE_ENV: 'development', RORCA_AUTONOMOUS_ISOLATION: 'local-dev',
  }, undefined, identity(1))).resolves.toBeNull();
  await expect(ensureAutonomousModelEgress({
    NODE_ENV: 'production', RORCA_AUTONOMOUS_ISOLATION: 'darwin-local-pi',
    RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS: 'model-api.example.invalid',
  }, undefined, identity(2))).resolves.toBeNull();
});

test('worker-authorized Darwin isolation gets an exact run-bound broker without mutating process-global endpoint state', async () => {
  const env = brokerEnv('model-api.example.invalid');
  const runIdentity = identity(40);
  const ambientBefore = process.env.RORCA_AUTONOMOUS_EGRESS_SOCKET;
  const socket = await ensureAutonomousModelEgress(env, 'darwin-local-pi', runIdentity);
  expect(socket).toBeTruthy();
  expect(process.env.RORCA_AUTONOMOUS_EGRESS_SOCKET).toBe(ambientBefore);
  expect(env[AUTONOMOUS_EGRESS_RUN_ID_ENV]).toBe('40');
  expect(env[AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV]).toBe(runIdentity.authorityHash);
  expect(env[AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV]).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(assertAutonomousModelEgressRunBinding(env, runIdentity)).toBe(socket);
  await expect(request(socket!, 'api.github.com:443')).resolves.toContain('403 Forbidden');
});

test.each(['', 'localhost', '127.0.0.1', '*.example.com', 'not-a-host', 'api.github.com']) (
  'isolated broker rejects missing/non-exact/public host configuration %p',
  async (host) => {
    await expect(ensureAutonomousModelEgress(brokerEnv(host), 'linux-bwrap', identity(50, host || 'empty')))
      .rejects.toThrow(/required|exact public DNS name/);
  },
);

test('broker denies GitHub, localhost, IP literals, non-443 ports, and non-CONNECT without external calls', async () => {
  const socket = await ensureAutonomousModelEgress(
    brokerEnv('model-api.example.invalid'), 'linux-bwrap', identity(60),
  );
  expect(socket).toBeTruthy();
  for (const authority of ['api.github.com:443', 'localhost:3030', '127.0.0.1:5432', 'model-api.example.invalid:80']) {
    await expect(request(socket!, authority)).resolves.toContain('403 Forbidden');
  }
  const nonConnect = await new Promise<string>((resolve, reject) => {
    const client = net.connect({ path: socket! });
    let output = '';
    client.setEncoding('utf8');
    client.on('connect', () => client.write('GET http://model-api.example.invalid/ HTTP/1.1\r\n\r\n'));
    client.on('data', chunk => { output += chunk; });
    client.on('end', () => resolve(output));
    client.on('error', reject);
  });
  expect(nonConnect).toContain('405 Method Not Allowed');
});

test('native concurrent runs with differing host policies receive distinct sockets and cannot share or reconfigure state', async () => {
  const firstIdentity = identity(71, 'first');
  const secondIdentity = identity(72, 'second');
  const firstEnv = brokerEnv('model-a.example.invalid');
  const secondEnv = brokerEnv('model-b.example.invalid');
  const [first, second] = await Promise.all([
    ensureAutonomousModelEgress(firstEnv, 'darwin-local-pi', firstIdentity),
    ensureAutonomousModelEgress(secondEnv, 'darwin-local-pi', secondIdentity),
  ]);
  expect(first).toBeTruthy();
  expect(second).toBeTruthy();
  expect(first).not.toBe(second);
  expect(path.dirname(first!)).not.toBe(path.dirname(second!));
  expect(assertAutonomousModelEgressRunBinding(firstEnv, firstIdentity)).toBe(first);
  expect(assertAutonomousModelEgressRunBinding(secondEnv, secondIdentity)).toBe(second);

  const reconfigured = brokerEnv('changed.example.invalid');
  await expect(ensureAutonomousModelEgress(reconfigured, 'darwin-local-pi', firstIdentity))
    .rejects.toThrow(/reconfigure immutable owner policy/);
  const inheritedReconfigured = { ...firstEnv, RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS: 'changed.example.invalid' };
  await expect(ensureAutonomousModelEgress(inheritedReconfigured, 'darwin-local-pi', firstIdentity))
    .rejects.toThrow(/differs from immutable run identity/);
  expect(fs.existsSync(first!)).toBe(true);
  expect(fs.existsSync(second!)).toBe(true);
});

test('operation authority cannot be reconstructed from caller environment or a forged identity literal', async () => {
  const identity = createAutonomousModelEgressOperationIdentity({ launcher: 'claude-cli', request: 'trusted' });
  const ambient = {
    ...brokerEnv('model-api.example.invalid'),
    [AUTONOMOUS_EGRESS_OPERATION_ID_ENV]: identity.operationId,
    [AUTONOMOUS_EGRESS_AUTHORITY_HASH_ENV]: identity.authorityHash,
  };
  await expect(ensureAutonomousModelEgress(ambient, 'linux-bwrap'))
    .rejects.toThrow(/requires exact run- or operation-owned identity/);
  await expect(ensureAutonomousModelEgress(
    brokerEnv('model-api.example.invalid'),
    'linux-bwrap',
    { ...identity },
  )).rejects.toThrow(/caller-controlled operation identity/);
});

test('concurrent operation and run identities remain isolated and exact operation close preserves the run', async () => {
  const operation = createAutonomousModelEgressOperationIdentity({ launcher: 'pi-spec-drafter', request: 'one' });
  expect(Object.isFrozen(operation)).toBe(true);
  expect(operation.operationId).toMatch(/^operation:[a-f0-9]{64}$/);
  const run = identity(79, 'concurrent-run');
  const operationEnv = brokerEnv('operation-model.example.invalid');
  const runEnv = brokerEnv('run-model.example.invalid');
  const [operationSocket, runSocket] = await Promise.all([
    ensureAutonomousModelEgress(operationEnv, 'linux-bwrap', operation),
    ensureAutonomousModelEgress(runEnv, 'linux-bwrap', run),
  ]);

  expect(operationSocket).toBeTruthy();
  expect(runSocket).toBeTruthy();
  expect(operationSocket).not.toBe(runSocket);
  expect(assertAutonomousModelEgressBinding(operationEnv, operation, 'linux-bwrap')).toBe(operationSocket);
  expect(assertAutonomousModelEgressRunBinding(runEnv, run, 'linux-bwrap')).toBe(runSocket);

  await closeAutonomousModelEgressForTests(operation);
  expect(fs.existsSync(operationSocket!)).toBe(false);
  expect(fs.existsSync(runSocket!)).toBe(true);
});

test('concurrent operations retain distinct roots and allowlists and exact close cannot cross owners', async () => {
  const firstIdentity = createAutonomousModelEgressOperationIdentity({ launcher: 'codex', request: 'first' });
  const secondIdentity = createAutonomousModelEgressOperationIdentity({ launcher: 'opencode', request: 'second' });
  const firstEnv = brokerEnv('model-a.example.invalid');
  const secondEnv = brokerEnv('model-b.example.invalid');
  const [firstSocket, secondSocket] = await Promise.all([
    ensureAutonomousModelEgress(firstEnv, 'linux-bwrap', firstIdentity),
    ensureAutonomousModelEgress(secondEnv, 'linux-bwrap', secondIdentity),
  ]);

  expect(firstSocket).toBeTruthy();
  expect(secondSocket).toBeTruthy();
  expect(firstSocket).not.toBe(secondSocket);
  expect(path.dirname(firstSocket!)).not.toBe(path.dirname(secondSocket!));
  expect(assertAutonomousModelEgressBinding(firstEnv, firstIdentity, 'linux-bwrap')).toBe(firstSocket);
  expect(assertAutonomousModelEgressBinding(secondEnv, secondIdentity, 'linux-bwrap')).toBe(secondSocket);
  await expect(request(firstSocket!, 'model-b.example.invalid:443')).resolves.toContain('403 Forbidden');
  await expect(request(secondSocket!, 'model-a.example.invalid:443')).resolves.toContain('403 Forbidden');

  await closeAutonomousModelEgressForTests(firstIdentity);
  expect(fs.existsSync(firstSocket!)).toBe(false);
  expect(fs.existsSync(secondSocket!)).toBe(true);
});

test('pre-lifecycle creation survives a concurrent sweep and publishes only a complete final root', async () => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const finalRootsBefore = new Set(fs.readdirSync(temporaryRoot)
    .filter(name => name.startsWith('rorca-model-egress-run-')));
  const mutableFs = require('node:fs') as typeof fs;
  const chmodSync = mutableFs.chmodSync.bind(mutableFs);
  let stagingRoot: string | null = null;
  let interleavings = 0;
  const chmodSpy = jest.spyOn(mutableFs, 'chmodSync').mockImplementation((target, mode) => {
    chmodSync(target, mode);
    const candidate = String(target);
    if (mode === 0o700 && path.basename(candidate).startsWith('rorca-model-egress-stage-')) {
      stagingRoot = candidate;
      interleavings += 1;
      expect(fs.existsSync(path.join(candidate, 'lifecycle.json'))).toBe(false);
      expect(new Set(fs.readdirSync(temporaryRoot)
        .filter(name => name.startsWith('rorca-model-egress-run-')))).toEqual(finalRootsBefore);
      expect(sweepStaleAutonomousModelEgressState([candidate])).toBe(0);
      expect(fs.existsSync(candidate)).toBe(true);
    }
  });

  let socket: string | null = null;
  try {
    const operation = createAutonomousModelEgressOperationIdentity({
      launcher: 'pi-spec-drafter', request: 'pre-lifecycle-sweep-interleaving',
    });
    socket = await ensureAutonomousModelEgress(
      brokerEnv('model-api.example.invalid'), 'linux-bwrap', operation,
    );
  } finally {
    chmodSpy.mockRestore();
  }

  expect(interleavings).toBe(1);
  expect(stagingRoot).not.toBeNull();
  expect(fs.existsSync(stagingRoot!)).toBe(false);
  expect(socket).toBeTruthy();
  const publishedRoot = path.dirname(socket!);
  expect(path.basename(publishedRoot)).toMatch(/^rorca-model-egress-run-op-[A-Za-z0-9]{6}$/);
  expect(fs.statSync(path.join(publishedRoot, 'lifecycle.json')).isFile()).toBe(true);
  expect(fs.statSync(path.join(publishedRoot, 'broker.json')).isFile()).toBe(true);
  expect(fs.statSync(socket!).isSocket()).toBe(true);
  expect(sweepStaleAutonomousModelEgressState([publishedRoot])).toBe(0);
  expect(fs.existsSync(publishedRoot)).toBe(true);
});

test('cross-process pre-lifecycle staging survives a live sweep and is removable after creator death', async () => {
  const childScript = String.raw`
const crypto=require('node:crypto');const cp=require('node:child_process');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const startIdentity=process.platform==='linux'
  ? (()=>{const stat=fs.readFileSync('/proc/'+process.pid+'/stat','utf8');const end=stat.lastIndexOf(')');return 'linux-proc-start:'+stat.slice(end+1).trim().split(/\s+/)[19]})()
  : 'darwin-ps-start:'+cp.execFileSync('/bin/ps',['-p',String(process.pid),'-o','lstart='],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}}).trim();
const startDigest=crypto.createHash('sha256').update(startIdentity).digest('hex');const instance=crypto.randomBytes(32).toString('hex');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'rorca-model-egress-stage-'+process.pid+'-'+startDigest+'-'+instance+'-'));fs.chmodSync(root,448);
fs.writeSync(1,JSON.stringify({pid:process.pid,root})+'\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`;
  const tsxCli = fs.realpathSync(path.resolve(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx'));
  const child = spawn(process.execPath, [tsxCli, '-e', childScript], {
    cwd: path.resolve(__dirname, '..', '..', '..'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stagingRoot: string | null = null;
  try {
    const fixture = await new Promise<{ pid: number; root: string }>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => reject(new Error(`staging fixture timeout: ${stderr}`)), 10_000);
      child.stdout.on('data', chunk => {
        stdout += chunk.toString();
        const newline = stdout.indexOf('\n');
        if (newline >= 0) { clearTimeout(timer); resolve(JSON.parse(stdout.slice(0, newline))); }
      });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => {
        if (!stdout.includes('\n')) { clearTimeout(timer); reject(new Error(`staging fixture exited ${code}: ${stderr}`)); }
      });
    });
    stagingRoot = fixture.root;
    expect(fs.existsSync(path.join(stagingRoot, 'lifecycle.json'))).toBe(false);
    expect(sweepStaleAutonomousModelEgressState([stagingRoot])).toBe(0);
    expect(fs.existsSync(stagingRoot)).toBe(true);

    process.kill(fixture.pid, 'SIGKILL');
    if (child.exitCode === null) await new Promise<void>(resolve => child.once('close', () => resolve()));
    expect(sweepStaleAutonomousModelEgressState([stagingRoot])).toBe(1);
    expect(fs.existsSync(stagingRoot)).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (stagingRoot) fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
});

test('exact replay retains one socket identity and close of one run cannot affect another', async () => {
  const replayIdentity = identity(81, 'replay');
  const otherIdentity = identity(82, 'other');
  const firstEnv = brokerEnv('model-api.example.invalid');
  const firstSocket = await ensureAutonomousModelEgress(firstEnv, 'darwin-local-pi', replayIdentity);
  const replayEnv = brokerEnv('model-api.example.invalid');
  const replaySocket = await ensureAutonomousModelEgress(replayEnv, 'darwin-local-pi', replayIdentity);
  const otherEnv = brokerEnv('other-model.example.invalid');
  const otherSocket = await ensureAutonomousModelEgress(otherEnv, 'darwin-local-pi', otherIdentity);
  expect(replaySocket).toBe(firstSocket);
  expect(replayEnv[AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV]).toBe(firstEnv[AUTONOMOUS_EGRESS_IDENTITY_HASH_ENV]);

  await closeAutonomousModelEgressForTests(replayIdentity);
  expect(fs.existsSync(firstSocket!)).toBe(false);
  expect(fs.existsSync(otherSocket!)).toBe(true);
});

test('native SIGKILL crash preserves a live cross-process operation root then removes only its stale lifecycle', async () => {
  const modulePath = path.resolve(__dirname, '..', 'autonomous-model-egress.ts');
  const childScript = String.raw`
const env={RORCA_AUTONOMOUS_ISOLATION:'linux-bwrap',RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS:'crash-model.example.invalid'};
import(process.argv[1]).then(async broker=>{const identity=broker.createAutonomousModelEgressOperationIdentity({launcher:'crash-fixture'});const socket=await broker.ensureAutonomousModelEgress(env,'linux-bwrap',identity);process.stdout.write(JSON.stringify({pid:process.pid,socket})+'\n');setInterval(()=>{},1000)},error=>{console.error(error);process.exit(1)});`;
  const tsxCli = fs.realpathSync(path.resolve(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx'));
  const child = spawn(process.execPath,
    [tsxCli, '-e', childScript, modulePath], {
      cwd: path.resolve(__dirname, '..', '..', '..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const fixture = await new Promise<{ pid: number; socket: string }>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`crash fixture timeout: ${stderr}`)), 10_000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      const newline = stdout.indexOf('\n');
      if (newline >= 0) { clearTimeout(timer); resolve(JSON.parse(stdout.slice(0, newline))); }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      if (!stdout.includes('\n')) { clearTimeout(timer); reject(new Error(`crash fixture exited ${code}: ${stderr}`)); }
    });
  });
  expect(fs.statSync(fixture.socket).isSocket()).toBe(true);
  const staleRoot = path.dirname(fixture.socket);
  const lifecycle = JSON.parse(fs.readFileSync(path.join(staleRoot, 'lifecycle.json'), 'utf8')) as Record<string, unknown>;
  expect(sweepStaleAutonomousModelEgressState([staleRoot])).toBe(0);
  expect(fs.existsSync(staleRoot)).toBe(true);
  process.kill(fixture.pid, 'SIGKILL');
  if (child.exitCode === null) await new Promise<void>(resolve => child.once('close', () => resolve()));
  expect(fs.existsSync(staleRoot)).toBe(true);

  // A recycled live PID is not the original lifecycle owner. The process-birth
  // identity prevents it from pinning an abandoned operation broker forever.
  const reusedPidRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rorca-model-egress-run-op-reused-'));
  fs.chmodSync(reusedPidRoot, 0o700);
  fs.writeFileSync(path.join(reusedPidRoot, 'lifecycle.json'), `${JSON.stringify({
    ...lifecycle,
    ownerPid: process.pid,
    ownerStartIdentity: `reused-process:${crypto.randomBytes(16).toString('hex')}`,
  })}\n`, { mode: 0o600 });
  expect(sweepStaleAutonomousModelEgressState([reusedPidRoot])).toBe(1);
  expect(fs.existsSync(reusedPidRoot)).toBe(false);

  expect(sweepStaleAutonomousModelEgressState([staleRoot])).toBe(1);
  expect(fs.existsSync(staleRoot)).toBe(false);
});

test('startup crash sweep removes stale run sockets while refusing substituted cleanup targets', () => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const stale = fs.mkdtempSync(path.join(temporaryRoot, 'rorca-model-egress-run-999-'));
  fs.chmodSync(stale, 0o700);
  fs.writeFileSync(path.join(stale, 'crash-credential'), 'stale', { mode: 0o600 });
  const outside = fs.mkdtempSync(path.join(temporaryRoot, 'rorca-egress-cleanup-outside-'));
  const sentinel = path.join(outside, 'must-survive');
  fs.writeFileSync(sentinel, 'survive');
  const substituted = path.join(temporaryRoot, 'rorca-model-egress-run-1000-substituted');
  fs.symlinkSync(outside, substituted);
  try {
    expect(sweepStaleAutonomousModelEgressState([stale, substituted])).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.lstatSync(substituted).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('survive');
  } finally {
    fs.rmSync(stale, { recursive: true, force: true });
    fs.unlinkSync(substituted);
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
