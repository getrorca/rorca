/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  check,
  checkSpec,
  detectRequiredTools,
  findCapableEngine,
  TOOL_CAPABILITY_MATRIX,
  type CapabilityStory,
  type ToolName,
} from '../tool-capability-checker';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStory(overrides: Partial<CapabilityStory> = {}): CapabilityStory {
  return {
    id: 'US-001',
    title: 'Test story',
    description: 'A simple test story',
    acceptanceCriteria: [],
    ...overrides,
  };
}

// ─── Tool Capability Matrix ──────────────────────────────────────────────────

describe('TOOL_CAPABILITY_MATRIX', () => {
  it('claude supports all 10 tools', () => {
    const tools = TOOL_CAPABILITY_MATRIX.claude;
    expect(tools.size).toBe(10);
    expect(tools.has('bash')).toBe(true);
    expect(tools.has('edit')).toBe(true);
    expect(tools.has('read')).toBe(true);
    expect(tools.has('write')).toBe(true);
    expect(tools.has('glob')).toBe(true);
    expect(tools.has('grep')).toBe(true);
    expect(tools.has('webfetch')).toBe(true);
    expect(tools.has('websearch')).toBe(true);
    expect(tools.has('task')).toBe(true);
    expect(tools.has('todowrite')).toBe(true);
  });

  it('opencode supports 8 tools (no task, no todowrite)', () => {
    const tools = TOOL_CAPABILITY_MATRIX.opencode;
    expect(tools.size).toBe(8);
    expect(tools.has('bash')).toBe(true);
    expect(tools.has('glob')).toBe(true);
    expect(tools.has('webfetch')).toBe(true);
    expect(tools.has('task')).toBe(false);
    expect(tools.has('todowrite')).toBe(false);
  });

  it('codex supports 4 tools only', () => {
    const tools = TOOL_CAPABILITY_MATRIX.codex;
    expect(tools.size).toBe(4);
    expect(tools.has('bash')).toBe(true);
    expect(tools.has('edit')).toBe(true);
    expect(tools.has('read')).toBe(true);
    expect(tools.has('write')).toBe(true);
    expect(tools.has('glob')).toBe(false);
    expect(tools.has('grep')).toBe(false);
    expect(tools.has('webfetch')).toBe(false);
    expect(tools.has('websearch')).toBe(false);
  });

  it('ollama supports 4 tools only', () => {
    const tools = TOOL_CAPABILITY_MATRIX.ollama;
    expect(tools.size).toBe(4);
    expect(tools.has('bash')).toBe(true);
    expect(tools.has('edit')).toBe(true);
    expect(tools.has('read')).toBe(true);
    expect(tools.has('write')).toBe(true);
  });
});

// ─── detectRequiredTools ─────────────────────────────────────────────────────

describe('detectRequiredTools', () => {
  it('detects webfetch from description', () => {
    const story = makeStory({ description: 'Use webfetch to get the API docs' });
    const tools = detectRequiredTools(story);
    expect(tools.has('webfetch')).toBe(true);
  });

  it('detects webfetch from "fetch URL" phrase', () => {
    const story = makeStory({ description: 'Fetch URL from the documentation site' });
    const tools = detectRequiredTools(story);
    expect(tools.has('webfetch')).toBe(true);
  });

  it('detects webfetch from "documentation lookup"', () => {
    const story = makeStory({ description: 'Perform a documentation lookup for the API' });
    const tools = detectRequiredTools(story);
    expect(tools.has('webfetch')).toBe(true);
  });

  it('detects websearch from description', () => {
    const story = makeStory({ description: 'Websearch for the latest version info' });
    const tools = detectRequiredTools(story);
    expect(tools.has('websearch')).toBe(true);
  });

  it('detects websearch from "search the web"', () => {
    const story = makeStory({ description: 'Search the web for documentation' });
    const tools = detectRequiredTools(story);
    expect(tools.has('websearch')).toBe(true);
  });

  it('detects glob from "find files"', () => {
    const story = makeStory({ description: 'Find files matching *.ts in the src directory' });
    const tools = detectRequiredTools(story);
    expect(tools.has('glob')).toBe(true);
  });

  it('detects grep from "search codebase"', () => {
    const story = makeStory({ description: 'Search codebase for all usages of apiFetch' });
    const tools = detectRequiredTools(story);
    expect(tools.has('grep')).toBe(true);
  });

  it('detects grep from "find all occurrences"', () => {
    const story = makeStory({ description: 'Find all occurrences of deprecated method' });
    const tools = detectRequiredTools(story);
    expect(tools.has('grep')).toBe(true);
  });

  it('detects task from "subagent"', () => {
    const story = makeStory({ description: 'Use a subagent to explore the codebase' });
    const tools = detectRequiredTools(story);
    expect(tools.has('task')).toBe(true);
  });

  it('detects task from "parallel research"', () => {
    const story = makeStory({ description: 'Parallel research into the three subsystems' });
    const tools = detectRequiredTools(story);
    expect(tools.has('task')).toBe(true);
  });

  it('detects tools from acceptanceCriteria', () => {
    const story = makeStory({
      description: 'Simple story',
      acceptanceCriteria: ['Must search codebase for existing patterns'],
    });
    const tools = detectRequiredTools(story);
    expect(tools.has('grep')).toBe(true);
  });

  it('detects multiple tools from same story', () => {
    const story = makeStory({
      description: 'Search codebase for API patterns, then fetch URL of upstream docs',
    });
    const tools = detectRequiredTools(story);
    expect(tools.has('grep')).toBe(true);
    expect(tools.has('webfetch')).toBe(true);
  });

  it('returns empty set for simple story', () => {
    const story = makeStory({ description: 'Add a button to the settings page' });
    const tools = detectRequiredTools(story);
    expect(tools.size).toBe(0);
  });
});

// ─── check ───────────────────────────────────────────────────────────────────

describe('check', () => {
  it('returns compatible for claude with all tool requirements', () => {
    const story = makeStory({ description: 'Use webfetch and search codebase with subagent' });
    const result = check(story, 'claude');
    expect(result.compatible).toBe(true);
    expect(result.missingTools).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('returns compatible for opencode with webfetch + grep', () => {
    const story = makeStory({ description: 'Use webfetch and search codebase' });
    const result = check(story, 'opencode');
    expect(result.compatible).toBe(true);
    expect(result.missingTools).toEqual([]);
  });

  it('returns incompatible for codex with webfetch', () => {
    const story = makeStory({ id: 'US-007', description: 'Use webfetch to get API docs' });
    const result = check(story, 'codex');
    expect(result.compatible).toBe(false);
    expect(result.missingTools).toContain('webfetch');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('US-007');
    expect(result.warnings[0]).toContain('webfetch');
    expect(result.warnings[0]).toContain('codex');
  });

  it('returns incompatible for codex with glob', () => {
    const story = makeStory({ description: 'Find files matching pattern' });
    const result = check(story, 'codex');
    expect(result.compatible).toBe(false);
    expect(result.missingTools).toContain('glob');
  });

  it('returns incompatible for codex with grep', () => {
    const story = makeStory({ description: 'Search codebase for pattern' });
    const result = check(story, 'codex');
    expect(result.compatible).toBe(false);
    expect(result.missingTools).toContain('grep');
  });

  it('returns incompatible for codex with websearch', () => {
    const story = makeStory({ description: 'Search the web for info' });
    const result = check(story, 'codex');
    expect(result.compatible).toBe(false);
    expect(result.missingTools).toContain('websearch');
  });

  it('returns incompatible for opencode with task tool', () => {
    const story = makeStory({ description: 'Use a subagent to explore' });
    const result = check(story, 'opencode');
    expect(result.compatible).toBe(false);
    expect(result.missingTools).toContain('task');
  });

  it('returns compatible for simple story on any engine', () => {
    const story = makeStory({ description: 'Add a CSS class to the button' });
    expect(check(story, 'claude').compatible).toBe(true);
    expect(check(story, 'opencode').compatible).toBe(true);
    expect(check(story, 'codex').compatible).toBe(true);
    expect(check(story, 'ollama').compatible).toBe(true);
  });

  it('returns multiple missing tools for codex', () => {
    const story = makeStory({
      description: 'Search codebase for patterns, then fetch URL of docs',
    });
    const result = check(story, 'codex');
    expect(result.compatible).toBe(false);
    expect(result.missingTools).toContain('grep');
    expect(result.missingTools).toContain('webfetch');
  });
});

// ─── checkSpec ───────────────────────────────────────────────────────────────

describe('checkSpec', () => {
  it('returns compatible for spec with no tool requirements', () => {
    const stories = [
      makeStory({ id: 'US-001', description: 'Add button' }),
      makeStory({ id: 'US-002', description: 'Add label' }),
    ];
    const report = checkSpec(stories, 'codex');
    expect(report.compatible).toBe(true);
    expect(report.stories).toEqual([]);
  });

  it('reports incompatible stories only', () => {
    const stories = [
      makeStory({ id: 'US-001', description: 'Add button' }),
      makeStory({ id: 'US-002', description: 'Search codebase for pattern' }),
      makeStory({ id: 'US-003', description: 'Fetch URL from API' }),
    ];
    const report = checkSpec(stories, 'codex');
    expect(report.compatible).toBe(false);
    expect(report.stories.length).toBe(2);
    expect(report.stories.map(s => s.storyId)).toEqual(['US-002', 'US-003']);
  });

  it('uses per-story agent override', () => {
    const stories = [
      makeStory({ id: 'US-001', description: 'Search codebase for pattern', agent: 'claude' }),
      makeStory({ id: 'US-002', description: 'Search codebase for pattern' }),
    ];
    // US-001 overrides to claude (compatible), US-002 uses codex (incompatible)
    const report = checkSpec(stories, 'codex');
    expect(report.stories.length).toBe(1);
    expect(report.stories[0].storyId).toBe('US-002');
  });

  it('returns compatible when run agent is claude', () => {
    const stories = [
      makeStory({ id: 'US-001', description: 'Search codebase and fetch URL and use subagent' }),
    ];
    const report = checkSpec(stories, 'claude');
    expect(report.compatible).toBe(true);
  });
});

// ─── findCapableEngine ───────────────────────────────────────────────────────

describe('findCapableEngine', () => {
  it('escalates codex to opencode for glob', () => {
    const required = new Set<ToolName>(['glob']);
    const result = findCapableEngine(required, 'codex');
    expect(result).toBe('opencode');
  });

  it('escalates codex to opencode for webfetch', () => {
    const required = new Set<ToolName>(['webfetch']);
    const result = findCapableEngine(required, 'codex');
    expect(result).toBe('opencode');
  });

  it('escalates codex to claude for task tool', () => {
    const required = new Set<ToolName>(['task']);
    const result = findCapableEngine(required, 'codex');
    expect(result).toBe('claude');
  });

  it('escalates opencode to claude for task tool', () => {
    const required = new Set<ToolName>(['task']);
    const result = findCapableEngine(required, 'opencode');
    expect(result).toBe('claude');
  });

  it('returns null when claude cannot handle (should not happen)', () => {
    // Claude handles everything, but test the boundary
    const required = new Set<ToolName>(['bash']);
    const result = findCapableEngine(required, 'claude');
    expect(result).toBeNull(); // No escalation beyond claude
  });

  it('escalates ollama to opencode for grep', () => {
    const required = new Set<ToolName>(['grep']);
    const result = findCapableEngine(required, 'ollama');
    expect(result).toBe('opencode');
  });

  it('escalates ollama to claude for task', () => {
    const required = new Set<ToolName>(['task']);
    const result = findCapableEngine(required, 'ollama');
    expect(result).toBe('claude');
  });
});

// ─── Mismatch Modes (integration-level) ──────────────────────────────────────

describe('mismatch mode handling', () => {
  it('warn mode: check returns warnings but does not block', () => {
    const story = makeStory({ id: 'US-005', description: 'Fetch URL from docs' });
    const result = check(story, 'codex');
    // In warn mode, caller uses the result but proceeds
    expect(result.compatible).toBe(false);
    expect(result.warnings.length).toBe(1);
    // The caller decides not to block — just log the warnings
  });

  it('reroute mode: findCapableEngine finds a suitable alternative', () => {
    const story = makeStory({ description: 'Search codebase for usages' });
    const result = check(story, 'codex');
    expect(result.compatible).toBe(false);
    const required = detectRequiredTools(story);
    const alt = findCapableEngine(required, 'codex');
    expect(alt).toBe('opencode');
  });

  it('block mode: checkSpec reports all incompatible pairs', () => {
    const stories = [
      makeStory({ id: 'US-001', description: 'Fetch URL from docs' }),
      makeStory({ id: 'US-002', description: 'Search codebase' }),
      makeStory({ id: 'US-003', description: 'Simple edit' }),
    ];
    const report = checkSpec(stories, 'codex');
    expect(report.compatible).toBe(false);
    expect(report.stories.length).toBe(2);
    // Block mode: the caller returns 400 with this report
  });
});
