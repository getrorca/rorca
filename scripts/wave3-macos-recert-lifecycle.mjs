#!/usr/bin/env node
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Real-host, disposable macOS launchd certification.
 *
 * This harness deliberately uses only tiny Node fixtures. It never starts the
 * Rorca application, opens port 3030, accesses a database, writes a user
 * LaunchAgents directory, or references the protected checkout except through
 * read-only git/process snapshots.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedRoot = '/Users/dimitriteravanessian/rorca-final-macos-recert';
const protectedRoot = '/Users/dimitriteravanessian/rorca';
const protectedLabels = [
  'com.rorca.backend.rorca',
  'com.rorca.worker.rorca',
  'com.rorca.capture.rorca',
  'com.rorca.login-smoke.rorca',
];
const uid = process.getuid();
const nonce = crypto.randomBytes(8).toString('hex');
const tempRoot = fs.mkdtempSync(`/private/tmp/rorca-final-macos-recert-${nonce}-`);
const fixture = path.join(repoRoot, 'scripts', 'wave3-macos-recert-service.mjs');
const evidenceJson = path.join(repoRoot, '.final-macos-recert-evidence.json');
const evidenceMd = path.join(repoRoot, '.final-macos-recert-evidence.md');
const progress = path.join(repoRoot, '.final-macos-recert-progress.md');
const roleNames = ['backend', 'worker', 'capture', 'monitor'];
const records = [];
let evidence;

function run(program, args, options = {}) {
  return spawnSync(program, args, { encoding: 'utf8', maxBuffer: 1024 * 1024, ...options });
}
function must(program, args, options = {}) {
  const result = run(program, args, options);
  if (result.status !== 0 || result.error) throw new Error(`${program} ${args.join(' ')} failed: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`);
  return result;
}
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}
function launchOutput(target) {
  return run('/bin/launchctl', ['print', target]);
}
function parseLaunch(output) {
  return {
    loaded: output.status === 0,
    state: output.stdout?.match(/^\s*state = (.+)$/m)?.[1]?.trim() || 'not-loaded',
    pid: Number(output.stdout?.match(/^\s*pid = (\d+)$/m)?.[1]) || null,
    runs: Number(output.stdout?.match(/^\s*runs = (\d+)$/m)?.[1]) || null,
  };
}
function psCommand(pid) { return run('/bin/ps', ['-p', String(pid), '-o', 'command=']).stdout.trim(); }
function cwdForPid(pid) {
  const output = run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).stdout;
  return output.split('\n').find((line) => line.startsWith('n'))?.slice(1) || null;
}
function listeners(port) {
  return run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).stdout
    .split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
}
function protectedSnapshot() {
  const labels = Object.fromEntries(protectedLabels.map((label) => {
    const output = launchOutput(`gui/${uid}/${label}`);
    return [label, { ...parseLaunch(output), outputSha256: digest(output.stdout || output.stderr || '') }];
  }));
  const portPids = listeners(3030);
  const port = portPids.map((pid) => ({ pid, commandSha256: digest(psCommand(pid)), cwd: cwdForPid(pid) }));
  const status = must('/usr/bin/git', ['-C', protectedRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout;
  return {
    git: {
      head: must('/usr/bin/git', ['-C', protectedRoot, 'rev-parse', 'HEAD']).stdout.trim(),
      branch: must('/usr/bin/git', ['-C', protectedRoot, 'branch', '--show-current']).stdout.trim(),
      porcelainSha256: digest(status),
      porcelainEntries: status.split('\0').filter(Boolean).length,
    },
    labels,
    port3030: port,
  };
}
function equalProtected(before, after) {
  assert.deepEqual(after, before, 'protected primary git state, labels, or port 3030 changed');
}
function allocatePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : null;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
function configFor(role, port) {
  const label = `com.rorca.wave3cert.${nonce}.${role}`;
  const file = path.join(tempRoot, 'plists', `${label}.plist`);
  const configPath = path.join(tempRoot, 'configs', `${role}.json`);
  const target = `gui/${uid}/${label}`;
  const config = { nonce, role, root: tempRoot, port };
  return { role, label, file, configPath, target, config, outLog: path.join(tempRoot, 'launchd-logs', `${role}.stdout.log`), errLog: path.join(tempRoot, 'launchd-logs', `${role}.stderr.log`) };
}
function renderPlist(config) {
  const args = [process.execPath, fixture, config.configPath];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${config.label}</string>\n<key>ProgramArguments</key><array>${args.map((value) => `<string>${value}</string>`).join('')}</array>\n<key>WorkingDirectory</key><string>${tempRoot}</string>\n<key>EnvironmentVariables</key><dict><key>RORCA_WAVE3_CERT_NONCE</key><string>${nonce}</string></dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>1</integer>\n<key>ProcessType</key><string>Background</string>\n<key>StandardOutPath</key><string>${config.outLog}</string>\n<key>StandardErrorPath</key><string>${config.errLog}</string>\n</dict></plist>\n`;
}
function assertConfigSafety(config, action) {
  assert.equal(path.resolve(repoRoot), expectedRoot, 'harness must run from the required isolated checkout');
  assert(process.platform === 'darwin', 'real launchd certification requires macOS');
  assert(uid > 0, 'refusing to run as root');
  assert(/^com\.rorca\.wave3cert\.[a-f0-9]{16}\.(backend|worker|capture|monitor)$/.test(config.label), 'invalid disposable label');
  assert(config.label.includes(nonce), 'label does not bind this nonce');
  assert(!protectedLabels.includes(config.label), 'disposable label collides with protected label');
  assert(isInside(tempRoot, config.file) && isInside(tempRoot, config.configPath) && isInside(tempRoot, config.outLog) && isInside(tempRoot, config.errLog), 'artifact escapes disposable root');
  assert.equal(path.resolve(fixture), path.join(expectedRoot, 'scripts', 'wave3-macos-recert-service.mjs'), 'unexpected fixture program');
  assert.equal(path.resolve(config.config.root), path.resolve(tempRoot), 'fixture root mismatch');
  assert.equal(config.config.nonce, nonce, 'fixture nonce mismatch');
  assert.equal(config.config.role, config.role, 'fixture role mismatch');
  assert.notEqual(config.config.port, 3030, 'fixture port must never be 3030');
  const plist = fs.readFileSync(config.file, 'utf8');
  assert(plist.includes(`<string>${config.label}</string>`) && plist.includes(`<string>${fixture}</string>`) && plist.includes(`<string>${config.configPath}</string>`) && plist.includes(`<string>${tempRoot}</string>`), 'plist program/path identity mismatch');
  const loaded = parseLaunch(launchOutput(config.target));
  if (action === 'bootstrap') assert(!loaded.loaded, `label collision: ${config.label} is already loaded`);
  if (loaded.pid) assertProcessIdentity(config, loaded.pid);
}
function assertProcessIdentity(config, pid) {
  assert(Number.isInteger(pid) && pid > 1, 'invalid test PID');
  const command = psCommand(pid);
  const cwd = cwdForPid(pid);
  assert(cwd && path.resolve(cwd) === path.resolve(tempRoot), `test pid ${pid} cwd is not disposable root`);
  assert(command.includes(fixture) && command.includes(config.configPath) && command.includes(nonce), `test pid ${pid} command identity mismatch`);
  return { pid, commandSha256: digest(command), cwd };
}
function launchctl(config, args, action) {
  assertConfigSafety(config, action);
  const result = run('/bin/launchctl', args);
  if (result.status !== 0) throw new Error(`launchctl ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  records.push({ at: new Date().toISOString(), action, label: config.label, args });
  return result;
}
async function waitFor(check, description, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await check(); if (last) return last; } catch (error) { last = error; }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${description}: ${last instanceof Error ? last.message : String(last)}`);
}
async function running(config) {
  return waitFor(() => {
    const state = parseLaunch(launchOutput(config.target));
    if (state.loaded && state.state === 'running' && state.pid) return { ...state, identity: assertProcessIdentity(config, state.pid) };
    return null;
  }, `${config.role} running`);
}
async function ready(port) {
  return waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(500) }).catch(() => null);
    if (!response || !response.ok) return null;
    const body = await response.json();
    return body?.ok === true && body.nonce === nonce ? body : null;
  }, `backend readiness on disposable port ${port}`);
}
function statusFresh(role) {
  const file = path.join(tempRoot, 'state', `${role}.status.json`);
  const status = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(status.nonce, nonce); assert.equal(status.role, role);
  assert(Date.now() - Date.parse(status.updatedAt) < 10_000, `${role} status is stale`);
  return { file: path.relative(repoRoot, file), pid: status.pid, updatedAt: status.updatedAt };
}
function compact(snapshot) {
  return JSON.stringify(snapshot, null, 2);
}
function writeEvidence(cleanup) {
  const data = {
    certification: 'final-macos-recert',
    result: 'passed',
    timestamp: new Date().toISOString(),
    branch: must('/usr/bin/git', ['-C', repoRoot, 'branch', '--show-current']).stdout.trim(),
    head: must('/usr/bin/git', ['-C', repoRoot, 'rev-parse', 'HEAD']).stdout.trim(),
    nonce,
    disposable: { labels: Object.fromEntries(configs.map((config) => [config.role, config.label])), port, database: 'none (fixture-only; no database process or connection was created)', runtimeRoot: path.basename(tempRoot) },
    lifecycle: records,
    observedPids: pidEvidence,
    freshness: freshEvidence,
    logRotation: rotationEvidence,
    protectedBefore: before,
    protectedAfter: after,
    protectedUnchanged: true,
    cleanup,
    redaction: 'No environment values, credentials, command lines, database URLs, or primary working-tree file names are recorded.',
  };
  fs.writeFileSync(evidenceJson, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(evidenceMd, `# Final macOS recertification evidence\n\n**PASS** — disposable launchd lifecycle only; no reboot/login test.\n\n- Base: \`${data.head}\`; branch: \`${data.branch}\`\n- Nonce: \`${nonce}\`; disposable port: \`${port}\`; test DB: none (fixture-only).\n- Labels: ${Object.values(data.disposable.labels).map((label) => `\`${label}\``).join(', ')}.\n- Verified: bootstrap/start, loopback readiness, process cwd/command identity, managed-log rotation, crash replacement, supported restart, status freshness, queue preservation, stop/uninstall, and cleanup.\n- Protected primary git snapshot, protected labels, and port 3030 snapshot were byte-for-byte equivalent before/after.\n- Cleanup: all disposable labels unloaded, disposable port released, and disposable runtime removed.\n- Excluded manual gates: login persistence and reboot persistence.\n\nMachine-readable details: [\`.final-macos-recert-evidence.json\`](./.final-macos-recert-evidence.json).\n`, { mode: 0o600 });
  fs.writeFileSync(progress, `# Final macOS recertification progress\n\n- Required isolated checkout: \`${expectedRoot}\`; branch \`final/macos-service-recert\`; base \`${data.head}\`.\n- Read \`AGENTS.md\` and Wave 3 stop-condition artifact before this run. The primary ignored \`node_modules\` incident remains preserved; this run did not inspect, restore, install into, or modify it.\n- Nonce \`${nonce}\`; disposable root basename \`${path.basename(tempRoot)}\`; disposable port \`${port}\`; test DB: **none** (fixture only).\n- Labels: ${configs.map((config) => `\`${config.label}\``).join(', ')}.\n- PIDs observed: ${Object.entries(pidEvidence).map(([role, values]) => `${role}=${values.join('→')}`).join('; ')}.\n- Protected before/after: primary HEAD/branch/porcelain hash, four protected launchd labels, and port 3030 owner snapshot are identical. No protected service, database, service file, active run, or primary checkout file was touched.\n- Lifecycle: actual bootstrap/kickstart, backend readiness, identity checks, log rotation, worker SIGKILL crash recovery (only after exact disposable PID/cwd/command verification), supported capture restart, status freshness/worker queue preservation, stop, uninstall.\n- Cleanup proof: ${cleanup.labelsUnloaded ? 'all test labels unloaded' : 'FAILED'}; ${cleanup.portReleased ? 'test port released' : 'FAILED'}; ${cleanup.runtimeRemoved ? 'runtime removed' : 'FAILED'}.\n- Artifacts redact credentials, env values, database URLs, primary file names, and full process command lines.\n- Manual gates intentionally unavailable: login persistence and reboot persistence (not tested).\n\nSee [machine evidence](./.final-macos-recert-evidence.json) and [human evidence](./.final-macos-recert-evidence.md).\n`, { mode: 0o600 });
  evidence = data;
}

let port;
let configs;
let before;
let after;
const pidEvidence = {};
const freshEvidence = {};
let rotationEvidence = {};

try {
  assert.equal(path.resolve(repoRoot), expectedRoot, 'refusing to run outside the required isolated checkout');
  assert.equal(process.platform, 'darwin', 'this is a macOS-only real-host harness');
  assert(fs.existsSync(fixture), 'fixture script missing');
  before = protectedSnapshot();
  port = await allocatePort();
  assert(Number.isInteger(port) && port > 1024 && port !== 3030 && listeners(port).length === 0, 'unable to reserve a safe disposable port');
  configs = roleNames.map((role) => configFor(role, port));
  fs.mkdirSync(path.join(tempRoot, 'plists'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(tempRoot, 'configs'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(tempRoot, 'launchd-logs'), { recursive: true, mode: 0o700 });
  for (const config of configs) {
    fs.writeFileSync(config.configPath, `${JSON.stringify(config.config)}\n`, { mode: 0o600 });
    fs.writeFileSync(config.file, renderPlist(config), { mode: 0o600 });
    must('/usr/bin/plutil', ['-lint', config.file]);
    assert.equal(parseLaunch(launchOutput(config.target)).loaded, false, `preexisting disposable label ${config.label}`);
  }
  for (const config of configs) {
    launchctl(config, ['bootstrap', `gui/${uid}`, config.file], 'bootstrap');
    // RunAtLoad is allowed to begin asynchronously. Wait for an exact fixture
    // identity before the next launchctl action rather than racing launchd.
    await running(config);
    launchctl(config, ['kickstart', '-k', config.target], 'start');
    const state = await running(config);
    pidEvidence[config.role] = [state.pid];
  }
  await ready(port);
  for (const config of configs) freshEvidence[config.role] = await waitFor(() => {
    try { return statusFresh(config.role); } catch { return null; }
  }, `${config.role} status freshness`);
  await waitFor(() => fs.existsSync(path.join(tempRoot, 'state', 'monitor.observation.json')), 'monitor observation');

  const backend = configs.find((config) => config.role === 'backend');
  const backendLog = path.join(tempRoot, 'logs', 'backend.managed.log');
  fs.appendFileSync(backendLog, 'x'.repeat(2048));
  launchctl(backend, ['bootout', backend.target], 'supported-restart-stop');
  await waitFor(() => !parseLaunch(launchOutput(backend.target)).loaded, 'backend unloaded for restart');
  launchctl(backend, ['bootstrap', `gui/${uid}`, backend.file], 'supported-restart-bootstrap');
  await running(backend);
  launchctl(backend, ['kickstart', '-k', backend.target], 'supported-restart-start');
  const restartedBackend = await running(backend);
  pidEvidence.backend.push(restartedBackend.pid);
  await ready(port);
  const rotated = `${backendLog}.1`;
  assert(fs.existsSync(rotated) && fs.statSync(rotated).size >= 2048, 'managed backend log did not rotate');
  rotationEvidence = { rotated: path.basename(rotated), rotatedBytes: fs.statSync(rotated).size, currentLogBytes: fs.statSync(backendLog).size };

  const worker = configs.find((config) => config.role === 'worker');
  const queuePath = path.join(tempRoot, 'state', 'worker.queue.ndjson');
  const queueBefore = fs.readFileSync(queuePath, 'utf8');
  const workerState = parseLaunch(launchOutput(worker.target));
  const workerIdentity = assertProcessIdentity(worker, workerState.pid);
  // The only direct signal in this harness is to this exact nonce-bound fixture
  // after command/cwd/PID verification; protected and ambiguous PIDs are never signalled.
  process.kill(workerIdentity.pid, 'SIGKILL');
  records.push({ at: new Date().toISOString(), action: 'deliberate-test-crash', label: worker.label, pid: workerIdentity.pid });
  const recoveredWorker = await waitFor(() => {
    const state = parseLaunch(launchOutput(worker.target));
    if (state.loaded && state.state === 'running' && state.pid && state.pid !== workerIdentity.pid) return { ...state, identity: assertProcessIdentity(worker, state.pid) };
    return null;
  }, 'worker automatic crash recovery', 15_000);
  pidEvidence.worker.push(recoveredWorker.pid);
  assert.equal(fs.readFileSync(queuePath, 'utf8'), queueBefore, 'worker queue was not preserved across crash recovery');

  const capture = configs.find((config) => config.role === 'capture');
  const captureBefore = parseLaunch(launchOutput(capture.target));
  launchctl(capture, ['bootout', capture.target], 'supported-stop');
  await waitFor(() => !parseLaunch(launchOutput(capture.target)).loaded, 'capture stopped');
  launchctl(capture, ['bootstrap', `gui/${uid}`, capture.file], 'supported-start-bootstrap');
  await running(capture);
  launchctl(capture, ['kickstart', '-k', capture.target], 'supported-start');
  const captureAfter = await running(capture);
  assert.notEqual(captureAfter.pid, captureBefore.pid, 'supported capture restart did not replace PID');
  pidEvidence.capture.push(captureAfter.pid);
  freshEvidence.captureAfterRestart = await waitFor(() => {
    try { return statusFresh('capture'); } catch { return null; }
  }, 'capture status freshness after supported restart');

  for (const config of configs) {
    launchctl(config, ['bootout', config.target], 'stop');
    await waitFor(() => !parseLaunch(launchOutput(config.target)).loaded, `${config.role} stop`);
  }
  assert.equal(listeners(port).length, 0, 'disposable backend port remained open after stop');
  for (const config of configs) fs.rmSync(config.file, { force: false });
  after = protectedSnapshot();
  equalProtected(before, after);
  const cleanup = { labelsUnloaded: configs.every((config) => !parseLaunch(launchOutput(config.target)).loaded), portReleased: listeners(port).length === 0, runtimeRemoved: false };
  writeEvidence(cleanup);
  fs.rmSync(tempRoot, { recursive: true, force: false });
  cleanup.runtimeRemoved = !fs.existsSync(tempRoot);
  // Rewrite only evidence/progress (inside the isolated checkout) with final cleanup state.
  writeEvidence(cleanup);
  console.log(`PASS final macOS disposable lifecycle certification nonce=${nonce} port=${port}`);
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`FAIL final macOS disposable lifecycle certification: ${message}`);
  process.exitCode = 1;
} finally {
  // Best-effort cleanup still uses the exact generated labels only. No primary
  // label, PID, port, service file, or process is ever selected here.
  if (configs) {
    for (const config of configs) {
      try {
        if (fs.existsSync(config.file) && parseLaunch(launchOutput(config.target)).loaded) launchctl(config, ['bootout', config.target], 'trap-cleanup');
      } catch (cleanupError) { console.error(`cleanup warning for ${config.label}: ${cleanupError}`); process.exitCode = 1; }
    }
  }
  try {
    if (port && listeners(port).length !== 0) { console.error(`cleanup warning: disposable port ${port} remains open`); process.exitCode = 1; }
    if (fs.existsSync(tempRoot)) fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (cleanupError) { console.error(`runtime cleanup warning: ${cleanupError}`); process.exitCode = 1; }
}
