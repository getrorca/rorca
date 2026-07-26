/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import hermesFixture from './fixtures/hermes-task-manifest.json';
import { parseTaskManifest } from '../task-manifest';
import { writeTaskManifestArtifact } from '../task-manifest-artifacts';
import {
  createTaskManifestExecutionEnvelope,
  writeTaskManifestExecutionEnvelope,
} from '../task-manifest-execution-envelope';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

test('task-manifest artifact publication rejects a symlinked artifact root', async () => {
  const workspace = temporary('rorca-task-artifact-workspace-');
  const outside = temporary('rorca-task-artifact-outside-');
  fs.mkdirSync(path.join(workspace, 'forge'));
  fs.symlinkSync(outside, path.join(workspace, 'forge', 'task-manifests'), 'dir');
  const manifest = parseTaskManifest(JSON.parse(JSON.stringify(hermesFixture)));

  await expect(writeTaskManifestArtifact({ workspacePath: workspace, manifest }))
    .rejects.toThrow(/symlink|filesystem authority/i);
  expect(fs.readdirSync(outside)).toEqual([]);
});

test('synthetic execution spec rejects a pre-existing symlink before any outside write', async () => {
  const workspace = temporary('rorca-task-envelope-workspace-');
  const outside = temporary('rorca-task-envelope-outside-');
  const manifest = parseTaskManifest(JSON.parse(JSON.stringify(hermesFixture)));
  const spec = createTaskManifestExecutionEnvelope(manifest);
  const dir = path.join(workspace, 'forge', 'task-manifests', manifest.manifestId);
  fs.mkdirSync(dir, { recursive: true });
  const outsideSpec = path.join(outside, 'outside.json');
  fs.writeFileSync(outsideSpec, 'outside-authority\n');
  fs.symlinkSync(outsideSpec, path.join(dir, `${spec.id}.json`));

  await expect(writeTaskManifestExecutionEnvelope({ workspacePath: workspace, manifest }))
    .rejects.toThrow(/symlink|regular|existing|authority/i);
  expect(fs.readFileSync(outsideSpec, 'utf8')).toBe('outside-authority\n');
});

test('synthetic execution spec permits byte-identical replay but rejects ordinary overwrite', async () => {
  const workspace = temporary('rorca-task-envelope-replay-');
  const manifest = parseTaskManifest(JSON.parse(JSON.stringify(hermesFixture)));
  const first = await writeTaskManifestExecutionEnvelope({ workspacePath: workspace, manifest });
  const second = await writeTaskManifestExecutionEnvelope({ workspacePath: workspace, manifest });
  expect(second.specPath).toBe(first.specPath);
  fs.writeFileSync(first.specPath, '{}\n');
  await expect(writeTaskManifestExecutionEnvelope({ workspacePath: workspace, manifest }))
    .rejects.toThrow(/different|existing|authority/i);
});

test('task-manifest artifact replay rejects a symlinked manifest authority file', async () => {
  const workspace = temporary('rorca-task-artifact-workspace-');
  const outside = temporary('rorca-task-artifact-outside-');
  const manifest = parseTaskManifest(JSON.parse(JSON.stringify(hermesFixture)));
  const dir = path.join(workspace, 'forge', 'task-manifests', manifest.manifestId);
  fs.mkdirSync(dir, { recursive: true });
  const outsideManifest = path.join(outside, 'manifest.json');
  fs.writeFileSync(outsideManifest, JSON.stringify(manifest));
  fs.symlinkSync(outsideManifest, path.join(dir, 'manifest.json'));

  await expect(writeTaskManifestArtifact({ workspacePath: workspace, manifest }))
    .rejects.toThrow(/regular non-symlink/i);
});
