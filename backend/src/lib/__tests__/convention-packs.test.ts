/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * CA-002: PackLoader unit tests
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PackLoader } from '../convention-packs';

// ─── DB Mock (required by pack-registry import chain) ────────────────────────

jest.mock('../../db/index', () => ({
  query: jest.fn().mockResolvedValue([]),
  queryOne: jest.fn().mockResolvedValue(undefined),
  execute: jest.fn().mockResolvedValue({ rowCount: 0 }),
  transaction: jest.fn().mockImplementation((fn: Function) => fn()),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let loader: PackLoader;

function writeFile(relativePath: string, content: string) {
  const absPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function writeJson(relativePath: string, content: object) {
  writeFile(relativePath, JSON.stringify(content, null, 2));
}

function mkDir(relativePath: string) {
  fs.mkdirSync(path.join(tmpDir, relativePath), { recursive: true });
}

/** Create a minimal valid pack directory structure. */
function createMinimalPack() {
  writeJson('pack.json', { name: 'test-pack', version: '1.0.0' });
  mkDir('direction');
  writeFile('direction/L1-engineering.md', [
    '---',
    'layer: L1',
    'priority: 0',
    'scope: global',
    '---',
    '# Engineering Principles',
    'Write clean code.',
  ].join('\n'));
  mkDir('scaffold');
  writeFile('scaffold/README.md', '# New Project');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-loader-test-'));
  loader = new PackLoader();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── PackLoader.load — Happy Path ────────────────────────────────────────────

describe('PackLoader.load', () => {
  it('loads a minimal valid pack with required dirs only', () => {
    createMinimalPack();

    const pack = loader.load(tmpDir);

    expect(pack.metadata.name).toBe('test-pack');
    expect(pack.metadata.version).toBe('1.0.0');
    expect(pack.direction).toHaveLength(1);
    expect(pack.direction[0].meta.layer).toBe('L1');
    expect(pack.direction[0].content).toContain('Engineering Principles');
    expect(pack.scaffold.length).toBeGreaterThanOrEqual(1);
    expect(pack.personas).toEqual([]);
    expect(pack.conventions).toEqual([]);
    expect(pack.templates).toEqual([]);
    expect(pack.agents).toBeNull();
  });

  it('loads a full pack with all optional directories', () => {
    createMinimalPack();

    // personas/
    writeFile('personas/_primary/architect.md', [
      '---',
      'category: primary',
      'name: architect',
      'description: Structural decisions',
      'triggers:',
      '  - "src/lib/**"',
      'reviewPriority: 10',
      '---',
      'You are the architect.',
    ].join('\n'));

    // conventions/
    writeFile('conventions/tailwind.md', [
      '---',
      'name: tailwind',
      'description: Tailwind CSS conventions',
      'globs:',
      '  - "**/*.css"',
      '  - "**/*.tsx"',
      'alwaysApply: false',
      '---',
      'Use space-y-4 not manual margin.',
    ].join('\n'));

    // templates/
    writeJson('templates/auth.json', {
      title: 'auth-template',
      userStories: [{ id: 'US-001', title: 'Login' }],
    });

    // AGENTS.md
    writeFile('AGENTS.md', '# File Governance\nFrontend owns src/.');

    const pack = loader.load(tmpDir);

    expect(pack.personas).toHaveLength(1);
    expect(pack.personas[0].metadata.name).toBe('architect');
    expect(pack.personas[0].metadata.category).toBe('primary');
    expect(pack.personas[0].promptText).toBe('You are the architect.');

    expect(pack.conventions).toHaveLength(1);
    expect(pack.conventions[0].meta.name).toBe('tailwind');
    expect(pack.conventions[0].meta.globs).toEqual(['**/*.css', '**/*.tsx']);
    expect(pack.conventions[0].meta.alwaysApply).toBe(false);
    expect(pack.conventions[0].content).toContain('space-y-4');

    expect(pack.templates).toHaveLength(1);
    expect(pack.templates[0].filename).toBe('auth.json');

    expect(pack.agents).toContain('File Governance');
  });
});

// ─── pack.json validation ────────────────────────────────────────────────────

describe('PackLoader — pack.json validation', () => {
  it('throws ValidationError when pack.json is missing', () => {
    mkDir('direction');
    mkDir('scaffold');

    expect(() => loader.load(tmpDir)).toThrow(/pack\.json not found/);
  });

  it('throws ValidationError for invalid JSON', () => {
    writeFile('pack.json', '{ broken');
    mkDir('direction');
    mkDir('scaffold');

    expect(() => loader.load(tmpDir)).toThrow(/Invalid pack\.json/);
  });

  it('throws ValidationError for schema violations', () => {
    writeJson('pack.json', { name: 'UPPERCASE!', version: 'bad' });
    mkDir('direction');
    mkDir('scaffold');

    expect(() => loader.load(tmpDir)).toThrow(/Invalid pack\.json/);
  });
});

// ─── Required directories ────────────────────────────────────────────────────

describe('PackLoader — required directories', () => {
  it('throws ValidationError when direction/ is missing', () => {
    writeJson('pack.json', { name: 'test', version: '1.0.0' });
    mkDir('scaffold');

    expect(() => loader.load(tmpDir)).toThrow(/direction/);
  });

  it('throws ValidationError when scaffold/ is missing', () => {
    writeJson('pack.json', { name: 'test', version: '1.0.0' });
    mkDir('direction');

    expect(() => loader.load(tmpDir)).toThrow(/scaffold/);
  });
});

// ─── direction/ parsing ──────────────────────────────────────────────────────

describe('PackLoader — direction/', () => {
  beforeEach(createMinimalPack);

  it('parses frontmatter with layer, priority, scope', () => {
    writeFile('direction/L2-domain.md', [
      '---',
      'layer: L2',
      'priority: 10',
      'scope: domain',
      '---',
      'SaaS conventions.',
    ].join('\n'));

    const pack = loader.load(tmpDir);
    const l2 = pack.direction.find(d => d.filename === 'L2-domain.md');

    expect(l2).toBeDefined();
    expect(l2!.meta.layer).toBe('L2');
    expect(l2!.meta.priority).toBe(10);
    expect(l2!.meta.scope).toBe('domain');
    expect(l2!.content).toBe('SaaS conventions.');
  });

  it('infers layer from filename when no frontmatter', () => {
    writeFile('direction/L3-project.md', 'No frontmatter here.');

    const pack = loader.load(tmpDir);
    const l3 = pack.direction.find(d => d.filename === 'L3-project.md');

    expect(l3).toBeDefined();
    expect(l3!.meta.layer).toBe('L3');
    expect(l3!.meta.priority).toBe(0);
    expect(l3!.meta.scope).toBe('global');
  });

  it('defaults to L0 when filename has no layer prefix', () => {
    writeFile('direction/custom.md', 'Custom content.');

    const pack = loader.load(tmpDir);
    const custom = pack.direction.find(d => d.filename === 'custom.md');

    expect(custom).toBeDefined();
    expect(custom!.meta.layer).toBe('L0');
  });

  it('ignores non-markdown files in direction/', () => {
    writeFile('direction/notes.txt', 'Not markdown.');

    const pack = loader.load(tmpDir);
    expect(pack.direction.every(d => d.filename.endsWith('.md'))).toBe(true);
  });
});

// ─── personas/ parsing ───────────────────────────────────────────────────────

describe('PackLoader — personas/', () => {
  beforeEach(createMinimalPack);

  it('loads personas from nested subdirectories', () => {
    writeFile('personas/_adversarial/red-team.md', [
      '---',
      'category: adversarial',
      'name: red-team',
      'description: Attack vector discovery',
      '---',
      'Find vulnerabilities.',
    ].join('\n'));

    writeFile('personas/_specialist/frontend.md', [
      '---',
      'category: specialist',
      'name: frontend',
      'description: Frontend development',
      'triggers:',
      '  - "src/**"',
      '---',
      'You own the frontend.',
    ].join('\n'));

    const pack = loader.load(tmpDir);
    expect(pack.personas).toHaveLength(2);

    const redTeam = pack.personas.find(p => p.metadata.name === 'red-team');
    expect(redTeam).toBeDefined();
    expect(redTeam!.metadata.category).toBe('adversarial');
    expect(redTeam!.filename).toContain('red-team.md');
  });

  it('skips persona files without valid frontmatter', () => {
    writeFile('personas/broken.md', 'No frontmatter.');

    const pack = loader.load(tmpDir);
    expect(pack.personas).toHaveLength(0);
  });

  it('skips persona files with invalid category', () => {
    writeFile('personas/bad.md', [
      '---',
      'category: unknown',
      'name: bad',
      'description: Invalid',
      '---',
      'Body.',
    ].join('\n'));

    const pack = loader.load(tmpDir);
    expect(pack.personas).toHaveLength(0);
  });

  it('skips persona files missing required fields', () => {
    writeFile('personas/noname.md', [
      '---',
      'category: primary',
      'description: No name field',
      '---',
      'Body.',
    ].join('\n'));

    const pack = loader.load(tmpDir);
    expect(pack.personas).toHaveLength(0);
  });

  it('returns empty array when personas/ does not exist', () => {
    const pack = loader.load(tmpDir);
    expect(pack.personas).toEqual([]);
  });

  it('defaults reviewPriority to 50', () => {
    writeFile('personas/pm.md', [
      '---',
      'category: primary',
      'name: pm',
      'description: Product Manager',
      '---',
      'Body.',
    ].join('\n'));

    const pack = loader.load(tmpDir);
    expect(pack.personas[0].metadata.reviewPriority).toBe(50);
  });
});

// ─── conventions/ parsing (Agent Skills) ─────────────────────────────────────

describe('PackLoader — conventions/', () => {
  beforeEach(createMinimalPack);

  it('loads convention files with YAML frontmatter', () => {
    writeFile('conventions/prisma.md', [
      '---',
      'name: prisma',
      'description: Prisma ORM conventions',
      'globs:',
      '  - "prisma/**"',
      '  - "**/*.prisma"',
      'alwaysApply: true',
      '---',
      'Always use Prisma for DB access.',
    ].join('\n'));

    const pack = loader.load(tmpDir);
    expect(pack.conventions).toHaveLength(1);
    expect(pack.conventions[0].meta.name).toBe('prisma');
    expect(pack.conventions[0].meta.description).toBe('Prisma ORM conventions');
    expect(pack.conventions[0].meta.globs).toEqual(['prisma/**', '**/*.prisma']);
    expect(pack.conventions[0].meta.alwaysApply).toBe(true);
    expect(pack.conventions[0].content).toBe('Always use Prisma for DB access.');
  });

  it('defaults name from filename when frontmatter has no name', () => {
    writeFile('conventions/eslint.md', [
      '---',
      'description: ESLint rules',
      '---',
      'Use flat config.',
    ].join('\n'));

    const pack = loader.load(tmpDir);
    expect(pack.conventions[0].meta.name).toBe('eslint');
  });

  it('handles convention files without frontmatter', () => {
    writeFile('conventions/readme.md', 'Just plain markdown.');

    const pack = loader.load(tmpDir);
    expect(pack.conventions).toHaveLength(1);
    expect(pack.conventions[0].meta.name).toBe('readme');
    expect(pack.conventions[0].meta.globs).toEqual([]);
    expect(pack.conventions[0].meta.alwaysApply).toBe(false);
    expect(pack.conventions[0].content).toBe('Just plain markdown.');
  });

  it('returns empty array when conventions/ does not exist', () => {
    const pack = loader.load(tmpDir);
    expect(pack.conventions).toEqual([]);
  });

  it('ignores non-markdown files', () => {
    writeFile('conventions/notes.txt', 'Not markdown.');

    const pack = loader.load(tmpDir);
    expect(pack.conventions).toHaveLength(0);
  });
});

// ─── templates/ parsing ──────────────────────────────────────────────────────

describe('PackLoader — templates/', () => {
  beforeEach(createMinimalPack);

  it('loads JSON template files', () => {
    writeJson('templates/crud.json', { title: 'CRUD', userStories: [] });
    writeJson('templates/auth.json', { title: 'Auth', userStories: [] });

    const pack = loader.load(tmpDir);
    expect(pack.templates).toHaveLength(2);
    expect(pack.templates.map(t => t.filename).sort()).toEqual(['auth.json', 'crud.json']);
  });

  it('skips invalid JSON files silently', () => {
    writeFile('templates/broken.json', '{ invalid');

    const pack = loader.load(tmpDir);
    expect(pack.templates).toHaveLength(0);
  });

  it('ignores non-JSON files', () => {
    writeFile('templates/notes.md', 'Not JSON.');

    const pack = loader.load(tmpDir);
    expect(pack.templates).toHaveLength(0);
  });

  it('returns empty array when templates/ does not exist', () => {
    const pack = loader.load(tmpDir);
    expect(pack.templates).toEqual([]);
  });
});

// ─── scaffold/ parsing ───────────────────────────────────────────────────────

describe('PackLoader — scaffold/', () => {
  beforeEach(createMinimalPack);

  it('collects all files and directories recursively', () => {
    writeFile('scaffold/src/index.ts', 'console.log("hello");');
    writeFile('scaffold/src/lib/utils.ts', 'export {}');
    writeFile('scaffold/.gitignore', 'node_modules');

    const pack = loader.load(tmpDir);
    const relPaths = pack.scaffold.map(e => e.relativePath);

    expect(relPaths).toContain('README.md');
    expect(relPaths).toContain('src');
    expect(relPaths).toContain(path.join('src', 'index.ts'));
    expect(relPaths).toContain(path.join('src', 'lib'));
    expect(relPaths).toContain(path.join('src', 'lib', 'utils.ts'));
    expect(relPaths).toContain('.gitignore');
  });

  it('marks directories vs files correctly', () => {
    writeFile('scaffold/src/index.ts', 'code');

    const pack = loader.load(tmpDir);
    const srcDir = pack.scaffold.find(e => e.relativePath === 'src');
    const indexFile = pack.scaffold.find(e => e.relativePath === path.join('src', 'index.ts'));

    expect(srcDir?.isDirectory).toBe(true);
    expect(indexFile?.isDirectory).toBe(false);
  });

  it('provides absolute paths', () => {
    const pack = loader.load(tmpDir);
    for (const entry of pack.scaffold) {
      expect(path.isAbsolute(entry.absolutePath)).toBe(true);
      expect(fs.existsSync(entry.absolutePath)).toBe(true);
    }
  });
});

// ─── AGENTS.md ───────────────────────────────────────────────────────────────

describe('PackLoader — AGENTS.md', () => {
  beforeEach(createMinimalPack);

  it('loads AGENTS.md content when present', () => {
    writeFile('AGENTS.md', '# Governance\nRules here.');

    const pack = loader.load(tmpDir);
    expect(pack.agents).toBe('# Governance\nRules here.');
  });

  it('returns null when AGENTS.md is absent', () => {
    const pack = loader.load(tmpDir);
    expect(pack.agents).toBeNull();
  });
});
