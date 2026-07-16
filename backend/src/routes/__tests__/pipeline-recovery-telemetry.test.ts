/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../../db/index', () => ({
  query: jest.fn(), queryOne: jest.fn(), execute: jest.fn(), transaction: jest.fn(),
}));
jest.mock('../../lib/recovery-telemetry', () => ({ getRecoveryTelemetry: jest.fn() }));

import pipelineRouter from '../pipeline';
import { queryOne } from '../../db/index';
import { getRecoveryTelemetry } from '../../lib/recovery-telemetry';

const mockedQueryOne = queryOne as jest.Mock;
const mockedTelemetry = getRecoveryTelemetry as jest.Mock;
const app = express();
app.use('/api/pipeline', pipelineRouter);

describe('recovery telemetry route boundary', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedQueryOne.mockResolvedValue({ id: 'ws-recovery' });
  });

  it('rejects invalid workspace input before querying telemetry', async () => {
    const response = await request(app).get('/api/pipeline/telemetry?workspaceId=../../bad');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(mockedTelemetry).not.toHaveBeenCalled();
  });

  it('returns a redacted 503 when the recovery capability is unavailable', async () => {
    mockedTelemetry.mockRejectedValue(new Error('pgboss raw payload: secret-value'));
    const response = await request(app).get('/api/pipeline/telemetry?workspaceId=ws-recovery');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: 'Recovery telemetry capability is currently unavailable',
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(JSON.stringify(response.body)).not.toContain('secret-value');
  });
});
