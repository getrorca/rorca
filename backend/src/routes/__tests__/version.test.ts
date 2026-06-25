/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express, { type Express } from 'express';
import request from 'supertest';
import { queryOne } from '../../db/index';

describe('GET /api/version', () => {
  let app: Express;

  beforeEach(() => {
    jest.resetModules();
    process.env.NODE_ENV = 'test';
    const router = require('../version').default;
    app = express();
    app.use('/api/version', router);
  });

  it('returns the expected compatibility payload', async () => {
    const backendPkg = require('../../../package.json') as { version: string };
    const schemaRow = await queryOne<{ version: string | null }>(
      'SELECT MAX(version)::text AS version FROM public.schema_migrations',
    );

    const res = await request(app).get('/api/version');

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(backendPkg.version);
    expect(res.body.apiVersion).toBe('1.0');
    expect(res.body.schemaVersion).toBe(schemaRow?.version ?? null);
    expect(res.body.minCliVersion).toBe('0.1.0');
    expect(res.body).toHaveProperty('capabilities.pi');
    expect(res.body).toHaveProperty('capabilities.docker');
    expect(res.body).toHaveProperty('capabilities.age');
    expect(typeof res.body.capabilities.pi).toBe('boolean');
    expect(typeof res.body.capabilities.docker).toBe('boolean');
    expect(typeof res.body.capabilities.age).toBe('boolean');
    expect(res.body).toHaveProperty('databaseCapability.dbMode');
    expect(res.body).toHaveProperty('databaseCapability.provider');
    expect(res.body).toHaveProperty('databaseCapability.extensions.age');
    expect(res.body).toHaveProperty('databaseCapability.graphMode');
    expect(String(res.body.databaseCapability.connection.url ?? '')).not.toContain('@');
  });

  it('does not require authentication', async () => {
    const res = await request(app).get('/api/version');
    expect(res.status).toBe(200);
  });
});
