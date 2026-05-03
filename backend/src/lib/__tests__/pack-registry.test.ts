/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * CA-001: PackRegistry + pack.json schema tests
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── DB Mock ────────────────────────────────────────────────────────────────

const mockRows: Record<string, unknown[]> = {};
const mockSingleRows: Record<string, unknown> = {};
let lastChanges = 1;

/** Normalize whitespace in SQL for lookup-key matching. */
function normSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

jest.mock('../../db/index', () => ({
  query: jest.fn(async (sql: string, ..._args: unknown[]) => {
    const key = Object.keys(mockRows).find(k => normSql(k) === normSql(sql));
    return key ? mockRows[key] : [];
  }),
  queryOne: jest.fn(async (sql: string, ..._args: unknown[]) => {
    const key = Object.keys(mockSingleRows).find(k => normSql(k) === normSql(sql));
    return key !== undefined ? mockSingleRows[key] : undefined;
  }),
  execute: jest.fn(async (_sql: string, ..._args: unknown[]) => ({ rowCount: lastChanges })),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { PackJsonSchema, PackRegistry, type PackJson } from '../pack-registry';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;

function writePackJson(dir: string, content: object) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(content, null, 2));
}

const validPack: PackJson = {
  name: 'react-saas',
  version: '1.0.0',
  description: 'React SaaS starter pack',
  compatibility: { frameworks: ['react', 'next.js'] },
  dependencies: [],
  skills: ['auth', 'billing'],
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-registry-test-'));
  fs.mkdirSync(path.join(tmpDir, '.rorca', 'packs'), { recursive: true });
  jest.clearAllMocks();
  lastChanges = 1;
  // Clear row maps
  for (const key of Object.keys(mockRows)) delete mockRows[key];
  for (const key of Object.keys(mockSingleRows)) delete mockSingleRows[key];
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── PackJsonSchema Tests ───────────────────────────────────────────────────

describe('PackJsonSchema', () => {
  it('validates a complete valid pack.json', () => {
    const result = PackJsonSchema.safeParse(validPack);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('react-saas');
      expect(result.data.version).toBe('1.0.0');
      expect(result.data.skills).toEqual(['auth', 'billing']);
    }
  });

  it('fills defaults for optional fields', () => {
    const result = PackJsonSchema.safeParse({ name: 'minimal', version: '0.1.0' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe('');
      expect(result.data.compatibility).toEqual({ frameworks: [] });
      expect(result.data.dependencies).toEqual([]);
      expect(result.data.skills).toEqual([]);
    }
  });

  it('rejects empty name', () => {
    const result = PackJsonSchema.safeParse({ name: '', version: '1.0.0' });
    expect(result.success).toBe(false);
  });

  it('rejects uppercase pack name', () => {
    const result = PackJsonSchema.safeParse({ name: 'MyPack', version: '1.0.0' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid semver', () => {
    const result = PackJsonSchema.safeParse({ name: 'test', version: 'not-semver' });
    expect(result.success).toBe(false);
  });

  it('accepts semver with pre-release tag', () => {
    const result = PackJsonSchema.safeParse({ name: 'test', version: '1.0.0-beta.1' });
    expect(result.success).toBe(true);
  });

  it('rejects name with spaces', () => {
    const result = PackJsonSchema.safeParse({ name: 'my pack', version: '1.0.0' });
    expect(result.success).toBe(false);
  });

  it('accepts name with dots, hyphens, underscores', () => {
    const cases = ['my-pack', 'my.pack', 'my_pack', 'react-saas.starter'];
    for (const name of cases) {
      const result = PackJsonSchema.safeParse({ name, version: '1.0.0' });
      expect(result.success).toBe(true);
    }
  });

  it('rejects missing version', () => {
    const result = PackJsonSchema.safeParse({ name: 'test' });
    expect(result.success).toBe(false);
  });

  it('validates dependencies array', () => {
    const result = PackJsonSchema.safeParse({
      name: 'test',
      version: '1.0.0',
      dependencies: [{ name: 'base-pack', version: '>=1.0.0' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dependencies).toHaveLength(1);
      expect(result.data.dependencies[0].name).toBe('base-pack');
    }
  });

  it('rejects dependency with empty name', () => {
    const result = PackJsonSchema.safeParse({
      name: 'test',
      version: '1.0.0',
      dependencies: [{ name: '' }],
    });
    expect(result.success).toBe(false);
  });

  it('provides field-level errors on invalid input', () => {
    const result = PackJsonSchema.safeParse({ name: 123, version: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map(i => i.path.join('.'));
      expect(paths).toContain('name');
      expect(paths).toContain('version');
    }
  });
});

// ─── PackRegistry.validatePack Tests ────────────────────────────────────────

describe('PackRegistry.validatePack', () => {
  let registry: PackRegistry;

  beforeEach(() => {
    registry = new PackRegistry(tmpDir, 'ws-1');
  });

  it('returns valid for a correct pack directory', () => {
    const packDir = path.join(tmpDir, '.rorca', 'packs', 'test-pack');
    writePackJson(packDir, validPack);

    const result = registry.validatePack(packDir);
    expect(result.valid).toBe(true);
    expect(result.pack?.name).toBe('react-saas');
    expect(result.errors).toHaveLength(0);
  });

  it('returns error when pack.json is missing', () => {
    const packDir = path.join(tmpDir, '.rorca', 'packs', 'empty');
    fs.mkdirSync(packDir, { recursive: true });

    const result = registry.validatePack(packDir);
    expect(result.valid).toBe(false);
    expect(result.pack).toBeNull();
    expect(result.errors[0].message).toBe('pack.json not found');
  });

  it('returns error for invalid JSON', () => {
    const packDir = path.join(tmpDir, '.rorca', 'packs', 'bad-json');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'pack.json'), '{ broken json');

    const result = registry.validatePack(packDir);
    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('pack.json');
    expect(result.errors[0].message).toContain('Invalid JSON');
  });

  it('returns field-level errors for schema violations', () => {
    const packDir = path.join(tmpDir, '.rorca', 'packs', 'bad-schema');
    writePackJson(packDir, { name: 'INVALID_NAME!', version: 'nope' });

    const result = registry.validatePack(packDir);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    const errorPaths = result.errors.map(e => e.path);
    expect(errorPaths.some(p => p === 'name' || p === 'version')).toBe(true);
  });
});

// ─── PackRegistry.listInstalled Tests ───────────────────────────────────────

describe('PackRegistry.listInstalled', () => {
  let registry: PackRegistry;

  beforeEach(() => {
    registry = new PackRegistry(tmpDir, 'ws-1');
  });

  it('returns empty array when no packs installed', async () => {
    // DB returns empty
    const selectSql = 'SELECT * FROM convention_packs WHERE workspace_id = $1 ORDER BY installed_at DESC';
    mockRows[selectSql] = [];

    const result = await registry.listInstalled();
    expect(result).toEqual([]);
  });

  it('cross-references DB rows with filesystem pack.json', async () => {
    const packDir = path.join(tmpDir, '.rorca', 'packs', 'react-saas');
    writePackJson(packDir, validPack);

    const selectSql = 'SELECT * FROM convention_packs WHERE workspace_id = $1 ORDER BY installed_at DESC';
    mockRows[selectSql] = [{
      id: 1,
      workspace_id: 'ws-1',
      pack_name: 'react-saas',
      pack_version: '1.0.0',
      installed_at: '2026-02-28T00:00:00',
      pack_path: '.rorca/packs/react-saas',
    }];

    const result = await registry.listInstalled();
    expect(result).toHaveLength(1);
    expect(result[0].packJson?.name).toBe('react-saas');
  });

  it('returns null packJson when pack dir is missing from disk', async () => {
    const selectSql = 'SELECT * FROM convention_packs WHERE workspace_id = $1 ORDER BY installed_at DESC';
    mockRows[selectSql] = [{
      id: 1,
      workspace_id: 'ws-1',
      pack_name: 'gone-pack',
      pack_version: '1.0.0',
      installed_at: '2026-02-28T00:00:00',
      pack_path: '.rorca/packs/gone-pack',
    }];

    const result = await registry.listInstalled();
    expect(result).toHaveLength(1);
    expect(result[0].packJson).toBeNull();
  });
});

// ─── PackRegistry.getPackPath Tests ─────────────────────────────────────────

describe('PackRegistry.getPackPath', () => {
  let registry: PackRegistry;

  beforeEach(() => {
    registry = new PackRegistry(tmpDir, 'ws-1');
  });

  it('returns absolute path for installed pack', async () => {
    const selectSql = 'SELECT pack_path FROM convention_packs WHERE workspace_id = $1 AND pack_name = $2';
    mockSingleRows[selectSql] = { pack_path: '.rorca/packs/react-saas' };

    const result = await registry.getPackPath('react-saas');
    expect(result).toBe(path.join(tmpDir, '.rorca/packs/react-saas'));
  });

  it('returns absolute path as-is if pack_path is absolute', async () => {
    const selectSql = 'SELECT pack_path FROM convention_packs WHERE workspace_id = $1 AND pack_name = $2';
    mockSingleRows[selectSql] = { pack_path: '/abs/path/to/pack' };

    const result = await registry.getPackPath('react-saas');
    expect(result).toBe('/abs/path/to/pack');
  });

  it('throws NotFoundError for unknown pack', async () => {
    const selectSql = 'SELECT pack_path FROM convention_packs WHERE workspace_id = $1 AND pack_name = $2';
    mockSingleRows[selectSql] = undefined;

    await expect(registry.getPackPath('nonexistent')).rejects.toThrow(/not found/i);
  });
});

// ─── PackRegistry.register Tests ────────────────────────────────────────────

describe('PackRegistry.register', () => {
  let registry: PackRegistry;

  beforeEach(() => {
    registry = new PackRegistry(tmpDir, 'ws-1');
  });

  it('registers a valid pack and returns DB row', async () => {
    const packDir = path.join(tmpDir, '.rorca', 'packs', 'react-saas');
    writePackJson(packDir, validPack);

    // No existing row
    const existsSql = 'SELECT id FROM convention_packs WHERE workspace_id = $1 AND pack_name = $2';
    mockSingleRows[existsSql] = undefined;

    // After insert, RETURNING * returns the new row
    const insertSql = 'INSERT INTO convention_packs (workspace_id, pack_name, pack_version, pack_path) VALUES ($1, $2, $3, $4) RETURNING *';
    mockSingleRows[insertSql] = {
      id: 1,
      workspace_id: 'ws-1',
      pack_name: 'react-saas',
      pack_version: '1.0.0',
      installed_at: '2026-02-28T00:00:00',
      pack_path: '.rorca/packs/react-saas',
    };

    const result = await registry.register(packDir);
    expect(result.pack_name).toBe('react-saas');
    expect(result.pack_version).toBe('1.0.0');
  });

  it('throws ValidationError for invalid pack', async () => {
    const packDir = path.join(tmpDir, '.rorca', 'packs', 'bad');
    writePackJson(packDir, { name: 'INVALID!', version: 'nope' });

    await expect(registry.register(packDir)).rejects.toThrow(/Invalid pack\.json/);
  });
});

// ─── PackRegistry.unregister Tests ──────────────────────────────────────────

describe('PackRegistry.unregister', () => {
  let registry: PackRegistry;

  beforeEach(() => {
    registry = new PackRegistry(tmpDir, 'ws-1');
  });

  it('throws NotFoundError when pack is not registered', async () => {
    lastChanges = 0;
    await expect(registry.unregister('ghost-pack')).rejects.toThrow(/not found/i);
  });
});

// ─── PackRegistry.scanUnregistered Tests ────────────────────────────────────

describe('PackRegistry.scanUnregistered', () => {
  let registry: PackRegistry;

  beforeEach(() => {
    registry = new PackRegistry(tmpDir, 'ws-1');
  });

  it('returns empty when packs dir does not exist', async () => {
    const reg = new PackRegistry('/nonexistent', 'ws-1');
    expect(await reg.scanUnregistered()).toEqual([]);
  });

  it('finds unregistered packs on disk', async () => {
    const packDir = path.join(tmpDir, '.rorca', 'packs', 'my-pack');
    writePackJson(packDir, { name: 'my-pack', version: '0.1.0' });

    // Not in DB
    const existsSql = 'SELECT id FROM convention_packs WHERE workspace_id = $1 AND pack_name = $2';
    mockSingleRows[existsSql] = undefined;

    const result = await registry.scanUnregistered();
    expect(result).toHaveLength(1);
    expect(result[0].pack.name).toBe('my-pack');
    expect(result[0].dir).toBe(packDir);
  });

  it('skips packs that are already registered', async () => {
    const packDir = path.join(tmpDir, '.rorca', 'packs', 'registered-pack');
    writePackJson(packDir, { name: 'registered-pack', version: '1.0.0' });

    // Already in DB
    const existsSql = 'SELECT id FROM convention_packs WHERE workspace_id = $1 AND pack_name = $2';
    mockSingleRows[existsSql] = { id: 42 };

    const result = await registry.scanUnregistered();
    expect(result).toHaveLength(0);
  });

  it('skips invalid pack directories', async () => {
    const packDir = path.join(tmpDir, '.rorca', 'packs', 'invalid-pack');
    writePackJson(packDir, { name: 'BAD!', version: 'nope' });

    const result = await registry.scanUnregistered();
    expect(result).toHaveLength(0);
  });
});
