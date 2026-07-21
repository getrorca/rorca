/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Pool } from 'pg';
import { resolveTestDatabaseUrl } from '../../lib/test-db-safety';
import * as dbModule from '../index';

type DbModule = typeof dbModule;
const originalEnv = {
  PG_POOL_SIZE: process.env.PG_POOL_SIZE,
  DATABASE_URL: process.env.DATABASE_URL,
  JEST_SKIP_RUNTIME_MIGRATIONS: process.env.JEST_SKIP_RUNTIME_MIGRATIONS,
};

async function loadDb(poolSize: number): Promise<DbModule> {
  process.env.PG_POOL_SIZE = String(poolSize);
  process.env.DATABASE_URL = resolveTestDatabaseUrl();
  process.env.JEST_SKIP_RUNTIME_MIGRATIONS = 'true';
  return dbModule;
}

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function closeDb(db: DbModule): Promise<void> {
  await db.closePool();
  restoreEnv('PG_POOL_SIZE');
  restoreEnv('DATABASE_URL');
  restoreEnv('JEST_SKIP_RUNTIME_MIGRATIONS');
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('maxPool=1 fenced queries reuse the lock session without deadlock', async () => {
  const db = await loadDb(1);
  try {
    const result = await Promise.race([
      db.withPgAdvisoryLock('als-max-one', () => db.queryOne<{ value: number }>('SELECT 1::int AS value')),
      sleep(1500).then(() => { throw new Error('single-connection advisory operation deadlocked'); }),
    ]);
    expect(result).toEqual({ value: 1 });
  } finally { await closeDb(db); }
});

test('same key serializes while different keys may progress concurrently', async () => {
  const db = await loadDb(4);
  try {
    const sameEvents: string[] = [];
    let markEntered!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const first = db.withPgAdvisoryLock('als-same', async () => {
      sameEvents.push('a:start'); markEntered(); await sleep(100); sameEvents.push('a:end');
    });
    await entered;
    const second = db.withPgAdvisoryLock('als-same', async () => {
      sameEvents.push('b:start'); await sleep(20); sameEvents.push('b:end');
    });
    await Promise.all([first, second]);
    expect(sameEvents).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);

    let active = 0;
    let maximumActive = 0;
    await Promise.all(['als-different-a', 'als-different-b'].map(key => db.withPgAdvisoryLock(key, async () => {
      active += 1; maximumActive = Math.max(maximumActive, active);
      await sleep(120);
      active -= 1;
    })));
    expect(maximumActive).toBe(2);
  } finally { await closeDb(db); }
});

test('throw unlocks and invalidates context for async descendants', async () => {
  const db = await loadDb(3);
  const external = new Pool({ connectionString: resolveTestDatabaseUrl(), max: 1 });
  let descendant: Promise<number> | undefined;
  try {
    await expect(db.withPgAdvisoryLock('als-throw', async () => {
      await expect(db.withPgAdvisoryLock('als-nested', async () => undefined))
        .rejects.toThrow(/Nested PostgreSQL advisory authority fences/);
      descendant = new Promise((resolve, reject) => setTimeout(() => {
        db.queryOne<{ pid: number }>('SELECT pg_backend_pid()::int AS pid').then(row => resolve(row!.pid), reject);
      }, 50));
      throw new Error('expected-operation-failure');
    })).rejects.toThrow('expected-operation-failure');

    const unlocked = await external.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`, ['als-throw'],
    );
    expect(unlocked.rows[0]?.acquired).toBe(true);
    await external.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, ['als-throw']);
    await expect(descendant!).resolves.toEqual(expect.any(Number));
    await expect(db.withPgAdvisoryLock('als-throw', async () => 'reacquired')).resolves.toBe('reacquired');
  } finally {
    await external.end();
    await closeDb(db);
  }
});

test('entry and exit reset poisoned search-path and claim session state', async () => {
  const db = await loadDb(1);
  try {
    await db.transaction(async client => {
      await client.query("SET search_path TO public");
      await client.query("SET request.jwt.claim.sub TO 'poison-before'");
    });
    await db.withPgAdvisoryLock('als-session-hygiene', async () => {
      expect(await db.queryOne<{ schema: string; claim: string }>(`
        SELECT current_schema() AS schema, current_setting('request.jwt.claim.sub', true) AS claim
      `)).toEqual({ schema: 'rorca', claim: '' });
      await db.transaction(async client => {
        await client.query("SET search_path TO public");
        await client.query("SET request.jwt.claim.sub TO 'poison-after'");
      });
    });
    expect(await db.queryOne<{ schema: string; claim: string }>(`
      SELECT current_schema() AS schema, current_setting('request.jwt.claim.sub', true) AS claim
    `)).toEqual({ schema: 'rorca', claim: '' });
  } finally { await closeDb(db); }
});

test('nested/concurrent fenced transactions and cross-owner helper queries fail closed', async () => {
  const db = await loadDb(1);
  try {
    await db.withPgAdvisoryLock('als-transaction-ownership', async () => {
      let releaseFirst!: () => void;
      let markEntered!: () => void;
      const entered = new Promise<void>(resolve => { markEntered = resolve; });
      const hold = new Promise<void>(resolve => { releaseFirst = resolve; });
      const first = db.transaction(async () => {
        markEntered();
        await expect(db.transaction(async () => undefined)).rejects.toThrow(/Nested or concurrent/);
        await hold;
      });
      await entered;
      await expect(db.transaction(async () => undefined)).rejects.toThrow(/Nested or concurrent/);
      await expect(db.queryOne('SELECT 1')).rejects.toThrow(/outside the active fenced transaction/);
      releaseFirst();
      await first;
    });
  } finally { await closeDb(db); }
});

test('successful completion does not leak a released fenced client to async descendants', async () => {
  const db = await loadDb(1);
  let descendant: Promise<number> | undefined;
  try {
    await db.withPgAdvisoryLock('als-success-cleanup', async () => {
      descendant = new Promise((resolve, reject) => setTimeout(() => {
        db.queryOne<{ value: number }>('SELECT 3::int AS value').then(row => resolve(row!.value), reject);
      }, 50));
    });
    // Close the original pool before the descendant runs. A leaked active ALS
    // client would now be a released/ended client rather than a fresh borrow.
    await db.closePool();
    await expect(descendant!).resolves.toBe(3);
  } finally { await closeDb(db); }
});

test('transaction commit and rollback use the fenced session without leaking transaction state', async () => {
  const db = await loadDb(1);
  try {
    await db.withPgAdvisoryLock('als-transaction', async () => {
      await db.transaction(async client => {
        await client.query('CREATE TEMP TABLE advisory_commit_probe(value int)');
        await client.query('INSERT INTO advisory_commit_probe VALUES (4)');
      });
      expect(await db.queryOne<{ value: number }>('SELECT value FROM advisory_commit_probe')).toEqual({ value: 4 });
      await db.execute('DROP TABLE advisory_commit_probe');

      await expect(db.transaction(async client => {
        await client.query('CREATE TEMP TABLE advisory_rollback_probe(value int)');
        await client.query('INSERT INTO advisory_rollback_probe VALUES (1)');
        throw new Error('rollback-probe');
      })).rejects.toThrow('rollback-probe');
      const probe = await db.queryOne<{ relation: string | null }>(
        `SELECT to_regclass('pg_temp.advisory_rollback_probe')::text AS relation`,
      );
      expect(probe?.relation).toBeNull();
      expect(await db.queryOne<{ value: number }>('SELECT 2::int AS value')).toEqual({ value: 2 });
    });
  } finally { await closeDb(db); }
});
