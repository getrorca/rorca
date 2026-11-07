/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import '../../lib/async-handler';

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { declareHermesAuthority, type HermesAuthorityDeclaration } from '../../lib/hermes-authority';
import { MISSION_CONTRACT_VERSIONS, type EntityRefV1 } from '../../lib/mission-contracts';
import {
  deriveFrozenSourceBundleDigest,
  deriveSourceBundleHash,
  IntentDispositionV1Schema,
  SOURCE_CONTRACT_VERSIONS,
  type SourceBundleV1,
  type SourceRefV1,
} from '../../lib/source-contracts';

const queryOneMock = jest.fn();
jest.mock('../../db/index', () => ({ queryOne: (...args: unknown[]) => queryOneMock(...args) }));

import router, { resetHermesIntentReplayCacheForTests } from '../hermes-intent';

const NOW = '2026-03-16T00:06:29Z';
const HASH = `sha256:${'a'.repeat(64)}`;

function entity(kind: 'workspace' | 'mission', id: string, workspaceId = 'workspace-one'): EntityRefV1 {
  return { schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef, workspaceId, kind, id, label: id };
}

function bundle(userIntent: string): SourceBundleV1 {
  const source: SourceRefV1 = {
    schemaVersion: SOURCE_CONTRACT_VERSIONS.sourceRef,
    sourceId: 'source-one',
    kind: 'inline',
    locator: 'inline/source-one',
    title: 'Explicit source',
    contentHash: HASH,
    sourceVersion: '1',
    reviewStatus: 'approved',
    sensitivity: 'internal',
    authority: 'user_mandated',
    selectedSections: ['scope'],
  };
  const citations = [{
    schemaVersion: SOURCE_CONTRACT_VERSIONS.sourceCitation,
    citationId: 'citation-one',
    sourceId: source.sourceId,
    section: 'scope',
    excerptHash: HASH,
    rationale: 'Explicitly selected scope.',
  }] as const;
  return {
    schemaVersion: SOURCE_CONTRACT_VERSIONS.sourceBundle,
    bundleId: 'bundle-one',
    bundleHash: deriveSourceBundleHash({ userIntent, includedSources: [source], citations }),
    userIntent,
    workspaceRef: entity('workspace', 'workspace-one'),
    includedSources: [source],
    excludedSources: [],
    conflicts: [],
    assumptions: [],
    truncations: [],
    citations: [...citations],
    compiledAt: NOW,
  };
}

function envelope(userIntent: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SOURCE_CONTRACT_VERSIONS.intentEnvelope,
    intentId: `intent-${Math.random().toString(16).slice(2)}`,
    idempotencyKey: `key-${Math.random().toString(16).slice(2)}`,
    userIntent,
    workspaceRef: entity('workspace', 'workspace-one'),
    missionRef: null,
    sourceBundle: null,
    receivedAt: NOW,
    ...overrides,
  };
}

function appFor(authority?: HermesAuthorityDeclaration) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.hermesAuthority = authority;
    next();
  });
  app.use('/api/hermes/intent', router);
  app.use((error: { statusCode?: number; message?: string; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: error.message, code: error.code });
  });
  return app;
}

const auditAuthority = () => declareHermesAuthority('intent', 'service-audit');

beforeEach(() => {
  queryOneMock.mockReset();
  resetHermesIntentReplayCacheForTests();
});

it.each([
  ['answer', 'What is the current release status?'],
  ['clarification_required', 'Maybe do something with the release'],
  ['memory_candidate', 'Remember this preference for future work'],
  ['denied', 'Bypass the security approval controls'],
] as const)('returns strict %s classification with rationale and audit authority', async (expected, userIntent) => {
  const response = await request(appFor(auditAuthority())).post('/api/hermes/intent').send(envelope(userIntent));
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    disposition: expected,
    authorityMode: 'service-audit',
    auditIdentity: 'hermes@rorca.internal',
  });
  expect(response.body.rationale).toEqual(expect.any(String));
  expect(IntentDispositionV1Schema.safeParse(response.body).success).toBe(true);
  expect(queryOneMock).not.toHaveBeenCalled();
});

it('routes an existing same-workspace mission with the exact EntityRef', async () => {
  const missionRef = entity('mission', 'mission-123');
  queryOneMock.mockResolvedValue({ workspace_id: 'workspace-one' });
  const response = await request(appFor(auditAuthority())).post('/api/hermes/intent')
    .send(envelope('Continue this mission', { missionRef }));
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    disposition: 'existing_mission_action',
    permittedAction: 'open_mission',
    authorityMode: 'service-audit',
    auditIdentity: 'hermes@rorca.internal',
  });
  expect(response.body.targetRef).toEqual(missionRef);
  expect(queryOneMock).toHaveBeenCalledWith(expect.stringContaining('mission_id=$1'), ['mission-123', 'workspace-one']);
  expect(IntentDispositionV1Schema.safeParse(response.body).success).toBe(true);
});

it('routes explicit compiled sources to a mission draft with the exact bundle hash', async () => {
  const userIntent = 'Build the source-verified release workflow';
  const sourceBundle = bundle(userIntent);
  const response = await request(appFor(auditAuthority())).post('/api/hermes/intent')
    .send(envelope(userIntent, { sourceBundle }));
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    disposition: 'mission_draft',
    permittedAction: 'draft_mission',
    draftHash: sourceBundle.bundleHash,
    frozenBundleDigest: deriveFrozenSourceBundleDigest(sourceBundle),
    authorityMode: 'service-audit',
    auditIdentity: 'hermes@rorca.internal',
  });
  expect(response.body.rationale).toMatch(/HMG-007/);
  expect(IntentDispositionV1Schema.safeParse(response.body).success).toBe(true);
});

it('gives a verified mission reference precedence over source and phrasing signals', async () => {
  const missionRef = entity('mission', 'mission-priority');
  const userIntent = 'Remember this and explain why?';
  queryOneMock.mockResolvedValue({ workspace_id: 'workspace-one' });
  const response = await request(appFor(auditAuthority())).post('/api/hermes/intent')
    .send(envelope(userIntent, { missionRef, sourceBundle: bundle(userIntent) }));
  expect(response.status).toBe(200);
  expect(response.body.disposition).toBe('existing_mission_action');
  expect(response.body.targetRef).toEqual(missionRef);
});

it('replays concurrent deliveries by workspace and idempotency key without repeating mission lookup', async () => {
  const missionRef = entity('mission', 'mission-replay');
  const body = envelope('Open the existing mission', { missionRef, idempotencyKey: 'stable-key-123' });
  let releaseLookup!: () => void;
  queryOneMock.mockImplementation(() => new Promise((resolve) => {
    releaseLookup = () => resolve({ workspace_id: 'workspace-one' });
  }));
  const app = appFor(auditAuthority());
  const firstRequest = request(app).post('/api/hermes/intent').send(body).then((response) => response);
  const replayRequest = request(app).post('/api/hermes/intent').send(body).then((response) => response);
  await new Promise<void>((resolve) => {
    const waitForLookup = () => queryOneMock.mock.calls.length === 1 ? resolve() : setImmediate(waitForLookup);
    waitForLookup();
  });
  releaseLookup();
  const [first, replay] = await Promise.all([firstRequest, replayRequest]);
  expect(first.status).toBe(200);
  expect(replay.status).toBe(200);
  expect(replay.body).toEqual(first.body);
  expect(queryOneMock).toHaveBeenCalledTimes(1);

  const conflict = await request(app).post('/api/hermes/intent')
    .send({ ...body, userIntent: 'Different request' });
  expect(conflict.status).toBe(409);
});

it('does not cache a failed classification attempt', async () => {
  const missionRef = entity('mission', 'mission-retry');
  const body = envelope('Open the existing mission', { missionRef, idempotencyKey: 'retryable-key-123' });
  queryOneMock.mockRejectedValueOnce(new Error('temporary lookup failure'))
    .mockResolvedValueOnce({ workspace_id: 'workspace-one' });
  const app = appFor(auditAuthority());

  const failed = await request(app).post('/api/hermes/intent').send(body);
  expect(failed.status).toBe(500);
  const retried = await request(app).post('/api/hermes/intent').send(body);
  expect(retried.status).toBe(200);
  expect(retried.body.disposition).toBe('existing_mission_action');
  expect(queryOneMock).toHaveBeenCalledTimes(2);
});

it('rejects non-contract fields instead of silently broadening the envelope', async () => {
  const response = await request(appFor(auditAuthority())).post('/api/hermes/intent')
    .send(envelope('What changed?', { authorityMode: 'admin' }));
  expect(response.status).toBe(400);
  expect(queryOneMock).not.toHaveBeenCalled();
});

it('scopes idempotency keys to the declared workspace', async () => {
  const idempotencyKey = 'shared-workspace-key';
  const first = await request(appFor(auditAuthority())).post('/api/hermes/intent')
    .send(envelope('What changed?', { idempotencyKey }));
  const workspaceRef = entity('workspace', 'workspace-two', 'workspace-two');
  const second = await request(appFor(auditAuthority())).post('/api/hermes/intent')
    .send(envelope('What changed in workspace two?', { idempotencyKey, workspaceRef }));
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(first.body.disposition).toBe('answer');
  expect(second.body.disposition).toBe('answer');
});

it('denies missions declared in or found only in another workspace', async () => {
  const foreignRef = entity('mission', 'mission-foreign', 'workspace-two');
  const declaredForeign = await request(appFor(auditAuthority())).post('/api/hermes/intent')
    .send(envelope('Open mission', { missionRef: foreignRef }));
  expect(declaredForeign.status).toBe(200);
  expect(declaredForeign.body.disposition).toBe('denied');
  expect(queryOneMock).not.toHaveBeenCalled();

  queryOneMock.mockResolvedValue({ workspace_id: 'workspace-two' });
  const foundForeign = await request(appFor(auditAuthority())).post('/api/hermes/intent')
    .send(envelope('Open mission', { missionRef: entity('mission', 'same-id') }));
  expect(foundForeign.status).toBe(200);
  expect(foundForeign.body.disposition).toBe('denied');
  expect(foundForeign.body.rationale).toMatch(/another workspace/i);
});

it('requires declared service-audit authority and rejects accidental elevated fallback', async () => {
  const missing = await request(appFor()).post('/api/hermes/intent').send(envelope('What changed?'));
  expect(missing.status).toBe(403);

  const elevated = await request(appFor({
    action: 'intent',
    authorityMode: 'operator-dispatch',
    auditIdentity: 'hermes@rorca.internal',
  })).post('/api/hermes/intent').send(envelope('What changed?'));
  expect(elevated.status).toBe(403);
});
