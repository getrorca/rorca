/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Explicit live integration: never include this file in DB-free focused selection. */

import { Client } from 'pg';
import {
  assertConnectedTestDatabase,
  readIsolatedTestDatabaseState,
  resolveTestDatabaseUrl,
} from '../test-db-safety';
import { runtimeTransaction } from '../../db';

test('live invocation server truth matches nonce marker, cluster, role, lease, and production denial', async () => {
  const state = readIsolatedTestDatabaseState();
  const url = resolveTestDatabaseUrl();
  if (!state.user || !state.migrationDatabaseUrl || !state.canonicalWriterDatabaseUrl) {
    throw new Error('Invocation split-principal database topology is incomplete');
  }
  const owner = decodeURIComponent(new URL(state.migrationDatabaseUrl).username);
  const canonicalWriter = decodeURIComponent(new URL(state.canonicalWriterDatabaseUrl).username);
  expect(state.user).not.toBe(owner);
  expect(canonicalWriter).not.toBe(state.user);
  expect(canonicalWriter).not.toBe(owner);
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await expect(assertConnectedTestDatabase(client, url)).resolves.toMatchObject({
      database: state.database,
      user: state.user,
      owner,
      marker: state.marker,
      systemIdentifier: state.systemIdentifier,
      dataDirectory: state.dataDirectory,
      superuser: false,
      productionDatabaseExists: true,
      productionConnect: false,
    });
  } finally {
    await client.end();
  }
});

test('runtime and canonical-writer principals can execute the schema-qualified crypto dependencies', async () => {
  const state = readIsolatedTestDatabaseState();
  if (!state.migrationDatabaseUrl || !state.canonicalWriterDatabaseUrl) {
    throw new Error('Invocation split-principal database topology is incomplete');
  }
  const clients = [
    new Client({ connectionString: resolveTestDatabaseUrl() }),
    new Client({ connectionString: state.canonicalWriterDatabaseUrl }),
  ];
  try {
    await Promise.all(clients.map((client) => client.connect()));
    for (const client of clients) {
      const result = await client.query<{ digest: string; mac: string }>(
        `SELECT encode(rorca.digest('rorca', 'sha256'), 'hex') AS digest,
                encode(rorca.hmac(convert_to('rorca', 'UTF8'), convert_to('key', 'UTF8'), 'sha256'), 'hex') AS mac`,
      );
      expect(result.rows[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(result.rows[0]?.mac).toMatch(/^[0-9a-f]{64}$/);
    }
  } finally {
    await Promise.all(clients.map((client) => client.end()));
  }
});

test('runtime principal can exercise its bounded closeout relation privileges', async () => {
  const client = new Client({ connectionString: resolveTestDatabaseUrl() });
  try {
    await client.connect();
    await client.query('SELECT id FROM rorca.run_findings LIMIT 0');
    await client.query('UPDATE rorca.run_findings SET status = status WHERE FALSE');
    await client.query('DELETE FROM rorca.run_findings WHERE FALSE');
    await client.query("SELECT nextval('rorca.run_findings_id_seq')");
    await client.query('SELECT id FROM rorca.ssdlc_reconciliation_receipts LIMIT 0');
    await client.query('SELECT id FROM rorca.ssdlc_release_qualifications LIMIT 0');
  } finally {
    await client.end();
  }
});

test('runtime-principal transactions initialize the exact runtime identity GUC', async () => {
  const expected = process.env.RORCA_RUNTIME_DATABASE_USER;
  if (!expected) throw new Error('RORCA_RUNTIME_DATABASE_USER is required');
  const observed = await runtimeTransaction(async (client) => {
    const result = await client.query<{ runtime_user: string }>(
      "SELECT current_setting('rorca.runtime_database_user') AS runtime_user",
    );
    return result.rows[0]?.runtime_user;
  });
  expect(observed).toBe(expected);
});
