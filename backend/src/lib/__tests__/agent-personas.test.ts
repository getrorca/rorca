/**
 * CA-007: Tests for agent-personas.ts
 *
 * Covers: frontmatter parsing, PersonaRegistry.discover(), indexing by
 * name/category, getReviewers() trigger matching, graceful degradation
 * on invalid frontmatter, and duplicate name handling.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseFrontmatter,
  PersonaRegistry,
  type Persona,
  type PersonaCategory,
} from '../agent-personas';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'persona-test-'));
}

function cleanup(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
}

function writePersona(
  dir: string,
  subdir: string,
  filename: string,
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const targetDir = path.join(dir, 'personas', subdir);
  fs.mkdirSync(targetDir, { recursive: true });
  const filePath = path.join(targetDir, filename);
  const yamlLines = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}:\n${v.map(item => `  - "${item}"`).join('\n')}`;
      }
      if (typeof v === 'string') return `${k}: "${v}"`;
      return `${k}: ${v}`;
    })
    .join('\n');
  fs.writeFileSync(filePath, `---\n${yamlLines}\n---\n${body}`);
  return filePath;
}

// ─── parseFrontmatter ────────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  it('extracts yaml and body from valid frontmatter', () => {
    const content = '---\nname: test\ncategory: primary\n---\nThis is the body.';
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.yaml).toContain('name: test');
    expect(result!.body).toBe('This is the body.');
  });

  it('returns null for content without frontmatter', () => {
    expect(parseFrontmatter('# Just a heading\nSome content')).toBeNull();
  });

  it('returns null for incomplete delimiters', () => {
    expect(parseFrontmatter('---\nname: test\nNo closing delimiter')).toBeNull();
  });

  it('handles empty body after frontmatter', () => {
    const result = parseFrontmatter('---\nname: test\n---\n');
    expect(result).not.toBeNull();
    expect(result!.body).toBe('');
  });
});

// ─── PersonaRegistry.discover ────────────────────────────────────────────────

describe('PersonaRegistry', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it('discovers personas from .rorca/personas/ subdirectories', () => {
    writePersona(dir, '_primary', 'architect.md', {
      category: 'primary',
      name: 'architect',
      description: 'Structural decisions',
      triggers: ['backend/src/lib/**'],
      reviewPriority: 10,
    }, 'You are the architect persona. Focus on system design.');

    writePersona(dir, '_adversarial', 'red-team.md', {
      category: 'adversarial',
      name: 'red-team',
      description: 'Attack vector discovery',
      triggers: ['backend/src/routes/**', 'backend/src/lib/auth*'],
      reviewPriority: 5,
    }, 'You are the red team. Find vulnerabilities.');

    const registry = new PersonaRegistry().discover(dir);
    expect(registry.getAll()).toHaveLength(2);
    expect(registry.getWarnings()).toHaveLength(0);
  });

  it('indexes by name (case-insensitive)', () => {
    writePersona(dir, '_specialist', 'frontend.md', {
      category: 'specialist',
      name: 'Frontend',
      description: 'Frontend specialist',
    }, 'You specialize in React components.');

    const registry = new PersonaRegistry().discover(dir);
    const persona = registry.getPersona('frontend');
    expect(persona).toBeDefined();
    expect(persona!.metadata.name).toBe('Frontend');
    expect(persona!.promptText).toBe('You specialize in React components.');

    // Case-insensitive lookup
    expect(registry.getPersona('FRONTEND')).toBeDefined();
    expect(registry.getPersona('Frontend')).toBeDefined();
  });

  it('indexes by category', () => {
    writePersona(dir, '_review', 'spec-writer.md', {
      category: 'review',
      name: 'spec-writer',
      description: 'Generates exhaustive specs',
      reviewPriority: 1,
    }, 'Write detailed specs.');

    writePersona(dir, '_review', 'best-practices.md', {
      category: 'review',
      name: 'best-practices',
      description: 'Convention enforcement',
      reviewPriority: 20,
    }, 'Enforce conventions.');

    const registry = new PersonaRegistry().discover(dir);
    const reviewPersonas = registry.getByCategory('review');
    expect(reviewPersonas).toHaveLength(2);
    expect(registry.getByCategory('primary')).toHaveLength(0);
  });

  it('getReviewers matches trigger globs against story paths', () => {
    writePersona(dir, '_specialist', 'frontend.md', {
      category: 'specialist',
      name: 'frontend',
      description: 'Frontend specialist',
      triggers: ['src/components/**', 'src/panels/**'],
      reviewPriority: 30,
    }, 'Frontend prompt.');

    writePersona(dir, '_adversarial', 'red-team.md', {
      category: 'adversarial',
      name: 'red-team',
      description: 'Security review',
      triggers: ['backend/src/routes/**', 'backend/src/lib/auth*'],
      reviewPriority: 5,
    }, 'Red team prompt.');

    writePersona(dir, '_specialist', 'database.md', {
      category: 'specialist',
      name: 'database',
      description: 'Database specialist',
      triggers: ['backend/src/db/**'],
      reviewPriority: 20,
    }, 'Database prompt.');

    const registry = new PersonaRegistry().discover(dir);

    // Story touches frontend files — should match frontend persona
    const frontendReviewers = registry.getReviewers([
      'src/components/Button.tsx',
      'src/panels/ForgePanel.tsx',
    ]);
    expect(frontendReviewers).toHaveLength(1);
    expect(frontendReviewers[0].metadata.name).toBe('frontend');

    // Story touches backend routes — should match red-team
    const backendReviewers = registry.getReviewers([
      'backend/src/routes/auth.ts',
    ]);
    expect(backendReviewers).toHaveLength(1);
    expect(backendReviewers[0].metadata.name).toBe('red-team');

    // Story touches nothing matching any trigger
    const noMatch = registry.getReviewers(['README.md']);
    expect(noMatch).toHaveLength(0);
  });

  it('getReviewers sorts by reviewPriority ascending', () => {
    writePersona(dir, '_review', 'low-priority.md', {
      category: 'review',
      name: 'low-priority',
      description: 'Low priority',
      triggers: ['src/**'],
      reviewPriority: 99,
    }, 'Low priority.');

    writePersona(dir, '_review', 'high-priority.md', {
      category: 'review',
      name: 'high-priority',
      description: 'High priority',
      triggers: ['src/**'],
      reviewPriority: 1,
    }, 'High priority.');

    writePersona(dir, '_review', 'mid-priority.md', {
      category: 'review',
      name: 'mid-priority',
      description: 'Mid priority',
      triggers: ['src/**'],
      reviewPriority: 50,
    }, 'Mid priority.');

    const registry = new PersonaRegistry().discover(dir);
    const reviewers = registry.getReviewers(['src/app.tsx']);
    expect(reviewers).toHaveLength(3);
    expect(reviewers[0].metadata.name).toBe('high-priority');
    expect(reviewers[1].metadata.name).toBe('mid-priority');
    expect(reviewers[2].metadata.name).toBe('low-priority');
  });

  it('returns empty list when getReviewers called with empty paths', () => {
    writePersona(dir, '_specialist', 'frontend.md', {
      category: 'specialist',
      name: 'frontend',
      description: 'Frontend',
      triggers: ['src/**'],
      reviewPriority: 10,
    }, 'Prompt.');

    const registry = new PersonaRegistry().discover(dir);
    expect(registry.getReviewers([])).toHaveLength(0);
  });

  // ─── Graceful degradation ──────────────────────────────────────────────────

  it('warns on missing frontmatter but does not crash', () => {
    const personasDir = path.join(dir, 'personas', '_primary');
    fs.mkdirSync(personasDir, { recursive: true });
    fs.writeFileSync(path.join(personasDir, 'bad.md'), '# No frontmatter\nJust text.');

    const registry = new PersonaRegistry().discover(dir);
    expect(registry.getAll()).toHaveLength(0);
    expect(registry.getWarnings()).toHaveLength(1);
    expect(registry.getWarnings()[0].reason).toContain('No valid YAML frontmatter');
  });

  it('warns on invalid YAML but does not crash', () => {
    const personasDir = path.join(dir, 'personas', '_primary');
    fs.mkdirSync(personasDir, { recursive: true });
    fs.writeFileSync(
      path.join(personasDir, 'bad-yaml.md'),
      '---\n  invalid: [yaml: {\n---\nBody text.',
    );

    const registry = new PersonaRegistry().discover(dir);
    expect(registry.getAll()).toHaveLength(0);
    expect(registry.getWarnings()).toHaveLength(1);
    expect(registry.getWarnings()[0].reason).toContain('Invalid YAML');
  });

  it('warns on missing required fields', () => {
    writePersona(dir, '_primary', 'incomplete.md', {
      category: 'primary',
      // missing name and description
    }, 'Body.');

    const registry = new PersonaRegistry().discover(dir);
    expect(registry.getAll()).toHaveLength(0);
    expect(registry.getWarnings()).toHaveLength(1);
    expect(registry.getWarnings()[0].reason).toContain('name');
  });

  it('warns on invalid category value', () => {
    writePersona(dir, '_primary', 'bad-category.md', {
      category: 'invalid_category',
      name: 'bad',
      description: 'Bad category',
    }, 'Body.');

    const registry = new PersonaRegistry().discover(dir);
    expect(registry.getAll()).toHaveLength(0);
    expect(registry.getWarnings()).toHaveLength(1);
    expect(registry.getWarnings()[0].reason).toContain('category');
  });

  it('warns on duplicate persona names', () => {
    writePersona(dir, '_primary', 'architect.md', {
      category: 'primary',
      name: 'architect',
      description: 'First architect',
    }, 'First.');

    writePersona(dir, '_specialist', 'architect-dup.md', {
      category: 'specialist',
      name: 'architect',
      description: 'Duplicate architect',
    }, 'Duplicate.');

    const registry = new PersonaRegistry().discover(dir);
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.getWarnings()).toHaveLength(1);
    expect(registry.getWarnings()[0].reason).toContain('Duplicate persona name');
  });

  it('warns on invalid triggers type', () => {
    writePersona(dir, '_primary', 'bad-triggers.md', {
      category: 'primary',
      name: 'bad-triggers',
      description: 'Has bad triggers',
      triggers: 'not-an-array',
    }, 'Body.');

    const registry = new PersonaRegistry().discover(dir);
    expect(registry.getAll()).toHaveLength(0);
    expect(registry.getWarnings()).toHaveLength(1);
    expect(registry.getWarnings()[0].reason).toContain('triggers must be an array');
  });

  // ─── Edge cases ────────────────────────────────────────────────────────────

  it('returns empty registry when personas dir does not exist', () => {
    const registry = new PersonaRegistry().discover(dir);
    expect(registry.getAll()).toHaveLength(0);
    expect(registry.getWarnings()).toHaveLength(0);
  });

  it('handles empty personas directory', () => {
    fs.mkdirSync(path.join(dir, 'personas'), { recursive: true });
    const registry = new PersonaRegistry().discover(dir);
    expect(registry.getAll()).toHaveLength(0);
  });

  it('defaults reviewPriority to 50 when omitted', () => {
    writePersona(dir, '_specialist', 'qa.md', {
      category: 'specialist',
      name: 'qa',
      description: 'QA specialist',
    }, 'QA prompt.');

    const registry = new PersonaRegistry().discover(dir);
    const qa = registry.getPersona('qa');
    expect(qa).toBeDefined();
    expect(qa!.metadata.reviewPriority).toBe(50);
  });

  it('defaults triggers to empty array when omitted', () => {
    writePersona(dir, '_specialist', 'qa.md', {
      category: 'specialist',
      name: 'qa',
      description: 'QA specialist',
    }, 'QA prompt.');

    const registry = new PersonaRegistry().discover(dir);
    const qa = registry.getPersona('qa');
    expect(qa).toBeDefined();
    expect(qa!.metadata.triggers).toEqual([]);
  });

  it('discovers deeply nested persona files', () => {
    const deepDir = path.join(dir, 'personas', '_specialist', 'deep', 'nested');
    fs.mkdirSync(deepDir, { recursive: true });
    fs.writeFileSync(
      path.join(deepDir, 'deep-persona.md'),
      '---\ncategory: specialist\nname: deep-persona\ndescription: Deeply nested\n---\nDeep prompt.',
    );

    const registry = new PersonaRegistry().discover(dir);
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.getPersona('deep-persona')).toBeDefined();
  });

  it('ignores non-.md files', () => {
    const personasDir = path.join(dir, 'personas', '_primary');
    fs.mkdirSync(personasDir, { recursive: true });
    fs.writeFileSync(path.join(personasDir, 'notes.txt'), 'not a persona');
    fs.writeFileSync(path.join(personasDir, 'config.json'), '{}');

    const registry = new PersonaRegistry().discover(dir);
    expect(registry.getAll()).toHaveLength(0);
    expect(registry.getWarnings()).toHaveLength(0);
  });

  it('re-discover resets state', () => {
    writePersona(dir, '_primary', 'architect.md', {
      category: 'primary',
      name: 'architect',
      description: 'Architect',
    }, 'First discovery.');

    const registry = new PersonaRegistry();
    registry.discover(dir);
    expect(registry.getAll()).toHaveLength(1);

    // Remove the file and re-discover
    fs.rmSync(path.join(dir, 'personas'), { recursive: true, force: true });
    registry.discover(dir);
    expect(registry.getAll()).toHaveLength(0);
  });
});

// ─── Default Personas Integration ─────────────────────────────────────────────

describe('Default personas (default-personas/ directory)', () => {
  const defaultPersonasDir = path.resolve(__dirname, '../../../../default-personas');
  let rorcaDir: string;

  beforeEach(() => {
    rorcaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'default-personas-test-'));
    // Copy default-personas/ into temp .rorca/personas/ to simulate install
    const destPersonas = path.join(rorcaDir, 'personas');
    copyDirSync(defaultPersonasDir, destPersonas);
  });

  afterEach(() => {
    try { fs.rmSync(rorcaDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('discovers all 15 default personas with zero warnings', () => {
    const registry = new PersonaRegistry().discover(rorcaDir);
    const warnings = registry.getWarnings();
    expect(warnings).toHaveLength(0);
    expect(registry.getAll()).toHaveLength(16);
  });

  it('has correct category distribution: 3 primary, 3 adversarial, 7 specialist, 3 review', () => {
    const registry = new PersonaRegistry().discover(rorcaDir);
    expect(registry.getByCategory('primary')).toHaveLength(3);
    expect(registry.getByCategory('adversarial')).toHaveLength(3);
    expect(registry.getByCategory('specialist')).toHaveLength(7);
    expect(registry.getByCategory('review')).toHaveLength(3);
  });

  it('can look up every expected persona by name', () => {
    const registry = new PersonaRegistry().discover(rorcaDir);
    const expected = [
      'architect', 'pm', 'lead-dev',
      'red-team', 'assumption-buster', 'devils-advocate',
      'frontend', 'backend', 'database', 'security', 'sre', 'ux-designer', 'qa',
      'spec-writer', 'spec-verifier', 'best-practices',
    ];
    for (const name of expected) {
      const persona = registry.getPersona(name);
      expect(persona).toBeDefined();
      expect(persona!.promptText.length).toBeGreaterThan(200);
    }
  });

  it('every persona has non-empty triggers', () => {
    const registry = new PersonaRegistry().discover(rorcaDir);
    for (const persona of registry.getAll()) {
      expect(persona.metadata.triggers.length).toBeGreaterThan(0);
    }
  });

  it('reviewer matching works with default trigger globs', () => {
    const registry = new PersonaRegistry().discover(rorcaDir);
    // A story touching auth routes should match red-team and security
    const authReviewers = registry.getReviewers(['backend/src/routes/auth.ts']);
    const names = authReviewers.map(p => p.metadata.name);
    expect(names).toContain('red-team');
    expect(names).toContain('security');
  });
});

// ─── Helper: recursive dir copy ───────────────────────────────────────────────

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
