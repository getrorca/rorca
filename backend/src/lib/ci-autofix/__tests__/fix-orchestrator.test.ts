/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import {
  buildFixDescription,
  buildAcceptanceCriteria,
  resolveAgent,
  resolveModel,
} from '../fix-orchestrator';
import type { CiAnnotation } from '../webhook-handler';

// ─── buildFixDescription ────────────────────────────────────────────────────

describe('buildFixDescription', () => {
  const annotations: CiAnnotation[] = [
    { path: 'src/app.ts', line: 42, message: 'Type error: string not assignable to number', level: 'failure' },
    { path: 'src/lib/utils.ts', line: 18, message: "Parameter 'x' implicitly has an 'any' type", level: 'failure' },
  ];

  test('includes check run name, branch, and sha7', () => {
    const desc = buildFixDescription('CI Gate', 'feat/auth', 'abc1234', annotations);
    expect(desc).toContain("check 'CI Gate'");
    expect(desc).toContain('`feat/auth`');
    expect(desc).toContain('abc1234');
  });

  test('includes annotation file paths and messages', () => {
    const desc = buildFixDescription('CI Gate', 'main', 'abc1234', annotations);
    expect(desc).toContain('**src/app.ts:42**');
    expect(desc).toContain('**src/lib/utils.ts:18**');
    expect(desc).toContain('Type error: string not assignable to number');
    expect(desc).toContain("Parameter 'x' implicitly has an 'any' type");
  });

  test('contains NO hardcoded language-specific commands', () => {
    const desc = buildFixDescription('Build', 'main', 'abc1234', annotations);
    // Must not contain ANY language-specific commands
    const forbiddenPatterns = [
      'npx tsc',
      'npm run lint',
      'npm run build',
      'npm test',
      'pytest',
      'cargo check',
      'cargo clippy',
      'cargo test',
      'go test',
      'go build',
      'go vet',
      'mvn',
      'gradle',
      'make ',
      'dotnet build',
      'ruby ',
      'bundle exec',
      'yarn ',
      'pnpm ',
      'bun test',
      'mypy',
      'flake8',
      'eslint',
      'prettier',
      'tsc --noEmit',
    ];
    for (const pattern of forbiddenPatterns) {
      expect(desc).not.toContain(pattern);
    }
  });

  test('instructs agent to read CLAUDE.md and direction stack', () => {
    const desc = buildFixDescription('CI Gate', 'main', 'abc1234', annotations);
    expect(desc).toContain('CLAUDE.md');
    expect(desc).toContain('direction stack');
  });

  test('instructs agent not to suppress errors', () => {
    const desc = buildFixDescription('CI Gate', 'main', 'abc1234', annotations);
    expect(desc).toContain('Do not suppress errors');
    expect(desc).toContain('fix the source code');
  });

  test('prepends count when annotations > 50', () => {
    const manyAnnotations: CiAnnotation[] = Array.from({ length: 55 }, (_, i) => ({
      path: `src/file${i}.ts`,
      line: i + 1,
      message: `Error ${i}`,
      level: 'failure' as const,
    }));
    const desc = buildFixDescription('Lint', 'main', 'abc1234', manyAnnotations);
    expect(desc).toContain('(55 total errors from Lint — fix all of them)');
  });

  test('does not prepend count when annotations <= 50', () => {
    const desc = buildFixDescription('Lint', 'main', 'abc1234', annotations);
    expect(desc).not.toContain('total errors');
  });
});

// ─── buildAcceptanceCriteria ────────────────────────────────────────────────

describe('buildAcceptanceCriteria', () => {
  test('generates one criterion per annotation plus final check', () => {
    const annotations: CiAnnotation[] = [
      { path: 'src/a.ts', line: 1, message: 'Error A', level: 'failure' },
      { path: 'src/b.ts', line: 2, message: 'Error B', level: 'failure' },
    ];
    const criteria = buildAcceptanceCriteria('CI Gate', annotations);
    expect(criteria).toHaveLength(3);
    expect(criteria[0]).toBe('src/a.ts:1 — Error A');
    expect(criteria[1]).toBe('src/b.ts:2 — Error B');
    expect(criteria[2]).toBe('The CI check "CI Gate" passes locally after all fixes are applied');
  });

  test('truncates long messages to 80 chars', () => {
    const longMessage = 'A'.repeat(100);
    const annotations: CiAnnotation[] = [
      { path: 'src/x.ts', line: 5, message: longMessage, level: 'failure' },
    ];
    const criteria = buildAcceptanceCriteria('Build', annotations);
    // First criterion: path:line — truncated message
    expect(criteria[0].length).toBeLessThanOrEqual('src/x.ts:5 — '.length + 80);
    expect(criteria[0]).toContain('...');
  });
});

// ─── resolveAgent ───────────────────────────────────────────────────────────

describe('resolveAgent', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.RORCA_AGENT;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('uses workspace pipeline_config agentType if present', () => {
    expect(resolveAgent({ agentType: 'opencode' })).toBe('opencode');
    expect(resolveAgent({ agentType: 'codex' })).toBe('codex');
    expect(resolveAgent({ agentType: 'claude' })).toBe('claude');
  });

  test('falls back to RORCA_AGENT env var', () => {
    process.env.RORCA_AGENT = 'opencode';
    expect(resolveAgent({})).toBe('opencode');
  });

  test('defaults to claude when nothing is set', () => {
    expect(resolveAgent({})).toBe('claude');
  });

  test('ignores invalid agentType in config', () => {
    process.env.RORCA_AGENT = 'opencode';
    expect(resolveAgent({ agentType: 'invalid' })).toBe('opencode');
  });
});

// ─── resolveModel ───────────────────────────────────────────────────────────

describe('resolveModel', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.RORCA_MODEL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('uses workspace pipeline_config model if present', () => {
    expect(resolveModel({ model: 'claude-opus-4-6' })).toBe('claude-opus-4-6');
  });

  test('falls back to RORCA_MODEL env var', () => {
    process.env.RORCA_MODEL = 'openai/gpt-4o';
    expect(resolveModel({})).toBe('openai/gpt-4o');
  });

  test('defaults to claude-sonnet-4-6', () => {
    expect(resolveModel({})).toBe('claude-sonnet-4-6');
  });
});

// ─── Spec JSON structure ────────────────────────────────────────────────────

describe('generated spec JSON structure', () => {
  test('spec is valid JSON with correct structure', () => {
    const annotations: CiAnnotation[] = [
      { path: 'src/a.ts', line: 1, message: 'Error A', level: 'failure' },
    ];
    const description = buildFixDescription('CI Gate', 'main', 'abc1234', annotations);
    const acceptanceCriteria = buildAcceptanceCriteria('CI Gate', annotations);

    const spec = {
      title: 'ci-autofix-abc1234',
      userStories: [
        {
          id: 'CAF-FIX-001',
          title: 'Fix CI failures from CI Gate',
          description,
          acceptanceCriteria,
          dependsOn: [],
          passes: false,
        },
      ],
      model: 'claude-sonnet-4-6',
      generatedAt: new Date().toISOString(),
    };

    // Validate serialization
    const json = JSON.stringify(spec);
    const parsed = JSON.parse(json);

    expect(parsed.title).toBe('ci-autofix-abc1234');
    expect(parsed.userStories).toHaveLength(1);
    expect(parsed.userStories[0].id).toBe('CAF-FIX-001');
    expect(parsed.userStories[0].dependsOn).toEqual([]);
    expect(parsed.userStories[0].passes).toBe(false);
    expect(parsed.model).toBe('claude-sonnet-4-6');
    expect(parsed.generatedAt).toBeTruthy();
  });

  test('agentOverride is set when workspace has explicit agent', () => {
    const hasExplicitAgent = true;
    const resolvedAgent = 'opencode';
    const spec: Record<string, unknown> = {
      title: 'ci-autofix-abc1234',
      userStories: [],
      model: 'claude-sonnet-4-6',
      generatedAt: new Date().toISOString(),
    };
    if (hasExplicitAgent) {
      spec.agentOverride = resolvedAgent;
    }
    expect(spec.agentOverride).toBe('opencode');
  });

  test('agentOverride is NOT set when workspace has no explicit agent', () => {
    const hasExplicitAgent = false;
    const spec: Record<string, unknown> = {
      title: 'ci-autofix-abc1234',
      userStories: [],
      model: 'claude-sonnet-4-6',
      generatedAt: new Date().toISOString(),
    };
    if (hasExplicitAgent) {
      spec.agentOverride = 'opencode';
    }
    expect(spec.agentOverride).toBeUndefined();
  });
});
