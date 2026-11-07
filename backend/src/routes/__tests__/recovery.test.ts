/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';

const mockCloseoutPreview = jest.fn();
const mockCloseoutRequest = jest.fn();
const mockExactWorkflowInspection = jest.fn();
const mockExactWorkflowReconcile = jest.fn();

jest.mock('../../lib/checkpoint-reconciliation', () => ({
  checkpointAttestationLookupSchema: require('zod').z.object({
    workspaceId: require('zod').z.string(),
    runId: require('zod').z.number().int().positive(),
    storyId: require('zod').z.string(),
    branch: require('zod').z.string(),
    checkpointSha: require('zod').z.string().length(40),
  }),
  checkpointReconciliationSchema: require('zod').z.object({
    workspaceId: require('zod').z.string(),
  }).passthrough(),
  getCheckpointAttestationReference: jest.fn(),
  reconcileCheckpoint: jest.fn(),
}));

jest.mock('../../lib/spec-post-save-reconciliation', () => ({
  inspectExactPostSaveWorkflow: (...args: unknown[]) => mockExactWorkflowInspection(...args),
  reconcilePostSaveWorkflowStage: (...args: unknown[]) => mockExactWorkflowReconcile(...args),
}));

jest.mock('../../lib/run-closeout-reconciliation', () => {
  const { z } = require('zod');
  return {
    closeoutReconciliationPreviewQuerySchema: z.object({ workspaceId: z.string().min(1) }).strict(),
    closeoutReconciliationRequestSchema: z.object({
      workspaceId: z.string().min(1),
      acceptedPreviewHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      rationale: z.string().min(12).max(2000),
      ownerAuthorization: z.record(z.string(), z.unknown()),
    }).strict(),
    previewRunCloseoutReconciliation: (...args: unknown[]) => mockCloseoutPreview(...args),
    requestRunCloseoutReconciliation: (...args: unknown[]) => mockCloseoutRequest(...args),
    requireCloseoutReconciliationIdempotencyKey: (value: unknown) => {
      const raw = typeof value === 'string' ? value : '';
      const key = raw.trim();
      if (raw !== key || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(key)) {
        const { ValidationError } = require('../../lib/errors');
        throw new ValidationError('Idempotency-Key must be 8-200 bounded ASCII characters');
      }
      return key;
    },
  };
});

import recoveryRouter from '../recovery';
import { csrfProtection } from '../../lib/csrf';
import { getCheckpointAttestationReference, reconcileCheckpoint } from '../../lib/checkpoint-reconciliation';

const mockedLookup = getCheckpointAttestationReference as jest.Mock;
const mockedReconcile = reconcileCheckpoint as jest.Mock;
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.user = { role: 'admin' }; next(); });
app.use('/api/admin/recovery', recoveryRouter);

describe('admin recovery checkpoint route boundary', () => {
  beforeEach(() => jest.resetAllMocks());

  it('rejects a non-admin caller before parsing or reconciliation', async () => {
    const denied = express();
    denied.use(express.json());
    denied.use((req: any, _res, next) => { req.user = { role: 'user' }; next(); });
    denied.use('/api/admin/recovery', recoveryRouter);
    const response = await request(denied).post('/api/admin/recovery/checkpoints/reconcile').send({ workspaceId: 'ws' });
    expect(response.status).toBe(403);
    expect(mockedReconcile).not.toHaveBeenCalled();
  });

  it('returns an AppError validation response before the governed service for malformed bodies', async () => {
    const response = await request(app).post('/api/admin/recovery/checkpoints/reconcile').send({});
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(mockedReconcile).not.toHaveBeenCalled();
  });

  it('returns only an existing opaque trusted-attestation reference', async () => {
    mockedLookup.mockResolvedValueOnce({
      attestationId: '11111111-1111-4111-8111-111111111111',
      attestationDigest: 'a'.repeat(64),
      validationGate: 'ci',
      expiresAt: '2026-07-05T00:00:00.000Z',
    });
    const response = await request(app).get('/api/admin/recovery/checkpoints/attestation').query({
      workspaceId: 'ws', runId: 21, storyId: 'US-002', branch: 'recovery/checkpoint', checkpointSha: '0'.repeat(40),
    });
    expect(response.status).toBe(200);
    expect(response.body.attestationId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('uses 201 for reconciliation and 200 for an idempotent replay', async () => {
    mockedReconcile
      .mockResolvedValueOnce({ reconciled: true, idempotent: false })
      .mockResolvedValueOnce({ reconciled: true, idempotent: true });

    const first = await request(app).post('/api/admin/recovery/checkpoints/reconcile').send({ workspaceId: 'ws' });
    const replay = await request(app).post('/api/admin/recovery/checkpoints/reconcile').send({ workspaceId: 'ws' });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(mockedReconcile).toHaveBeenCalledTimes(2);
  });
});

describe('admin exact-run closeout reconciliation route boundary', () => {
  const previousAuthRequired = process.env.AUTH_REQUIRED;
  const localApp = express();
  localApp.use(express.json());
  localApp.use((req: any, _res, next) => {
    req.user = {
      id: 'local-admin', email: 'admin@rorca.local',
      supabaseId: '00000000-0000-0000-0000-000000000001', role: 'admin',
    };
    next();
  });
  localApp.use('/api/admin/recovery', recoveryRouter);

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.AUTH_REQUIRED = 'false';
  });

  afterAll(() => {
    if (previousAuthRequired === undefined) delete process.env.AUTH_REQUIRED;
    else process.env.AUTH_REQUIRED = previousAuthRequired;
  });

  it('denies a generic platform/service admin that is not the exact local human principal', async () => {
    const denied = express();
    denied.use(express.json());
    denied.use((req: any, _res, next) => {
      req.user = { id: 'rorca-internal-service', email: 'scheduler@rorca.internal', supabaseId: 'service', role: 'admin' };
      next();
    });
    denied.use('/api/admin/recovery', recoveryRouter);
    const response = await request(denied)
      .get('/api/admin/recovery/runs/550/closeout-reconciliation/preview')
      .query({ workspaceId: 'proof-workspace' });
    expect(response.status).toBe(403);
    expect(mockCloseoutPreview).not.toHaveBeenCalled();
  });

  it('returns the one exact read-only preview for a run/workspace pair', async () => {
    mockCloseoutPreview.mockResolvedValueOnce({
      schemaVersion: 'rorca.run-closeout-reconciliation-preview.v1',
      eligible: true,
      canonicalTargetHash: `sha256:${'a'.repeat(64)}`,
    });
    const response = await request(localApp)
      .get('/api/admin/recovery/runs/550/closeout-reconciliation/preview')
      .query({ workspaceId: 'proof-workspace' });
    expect(response.status).toBe(200);
    expect(mockCloseoutPreview).toHaveBeenCalledWith({ runId: 550, workspaceId: 'proof-workspace' });
    expect(response.body.eligible).toBe(true);
  });

  it('requires a bounded Idempotency-Key before any mutation service call', async () => {
    const response = await request(localApp)
      .post('/api/admin/recovery/runs/550/closeout-reconciliation')
      .send({
        workspaceId: 'proof-workspace',
        acceptedPreviewHash: `sha256:${'a'.repeat(64)}`,
        rationale: 'Correct the audited false-failed host closeout.',
        ownerAuthorization: { signed: true },
      });
    expect(response.status).toBe(400);
    expect(mockCloseoutRequest).not.toHaveBeenCalled();
  });

  it('queues only the exact owner-authorized request and returns exact replay as 200', async () => {
    const body = {
      workspaceId: 'proof-workspace',
      acceptedPreviewHash: `sha256:${'a'.repeat(64)}`,
      rationale: 'Correct the audited false-failed host closeout.',
      ownerAuthorization: { schemaVersion: 'provider-human-event.v1', signed: true },
    };
    mockCloseoutRequest
      .mockResolvedValueOnce({ reconciliationId: 'one', state: 'queued', replayed: false })
      .mockResolvedValueOnce({ reconciliationId: 'one', state: 'completed', replayed: true });
    const first = await request(localApp)
      .post('/api/admin/recovery/runs/550/closeout-reconciliation')
      .set('Idempotency-Key', 'closeout:proof:550')
      .send(body);
    const replay = await request(localApp)
      .post('/api/admin/recovery/runs/550/closeout-reconciliation')
      .set('Idempotency-Key', 'closeout:proof:550')
      .send(body);
    expect(first.status).toBe(202);
    expect(replay.status).toBe(200);
    expect(mockCloseoutRequest).toHaveBeenNthCalledWith(1, expect.objectContaining({
      runId: 550,
      workspaceId: 'proof-workspace',
      idempotencyKey: 'closeout:proof:550',
      requesterActorId: 'local-admin',
      acceptedPreviewHash: `sha256:${'a'.repeat(64)}`,
    }));
  });

  it('rejects caller-supplied merge, path, SHA, story, or execution fields', async () => {
    const response = await request(localApp)
      .post('/api/admin/recovery/runs/550/closeout-reconciliation')
      .set('Idempotency-Key', 'closeout:proof:extra')
      .send({
        workspaceId: 'proof-workspace',
        acceptedPreviewHash: `sha256:${'a'.repeat(64)}`,
        rationale: 'Correct the audited false-failed host closeout.',
        ownerAuthorization: { signed: true },
        mergeStrategy: 'direct',
        sha: 'f'.repeat(40),
        storyId: 'E2E-001',
      });
    expect(response.status).toBe(400);
    expect(mockCloseoutRequest).not.toHaveBeenCalled();
  });
});

describe('admin exact post-save workflow reconciliation route boundary', () => {
  const previousAuthRequired = process.env.AUTH_REQUIRED;
  const localApp = express();
  localApp.use(express.json());
  localApp.use((req: any, _res, next) => {
    req.user = {
      id: 'local-admin', email: 'admin@rorca.local',
      supabaseId: '00000000-0000-0000-0000-000000000001', role: 'admin',
    };
    next();
  });
  localApp.use('/api/admin/recovery', recoveryRouter);

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.AUTH_REQUIRED = 'false';
  });
  afterAll(() => {
    if (previousAuthRequired === undefined) delete process.env.AUTH_REQUIRED;
    else process.env.AUTH_REQUIRED = previousAuthRequired;
  });

  it('returns only the exact bounded run inspection', async () => {
    mockExactWorkflowInspection.mockResolvedValueOnce({
      schemaVersion: 'rorca.spec-post-save-workflow-inspection.v1',
      workflow: { runId: 80, workspaceId: 'mission-waves', specId: 'wave-2', status: 'queued' },
      stages: [{ key: 'memorySynthesis', status: 'queued', applicationJobId: '340c973e-1829-4b9e-b7a0-1405a635d703' }],
    });
    const response = await request(localApp)
      .get('/api/admin/recovery/spec-workflows/v1/80')
      .query({ workspaceId: 'mission-waves', specId: 'wave-2' });
    expect(response.status).toBe(200);
    expect(mockExactWorkflowInspection).toHaveBeenCalledWith({
      workspaceId: 'mission-waves', specId: 'wave-2', workflowRunId: 80,
    });
    expect(JSON.stringify(response.body)).not.toContain('errorMessage');
  });

  it('rejects the real mounted mutation without double-submit CSRF before reconciliation',async()=>{
    const protectedApp=express();protectedApp.use(express.json());protectedApp.use(csrfProtection);
    protectedApp.use((req:any,_res,next)=>{req.user={id:'local-admin',email:'admin@rorca.local',supabaseId:'00000000-0000-0000-0000-000000000001',role:'admin'};next();});
    protectedApp.use('/api/admin/recovery',recoveryRouter);
    protectedApp.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error.statusCode??500).json({error:error.message}));
    const response=await request(protectedApp).post('/api/admin/recovery/spec-workflows/v1/80/stages/memorySynthesis/reconcile')
      .set('Idempotency-Key','workflow:csrf:strict:one').send({workspaceId:'mission-waves',specId:'wave-2',applicationJobId:'340c973e-1829-4b9e-b7a0-1405a635d703'});
    expect(response.status).toBe(403);expect(mockExactWorkflowReconcile).not.toHaveBeenCalled();
  });

  it('requires exact bounded body and Idempotency-Key before reconciliation', async () => {
    const response = await request(localApp)
      .post('/api/admin/recovery/spec-workflows/v1/80/stages/memorySynthesis/reconcile')
      .send({ workspaceId: 'mission-waves', specId: 'wave-2', applicationJobId: '340c973e-1829-4b9e-b7a0-1405a635d703' });
    expect(response.status).toBe(400);
    expect(mockExactWorkflowReconcile).not.toHaveBeenCalled();
  });

  it('returns accepted/no-op but maps rejected evidence to AppError conflict', async () => {
    const body = { workspaceId: 'mission-waves', specId: 'wave-2', applicationJobId: '340c973e-1829-4b9e-b7a0-1405a635d703' };
    const result=(outcome:'accepted'|'rejected',reasonCode:string,auditId:number)=>({schemaVersion:'rorca.spec-post-save-reconciliation.v1',outcome,reasonCode,workspaceId:'mission-waves',specId:'wave-2',workflowRunId:80,stageKey:'memorySynthesis',applicationJobId:body.applicationJobId,bossJobId:'b1ed2642-d2bc-40df-b19b-10b9372b933a',beforeStatus:'queued',afterStatus:outcome==='accepted'?'failed':'queued',applicationJobStatus:'failed',transport:{location:'live',state:outcome==='accepted'?'failed':'active'},auditId});
    mockExactWorkflowReconcile
      .mockResolvedValueOnce(result('accepted','terminal_application_job_applied',1))
      .mockResolvedValueOnce(result('rejected','transport_live_work',2));
    const accepted = await request(localApp)
      .post('/api/admin/recovery/spec-workflows/v1/80/stages/memorySynthesis/reconcile')
      .set('Idempotency-Key', 'workflow:run80:memory:one')
      .send(body);
    const rejected = await request(localApp)
      .post('/api/admin/recovery/spec-workflows/v1/80/stages/memorySynthesis/reconcile')
      .set('Idempotency-Key', 'workflow:run80:memory:two')
      .send(body);
    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(409);
    expect(rejected.body.details).toMatchObject({ reasonCode: 'transport_live_work', auditId: 2 });
  });
});
