/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockReadFileSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockChmodSync = jest.fn();
const mockUnlinkSync = jest.fn();
const mockQuery = jest.fn();
const mockPoolQuery = jest.fn();
const mockPoolEnd = jest.fn();
const mockPoolCtor = jest.fn((_config?: unknown) => ({
  query: (...args: unknown[]) => mockPoolQuery(...args),
  end: (...args: unknown[]) => mockPoolEnd(...args),
}));
const dedicatedTestDatabaseUrl = process.env.RORCA_TEST_DATABASE_URL;

jest.mock('fs', () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  chmodSync: (...args: unknown[]) => mockChmodSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
}));

jest.mock('os', () => ({
  homedir: () => '/tmp/test-home',
}));

jest.mock('pg', () => ({
  Pool: function Pool(this: unknown, config: unknown) {
    return mockPoolCtor(config);
  },
}));

jest.mock('../../db/index', () => ({
  buildSslConfig: jest.fn().mockReturnValue(undefined),
  detectCloudProvider: jest.fn((connectionString?: string) => {
    const value = connectionString?.toLowerCase() ?? '';
    if (value.includes('supabase')) return 'supabase';
    if (value.includes('neon.tech')) return 'neon';
    if (value.includes('railway')) return 'railway';
    return 'self-hosted';
  }),
  query: (...args: unknown[]) => mockQuery(...args),
}));

describe('db-strategy', () => {
  beforeEach(() => {
    jest.resetModules();
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockMkdirSync.mockReset();
    mockChmodSync.mockReset();
    mockUnlinkSync.mockReset();
    mockQuery.mockReset();
    mockPoolQuery.mockReset();
    mockPoolEnd.mockReset().mockResolvedValue(undefined);
    mockPoolCtor.mockClear();
    delete process.env.DATABASE_URL;
    delete process.env.RORCA_DB_MODE;
  });

  it('honors an explicit process mode over persisted local configuration', () => {
    process.env.RORCA_DB_MODE = 'byop';
    process.env.DATABASE_URL = 'postgres://user:pass@127.0.0.1:55493/rorca_canary_test';
    mockReadFileSync.mockImplementation((target: string) => {
      if (target.endsWith('/db-mode')) return 'native\n';
      if (target.endsWith('/database-url')) return 'postgres://localhost:5433/rorca';
      throw new Error('missing');
    });
    const { detectDbMode, buildDatabaseCapability } = require('../db-strategy');
    expect(detectDbMode()).toBe('byop');
    expect(buildDatabaseCapability({ connected: true }).connection.port).toBe(55493);
  });

  afterEach(() => {
    if (dedicatedTestDatabaseUrl) {
      process.env.DATABASE_URL = dedicatedTestDatabaseUrl;
    } else {
      delete process.env.DATABASE_URL;
    }
  });

  it('returns byop when DATABASE_URL points to a non-local host and no explicit mode is persisted', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@db.example.com:5432/rorca';
    mockReadFileSync.mockImplementation(() => {
      throw new Error('missing');
    });
    const { detectDbMode } = require('../db-strategy');
    expect(detectDbMode()).toBe('byop');
  });

  it('honors an explicit persisted docker mode over a stale remote DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@db.example.com:5432/rorca';
    mockReadFileSync.mockImplementation((target: string) => {
      if (target.endsWith('/db-mode')) return 'docker\n';
      throw new Error('missing');
    });
    const { detectDbMode } = require('../db-strategy');
    expect(detectDbMode()).toBe('docker');
  });

  it('honors a persisted byop mode when a BYOP DATABASE_URL has been saved', () => {
    mockReadFileSync.mockImplementation((target: string) => {
      if (target.endsWith('/db-mode')) return 'byop\n';
      if (target.endsWith('/database-url')) return 'postgres://user:pass@db.example.com:5432/rorca?sslmode=require\n';
      throw new Error('missing');
    });
    const { detectDbMode } = require('../db-strategy');
    expect(detectDbMode()).toBe('byop');
  });

  it('falls back off persisted byop to native when no saved URL or remote env URL exists', () => {
    // db-mode says byop, but no persisted database-url file and no remote DATABASE_URL.
    mockReadFileSync.mockImplementation((target: string) => {
      if (target.endsWith('/db-mode')) return 'byop\n';
      throw new Error('missing');
    });
    const { detectDbMode } = require('../db-strategy');
    expect(detectDbMode()).toBe('native');
  });

  it('returns native by default', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('missing');
    });
    const { detectDbMode } = require('../db-strategy');
    expect(detectDbMode()).toBe('native');
  });

  it('infers docker mode from a local 5432 DATABASE_URL when no mode file exists', () => {
    process.env.DATABASE_URL = 'postgres://rorca:rorca@localhost:5432/rorca';
    mockReadFileSync.mockImplementation(() => {
      throw new Error('missing');
    });
    const { detectDbMode } = require('../db-strategy');
    expect(detectDbMode()).toBe('docker');
  });

  it('writes db-mode file with chmod 0600 and clears persisted BYOP URLs when switching away from byop', () => {
    const { setDbMode } = require('../db-strategy');
    setDbMode('native');
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-home/.rorca', { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/test-home/.rorca/db-mode',
      'native\n',
      { mode: 0o600 }
    );
    expect(mockChmodSync).toHaveBeenCalledWith('/tmp/test-home/.rorca/db-mode', 0o600);
    expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/test-home/.rorca/database-url');
  });

  it('returns the native connection string from the CLI-managed port constant', () => {
    mockReadFileSync.mockImplementation((target: string) => {
      if (String(target).includes('/bin/rorca.ts')) return 'const MANAGED_PG_PORT = 5433;';
      throw new Error('missing');
    });
    const { getDbConnectionString } = require('../db-strategy');
    expect(getDbConnectionString('native')).toBe('postgres://rorca:rorca@localhost:5433/rorca');
  });

  it('returns the persisted BYOP connection string when mode=byop', () => {
    mockReadFileSync.mockImplementation((target: string) => {
      if (target.endsWith('/database-url')) return 'postgres://user:pass@db.example.com:5432/rorca\n';
      throw new Error('missing');
    });
    const { getDbConnectionString } = require('../db-strategy');
    expect(getDbConnectionString('byop')).toBe('postgres://user:pass@db.example.com:5432/rorca');
  });

  it('rewrites a local DATABASE_URL to the persisted docker mode target', () => {
    process.env.DATABASE_URL = 'postgres://rorca:rorca@localhost:5433/rorca';
    mockReadFileSync.mockImplementation((target: string) => {
      if (target.endsWith('/db-mode')) return 'docker\n';
      if (String(target).includes('/bin/rorca.ts')) return 'const MANAGED_PG_PORT = 5433;';
      throw new Error('missing');
    });
    const { applySelectedDbModeEnvironment } = require('../db-strategy');
    expect(applySelectedDbModeEnvironment()).toEqual({
      mode: 'docker',
      databaseUrl: 'postgres://rorca:rorca@localhost:5432/rorca',
      changed: true,
    });
    expect(process.env.DATABASE_URL).toBe('postgres://rorca:rorca@localhost:5432/rorca');
  });

  it.each(['localhost', '127.0.0.1', '[::1]'])('preserves the registered principal for the selected Docker database at %s', (host) => {
    const supplied = `postgres://registered_runtime:existing-credential@${host}:5432/rorca?application_name=rorca-api`;
    process.env.DATABASE_URL = supplied;
    process.env.RORCA_DB_MODE = 'docker';
    const { applySelectedDbModeEnvironment } = require('../db-strategy');
    expect(applySelectedDbModeEnvironment()).toEqual({
      mode: 'docker', databaseUrl: supplied, changed: false,
    });
    expect(process.env.DATABASE_URL).toBe(supplied);
  });

  it.each([
    'postgres://runtime:credential@db.example.com:5432/rorca',
    'postgres://runtime:credential@localhost:5432/other_database',
    'http://runtime:credential@localhost:5432/rorca',
  ])('does not preserve a URL outside the selected local database: %s', (supplied) => {
    process.env.DATABASE_URL = supplied;
    process.env.RORCA_DB_MODE = 'docker';
    const { applySelectedDbModeEnvironment } = require('../db-strategy');
    const selection = applySelectedDbModeEnvironment();
    const selected = new URL(selection.databaseUrl);
    expect([selected.hostname, selected.port, selected.pathname]).toEqual(['localhost', '5432', '/rorca']);
    expect(selection.changed).toBe(true);
  });

  it('hydrates a persisted BYOP DATABASE_URL into process.env on startup', () => {
    mockReadFileSync.mockImplementation((target: string) => {
      if (target.endsWith('/db-mode')) return 'byop\n';
      if (target.endsWith('/database-url')) return 'postgres://user:pass@db.example.com:5432/rorca?sslmode=require\n';
      throw new Error('missing');
    });
    const { applySelectedDbModeEnvironment } = require('../db-strategy');
    expect(applySelectedDbModeEnvironment()).toEqual({
      mode: 'byop',
      databaseUrl: 'postgres://user:pass@db.example.com:5432/rorca?sslmode=require',
      changed: true,
    });
    expect(process.env.DATABASE_URL).toBe('postgres://user:pass@db.example.com:5432/rorca?sslmode=require');
  });

  it('preserves the entire dedicated test credential instead of applying production mode credentials', () => {
    process.env.DATABASE_URL = 'postgres://rorca_test_runner:dedicated@localhost:5433/rorca_test';
    mockReadFileSync.mockImplementation((target: string) => {
      if (target.endsWith('/db-mode')) return 'docker\n';
      if (String(target).includes('/bin/rorca.ts')) return 'const MANAGED_PG_PORT = 5433;';
      throw new Error('missing');
    });
    const { applySelectedDbModeEnvironment } = require('../db-strategy');
    expect(applySelectedDbModeEnvironment()).toEqual({
      mode: 'docker',
      databaseUrl: 'postgres://rorca_test_runner:dedicated@localhost:5433/rorca_test',
      changed: false,
    });
    expect(process.env.DATABASE_URL).toBe('postgres://rorca_test_runner:dedicated@localhost:5433/rorca_test');
  });

  it('redacts credentials from database URLs in the canonical capability model', () => {
    process.env.DATABASE_URL = 'postgres://user:secret@db.example.com:5432/rorca?sslmode=require';
    const { buildDatabaseCapability } = require('../db-strategy');
    const capability = buildDatabaseCapability({
      connected: true,
      dbMode: 'byop',
      extensionStatus: { age: false, vector: true },
      databaseUrl: process.env.DATABASE_URL,
    });

    expect(capability).toMatchObject({
      dbMode: 'byop',
      provider: 'self-hosted',
      graphMode: 'lite',
      extensions: { age: false, vector: true, pgcrypto: false },
    });
    expect(capability.connection.url).toBe('postgres://db.example.com:5432/rorca');
    expect(capability.warnings.some((warning: string) => warning.includes('lite graph mode'))).toBe(true);
  });

  it('disables the graph and warns when the database is unreachable', () => {
    const { buildDatabaseCapability } = require('../db-strategy');
    const capability = buildDatabaseCapability({
      connected: false,
      dbMode: 'docker',
      extensionStatus: { age: false, vector: false },
      databaseUrl: 'postgres://rorca:rorca@localhost:5432/rorca',
    });
    expect(capability.graphMode).toBe('disabled');
    expect(capability.connected).toBe(false);
    expect(capability.warnings.some((warning: string) => /connectivity is unavailable/i.test(warning))).toBe(true);
  });

  it('falls back to lite graph mode when connected without AGE', async () => {
    mockQuery.mockResolvedValue([{ extname: 'vector' }]);
    const { getDatabaseCapability } = require('../db-strategy');
    await expect(getDatabaseCapability()).resolves.toMatchObject({
      graphMode: 'lite',
      extensions: { age: false, vector: true },
      connected: true,
    });
  });

  it('rejects malformed or unsafe BYOP connection strings before persistence', () => {
    const { validateByopDatabaseUrl } = require('../db-strategy');

    expect(() => validateByopDatabaseUrl('https://db.example.com/rorca')).toThrow(/postgres/i);
    expect(() => validateByopDatabaseUrl('postgres://user:pass@db.example.com:5432/rorca?sslmode=disable')).toThrow(/ssl/i);
  });

  it('validates a reachable BYOP database and requires pgvector', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ version: 'PostgreSQL 16.4' }] })
      .mockResolvedValueOnce({ rows: [{ max_connections: '50' }] })
      .mockResolvedValueOnce({ rows: [{ extname: 'vector' }, { extname: 'age' }] });

    const { validateByopConnection } = require('../db-strategy');
    await expect(validateByopConnection('postgres://user:secret@db.example.supabase.co:5432/postgres?sslmode=require')).resolves.toMatchObject({
      provider: 'supabase',
      connection: {
        url: 'postgres://db.example.supabase.co:5432/postgres',
        host: 'db.example.supabase.co',
        port: 5432,
        database: 'postgres',
        local: false,
      },
      extensions: { vector: true, age: true, pgcrypto: false },
      connectionLimit: 50,
      pgVersion: 'PostgreSQL 16.4',
    });
    expect(mockPoolEnd).toHaveBeenCalled();
  });

  it('rejects BYOP databases that do not expose pgvector', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ version: 'PostgreSQL 16.4' }] })
      .mockResolvedValueOnce({ rows: [{ max_connections: '50' }] })
      .mockResolvedValueOnce({ rows: [{ extname: 'age' }] });

    const { validateByopConnection } = require('../db-strategy');
    const rejection = validateByopConnection('postgres://user:secret@db.example.neon.tech:5432/rorca?sslmode=require');
    await expect(rejection).rejects.toMatchObject({ code: 'PGVECTOR_REQUIRED' });
    // The rejection must name the provider and explain how to enable pgvector.
    await expect(rejection).rejects.toThrow(/Neon Postgres/);
    await expect(rejection).rejects.toThrow(/CREATE EXTENSION IF NOT EXISTS vector/);
    await expect(rejection).rejects.toThrow(/docs\/supabase-setup\.md/);
    expect(mockPoolEnd).toHaveBeenCalled();
  });

  it('describePgvectorFix returns mode-specific remediation', () => {
    const { describePgvectorFix } = require('../db-strategy');
    expect(describePgvectorFix('native')).toMatch(/native Postgres/i);
    expect(describePgvectorFix('native')).toMatch(/rorca start/);
    expect(describePgvectorFix('docker')).toMatch(/Docker Postgres image/i);
    expect(describePgvectorFix('docker')).toMatch(/rorca db start/);
    expect(describePgvectorFix('byop', 'supabase')).toMatch(/Supabase Postgres/);
    expect(describePgvectorFix('byop', 'neon')).toMatch(/Neon Postgres/);
  });

  it('assertPgvectorInstalled throws PGVECTOR_REQUIRED only when vector is missing', () => {
    const { assertPgvectorInstalled } = require('../db-strategy');
    expect(() => assertPgvectorInstalled({ vector: true }, 'native')).not.toThrow();
    expect(() => assertPgvectorInstalled({ vector: false }, 'docker')).toThrow(
      expect.objectContaining({ code: 'PGVECTOR_REQUIRED' }),
    );
  });

  it('surfaces a pgvector fix path in capability warnings when vector is missing', async () => {
    mockQuery.mockResolvedValue([{ extname: 'age' }]);
    const { getDatabaseCapability } = require('../db-strategy');
    const capability = await getDatabaseCapability();
    expect(capability.extensions.vector).toBe(false);
    expect(capability.warnings.some((w: string) => /pgvector is not installed/.test(w))).toBe(true);
    expect(capability.warnings.some((w: string) => /CREATE EXTENSION IF NOT EXISTS vector|rorca/.test(w))).toBe(true);
  });

  it('returns full graph capability when AGE is installed', async () => {
    mockQuery.mockResolvedValue([{ extname: 'age' }, { extname: 'vector' }]);
    const { getDatabaseCapability } = require('../db-strategy');

    await expect(getDatabaseCapability()).resolves.toMatchObject({
      graphMode: 'full',
      extensions: { age: true, vector: true, pgcrypto: false },
      connected: true,
    });
  });

  it('returns false for AGE when the canonical capability probe does not find AGE', async () => {
    mockQuery.mockResolvedValue([]);
    const { isAgeAvailable } = require('../db-strategy');
    await expect(isAgeAvailable()).resolves.toBe(false);
    expect(mockQuery).toHaveBeenCalledWith(
      "SELECT extname FROM pg_extension WHERE extname IN ('age', 'vector', 'pgcrypto') ORDER BY extname"
    );
  });

  it('returns true for AGE when the extension row exists', async () => {
    mockQuery.mockResolvedValue([{ extname: 'age' }]);
    const { isAgeAvailable } = require('../db-strategy');
    await expect(isAgeAvailable()).resolves.toBe(true);
  });
});

export {};
