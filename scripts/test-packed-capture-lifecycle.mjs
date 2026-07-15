#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rorca-packed-lifecycle-'));
const artifacts = path.join(tempRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout || ''}\n${result.stderr || ''}`);
  return result;
}

function npmJson(args, cwd = repoRoot) {
  return JSON.parse(run(npm, args, { cwd }).stdout);
}

function installArtifact(consumer, tarball) {
  run(npm, ['install', '--ignore-scripts', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund', '--package-lock=false', '--save-exact', tarball], { cwd: consumer });
}

function runCapture(packageRoot, args, env, cwd, expectedStatus = 0) {
  const cli = path.join(packageRoot, 'packages', 'rorca-capture', 'dist', 'cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => {
      try {
        assert.equal(status, expectedStatus, `capture CLI failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
        resolve({ stdout, stderr });
      } catch (error) { reject(error); }
    });
  });
}

const requests = [];
let workspace;
const server = http.createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/health') response.end(JSON.stringify({ status: 'ok' }));
    else if (request.method === 'GET' && request.url === '/api/workspaces') response.end(JSON.stringify({ items: [workspace] }));
    else response.end(JSON.stringify({ ok: true, workspace }));
  });
});

try {
  const dryPack = npmJson(['pack', '--dry-run', '--ignore-scripts', '--json'])[0];
  const files = new Map(dryPack.files.map((file) => [file.path, file]));
  const required = [
    'packages/rorca-capture/dist/cli.js',
    'packages/rorca-capture/dist/always-on.js',
    'packages/rorca-capture/dist/secure-fs.js',
    'packages/rorca-capture/package.json',
    'backend/src/lib/context-safety.js',
    'backend/src/lib/package.json',
    'backend/src/db/pg-migrations/20260714150000_always_on_context_mainline_reconciliation.sql',
    'docs/always-on-context-packaging.md',
    'docs/universal-context-capture.md',
    'scripts/install.sh',
    'scripts/install.ps1',
    'scripts/capture-platform-smoke.mjs',
    'README.md',
    'LICENSE',
  ];
  for (const file of required) assert(files.has(file), `packed artifact is missing ${file}`);
  assert(![...files.keys()].some((file) => file.includes('packages/rorca-capture/src/__tests__')), 'capture source tests must not ship');
  if (process.platform !== 'win32') assert.equal(files.get('packages/rorca-capture/dist/cli.js').mode & 0o111, 0o111, 'capture CLI must be executable');
  assert.equal(files.get('scripts/install.sh').mode & 0o111, 0o111, 'POSIX installer must be executable');

  const posixInstaller = readFileSync(path.join(repoRoot, 'scripts', 'install.sh'), 'utf8');
  const windowsInstaller = readFileSync(path.join(repoRoot, 'scripts', 'install.ps1'), 'utf8');
  for (const installer of [posixInstaller, windowsInstaller]) {
    assert(!/(^|\n)\s*sudo\s+/m.test(installer), 'installers must not invoke sudo');
    assert(!/launchctl|systemctl|Register-ScheduledTask|schtasks(?:\.exe)?/i.test(installer), 'installers must not mutate services');
    assert(!/reboot|shutdown|Restart-Computer|Stop-Computer/i.test(installer), 'installers must not reboot or shut down hosts');
  }

  const packed = npmJson(['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts])[0];
  const tarball = path.join(artifacts, packed.filename);
  const consumer = path.join(tempRoot, 'consumer');
  mkdirSync(consumer, { recursive: true });
  writeFileSync(path.join(consumer, 'package.json'), '{"name":"capture-consumer","private":true}\n', 'utf8');
  installArtifact(consumer, tarball);
  const installedRoot = path.join(consumer, 'node_modules', 'rorca');
  const linkedBin = path.join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'rorca-capture.cmd' : 'rorca-capture');
  assert(existsSync(linkedBin), 'npm install must expose rorca-capture');
  if (process.platform !== 'win32') assert((statSync(path.join(installedRoot, 'packages', 'rorca-capture', 'dist', 'cli.js')).mode & 0o111) !== 0);

  const home = path.join(tempRoot, 'home');
  const workspaceRoot = path.join(tempRoot, 'workspace');
  mkdirSync(path.join(home, '.rorca'), { recursive: true, mode: 0o700 });
  mkdirSync(path.join(workspaceRoot, '.git', 'hooks'), { recursive: true });
  workspace = { id: 'pack-demo', label: 'Pack Demo', path: workspaceRoot };
  const tokenPath = path.join(home, '.rorca', 'mcp-token');
  writeFileSync(tokenPath, 'pack-test-token-value\n', { mode: 0o600 });
  if (process.platform !== 'win32') { chmodSync(path.join(home, '.rorca'), 0o700); chmodSync(tokenPath, 0o600); }

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert(address && typeof address === 'object');
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const env = { ...process.env, HOME: home, USERPROFILE: home, RORCA_MCP_TOKEN_PATH: tokenPath };
  const common = ['--workspace', workspace.id, '--repo-path', workspaceRoot, '--api-url', apiUrl, '--json'];

  const setupRun = await runCapture(installedRoot, ['setup', '--always-on', '--policy', 'metadata-only', ...common], env, workspaceRoot);
  const captureDir = path.join(workspaceRoot, '.rorca', 'capture');
  const manifestPath = path.join(captureDir, 'uninstall.json');
  assert(existsSync(manifestPath), `setup did not create uninstall metadata\nstdout:\n${setupRun.stdout}\nstderr:\n${setupRun.stderr}`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const queuePath = path.join(workspaceRoot, '.rorca-capture-queue.jsonl');
  assert(manifest.preserves.includes(queuePath));
  assert(!manifest.removes.includes(queuePath));
  assert(!JSON.stringify(manifest).includes('pack-test-token-value'));
  assert(existsSync(path.join(workspaceRoot, '.git', 'hooks', 'post-commit')));

  await runCapture(installedRoot, ['pause', ...common], env, workspaceRoot);
  assert.equal(JSON.parse(readFileSync(path.join(captureDir, 'policy.json'), 'utf8')).paused, true);
  await runCapture(installedRoot, ['resume', ...common], env, workspaceRoot);
  assert.equal(JSON.parse(readFileSync(path.join(captureDir, 'policy.json'), 'utf8')).paused, false);

  writeFileSync(queuePath, '{"preserve":true}\n', { mode: 0o600 });
  const statePath = path.join(captureDir, 'state.json');
  const statusPath = path.join(captureDir, 'status.json');
  const logPath = path.join(captureDir, 'service.log');
  writeFileSync(statePath, '{"cursor":"abc"}\n', { mode: 0o600 });
  writeFileSync(statusPath, '{"status":"offline"}\n', { mode: 0o600 });
  writeFileSync(logPath, 'operator evidence\n', { mode: 0o600 });

  await runCapture(installedRoot, ['teardown', '--all', ...common], env, workspaceRoot);
  assert.equal(readFileSync(queuePath, 'utf8'), '{"preserve":true}\n');
  assert.equal(readFileSync(statePath, 'utf8'), '{"cursor":"abc"}\n');
  assert.equal(readFileSync(statusPath, 'utf8'), '{"status":"offline"}\n');
  assert.equal(readFileSync(logPath, 'utf8'), 'operator evidence\n');
  assert(!existsSync(path.join(workspaceRoot, '.git', 'hooks', 'post-commit')), 'managed hook must be removed');

  installArtifact(consumer, tarball);
  assert.equal(readFileSync(queuePath, 'utf8'), '{"preserve":true}\n');
  run(npm, ['uninstall', '--ignore-scripts', '--no-audit', '--no-fund', 'rorca'], { cwd: consumer });
  assert.equal(readFileSync(queuePath, 'utf8'), '{"preserve":true}\n');

  assert(requests.every((item) => item.authorization === `Bearer pack-test-token-value`));
  assert(requests.some((item) => item.url === '/api/context-capture/bootstrap/verify'));
  assert(requests.some((item) => item.url === '/api/context-capture/pack-demo/pause'));
  assert(!requests.some((item) => item.url?.includes('/uninstall')), 'teardown must not invoke queue-draining API uninstall');
  console.log(`PASS packed canonical capture lifecycle (${process.platform}): ${packed.filename}`);
} finally {
  await new Promise((resolve) => server.close(() => resolve()));
  rmSync(tempRoot, { recursive: true, force: true });
}
