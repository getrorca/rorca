/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import express, { type Request } from 'express';
import request from 'supertest';
import { queryOne } from '../../db/index';
import { acceptContinuationDispatchDelivery, submitPlanChangeProposal } from '../../lib/governed-mission-service';
import missionControlRouter from '../mission-control';
import { errorHandler } from '../../lib/error-handler';
import { authRequired, INTERNAL_SERVICE_TOKEN, requirePlatformAdmin, requireWorkspaceAdmin } from '../../lib/auth-utils';

jest.mock('../../db/index', () => ({ ...jest.requireActual('../../db/index'), queryOne: jest.fn(async () => undefined) }));
jest.mock('../../lib/governed-mission-service', () => ({
  ...jest.requireActual('../../lib/governed-mission-service'),
  submitPlanChangeProposal: jest.fn(async (_body, context) => ({ duplicate: false, value: { principalId: context.principalId, relayPrincipalId: context.relayPrincipalId } })),
  acceptContinuationDispatchDelivery:jest.fn(async(_body,receiverPrincipalId)=>({accepted:true,duplicate:false,acceptanceReceiptHash:`sha256:${'a'.repeat(64)}`,acceptedAt:'2026-07-31T00:00:00.000Z',receiverPrincipalId})),
}));

const H = `sha256:${'a'.repeat(64)}`;
const RECEIVER_TOKEN = `receiver-http-test-${'r'.repeat(40)}`;
const originalReceiverToken = process.env.RORCA_DISPATCH_RECEIVER_TOKEN;

beforeAll(() => {
  process.env.RORCA_DISPATCH_RECEIVER_TOKEN = RECEIVER_TOKEN;
});

afterAll(() => {
  if (originalReceiverToken === undefined) delete process.env.RORCA_DISPATCH_RECEIVER_TOKEN;
  else process.env.RORCA_DISPATCH_RECEIVER_TOKEN = originalReceiverToken;
});

const proposal = {
  schemaVersion: 'rorca.plan-change-proposal.v1', contractId: 'rorca.plan-change-proposal.v1', contractVersion: '1.0.0',
  artifactId: 'proposal-artifact:http', contentHash: H, createdAt: '2026-07-29T00:00:00.000Z', createdBy: 'runtime:http',
  workspaceId: 'workspace:http', missionId: 'mission:http', workPackageId: 'work-package:http',
  attemptId: 'attempt:http', leaseId: 'lease:http', fencingToken: 1, policyActivationHash: H, baseRevision: 1,
  baseHash: H, proposalId: 'proposal:http', diffHash: H, rationale: 'Bounded change', impactHash: H,
  requestedPaths: ['backend/src/example.ts'], dependencyManifestHash: H, validationManifestHash: H,
  proposerRuntimeId: 'runtime:http', requestsMergeAuthority: false, requestsDeploymentAuthority: false, state: 'proposed',
};

function authenticatedApp(){
  const instance=express();
  instance.use((req,_res,next)=>{(req as Request&{requestId?:string}).requestId='request:http-authenticated';next();});
  instance.use(authRequired);
  instance.use('/api/mission-control/v1',missionControlRouter);
  instance.use(errorHandler);
  return instance;
}

function app(userId: string) {
  const instance = express();
  instance.use((req, _res, next) => {
    req.user = { id: userId, email: `${userId}@local`, supabaseId: userId, role: 'admin' };
    (req as Request & { requestId?: string }).requestId = 'request:http-runtime';
    next();
  });
  instance.use('/api/mission-control/v1', missionControlRouter);
  instance.use(errorHandler);
  return instance;
}

test('internal service HTTP ingress delegates only the exact runtime principal and records the relay', async () => {
  const response = await request(app('rorca-internal-service')).post('/api/mission-control/v1/runtime/plan-change-proposals')
    .set('Idempotency-Key', 'http-runtime-proposal-one').set('X-Rorca-Runtime-Id', 'runtime:http').send(proposal);
  expect(response.status).toBe(200);
  expect(response.body.value).toEqual({ principalId: 'runtime:http', relayPrincipalId: 'rorca-internal-service' });
  expect(submitPlanChangeProposal).toHaveBeenCalledWith(proposal, expect.objectContaining({
    principalId: 'runtime:http', relayPrincipalId: 'rorca-internal-service', authoritySource: 'runtime_lease',
  }));
});

test('receiver acceptance traverses production auth with an independent receiver credential and exact payload transport', async () => {
  const payload = { schemaVersion: 'rorca.continuation-receiver-payload.v1', dispatchId: 'dispatch:http', continuationKey: H,
    leaseId: 'lease:http', fencingToken: 1, bundleId: 'bundle:http' };
  const body = { workspaceId: 'workspace:http', dispatchId: 'dispatch:http', owner: 'transport:http', claimFence: 1,
    sendAuthorizationHash: H, deliveryKey: H, payloadHash: H, payload };
  const generic = await request(authenticatedApp()).post('/api/mission-control/v1/internal/dispatch-outbox/accept')
    .set('Authorization', `Bearer ${INTERNAL_SERVICE_TOKEN}`).set('X-Rorca-Service', 'scheduler')
    .set('X-Rorca-Receiver-Id', 'rorca-dispatch-receiver').send(body);
  expect(generic.status).toBe(401);
  const receiver = await request(authenticatedApp()).post('/api/mission-control/v1/internal/dispatch-outbox/accept')
    .set('Authorization', `Bearer ${RECEIVER_TOKEN}`).set('X-Rorca-Service', 'dispatch-receiver')
    .set('X-Rorca-Receiver-Id', 'rorca-dispatch-receiver').send(body);
  expect(receiver.status).toBe(200);
  expect(acceptContinuationDispatchDelivery).toHaveBeenCalledWith(body, 'rorca-dispatch-receiver');
  const substituted = await request(authenticatedApp()).post('/api/mission-control/v1/internal/dispatch-outbox/accept')
    .set('Authorization', `Bearer ${RECEIVER_TOKEN}`).set('X-Rorca-Service', 'dispatch-receiver')
    .set('X-Rorca-Receiver-Id', 'receiver:other').send(body);
  expect(substituted.status).toBe(401);
  const reusedInternalSecret = await request(authenticatedApp()).post('/api/mission-control/v1/internal/dispatch-outbox/accept')
    .set('Authorization', `Bearer ${INTERNAL_SERVICE_TOKEN}`).set('X-Rorca-Service', 'dispatch-receiver')
    .set('X-Rorca-Receiver-Id', 'rorca-dispatch-receiver').send(body);
  expect(reusedInternalSecret.status).toBe(401);
});

test('receiver acceptance fails closed when receiver configuration is absent', async () => {
  const configured = process.env.RORCA_DISPATCH_RECEIVER_TOKEN;
  const callsBefore = jest.mocked(acceptContinuationDispatchDelivery).mock.calls.length;
  delete process.env.RORCA_DISPATCH_RECEIVER_TOKEN;
  try {
    const response = await request(authenticatedApp()).post('/api/mission-control/v1/internal/dispatch-outbox/accept')
      .set('Authorization', `Bearer ${RECEIVER_TOKEN}`).set('X-Rorca-Service', 'dispatch-receiver')
      .set('X-Rorca-Receiver-Id', 'rorca-dispatch-receiver').send({ workspaceId: 'workspace:http' });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_ERROR');
    expect(acceptContinuationDispatchDelivery).toHaveBeenCalledTimes(callsBefore);
  } finally {
    if (configured === undefined) delete process.env.RORCA_DISPATCH_RECEIVER_TOKEN;
    else process.env.RORCA_DISPATCH_RECEIVER_TOKEN = configured;
  }
});

test.each([
  ['delete', '/api/workspaces/workspace:other'],
  ['post', '/api/pipeline/trigger'],
  ['post', '/api/settings/worker'],
  ['post', '/api/mission-control/v1/internal/dispatch-outbox/settle'],
  ['get', '/api/mission-control/v1/internal/dispatch-outbox/accept'],
  ['post', '/api/mission-control/v1/internal/dispatch-outbox/accept/'],
])('receiver credential is rejected before unrelated %s %s authorization', async (method, path) => {
  const response = await (request(authenticatedApp()) as any)[method](path)
    .set('Authorization', `Bearer ${RECEIVER_TOKEN}`).set('X-Rorca-Service', 'dispatch-receiver')
    .set('X-Rorca-Receiver-Id', 'rorca-dispatch-receiver').send({ workspaceId: 'workspace:other' });
  expect(response.status).toBe(401);
  expect(response.body.code).toBe('AUTH_ERROR');
});

test('receiver capability principal cannot satisfy generic platform or workspace administrator gates',async()=>{
  const gated=express();
  gated.use((req,_res,next)=>{req.user={id:'rorca-dispatch-receiver',email:'dispatch-receiver@rorca.internal',
    supabaseId:'00000000-0000-0000-0000-000000000003',role:'dispatch_receiver'};next();});
  gated.post('/platform',requirePlatformAdmin(),(_req,res)=>res.sendStatus(204));
  gated.post('/workspace/:id',requireWorkspaceAdmin(),(_req,res)=>res.sendStatus(204));
  expect((await request(gated).post('/platform')).status).toBe(403);
  expect((await request(gated).post('/workspace/workspace:other')).status).toBe(403);
});

test('generic browser admin cannot claim runtime delegation', async () => {
  const response = await request(app('browser-admin')).post('/api/mission-control/v1/runtime/plan-change-proposals')
    .set('Idempotency-Key', 'http-runtime-proposal-two').set('X-Rorca-Runtime-Id', 'runtime:http').send(proposal);
  expect(response.status).toBe(401);
  expect(submitPlanChangeProposal).toHaveBeenCalledTimes(1);
});

test('internal service cannot substitute the artifact runtime identity', async () => {
  const response = await request(app('rorca-internal-service')).post('/api/mission-control/v1/runtime/plan-change-proposals')
    .set('Idempotency-Key', 'http-runtime-proposal-three').set('X-Rorca-Runtime-Id', 'runtime:other').send(proposal);
  expect(response.status).toBe(401);
  expect(submitPlanChangeProposal).toHaveBeenCalledTimes(1);
});

test('strict HTTP validation reaches the standard AppError envelope before service mutation', async () => {
  const response = await request(app('rorca-internal-service')).post('/api/mission-control/v1/runtime/plan-change-proposals')
    .set('Idempotency-Key', 'http-runtime-proposal-four').set('X-Rorca-Runtime-Id', 'runtime:http')
    .send({ ...proposal, callerAuthority: true });
  expect(response.status).toBe(422);
  expect(response.body).toEqual(expect.objectContaining({ error: 'Validation failed', code: 'REQUEST_SCHEMA_INVALID',
    details: expect.objectContaining({ issues: expect.any(Array) }) }));
  expect(submitPlanChangeProposal).toHaveBeenCalledTimes(1);
});

test('mission-control enforces the route-specific pre-service body bound', async () => {
  const response = await request(app('rorca-internal-service')).post('/api/mission-control/v1/runtime/plan-change-proposals')
    .set('Idempotency-Key', 'http-runtime-proposal-five').set('X-Rorca-Runtime-Id', 'runtime:http')
    .send({ ...proposal, rationale: 'x'.repeat(300_000) });
  expect(response.status).toBe(413);
  expect(response.body).toEqual(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }));
  expect(submitPlanChangeProposal).toHaveBeenCalledTimes(1);
});

test('raw wire bytes are enforced below, at, and above every governed route limit', async () => {
  const cases = [
    { path: '/api/mission-control/v1/runtime/events', limit: 64 * 1024 },
    { path: '/api/mission-control/v1/runtime/plan-change-proposals', limit: 256 * 1024 },
    { path: '/api/mission-control/v1/runtime/context-bundles', limit: 4 * 1024 * 1024 },
  ];
  for (const item of cases) {
    for (const size of [item.limit - 1, item.limit]) {
      const raw = `${' '.repeat(size - 2)}{}`;
      const response = await request(app('rorca-internal-service')).post(item.path).set('Content-Type', 'application/json').send(raw);
      expect(response.status).not.toBe(413);
    }
    const raw = `${' '.repeat(item.limit - 1)}{}`;
    const response = await request(app('rorca-internal-service')).post(item.path).set('Content-Type', 'application/json').send(raw);
    expect(response.status).toBe(413);
    expect(response.body.code).toBe('PAYLOAD_TOO_LARGE');
  }
}, 30_000);

test('parser-originated 4 MiB overflow and malformed JSON use stable public errors', async () => {
  const oversized = await request(app('rorca-internal-service')).post('/api/mission-control/v1/runtime/plan-change-proposals')
    .set('Content-Type', 'application/json').send(JSON.stringify({ rationale: 'x'.repeat(4 * 1024 * 1024 + 1) }));
  expect(oversized.status).toBe(413);
  expect(oversized.body).toEqual({ error: 'Request body exceeds the configured limit', code: 'PAYLOAD_TOO_LARGE' });
  const malformed = await request(app('rorca-internal-service')).post('/api/mission-control/v1/runtime/plan-change-proposals')
    .set('Content-Type', 'application/json').send('{"workspaceId":');
  expect(malformed.status).toBe(400);
  expect(malformed.body).toEqual({ error: 'Malformed JSON request body', code: 'MALFORMED_JSON' });
  expect(submitPlanChangeProposal).toHaveBeenCalledTimes(1);
});

test('platform admin without exact workspace membership cannot read or mutate governed tenant state', async () => {
  jest.mocked(queryOne).mockResolvedValue(undefined);
  const read = await request(app('browser-admin')).get('/api/mission-control/v1/missions?workspaceId=workspace:other');
  expect(read.status).toBe(403);
  expect(read.body.code).toBe('FORBIDDEN');
  const mutation = await request(app('browser-admin')).post('/api/mission-control/v1/missions/compile')
    .set('Content-Type', 'application/json').send({ artifact: { workspaceId: 'workspace:other' }, expectedStateVersion: null });
  expect(mutation.status).toBe(403);
  expect(mutation.body.code).toBe('FORBIDDEN');
});

test.each([
  '/missions/compile','/work-packages/revisions','/leases/acquire','/context/policy-definitions',
  '/context/policy-activations','/context/retry-budgets','/plan-change-proposals/review',
  '/cancellations/request','/compat/context-epoch-retirement/evaluate',
])('spoofed runtime header and internal credentials never bypass membership on operator route %s',async(route)=>{
  jest.mocked(queryOne).mockResolvedValue(undefined);
  for(const principal of ['browser-admin','rorca-internal-service']){
    const response=await request(app(principal)).post(`/api/mission-control/v1${route}`)
      .set('Content-Type','application/json').set('X-Rorca-Runtime-Id','runtime:spoofed')
      .send({workspaceId:'workspace:other',artifact:{workspaceId:'workspace:other'},expectedStateVersion:null});
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('FORBIDDEN');
  }
});
