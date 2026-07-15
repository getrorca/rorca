#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'rorca packed lifecycle '));
const artifacts = path.join(tempRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\nstdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`);
  }
  return result;
}

function npmJson(args, cwd = repoRoot) {
  const result = run(npm, args, { cwd });
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm did not return JSON:\n${result.stdout}\n${result.stderr}`);
  }
}

function installArtifact(consumer, tarball) {
  run(npm, [
    'install', '--ignore-scripts', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund',
    '--package-lock=false', '--save-exact', tarball,
  ], { cwd: consumer });
}

function runCapture(packageRoot, args, env, expectedStatus = 0) {
  const cli = path.join(packageRoot, 'bin', 'rorca-capture.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
        resolve({ status, stdout, stderr });
      } catch (error) {
        reject(error);
      }
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
    if (request.method === 'GET' && request.url === '/api/health') response.end(JSON.stringify({ status: 'ok', version: 'pack-test', mcp: { status: 'ok' } }));
    else if (request.method === 'GET' && request.url === '/api/workspaces') response.end(JSON.stringify({ items: [workspace] }));
    else response.end(JSON.stringify({ ok: true, workspace, status: { paused: request.url?.endsWith('/pause') } }));
  });
});

try {
  const dryPack = npmJson(['pack', '--dry-run', '--ignore-scripts', '--json'])[0];
  const files = new Map(dryPack.files.map((file) => [file.path, file]));
  const required = [
    'bin/rorca-capture.js',
    'packages/rorca-pi-extension/extensions/rorca/capture-bootstrap.js',
    'packages/rorca-pi-extension/extensions/rorca/capture-bootstrap.ts',
    'packages/rorca-pi-extension/extensions/rorca/capture-service.js',
    'packages/rorca-pi-extension/extensions/rorca/capture-shell.js',
    'backend/src/lib/context-safety.js',
    'backend/src/lib/package.json',
    'backend/src/db/pg-migrations/20260714143000_context_capture_candidate_compatibility.sql',
    'docs/always-on-context-packaging.md',
    'docs/universal-context-capture.md',
    'scripts/install.sh',
    'scripts/install.ps1',
    'scripts/capture-platform-smoke.mjs',
    'README.md',
    'LICENSE',
  ];
  for (const file of required) assert(files.has(file), `packed artifact is missing ${file}`);
  assert.equal(files.get('bin/rorca-capture.js').mode & 0o111, 0o111, 'capture CLI must be executable in the tarball');
  assert.equal(files.get('scripts/install.sh').mode & 0o111, 0o111, 'POSIX installer must be executable in the tarball');
  const posixInstaller = readFileSync(path.join(repoRoot, 'scripts', 'install.sh'), 'utf8');
  const windowsInstaller = readFileSync(path.join(repoRoot, 'scripts', 'install.ps1'), 'utf8');
  for (const installer of [posixInstaller, windowsInstaller]) {
    assert(!/(^|\n)\s*sudo\s+/m.test(installer), 'installers must not invoke sudo');
    assert(!/launchctl|systemctl|Register-ScheduledTask|schtasks(?:\.exe)?/i.test(installer), 'installers must not mutate live services');
    assert(!/\b(?:claude|codex|opencode|cursor|code)\b\s+(?:run|exec|--install)/i.test(installer), 'installers must not invoke providers or editors');
    assert(!/reboot|shutdown|Restart-Computer|Stop-Computer/i.test(installer), 'installers must not reboot or shut down hosts');
  }

  const packed = npmJson(['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts])[0];
  const currentTarball = path.join(artifacts, packed.filename);
  assert(existsSync(currentTarball), 'npm pack did not produce a tarball');

  // Create a deterministic prior-version artifact from the packed contents. No
  // source-checkout module is imported after this point.
  const previousSource = path.join(tempRoot, 'previous source');
  mkdirSync(previousSource, { recursive: true });
  run('tar', ['-xzf', currentTarball, '-C', previousSource]);
  const previousPackageRoot = path.join(previousSource, 'package');
  const previousManifestPath = path.join(previousPackageRoot, 'package.json');
  const previousManifest = JSON.parse(readFileSync(previousManifestPath, 'utf8'));
  previousManifest.version = '0.0.0-wave1';
  writeFileSync(previousManifestPath, `${JSON.stringify(previousManifest, null, 2)}\n`, 'utf8');
  const previousPacked = npmJson(['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], previousPackageRoot)[0];
  const previousTarball = path.join(artifacts, previousPacked.filename);

  const consumer = path.join(tempRoot, 'consumer with spaces');
  mkdirSync(consumer, { recursive: true });
  writeFileSync(path.join(consumer, 'package.json'), '{"name":"capture-package-consumer","private":true}\n', 'utf8');
  installArtifact(consumer, previousTarball);

  const installedRoot = path.join(consumer, 'node_modules', 'rorca');
  assert.equal(JSON.parse(readFileSync(path.join(installedRoot, 'package.json'), 'utf8')).version, '0.0.0-wave1');
  assert(existsSync(path.join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'rorca-capture.cmd' : 'rorca-capture')));
  if (process.platform !== 'win32') assert.equal(statSync(path.join(installedRoot, 'bin', 'rorca-capture.js')).mode & 0o111, 0o111);

  const home = path.join(tempRoot, 'home with spaces');
  const workspaceRoot = path.join(tempRoot, "workspace's path with spaces");
  mkdirSync(path.join(home, '.rorca'), { recursive: true });
  mkdirSync(path.join(workspaceRoot, '.git', 'hooks'), { recursive: true });
  workspace = { id: 'pack-demo', label: 'Pack Demo', path: workspaceRoot };
  const tokenPath = path.join(home, '.rorca', 'mcp-token');
  writeFileSync(tokenPath, 'pack-test-token-value\n', 'utf8');
  if (process.platform !== 'win32') chmodSync(tokenPath, 0o600);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const emptyPath = path.join(tempRoot, 'empty path');
  mkdirSync(emptyPath, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    SHELL: '/bin/zsh',
    PATH: emptyPath,
    RORCA_PI_API_URL: apiUrl,
    RORCA_CAPTURE_API_URL: apiUrl,
  };

  await runCapture(installedRoot, ['setup', '--always-on', '--policy', 'metadata-only', '--workspace-id', workspace.id, '--cwd', workspaceRoot, '--api-base-url', apiUrl, '--json'], env);
  const firstUninstall = JSON.parse(readFileSync(path.join(workspaceRoot, '.rorca', 'capture', 'uninstall.json'), 'utf8'));
  assert(firstUninstall.preserves.includes(path.join(workspaceRoot, '.rorca', 'capture', 'queue')));
  assert(!firstUninstall.removes.includes(path.join(workspaceRoot, '.rorca', 'capture', 'queue')));
  const allGeneratedText = JSON.stringify(firstUninstall) + readFileSync(path.join(workspaceRoot, '.rorca', 'capture', 'adapters', 'claude-code', 'slash-commands.json'), 'utf8');
  assert(!allGeneratedText.includes('pack-test-token-value'), 'generated files must contain token paths, never token values');

  // Idempotent reinstall from the same packed prior version.
  await runCapture(installedRoot, ['setup', '--always-on', '--policy', 'metadata-only', '--workspace-id', workspace.id, '--cwd', workspaceRoot, '--api-base-url', apiUrl, '--json'], env);

  const captureDir = path.join(workspaceRoot, '.rorca', 'capture');
  const queueFile = path.join(captureDir, 'queue', 'offline.ndjson');
  const stateFile = path.join(captureDir, 'state.json');
  const statusFile = path.join(captureDir, 'status.json');
  const logFile = path.join(captureDir, 'service.log');
  const protectedFile = path.join(captureDir, 'operator-notes.txt');
  const userWorkspaceFile = path.join(workspaceRoot, 'USER-DATA.txt');
  writeFileSync(queueFile, '{"id":"preserve-me"}\n', 'utf8');
  writeFileSync(stateFile, '{"cursor":{"lastCommit":"abc123"}}\n', 'utf8');
  writeFileSync(statusFile, '{"status":"offline"}\n', 'utf8');
  writeFileSync(logFile, 'operator evidence\n', 'utf8');
  writeFileSync(protectedFile, 'not managed by Rorca\n', 'utf8');
  writeFileSync(userWorkspaceFile, 'workspace data\n', 'utf8');

  await runCapture(installedRoot, ['pause', '--workspace-id', workspace.id, '--cwd', workspaceRoot, '--api-base-url', apiUrl, '--json'], env);
  assert.equal(JSON.parse(readFileSync(path.join(captureDir, 'policy.json'), 'utf8')).paused, true);
  await runCapture(installedRoot, ['resume', '--workspace-id', workspace.id, '--cwd', workspaceRoot, '--api-base-url', apiUrl, '--json'], env);
  assert.equal(JSON.parse(readFileSync(path.join(captureDir, 'policy.json'), 'utf8')).paused, false);

  // Upgrade and rollback replace only package code. Workspace queue/state stay out
  // of node_modules and must survive both directions.
  installArtifact(consumer, currentTarball);
  assert.equal(JSON.parse(readFileSync(path.join(installedRoot, 'package.json'), 'utf8')).version, packed.version);
  assert.equal(readFileSync(queueFile, 'utf8'), '{"id":"preserve-me"}\n');
  installArtifact(consumer, previousTarball);
  assert.equal(JSON.parse(readFileSync(path.join(installedRoot, 'package.json'), 'utf8')).version, '0.0.0-wave1');
  assert.equal(readFileSync(stateFile, 'utf8'), '{"cursor":{"lastCommit":"abc123"}}\n');

  // Legacy --all is deliberately data-preserving. It removes only files listed
  // in signed/sentinel uninstall metadata and the managed shell startup block.
  await runCapture(installedRoot, ['teardown', '--all', '--cwd', workspaceRoot, '--json'], env);
  assert.equal(readFileSync(queueFile, 'utf8'), '{"id":"preserve-me"}\n');
  assert.equal(readFileSync(stateFile, 'utf8'), '{"cursor":{"lastCommit":"abc123"}}\n');
  assert.equal(readFileSync(statusFile, 'utf8'), '{"status":"offline"}\n');
  assert.equal(readFileSync(logFile, 'utf8'), 'operator evidence\n');
  assert.equal(readFileSync(protectedFile, 'utf8'), 'not managed by Rorca\n');
  assert.equal(readFileSync(userWorkspaceFile, 'utf8'), 'workspace data\n');
  assert(!existsSync(path.join(workspaceRoot, '.git', 'hooks', 'post-commit')), 'managed git hook should be removed');
  assert(!existsSync(path.join(workspaceRoot, '.rorca-captureignore')), 'managed ignore file should be removed');
  const zshrc = path.join(home, '.zshrc');
  assert(!existsSync(zshrc) || !readFileSync(zshrc, 'utf8').includes('rorca-capture always-on (managed)'));

  run(npm, ['uninstall', '--ignore-scripts', '--no-audit', '--no-fund', 'rorca'], { cwd: consumer });
  assert(!existsSync(installedRoot), 'npm uninstall should remove package code');
  assert.equal(readFileSync(queueFile, 'utf8'), '{"id":"preserve-me"}\n');
  assert.equal(readFileSync(userWorkspaceFile, 'utf8'), 'workspace data\n');

  assert(requests.some((item) => item.url === '/api/context-capture/bootstrap/verify'));
  assert(requests.some((item) => item.url === '/api/context-capture/pack-demo/pause'));
  assert(!requests.some((item) => item.url?.includes('/uninstall')), 'package lifecycle test must not invoke queue-draining API uninstall');
  assert(!requests.some((item) => /provider|claude|codex|opencode|editor/i.test(item.url || '')));
  console.log(`PASS packed capture lifecycle (${process.platform}): ${packed.filename}`);
} finally {
  await new Promise((resolve) => server.close(() => resolve()));
  rmSync(tempRoot, { recursive: true, force: true });
}
