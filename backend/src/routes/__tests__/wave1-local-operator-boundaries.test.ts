/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { csrfProtection } from '../../lib/csrf';
import { requireConfiguredBrowserOrigin } from '../../lib/local-operator-boundary';
import forgejoOperatorRouter from '../forgejo-operator';
import { registerForgejoCredential } from '../../lib/forgejo-token-credential-provider';
import { LOCAL_ADMIN } from '../../lib/auth-utils';
import { errorHandler } from '../../lib/error-handler';

jest.mock('../../lib/forgejo-token-credential-provider', () => ({
  registerForgejoCredential: jest.fn(),
  rotateForgejoCredential: jest.fn(),
  revokeForgejoCredential: jest.fn(),
  provisionForgejoWebhookSecret: jest.fn(),
  rotateForgejoWebhookSecret: jest.fn(),
  revokeForgejoWebhookSecret: jest.fn(),
}));

const CAPABILITY = 'wave1-route-test-operator';
const CSRF = 'b'.repeat(64);
const register = registerForgejoCredential as jest.MockedFunction<typeof registerForgejoCredential>;

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use(requireConfiguredBrowserOrigin);
  instance.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = LOCAL_ADMIN;
    next();
  });
  instance.use(csrfProtection);
  instance.use('/api/forgejo', forgejoOperatorRouter);
  instance.use(errorHandler);
  return instance;
}

function mutation(instance: express.Express) {
  return request(instance)
    .post('/api/forgejo/credentials/workspace-one')
    .set('Origin', 'http://localhost:5210')
    .set('Cookie', `_csrf=${CSRF}`)
    .set('X-CSRF-Token', CSRF)
    .send({
      instanceUrl: 'https://forgejo.example.test',
      owner: 'acme',
      name: 'widgets',
      token: 'test-token-material-at-least-16-bytes',
    });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.AUTH_REQUIRED;
  delete process.env.CORS_ORIGIN;
  process.env.RORCA_OPERATOR_CAPABILITY_SHA256 = crypto.createHash('sha256').update(CAPABILITY).digest('hex');
  register.mockResolvedValue({
    bindingId: 'binding-one', workspaceId: 'workspace-one', instanceUrl: 'https://forgejo.example.test',
    owner: 'acme', name: 'widgets', status: 'active', tokenDigest: 'sha256:digest', scopeProfile: {},
    credentialVersion: 1, keyVersion: 1, expiresAt: null, lastValidatedAt: new Date().toISOString(),
    validationErrorCode: null, auditProvenanceHash: null, webhookSecretEncrypted: null,
    webhookSecretPreviousEncrypted: null, webhookSecretVersion: 0, createdAt: new Date().toISOString(),
  });
});

afterEach(() => {
  delete process.env.RORCA_OPERATOR_CAPABILITY_SHA256;
});

test('exploit-shaped origin is denied before Forgejo credential handling', async () => {
  const response = await mutation(app()).set('Origin', 'http://localhost.attacker.test:5210')
    .set('X-Rorca-Operator-Capability', CAPABILITY);
  expect(response.status).toBe(403);
  expect(register).not.toHaveBeenCalled();
});

test('missing CSRF or operator capability is denied before Forgejo networking', async () => {
  const missingCapability = await mutation(app());
  expect(missingCapability.status).toBe(403);
  const missingCsrf = await request(app())
    .post('/api/forgejo/credentials/workspace-one')
    .set('X-Rorca-Operator-Capability', CAPABILITY)
    .send({ instanceUrl: 'https://forgejo.example.test', owner: 'acme', name: 'widgets', token: 'test-token-material-at-least-16-bytes' });
  expect(missingCsrf.status).toBe(403);
  expect(register).not.toHaveBeenCalled();
});

test('configured local operator request remains usable', async () => {
  const response = await mutation(app()).set('X-Rorca-Operator-Capability', CAPABILITY);
  expect(response.status).toBe(200);
  expect(register).toHaveBeenCalledTimes(1);
});
