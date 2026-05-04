/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * CA-007: Tests for agent-personas.ts (PersonaRegistry)
 *
 * Covers: frontmatter parsing, discover(), getPersona(), getReviewers(),
 * getPersonaCatalogForPrompt(), graceful degradation on invalid files.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseFrontmatter,
  PersonaRegistry,
} from '../agent-personas';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'persona-test-'));
}

function cleanup(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
}

function writePersona(
  baseDir: string,
  category: string,
  filename: string,
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const dir = path.join(baseDir, 'personas', category);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);

  const lines: string[] = ['---'];
  for (const [key, val] of Object.entries(frontmatter)) {
    if (Array.isArray(val)) {
      lines.push(`${key}:`);
      for (const item of val) {
        lines.push(`  - "${item}"`);
      }
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(body);

  fs.writeFileSync(filePath, lines.join('\n'));
  return filePath;
}

// ─── parseFrontmatter ────────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  it('parses valid frontmatter with scalar values', () => {
    const content = `---
category: specialist
name: frontend
description: React specialist
reviewPriority: 10
---

You are a frontend specialist.`;

    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.attrs.category).toBe('specialist');
    expect(result!.attrs.name).toBe('frontend');
    expect(result!.attrs.description).toBe('React specialist');
    expect(result!.attrs.reviewPriority).toBe('10');
    expect(result!.body).toBe('You are a frontend specialist.');
  });

  it('parses frontmatter with array values', () => {
    const content = `---
name: backend
triggers:
  - "backend/src/**"
  - "backend/src/routes/**"
---

Body text.`;

    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.attrs.triggers).toEqual(['backend/src/**', 'backend/src/routes/**']);
  });

  it('returns null for content without frontmatter', () => {
    expect(parseFrontmatter('# Just a heading')).toBeNull();
    expect(parseFrontmatter('no frontmatter here')).toBeNull();
  });

  it('returns null for unclosed frontmatter', () => {
    expect(parseFrontmatter('---\nname: test\n')).toBeNull();
  });

  it('handles empty frontmatter', () => {
    const result = parseFrontmatter('---\n---\nBody');
    expect(result).not.toBeNull();
    expect(Object.keys(result!.attrs)).toHaveLength(0);
    expect(result!.body).toBe('Body');
  });

  it('handles empty triggers list', () => {
    const content = `---
name: test
triggers: []
---
Body`;
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.attrs.triggers).toEqual([]);
  });
});

// ─── PersonaRegistry.discover ────────────────────────────────────────────────

describe('PersonaRegistry.discover', () => {
  it('discovers personas from category subdirectories', () => {
    const dir = tmpDir();
    try {
      writePersona(dir, '_specialist', 'frontend.md', {
        category: 'specialist',
        name: 'frontend',
        description: 'React, CSS, UI/UX implementation',
        triggers: ['src/components/**', 'src/panels/**'],
        reviewPriority: 50,
      }, 'You are a frontend specialist agent.');

      writePersona(dir, '_adversarial', 'red-team.md', {
        category: 'adversarial',
        name: 'red-team',
        description: 'Attack vector discovery',
        triggers: ['backend/src/**'],
        reviewPriority: 10,
      }, 'You are a red team agent. Find security vulnerabilities.');

      const registry = new PersonaRegistry();
      registry.discover(dir);

      expect(registry.getAll()).toHaveLength(2);
      expect(registry.getWarnings()).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  it('infers category from directory when frontmatter lacks it', () => {
    const dir = tmpDir();
    try {
      writePersona(dir, '_primary', 'architect.md', {
        name: 'architect',
        description: 'Structural decisions',
      }, 'You are the architect.');

      const registry = new PersonaRegistry();
      registry.discover(dir);

      const persona = registry.getPersona('architect');
      expect(persona).toBeDefined();
      expect(persona!.metadata.category).toBe('primary');
    } finally {
      cleanup(dir);
    }
  });

  it('returns empty when personas directory does not exist', () => {
    const dir = tmpDir();
    try {
      const registry = new PersonaRegistry();
      registry.discover(dir);
      expect(registry.getAll()).toHaveLength(0);
      expect(registry.getWarnings()).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });

  it('warns on invalid frontmatter but does not crash', () => {
    const dir = tmpDir();
    try {
      // Valid persona
      writePersona(dir, '_specialist', 'valid.md', {
        name: 'valid-persona',
        category: 'specialist',
        description: 'A valid persona',
      }, 'Valid body.');

      // Invalid persona — no name
      const invalidDir = path.join(dir, 'personas', '_specialist');
      fs.writeFileSync(
        path.join(invalidDir, 'invalid.md'),
        '---\ncategory: specialist\n---\nBody without name.',
      );

      const registry = new PersonaRegistry();
      registry.discover(dir);

      expect(registry.getAll()).toHaveLength(1);
      expect(registry.getWarnings()).toHaveLength(1);
      expect(registry.getWarnings()[0].message).toContain('name');
    } finally {
      cleanup(dir);
    }
  });

  it('warns on files without frontmatter', () => {
    const dir = tmpDir();
    try {
      const personasDir = path.join(dir, 'personas', '_specialist');
      fs.mkdirSync(personasDir, { recursive: true });
      fs.writeFileSync(path.join(personasDir, 'no-frontmatter.md'), '# Just a heading\n\nSome text.');

      const registry = new PersonaRegistry();
      registry.discover(dir);

      expect(registry.getAll()).toHaveLength(0);
      expect(registry.getWarnings()).toHaveLength(1);
      expect(registry.getWarnings()[0].message).toContain('frontmatter');
    } finally {
      cleanup(dir);
    }
  });

  it('discovers personas in nested subdirectories', () => {
    const dir = tmpDir();
    try {
      // Create a deeply nested persona
      const deepDir = path.join(dir, 'personas', '_specialist', 'sub', 'deep');
      fs.mkdirSync(deepDir, { recursive: true });
      fs.writeFileSync(
        path.join(deepDir, 'nested.md'),
        '---\nname: nested\ncategory: specialist\ndescription: A nested persona\n---\nNested body.',
      );

      const registry = new PersonaRegistry();
      registry.discover(dir);

      expect(registry.getAll()).toHaveLength(1);
      expect(registry.getPersona('nested')).toBeDefined();
    } finally {
      cleanup(dir);
    }
  });

  it('clears previous state on re-discover', () => {
    const dir = tmpDir();
    try {
      writePersona(dir, '_specialist', 'first.md', {
        name: 'first',
        category: 'specialist',
        description: 'First',
      }, 'Body.');

      const registry = new PersonaRegistry();
      registry.discover(dir);
      expect(registry.getAll()).toHaveLength(1);

      // Remove the file and re-discover
      fs.rmSync(path.join(dir, 'personas'), { recursive: true, force: true });
      registry.discover(dir);
      expect(registry.getAll()).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
});

// ─── PersonaRegistry.getPersona ──────────────────────────────────────────────

describe('PersonaRegistry.getPersona', () => {
  it('looks up by name case-insensitively', () => {
    const dir = tmpDir();
    try {
      writePersona(dir, '_specialist', 'frontend.md', {
        name: 'Frontend',
        category: 'specialist',
        description: 'React specialist',
      }, 'Body.');

      const registry = new PersonaRegistry();
      registry.discover(dir);

      expect(registry.getPersona('frontend')).toBeDefined();
      expect(registry.getPersona('Frontend')).toBeDefined();
      expect(registry.getPersona('FRONTEND')).toBeDefined();
    } finally {
      cleanup(dir);
    }
  });

  it('returns undefined for unknown name', () => {
    const registry = new PersonaRegistry();
    expect(registry.getPersona('nonexistent')).toBeUndefined();
  });

  it('returns full Persona with metadata, promptText, and filePath', () => {
    const dir = tmpDir();
    try {
      writePersona(dir, '_review', 'verifier.md', {
        name: 'spec-verifier',
        category: 'review',
        description: 'Consistency checks',
        triggers: ['forge/specs/**'],
        reviewPriority: 5,
      }, 'You verify specs for consistency.');

      const registry = new PersonaRegistry();
      registry.discover(dir);

      const persona = registry.getPersona('spec-verifier')!;
      expect(persona.metadata.category).toBe('review');
      expect(persona.metadata.name).toBe('spec-verifier');
      expect(persona.metadata.description).toBe('Consistency checks');
      expect(persona.metadata.triggers).toEqual(['forge/specs/**']);
      expect(persona.metadata.reviewPriority).toBe(5);
      expect(persona.promptText).toBe('You verify specs for consistency.');
      expect(persona.filePath).toContain('verifier.md');
    } finally {
      cleanup(dir);
    }
  });
});

// ─── PersonaRegistry.getByCategory ───────────────────────────────────────────

describe('PersonaRegistry.getByCategory', () => {
  it('returns personas grouped by category', () => {
    const dir = tmpDir();
    try {
      writePersona(dir, '_specialist', 'frontend.md', {
        name: 'frontend', category: 'specialist', description: 'FE',
      }, 'FE body.');
      writePersona(dir, '_specialist', 'backend.md', {
        name: 'backend', category: 'specialist', description: 'BE',
      }, 'BE body.');
      writePersona(dir, '_adversarial', 'red-team.md', {
        name: 'red-team', category: 'adversarial', description: 'RT',
      }, 'RT body.');

      const registry = new PersonaRegistry();
      registry.discover(dir);

      expect(registry.getByCategory('specialist')).toHaveLength(2);
      expect(registry.getByCategory('adversarial')).toHaveLength(1);
      expect(registry.getByCategory('primary')).toHaveLength(0);
      expect(registry.getByCategory('review')).toHaveLength(0);
    } finally {
      cleanup(dir);
    }
  });
});

// ─── PersonaRegistry.getReviewers ────────────────────────────────────────────

describe('PersonaRegistry.getReviewers', () => {
  let dir: string;
  let registry: PersonaRegistry;

  beforeEach(() => {
    dir = tmpDir();
    writePersona(dir, '_specialist', 'frontend.md', {
      name: 'frontend',
      category: 'specialist',
      description: 'React specialist',
      triggers: ['src/components/**', 'src/panels/**'],
      reviewPriority: 50,
    }, 'FE body.');

    writePersona(dir, '_adversarial', 'security.md', {
      name: 'security',
      category: 'adversarial',
      description: 'Security review',
      triggers: ['backend/src/routes/**', 'backend/src/lib/**'],
      reviewPriority: 10,
    }, 'Security body.');

    writePersona(dir, '_review', 'best-practices.md', {
      name: 'best-practices',
      category: 'review',
      description: 'Convention compliance',
      triggers: ['src/**', 'backend/**'],
      reviewPriority: 90,
    }, 'BP body.');

    writePersona(dir, '_primary', 'architect.md', {
      name: 'architect',
      category: 'primary',
      description: 'Architecture',
      triggers: [],
      reviewPriority: 1,
    }, 'Architect body.');

    registry = new PersonaRegistry();
    registry.discover(dir);
  });

  afterEach(() => cleanup(dir));

  it('returns personas whose triggers match story paths', () => {
    const reviewers = registry.getReviewers(['src/components/Button.tsx']);
    const names = reviewers.map(r => r.metadata.name);
    expect(names).toContain('frontend');
    expect(names).toContain('best-practices');
    expect(names).not.toContain('security');
  });

  it('matches backend paths to security persona', () => {
    const reviewers = registry.getReviewers(['backend/src/routes/api.ts']);
    const names = reviewers.map(r => r.metadata.name);
    expect(names).toContain('security');
    expect(names).toContain('best-practices');
    expect(names).not.toContain('frontend');
  });

  it('sorts by reviewPriority ascending', () => {
    const reviewers = registry.getReviewers(['backend/src/routes/api.ts']);
    for (let i = 1; i < reviewers.length; i++) {
      expect(reviewers[i].metadata.reviewPriority).toBeGreaterThanOrEqual(
        reviewers[i - 1].metadata.reviewPriority,
      );
    }
  });

  it('excludes personas with no triggers', () => {
    const reviewers = registry.getReviewers(['src/components/Button.tsx']);
    const names = reviewers.map(r => r.metadata.name);
    expect(names).not.toContain('architect');
  });

  it('returns empty for no matching paths', () => {
    const reviewers = registry.getReviewers(['docs/README.md']);
    expect(reviewers).toHaveLength(0);
  });

  it('returns empty for empty paths array', () => {
    const reviewers = registry.getReviewers([]);
    expect(reviewers).toHaveLength(0);
  });
});

// ─── PersonaRegistry.getPersonaCatalogForPrompt ──────────────────────────────

describe('PersonaRegistry.getPersonaCatalogForPrompt', () => {
  it('produces a compact catalog grouped by category', () => {
    const dir = tmpDir();
    try {
      writePersona(dir, '_primary', 'architect.md', {
        name: 'architect', category: 'primary', description: 'Structural decisions',
      }, 'Body.');
      writePersona(dir, '_specialist', 'frontend.md', {
        name: 'frontend', category: 'specialist', description: 'React, CSS, UI/UX',
      }, 'Body.');
      writePersona(dir, '_adversarial', 'red-team.md', {
        name: 'red-team', category: 'adversarial', description: 'Attack vector discovery',
      }, 'Body.');
      writePersona(dir, '_review', 'verifier.md', {
        name: 'spec-verifier', category: 'review', description: 'Consistency checks',
      }, 'Body.');

      const registry = new PersonaRegistry();
      registry.discover(dir);

      const catalog = registry.getPersonaCatalogForPrompt();

      expect(catalog).toContain('## Available Agent Personas');
      expect(catalog).toContain('### Primary');
      expect(catalog).toContain('- **architect**: Structural decisions');
      expect(catalog).toContain('### Specialist');
      expect(catalog).toContain('- **frontend**: React, CSS, UI/UX');
      expect(catalog).toContain('### Adversarial');
      expect(catalog).toContain('- **red-team**: Attack vector discovery');
      expect(catalog).toContain('### Review');
      expect(catalog).toContain('- **spec-verifier**: Consistency checks');
    } finally {
      cleanup(dir);
    }
  });

  it('returns empty string when no personas discovered', () => {
    const registry = new PersonaRegistry();
    expect(registry.getPersonaCatalogForPrompt()).toBe('');
  });

  it('omits empty categories', () => {
    const dir = tmpDir();
    try {
      writePersona(dir, '_specialist', 'only.md', {
        name: 'only-one', category: 'specialist', description: 'Sole persona',
      }, 'Body.');

      const registry = new PersonaRegistry();
      registry.discover(dir);

      const catalog = registry.getPersonaCatalogForPrompt();
      expect(catalog).toContain('### Specialist');
      expect(catalog).not.toContain('### Primary');
      expect(catalog).not.toContain('### Adversarial');
      expect(catalog).not.toContain('### Review');
    } finally {
      cleanup(dir);
    }
  });

  it('shows "No description" for personas without description', () => {
    const dir = tmpDir();
    try {
      writePersona(dir, '_specialist', 'nodesc.md', {
        name: 'no-desc', category: 'specialist',
      }, 'Body.');

      const registry = new PersonaRegistry();
      registry.discover(dir);

      const catalog = registry.getPersonaCatalogForPrompt();
      expect(catalog).toContain('- **no-desc**: No description');
    } finally {
      cleanup(dir);
    }
  });
});

// ─── Default reviewPriority ──────────────────────────────────────────────────

describe('default reviewPriority', () => {
  it('defaults to 50 when not specified', () => {
    const dir = tmpDir();
    try {
      writePersona(dir, '_specialist', 'default-prio.md', {
        name: 'default-prio',
        category: 'specialist',
        description: 'Test',
      }, 'Body.');

      const registry = new PersonaRegistry();
      registry.discover(dir);

      const persona = registry.getPersona('default-prio');
      expect(persona!.metadata.reviewPriority).toBe(50);
    } finally {
      cleanup(dir);
    }
  });
});
