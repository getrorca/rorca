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
const mockOperations = jest.fn();
const mockEvaluatorError = jest.fn();
const mockQueryOne = jest.fn();
const mockReadSourceArtifact = jest.fn();
const mockOpenSourceArtifact = jest.fn();
const mockResolveGenesisSource = jest.fn();

jest.mock('../../lib/source-adapters/genesis', () => {
  const actual = jest.requireActual('../../lib/source-adapters/genesis');
  return {
    ...actual,
    resolveGenesisSource: (...args: unknown[]) => mockResolveGenesisSource(...args),
  };
});

jest.mock('../../ssdlc/genesis/genesis-authority-bridge', () => ({
  createGenesisAuthorityBridge: () => ({ resolveSource: jest.fn() }),
}));

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));

jest.mock('../../lib/lifecycle-source-material', () => {
  const actual = jest.requireActual('../../lib/lifecycle-source-material');
  return {
    ...actual,
    readLifecycleSourceArtifact: (...args: unknown[]) => mockReadSourceArtifact(...args),
    openLifecycleSourceArtifact: (...args: unknown[]) => mockOpenSourceArtifact(...args),
  };
});

jest.mock('../../lib/lifecycle-operations', () => ({
  getLifecycleOperationsReport: (...args: unknown[]) => mockOperations(...args),
  recordLifecycleEvaluatorError: (...args: unknown[]) => mockEvaluatorError(...args),
}));

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

function app(user: Express.UserShape = {
  id: 'local-admin',
  email: 'admin@rorca.local',
  supabaseId: 'local-auth',
  role: 'admin',
}) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.user = user;
    next();
  });
  instance.use('/api/lifecycle', lifecycleRouter);
  instance.use(errorHandler);
  return instance;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPortfolio.mockResolvedValue({ items: [], total: 0, hasMore: false, snapshotId: `sha256:${'a'.repeat(64)}` });
  mockSpec.mockResolvedValue({ specId: 'safe-spec' });
  mockPhase.mockResolvedValue({ specId: 'safe-spec', phaseId: 'testing', evidence: { items: [], total: 0, hasMore: false } });
  mockEvidence.mockResolvedValue({ id: '7', rawReference: { accessTier: 'auth', rawPayloadIncluded: false } });
  mockLearnCloseout.mockResolvedValue({ status: 'generated', candidateIds: [91] });
  mockLifecycleInvalidation.mockResolvedValue(undefined);
  mockOperations.mockResolvedValue({ schemaVersion: 'lifecycle-operations.v1', rollout: {}, health: {} });
  mockEvaluatorError.mockResolvedValue(undefined);
  mockQueryOne.mockResolvedValue(null);
  mockReadSourceArtifact.mockResolvedValue({
    relativePath: 'requirements.md',
    content: 'bounded source body',
    startLine: 1,
    endLine: 1,
    totalLines: 1,
  });
  mockOpenSourceArtifact.mockResolvedValue({ opened: true, action: 'open', relativePath: 'requirements.md' });
  mockResolveGenesisSource.mockResolvedValue({
    sections: [{ redacted: false }],
    genesis: {
      publicationAuthority: {
        workspaceId: 'ws-a',
        specSlug: 'safe-spec',
        packageId: 'pack-1',
        receiptId: `package-event:sha256:${'c'.repeat(64)}`,
        receiptHash: `sha256:${'d'.repeat(64)}`,
        manifestHash: `sha256:${'e'.repeat(64)}`,
        packageHash: `sha256:${'a'.repeat(64)}`,
        previewHash: `sha256:${'b'.repeat(64)}`,
        snapshotHash: `sha256:${'c'.repeat(64)}`,
        releaseSubjectHash: `sha256:${'f'.repeat(64)}`,
      },
    },
  });
});

describe('lifecycle aggregate read routes', () => {
  test('reads a bounded portfolio with validated filters and canonical pagination', async () => {
    const response = await request(app()).get('/api/lifecycle?workspaceId=ws-a&phase=testing&blocked=true&limit=20');

    expect(response.status).toBe(200);
    expect(mockPortfolio).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-a',
      phase: 'testing',
      blocked: true,
      pagination: expect.objectContaining({ limit: 20 }),
    }));
  });

  test('rejects invalid, legacy phase filters and pagination before calling the store', async () => {
    const [filterResponse, legacyResponse, pageResponse] = await Promise.all([
      request(app()).get('/api/lifecycle?workspaceId=ws-a&phase=frontend'),
      request(app()).get('/api/lifecycle?workspaceId=ws-a&phase=qa'),
      request(app()).get('/api/lifecycle?workspaceId=ws-a&limit=101'),
    ]);

    expect(filterResponse.status).toBe(400);
    expect(legacyResponse.status).toBe(400);
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

  test('reports bounded rollout and health through a distinct read-only operational route', async () => {
    const response = await request(app()).get('/api/lifecycle/operations?workspaceId=ws-a');

    expect(response.status).toBe(200);
    expect(response.body.schemaVersion).toBe('lifecycle-operations.v1');
    expect(mockOperations).toHaveBeenCalledWith({ workspaceId: 'ws-a' });
    expect(mockSpec).not.toHaveBeenCalled();
  });

  test('audits unexpected evaluator failures without replacing the route error', async () => {
    mockPortfolio.mockRejectedValueOnce(new Error('database detail that must not enter metrics'));

    const response = await request(app()).get('/api/lifecycle?workspaceId=ws-a');

    expect(response.status).toBe(500);
    expect(mockEvaluatorError).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-a',
      operation: 'portfolio',
      error: expect.any(Error),
    }));
  });

  test('routes spec and phase detail through distinct explicit paths', async () => {
    const specResponse = await request(app()).get('/api/lifecycle/specs/safe-spec?workspaceId=ws-a');
    const phaseResponse = await request(app()).get('/api/lifecycle/specs/safe-spec/phases/testing?workspaceId=ws-a&limit=10');

    expect(specResponse.status).toBe(200);
    expect(phaseResponse.status).toBe(200);
    expect(mockSpec).toHaveBeenCalledWith({ workspaceId: 'ws-a', specId: 'safe-spec', expectedSnapshotId: undefined });
    expect(mockPhase).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-a',
      specId: 'safe-spec',
      phaseId: 'testing',
      evidencePagination: expect.objectContaining({ limit: 10 }),
    }));
  });

  test('requires membership in the exact requested workspace before aggregate reads', async () => {
    mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('workspace_members') && params[0] === 'ws-a') return { role: 'member' };
      return null;
    });
    const member = {
      id: 'workspace-member',
      email: 'member@example.test',
      supabaseId: 'auth-member',
      role: 'user',
    } as Express.UserShape;

    const allowed = await request(app(member)).get('/api/lifecycle?workspaceId=ws-a');
    const foreign = await request(app(member)).get('/api/lifecycle?workspaceId=ws-foreign');

    expect(allowed.status).toBe(200);
    expect(foreign.status).toBe(403);
    expect(mockPortfolio).toHaveBeenCalledTimes(1);
    expect(mockPortfolio).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-a' }));
  });

  test('removes source body bytes from aggregate and phase responses while preserving provenance metadata', async () => {
    const sourceMaterial = {
      state: 'available',
      schemaVersion: 'rorca.lifecycle-source-material.v1',
      lens: 'requirements',
      package: { packageId: 'pack-1', contentHash: `sha256:${'a'.repeat(64)}` },
      artifacts: [{ relativePath: 'requirements.md', contentHash: `sha256:${'b'.repeat(64)}` }],
      synthesis: {
        title: 'Requirements',
        sourcePackageHash: `sha256:${'a'.repeat(64)}`,
        sections: [{
          id: 'requirements-1',
          title: 'Security boundaries',
          content: 'SECRET SOURCE PACK BODY',
          sourcePath: 'requirements.md',
          startLine: 10,
          endLine: 12,
          sourceContentHash: `sha256:${'b'.repeat(64)}`,
          freshness: 'current',
        }],
      },
    };
    mockSpec.mockResolvedValueOnce({ specId: 'safe-spec', sourceMaterial });
    mockPhase.mockResolvedValueOnce({ specId: 'safe-spec', phaseId: 'requirements', sourceMaterial });

    const aggregate = await request(app()).get('/api/lifecycle/specs/safe-spec?workspaceId=ws-a');
    const phase = await request(app()).get('/api/lifecycle/specs/safe-spec/phases/requirements?workspaceId=ws-a');

    expect(aggregate.status).toBe(200);
    expect(phase.status).toBe(200);
    expect(JSON.stringify(aggregate.body)).not.toContain('SECRET SOURCE PACK BODY');
    expect(JSON.stringify(phase.body)).not.toContain('SECRET SOURCE PACK BODY');
    expect(aggregate.body.sourceMaterial.synthesis.sections[0]).toMatchObject({
      sourcePath: 'requirements.md',
      startLine: 10,
      endLine: 12,
      sourceContentHash: `sha256:${'b'.repeat(64)}`,
    });
    expect(aggregate.body.sourceMaterial.synthesis.sections[0]).not.toHaveProperty('content');
    expect(phase.body.sourceMaterial.synthesis.sections[0]).not.toHaveProperty('content');
  });

  test('keeps bounded source content behind exact workspace and Genesis clearance authorization', async () => {
    mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('workspace_members')) return params[0] === 'ws-a' ? { role: 'member' } : null;
      if (sql.includes('SELECT path FROM workspaces')) return { path: '/workspace-a' };
      return null;
    });
    mockPhase.mockResolvedValue({
      sourceMaterial: {
        state: 'available',
        package: {
          packageId: 'pack-1',
          authoritative: true,
          contentHash: `sha256:${'a'.repeat(64)}`,
          previewHash: `sha256:${'b'.repeat(64)}`,
          snapshotHash: `sha256:${'c'.repeat(64)}`,
        },
        authority: {
          status: 'verified',
          receiptId: `package-event:sha256:${'c'.repeat(64)}`,
          receiptHash: `sha256:${'d'.repeat(64)}`,
          manifestHash: `sha256:${'e'.repeat(64)}`,
          releaseSubject: { type: 'spec_hash', value: `sha256:${'f'.repeat(64)}` },
        },
        artifacts: [{ relativePath: 'requirements.md', contentHash: `sha256:${'b'.repeat(64)}` }],
      },
    });
    const member = {
      id: 'workspace-member',
      email: 'member@example.test',
      supabaseId: 'auth-member',
      role: 'user',
    } as Express.UserShape;

    const foreign = await request(app(member))
      .get('/api/lifecycle/specs/safe-spec/source-artifacts/content?workspaceId=ws-foreign&relativePath=requirements.md');
    const proxied = await request(app(member))
      .get('/api/lifecycle/specs/safe-spec/source-artifacts/content?workspaceId=ws-a&relativePath=requirements.md')
      .set('X-Forwarded-For', '198.51.100.7');
    const allowed = await request(app(member))
      .get('/api/lifecycle/specs/safe-spec/source-artifacts/content?workspaceId=ws-a&relativePath=requirements.md');

    expect(foreign.status).toBe(403);
    expect(proxied.status).toBe(403);
    expect(allowed.status).toBe(200);
    expect(allowed.body.content).toBe('bounded source body');
    expect(mockReadSourceArtifact).toHaveBeenCalledTimes(1);
    expect(mockReadSourceArtifact).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '/workspace-a',
      relativePath: 'requirements.md',
    }));

    mockResolveGenesisSource.mockResolvedValueOnce({
      sections: [{ redacted: true }],
      genesis: { publicationAuthority: null },
    });
    const denied = await request(app(member))
      .get('/api/lifecycle/specs/safe-spec/source-artifacts/content?workspaceId=ws-a&relativePath=requirements.md');
    expect(denied.status).toBe(403);
    expect(mockReadSourceArtifact).toHaveBeenCalledTimes(1);

    mockResolveGenesisSource.mockResolvedValueOnce({
      sections: [{ redacted: true }],
      genesis: { publicationAuthority: null },
    });
    const deniedOpen = await request(app())
      .post('/api/lifecycle/specs/safe-spec/source-artifacts/open?workspaceId=ws-a')
      .send({ relativePath: 'requirements.md' });
    expect(deniedOpen.status).toBe(403);
    expect(mockOpenSourceArtifact).not.toHaveBeenCalled();
  });

  test('allows a bounded local preview for the projected draft but keeps host actions receipt-gated', async () => {
    mockQueryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('workspace_members')) return { role: 'admin' };
      if (sql.includes('SELECT path FROM workspaces')) return { path: '/workspace-a' };
      return null;
    });
    mockPhase.mockResolvedValue({
      sourceMaterial: {
        state: 'available',
        package: {
          packageId: 'draft-pack',
          authoritative: false,
          publicationStatus: 'draft-not-published',
          contentHash: `sha256:${'a'.repeat(64)}`,
          previewHash: `sha256:${'b'.repeat(64)}`,
          snapshotHash: `sha256:${'c'.repeat(64)}`,
        },
        authority: {
          status: 'context_only',
          reasonCode: 'authority_receipt_not_declared',
          receiptId: null,
          receiptHash: null,
          manifestHash: null,
          releaseSubject: null,
        },
        artifacts: [{ relativePath: 'requirements.md', contentHash: `sha256:${'b'.repeat(64)}` }],
      },
    });

    const preview = await request(app())
      .get('/api/lifecycle/specs/safe-spec/source-artifacts/content?workspaceId=ws-a&relativePath=requirements.md');
    const open = await request(app())
      .post('/api/lifecycle/specs/safe-spec/source-artifacts/open?workspaceId=ws-a')
      .send({ relativePath: 'requirements.md' });

    expect(preview.status).toBe(200);
    expect(preview.body.content).toBe('bounded source body');
    expect(open.status).toBe(403);
    expect(mockReadSourceArtifact).toHaveBeenCalledTimes(1);
    expect(mockOpenSourceArtifact).not.toHaveBeenCalled();
    expect(mockResolveGenesisSource).not.toHaveBeenCalled();
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
      workspaceId: 'ws-a', specId: 'safe-spec', phaseId: 'maintenance', runId: 42, changeKind: 'evidence_persisted',
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
      request(app()).get('/api/lifecycle/operations'),
      request(app()).get('/api/lifecycle/specs/safe-spec'),
      request(app()).get('/api/lifecycle/specs/safe-spec/phases/testing'),
      request(app()).get('/api/lifecycle/evidence/7'),
    ]);

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400]);
    expect(mockPortfolio).not.toHaveBeenCalled();
    expect(mockSpec).not.toHaveBeenCalled();
    expect(mockPhase).not.toHaveBeenCalled();
    expect(mockEvidence).not.toHaveBeenCalled();
  });
});
