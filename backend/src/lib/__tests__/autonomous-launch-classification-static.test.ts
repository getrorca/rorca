/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const backendRoot = path.resolve(__dirname, '..', '..', '..');
const repoRoot = path.resolve(backendRoot, '..');

type Classification = 'autonomous-sandboxed' | 'trusted-host' | 'boundary' | 'retired';

/**
 * Closed production allowlist. Adding any child_process import requires an
 * explicit security classification and rationale here. Autonomous launchers
 * must additionally cross the central sandbox seam below.
 */
const CLASSIFICATIONS: Record<string, { classification: Classification; rationale: string }> = {
  'lib/agent-hook-runner.ts': { classification: 'autonomous-sandboxed', rationale: 'workspace-configured shell hook' },
  'lib/agents-parser.ts': { classification: 'trusted-host', rationale: 'bounded read-only Git metadata parser' },
  'lib/autonomous-cli-probe.ts': { classification: 'boundary', rationale: 'central networkless CLI probe wrapper' },
  'lib/autonomous-sandbox.ts': { classification: 'boundary', rationale: 'namespace construction and capability probe' },
  'lib/backup.ts': { classification: 'trusted-host', rationale: 'operator-owned database backup client' },
  'lib/claude-auth.ts': { classification: 'trusted-host', rationale: 'explicit operator credential login/logout' },
  'lib/codex-auth.ts': { classification: 'trusted-host', rationale: 'explicit operator credential login/logout' },
  'lib/codex-spec-drafter.ts': { classification: 'autonomous-sandboxed', rationale: 'tool-capable model drafting' },
  'lib/context-diff.ts': { classification: 'trusted-host', rationale: 'read-only host Git diff' },
  'lib/db-sidecar.js': { classification: 'trusted-host', rationale: 'legacy operator DB lifecycle adapter' },
  'lib/db-sidecar.ts': { classification: 'trusted-host', rationale: 'operator DB lifecycle adapter' },
  'lib/execution-engine.ts': { classification: 'autonomous-sandboxed', rationale: 'model/validation children; host Git remains orchestrator-owned' },
  'lib/gitreins-runner.ts': { classification: 'autonomous-sandboxed', rationale: 'workspace-reading validation tool' },
  'lib/hilo-hydration-runner.ts': { classification: 'autonomous-sandboxed', rationale: 'workspace-reading configured binary' },
  'lib/hook-runner.ts': { classification: 'autonomous-sandboxed', rationale: 'workspace-configured pipeline shell hook' },
  'lib/llm-client.ts': { classification: 'autonomous-sandboxed', rationale: 'Claude model CLI; SDK providers do not spawn' },
  'lib/memory-synthesis.ts': { classification: 'trusted-host', rationale: 'bounded read-only host Git history' },
  'lib/merge-conflict-resolver.ts': { classification: 'autonomous-sandboxed', rationale: 'model conflict resolver' },
  'lib/merge-handler.ts': { classification: 'trusted-host', rationale: 'canonical release Git authority' },
  'lib/opencode-server.ts': { classification: 'retired', rationale: 'warm cross-namespace server fails closed' },
  'lib/opencode-spec-gen.ts': { classification: 'autonomous-sandboxed', rationale: 'tool-capable model drafting' },
  'lib/pi-autonomous-runner.ts': { classification: 'trusted-host', rationale: 'ChildProcess type declarations only; it does not launch a process' },
  'lib/pi-spec-drafter.ts': { classification: 'autonomous-sandboxed', rationale: 'tool-capable model drafting' },
  'lib/postgres-manager.ts': { classification: 'trusted-host', rationale: 'operator database lifecycle control' },
  'lib/release-authority.ts': { classification: 'trusted-host', rationale: 'canonical provider/release Git authority' },
  'lib/run-git-authority.ts': { classification: 'trusted-host', rationale: 'canonical run Git host authority' },
  'lib/secret-resolver.ts': { classification: 'trusted-host', rationale: 'explicit secret broker client' },
  'lib/ssdlc-liveness.ts': { classification: 'trusted-host', rationale: 'bounded read-only Git liveness probe' },
  'lib/story-host-validation.ts': { classification: 'autonomous-sandboxed', rationale: 'workspace-controlled validation commands' },
  'lib/supervisor.ts': { classification: 'trusted-host', rationale: 'API/worker process supervisor' },
  'lib/worktree-freshness.ts': { classification: 'trusted-host', rationale: 'canonical host Git freshness/CAS probe' },
  'routes/context-files.ts': { classification: 'trusted-host', rationale: 'authorized host Git context diff' },
  'routes/doctor.ts': { classification: 'trusted-host', rationale: 'operator infrastructure diagnostics' },
  'routes/pipeline.ts': { classification: 'trusted-host', rationale: 'read-only host Git base snapshot; no execution spawn' },
  'routes/specs.ts': { classification: 'trusted-host', rationale: 'read-only host Git branch metadata; models use isolated libraries' },
  'routes/workspaces.ts': { classification: 'trusted-host', rationale: 'authorized scaffold Git commit' },
  'runner/local-runner.ts': { classification: 'trusted-host', rationale: 'separate user-owned engine orchestrator; agents sandbox in engine' },
  'tui/Forge.tsx': { classification: 'trusted-host', rationale: 'explicit local operator TUI command' },
  'worker-supervisor.ts': { classification: 'trusted-host', rationale: 'worker service lifecycle supervisor' },
  'worker.ts': { classification: 'trusted-host', rationale: 'canonical queue/release engine orchestrator' },
};

function productionFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'fixtures') continue;
      found.push(...productionFiles(absolute));
    } else if (!entry.name.endsWith('.test.ts')) {
      found.push(absolute);
    }
  }
  return found;
}

function source(relative: string): string {
  return fs.readFileSync(path.join(backendRoot, 'src', relative), 'utf8');
}

test('every production child_process surface has an explicit closed classification', () => {
  const imports = productionFiles(path.join(backendRoot, 'src'))
    .filter(file => /from ['"](?:node:)?child_process['"]|require\(['"](?:node:)?child_process['"]\)/.test(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(path.join(backendRoot, 'src'), file))
    .sort();
  expect(imports).toEqual(Object.keys(CLASSIFICATIONS).sort());
  for (const entry of Object.values(CLASSIFICATIONS)) expect(entry.rationale.length).toBeGreaterThan(12);
});

test('every autonomous subprocess crosses the central sandbox seam and retired launchers cannot spawn', () => {
  for (const [relative, entry] of Object.entries(CLASSIFICATIONS)) {
    const text = source(relative);
    if (entry.classification === 'autonomous-sandboxed') {
      expect(text).toMatch(/prepareAutonomous(?:Model)?SandboxLaunch|isolatedAgentLaunch|pi-autonomous-runner.*execution-engine/s);
    }
    if (entry.classification === 'retired') {
      expect(text).not.toMatch(/\bspawn(?:Sync)?\s*\(/);
      expect(text).toContain('retired');
    }
  }
});

test('named API model launchers use the model sandbox helper and never inherit process.env directly', () => {
  for (const relative of [
    'lib/codex-spec-drafter.ts', 'lib/pi-spec-drafter.ts',
    'lib/opencode-spec-gen.ts', 'lib/llm-client.ts',
  ]) {
    const text = source(relative);
    expect(text).toContain('prepareAutonomousModelSandboxLaunch');
    expect(text).toMatch(/spawn\(launch\.command, launch\.args/);
    expect(text).not.toMatch(/spawn\([^\n]+,[\s\S]{0,180}env:\s*\{\s*\.\.\.process\.env/);
  }
  expect(source('lib/codex-spec-drafter.ts')).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  expect(source('lib/llm-client.ts')).not.toContain('--dangerously-skip-permissions');
});

test('quick-run is a truthful no-mutation conflict and legacy shell loop is unreachable', () => {
  const pipeline = source('routes/pipeline.ts');
  const handler = pipeline.slice(
    pipeline.indexOf("router.post('/quick-run'"),
    pipeline.indexOf('// ─── POST /api/pipeline/runs', pipeline.indexOf("router.post('/quick-run'")),
  );
  expect(handler).toContain('res.status(409)');
  expect(handler).toContain("error: 'quick_run_retired'");
  for (const forbidden of ['queryOne(', 'execute(', 'getWorkspaceEnvVars(', 'spawn(', 'writeFile', 'mkdir', 'chatComplete(']) {
    expect(handler).not.toContain(forbidden);
  }
  expect(pipeline).not.toContain("path.join(workspace.path, 'forge', 'run-loop.sh')");
  expect(source('routes/pipeline.ts')).not.toMatch(/\bspawn\s*\(/);
  const legacyLoop = fs.readFileSync(path.join(repoRoot, 'forge', 'run-loop.sh'), 'utf8');
  expect(legacyLoop).toContain('run-loop.sh is retired');
  expect(legacyLoop).toContain('exit 64');
  expect(legacyLoop).not.toMatch(/\b(?:claude|codex|opencode|pi)\s+(?:exec|--print|run)/);
  expect(fs.readFileSync(path.join(repoRoot, 'src', 'panels', 'SpecsPanel.tsx'), 'utf8'))
    .not.toContain('/api/pipeline/quick-run');
});

test('model credentials and broker mount require explicit model classification', () => {
  for (const relative of ['lib/hook-runner.ts', 'lib/agent-hook-runner.ts', 'lib/hilo-hydration-runner.ts', 'lib/story-host-validation.ts']) {
    expect(source(relative)).not.toContain('modelCredentials: true');
  }
  for (const relative of ['lib/merge-conflict-resolver.ts', 'lib/gitreins-runner.ts']) {
    expect(source(relative)).toContain('modelCredentials: true');
    expect(source(relative)).toContain('ensureAutonomousModelEgress');
  }
  expect(source('lib/execution-engine.ts')).toContain('modelCredentials = true');
  expect(source('lib/execution-engine.ts')).toContain("buildGuardedAgentEnv(cwd, env), false");
  expect(source('lib/execution-engine.ts')).not.toContain('mcp add');
  expect(source('lib/execution-engine.ts')).not.toContain('mcp remove');
  expect(source('routes/pipeline.ts')).toContain("browserMcpReason: 'disabled_by_autonomous_isolation'");
});

test('raw local-dev mode and ambient model CLI flags cannot return', () => {
  const sandbox = source('lib/autonomous-sandbox.ts');
  expect(sandbox).not.toContain("'local-dev'");
  expect(sandbox).not.toContain("NODE_ENV === 'test'");
  expect(sandbox).toContain('raw local-dev autonomous execution is forbidden');
  expect(source('lib/autonomous-model-egress.ts')).toContain("env.RORCA_AUTONOMOUS_ISOLATION !== 'linux-bwrap'");
  const dangerous = productionFiles(path.join(backendRoot, 'src'))
    .map(file => ({ file, text: fs.readFileSync(file, 'utf8') }))
    .filter(item => /--dangerously-(?:skip-permissions|bypass-approvals-and-sandbox)/.test(item.text));
  for (const item of dangerous) {
    if (item.file.endsWith('pty-cli-compat.ts')) {
      expect(item.text).toContain('probeAutonomousCli');
      continue;
    }
    expect(item.text).toMatch(/prepareAutonomousSandboxLaunch|isolatedAgentLaunch/);
  }
});
