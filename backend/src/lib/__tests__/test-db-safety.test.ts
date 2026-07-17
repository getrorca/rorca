/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Client } from 'pg';
import {
  assertConnectedTestDatabase,
  assertTestDatabaseUrl,
  databaseNameFromUrl,
  resolveTestDatabaseUrl,
} from '../test-db-safety';

describe('test database safety', () => {
  test('accepts only PostgreSQL URLs naming a *_test database', () => {
    expect(databaseNameFromUrl('postgresql://user:secret@localhost:5433/rorca_test'))
      .toBe('rorca_test');
    expect(assertTestDatabaseUrl('postgres://localhost/suite_test')).toBe('suite_test');

    expect(() => assertTestDatabaseUrl('postgres://localhost/rorca'))
      .toThrow(/does not end in "_test"/);
    expect(() => assertTestDatabaseUrl('https://localhost/rorca_test'))
      .toThrow(/must use postgres/);
  });

  test('never derives a test target from production DATABASE_URL', () => {
    expect(() => resolveTestDatabaseUrl({
      DATABASE_URL: 'postgresql://admin:secret@localhost:5433/rorca',
      RORCA_TEST_DB_ENV_FILE: '/definitely/missing/rorca-test-db.env',
    })).toThrow(/No dedicated test database configured/);
  });

  test('rejects an explicit non-test target before connecting', () => {
    expect(() => resolveTestDatabaseUrl({
      RORCA_TEST_DATABASE_URL: 'postgresql://admin:secret@localhost:5433/rorca',
      RORCA_TEST_DB_ENV_FILE: '/definitely/missing/rorca-test-db.env',
    })).toThrow(/"rorca".*does not end/);
  });

  test('verifies server-reported database truth and expected target', async () => {
    const matchingClient = {
      query: jest.fn().mockResolvedValue({
        rows: [{ database: 'rorca_test', user: 'rorca_test_runner', owner: 'rorca_test_runner' }],
      }),
    };
    await expect(assertConnectedTestDatabase(
      matchingClient,
      'postgresql://rorca_test_runner:secret@localhost:5433/rorca_test',
    )).resolves.toEqual({ database: 'rorca_test', user: 'rorca_test_runner', owner: 'rorca_test_runner' });

    const productionClient = {
      query: jest.fn().mockResolvedValue({
        rows: [{ database: 'rorca', user: 'admin', owner: 'admin' }],
      }),
    };
    await expect(assertConnectedTestDatabase(
      productionClient,
      'postgresql://runner:secret@localhost:5433/rorca_test',
    )).rejects.toThrow(/Refusing connected database "rorca"/);

    const wrongTestClient = {
      query: jest.fn().mockResolvedValue({
        rows: [{ database: 'other_test', user: 'runner', owner: 'runner' }],
      }),
    };
    await expect(assertConnectedTestDatabase(
      wrongTestClient,
      'postgresql://runner:secret@localhost:5433/rorca_test',
    )).rejects.toThrow(/expected "rorca_test"/);

    await expect(assertConnectedTestDatabase({
      query: jest.fn().mockResolvedValue({
        rows: [{ database: 'rorca_test', user: 'rorca', owner: 'runner' }],
      }),
    }, 'postgresql://runner:secret@localhost:5433/rorca_test'))
      .rejects.toThrow(/Refusing connected role "rorca"/);

    await expect(assertConnectedTestDatabase({
      query: jest.fn().mockResolvedValue({
        rows: [{ database: 'rorca_test', user: 'runner', owner: 'rorca' }],
      }),
    }, 'postgresql://runner:secret@localhost:5433/rorca_test'))
      .rejects.toThrow(/Refusing database owner "rorca"/);
  });

  test('incident regression A: leave mutable DATABASE_URL pointing away from test', async () => {
    const dedicatedUrl = process.env.RORCA_TEST_DATABASE_URL!;
    const client = new Client({ connectionString: dedicatedUrl });
    try {
      await client.connect();
      await client.query(
        `INSERT INTO rorca.workspaces (id, label, path)
         VALUES ('db-isolation-sentinel', 'DB isolation sentinel', '/tmp/db-isolation-sentinel')`,
      );
    } finally {
      await client.end();
    }

    // This reproduces the incident precondition without valid production
    // credentials. The next global cleanup must ignore this mutable value.
    process.env.DATABASE_URL = 'postgresql://invalid:invalid@127.0.0.1:5433/rorca';
  });

  test('incident regression B: global cleanup used its immutable test target', async () => {
    const dedicatedUrl = process.env.RORCA_TEST_DATABASE_URL!;
    const client = new Client({ connectionString: dedicatedUrl });
    try {
      await client.connect();
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM rorca.workspaces
          WHERE id = 'db-isolation-sentinel'`,
      );
      expect(result.rows[0]?.count).toBe('0');
    } finally {
      await client.end();
      process.env.DATABASE_URL = dedicatedUrl;
    }
  });
});
