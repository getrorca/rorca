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

  it('preserves a local *_test database name while applying the selected mode host/port', () => {
    process.env.DATABASE_URL = 'postgres://rorca:rorca@localhost:5433/rorca_test';
    mockReadFileSync.mockImplementation((target: string) => {
      if (target.endsWith('/db-mode')) return 'docker\n';
      if (String(target).includes('/bin/rorca.ts')) return 'const MANAGED_PG_PORT = 5433;';
      throw new Error('missing');
    });
    const { applySelectedDbModeEnvironment } = require('../db-strategy');
    expect(applySelectedDbModeEnvironment()).toEqual({
      mode: 'docker',
      databaseUrl: 'postgres://rorca:rorca@localhost:5432/rorca_test',
      changed: true,
    });
    expect(process.env.DATABASE_URL).toBe('postgres://rorca:rorca@localhost:5432/rorca_test');
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
    await expect(validateByopConnection('postgres://user:secret@db.example.neon.tech:5432/rorca?sslmode=require')).rejects.toMatchObject({
      code: 'PGVECTOR_REQUIRED',
    });
    expect(mockPoolEnd).toHaveBeenCalled();
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
