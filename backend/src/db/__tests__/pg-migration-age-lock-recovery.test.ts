/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Pool, type PoolClient } from 'pg';
import { runPgMigrations } from '../pg-index';
import { assertConnectedTestDatabase, resolveTestDatabaseUrl } from '../../lib/test-db-safety';

const AGE_VERSION = 50;

type Marker = {
  version: string;
  filename: string;
  skipped_in_lite_mode: boolean;
};

class AgeUnavailablePool {
  readonly pool: Pool;
  readonly events: string[] = [];
  private readonly failMarker: boolean;
  private sequence = 0;

  constructor(connectionString: string, failMarker = false) {
    this.pool = new Pool({ connectionString, max: 4 });
    this.failMarker = failMarker;
  }

  async connect(): Promise<PoolClient> {
    const client = await this.pool.connect();
    const session = ++this.sequence;
    const originalQuery = client.query.bind(client);
    const events = this.events;
    const failMarker = this.failMarker;
    client.query = (async (...args: unknown[]) => {
      const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? '');
      const params = Array.isArray(args[1]) ? args[1] as unknown[] : [];
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (normalized.includes('pg_advisory_lock')) events.push(`s${session}:lock`);
      if (normalized.includes("to_regclass('ag_catalog.ag_graph')")) events.push(`s${session}:catalog`);
      if (normalized.startsWith('INSERT INTO public.schema_migrations')
        && Number(params[0]) === AGE_VERSION) events.push(`s${session}:marker`);
      if (normalized.includes('CREATE EXTENSION IF NOT EXISTS age')) {
        events.push(`s${session}:age-unavailable`);
        const error = new Error('forced AGE unavailable on this certification client') as Error & { code: string };
        error.code = '0A000';
        throw error;
      }
      if (failMarker
        && normalized.startsWith('INSERT INTO public.schema_migrations')
        && Number(params[0]) === AGE_VERSION) {
        events.push(`s${session}:marker-denied`);
        const error = new Error('forced migration marker denial') as Error & { code: string };
        error.code = '42501';
        throw error;
      }
      return originalQuery(...args as Parameters<PoolClient['query']>);
    }) as PoolClient['query'];
    return client;
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

const describeMigrationCertification = process.env.RORCA_RUN_DESTRUCTIVE_MIGRATION_CERT === '1'
  ? describe
  : describe.skip;

describeMigrationCertification('migration AGE session replacement authority (real PostgreSQL) [skip: requires RORCA_RUN_DESTRUCTIVE_MIGRATION_CERT=1; separately certified by migration-real-postgres gate]', () => {
  const connectionString = resolveTestDatabaseUrl();
  const authority = new Pool({ connectionString, max: 2 });
  let originalMarker: Marker;

  beforeAll(async () => {
    await assertConnectedTestDatabase(authority, connectionString);
    const marker = await authority.query<Marker>(
      `SELECT version, filename, skipped_in_lite_mode
         FROM public.schema_migrations WHERE version = $1`,
      [AGE_VERSION],
    );
    if (!marker.rows[0]) throw new Error('Certification DB is missing the AGE migration marker');
    originalMarker = marker.rows[0];
  });

  afterEach(async () => {
    await authority.query('DELETE FROM public.schema_migrations WHERE version = $1', [AGE_VERSION]);
    await authority.query(
      `INSERT INTO public.schema_migrations (version, filename, skipped_in_lite_mode)
       VALUES ($1, $2, $3)`,
      [AGE_VERSION, originalMarker.filename, originalMarker.skipped_in_lite_mode],
    );
  });

  afterAll(async () => {
    await authority.end();
  });

  it('releases the poisoned session, reacquires the lock on replacement, and converges two runners to one durable marker', async () => {
    await authority.query('DELETE FROM public.schema_migrations WHERE version = $1', [AGE_VERSION]);
    const runnerA = new AgeUnavailablePool(connectionString);
    const runnerB = new AgeUnavailablePool(connectionString);
    try {
      await Promise.all([
        runPgMigrations(runnerA as unknown as Pool),
        runPgMigrations(runnerB as unknown as Pool),
      ]);

      const marker = await authority.query<Marker>(
        `SELECT version, filename, skipped_in_lite_mode
           FROM public.schema_migrations WHERE version = $1`,
        [AGE_VERSION],
      );
      expect(marker.rows).toHaveLength(1);
      expect(marker.rows[0].filename).toContain('[skipped: extension unavailable]');
      expect(marker.rows[0].skipped_in_lite_mode).toBe(true);

      for (const events of [runnerA.events, runnerB.events]) {
        const unavailable = events.findIndex((event) => event.endsWith(':age-unavailable'));
        if (unavailable < 0) continue; // The other runner may refresh after the winner.
        const replacementLock = events.findIndex((event, index) => index > unavailable && event.endsWith(':lock'));
        const markerWrite = events.findIndex((event, index) => index > unavailable && event.endsWith(':marker'));
        expect(replacementLock).toBeGreaterThan(unavailable);
        if (markerWrite >= 0) expect(markerWrite).toBeGreaterThan(replacementLock);
        expect(events.some((event) => event.endsWith(':catalog'))).toBe(false);
      }
      expect([...runnerA.events, ...runnerB.events].filter((event) => event.endsWith(':age-unavailable')).length).toBeGreaterThan(0);
    } finally {
      await Promise.all([runnerA.end(), runnerB.end()]);
    }
  }, 60_000);

  it('fails closed when the durable skip marker cannot be written', async () => {
    await authority.query('DELETE FROM public.schema_migrations WHERE version = $1', [AGE_VERSION]);
    const runner = new AgeUnavailablePool(connectionString, true);
    try {
      await expect(runPgMigrations(runner as unknown as Pool)).rejects.toThrow('forced migration marker denial');
      const marker = await authority.query('SELECT version FROM public.schema_migrations WHERE version = $1', [AGE_VERSION]);
      expect(marker.rows).toHaveLength(0);
      expect(runner.events.some((event) => event.endsWith(':marker-denied'))).toBe(true);
    } finally {
      await runner.end();
    }
  }, 60_000);
});
