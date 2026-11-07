/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveLocalFileSource } from '../local-file-source-adapter';
import { compileSourceBundle } from '../source-compiler';
import { assertEvidenceCurrent, inspectSourceDrift, recompileSourceRevision } from '../source-drift';
import type { SourceBundleV1 } from '../source-contracts';

const hash = (value: string): `sha256:${string}` => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const workspaceRef = { schemaVersion: 'rorca.entity-ref.v1' as const, workspaceId: 'workspace-1', kind: 'workspace' as const,
  id: 'workspace-1', label: 'Workspace 1' };

async function frozenLocalBundle(root: string, content = '# Brief\nShip safely.'): Promise<SourceBundleV1> {
  await writeFile(path.join(root, 'brief.md'), content);
  const local = await resolveLocalFileSource(root, 'brief.md');
  return (await compileSourceBundle({ userIntent: 'Ship safely.', workspaceRef, compiledAt: '2026-03-16T00:00:00Z',
    sources: [{ sourceRef: local.sourceRef, sections: local.sections.map(({ heading, content: text }) => ({ section: heading, content: text })) }] })).bundle;
}

test('unchanged frozen local source reports fresh with exact matching hashes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rorca-drift-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = await frozenLocalBundle(root);
  const before = structuredClone(bundle);
  const report = await inspectSourceDrift(bundle, { workspaceRoot: root, checkedAt: '2026-03-16T00:01:00Z' });
  assert.equal(report.contextState, 'fresh'); assert.equal(report.stale, false);
  assert.equal(report.sources[0].state, 'unchanged'); assert.equal(report.sources[0].oldHash, report.sources[0].newHash);
  assert.deepEqual(bundle, before);
});

test('changed frozen local source reports stale and exact old/new hashes without swapping frozen content', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rorca-drift-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = await frozenLocalBundle(root);
  await writeFile(path.join(root, 'brief.md'), '# Brief\nShip differently.');
  const report = await inspectSourceDrift(bundle, { workspaceRoot: root });
  const live = await resolveLocalFileSource(root, 'brief.md');
  assert.equal(report.contextState, 'stale'); assert.equal(report.stale, true); assert.equal(report.sources[0].state, 'changed');
  assert.equal(report.sources[0].oldHash, bundle.includedSources[0].contentHash);
  assert.equal(report.sources[0].newHash, live.sourceRef.contentHash);
  assert.notEqual(report.sources[0].newHash, report.sources[0].oldHash);
});

test('deleted, unavailable, and unknown are distinct honest source states', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rorca-drift-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = await frozenLocalBundle(root); await unlink(path.join(root, 'brief.md'));
  const deleted = await inspectSourceDrift(bundle, { workspaceRoot: root });
  assert.equal(deleted.contextState, 'stale'); assert.equal(deleted.sources[0].state, 'deleted'); assert.equal(deleted.sources[0].newHash, null);

  const unavailable = await inspectSourceDrift(bundle, { workspaceRoot: root, probes: { local_file: async () => { throw new Error('offline'); } } });
  assert.equal(unavailable.contextState, 'unavailable'); assert.equal(unavailable.sources[0].state, 'unavailable');

  const inlineBundle = await compileSourceBundle({ userIntent: 'Ship safely.', workspaceRef, sources: [{ sourceRef: {
    schemaVersion: 'rorca.source-ref.v1', sourceId: 'inline-1', kind: 'inline', locator: 'intent/inline-1', title: 'Brief',
    contentHash: hash('Ship safely.'), sourceVersion: '1', reviewStatus: 'approved', sensitivity: 'internal',
    authority: 'user_mandated', selectedSections: ['Document'] }, sections: [{ section: 'Document', content: 'Ship safely.' }] }] });
  const unknown = await inspectSourceDrift(inlineBundle.bundle, { workspaceRoot: root });
  assert.equal(unknown.contextState, 'unknown'); assert.equal(unknown.sources[0].state, 'unknown');
});

test('recompilation creates new bundle/revision/profile receipt and leaves execution pending re-review', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rorca-drift-')); t.after(() => rm(root, { recursive: true, force: true }));
  const previousBundle = await frozenLocalBundle(root); await writeFile(path.join(root, 'brief.md'), '# Brief\nShip differently.');
  const drift = await inspectSourceDrift(previousBundle, { workspaceRoot: root });
  const live = await resolveLocalFileSource(root, 'brief.md');
  const previousReceipt = hash('profile-v1'); const nextReceipt = hash('profile-v2');
  const result = await recompileSourceRevision({ previousBundle, drift,
    previousSpecRevision: { kind: 'spec_version', value: '1' }, nextSpecRevision: { kind: 'spec_version', value: '2' },
    previousAssuranceCompilationReceiptHash: previousReceipt,
    compilation: { userIntent: 'Ship safely.', workspaceRef, compiledAt: '2026-03-16T00:02:00Z',
      sources: [{ sourceRef: live.sourceRef, sections: live.sections.map(({ heading, content }) => ({ section: heading, content })) }] },
    compileAssurance: ({ bundle, specRevision }) => {
      assert.equal(bundle.includedSources[0].contentHash, live.sourceRef.contentHash); assert.equal(specRevision.value, '2');
      return { compilationReceiptHash: nextReceipt };
    } });
  assert.notEqual(result.current.bundleHash, previousBundle.bundleHash); assert.equal(result.current.specRevision.value, '2');
  assert.equal(result.current.assuranceCompilationReceiptHash, nextReceipt); assert.equal(result.priorProfileApplies, false);
  assert.equal(result.reviewState, 'pending_re_review'); assert.equal(result.executionAffected, false);
});

test('prior profile receipt and stale evidence cannot satisfy the changed revision', () => {
  const oldEvidence = { specRevision: { kind: 'spec_version' as const, value: '1' }, sourceBundleHash: hash('bundle-v1'), assuranceCompilationReceiptHash: hash('profile-v1') };
  const current = { specRevision: { kind: 'spec_version' as const, value: '2' }, sourceBundleHash: hash('bundle-v2'), assuranceCompilationReceiptHash: hash('profile-v2') };
  assert.throws(() => assertEvidenceCurrent(oldEvidence, current), (error: unknown) =>
    error instanceof Error && error.message.includes('stale source/spec/assurance revision'));
  assert.doesNotThrow(() => assertEvidenceCurrent(current, current));
});
