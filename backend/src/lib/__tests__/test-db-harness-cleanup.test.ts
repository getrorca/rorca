/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/** DB-free teardown fault injection: fake Docker/pg_ctl only. */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  cleanupIsolatedTestDatabase,
  provisionIsolatedTestDatabase,
  recoverStaleIsolatedTestDatabases,
} from '../test-db-harness';
import { requireCurrentProcessStartIdentity } from '../process-instance-identity';
import {
  TEST_DB_STATE_SCHEMA_VERSION,
  type IsolatedTestDatabaseState,
} from '../test-db-safety';

const roots = new Set<string>();
const artifacts = new Set<string>();

function hash(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o700 });
  fs.chmodSync(filePath, 0o700);
}

function invocationFixture(input: {
  mode: 'docker-container' | 'local-cluster';
  commandMode: string;
  stale?: boolean;
}): { state: IsolatedTestDatabaseState; env: NodeJS.ProcessEnv; commandLog: string } {
  const invocationId = crypto.randomBytes(12).toString('hex');
  const root = path.join(fs.realpathSync(os.tmpdir()), `rorca-jest-invocation-${invocationId}`);
  roots.add(root);
  fs.mkdirSync(root, { mode: 0o700 });
  const ownerPid = input.stale ? 2_000_000_000 : process.pid;
  const ownerProcessStartIdentity = input.stale
    ? (process.platform === 'darwin' ? 'darwin-ps-lstart:Mon Jan 1 00:00:00 2001' : 'linux-proc-start:1')
    : requireCurrentProcessStartIdentity();
  const ownerInstanceNonce = crypto.randomBytes(32).toString('hex');
  const token = crypto.randomBytes(24).toString('hex');
  const leaseFile = path.join(root, 'owner.lease');
  const stateFile = path.join(root, 'database-state.json');
  fs.writeFileSync(leaseFile, `${JSON.stringify({
    invocationId, ownerPid, ownerProcessStartIdentity, ownerInstanceNonce, token,
  })}\n`, { mode: 0o600 });
  const commandLog = `${root}.commands.log`;
  artifacts.add(commandLog);
  artifacts.add(`${commandLog}.removed`);
  artifacts.add(`${commandLog}.stopped`);
  const state: IsolatedTestDatabaseState = {
    schemaVersion: TEST_DB_STATE_SCHEMA_VERSION,
    invocationId,
    ownerPid,
    ownerProcessStartIdentity,
    ownerInstanceNonce,
    root,
    leaseFile,
    leaseTokenHash: hash(token),
    stateFile,
    status: 'failed',
    mode: input.mode,
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RORCA_JEST_INVOCATION_ID: invocationId,
    RORCA_JEST_OWNER_PID: String(ownerPid),
    RORCA_JEST_STATE_FILE: stateFile,
    RORCA_TEST_CLEANUP_COMMAND_TIMEOUT_MS: input.commandMode === 'timeout' ? '100' : '5000',
    FAKE_COMMAND_MODE: input.commandMode,
    FAKE_COMMAND_LOG: commandLog,
    FAKE_INVOCATION_ID: invocationId,
  };

  if (input.mode === 'docker-container') {
    const docker = path.join(root, 'fake-docker');
    const containerName = `rorca-jest-pg16-${invocationId}`;
    const containerId = 'c'.repeat(64);
    state.containerName = containerName;
    state.containerId = containerId;
    env.RORCA_TEST_DOCKER_BIN = docker;
    writeExecutable(docker, `#!/usr/bin/env node
const fs=require('fs');
const args=process.argv.slice(2),mode=process.env.FAKE_COMMAND_MODE,log=process.env.FAKE_COMMAND_LOG;
fs.appendFileSync(log,args.join(' ')+'\\n');
const removed=log+'.removed',id='${containerId}',label=process.env.FAKE_INVOCATION_ID,name='${containerName}';
if(args[0]==='version'){process.stdout.write('26.0.0\\n');process.exit(0)}
if(args[0]==='image'&&args[1]==='inspect')process.exit(0);
if(args[0]==='run')process.exit(mode==='provision-run-failure'?42:2);
if(args[0]==='inspect'){
  if(mode==='daemon-unavailable'||mode==='provision-run-failure')process.exit(1);
  if(mode==='signal')process.kill(process.pid,'SIGTERM');
  if(mode==='timeout'){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);process.exit(0)}
  if(mode==='absent'||fs.existsSync(removed))process.exit(1);
  const outLabel=mode==='mismatch'?'other-invocation':label;
  process.stdout.write(id+'|'+outLabel+'|/'+name+'\\n');process.exit(0);
}
if(args[0]==='container'&&args[1]==='ls'){
  if(mode==='daemon-unavailable'||mode==='provision-run-failure')process.exit(42);
  if(mode==='absent'||fs.existsSync(removed)){process.stdout.write('');process.exit(0)}
  process.stdout.write(id.slice(0,12)+'|'+label+'|'+name+'\\n');process.exit(0);
}
if(args[0]==='rm'){
  if(mode==='remove-nonzero')process.exit(42);
  fs.writeFileSync(removed,'removed');process.stdout.write(name+'\\n');process.exit(0);
}
process.exit(2);
`);
  } else {
    const pgBin = path.join(root, 'pg-bin');
    fs.mkdirSync(pgBin, { mode: 0o700 });
    const pgCtl = path.join(pgBin, 'pg_ctl');
    const dataDirectory = path.join(root, 'pgdata');
    const socketDirectory = process.platform === 'darwin'
      ? path.join(fs.realpathSync('/tmp'), `rorca-js-${state.invocationId}`)
      : path.join(root, 'socket');
    roots.add(socketDirectory);
    fs.mkdirSync(dataDirectory, { mode: 0o700 });
    fs.mkdirSync(socketDirectory, { mode: 0o700 });
    state.pgBin = pgBin;
    state.dataDirectory = dataDirectory;
    state.socketDirectory = socketDirectory;
    writeExecutable(pgCtl, `#!/usr/bin/env node
const fs=require('fs');
const args=process.argv.slice(2),mode=process.env.FAKE_COMMAND_MODE,log=process.env.FAKE_COMMAND_LOG,stopped=log+'.stopped';
fs.appendFileSync(log,args.join(' ')+'\\n');
if(args.includes('status'))process.exit(mode==='local-already-stopped'||fs.existsSync(stopped)?3:0);
if(args.includes('stop')){if(mode==='local-stop-nonzero')process.exit(42);fs.writeFileSync(stopped,'stopped');process.exit(0)}
process.exit(2);
`);
  }
  fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  return { state, env, commandLog };
}

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
  for (const artifact of artifacts) fs.rmSync(artifact, { force: true });
  artifacts.clear();
});

test.each([
  ['remove-nonzero', /Docker remove failed/],
  ['daemon-unavailable', /absence proof failed/],
  ['mismatch', /mismatched invocation identity/],
  ['timeout', /Docker inspect failed/],
  ['signal', /Docker inspect failed/],
] as const)('Docker %s preserves exact recovery state and propagates failure', async (commandMode, expected) => {
  const fixture = invocationFixture({ mode: 'docker-container', commandMode });
  await expect(cleanupIsolatedTestDatabase(fixture.env)).rejects.toThrow(expected);
  expect(fs.existsSync(fixture.state.root)).toBe(true);
  expect(JSON.parse(fs.readFileSync(fixture.state.stateFile, 'utf8')).status).toBe('cleaning');
});

test('already-absent Docker identity is proved through exact-name inventory before root removal', async () => {
  const fixture = invocationFixture({ mode: 'docker-container', commandMode: 'absent' });
  await expect(cleanupIsolatedTestDatabase(fixture.env)).resolves.toBeUndefined();
  expect(fs.existsSync(fixture.state.root)).toBe(false);
  expect(fs.readFileSync(fixture.commandLog, 'utf8')).toContain('container ls --all');
});

test('successful Docker remove is followed by exact absence proof', async () => {
  const fixture = invocationFixture({ mode: 'docker-container', commandMode: 'success' });
  await cleanupIsolatedTestDatabase(fixture.env);
  expect(fs.existsSync(fixture.state.root)).toBe(false);
  const commands = fs.readFileSync(fixture.commandLog, 'utf8');
  expect(commands.match(/^inspect /gm)).toHaveLength(2);
  expect(commands).toContain(`rm --force ${fixture.state.containerName}`);
  expect(commands).toContain('container ls --all');
});

test('local pg_ctl stop failure preserves state; success and already-stopped both prove absence', async () => {
  const failed = invocationFixture({ mode: 'local-cluster', commandMode: 'local-stop-nonzero' });
  await expect(cleanupIsolatedTestDatabase(failed.env)).rejects.toThrow(/pg_ctl stop failed/);
  expect(fs.existsSync(failed.state.root)).toBe(true);

  const stopped = invocationFixture({ mode: 'local-cluster', commandMode: 'local-already-stopped' });
  await expect(cleanupIsolatedTestDatabase(stopped.env)).resolves.toBeUndefined();
  expect(fs.existsSync(stopped.state.root)).toBe(false);

  const success = invocationFixture({ mode: 'local-cluster', commandMode: 'local-success' });
  await expect(cleanupIsolatedTestDatabase(success.env)).resolves.toBeUndefined();
  expect(fs.existsSync(success.state.root)).toBe(false);
  expect(fs.readFileSync(success.commandLog, 'utf8').match(/status/g)).toHaveLength(2);
});

test('a rejected Docker start never clobbers the pre-side-effect container identity with stale allocated state', async () => {
  const fixture = invocationFixture({ mode: 'docker-container', commandMode: 'provision-run-failure' });
  const allocated: IsolatedTestDatabaseState = {
    ...fixture.state,
    status: 'allocated',
  };
  delete allocated.mode;
  delete allocated.containerName;
  delete allocated.containerId;
  fs.writeFileSync(allocated.stateFile, `${JSON.stringify(allocated)}\n`, { mode: 0o600 });

  await expect(provisionIsolatedTestDatabase({
    ...fixture.env,
    RORCA_TEST_DATABASE_MODE: 'docker',
  })).rejects.toThrow(/provisioning and exact cleanup both failed/);
  const preserved = JSON.parse(fs.readFileSync(allocated.stateFile, 'utf8')) as IsolatedTestDatabaseState;
  expect(preserved.status).toBe('cleaning');
  expect(preserved.mode).toBe('docker-container');
  expect(preserved.containerName).toBe(`rorca-jest-pg16-${allocated.invocationId}`);
  expect(fs.existsSync(allocated.root)).toBe(true);
});

test('stale recovery preserves a live exact owner and removes only a proved-dead exact identity', async () => {
  const live = invocationFixture({ mode: 'docker-container', commandMode: 'absent' });
  const stale = invocationFixture({ mode: 'docker-container', commandMode: 'absent', stale: true });
  await expect(recoverStaleIsolatedTestDatabases(stale.env, [live.state.root, stale.state.root])).resolves.toBe(1);
  expect(fs.existsSync(live.state.root)).toBe(true);
  expect(fs.existsSync(stale.state.root)).toBe(false);
});

test('stale recovery resumes a no-resource cleanup interrupted after the cleaning marker', async () => {
  const stale = invocationFixture({ mode: 'docker-container', commandMode: 'absent', stale: true });
  const interrupted: IsolatedTestDatabaseState = { ...stale.state, status: 'cleaning' };
  delete interrupted.mode;
  delete interrupted.containerName;
  delete interrupted.containerId;
  fs.writeFileSync(interrupted.stateFile, `${JSON.stringify(interrupted)}\n`, { mode: 0o600 });

  await expect(recoverStaleIsolatedTestDatabases(stale.env, [interrupted.root])).resolves.toBe(1);
  expect(fs.existsSync(interrupted.root)).toBe(false);
});
