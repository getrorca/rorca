/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';
import { queryOne } from '../../db/index';
import { errorHandler } from '../../lib/error-handler';
import attachmentsRouter from '../attachments';

jest.mock('../../db/index', () => ({
  queryOne: jest.fn(),
}));

const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;

function buildApp() {
  const app = express();
  app.use('/api/attachments', attachmentsRouter);
  app.use(errorHandler);
  return app;
}

describe('attachment multipart security boundary', () => {
  beforeEach(() => {
    mockQueryOne.mockReset();
    mockQueryOne.mockResolvedValue({
      id: 'attachment-id',
      filename: 'brief.txt',
      content_type: 'text/plain',
      file_size: 5,
      created_at: '2026-07-14T00:00:00.000Z',
    } as never);
  });

  it('accepts the expected bounded upload shape after the Multer upgrade', async () => {
    const response = await request(buildApp())
      .post('/api/attachments/pending')
      .field('specSlug', 'security-review')
      .attach('file', Buffer.from('brief'), {
        filename: 'brief.txt',
        contentType: 'text/plain',
      });

    expect(response.status).toBe(201);
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });

  it('rejects deeply nested multipart fields before route or database processing', async () => {
    const deeplyNestedField = `metadata${'[nested]'.repeat(64)}`;
    const response = await request(buildApp())
      .post('/api/attachments/pending')
      .field(deeplyNestedField, 'attacker-controlled')
      .attach('file', Buffer.from('brief'), {
        filename: 'brief.txt',
        contentType: 'text/plain',
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      code: 'VALIDATION_ERROR',
      error: expect.stringMatching(/invalid multipart upload/i),
    }));
    expect(mockQueryOne).not.toHaveBeenCalled();
  });
});
