import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PackJsonSchema, type PackJson } from '../pack-registry';

// ─── DB mock ────────────────────────────────────────────────────────────────

const mockRun = jest.fn().mockReturnValue({ changes: 0, lastInsertRowid: 1 });
const mockGet = jest.fn().mockReturnValue(undefined);
const mockAll = jest.fn().mockReturnValue([]);
const mockPrepare = jest.fn().mockReturnValue({
  run: mockRun,
  get: mockGet,
  all: mockAll,
});

jest.mock('../../db/index', () => ({
  db: { prepare: (...args: unknown[]) => mockPrepare(...args) },
}));

// Import after mock
import { PackRegistry, type PackValidationResult } from '../pack-registry';

// ─── Test fixtures ──────────────────────────────────────────────────────────

let tmpDir: string;
let packsDir: string;

function validPackJson(overrides: Partial<PackJson> = {}): PackJson {
  return {
    name: 'test-pack',
    version: '1.0.0',
    description: 'A test convention pack',
    compatibility: { frameworks: [] },
    dependencies: [],
    skills: [],
    ...overrides,
  };
}

function createPackOnDisk(name: string, packJson: object, skillFiles: string[] = []): string {
  const packDir = path.join(packsDir, name);
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'pack.json'), JSON.stringify(packJson, null, 2));

  if (skillFiles.length > 0) {
    const skillsDir = path.join(packDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    for (const sf of skillFiles) {
      fs.writeFileSync(path.join(skillsDir, sf), `# ${sf}\nSkill content.`);
    }
  }

  return packDir;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-registry-test-'));
  packsDir = path.join(tmpDir, '.rorca', 'packs');
  fs.mkdirSync(packsDir, { recursive: true });
  jest.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── PackJsonSchema Tests ───────────────────────────────────────────────────

describe('PackJsonSchema', () => {
  it('validates a minimal valid pack.json', () => {
    const result = PackJsonSchema.safeParse({
      name: 'my-pack',
      version: '1.0.0',
      description: 'A convention pack',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('my-pack');
      expect(result.data.version).toBe('1.0.0');
      expect(result.data.skills).toEqual([]);
      expect(result.data.dependencies).toEqual([]);
      expect(result.data.compatibility.frameworks).toEqual([]);
    }
  });

  it('validates a full pack.json with all fields', () => {
    const result = PackJsonSchema.safeParse({
      name: 'nextjs-saas',
      version: '2.3.1',
      description: 'Convention pack for Next.js SaaS applications',
      compatibility: { node: '>=18.0.0', frameworks: ['next', 'react'] },
      dependencies: ['base-typescript'],
      skills: ['auth.md', 'billing.md', 'crud.md'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.compatibility.node).toBe('>=18.0.0');
      expect(result.data.compatibility.frameworks).toEqual(['next', 'react']);
      expect(result.data.dependencies).toEqual(['base-typescript']);
      expect(result.data.skills).toEqual(['auth.md', 'billing.md', 'crud.md']);
    }
  });

  it('rejects missing name', () => {
    const result = PackJsonSchema.safeParse({
      version: '1.0.0',
      description: 'A pack',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing version', () => {
    const result = PackJsonSchema.safeParse({
      name: 'my-pack',
      description: 'A pack',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing description', () => {
    const result = PackJsonSchema.safeParse({
      name: 'my-pack',
      version: '1.0.0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid version format', () => {
    const result = PackJsonSchema.safeParse({
      name: 'my-pack',
      version: 'latest',
      description: 'A pack',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const versionErr = result.error.issues.find(i => i.path.includes('version'));
      expect(versionErr).toBeDefined();
    }
  });

  it('rejects pack name with uppercase', () => {
    const result = PackJsonSchema.safeParse({
      name: 'MyPack',
      version: '1.0.0',
      description: 'A pack',
    });
    expect(result.success).toBe(false);
  });

  it('rejects pack name with spaces', () => {
    const result = PackJsonSchema.safeParse({
      name: 'my pack',
      version: '1.0.0',
      description: 'A pack',
    });
    expect(result.success).toBe(false);
  });

  it('accepts pack name with dashes', () => {
    const result = PackJsonSchema.safeParse({
      name: 'my-convention-pack',
      version: '0.1.0',
      description: 'A pack',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty name', () => {
    const result = PackJsonSchema.safeParse({
      name: '',
      version: '1.0.0',
      description: 'A pack',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty description', () => {
    const result = PackJsonSchema.safeParse({
      name: 'my-pack',
      version: '1.0.0',
      description: '',
    });
    expect(result.success).toBe(false);
  });
});

// ─── PackRegistry.validatePack ──────────────────────────────────────────────

describe('PackRegistry.validatePack', () => {
  let registry: PackRegistry;

  beforeEach(() => {
    registry = new PackRegistry(tmpDir, 'ws-1');
  });

  it('returns valid for a correct pack directory', () => {
    const packDir = createPackOnDisk('valid-pack', validPackJson());
    const result = registry.validatePack(packDir);
    expect(result.valid).toBe(true);
    expect(result.pack).not.toBeNull();
    expect(result.pack!.name).toBe('test-pack');
    expect(result.errors).toHaveLength(0);
  });

  it('returns invalid when pack.json is missing', () => {
    const packDir = path.join(packsDir, 'missing');
    fs.mkdirSync(packDir, { recursive: true });
    const result = registry.validatePack(packDir);
    expect(result.valid).toBe(false);
    expect(result.pack).toBeNull();
    expect(result.errors[0].message).toContain('pack.json not found');
  });

  it('returns invalid when pack.json has bad JSON', () => {
    const packDir = path.join(packsDir, 'bad-json');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'pack.json'), '{ invalid json }');
    const result = registry.validatePack(packDir);
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Invalid JSON syntax');
  });

  it('returns field-level errors for schema violations', () => {
    const packDir = createPackOnDisk('bad-schema', {
      name: 'Invalid Name!',
      version: 'not-semver',
    });
    const result = registry.validatePack(packDir);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    const paths = result.errors.map(e => e.path);
    expect(paths).toContain('name');
  });

  it('validates skills files exist on disk', () => {
    const packDir = createPackOnDisk('missing-skills', validPackJson({
      skills: ['existing.md', 'missing.md'],
    }), ['existing.md']); // only create existing.md
    const result = registry.validatePack(packDir);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("missing.md");
    expect(result.errors[0].path).toBe('skills');
  });

  it('passes when all declared skills exist', () => {
    const packDir = createPackOnDisk('with-skills', validPackJson({
      skills: ['auth.md', 'crud.md'],
    }), ['auth.md', 'crud.md']);
    const result = registry.validatePack(packDir);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ─── PackRegistry.listInstalled ─────────────────────────────────────────────

describe('PackRegistry.listInstalled', () => {
  let registry: PackRegistry;

  beforeEach(() => {
    registry = new PackRegistry(tmpDir, 'ws-1');
  });

  it('returns empty array when no packs installed', () => {
    mockAll.mockReturnValueOnce([]);
    const packs = registry.listInstalled();
    expect(packs).toEqual([]);
    expect(mockPrepare).toHaveBeenCalledWith(
      expect.stringContaining('SELECT'),
    );
  });

  it('returns installed packs with manifest from disk', () => {
    const packDir = createPackOnDisk('my-pack', validPackJson());
    mockAll.mockReturnValueOnce([{
      id: 1,
      workspace_id: 'ws-1',
      pack_name: 'my-pack',
      pack_version: '1.0.0',
      installed_at: '2026-02-28T00:00:00.000Z',
      pack_path: packDir,
    }]);

    const packs = registry.listInstalled();
    expect(packs).toHaveLength(1);
    expect(packs[0].name).toBe('my-pack');
    expect(packs[0].manifest).not.toBeNull();
    expect(packs[0].manifest!.name).toBe('test-pack');
  });

  it('returns manifest: null when pack directory is missing', () => {
    mockAll.mockReturnValueOnce([{
      id: 1,
      workspace_id: 'ws-1',
      pack_name: 'gone-pack',
      pack_version: '1.0.0',
      installed_at: '2026-02-28T00:00:00.000Z',
      pack_path: '/nonexistent/path',
    }]);

    const packs = registry.listInstalled();
    expect(packs).toHaveLength(1);
    expect(packs[0].name).toBe('gone-pack');
    expect(packs[0].manifest).toBeNull();
  });
});

// ─── PackRegistry.getPackPath ───────────────────────────────────────────────

describe('PackRegistry.getPackPath', () => {
  let registry: PackRegistry;

  beforeEach(() => {
    registry = new PackRegistry(tmpDir, 'ws-1');
  });

  it('returns path from DB when pack is registered', () => {
    mockGet.mockReturnValueOnce({ pack_path: '/some/path/my-pack' });
    const result = registry.getPackPath('my-pack');
    expect(result).toBe('/some/path/my-pack');
  });

  it('falls back to conventional .rorca/packs/<name> directory', () => {
    mockGet.mockReturnValueOnce(undefined);
    const packDir = path.join(packsDir, 'fallback-pack');
    fs.mkdirSync(packDir, { recursive: true });
    const result = registry.getPackPath('fallback-pack');
    expect(result).toBe(packDir);
  });

  it('throws NotFoundError when pack not in DB and not on disk', () => {
    mockGet.mockReturnValueOnce(undefined);
    expect(() => registry.getPackPath('nonexistent')).toThrow(/not found/i);
  });
});

// ─── PackRegistry.registerPack ──────────────────────────────────────────────

describe('PackRegistry.registerPack', () => {
  let registry: PackRegistry;

  beforeEach(() => {
    registry = new PackRegistry(tmpDir, 'ws-1');
  });

  it('registers a valid pack and returns InstalledPack', () => {
    const packDir = createPackOnDisk('new-pack', validPackJson({ name: 'new-pack' }));
    mockGet.mockReturnValueOnce(undefined); // no existing row

    const result = registry.registerPack(packDir);
    expect(result.name).toBe('new-pack');
    expect(result.version).toBe('1.0.0');
    expect(result.manifest).not.toBeNull();
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT'));
  });

  it('updates version when pack already registered', () => {
    const packDir = createPackOnDisk('existing-pack', validPackJson({
      name: 'existing-pack',
      version: '2.0.0',
    }));
    mockGet.mockReturnValueOnce({ id: 42 }); // existing row

    const result = registry.registerPack(packDir);
    expect(result.name).toBe('existing-pack');
    expect(result.version).toBe('2.0.0');
    expect(result.id).toBe(42);
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE'));
  });

  it('throws ValidationError on invalid pack', () => {
    const packDir = path.join(packsDir, 'invalid');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'pack.json'), '{}');
    expect(() => registry.registerPack(packDir)).toThrow(/Invalid pack\.json/);
  });
});

// ─── PackRegistry.unregisterPack ────────────────────────────────────────────

describe('PackRegistry.unregisterPack', () => {
  let registry: PackRegistry;

  beforeEach(() => {
    registry = new PackRegistry(tmpDir, 'ws-1');
  });

  it('deletes DB row for installed pack', () => {
    mockRun.mockReturnValueOnce({ changes: 1, lastInsertRowid: 0 });
    expect(() => registry.unregisterPack('my-pack')).not.toThrow();
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('DELETE'));
  });

  it('throws NotFoundError when pack is not installed', () => {
    mockRun.mockReturnValueOnce({ changes: 0, lastInsertRowid: 0 });
    expect(() => registry.unregisterPack('nonexistent')).toThrow(/not found/i);
  });
});
