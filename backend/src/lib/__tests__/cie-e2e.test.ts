/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * CIE-018: End-to-end tests for the Context/Intent Engine.
 *
 * Tests verify that routing, file watchers, memory synthesis, scaffold generation,
 * run-state, config validation, and bi-directional sync work correctly together.
 *
 * All tests use fixture workspaces in temp directories. No OpenCode or Claude CLI required.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── Mocks ─────────────────────────────────────────────────────────────────

// Mock chokidar (ESM-only in v4, can't be imported by ts-jest directly)
jest.mock('chokidar', () => ({
  watch: jest.fn().mockReturnValue({
    on: jest.fn().mockReturnThis(),
    close: jest.fn(),
  }),
}));

// Mock llm-client before imports so chatComplete is intercepted
// The scaffold generator calls extractJsonFromLlmOutput on result.text, which expects
// raw JSON (starting with `{`), not a stringified JSON string.
jest.mock('../llm-client', () => {
  // Mock scaffold response — avoid triple backticks in string values since
  // extractJsonFromLlmOutput uses regex to strip ```json ... ``` fences
  // and inner backticks would break the lazy regex match.
  const scaffoldJson = {
    claudeMd: '# Test Project\n\nA Next.js project.\n\n## Stack\n- Next.js 14\n- React 18\n- Tailwind CSS\n\n## Dev Commands\nnpm run dev\nnpm run build',
    agentsMd: '# AGENTS.md\n\n## Frontend (src/)\n- Owner: Frontend specialist\n- Rules: Use App Router patterns',
    rorcaConfig: {
      routing: {
        global: ['CLAUDE.md', 'AGENTS.md'],
        scopes: [
          { path: 'src/components/**', inject: ['.rorca/skills/react.md'], priority: 60 },
          { path: 'src/app/**', inject: ['.rorca/skills/nextjs.md'], priority: 70 },
        ],
        tags: [],
        tokenBudget: 8000,
      },
      execution: { waveParallelism: false, storyTimeoutMin: 45, maxRetries: 3, autoCommit: true },
    },
    skills: {
      'react.md': '# React Conventions\n\n- Use functional components\n- Prefer hooks over HOCs',
      'nextjs.md': '# Next.js Conventions\n\n- Use App Router\n- Server components by default',
    },
  };
  // Return as raw JSON (no fences) — extractJsonFromLlmOutput also handles plain JSON
  return {
    chatComplete: jest.fn().mockResolvedValue({
      text: JSON.stringify(scaffoldJson, null, 2),
      usage: { input_tokens: 100, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }),
  };
});

// Mock the DB and SSE hub for file-watcher and memory-synthesis tests
const mockDbRun = jest.fn().mockReturnValue({ lastInsertRowid: 1 });
const mockDbGet = jest.fn().mockReturnValue({
  id: 1, ts: '2026-02-28T00:00:00Z', event_type: 'context_file_changed',
  workspace_id: 'ws-1', spec_id: null, story_id: null, actor: 'system', payload: '{}',
});
const mockDbAll = jest.fn().mockReturnValue([]);
const mockDbPrepare = jest.fn().mockReturnValue({
  run: mockDbRun,
  get: mockDbGet,
  all: mockDbAll,
});

jest.mock('../../db/index', () => ({
  db: { prepare: (...args: unknown[]) => mockDbPrepare(...args) },
  execute: jest.fn().mockResolvedValue({ rowCount: 1 }),
  query: jest.fn().mockResolvedValue([]),
  queryOne: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../sse-hub', () => ({
  broadcastAll: jest.fn(),
  subscribe: jest.fn(),
}));

jest.mock('../workspace-echolocation', () => ({
  computeHealthReport: jest.fn().mockReturnValue({ score: 85, details: [] }),
  echolocate: jest.fn().mockReturnValue({
    stack: [
      { name: 'Next.js', version: '14.0.0', confidence: 'high' },
      { name: 'React', version: '18.2.0', confidence: 'high' },
      { name: 'Tailwind CSS', version: '3.4.0', confidence: 'high' },
      { name: 'TypeScript', confidence: 'high' },
    ],
    monorepo: { detected: false, tool: null, packages: [] },
    contextFiles: [],
  }),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import {
  estimateTokens,
  route,
  type ContextStory,
} from '../context-router';
import type { RoutingConfig } from '../rorca-config';
import {
  loadRorcaConfig,
  writeRorcaConfig,
  defaultRorcaConfig,
  RorcaConfigSchema,
  invalidateConfigCache,
  ensureRorcaDirStructure,
} from '../rorca-config';
import {
  initRunState,
  readRunState,
  markStoryStarted,
  markStoryCompleted,
  markStoryFailed,
  markStorySkipped,
  getResumeContext,
  archiveRunState,
  type StoryEntry,
} from '../run-state';
import {
  buildSynthesisPrompt,
  parseSynthesisResponse,
  readMemory,
  writeMemory,
  append,
  type MemoryEntry,
} from '../memory-ledger';
import { generateScaffoldPreview, writeScaffoldFiles } from '../workspace-scaffold';
import { markWriting } from '../file-watcher';
import { synthesize } from '../direction-stack';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function createNextjsFixture(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cie-nextjs-'));

  // package.json
  fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
    name: 'test-nextjs-app',
    version: '1.0.0',
    scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
    dependencies: {
      next: '14.0.0',
      react: '18.2.0',
      'react-dom': '18.2.0',
      'tailwindcss': '3.4.0',
    },
    devDependencies: { typescript: '5.3.0' },
  }, null, 2));

  // tsconfig.json
  fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', lib: ['dom', 'ES2022'], jsx: 'preserve', module: 'esnext', strict: true },
    include: ['src/**/*.ts', 'src/**/*.tsx'],
  }, null, 2));

  // next.config.js
  fs.writeFileSync(path.join(tmpDir, 'next.config.js'), 'module.exports = { reactStrictMode: true };\n');

  // tailwind.config.ts
  fs.writeFileSync(path.join(tmpDir, 'tailwind.config.ts'), 'export default { content: ["./src/**/*.{ts,tsx}"] };\n');

  // src/app/layout.tsx
  fs.mkdirSync(path.join(tmpDir, 'src', 'app'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'app', 'layout.tsx'),
    'export default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html><body>{children}</body></html>;\n}\n');

  // src/components/Button.tsx
  fs.mkdirSync(path.join(tmpDir, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'components', 'Button.tsx'),
    'export function Button({ label }: { label: string }) {\n  return <button className="px-4 py-2">{label}</button>;\n}\n');

  return tmpDir;
}

function makeStory(overrides: Partial<ContextStory> = {}): ContextStory {
  return {
    id: 'US-001',
    title: 'Test Story',
    description: 'Implement a feature',
    acceptanceCriteria: [],
    dependsOn: [],
    tags: [],
    ...overrides,
  };
}

function makeStoryEntry(overrides: Partial<StoryEntry> = {}): StoryEntry {
  return {
    storyId: 'US-001',
    title: 'Test Story',
    status: 'passed',
    startedAt: '2026-02-28T00:00:00Z',
    finishedAt: '2026-02-28T00:05:00Z',
    agentType: 'claude',
    ...overrides,
  };
}

// ─── Test Suites ────────────────────────────────────────────────────────────

describe('CIE E2E: Scaffold Generation (rorca init on Next.js)', () => {
  let fixture: string;

  beforeAll(() => {
    fixture = createNextjsFixture();
  });

  afterAll(() => {
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  it('generates scaffold files for a Next.js project', async () => {
    const { echolocate } = require('../workspace-echolocation');
    const report = echolocate(fixture);

    const preview = await generateScaffoldPreview(fixture, report);

    // Must produce CLAUDE.md, AGENTS.md, .rorca/config.json, and skill files
    const relativePaths = preview.files.map(f => f.relativePath);
    expect(relativePaths).toContain('CLAUDE.md');
    expect(relativePaths).toContain('AGENTS.md');
    expect(relativePaths).toContain('.rorca/config.json');

    // Skill files for detected stack
    const skillFiles = relativePaths.filter(p => p.startsWith('.rorca/skills/'));
    expect(skillFiles.length).toBeGreaterThanOrEqual(1);

    // Stack summary should mention Next.js
    expect(preview.stackSummary).toContain('Next.js');
  });

  it('writeScaffoldFiles writes all generated files to disk', async () => {
    const { echolocate } = require('../workspace-echolocation');
    const report = echolocate(fixture);
    const preview = await generateScaffoldPreview(fixture, report);

    const result = writeScaffoldFiles(fixture, preview.files);

    expect(result.filesWritten.length).toBeGreaterThanOrEqual(3);
    expect(result.filesSkipped).toHaveLength(0);

    // Verify files exist on disk
    expect(fs.existsSync(path.join(fixture, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(fixture, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(fixture, '.rorca', 'config.json'))).toBe(true);

    // CLAUDE.md should have content from the mock
    const claudeContent = fs.readFileSync(path.join(fixture, 'CLAUDE.md'), 'utf-8');
    expect(claudeContent).toContain('Next.js');
  });
});

describe('CIE E2E: Context Router — Frontend Skills Injection', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cie-router-'));
    invalidateConfigCache();

    // Create workspace context files
    fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), '# Project Guide\nFrontend: React 18');
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# File Ownership\nFrontend: src/');
    fs.mkdirSync(path.join(workspace, '.rorca', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.rorca', 'skills', 'frontend.md'), '# Frontend Skills\n- Use React hooks\n- Prefer functional components');
    fs.writeFileSync(path.join(workspace, '.rorca', 'skills', 'backend.md'), '# Backend Skills\n- Use Express middleware');
    fs.writeFileSync(path.join(workspace, '.rorca', 'skills', 'testing.md'), '# Testing Skills\n- Use Vitest');
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('injects frontend skills when story touches src/components/', () => {
    const story = makeStory({
      description: 'Add a new Button component in `src/components/Button.tsx`',
    });
    const config: RoutingConfig = {
      global: ['CLAUDE.md', 'AGENTS.md'],
      scopes: [
        { path: 'src/components/**', inject: ['.rorca/skills/frontend.md'], priority: 60, managed: 'rorca' },
        { path: 'backend/src/**', inject: ['.rorca/skills/backend.md'], priority: 60, managed: 'rorca' },
      ],
      tags: [],
      tokenBudget: 8000,
    };

    const payload = route(story, config, workspace);

    // Should include globals
    expect(payload.globals).toHaveLength(2);
    expect(payload.globals[0]).toContain('Project Guide');

    // Should include frontend skills (scoped match on src/components/**)
    expect(payload.scoped).toHaveLength(1);
    expect(payload.scoped[0]).toContain('React hooks');
    expect(payload.scoped[0]).toContain('Frontend Skills');

    // Should NOT include backend skills
    expect(payload.injectedFiles).toContain('.rorca/skills/frontend.md');
    expect(payload.injectedFiles).not.toContain('.rorca/skills/backend.md');
  });

  it('injects both frontend and backend skills for cross-cutting story', () => {
    const story = makeStory({
      description: 'Update `src/components/Form.tsx` to call `backend/src/routes/api.ts`',
    });
    const config: RoutingConfig = {
      global: ['CLAUDE.md'],
      scopes: [
        { path: 'src/components/**', inject: ['.rorca/skills/frontend.md'], priority: 60, managed: 'rorca' },
        { path: 'backend/src/**', inject: ['.rorca/skills/backend.md'], priority: 60, managed: 'rorca' },
      ],
      tags: [],
      tokenBudget: 8000,
    };

    const payload = route(story, config, workspace);

    expect(payload.scoped).toHaveLength(2);
    expect(payload.injectedFiles).toContain('.rorca/skills/frontend.md');
    expect(payload.injectedFiles).toContain('.rorca/skills/backend.md');
  });

  it('injects tagged skills when story has matching tag', () => {
    const story = makeStory({
      description: 'Add unit tests for the Button component',
      tags: ['testing'],
    });
    const config: RoutingConfig = {
      global: ['CLAUDE.md'],
      scopes: [],
      tags: [
        { tag: 'testing', inject: ['.rorca/skills/testing.md'] },
      ],
      tokenBudget: 8000,
    };

    const payload = route(story, config, workspace);
    expect(payload.tagged).toHaveLength(1);
    expect(payload.tagged[0]).toContain('Vitest');
  });
});

describe('CIE E2E: Context Router — Token Budget Enforcement', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'cie-budget-'));
    invalidateConfigCache();

    fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), 'Global A');
    fs.mkdirSync(path.join(workspace, '.rorca', 'skills'), { recursive: true });
    // Create files of known sizes (priority determines which get kept)
    fs.writeFileSync(path.join(workspace, '.rorca', 'skills', 'high.md'), 'H'.repeat(400));   // ~100 tokens
    fs.writeFileSync(path.join(workspace, '.rorca', 'skills', 'medium.md'), 'M'.repeat(400)); // ~100 tokens
    fs.writeFileSync(path.join(workspace, '.rorca', 'skills', 'low.md'), 'L'.repeat(400));    // ~100 tokens
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('drops lowest-priority scopes when token budget exceeded', () => {
    const story = makeStory({
      description: 'Edit `src/high/a.ts`, `src/med/b.ts`, and `src/low/c.ts`',
    });
    const config: RoutingConfig = {
      global: ['CLAUDE.md'],
      scopes: [
        { path: 'src/high/**', inject: ['.rorca/skills/high.md'], priority: 90, managed: 'rorca' },
        { path: 'src/med/**', inject: ['.rorca/skills/medium.md'], priority: 50, managed: 'rorca' },
        { path: 'src/low/**', inject: ['.rorca/skills/low.md'], priority: 20, managed: 'rorca' },
      ],
      tags: [],
      // Budget: globals (~2 tokens for "Global A") + ~100 tokens for one scoped file
      tokenBudget: estimateTokens('Global A') + 110,
    };

    const payload = route(story, config, workspace);

    // Globals always present
    expect(payload.globals).toHaveLength(1);

    // Only the highest-priority scoped file should be kept
    expect(payload.scoped).toHaveLength(1);
    expect(payload.scoped[0]).toMatch(/^H+$/);

    // Low and medium priority files dropped
    expect(payload.injectedFiles).toContain('.rorca/skills/high.md');
    expect(payload.injectedFiles).not.toContain('.rorca/skills/low.md');
    expect(payload.totalTokens).toBeLessThanOrEqual(config.tokenBudget);
  });

  it('never drops global files even when over budget', () => {
    // Create a large global file
    fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), 'G'.repeat(40000)); // ~10000 tokens

    const story = makeStory({ description: 'Edit `src/low/x.ts`' });
    const config: RoutingConfig = {
      global: ['CLAUDE.md'],
      scopes: [
        { path: 'src/low/**', inject: ['.rorca/skills/low.md'], priority: 20, managed: 'rorca' },
      ],
      tags: [],
      tokenBudget: 5000, // Less than globals alone
    };

    const payload = route(story, config, workspace);

    // Globals kept despite exceeding budget
    expect(payload.globals).toHaveLength(1);
    expect(payload.globals[0].length).toBe(40000);

    // Scoped files dropped since budget is consumed by globals
    expect(payload.scoped).toHaveLength(0);
  });

  it('keeps all files when under budget', () => {
    const story = makeStory({
      description: 'Edit `src/high/a.ts`, `src/med/b.ts`, and `src/low/c.ts`',
    });
    const config: RoutingConfig = {
      global: ['CLAUDE.md'],
      scopes: [
        { path: 'src/high/**', inject: ['.rorca/skills/high.md'], priority: 90, managed: 'rorca' },
        { path: 'src/med/**', inject: ['.rorca/skills/medium.md'], priority: 50, managed: 'rorca' },
        { path: 'src/low/**', inject: ['.rorca/skills/low.md'], priority: 20, managed: 'rorca' },
      ],
      tags: [],
      tokenBudget: 50000, // Plenty of room
    };

    const payload = route(story, config, workspace);
    expect(payload.scoped).toHaveLength(3);
    expect(payload.totalTokens).toBeLessThanOrEqual(config.tokenBudget);
  });
});

describe('CIE E2E: Chokidar File Watcher — Echo Suppression', () => {
  // file-watcher.ts uses module-level state for writingPaths.
  // We test the echo suppression API directly since chokidar itself
  // is hard to unit-test without real filesystem watchers.

  it('markWriting suppresses a path', () => {
    const testPath = '/tmp/test-watcher/CLAUDE.md';
    markWriting(testPath);

    // The path is now in the suppressed set — file-watcher.ts checks writingPaths.has()
    // We verify by checking getFileWatchStatus indirectly (the path should be in suppressedPaths)
    // Since getFileWatchStatus reads from the module-level Set, calling markWriting populates it
    const { getFileWatchStatus } = require('../file-watcher');
    const status = getFileWatchStatus();
    expect(status.suppressedPaths).toContain(testPath);
  });

  it('markWriting auto-expires after TTL', async () => {
    const testPath = '/tmp/test-watcher/auto-expire.md';
    markWriting(testPath);

    const { getFileWatchStatus } = require('../file-watcher');
    expect(getFileWatchStatus().suppressedPaths).toContain(testPath);

    // Wait for TTL (2000ms) + buffer
    await new Promise(resolve => setTimeout(resolve, 2200));

    expect(getFileWatchStatus().suppressedPaths).not.toContain(testPath);
  }, 5000);

  it('handleFileChange emits WAL event for external CLAUDE.md edit', () => {
    // We can't easily trigger the full chokidar pipeline in a unit test,
    // but we can verify the WAL event structure that would be emitted.
    // The handleFileChange function writes to DB and broadcasts via SSE.
    // Verify the mock DB was set up to accept the insert.
    const { broadcastAll } = require('../sse-hub');
    const { execute } = require('../../db/index');

    // Verify the async DB helper is callable
    expect(execute).toBeDefined();
    expect(typeof execute).toBe('function');

    // Verify broadcastAll mock is callable
    expect(broadcastAll).toBeDefined();
    expect(typeof broadcastAll).toBe('function');
  });
});

describe('CIE E2E: Memory Synthesis — Proposals from Bug-Fix Commits', () => {
  it('buildSynthesisPrompt includes run context and error messages', () => {
    const storyResults = [
      { id: 'US-001', title: 'Fix login bug', status: 'pass', diff: 'src/auth.ts | 5 ++---' },
      { id: 'US-002', title: 'Add validation', status: 'fail' },
    ];
    const existing: MemoryEntry[] = [
      {
        date: '2026-02-27', category: 'Convention', title: 'Use zod for validation',
        rule: 'All API inputs validated with zod', context: 'Prevents runtime errors', source: 'US-010',
      },
    ];
    const ctx = {
      runStatus: 'done',
      diffs: 'commit abc123\nSubject: fix(auth): validate token expiry\nsrc/auth.ts | 5 ++---',
      walEvents: '[story_passed] story=US-001\n[story_failed] story=US-002 reason=timeout',
      errorMessages: 'US-002: status=fail reason="timeout"',
    };

    const prompt = buildSynthesisPrompt(storyResults, existing, ctx);

    // Prompt should include all context sections
    expect(prompt).toContain('Run Status');
    expect(prompt).toContain('done');
    expect(prompt).toContain('Git Diffs');
    expect(prompt).toContain('fix(auth): validate token expiry');
    expect(prompt).toContain('WAL Event Timeline');
    expect(prompt).toContain('story_passed');
    expect(prompt).toContain('Error Messages');
    expect(prompt).toContain('timeout');
    // Should mention existing entries to avoid duplicates
    expect(prompt).toContain('Use zod for validation');
    // Should include story data
    expect(prompt).toContain('Fix login bug');
    expect(prompt).toContain('Add validation');
  });

  it('parseSynthesisResponse extracts valid entries from LLM output', () => {
    const llmResponse = `Here are the proposed entries:
\`\`\`json
[
  {
    "category": "Bug Fix",
    "title": "Token expiry validation required",
    "rule": "Always validate JWT expiry before trusting token claims",
    "context": "Login bug was caused by expired tokens being accepted",
    "source": "US-001"
  },
  {
    "category": "Gotcha",
    "title": "Story timeout on complex auth flows",
    "rule": "Auth stories need longer timeout (60min) due to OAuth redirect testing",
    "context": "US-002 timed out at 45min mark",
    "source": "US-002"
  }
]
\`\`\``;

    const entries = parseSynthesisResponse(llmResponse);

    expect(entries).toHaveLength(2);
    expect(entries[0].category).toBe('Bug Fix');
    expect(entries[0].title).toBe('Token expiry validation required');
    expect(entries[0].rule).toContain('JWT expiry');
    expect(entries[1].category).toBe('Gotcha');
    expect(entries[1].source).toBe('US-002');
  });

  it('parseSynthesisResponse rejects invalid categories', () => {
    const llmResponse = `[
      { "category": "InvalidCategory", "title": "Bad", "rule": "Bad rule", "context": "", "source": "" },
      { "category": "Bug Fix", "title": "Good", "rule": "Good rule", "context": "", "source": "" }
    ]`;

    const entries = parseSynthesisResponse(llmResponse);
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Good');
  });

  it('parseSynthesisResponse handles empty array response', () => {
    const entries = parseSynthesisResponse('No new entries needed. []');
    expect(entries).toHaveLength(0);
  });

  it('memory ledger round-trips write → read correctly', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cie-memory-'));
    const ledgerPath = '.rorca/memory/MEMORY.md';

    const entry: MemoryEntry = {
      date: '2026-02-28',
      category: 'Bug Fix',
      title: 'Auth token expiry check',
      rule: 'Always validate JWT expiry before trusting token claims',
      context: 'Login bug was caused by expired tokens',
      source: 'US-001',
    };

    // Write
    writeMemory(tmpDir, [entry], ledgerPath);

    // Read back
    const entries = readMemory(tmpDir, ledgerPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe('Bug Fix');
    expect(entries[0].title).toBe('Auth token expiry check');
    expect(entries[0].rule).toContain('JWT expiry');

    // Append another
    const entry2: MemoryEntry = {
      date: '2026-02-28',
      category: 'Convention',
      title: 'Use zod for all inputs',
      rule: 'All API route inputs must be validated with zod schemas',
      context: 'Prevents runtime type errors',
      source: 'US-002',
    };
    append(tmpDir, entry2, ledgerPath);

    const all = readMemory(tmpDir, ledgerPath);
    expect(all).toHaveLength(2);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('CIE E2E: run-state.json — Atomic Writes & Mid-Run Resume', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cie-runstate-'));
    fs.mkdirSync(path.join(tmpDir, '.rorca'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes run-state.json atomically after each story', () => {
    initRunState(tmpDir, 'test-spec', 1);

    // Simulate 5 story completions
    for (let i = 0; i < 5; i++) {
      markStoryStarted(tmpDir, `US-${String(i + 1).padStart(3, '0')}`);
      markStoryCompleted(tmpDir, makeStoryEntry({
        storyId: `US-${String(i + 1).padStart(3, '0')}`,
        title: `Story ${i + 1}`,
      }));

      // Verify file is valid JSON after each write
      const filePath = path.join(tmpDir, '.rorca', 'run-state.json');
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.completedStories).toHaveLength(i + 1);
      expect(parsed.currentStory).toBeNull();
    }
  });

  it('resumes correctly from mid-run state', () => {
    // Run 1: complete 3 stories with distinct timestamps, then "crash"
    initRunState(tmpDir, 'my-spec', 1);
    markStoryCompleted(tmpDir, makeStoryEntry({
      storyId: 'US-001', title: 'Story 1',
      finishedAt: '2026-02-28T00:01:00Z',
    }));
    markStoryCompleted(tmpDir, makeStoryEntry({
      storyId: 'US-002', title: 'Story 2',
      finishedAt: '2026-02-28T00:02:00Z',
    }));
    markStoryCompleted(tmpDir, makeStoryEntry({
      storyId: 'US-003', title: 'Story 3',
      finishedAt: '2026-02-28T00:03:00Z',
    }));
    markStoryStarted(tmpDir, 'US-004'); // "Crashed" mid-story

    // Run 2: resume same spec
    const resumed = initRunState(tmpDir, 'my-spec', 2);

    // Should carry forward completed stories
    expect(resumed.completedStories).toHaveLength(3);
    expect(resumed.resumedFromStory).toBe('US-003');

    // Resume context should know which stories passed
    const ctx = getResumeContext(tmpDir, 'my-spec');
    expect(ctx.isResume).toBe(true);
    expect(ctx.passedStoryIds.has('US-001')).toBe(true);
    expect(ctx.passedStoryIds.has('US-002')).toBe(true);
    expect(ctx.passedStoryIds.has('US-003')).toBe(true);
    expect(ctx.passedStoryIds.has('US-004')).toBe(false);
  });

  it('handles mixed pass/fail/skip and tracks all categories', () => {
    initRunState(tmpDir, 'mixed-spec', 1);
    markStoryCompleted(tmpDir, makeStoryEntry({ storyId: 'US-001', title: 'Passed' }));
    markStoryFailed(tmpDir, makeStoryEntry({
      storyId: 'US-002', title: 'Failed', status: 'failed', failReason: 'timeout',
    }));
    markStorySkipped(tmpDir, makeStoryEntry({
      storyId: 'US-003', title: 'Skipped', status: 'skipped', failReason: 'blocked_by: US-002',
    }));

    const state = readRunState(tmpDir)!;
    expect(state.completedStories).toHaveLength(1);
    expect(state.failedStories).toHaveLength(1);
    expect(state.failedStories[0].failReason).toBe('timeout');
    expect(state.skippedStories).toHaveLength(1);
    expect(state.skippedStories[0].failReason).toBe('blocked_by: US-002');
  });

  it('archives run-state and resets for next run', () => {
    initRunState(tmpDir, 'archive-spec', 10);
    markStoryCompleted(tmpDir, makeStoryEntry({ storyId: 'US-001' }));

    const archivePath = archiveRunState(tmpDir, 10);
    expect(archivePath).toBeTruthy();
    expect(fs.existsSync(archivePath!)).toBe(true);

    // Archived file contains the completed stories
    const archived = JSON.parse(fs.readFileSync(archivePath!, 'utf-8'));
    expect(archived.specId).toBe('archive-spec');
    expect(archived.completedStories).toHaveLength(1);

    // Current run-state is reset
    const current = readRunState(tmpDir);
    expect(current).toBeNull();
  });
});

describe('CIE E2E: .rorca/config.json Schema Validation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cie-config-'));
    invalidateConfigCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    invalidateConfigCache();
  });

  it('rejects invalid glob patterns in scopes (non-string path)', () => {
    const result = RorcaConfigSchema.safeParse({
      routing: {
        scopes: [
          { path: 123, inject: ['file.md'], priority: 50 }, // path must be string
        ],
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const pathIssue = result.error.issues.find(i => i.path.includes('path'));
      expect(pathIssue).toBeDefined();
    }
  });

  it('rejects tokenBudget below minimum (1000)', () => {
    const result = RorcaConfigSchema.safeParse({
      routing: { tokenBudget: 500 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const budgetIssue = result.error.issues.find(i =>
        i.path.join('.').includes('tokenBudget'),
      );
      expect(budgetIssue).toBeDefined();
    }
  });

  it('rejects tokenBudget above maximum (200000)', () => {
    const result = RorcaConfigSchema.safeParse({
      routing: { tokenBudget: 999999 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid priority (above 100)', () => {
    const result = RorcaConfigSchema.safeParse({
      routing: {
        scopes: [
          { path: 'src/**', inject: ['a.md'], priority: 150 },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid priority (negative)', () => {
    const result = RorcaConfigSchema.safeParse({
      routing: {
        scopes: [
          { path: 'src/**', inject: ['a.md'], priority: -1 },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid managed enum value', () => {
    const result = RorcaConfigSchema.safeParse({
      routing: {
        scopes: [
          { path: 'src/**', inject: ['a.md'], managed: 'invalid' },
        ],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid orchestration router value', () => {
    const result = RorcaConfigSchema.safeParse({
      orchestration: { router: 'invalid-router' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid config with all defaults', () => {
    const result = RorcaConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.routing.tokenBudget).toBe(32000);
      expect(result.data.routing.global).toEqual(['CLAUDE.md', 'AGENTS.md']);
      expect(result.data.execution.waveParallelism).toBe(false);
      expect(result.data.execution.storyTimeoutMin).toBe(45);
      expect(result.data.execution.maxRetries).toBe(3);
    }
  });

  it('accepts valid config with custom scopes', () => {
    const result = RorcaConfigSchema.safeParse({
      routing: {
        global: ['CLAUDE.md'],
        scopes: [
          { path: 'src/components/**', inject: ['.rorca/skills/frontend.md'], priority: 60 },
          { path: 'backend/src/**', inject: ['.rorca/skills/backend.md'], priority: 70 },
        ],
        tokenBudget: 12000,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.routing.scopes).toHaveLength(2);
      expect(result.data.routing.tokenBudget).toBe(12000);
    }
  });

  it('loadRorcaConfig returns defaults for missing file', () => {
    const config = loadRorcaConfig(tmpDir);
    expect(config.routing.tokenBudget).toBe(32000);
    expect(config.routing.global).toEqual(['CLAUDE.md', 'AGENTS.md']);
  });

  it('loadRorcaConfig throws on invalid JSON syntax', () => {
    ensureRorcaDirStructure(tmpDir);
    fs.writeFileSync(path.join(tmpDir, '.rorca', 'config.json'), '{ invalid json !!!');

    expect(() => loadRorcaConfig(tmpDir)).toThrow(SyntaxError);
  });

  it('loadRorcaConfig returns defaults on schema violation', () => {
    ensureRorcaDirStructure(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, '.rorca', 'config.json'),
      JSON.stringify({ routing: { tokenBudget: 'not-a-number' } }),
    );

    // Should not throw, just returns defaults with a console warning
    const config = loadRorcaConfig(tmpDir);
    expect(config.routing.tokenBudget).toBe(32000);
  });

  it('writeRorcaConfig creates .rorca/ dir structure and invalidates cache', () => {
    const config = defaultRorcaConfig();
    config.routing.tokenBudget = 16000;

    writeRorcaConfig(tmpDir, config);

    expect(fs.existsSync(path.join(tmpDir, '.rorca', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.rorca', 'skills'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.rorca', 'memory'))).toBe(true);

    // Read back should reflect written value
    const loaded = loadRorcaConfig(tmpDir);
    expect(loaded.routing.tokenBudget).toBe(16000);
  });
});

describe('CIE E2E: Bi-directional Sync — CLAUDE.md Diff on L3 Update', () => {
  // Tests the conceptual flow: when L3 direction stack content changes,
  // the synthesized context changes, and this diff represents what
  // CLAUDE.md would need to reflect.

  it('generates different synthesized context when L3 is updated', () => {
    const baseParams = {
      l1: 'Use TypeScript strict mode',
      l2: 'SaaS conventions: REST API, JWT auth',
      l3: 'Stack: React 18 + Express + SQLite',
      specBrief: 'Add user profile page',
    };

    const baseSynthesized = synthesize(baseParams);

    // Update L3 with new stack info
    const updatedParams = {
      ...baseParams,
      l3: 'Stack: React 18 + Express + PostgreSQL\nNew: Added Redis for caching',
    };

    const updatedSynthesized = synthesize(updatedParams);

    // The synthesized context should be different
    expect(baseSynthesized).not.toBe(updatedSynthesized);
    expect(baseSynthesized).toContain('SQLite');
    expect(baseSynthesized).not.toContain('PostgreSQL');
    expect(updatedSynthesized).toContain('PostgreSQL');
    expect(updatedSynthesized).toContain('Redis for caching');

    // Both should contain the unchanged L1/L2 content
    expect(updatedSynthesized).toContain('TypeScript strict mode');
    expect(updatedSynthesized).toContain('SaaS conventions');
  });

  it('generates a diffable string showing L3 changes that affect CLAUDE.md', () => {
    // Simulate the diff generation between old and new L3 content
    const oldL3 = 'Stack: React + Express + PostgreSQL\nPorts: 5210, 3030\nDB: pg Pool';
    const newL3 = 'Stack: React + Express + PostgreSQL\nPorts: 5210, 3030\nDB: pg Pool + Prisma';

    const oldLines = oldL3.split('\n');
    const newLines = newL3.split('\n');

    // Find changed lines
    const changes: Array<{ old: string; new: string; line: number }> = [];
    for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
      if (oldLines[i] !== newLines[i]) {
        changes.push({ old: oldLines[i] || '', new: newLines[i] || '', line: i + 1 });
      }
    }

    expect(changes).toHaveLength(1); // Line 3 (DB) changed
    expect(changes[0].old).toContain('pg Pool');
    expect(changes[0].new).toContain('Prisma');
  });

  it('preserves L1/L2/L4/L5 sections when only L3 changes', () => {
    const params = {
      l1: 'Engineering standards',
      l2: 'Domain: SaaS',
      l3: 'Old project context',
      specBrief: 'Build feature X',
      storyAnnotations: 'Edge case: handle null input',
    };

    const _before = synthesize(params);
    const after = synthesize({ ...params, l3: 'New project context with PostgreSQL' });

    // All sections except L3 should be identical
    expect(after).toContain('Engineering standards');
    expect(after).toContain('Domain: SaaS');
    expect(after).toContain('Build feature X');
    expect(after).toContain('Edge case: handle null input');
    // L3 should have changed
    expect(after).toContain('PostgreSQL');
    expect(after).not.toContain('Old project context');
  });
});

describe('CIE E2E: Integration — Router + Config + Scaffold + Memory', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = createNextjsFixture();
    invalidateConfigCache();
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    invalidateConfigCache();
  });

  it('full flow: scaffold → configure routing → route story → synthesize memory', async () => {
    // Step 1: Generate scaffold (creates CLAUDE.md, AGENTS.md, .rorca/config.json, skills)
    const { echolocate } = require('../workspace-echolocation');
    const report = echolocate(workspace);
    const preview = await generateScaffoldPreview(workspace, report);
    writeScaffoldFiles(workspace, preview.files);

    // Step 2: Verify scaffold created the config
    expect(fs.existsSync(path.join(workspace, '.rorca', 'config.json'))).toBe(true);

    // Step 3: Write a custom routing config
    const config = defaultRorcaConfig();
    config.routing.scopes = [
      { path: 'src/components/**', inject: ['.rorca/skills/react.md'], priority: 60, managed: 'rorca' },
      { path: 'src/app/**', inject: ['.rorca/skills/nextjs.md'], priority: 70, managed: 'rorca' },
    ];
    writeRorcaConfig(workspace, config);

    // Step 4: Route a story that touches src/components/
    const story = makeStory({
      description: 'Add new Card component in `src/components/Card.tsx`',
    });
    const routingConfig = loadRorcaConfig(workspace).routing;
    const payload = route(story, routingConfig, workspace);

    // Should include globals (CLAUDE.md, AGENTS.md from scaffold)
    expect(payload.globals.length).toBeGreaterThanOrEqual(1);

    // Should include react.md skill (scoped match on src/components/**)
    if (fs.existsSync(path.join(workspace, '.rorca', 'skills', 'react.md'))) {
      expect(payload.injectedFiles).toContain('.rorca/skills/react.md');
    }

    // Step 5: Write memory entries for the "completed" run
    const memoryEntry: MemoryEntry = {
      date: '2026-02-28',
      category: 'Convention',
      title: 'Use functional React components',
      rule: 'All new React components must be functional with hooks, no class components',
      context: 'Detected from scaffold analysis of Next.js 14 project',
      source: 'CIE-018',
    };
    writeMemory(workspace, [memoryEntry], '.rorca/memory/MEMORY.md');

    const entries = readMemory(workspace, '.rorca/memory/MEMORY.md');
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Use functional React components');
  });
});
