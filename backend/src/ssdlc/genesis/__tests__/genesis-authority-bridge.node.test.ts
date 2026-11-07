/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ValidationError } from '../../../lib/errors';
import {
  GENESIS_REDACTION_MARKER,
  resolveGenesisSource,
} from '../../../lib/source-adapters/genesis';
import {
  createGenesisAuthorityBridge,
  registerGenesisPackage,
  type GenesisPackageDefinitionInput,
} from '../genesis-authority-bridge';

const digest = (value: string) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

const SECRET = 'raw restricted deployment credential';

function packageDefinition(overrides: Partial<GenesisPackageDefinitionInput> = {}): GenesisPackageDefinitionInput {
  return {
    id: 'GEN-PKG-1',
    title: 'Approved delivery controls',
    sourceVersion: 'revision-7',
    reviewStatus: 'approved',
    sensitivity: 'restricted',
    canonicalStore: 'pglite+pgvector+genesis-vault',
    citationSummary: '2 bridge-selected evidence chunks',
    warningCount: 0,
    skippedEvidenceCount: 0,
    freshnessTs: '2026-03-16T00:00:00.000Z',
    bridgeVersion: 'genesis-bridge.v1',
    chunks: [
      {
        chunkId: 'chunk-control',
        evidence: { genesisEvidenceId: 'GEN-101', sourceTitle: 'Delivery Control', exactCitation: 'Genesis Control §4.1', evidenceStrength: 'primary' },
        sensitivity: 'internal',
        content: 'Require signed delivery evidence.',
      },
      {
        chunkId: 'chunk-secret',
        evidence: { genesisEvidenceId: 'GEN-SECRET-9', sourceTitle: 'Restricted Vault Item', exactCitation: 'Genesis Vault restricted item 9', evidenceStrength: 'primary' },
        sensitivity: 'restricted',
        content: SECRET,
      },
    ],
    ...overrides,
  };
}

test('production bridge resolves a genesis_package projection through resolveGenesisSource for a cleared principal', async () => {
  const bridge = createGenesisAuthorityBridge({
    packages: [packageDefinition()],
    principalClearance: () => 'restricted',
  });

  const result = await resolveGenesisSource(
    { kind: 'genesis_package', id: 'GEN-PKG-1', principalId: 'principal-reviewer' },
    bridge,
  );

  assert.equal(result.sourceRef.reviewStatus, 'approved');
  assert.equal(result.sourceRef.authority, 'approved_context');
  assert.equal(result.sourceRef.sensitivity, 'restricted');
  assert.equal(result.sourceRef.selectedSections.length, 2);
  // Complete unredacted access: the adapter enforces the bridge content hash
  // against the exact compiled bytes, so these must agree.
  assert.equal(result.genesis.contentHash, result.sourceRef.contentHash);
  assert.equal(result.sourceRef.contentHash, digest('Require signed delivery evidence.\n\n'.concat(SECRET)));
  assert.deepEqual(result.genesis.evidenceChunkIds, ['chunk-control', 'chunk-secret']);
  assert.ok(result.compiledText.includes(SECRET), 'cleared principal reads the vault content');
});

test('production bridge projects only explicitly selected chunks', async () => {
  const bridge = createGenesisAuthorityBridge({
    packages: [packageDefinition()],
    principalClearance: () => 'restricted',
  });

  const projection = await bridge.resolveSource({
    kind: 'genesis_package',
    id: 'GEN-PKG-1',
    principalId: 'principal-reviewer',
    selectedChunkIds: ['chunk-control'],
  }) as { chunks: Array<{ chunkId: string; content: string | null }> };

  assert.deepEqual(projection.chunks.map((chunk) => chunk.chunkId), ['chunk-control']);
  assert.equal(JSON.stringify(projection).includes(SECRET), false);
});

test('restricted chunk content never leaves the bridge or the adapter (redaction marker only)', async () => {
  const bridge = createGenesisAuthorityBridge({
    packages: [packageDefinition()],
    principalClearance: () => 'internal', // below the restricted chunk ceiling
  });

  const projection = await bridge.resolveSource({
    kind: 'genesis_package',
    id: 'GEN-PKG-1',
    principalId: 'principal-reviewer',
  }) as { chunks: Array<{ chunkId: string; content: string | null; bridgeProvenance: { access: string } }> };

  const denied = projection.chunks.find((chunk) => chunk.chunkId === 'chunk-secret');
  assert.ok(denied, 'denied chunk stays present in the projection');
  assert.equal(denied.content, null, 'restricted content never leaves the bridge');
  assert.equal(denied.bridgeProvenance.access, 'denied');

  const result = await resolveGenesisSource(
    { kind: 'genesis_package', id: 'GEN-PKG-1', principalId: 'principal-reviewer' },
    bridge,
  );

  assert.equal(result.sections.length, 2);
  const redacted = result.sections.find((section) => section.chunkId === 'chunk-secret');
  assert.ok(redacted, 'redacted section remains resolvable');
  assert.equal(redacted.redacted, true);
  assert.equal(redacted.content.includes(SECRET), false);
  assert.match(redacted.content, new RegExp(GENESIS_REDACTION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(result.compiledText.includes(SECRET), false);
  assert.ok(result.genesis.evidenceChunkIds.includes('chunk-secret'));
  // The full package hash is bridge-owned provenance; the adapter skips the
  // exact-bytes check for redacted subsets.
  assert.equal(result.genesis.contentHash, digest('Require signed delivery evidence.\n\n'.concat(SECRET)));
});

test('principal clearance is per-principal, not a global projection mode', async () => {
  const cleared = createGenesisAuthorityBridge({
    packages: [packageDefinition()],
    principalClearance: (principalId) => principalId === 'vault-owner' ? 'restricted' : 'public',
  });

  const owner = await resolveGenesisSource(
    { kind: 'genesis_package', id: 'GEN-PKG-1', principalId: 'vault-owner' },
    cleared,
  );
  assert.equal(owner.sections.every((section) => !section.redacted), true);
  assert.ok(owner.compiledText.includes(SECRET));

  const analyst = await resolveGenesisSource(
    { kind: 'genesis_package', id: 'GEN-PKG-1', principalId: 'analyst' },
    cleared,
  );
  assert.equal(analyst.sections.every((section) => section.redacted), true);
  assert.equal(analyst.compiledText.includes(SECRET), false);
  assert.equal(analyst.compiledText.includes(GENESIS_REDACTION_MARKER), true);
});

test('no principal clearance policy denies every chunk without failing resolution', async () => {
  const bridge = createGenesisAuthorityBridge({ packages: [packageDefinition()] });
  const result = await resolveGenesisSource(
    { kind: 'genesis_package', id: 'GEN-PKG-1', principalId: 'untrusted-principal' },
    bridge,
  );
  assert.equal(result.sections.every((section) => section.redacted), true);
  assert.equal(result.compiledText.includes(SECRET), false);
});

test('unknown package and evidence-only requests fail closed through the adapter', async () => {
  const bridge = createGenesisAuthorityBridge({ packages: [packageDefinition()] });

  assert.equal(await bridge.resolveSource({ kind: 'genesis_package', id: 'GEN-PKG-MISSING', principalId: 'p' }), undefined);
  assert.equal(await bridge.resolveSource({ kind: 'genesis_evidence', id: 'GEN-101', principalId: 'p' }), undefined);

  await assert.rejects(
    resolveGenesisSource({ kind: 'genesis_package', id: 'GEN-PKG-MISSING', principalId: 'p' }, bridge),
    (error: unknown) => error instanceof ValidationError && /GEN-PKG-MISSING.*not found/.test(error.message),
  );
  await assert.rejects(
    resolveGenesisSource({ kind: 'genesis_evidence', id: 'GEN-101', principalId: 'p' }, bridge),
    (error: unknown) => error instanceof ValidationError && /GEN-101.*not found/.test(error.message),
  );
});

test('pending packages stay supporting evidence and are never promoted', async () => {
  const bridge = createGenesisAuthorityBridge({
    packages: [packageDefinition({ reviewStatus: 'pending' })],
    principalClearance: () => 'restricted',
  });
  const result = await resolveGenesisSource(
    { kind: 'genesis_package', id: 'GEN-PKG-1', principalId: 'principal-reviewer' },
    bridge,
  );
  assert.equal(result.sourceRef.reviewStatus, 'pending');
  assert.equal(result.sourceRef.authority, 'supporting_evidence');
});

test('existing bridge observes late registration and revocation with bridge-owned clearance', async () => {
  const bridge = createGenesisAuthorityBridge();
  assert.equal(await bridge.resolveSource({
    kind: 'genesis_package', id: 'GEN-PKG-LIVE', principalId: 'principal-reviewer',
  }), undefined);
  const unregister = registerGenesisPackage(
    packageDefinition({ id: 'GEN-PKG-LIVE' }),
    { principalClearance: () => 'restricted' },
  );
  try {
    const result = await resolveGenesisSource(
      { kind: 'genesis_package', id: 'GEN-PKG-LIVE', principalId: 'principal-reviewer' },
      bridge,
    );
    assert.equal(result.sourceRef.sourceId, 'genesis-package-GEN-PKG-LIVE');
    assert.equal(result.sections.every((section) => !section.redacted), true);
  } finally {
    unregister();
  }
  await assert.rejects(
    resolveGenesisSource({ kind: 'genesis_package', id: 'GEN-PKG-LIVE', principalId: 'principal-reviewer' }, bridge),
    (error: unknown) => error instanceof ValidationError && /not found/.test(error.message),
  );
});

test('existing bridge resolves a replacement registration without retaining old content or clearance', async () => {
  const bridge = createGenesisAuthorityBridge();
  const unregister = registerGenesisPackage(
    packageDefinition({ id: 'GEN-PKG-REPLACED' }),
    { principalClearance: () => 'restricted' },
  );
  try {
    const result = await resolveGenesisSource(
      { kind: 'genesis_package', id: 'GEN-PKG-REPLACED', principalId: 'reader' }, bridge,
    );
    assert.ok(result.compiledText.includes(SECRET));
  } finally {
    unregister();
  }
  const unregisterReplacement = registerGenesisPackage(
    packageDefinition({ id: 'GEN-PKG-REPLACED', sourceVersion: 'revision-8' }),
    { principalClearance: () => 'public' },
  );
  try {
    const result = await resolveGenesisSource(
      { kind: 'genesis_package', id: 'GEN-PKG-REPLACED', principalId: 'reader' }, bridge,
    );
    assert.equal(result.sourceRef.sourceVersion, 'revision-8');
    assert.equal(result.compiledText.includes(SECRET), false);
    assert.equal(result.sections.every((section) => section.redacted), true);
  } finally {
    unregisterReplacement();
    unregister();
  }
});

test('late registration cannot shadow a bridge-local authority definition', async () => {
  const bridge = createGenesisAuthorityBridge({
    packages: [packageDefinition({ id: 'GEN-PKG-CONFLICT' })],
    principalClearance: () => 'restricted',
  });
  const unregister = registerGenesisPackage(
    packageDefinition({ id: 'GEN-PKG-CONFLICT' }),
    { principalClearance: () => 'public' },
  );
  try {
    await assert.rejects(bridge.resolveSource({
      kind: 'genesis_package', id: 'GEN-PKG-CONFLICT', principalId: 'reader',
    }), /conflicting authority definitions/);
  } finally {
    unregister();
  }
});

test('bridge registration rejects invalid authority definitions', () => {
  assert.throws(
    () => createGenesisAuthorityBridge({ packages: [
      packageDefinition({ sensitivity: 'internal', chunks: [
        { ...packageDefinition().chunks[0], sensitivity: 'restricted' },
      ] }),
    ] }),
    /understates chunk/,
  );
  assert.throws(
    () => createGenesisAuthorityBridge({ packages: [
      packageDefinition({ chunks: [
        { ...packageDefinition().chunks[0], chunkId: 'same-chunk' },
        { ...packageDefinition().chunks[1], chunkId: 'same-chunk' },
      ] }),
    ] }),
    /duplicate chunk ids/,
  );
  assert.throws(
    () => createGenesisAuthorityBridge({ packages: [packageDefinition(), packageDefinition()] }),
    /unique ids/,
  );
  assert.throws(
    () => createGenesisAuthorityBridge({ packages: [{ ...packageDefinition(), id: 'bad id!' }] }),
    /canonical Genesis id/,
  );
});

test('bridge projections are frozen at every level', async () => {
  const bridge = createGenesisAuthorityBridge({
    packages: [packageDefinition()],
    principalClearance: () => 'restricted',
  });
  const projection = await bridge.resolveSource({ kind: 'genesis_package', id: 'GEN-PKG-1', principalId: 'p' }) as Record<string, unknown>;
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(projection.chunks), true);
  assert.equal(Object.isFrozen(projection.provenance), true);
});
