/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';
import attentionRouter from '../attention';
import deliveryCasesRouter from '../delivery-cases';
import { errorHandler } from '../../lib/error-handler';
import { getDeliveryCaseSummary, getRunControlProjection, getWorkspaceAttention } from '../../lib/mission-read-models';
import { NotFoundError, ValidationError } from '../../lib/errors';

jest.mock('../../lib/mission-read-models', () => ({
  getWorkspaceAttention: jest.fn(), getDeliveryCaseSummary: jest.fn(), getRunControlProjection: jest.fn(),
}));

const attentionMock = jest.mocked(getWorkspaceAttention);
const deliveryMock = jest.mocked(getDeliveryCaseSummary);
const controlMock = jest.mocked(getRunControlProjection);

function app() {
  const instance = express();
  instance.use('/api/workspaces', attentionRouter);
  instance.use('/api/workspaces', deliveryCasesRouter);
  instance.use(errorHandler);
  return instance;
}

beforeEach(() => jest.clearAllMocks());

test('workspace read routes pass only server path identities to the read service', async () => {
  attentionMock.mockResolvedValue({ items: [], generatedAt: '2026-08-06T12:00:00.000Z' });
  deliveryMock.mockResolvedValue({ marker: 'delivery' } as never);
  controlMock.mockResolvedValue({ marker: 'control' } as never);

  expect((await request(app()).get('/api/workspaces/ws-a/attention')).status).toBe(200);
  expect((await request(app()).get('/api/workspaces/ws-a/delivery-cases/spec-a?authority=admin')).body).toEqual({ marker: 'delivery' });
  expect((await request(app()).get('/api/workspaces/ws-a/delivery-cases/spec-a/runs/42/control?action=cancel')).body).toEqual({ marker: 'control' });

  expect(attentionMock).toHaveBeenCalledWith('ws-a');
  expect(deliveryMock).toHaveBeenCalledWith('ws-a', 'spec-a');
  expect(controlMock).toHaveBeenCalledWith('ws-a', 'spec-a', '42');
});

test('routes preserve standard AppError validation and not-found envelopes', async () => {
  attentionMock.mockRejectedValueOnce(new ValidationError('workspaceId is invalid', { field: 'workspaceId' }));
  const invalid = await request(app()).get('/api/workspaces/bad/attention');
  expect(invalid.status).toBe(400);
  expect(invalid.body).toMatchObject({ code: 'VALIDATION_ERROR', details: { field: 'workspaceId' } });

  deliveryMock.mockRejectedValueOnce(new NotFoundError('Lifecycle spec', 'missing'));
  const missing = await request(app()).get('/api/workspaces/ws-a/delivery-cases/missing');
  expect(missing.status).toBe(404);
  expect(missing.body).toMatchObject({ code: 'NOT_FOUND' });
});
