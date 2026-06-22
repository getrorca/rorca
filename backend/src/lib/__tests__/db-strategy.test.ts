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
const mockQuery = jest.fn();

jest.mock('fs', () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  chmodSync: (...args: unknown[]) => mockChmodSync(...args),
}));

jest.mock('os', () => ({
  homedir: () => '/tmp/test-home',
}));

jest.mock('../../db/index', () => ({
  detectCloudProvider: jest.fn((connectionString?: string) => (
    connectionString?.includes('supabase') ? 'supabase' : 'self-hosted'
  )),
  query: (...args: unknown[]) => mockQuery(...args),
}));

describe('db-strategy', () => {
  beforeEach(() => {
    jest.resetModules();
    mockReadFileSync.mockReset();
    mockWriteFileSync.mockReset();
    mockMkdirSync.mockReset();
    mockChmodSync.mockReset();
    mockQuery.mockReset();
    delete process.env.DATABASE_URL;
  });

  it('returns byop when DATABASE_URL points to a non-local host', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@db.example.com:5432/rorca';
    const { detectDbMode } = require('../db-strategy');
    expect(detectDbMode()).toBe('byop');
  });

  it('returns docker when db-mode file contains docker', () => {
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

  it('writes db-mode file with chmod 0600', () => {
    const { setDbMode } = require('../db-strategy');
    setDbMode('docker');
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/test-home/.rorca', { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/test-home/.rorca/db-mode',
      'docker\n',
      { mode: 0o600 }
    );
    expect(mockChmodSync).toHaveBeenCalledWith('/tmp/test-home/.rorca/db-mode', 0o600);
  });

  it('returns the native connection string from the CLI-managed port constant', () => {
    mockReadFileSync.mockImplementation((target: string) => {
      if (String(target).includes('/bin/rorca.ts')) return 'const MANAGED_PG_PORT = 5433;';
      throw new Error('missing');
    });
    const { getDbConnectionString } = require('../db-strategy');
    expect(getDbConnectionString('native')).toBe('postgres://rorca:rorca@localhost:5433/rorca');
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

  it('preserves remote DATABASE_URL values in byop mode', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@db.example.com:5432/rorca';
    const { applySelectedDbModeEnvironment } = require('../db-strategy');
    expect(applySelectedDbModeEnvironment()).toEqual({
      mode: 'byop',
      databaseUrl: 'postgres://user:pass@db.example.com:5432/rorca',
      changed: false,
    });
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
