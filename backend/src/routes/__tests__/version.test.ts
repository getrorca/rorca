/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express, { type Express } from 'express';
import { Pool } from 'pg';
import request from 'supertest';

const VERSION_WORKSPACE_ID = 'ws-version-contract';
const ENVIRONMENT_KEYS = ['NODE_ENV', 'RORCA_TEST_DATABASE_WORKSPACE_SCOPE'] as const;
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>;

process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = VERSION_WORKSPACE_ID;

const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 1,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${VERSION_WORKSPACE_ID}`,
});

function restoreEnvironment(): void {
  for (const key of ENVIRONMENT_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('GET /api/version', () => {
  let app: Express;

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = VERSION_WORKSPACE_ID;
    const router = require('../version').default;
    app = express();
    app.use('/api/version', router);
  });

  afterAll(async () => {
    try {
      await ownerPool.end();
    } finally {
      restoreEnvironment();
    }
  });

  it('returns the expected compatibility payload', async () => {
    const backendPkg = require('../../../package.json') as { version: string };
    const schemaResult = await ownerPool.query<{ version: string; filename: string }>(
      'SELECT version::text AS version, filename FROM public.schema_migrations ORDER BY schema_migrations.version DESC LIMIT 1',
    );
    expect(schemaResult.rows[0]).toEqual({
      version: expect.any(String),
      filename: expect.stringMatching(/\.sql(?: \[.*\])?$/),
    });
    const mixedVersions = await ownerPool.query<{ has_single_digit: boolean; has_timestamp: boolean }>(
      `SELECT BOOL_OR(version = 9) AS has_single_digit,
              BOOL_OR(version >= 10000000000000) AS has_timestamp
         FROM public.schema_migrations`,
    );
    expect(mixedVersions.rows[0]).toEqual({ has_single_digit: true, has_timestamp: true });

    const res = await request(app).get('/api/version');

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(backendPkg.version);
    expect(res.body.apiVersion).toBe('1.0');
    expect(res.body.schemaVersion).toBe(schemaResult.rows[0].version);
    expect(res.body.schemaMigration).toEqual(schemaResult.rows[0]);
    expect(res.body.minCliVersion).toBe('0.1.0');
    expect(res.body).toHaveProperty('capabilities.pi');
    expect(res.body).toHaveProperty('capabilities.docker');
    expect(res.body).toHaveProperty('capabilities.age');
    expect(typeof res.body.capabilities.pi).toBe('boolean');
    expect(typeof res.body.capabilities.docker).toBe('boolean');
    expect(typeof res.body.capabilities.age).toBe('boolean');
    expect(typeof res.body.capabilities.pgcrypto).toBe('boolean');
    expect(res.body.capabilities.age).toBe(res.body.databaseCapability.extensions.age);
    expect(res.body.capabilities.vector).toBe(res.body.databaseCapability.extensions.vector);
    expect(res.body.capabilities.pgcrypto).toBe(res.body.databaseCapability.extensions.pgcrypto);
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
