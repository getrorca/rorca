/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * CIE-006: Tests for agents-parser.ts
 *
 * Covers: parsing, role matching, violation detection, prompt section building,
 * AGENTS.md serialization, and echolocation generation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseAgentsMd,
  matchRole,
  buildRolePromptSection,
  detectViolations,
  serializeAgentsMd,
  generateAgentsMd,
  loadAgentsMd,
  type AgentRole,
} from '../agents-parser';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agents-test-'));
}

function cleanup(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

describe('parseAgentsMd', () => {
  it('parses a standard AGENTS.md with roles', () => {
    const content = `# AGENTS.md

## Roles

### Frontend Agent
- owns: src/components/**, src/panels/**
- avoids: backend/**
- rules:
  - Never introduce new npm packages without listing alternatives
  - All API calls through apiFetch

### Backend Agent
- owns: backend/src/routes/**, backend/src/lib/**
- avoids: src/**
- rules:
  - Throw AppError subclasses
`;

    const { roles } = parseAgentsMd(content);
    expect(roles).toHaveLength(2);

    expect(roles[0].name).toBe('Frontend Agent');
    expect(roles[0].owns).toEqual(['src/components/**', 'src/panels/**']);
    expect(roles[0].avoids).toEqual(['backend/**']);
    expect(roles[0].rules).toHaveLength(2);
    expect(roles[0].rules[0]).toBe('Never introduce new npm packages without listing alternatives');

    expect(roles[1].name).toBe('Backend Agent');
    expect(roles[1].owns).toEqual(['backend/src/routes/**', 'backend/src/lib/**']);
    expect(roles[1].avoids).toEqual(['src/**']);
    expect(roles[1].rules).toEqual(['Throw AppError subclasses']);
  });

  it('returns empty roles for content without ### headers', () => {
    const { roles } = parseAgentsMd('# Just a title\n\nSome text.');
    expect(roles).toHaveLength(0);
  });

  it('handles roles with no owns/avoids/rules', () => {
    const content = `### Minimal Agent\n- owns: src/**\n`;
    const { roles } = parseAgentsMd(content);
    expect(roles).toHaveLength(1);
    expect(roles[0].name).toBe('Minimal Agent');
    expect(roles[0].owns).toEqual(['src/**']);
    expect(roles[0].avoids).toEqual([]);
    expect(roles[0].rules).toEqual([]);
  });

  it('handles inline rule on same line as rules:', () => {
    const content = `### Agent\n- owns: src/**\n- rules: Do the thing\n`;
    const { roles } = parseAgentsMd(content);
    expect(roles[0].rules).toEqual(['Do the thing']);
  });

  it('stops collecting rules at next non-list line', () => {
    const content = `### Agent A
- rules:
  - Rule 1
  - Rule 2

Some text that ends rules.

### Agent B
- owns: lib/**
`;
    const { roles } = parseAgentsMd(content);
    expect(roles).toHaveLength(2);
    expect(roles[0].rules).toEqual(['Rule 1', 'Rule 2']);
    expect(roles[1].name).toBe('Agent B');
  });
});

// ─── loadAgentsMd ─────────────────────────────────────────────────────────────

describe('loadAgentsMd', () => {
  it('returns empty roles when file does not exist', () => {
    const dir = tmpDir();
    try {
      const { roles, raw } = loadAgentsMd(dir);
      expect(roles).toEqual([]);
      expect(raw).toBe('');
    } finally {
      cleanup(dir);
    }
  });

  it('parses an existing AGENTS.md', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), `### Test\n- owns: src/**\n`);
      const { roles } = loadAgentsMd(dir);
      expect(roles).toHaveLength(1);
      expect(roles[0].name).toBe('Test');
    } finally {
      cleanup(dir);
    }
  });
});

// ─── Role Matching ────────────────────────────────────────────────────────────

describe('matchRole', () => {
  const roles: AgentRole[] = [
    { name: 'Frontend Agent', owns: ['src/components/**', 'src/panels/**'], avoids: ['backend/**'], rules: [] },
    { name: 'Backend Agent', owns: ['backend/src/routes/**', 'backend/src/lib/**'], avoids: ['src/**'], rules: [] },
    { name: 'Database Agent', owns: ['backend/src/db/**'], avoids: [], rules: [] },
  ];

  it('matches frontend role for component-related story', () => {
    const matches = matchRole(
      'Add a new panel component in src/panels/',
      ['Component renders correctly'],
      roles,
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].role.name).toBe('Frontend Agent');
  });

  it('matches backend role for route-related story', () => {
    const matches = matchRole(
      'Create a new API endpoint in backend/src/routes/',
      ['Endpoint returns 200'],
      roles,
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].role.name).toBe('Backend Agent');
  });

  it('matches database role for migration story', () => {
    const matches = matchRole(
      'Add a migration for the new table in the database',
      ['Table created with correct schema'],
      roles,
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].role.name).toBe('Database Agent');
  });

  it('returns empty for unrelated story', () => {
    const matches = matchRole(
      'Write a poem about cats',
      undefined,
      roles,
    );
    expect(matches).toEqual([]);
  });

  it('returns empty for empty roles', () => {
    const matches = matchRole('Any story', undefined, []);
    expect(matches).toEqual([]);
  });
});

// ─── buildRolePromptSection ───────────────────────────────────────────────────

describe('buildRolePromptSection', () => {
  it('builds a complete prompt section', () => {
    const role: AgentRole = {
      name: 'Frontend Agent',
      owns: ['src/components/**'],
      avoids: ['backend/**'],
      rules: ['Use TypeScript strictly'],
    };
    const section = buildRolePromptSection(role);
    expect(section).toContain('## Agent Role: Frontend Agent');
    expect(section).toContain('`src/components/**`');
    expect(section).toContain('`backend/**`');
    expect(section).toContain('Use TypeScript strictly');
  });

  it('omits empty sections', () => {
    const role: AgentRole = { name: 'Minimal', owns: [], avoids: [], rules: [] };
    const section = buildRolePromptSection(role);
    expect(section).toContain('## Agent Role: Minimal');
    expect(section).not.toContain('Owned files');
    expect(section).not.toContain('Avoided files');
    expect(section).not.toContain('Rules');
  });
});

// ─── Violation Detection ──────────────────────────────────────────────────────

describe('detectViolations', () => {
  const role: AgentRole = {
    name: 'Frontend Agent',
    owns: ['src/**'],
    avoids: ['backend/**', 'db/**'],
    rules: [],
  };

  it('detects files matching avoids globs', () => {
    const report = detectViolations(
      ['src/App.tsx', 'backend/src/routes/api.ts', 'db/migrations/001.sql'],
      role,
      'US-001',
    );
    expect(report.violations).toHaveLength(2);
    expect(report.violations[0].file).toBe('backend/src/routes/api.ts');
    expect(report.violations[0].pattern).toBe('backend/**');
    expect(report.violations[1].file).toBe('db/migrations/001.sql');
    expect(report.violations[1].pattern).toBe('db/**');
  });

  it('returns empty violations when no files match avoids', () => {
    const report = detectViolations(
      ['src/App.tsx', 'src/panels/Hub.tsx'],
      role,
      'US-002',
    );
    expect(report.violations).toHaveLength(0);
  });

  it('returns empty violations for role with no avoids', () => {
    const noAvoids: AgentRole = { name: 'Open', owns: ['**'], avoids: [], rules: [] };
    const report = detectViolations(['anything.ts'], noAvoids, 'US-003');
    expect(report.violations).toHaveLength(0);
  });

  it('sets storyId and roleName in report', () => {
    const report = detectViolations([], role, 'US-007');
    expect(report.storyId).toBe('US-007');
    expect(report.roleName).toBe('Frontend Agent');
  });
});

// ─── Serialization ────────────────────────────────────────────────────────────

describe('serializeAgentsMd', () => {
  it('round-trips through parse → serialize → parse', () => {
    const original: AgentRole[] = [
      { name: 'Frontend Agent', owns: ['src/**'], avoids: ['backend/**'], rules: ['Rule 1', 'Rule 2'] },
      { name: 'Backend Agent', owns: ['backend/**'], avoids: ['src/**'], rules: ['Rule A'] },
    ];
    const serialized = serializeAgentsMd(original);
    const { roles } = parseAgentsMd(serialized);

    expect(roles).toHaveLength(2);
    expect(roles[0].name).toBe('Frontend Agent');
    expect(roles[0].owns).toEqual(['src/**']);
    expect(roles[0].avoids).toEqual(['backend/**']);
    expect(roles[0].rules).toEqual(['Rule 1', 'Rule 2']);
    expect(roles[1].name).toBe('Backend Agent');
  });

  it('produces valid markdown headers', () => {
    const content = serializeAgentsMd([{ name: 'Test', owns: [], avoids: [], rules: [] }]);
    expect(content).toContain('# AGENTS.md');
    expect(content).toContain('## Roles');
    expect(content).toContain('### Test');
  });
});

// ─── Echolocation Generation ──────────────────────────────────────────────────

describe('generateAgentsMd', () => {
  it('generates roles from a typical project structure', () => {
    const dir = tmpDir();
    try {
      // Create a minimal project structure
      fs.mkdirSync(path.join(dir, 'src', 'components'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'backend', 'src', 'routes'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'backend', 'src', 'db'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');

      const content = generateAgentsMd(dir);
      const { roles } = parseAgentsMd(content);

      // Should have at least Frontend, Backend, Database agents
      const roleNames = roles.map(r => r.name);
      expect(roleNames).toContain('Frontend Agent');
      expect(roleNames).toContain('Backend Agent');
      expect(roleNames).toContain('Database Agent');

      // Frontend should avoid backend
      const frontend = roles.find(r => r.name === 'Frontend Agent')!;
      expect(frontend.avoids.some(a => a.startsWith('backend'))).toBe(true);

      // Backend should avoid src
      const backend = roles.find(r => r.name === 'Backend Agent')!;
      expect(backend.avoids.some(a => a.startsWith('src'))).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it('returns valid AGENTS.md even for empty directory', () => {
    const dir = tmpDir();
    try {
      const content = generateAgentsMd(dir);
      expect(content).toContain('# AGENTS.md');
      // May have 0 roles (no recognized structure)
      const { roles } = parseAgentsMd(content);
      expect(Array.isArray(roles)).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});
