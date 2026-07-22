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
