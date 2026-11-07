#!/usr/bin/env node
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pi-packed-parity-'));
const packDir = path.join(temp, 'pack');
const installDir = path.join(temp, 'installed');
fs.mkdirSync(packDir, { recursive: true });
fs.mkdirSync(installDir, { recursive: true });

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

try {
  const packed = JSON.parse(execFileSync('npm', [
    'pack', '--workspace=@rorca/pi-extension', '--pack-destination', packDir, '--json',
  ], { cwd: root, encoding: 'utf8', timeout: 60_000 }));
  assert.equal(packed.length, 1);
  const tarball = path.join(packDir, packed[0].filename);
  assert.ok(fs.statSync(tarball).size > 0, 'package tarball must be non-empty');

  fs.writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ private: true }));
  execFileSync('npm', [
    'install', '--ignore-scripts', '--no-package-lock', '--omit=peer', tarball,
  ], { cwd: installDir, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });

  const installedRoot = path.join(installDir, 'node_modules', '@rorca', 'pi-extension');
  const installedSkill = fs.readFileSync(path.join(installedRoot, 'skills', 'rorca-forge', 'SKILL.md'), 'utf8');
  const installedLauncher = fs.readFileSync(path.join(installedRoot, 'extensions', 'rorca', 'skill-launcher.ts'), 'utf8');
  const installedContract = JSON.parse(fs.readFileSync(path.join(installedRoot, 'contracts', 'wave1-forge-mcp-contract.json'), 'utf8'));
  const sourceSkill = read('packages/rorca-pi-extension/skills/rorca-forge/SKILL.md');
  const sourceLauncher = read('packages/rorca-pi-extension/extensions/rorca/skill-launcher.ts');
  const sourceContract = JSON.parse(read('packages/rorca-pi-extension/contracts/wave1-forge-mcp-contract.json'));
  assert.equal(installedSkill, sourceSkill, 'installed Forge skill must byte-match source');
  assert.equal(installedLauncher, sourceLauncher, 'installed launcher must byte-match source');
  assert.deepEqual(installedContract, sourceContract, 'installed MCP contract must byte-semantically match source');

  for (const text of [installedSkill, installedLauncher]) {
    assert.match(text, /rorca_specs_generation_context/);
    assert.match(text, /rorca_create_spec/);
    assert.match(text, /rorca_persist_spec/);
    assert.match(text, /contextUsed/);
    assert.match(text, /contextSummary/);
    assert.match(text, /skill_first_strict/);
  }
  assert.match(installedSkill, /Do not approve or run unless/);
  assert.match(installedSkill, /never calls `rorca_specs_forge`/);
  assert.doesNotMatch(installedLauncher, /\["rorca_specs_forge"\]/);

  // Execute the actual OpenAPI-derived MCP handler. It performs a real
  // tools/list request, validates create-spec required input, verifies zero REST
  // forwarding, and proves the production 1 MiB parser rejects oversize bodies.
  const runtimeOutput = execFileSync(path.join(root, 'backend', 'node_modules', '.bin', 'tsx'), [
    path.join(root, 'backend', 'scripts', 'check-wave1-mcp-runtime-parity.ts'),
  ], { cwd: path.join(root, 'backend'), encoding: 'utf8', timeout: 60_000 });
  const runtimeJsonStart = runtimeOutput.indexOf('{\n  "schemaVersion": "rorca.wave1-forge-mcp-parity.v1"');
  assert.ok(runtimeJsonStart >= 0, 'actual MCP runtime probe did not return its contract');
  const runtimeContract = JSON.parse(runtimeOutput.slice(runtimeJsonStart));
  assert.deepEqual(runtimeContract, installedContract,
    'actual MCP discovery/request schemas/body limit/no-action behavior differ from installed package');

  // Import and execute the actual installed launcher rather than grepping it.
  const installedProbe = path.join(installDir, 'probe-installed-launcher.ts');
  fs.writeFileSync(installedProbe, `
    import { getRequiredToolGroups, formatSkillLaunchPrompt } from './node_modules/@rorca/pi-extension/extensions/rorca/skill-launcher.ts';
    const request = { workflow: 'forge', skillName: 'rorca-forge', workspaceId: 'ws', brief: 'brief', briefSource: 'test', autoApprove: false, autoRun: false, queue: false } as const;
    process.stdout.write(JSON.stringify({ groups: getRequiredToolGroups(request), prompt: formatSkillLaunchPrompt(request) }));
  `);
  const installedBehavior = JSON.parse(execFileSync(
    path.join(root, 'backend', 'node_modules', '.bin', 'tsx'), [installedProbe],
    { cwd: installDir, encoding: 'utf8', timeout: 30_000 },
  ));
  const flattenedGroups = installedBehavior.groups.flat();
  assert.ok(flattenedGroups.includes('rorca_specs_generation_context'));
  assert.ok(flattenedGroups.includes('rorca_create_spec'));
  assert.ok(!flattenedGroups.includes('rorca_approve_spec'), 'no-approve launch unexpectedly requested approval');
  assert.ok(!flattenedGroups.includes('rorca_trigger_run'), 'no-run launch unexpectedly requested execution');
  assert.match(installedBehavior.prompt, /autoApprove: false/);
  assert.match(installedBehavior.prompt, /autoRun: false/);

  const snapshot = JSON.parse(read('docs/openapi-public-snapshot.json'));
  const paths = new Set(snapshot.routes.map((route) => `${route.method} ${route.path}`));
  for (const operation of [
    'POST /api/specs/generation-context',
    'POST /api/specs/persist',
    'GET /api/recovery/runs/{runId}/closeout-reconciliation',
    'GET /api/recovery/runs/{runId}/closeout-reconciliation/preview',
  ]) assert.ok(paths.has(operation), `public contract missing ${operation}`);
  assert.ok(!paths.has('POST /api/admin/recovery/runs/{runId}/closeout-reconciliation'), 'apply must remain non-public');

  const packageJson = JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8'));
  assert.deepEqual(packageJson.pi.skills, ['./skills']);
  console.log(`PI_PACKED_FORGE_PARITY_PASSED tarball=${path.basename(tarball)} files=${packed[0].files.length}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
