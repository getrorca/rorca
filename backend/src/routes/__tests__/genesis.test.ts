/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createGenesisRouter } from '../genesis';
import type { GenesisAuthorityBridge, GenesisBridgeProjection } from '../../lib/source-adapters/genesis';

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
      contentHash: digest(chunks.map((chunk) => chunk.content).join('\n\n')),
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

function appWith(bridge: GenesisAuthorityBridge) {
  const app = express();
  app.use(express.json());
  app.use('/api/genesis', createGenesisRouter(bridge));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message, code: error.code });
  });
  return app;
}

test('resolves a genesis_package projection with a principal identity', async () => {
  const calls: Array<{ kind: string; id: string; principalId: string }> = [];
  const bridge: GenesisAuthorityBridge = {
    resolveSource: async (input) => {
      calls.push({ ...input });
      return projection();
    },
  };
  const response = await request(appWith(bridge))
    .get('/api/genesis/sources/genesis_package/GEN-PKG-1')
    .query({ principalId: 'principal-reviewer' });

  expect(response.status).toBe(200);
  expect(calls).toEqual([{ kind: 'genesis_package', id: 'GEN-PKG-1', principalId: 'principal-reviewer' }]);
  expect(response.body.sourceRef.reviewStatus).toBe('approved');
  expect(response.body.sourceRef.authority).toBe('approved_context');
  expect(response.body.sections).toHaveLength(2);
  expect(response.body.compiledText).toContain('Require signed delivery evidence.');
  expect(response.body.genesis.evidenceChunkIds).toEqual(['chunk-control', 'chunk-review']);
});

test('passes a bounded selectedChunkIds subset to the bridge', async () => {
  let selected: string[] | undefined;
  const bridge: GenesisAuthorityBridge = {
    resolveSource: async (input) => {
      selected = (input as { selectedChunkIds?: string[] }).selectedChunkIds;
      return projection();
    },
  };
  const response = await request(appWith(bridge))
    .get('/api/genesis/sources/genesis_package/GEN-PKG-1')
    .query({ principalId: 'principal-reviewer', selectedChunkIds: ['chunk-control,chunk-review'] });

  expect(response.status).toBe(200);
  expect(selected).toEqual(['chunk-control', 'chunk-review']);
});

test('restricted chunk content never reaches the endpoint body', async () => {
  const secret = 'raw restricted deployment credential';
  const bridge = bridgeReturning(projection({
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
  }));
  const response = await request(appWith(bridge))
    .get('/api/genesis/sources/genesis_package/GEN-PKG-1')
    .query({ principalId: 'principal-reviewer' });

  expect(response.status).toBe(200);
  expect(response.body.compiledText).toContain('[REDACTED: Genesis sensitivity authority required]');
  expect(JSON.stringify(response.body)).not.toContain(secret);
  expect(response.body.sections[0].redacted).toBe(true);
});

test('requires an explicit principal identity', async () => {
  let bridgeCalled = false;
  const bridge: GenesisAuthorityBridge = {
    resolveSource: async () => {
      bridgeCalled = true;
      return projection();
    },
  };
  const response = await request(appWith(bridge))
    .get('/api/genesis/sources/genesis_package/GEN-PKG-1');

  expect(response.status).toBe(400);
  expect(response.body.code).toBe('VALIDATION_ERROR');
  expect(bridgeCalled).toBe(false);
});

test('maps an unknown source to 404', async () => {
  const response = await request(appWith(bridgeReturning(undefined)))
    .get('/api/genesis/sources/genesis_package/GEN-PKG-MISSING')
    .query({ principalId: 'principal-reviewer' });

  expect(response.status).toBe(404);
  expect(response.body.code).toBe('NOT_FOUND');
  expect(response.body.error).toContain('GEN-PKG-MISSING');
});

test('rejects an invalid kind before bridge access', async () => {
  let bridgeCalled = false;
  const bridge: GenesisAuthorityBridge = {
    resolveSource: async () => {
      bridgeCalled = true;
      return projection();
    },
  };
  const response = await request(appWith(bridge))
    .get('/api/genesis/sources/forged_kind/GEN-PKG-1')
    .query({ principalId: 'principal-reviewer' });

  expect(response.status).toBe(400);
  expect(response.body.code).toBe('VALIDATION_ERROR');
  expect(bridgeCalled).toBe(false);
});
