/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';

const mockPersistCanonicalEvidence = jest.fn();
const mockPaginateNormalizedEvidence = jest.fn();

jest.mock('../../lib/ssdlc-evidence', () => {
  const actual = jest.requireActual('../../lib/ssdlc-evidence');
  return {
    ...actual,
    persistCanonicalEvidence: (...args: unknown[]) => mockPersistCanonicalEvidence(...args),
    paginateNormalizedEvidence: (...args: unknown[]) => mockPaginateNormalizedEvidence(...args),
  };
});

import lifecycleEvidenceRouter from '../lifecycle-evidence';
import { errorHandler } from '../../lib/error-handler';

const observedAt = '2026-07-15T12:00:00.000Z';

function appWithUser(user?: Express.UserShape) {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req, _res, next) => {
      req.user = user;
      next();
    });
  }
  app.use('/api/lifecycle', lifecycleEvidenceRouter);
  app.use(errorHandler);
  return app;
}

function manualEnvelope() {
  return {
    schemaVersion: 'hermes.evidence.v1',
    kind: 'manual_qa',
    sourceSystem: 'claimed-github-actions',
    sourceEventId: 'manual-qa-1',
    observedAt,
    scope: {
      workspaceId: 'ws-a',
      specSlug: 'safe-delivery',
      runId: 7,
      storyId: 'LFC-005',
      phaseId: 'qa',
      gateId: 'manual-qa',
    },
    subject: { type: 'artifact_digest', value: 'sha256:image' },
    phaseSubject: { type: 'artifact_digest', value: 'sha256:image' },
    releaseIdentity: { commitSha: 'abc123', artifactDigest: 'sha256:image' },
    status: 'passed',
    confidence: 1,
    payloadHash: 'a'.repeat(64),
    excerpt: 'QA passed',
    attachmentReference: 'attachments:manual-qa-1',
    provenanceChain: [{ system: 'hermes', eventId: 'manual-qa-1', observedAt }],
    rationale: 'Reviewed the staging acceptance path',
    actor: 'github-actions[bot]',
    trustLevel: 'provider_verified',
    automated: true,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPersistCanonicalEvidence.mockImplementation(async (evidence) => ({ evidence, replayed: false }));
  mockPaginateNormalizedEvidence.mockResolvedValue({ items: [], total: 0, hasMore: false });
});

describe('lifecycle evidence route', () => {
  test('requires an existing Rorca request identity', async () => {
    const response = await request(appWithUser())
      .post('/api/lifecycle/evidence/hermes')
      .send(manualEnvelope());

    expect(response.status).toBe(401);
    expect(mockPersistCanonicalEvidence).not.toHaveBeenCalled();
  });

  test('derives manual actor/trust from the principal rather than request claims', async () => {
    const response = await request(appWithUser({
      id: 'reviewer-1',
      email: 'reviewer@example.test',
      supabaseId: 'auth-reviewer-1',
      role: 'user',
    }))
      .post('/api/lifecycle/evidence/hermes')
      .send(manualEnvelope());

    expect(response.status).toBe(201);
    const normalized = mockPersistCanonicalEvidence.mock.calls[0][0];
    expect(normalized.source.type).toBe('manual_qa');
    expect(normalized.actor).toBe('reviewer@example.test');
    expect(normalized.actor).not.toBe('github-actions[bot]');
    expect(normalized.trustLevel).toBe('authenticated_manual');
  });

  test('returns 200 for an exact idempotent replay', async () => {
    mockPersistCanonicalEvidence.mockImplementation(async (evidence) => ({ evidence, replayed: true }));
    const response = await request(appWithUser({
      id: 'hermes-service',
      email: 'hermes@rorca.internal',
      supabaseId: 'auth-hermes',
      role: 'admin',
    }))
      .post('/api/lifecycle/evidence/hermes')
      .send({ ...manualEnvelope(), kind: 'gitreins_judgment', rationale: undefined, attachmentReference: undefined, rawReference: 'hermes:judgment-1' });

    expect(response.status).toBe(200);
    expect(response.body.replayed).toBe(true);
    expect(mockPersistCanonicalEvidence.mock.calls[0][0].trustLevel).toBe('provider_verified');
  });

  test('uses canonical pagination for redacted evidence listing', async () => {
    const response = await request(appWithUser({
      id: 'user-1',
      email: 'user@example.test',
      supabaseId: 'auth-user-1',
      role: 'user',
    })).get('/api/lifecycle/evidence?workspaceId=ws-a&runId=7&limit=25');

    expect(response.status).toBe(200);
    expect(mockPaginateNormalizedEvidence).toHaveBeenCalledWith(
      'ws-a',
      expect.objectContaining({ runId: 7 }),
      expect.objectContaining({ limit: 25 }),
    );
  });
});
