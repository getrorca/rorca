/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const backendRoot = path.resolve(__dirname, '..', '..', '..');
const repoRoot = path.resolve(backendRoot, '..');
const sandbox = fs.readFileSync(path.join(backendRoot, 'src', 'lib', 'autonomous-sandbox.ts'), 'utf8');
const egress = fs.readFileSync(path.join(backendRoot, 'src', 'lib', 'autonomous-model-egress.ts'), 'utf8');
const engine = fs.readFileSync(path.join(backendRoot, 'src', 'lib', 'execution-engine.ts'), 'utf8');
const worker = fs.readFileSync(path.join(backendRoot, 'src', 'worker.ts'), 'utf8');
const hostValidation = fs.readFileSync(path.join(backendRoot, 'src', 'lib', 'story-host-validation.ts'), 'utf8');
const resolver = fs.readFileSync(path.join(backendRoot, 'src', 'lib', 'merge-conflict-resolver.ts'), 'utf8');
const gitreins = fs.readFileSync(path.join(backendRoot, 'src', 'lib', 'gitreins-runner.ts'), 'utf8');
const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
const backendDockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile.backend'), 'utf8');
const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');

test('production worker image and Compose select the concrete fail-closed sandbox primitive', () => {
  for (const source of [dockerfile, backendDockerfile]) {
    expect(source).toContain('bubblewrap');
    expect(source).toContain('github-cli');
    expect(source).toContain('python3');
    expect(source).toContain('RORCA_AUTONOMOUS_ISOLATION=linux-bwrap');
    expect(source).toContain('RORCA_BWRAP_BIN=/usr/bin/bwrap');
  }
  expect(compose).toContain('RORCA_AUTONOMOUS_ISOLATION: linux-bwrap');
  expect(compose).toContain('RORCA_BWRAP_BIN: /usr/bin/bwrap');
  expect(compose).toContain('RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS:');
  expect(compose).toContain('cap_drop:');
  expect(compose).toContain('- SYS_ADMIN');
  expect(compose).toContain('- no-new-privileges:true');
  expect(compose).toContain('- apparmor:unconfined');
  expect(sandbox).toContain("'--cap-drop', 'ALL'");
});

test('worker proves isolation before either fresh or retry lifecycle can become running', () => {
  const calls = [...worker.matchAll(/assertAutonomousExecutionBoundary\(\{/g)].map(match => match.index!);
  const egress = [...worker.matchAll(/await ensureAutonomousModelEgress\(\)/g)].map(match => match.index!);
  const running = [...worker.matchAll(/transitionRunLifecycle\(runId, 'starting'/g)].map(match => match.index!);
  expect(calls).toHaveLength(2);
  expect(egress).toHaveLength(2);
  expect(running).toHaveLength(2);
  expect(calls[0]).toBeLessThan(egress[0]);
  expect(egress[0]).toBeLessThan(running[0]);
  expect(calls[1]).toBeLessThan(egress[1]);
  expect(egress[1]).toBeLessThan(running[1]);
  expect(worker).not.toContain('assertLocalDevHasNoDurableProviderAuthority');
  expect(worker).toContain('providerCapable: payload.safetyOptions.externalSend');
  expect(worker).toContain('providerCapable: approvedPreview.options.safety.externalSend');
});

test('semantic, RPC, PTY, conflict resolution, and worktree-controlled host validation all use one sandbox launch seam', () => {
  expect(engine.match(/isolatedAgentLaunch\(/g)?.length).toBeGreaterThanOrEqual(7);
  expect(engine).toContain('nodePty.spawn(launch.command, launch.args');
  expect(engine).toContain("isolatedAgentLaunch('npx', ['tsc', '--noEmit']");
  expect(hostValidation).toContain('prepareAutonomousSandboxLaunch({');
  expect(hostValidation).toContain('spawnSync(launch.command, launch.args');
  expect(resolver).toContain('prepareAutonomousSandboxLaunch({');
  expect(resolver).toContain('spawn(launch.command, launch.args');
  expect(gitreins).toContain('prepareAutonomousSandboxLaunch({');
  expect(gitreins).toContain('spawn(launch.command, launch.args');
});

test('boundary is topology with an exec-time ancestor marker and a no-PID-isolation sensitivity control', () => {
  for (const required of [
    "'--unshare-all'", "'--clearenv'", "'--proc', '/proc'", "'--tmpfs', '/tmp'",
    "denied('127.0.0.1',3030)", "denied('198.51.100.1',443)",
    "'/usr/local/bin/node'", "'/usr/bin/python3'", "'/usr/bin/git'", "'/usr/bin/gh'",
    "'/usr/local/bin/npm'", "'/usr/local/bin/npx'", "fs.readFileSync('/proc/'",
    "Buffer.from('RORCA_ANCESTOR_SECRET_PROBE=')", 'BOUNDARY_PROBE_SUPERVISOR',
    "sensitivity.status !== 41", "'--unshare-ipc'", "'--unshare-cgroup-try'",
    "retain the supervisor's user and PID namespaces",
  ]) expect(sandbox).toContain(required);
  expect(sandbox).not.toContain('process.env.RORCA_ANCESTOR_SECRET_PROBE =');
  expect(sandbox).not.toMatch(/args:\s*\[[^\]]*marker/);
  expect(sandbox).not.toContain("fs.writeFileSync(workspaceCredential, marker");
  expect(sandbox).toContain('Repository Git config contains an embedded credential');
  expect(sandbox).toContain('Autonomous worktree overlaps the trusted engine installation');
  expect(sandbox).toContain('raw local-dev autonomous execution is forbidden');
  expect(sandbox).toContain("selected.HTTPS_PROXY = SANDBOX_PROXY_URL");
  expect(sandbox).toContain('Autonomous model egress endpoint is not a Unix socket');
  expect(egress).toContain("host.endsWith('.github.com')");
  expect(egress).toContain("port !== 443 || !allowed.has(host)");
  expect(egress).toContain('dns.lookup(host, { all: true, verbatim: true })');
  expect(egress).toContain('resolved.some(candidate => !isPublicAddress(candidate.address))');
  expect(sandbox).not.toContain("'--ro-bind', '/', '/'");
});
