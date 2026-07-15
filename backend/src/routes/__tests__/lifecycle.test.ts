/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';

const mockPortfolio = jest.fn();
const mockSpec = jest.fn();
const mockPhase = jest.fn();
const mockEvidence = jest.fn();
const mockLearnCloseout = jest.fn();
const mockLifecycleInvalidation = jest.fn();

jest.mock('../../lib/learn-closeout', () => ({
  generateLearnCloseoutCandidates: (...args: unknown[]) => mockLearnCloseout(...args),
}));
jest.mock('../../lib/lifecycle-mutations', () => ({
  emitLifecycleInvalidation: (...args: unknown[]) => mockLifecycleInvalidation(...args),
}));

jest.mock('../../lib/ssdlc-lifecycle-read', () => {
  const actual = jest.requireActual('../../lib/ssdlc-lifecycle-read');
  return {
    ...actual,
    getLifecyclePortfolio: (...args: unknown[]) => mockPortfolio(...args),
    getLifecycleSpec: (...args: unknown[]) => mockSpec(...args),
    getLifecyclePhase: (...args: unknown[]) => mockPhase(...args),
    getLifecycleEvidence: (...args: unknown[]) => mockEvidence(...args),
  };
});

import lifecycleRouter from '../lifecycle';
import { ConflictError, NotFoundError } from '../../lib/errors';
import { errorHandler } from '../../lib/error-handler';

function app() {
  const instance = express();
  instance.use('/api/lifecycle', lifecycleRouter);
  instance.use(errorHandler);
  return instance;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPortfolio.mockResolvedValue({ items: [], total: 0, hasMore: false, snapshotId: `sha256:${'a'.repeat(64)}` });
  mockSpec.mockResolvedValue({ specId: 'safe-spec' });
  mockPhase.mockResolvedValue({ specId: 'safe-spec', phaseId: 'qa', evidence: { items: [], total: 0, hasMore: false } });
  mockEvidence.mockResolvedValue({ id: '7', rawReference: { accessTier: 'auth', rawPayloadIncluded: false } });
  mockLearnCloseout.mockResolvedValue({ status: 'generated', candidateIds: [91] });
  mockLifecycleInvalidation.mockResolvedValue(undefined);
});

describe('lifecycle aggregate read routes', () => {
  test('reads a bounded portfolio with validated filters and canonical pagination', async () => {
    const response = await request(app()).get('/api/lifecycle?workspaceId=ws-a&phase=qa&blocked=true&limit=20');

    expect(response.status).toBe(200);
    expect(mockPortfolio).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-a',
      phase: 'qa',
      blocked: true,
      pagination: expect.objectContaining({ limit: 20 }),
    }));
  });

  test('rejects invalid filters and pagination before calling the store', async () => {
    const [filterResponse, pageResponse] = await Promise.all([
      request(app()).get('/api/lifecycle?workspaceId=ws-a&phase=frontend'),
      request(app()).get('/api/lifecycle?workspaceId=ws-a&limit=101'),
    ]);

    expect(filterResponse.status).toBe(400);
    expect(pageResponse.status).toBe(400);
    expect(mockPortfolio).not.toHaveBeenCalled();
  });

  test('keeps evidence in the static namespace and pins it to the caller snapshot', async () => {
    const snapshotId = `sha256:${'a'.repeat(64)}`;
    const response = await request(app()).get(`/api/lifecycle/evidence/7?workspaceId=ws-a&snapshotId=${snapshotId}`);

    expect(response.status).toBe(200);
    expect(mockEvidence).toHaveBeenCalledWith({ workspaceId: 'ws-a', evidenceId: '7', expectedSnapshotId: snapshotId });
    expect(mockSpec).not.toHaveBeenCalled();
    expect(mockPhase).not.toHaveBeenCalled();
  });

  test('routes spec and phase detail through distinct explicit paths', async () => {
    const specResponse = await request(app()).get('/api/lifecycle/specs/safe-spec?workspaceId=ws-a');
    const phaseResponse = await request(app()).get('/api/lifecycle/specs/safe-spec/phases/qa?workspaceId=ws-a&limit=10');

    expect(specResponse.status).toBe(200);
    expect(phaseResponse.status).toBe(200);
    expect(mockSpec).toHaveBeenCalledWith({ workspaceId: 'ws-a', specId: 'safe-spec', expectedSnapshotId: undefined });
    expect(mockPhase).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-a',
      specId: 'safe-spec',
      phaseId: 'qa',
      evidencePagination: expect.objectContaining({ limit: 10 }),
    }));
  });

  test('rejects frontend-supplied unknown phase state and malformed snapshots', async () => {
    const unknownPhase = await request(app()).get('/api/lifecycle/specs/safe-spec/phases/evidence?workspaceId=ws-a');
    const badSnapshot = await request(app()).get('/api/lifecycle/specs/safe-spec?workspaceId=ws-a&snapshotId=latest');

    expect(unknownPhase.status).toBe(400);
    expect(badSnapshot.status).toBe(400);
    expect(mockPhase).not.toHaveBeenCalled();
    expect(mockSpec).not.toHaveBeenCalled();
  });

  test('returns typed refresh-required conflicts without mixing snapshots', async () => {
    mockSpec.mockRejectedValueOnce(new ConflictError('Lifecycle evaluation snapshot is stale; refresh before acting', {
      type: 'refresh_required',
      requestedSnapshotId: `sha256:${'a'.repeat(64)}`,
      currentSnapshotId: `sha256:${'b'.repeat(64)}`,
    }));

    const response = await request(app()).get(`/api/lifecycle/specs/safe-spec?workspaceId=ws-a&snapshotId=sha256:${'a'.repeat(64)}`);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CONFLICT');
    expect(response.body.details.type).toBe('refresh_required');
  });

  test('a ledger write between portfolio, detail, and evidence reads requires one full refresh', async () => {
    const portfolioSnapshot = `sha256:${'a'.repeat(64)}`;
    let currentSnapshot = portfolioSnapshot;
    const readAtSnapshot = (expectedSnapshotId: string | undefined, value: Record<string, unknown>) => {
      if (expectedSnapshotId && expectedSnapshotId !== currentSnapshot) {
        throw new ConflictError('Lifecycle evaluation snapshot is stale; refresh before acting', {
          type: 'refresh_required',
          requestedSnapshotId: expectedSnapshotId,
          currentSnapshotId: currentSnapshot,
        });
      }
      return { ...value, snapshotId: currentSnapshot };
    };
    mockPortfolio.mockImplementation(async () => readAtSnapshot(undefined, { items: [], total: 0, hasMore: false }));
    mockSpec.mockImplementation(async ({ expectedSnapshotId }: { expectedSnapshotId?: string }) => readAtSnapshot(expectedSnapshotId, { specId: 'safe-spec' }));
    mockEvidence.mockImplementation(async ({ expectedSnapshotId }: { expectedSnapshotId?: string }) => readAtSnapshot(expectedSnapshotId, { id: '7' }));

    const portfolio = await request(app()).get('/api/lifecycle?workspaceId=ws-a');
    expect(portfolio.status).toBe(200);
    expect(portfolio.body.snapshotId).toBe(portfolioSnapshot);

    // Deterministic write fixture: a new immutable ledger row advances the bounded snapshot.
    currentSnapshot = `sha256:${'b'.repeat(64)}`;
    const [detail, evidence] = await Promise.all([
      request(app()).get(`/api/lifecycle/specs/safe-spec?workspaceId=ws-a&snapshotId=${portfolioSnapshot}`),
      request(app()).get(`/api/lifecycle/evidence/7?workspaceId=ws-a&snapshotId=${portfolioSnapshot}`),
    ]);

    expect([detail.status, evidence.status]).toEqual([409, 409]);
    expect(detail.body.details).toMatchObject({ type: 'refresh_required', currentSnapshotId: currentSnapshot });
    expect(evidence.body.details).toMatchObject({ type: 'refresh_required', currentSnapshotId: currentSnapshot });
  });

  test('retries Learn closeout through the workspace/spec/run scoped producer', async () => {
    const response = await request(app())
      .post('/api/lifecycle/specs/safe-spec/runs/42/learn-closeout?workspaceId=ws-a')
      .send({ modelSummarization: true });

    expect(response.status).toBe(200);
    expect(mockLearnCloseout).toHaveBeenCalledWith({
      workspaceId: 'ws-a', specId: 'safe-spec', runId: 42, modelSummarization: true,
    });
    expect(mockLifecycleInvalidation).toHaveBeenCalledWith({
      workspaceId: 'ws-a', specId: 'safe-spec', phaseId: 'learn', runId: 42, changeKind: 'evidence_persisted',
    });
  });

  test('denies a run that is not owned by the requested workspace', async () => {
    mockLearnCloseout.mockRejectedValueOnce(new NotFoundError('Pipeline run', '42'));
    const response = await request(app())
      .post('/api/lifecycle/specs/safe-spec/runs/42/learn-closeout?workspaceId=ws-b')
      .send({});

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  test('requires workspace scope on every aggregate route', async () => {
    const responses = await Promise.all([
      request(app()).get('/api/lifecycle'),
      request(app()).get('/api/lifecycle/specs/safe-spec'),
      request(app()).get('/api/lifecycle/specs/safe-spec/phases/qa'),
      request(app()).get('/api/lifecycle/evidence/7'),
    ]);

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400]);
    expect(mockPortfolio).not.toHaveBeenCalled();
    expect(mockSpec).not.toHaveBeenCalled();
    expect(mockPhase).not.toHaveBeenCalled();
    expect(mockEvidence).not.toHaveBeenCalled();
  });
});
