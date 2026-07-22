/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import {
  assertConnectedTestDatabase,
  assertTestDatabaseUrl,
  databaseNameFromUrl,
  resolveTestDatabaseUrl,
} from '../test-db-safety';

const AUTHORIZED_URL = 'postgresql://rorca_test_runner:secret@localhost:5433/rorca_cert_test';
let tempDir: string;
let envPath: string;

function authorizedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { RORCA_TEST_DB_ENV_FILE: envPath, ...overrides };
}

describe('test database safety', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-test-db-safety-'));
    envPath = path.join(tempDir, 'test-db.env');
    fs.writeFileSync(envPath, `RORCA_TEST_DATABASE_URL=${AUTHORIZED_URL}\n`, { mode: 0o600 });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('parses only PostgreSQL URLs naming a *_test database', () => {
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
    })).toThrow(/No authorized mode-0600 credential file/);
  });

  test('ignores ambient production and legacy targets when the authorized file is present', () => {
    expect(resolveTestDatabaseUrl(authorizedEnv({
      TEST_DATABASE_URL: 'postgresql://admin:secret@localhost:5433/rorca',
      DATABASE_URL: 'postgresql://admin:secret@localhost:5433/rorca',
    }))).toBe(AUTHORIZED_URL);
  });

  test('rejects alternate explicit test identities and URL overrides', () => {
    expect(() => resolveTestDatabaseUrl(authorizedEnv({
      RORCA_TEST_DATABASE_URL: 'postgresql://other_runner:secret@localhost:5433/other_test',
    }))).toThrow(/does not match the authorized mode-0600 credential file/);

    fs.writeFileSync(
      envPath,
      'RORCA_TEST_DATABASE_URL=postgresql://other_runner:secret@localhost:5433/other_test\n',
      { mode: 0o600 },
    );
    expect(() => resolveTestDatabaseUrl(authorizedEnv()))
      .toThrow(/only rorca_test_runner@rorca_cert_test is authorized/);
  });

  test('rejects an insecure credential file', () => {
    fs.chmodSync(envPath, 0o644);
    expect(() => resolveTestDatabaseUrl(authorizedEnv())).toThrow(/chmod 600/);
  });

  test('verifies server-reported database, role, owner, and exact authority target', async () => {
    const matchingClient = {
      query: jest.fn().mockResolvedValue({
        rows: [{ database: 'rorca_cert_test', user: 'rorca_test_runner', owner: 'rorca_test_runner' }],
      }),
    };
    await expect(assertConnectedTestDatabase(matchingClient, AUTHORIZED_URL)).resolves.toEqual({
      database: 'rorca_cert_test',
      user: 'rorca_test_runner',
      owner: 'rorca_test_runner',
    });

    await expect(assertConnectedTestDatabase({
      query: jest.fn().mockResolvedValue({
        rows: [{ database: 'other_test', user: 'rorca_test_runner', owner: 'rorca_test_runner' }],
      }),
    }, AUTHORIZED_URL)).rejects.toThrow(/Refusing connected database "other_test"/);

    await expect(assertConnectedTestDatabase({
      query: jest.fn().mockResolvedValue({
        rows: [{ database: 'rorca_cert_test', user: 'rorca', owner: 'rorca_test_runner' }],
      }),
    }, AUTHORIZED_URL)).rejects.toThrow(/Refusing connected role "rorca"/);

    await expect(assertConnectedTestDatabase({
      query: jest.fn().mockResolvedValue({
        rows: [{ database: 'rorca_cert_test', user: 'rorca_test_runner', owner: 'rorca' }],
      }),
    }, AUTHORIZED_URL)).rejects.toThrow(/Refusing database owner "rorca"/);

    await expect(assertConnectedTestDatabase(
      matchingClient,
      'postgresql://other_runner:secret@localhost:5433/other_test',
    )).rejects.toThrow(/only rorca_test_runner@rorca_cert_test is authorized/);
  });

  test('the configured server truth matches the immutable local credential', async () => {
    const dedicatedUrl = resolveTestDatabaseUrl();
    const client = new Client({ connectionString: dedicatedUrl });
    try {
      await client.connect();
      await expect(assertConnectedTestDatabase(client, dedicatedUrl)).resolves.toEqual({
        database: 'rorca_cert_test',
        user: 'rorca_test_runner',
        owner: 'rorca_test_runner',
      });
    } finally {
      await client.end();
    }
  });
});
