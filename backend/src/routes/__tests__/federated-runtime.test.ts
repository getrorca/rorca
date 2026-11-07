/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { ZodError } from 'zod';
import { AppError, ConflictError } from '../../lib/errors';
import type { FederatedRuntimeService } from '../../lib/federated-runtime-service';
import { createTrustedProxyPredicate } from '../../lib/trusted-proxy';
import { createFederatedRuntimeRouter, type FederatedRateLimitOptions } from '../federated-runtime';

const runtime = { runtimeId: 'runtime:pilot', workspaceId: 'workspace:one', credentialVersion: 1, keyVersion: 1,
  status: 'active' as const, allowedContractVersions: ['1.0.0'] as const, mutationBoundsHash: `sha256:${'a'.repeat(64)}` };

function fixture(rateOptions?: FederatedRateLimitOptions) {
  const service = {
    authenticate: jest.fn().mockResolvedValue(runtime), discover: jest.fn().mockResolvedValue({ offers: [] }),
    acquire: jest.fn().mockResolvedValue({ claimId: 'claim:one' }), readWorkPackage: jest.fn().mockResolvedValue({ workPackage: {} }),
    renew: jest.fn().mockResolvedValue({ renewed: true }), release: jest.fn().mockResolvedValue({ released: true }),
    ingestEvent: jest.fn().mockResolvedValue({ duplicate: false }), ingestActivity: jest.fn().mockResolvedValue({ duplicate: false }),
    proposeResult: jest.fn().mockResolvedValue({ acceptedAsCompletion: false }), acknowledgeCancellation: jest.fn().mockResolvedValue({ duplicate: false }),
    proposePlanChange: jest.fn().mockResolvedValue({ duplicate: false }), recover: jest.fn().mockResolvedValue({ action: 'observe_only' }),
  } as unknown as jest.Mocked<FederatedRuntimeService>;
  const app = express();
  app.use('/api/mission-control/v1/federation', createFederatedRuntimeRouter(async () => service, rateOptions));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) res.status(error.statusCode).json(error.toJSON());
    else res.status(500).json({ error: error instanceof Error ? error.message : 'unknown' });
  });
  return { app, service };
}

function authenticated(call: request.Test): request.Test {
  return call.set('authorization', `Federated ${'credential-material-32-bytes-long!!'}`)
    .set('x-rorca-workspace-id', runtime.workspaceId).set('x-rorca-runtime-id', runtime.runtimeId)
    .set('x-rorca-credential-version', '1').set('x-rorca-key-version', '1');
}

describe('Wave 4 federated HTTP boundary', () => {
  test('rejects before disclosure when the runtime credential is absent', async () => {
    const { app, service } = fixture();
    const response = await request(app).post('/api/mission-control/v1/federation/discover').send({});
    expect(response.status).toBe(401);
    expect(service.discover).not.toHaveBeenCalled();
  });

  test('binds every mutation seam to one authenticated runtime identity', async () => {
    const { app, service } = fixture();
    const paths: Array<[string, keyof FederatedRuntimeService]> = [
      ['/discover', 'discover'], ['/acquire', 'acquire'], ['/work-package/read', 'readWorkPackage'],
      ['/leases/renew', 'renew'], ['/leases/release', 'release'], ['/events', 'ingestEvent'], ['/activity', 'ingestActivity'],
      ['/results/propose', 'proposeResult'], ['/cancellations/acknowledge', 'acknowledgeCancellation'],
      ['/plan-changes/propose', 'proposePlanChange'], ['/recover', 'recover'],
    ];
    for (const [path, method] of paths) {
      const response = await authenticated(request(app).post(`/api/mission-control/v1/federation${path}`).send({ marker: path }));
      expect(response.status).toBe(200);
      expect(service.authenticate).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: runtime.workspaceId,
        runtimeId: runtime.runtimeId, credentialVersion: 1, keyVersion: 1 }));
      expect(service[method]).toHaveBeenCalledWith(runtime, { marker: path });
    }
  });

  test('enforces the bounded body parser before service mutation', async () => {
    const { app, service } = fixture();
    const response = await authenticated(request(app).post('/api/mission-control/v1/federation/events')
      .send({ payload: 'x'.repeat(300 * 1024) }));
    expect(response.status).toBe(413);
    expect(service.ingestEvent).not.toHaveBeenCalled();
  });

  test('keeps forwarded TLS untrusted in production when remote MCP is enabled', async () => {
    const prior = process.env.NODE_ENV;
    const priorMcpRemote = process.env.RORCA_MCP_ALLOW_REMOTE;
    process.env.NODE_ENV = 'production';
    process.env.RORCA_MCP_ALLOW_REMOTE = 'true';
    try {
      const { app, service } = fixture();
      app.set('trust proxy', createTrustedProxyPredicate('203.0.113.10'));
      const response = await authenticated(request(app).post('/api/mission-control/v1/federation/discover').send({}));
      expect(response.status).toBe(401);
      expect(service.authenticate).not.toHaveBeenCalled();
      const spoofed = await authenticated(request(app).post('/api/mission-control/v1/federation/discover')
        .set('x-forwarded-proto', 'https').send({}));
      expect(spoofed.status).toBe(401);
      expect(service.authenticate).not.toHaveBeenCalled();
      app.set('trust proxy', 'loopback');
      const secure = await authenticated(request(app).post('/api/mission-control/v1/federation/discover')
        .set('x-forwarded-proto', 'https').send({}));
      expect(secure.status).toBe(200);
    } finally {
      process.env.NODE_ENV = prior;
      if (priorMcpRemote === undefined) delete process.env.RORCA_MCP_ALLOW_REMOTE;
      else process.env.RORCA_MCP_ALLOW_REMOTE = priorMcpRemote;
    }
  });


  test('maps strict schema failures and AppError conflicts without mutating another seam', async () => {
    const { app, service } = fixture();
    service.acquire.mockRejectedValueOnce(new ZodError([
      { code: 'custom', path: ['binding'], message: 'exact binding required' },
    ]));
    const invalid = await authenticated(request(app).post('/api/mission-control/v1/federation/acquire')
      .send({ unknownAuthority: true }));
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    service.release.mockRejectedValueOnce(new ConflictError('Exact fence changed', {
      reason: 'exact_binding_or_session_mismatch', retryable: false,
    }));
    const conflict = await authenticated(request(app).post('/api/mission-control/v1/federation/leases/release').send({}));
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: 'CONFLICT',
      details: { reason: 'exact_binding_or_session_mismatch', retryable: false } });
    expect(service.proposeResult).not.toHaveBeenCalled();
  });

  test('enforces the one-runtime request window before the third service call', async () => {
    const { app, service } = fixture({ windowMs: 60_000, maxRequestsPerWindow: 2 });
    let response: request.Response | undefined;
    for (let index = 0; index < 3; index += 1) {
      response = await authenticated(request(app).post('/api/mission-control/v1/federation/discover').send({ index }));
    }
    expect(response?.status).toBe(429);
    expect(response?.body).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(service.discover).toHaveBeenCalledTimes(2);
  });
});
