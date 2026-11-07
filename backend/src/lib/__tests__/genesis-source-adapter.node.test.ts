/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ValidationError } from '../errors';
import {
  GENESIS_REDACTION_MARKER,
  GenesisProvenanceSchema,
  resolveGenesisSource,
  type GenesisAuthorityBridge,
  type GenesisBridgeProjection,
} from '../source-adapters/genesis';
import { SourceCitationV1Schema, SourceRefV1Schema } from '../source-contracts';

const digest = (value: string) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

function projection(overrides: Partial<GenesisBridgeProjection> = {}): GenesisBridgeProjection {
  const chunks = overrides.chunks ?? [
    {
      chunkId: 'chunk-control',
      evidence: { genesisEvidenceId: 'GEN-101', sourceTitle: 'Delivery Control', exactCitation: 'Genesis Control §4.1', evidenceStrength: 'primary' },
      bridgeProvenance: { source: 'genesis-bridge', reviewStatus: 'approved', access: 'allowed' },
      sensitivity: 'internal',
      content: 'Require signed delivery evidence.',
    },
    {
      chunkId: 'chunk-review',
      evidence: { genesisEvidenceId: 'GEN-102', sourceTitle: 'Review Control', exactCitation: 'Genesis Review §2.3', evidenceStrength: 'primary' },
      bridgeProvenance: { source: 'genesis-bridge', reviewStatus: 'approved', access: 'allowed' },
      sensitivity: 'internal',
      content: 'Approval requires independent review.',
    },
  ];
  const compiled = chunks.map((chunk) => chunk.bridgeProvenance.access === 'allowed' ? chunk.content : '').join('\n\n');
  return {
    kind: 'genesis_package',
    id: 'GEN-PKG-1',
    title: 'Approved delivery controls',
    sourceVersion: 'revision-7',
    reviewStatus: 'approved',
    sensitivity: 'internal',
    chunks,
    provenance: {
      packageId: 'GEN-PKG-1',
      packageHash: digest('immutable package envelope'),
      contentHash: digest(compiled),
      canonicalStore: 'pglite+pgvector+genesis-vault',
      citationSummary: '2 bridge-selected evidence chunks',
      warningCount: 0,
      skippedEvidenceCount: 0,
      freshnessTs: '2026-03-16T00:00:00.000Z',
      bridgeVersion: 'genesis-bridge.v1',
    },
    ...overrides,
  };
}

function bridgeReturning(value: unknown): GenesisAuthorityBridge {
  return { resolveSource: async () => value };
}

const request = { kind: 'genesis_package' as const, id: 'GEN-PKG-1', principalId: 'principal-reviewer' };

test('approved package preserves bridge approval, exact chunks, citations, and complete hashes', async () => {
  const result = await resolveGenesisSource(request, bridgeReturning(projection()));

  assert.equal(result.sourceRef.reviewStatus, 'approved');
  assert.equal(result.sourceRef.authority, 'approved_context');
  assert.match(result.sourceRef.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.genesis.packageHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.genesis.contentHash, result.sourceRef.contentHash);
  assert.deepEqual(result.sourceRef.selectedSections, ['chunk-control', 'chunk-review']);
  assert.deepEqual(result.genesis.evidenceChunkIds, ['chunk-control', 'chunk-review']);
  assert.deepEqual(result.genesis.evidenceProvenance[0], {
    genesisEvidenceId: 'GEN-101',
    sourceTitle: 'Delivery Control',
    exactCitation: 'Genesis Control §4.1',
    evidenceStrength: 'primary',
    bridgeProvenance: { source: 'genesis-bridge', reviewStatus: 'approved', access: 'allowed' },
  });
  assert.doesNotThrow(() => SourceRefV1Schema.parse(result.sourceRef));
  assert.doesNotThrow(() => GenesisProvenanceSchema.parse(result.genesis));
  result.citations.forEach((citation) => assert.doesNotThrow(() => SourceCitationV1Schema.parse(citation)));
});

test('pending and unreviewed projections are never promoted to approved', async () => {
  for (const reviewStatus of ['pending', 'unreviewed'] as const) {
    const result = await resolveGenesisSource(request, bridgeReturning(projection({ reviewStatus })));
    assert.equal(result.sourceRef.reviewStatus, reviewStatus);
    assert.equal(result.sourceRef.authority, 'supporting_evidence');
    assert.equal(result.genesis.reviewStatus, reviewStatus);
  }
});

test('bridge cannot promote a package containing pending evidence to approved context', async () => {
  const pendingChunk = {
    ...projection().chunks[0],
    bridgeProvenance: { source: 'genesis-bridge' as const, reviewStatus: 'pending' as const, access: 'allowed' as const },
  };
  const promoted = projection({ chunks: [pendingChunk] });

  await assert.rejects(
    resolveGenesisSource(request, bridgeReturning(promoted)),
    (error: unknown) => error instanceof ValidationError && /pending or unreviewed evidence as approved/.test(error.message),
  );
});

test('missing package fails closed', async () => {
  await assert.rejects(
    resolveGenesisSource(request, bridgeReturning(undefined)),
    (error: unknown) => error instanceof ValidationError && /GEN-PKG-1.*not found/.test(error.message),
  );
});

test('restricted bridge projection emits only a visible redaction marker', async () => {
  const secret = 'raw restricted deployment credential';
  const restricted = projection({
    sensitivity: 'restricted',
    chunks: [{
      chunkId: 'chunk-secret',
      evidence: { genesisEvidenceId: 'GEN-SECRET-9', sourceTitle: 'Restricted Vault Item', exactCitation: 'Genesis Vault restricted item 9', evidenceStrength: 'primary' },
      bridgeProvenance: { source: 'genesis-bridge', reviewStatus: 'approved', access: 'denied' },
      sensitivity: 'restricted',
      content: null,
    }],
    provenance: {
      ...projection().provenance,
      contentHash: digest(secret),
      citationSummary: '1 restricted evidence chunk redacted by bridge',
      skippedEvidenceCount: 1,
    },
  });
  const result = await resolveGenesisSource(request, bridgeReturning(restricted));

  assert.match(result.compiledText, new RegExp(GENESIS_REDACTION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(result.compiledText.includes(secret), false);
  assert.equal(result.sections[0].content.includes(secret), false);
  assert.equal(result.sections[0].redacted, true);
  assert.equal(result.sourceRef.sensitivity, 'restricted');
});

test('bridge projection cannot understate restricted evidence sensitivity', async () => {
  const restrictedChunk = {
    ...projection().chunks[0],
    sensitivity: 'restricted' as const,
    bridgeProvenance: { source: 'genesis-bridge' as const, reviewStatus: 'approved' as const, access: 'denied' as const },
    content: null,
  };

  await assert.rejects(
    resolveGenesisSource(request, bridgeReturning(projection({ sensitivity: 'public', chunks: [restrictedChunk] }))),
    (error: unknown) => error instanceof ValidationError && /understates its evidence sensitivity/.test(error.message),
  );
});

test('caller cannot locally promote review state or request a sensitivity exception', async () => {
  let bridgeCalled = false;
  const bridge: GenesisAuthorityBridge = {
    resolveSource: async () => {
      bridgeCalled = true;
      return projection();
    },
  };
  const forged = {
    ...request,
    reviewStatus: 'approved',
    sensitivityOverride: 'public',
  };

  await assert.rejects(
    resolveGenesisSource(forged, bridge),
    (error: unknown) => error instanceof ValidationError && /Invalid Genesis source request/.test(error.message),
  );
  assert.equal(bridgeCalled, false, 'invalid local authority fields must be rejected before bridge access');
});
