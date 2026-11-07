import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const driver = path.join(here, 'fixtures', 'always-on-reboot-smoke-driver.mjs');
const disposableRoots = [];

function setup() {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'rorca-reboot-smoke-test-'));
  disposableRoots.push(parent);
  const root = path.join(parent, 'checkout');
  const home = path.join(parent, 'home');
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(root, 'scripts', 'verify-always-on-login-readiness.mjs'), '// mock only\n');
  writeFileSync(path.join(root, 'scripts', 'always-on-reboot-smoke.mjs'), '// path identity sentinel\n');
  return {
    parent,
    root,
    home,
    commandLog: path.join(parent, 'mock-commands.ndjson'),
    evidence: path.join(root, '.rorca', 'services', 'reboot-smoke'),
  };
}

function environment(context, extra = {}) {
  return {
    ...process.env,
    MOCK_HOME: context.home,
    MOCK_COMMAND_LOG: context.commandLog,
    MOCK_BOOT_SECONDS: '1000',
    MOCK_NOW_MS: '1010000',
    ...extra,
  };
}

function run(context, action, args = [], extraEnv = {}) {
  return spawnSync(process.execPath, [driver, action, '--root', context.root, ...args], {
    encoding: 'utf8',
    env: environment(context, extraEnv),
    timeout: 15_000,
  });
}

function start(context, action, args = [], extraEnv = {}) {
  return spawn(process.execPath, [driver, action, '--root', context.root, ...args], {
    env: environment(context, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function state(context) {
  return readJson(path.join(context.evidence, 'state.json'));
}

function marker(context) {
  return readJson(path.join(context.evidence, 'armed.json'));
}

function plistPath(context) {
  const directory = path.join(context.home, 'Library', 'LaunchAgents');
  return path.join(directory, readdirSync(directory).find((name) => name.endsWith('.plist')));
}

function arm(context) {
  const result = run(context, 'arm');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return marker(context).id;
}

function assertMockAudit(context) {
  const entries = readFileSync(context.commandLog, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(entries.length > 0);
  assert.ok(entries.every((entry) => entry.mock === true), 'all external command records must come from the mock runtime');
  return entries;
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

function childResult(child) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

function writeFreshServiceLogs(context, bootSeconds) {
  const files = [
    path.join(context.root, '.rorca', 'services', 'backend.stdout.log'),
    path.join(context.root, '.rorca', 'services', 'worker.stdout.log'),
    path.join(context.root, '.rorca', 'capture', 'service.log'),
  ];
  for (const file of files) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'mock service activity\n');
    utimesSync(file, new Date((bootSeconds + 1) * 1000), new Date((bootSeconds + 1) * 1000));
  }
}

test.after(() => {
  for (const directory of disposableRoots) rmSync(directory, { recursive: true, force: true });
});

test('arm durably follows idle -> arming -> armed and binds every artifact to one immutable arm ID', () => {
  const context = setup();
  const armId = arm(context);
  const durable = state(context);
  assert.equal(durable.phase, 'armed');
  assert.equal(durable.armId, armId);
  assert.deepEqual(durable.history.map(({ to }) => to), ['arming', 'armed']);
  assert.equal(marker(context).id, armId);
  assert.match(readFileSync(plistPath(context), 'utf8'), new RegExp(`<string>${armId}</string>`));
  const rebootCommand = readFileSync(path.join(context.evidence, 'REBOOT-COMMAND.txt'), 'utf8');
  assert.match(rebootCommand, new RegExp(`--arm-id '${armId}'`));
  assert.match(rebootCommand, /--confirm-reboot/);
  assertMockAudit(context);
});

test('stale old-arm disarm cannot compare/delete a newer arm bundle', () => {
  const context = setup();
  const oldArmId = arm(context);
  const oldDisarm = run(context, 'disarm', ['--arm-id', oldArmId]);
  assert.equal(oldDisarm.status, 0, oldDisarm.stderr);
  const newArmId = arm(context);
  assert.notEqual(newArmId, oldArmId);
  const newPlist = readFileSync(plistPath(context), 'utf8');

  const staleDisarm = run(context, 'disarm', ['--arm-id', oldArmId]);
  assert.equal(staleDisarm.status, 1);
  assert.match(staleDisarm.stderr, /does not match durable arm/);
  assert.equal(marker(context).id, newArmId);
  assert.equal(readFileSync(plistPath(context), 'utf8'), newPlist);
  assert.equal(state(context).phase, 'armed');
  assertMockAudit(context);
});

test('same-boot ambiguous stale lock is never silently overridden', () => {
  const context = setup();
  const armId = arm(context);
  const lockDir = path.join(context.evidence, 'operation.lock');
  mkdirSync(lockDir);
  writeFileSync(path.join(lockDir, 'owner.json'), `${JSON.stringify({
    version: 1,
    token: 'stale-same-boot-token',
    action: 'arm',
    armId,
    pid: 99999,
    acquiredAt: new Date(1001 * 1000).toISOString(),
    bootSession: { epochMs: 1000 * 1000 },
  })}\n`);

  const result = run(context, 'disarm', ['--arm-id', armId]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exclusive operation lock is held/);
  assert.equal(existsSync(lockDir), true);
  assert.equal(marker(context).id, armId);
  assert.equal(existsSync(plistPath(context)), true);
  assertMockAudit(context);
});

test('exact regression: disarm during shutdown loses both races and post-login preserves formal evidence', async () => {
  const context = setup();
  const armId = arm(context);
  const hold = path.join(context.parent, 'hold-mock-shutdown');
  const reached = path.join(context.parent, 'mock-shutdown-reached');
  writeFileSync(hold, 'hold\n');

  const rebootChild = start(context, 'reboot-now', ['--arm-id', armId, '--confirm-reboot'], {
    MOCK_SHUTDOWN_HOLD: hold,
    MOCK_SHUTDOWN_REACHED: reached,
  });
  const rebootCompletion = childResult(rebootChild);
  await waitFor(() => existsSync(reached) && state(context).phase === 'rebooting', 'mock shutdown was not reached in durable rebooting state');

  const concurrentDisarm = run(context, 'disarm', ['--arm-id', armId]);
  assert.equal(concurrentDisarm.status, 1);
  assert.match(concurrentDisarm.stderr, /exclusive operation lock is held/);
  assert.equal(marker(context).id, armId);
  assert.equal(existsSync(plistPath(context)), true);

  unlinkSync(hold);
  const rebootResult = await rebootCompletion;
  assert.equal(rebootResult.status, 0, rebootResult.stderr);
  assert.equal(state(context).phase, 'rebooting');

  const afterCommandDisarm = run(context, 'disarm', ['--arm-id', armId]);
  assert.equal(afterCommandDisarm.status, 1);
  assert.match(afterCommandDisarm.stderr, /disarm is forbidden while state is rebooting/);
  const competingArm = run(context, 'arm');
  assert.equal(competingArm.status, 1);
  assert.match(competingArm.stderr, /cannot arm while durable state is rebooting/);
  assert.equal(marker(context).id, armId);

  // Model the lock left behind by abrupt reboot. Only an exact-arm post-login
  // on a different kernel boot may atomically archive it.
  const lockDir = path.join(context.evidence, 'operation.lock');
  mkdirSync(lockDir);
  writeFileSync(path.join(lockDir, 'owner.json'), `${JSON.stringify({
    version: 1,
    token: 'prior-boot-reboot-lock',
    action: 'reboot-now',
    armId,
    pid: 777,
    acquiredAt: new Date(1001 * 1000).toISOString(),
    bootSession: { epochMs: 1000 * 1000 },
  })}\n`);
  writeFreshServiceLogs(context, 2000);
  const installedPlist = plistPath(context);
  const postLogin = run(context, 'post-login', ['--arm-id', armId], {
    MOCK_BOOT_SECONDS: '2000',
    MOCK_NOW_MS: '2010000',
  });
  assert.equal(postLogin.status, 0, postLogin.stderr || postLogin.stdout);
  assert.equal(state(context).phase, 'completed');
  assert.equal(existsSync(path.join(context.evidence, 'armed.json')), false);
  assert.equal(existsSync(installedPlist), false);
  assert.equal(readdirSync(path.join(context.evidence, 'stale-locks')).length, 1);
  const latest = readJson(path.join(context.evidence, 'post-login-latest.json'));
  assert.equal(latest.ok, true);
  assert.equal(latest.armId, armId);
  assertMockAudit(context);
});

test('shutdown command failure transitions rebooting -> failed and retains exact bundle for guarded disarm', () => {
  const context = setup();
  const armId = arm(context);
  const failedReboot = run(context, 'reboot-now', ['--arm-id', armId, '--confirm-reboot'], {
    MOCK_SHUTDOWN_STATUS: '9',
  });
  assert.equal(failedReboot.status, 1);
  assert.match(failedReboot.stderr, /mock shutdown failure/);
  assert.equal(state(context).phase, 'failed');
  assert.equal(marker(context).id, armId);
  assert.equal(existsSync(plistPath(context)), true);

  const installedPlist = plistPath(context);
  const cleanup = run(context, 'disarm', ['--arm-id', armId]);
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(existsSync(path.join(context.evidence, 'armed.json')), false);
  assert.equal(existsSync(installedPlist), false);
  const commands = assertMockAudit(context);
  assert.equal(commands.filter(({ command, args }) => command === '/usr/bin/sudo' && args[0] === '/sbin/shutdown').length, 1);
});

test('reboot requires separate confirmation and an interactive terminal before any sudo request', () => {
  const context = setup();
  const armId = arm(context);
  const withoutConsent = run(context, 'reboot-now', ['--arm-id', armId]);
  assert.equal(withoutConsent.status, 1);
  assert.match(withoutConsent.stderr, /separate explicit --confirm-reboot consent/);
  const unattended = run(context, 'reboot-now', ['--arm-id', armId, '--confirm-reboot'], { MOCK_TTY: 'false' });
  assert.equal(unattended.status, 1);
  assert.match(unattended.stderr, /interactive-only/);
  assert.equal(state(context).phase, 'armed');
  const entries = assertMockAudit(context);
  assert.equal(entries.some(({ command }) => command === '/usr/bin/sudo'), false);
});

test('plist tampering fails closed and compare/delete preserves the entire arm bundle', () => {
  const context = setup();
  const armId = arm(context);
  const installedPlist = plistPath(context);
  writeFileSync(installedPlist, `${readFileSync(installedPlist, 'utf8')}<!-- tampered -->\n`);
  const tampered = readFileSync(installedPlist, 'utf8');
  const disarm = run(context, 'disarm', ['--arm-id', armId]);
  assert.equal(disarm.status, 1);
  assert.match(disarm.stderr, /does not exactly match arm/);
  assert.equal(state(context).phase, 'armed');
  assert.equal(marker(context).id, armId);
  assert.equal(readFileSync(installedPlist, 'utf8'), tampered);
  assertMockAudit(context);
});

test('test harness intercepts every sudo, shutdown, sync, git, plutil, ps, sysctl, and launchctl command', () => {
  const context = setup();
  const armId = arm(context);
  const reboot = run(context, 'reboot-now', ['--arm-id', armId, '--confirm-reboot']);
  assert.equal(reboot.status, 0, reboot.stderr);
  const entries = assertMockAudit(context);
  const commands = new Set(entries.map(({ command }) => command));
  for (const expected of ['/usr/bin/sudo', '/bin/sync', '/usr/bin/git', '/usr/bin/plutil', '/bin/ps', '/usr/sbin/sysctl', '/bin/launchctl', '/mock/node']) {
    assert.equal(commands.has(expected), true, `expected intercepted command ${expected}`);
  }
  assert.ok(entries.every(({ mock }) => mock === true));
});
