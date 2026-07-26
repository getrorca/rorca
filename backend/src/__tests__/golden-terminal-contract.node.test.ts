/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  assertGoldenReplay,
  loadGoldenFixture,
  readGoldenManifest,
  type GoldenAvailability,
  type GoldenEngine,
} from './helpers/golden-terminal-harness';
import { RELEASE_TERMINAL_RUNTIME } from '../lib/terminal-runtime-contract';

function replay(fixture: ReturnType<typeof loadGoldenFixture>): {
  bytes: Buffer;
  chunkIds: string[];
} {
  const ordered = fixture.replayChunks.slice().sort((left, right) => left.sequence - right.sequence);
  return {
    bytes: Buffer.concat(ordered.map(({ chunk }) => chunk)),
    chunkIds: ordered.map(({ sequence }) => `v1|run_pty_output_chunks|00000000-0000-4000-8000-000000000000|${sequence}`),
  };
}

function availability(engine: GoldenEngine, version: string): GoldenAvailability {
  return { available: true, reason: null, installedVersion: `${engine} ${version}` };
}

for (const [engine, version] of [
  ['pi', RELEASE_TERMINAL_RUNTIME.pi.version],
  ['opencode', RELEASE_TERMINAL_RUNTIME.opencode.version],
] as const) {
  test(`${engine} requires exact pinned, fixture, and installed version equality`, () => {
    const fixture = loadGoldenFixture(engine);
    const current = replay(fixture);

    assert.doesNotThrow(() => assertGoldenReplay(
      fixture,
      current.bytes,
      current.chunkIds,
      availability(engine, version),
    ));
    assert.throws(() => assertGoldenReplay(
      fixture,
      current.bytes,
      current.chunkIds,
      availability(engine, '0.0.0'),
    ), /version mismatch/);
    assert.throws(() => assertGoldenReplay(
      fixture,
      current.bytes,
      current.chunkIds,
      { available: false, reason: `${engine} unavailable`, installedVersion: null },
    ), /version mismatch/);
  });
}

test('Pi/OpenCode fixtures remain non-release while every shipped/runtime verifier pin stays exact', () => {
  const manifest = readGoldenManifest();
  assert.equal(manifest.engines.pi.pinnedVersion, RELEASE_TERMINAL_RUNTIME.pi.displayVersion);
  assert.equal(manifest.engines.opencode.pinnedVersion, RELEASE_TERMINAL_RUNTIME.opencode.displayVersion);

  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, new RegExp(`@earendil-works/pi-coding-agent@${RELEASE_TERMINAL_RUNTIME.pi.version.replaceAll('.', '\\.')}`));
  assert.match(dockerfile, new RegExp(`opencode-ai@${RELEASE_TERMINAL_RUNTIME.opencode.version.replaceAll('.', '\\.')}`));
  const platformVerifier = fs.readFileSync(path.join(repositoryRoot, 'scripts/verify-real-platform-boundaries.mjs'), 'utf8');
  assert.match(platformVerifier, new RegExp(`pi: '${RELEASE_TERMINAL_RUNTIME.pi.version.replaceAll('.', '\\.')}'`));
  assert.match(platformVerifier, new RegExp(`opencode: '${RELEASE_TERMINAL_RUNTIME.opencode.version.replaceAll('.', '\\.')}'`));

  const piMeta = JSON.parse(loadGoldenFixture('pi').directBytes.toString('utf8').split('\n', 1)[0]);
  const openCodeMeta = JSON.parse(fs.readFileSync(loadGoldenFixture('opencode').fixtureAbsolutePath, 'utf8'));
  for (const metadata of [piMeta, openCodeMeta]) {
    assert.equal(metadata.evidenceClass, 'non-release-fixture-replay');
    assert.equal(metadata.actualProviderCapture, false);
  }
});
