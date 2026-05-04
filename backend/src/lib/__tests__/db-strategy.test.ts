/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

const mockReadFileSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockChmodSync = jest.fn();
const mockQueryOne = jest.fn();

jest.mock('fs', () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
  chmodSync: (...args: unknown[]) => mockChmodSync(...args),
}));

jest.mock('os', () => ({
  homedir: () => '/tmp/test-home',
}));

jest.mock('../../db', () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));

describe('db-strategy', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
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

  it('returns false for AGE in native mode without querying the database', async () => {
    const { isAgeAvailable } = require('../db-strategy');
    await expect(isAgeAvailable()).resolves.toBe(false);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('returns true for AGE when the extension row exists', async () => {
    process.env.DATABASE_URL = 'postgres://user:pass@db.example.com:5432/rorca';
    mockQueryOne.mockResolvedValue({ present: 1 });
    const { isAgeAvailable } = require('../db-strategy');
    await expect(isAgeAvailable()).resolves.toBe(true);
    expect(mockQueryOne).toHaveBeenCalledWith(
      "SELECT 1 AS present FROM pg_extension WHERE extname = 'age'"
    );
  });
});
