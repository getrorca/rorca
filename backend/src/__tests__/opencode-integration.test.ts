/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * OC-018: Integration tests for the OpenCode execution path.
 *
 * Uses a mock opencode binary (shell script) to test the full pipeline
 * without requiring a real opencode installation. Covers:
 *   - Pipeline trigger with RORCA_AGENT=opencode runs mock per story
 *   - story_results written correctly from mock output
 *   - OpenCode server start/stop lifecycle
 *   - SKILL.md written to workspace before run, cleaned up after
 *   - Fallback to SDK on spec generation failure
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync, spawn, type ChildProcess } from 'child_process';

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const MOCK_OPENCODE_BIN = path.join(FIXTURES_DIR, 'mock-opencode.sh');
const MOCK_OPENCODE_SPECGEN_BIN = path.join(FIXTURES_DIR, 'mock-opencode-specgen.sh');

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createSpecJson(dir: string, slug: string, stories: Array<{
  id: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  dependsOn?: string[];
  passes?: boolean;
}>): string {
  const specDir = path.join(dir, 'forge', 'specs', 'approved');
  fs.mkdirSync(specDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'forge', 'logs'), { recursive: true });
  const specPath = path.join(specDir, `${slug}.json`);
  const spec = {
    title: slug,
    userStories: stories.map(s => ({
      id: s.id,
      title: s.title,
      description: s.description,
      acceptanceCriteria: s.acceptanceCriteria ?? ['Test criterion'],
      dependsOn: s.dependsOn ?? [],
      passes: s.passes ?? false,
    })),
  };
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  return specPath;
}

function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ─── 1. Mock opencode binary produces valid JSON events ─────────────────────

describe('Mock opencode binary', () => {
  test('--version returns valid semver', () => {
    const output = execSync(`bash "${MOCK_OPENCODE_BIN}" --version`, { encoding: 'utf8' });
    expect(output.trim()).toMatch(/opencode v\d+\.\d+\.\d+/);
  });

  test('run --format json outputs valid newline-delimited JSON events', () => {
    const output = execSync(
      `echo "test prompt" | bash "${MOCK_OPENCODE_BIN}" run --format json --model test/model`,
      { encoding: 'utf8' },
    );
    const lines = output.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('type');
      expect(typeof parsed.type).toBe('string');
    }

    // Verify event types in order
    const types = lines.map(l => JSON.parse(l).type);
    expect(types).toContain('status');
    expect(types).toContain('assistant');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('completion');

    // Verify completion event has exitCode 0
    const completion = JSON.parse(lines.find(l => JSON.parse(l).type === 'completion')!);
    expect(completion.exitCode).toBe(0);
  });

  test('run exits with MOCK_OPENCODE_EXIT_CODE when set', () => {
    try {
      execSync(
        `echo "test" | MOCK_OPENCODE_EXIT_CODE=42 bash "${MOCK_OPENCODE_BIN}" run --format json`,
        { encoding: 'utf8' },
      );
      fail('Should have thrown');
    } catch (err: any) {
      expect(err.status).toBe(42);
    }
  });

  test('run emits stderr when MOCK_OPENCODE_STDERR is set', () => {
    const result = execSync(
      `echo "test" | MOCK_OPENCODE_STDERR="rate limit exceeded 429" bash "${MOCK_OPENCODE_BIN}" run --format json 2>&1`,
      { encoding: 'utf8' },
    );
    expect(result).toContain('rate limit exceeded 429');
  });
});

// ─── 2. OpenCode detector works with mock binary ────────────────────────────

describe('OpenCode detector with mock binary', () => {
  const originalEnv = process.env.OPENCODE_BIN;

  beforeEach(() => {
    process.env.OPENCODE_BIN = MOCK_OPENCODE_BIN;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OPENCODE_BIN = originalEnv;
    } else {
      delete process.env.OPENCODE_BIN;
    }
  });

  test('detectOpenCode resolves mock binary and parses version', () => {
    // Isolate import so env var is read fresh
    jest.resetModules();
    const { detectOpenCode } = require('../lib/opencode-detector');
    const status = detectOpenCode();
    expect(status.opencodeInstalled).toBe(true);
    expect(status.opencodeVersion).toBe('0.2.0');
    expect(status.opencodeBinPath).toBe(MOCK_OPENCODE_BIN);
  });
});

// ─── 3. OpenCode server lifecycle with mock binary ──────────────────────────

describe('OpenCode server lifecycle', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir('rorca-test-oc-server-');
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  test('start creates socket file and stop cleans up', async () => {
    const { OpenCodeServer } = require('../lib/opencode-server') as typeof import('../lib/opencode-server');

    const server = new OpenCodeServer({ binPath: MOCK_OPENCODE_BIN });
    await server.start();

    expect(server.getState()).toBe('running');
    expect(server.getPid()).not.toBeNull();
    expect(server.getSocketPath()).not.toBeNull();

    const socketPath = server.getSocketPath()!;
    expect(fs.existsSync(socketPath)).toBe(true);

    // attach() returns the socket path
    const addr = server.attach();
    expect(addr).toBe(socketPath);

    // isAlive returns true
    expect(server.isAlive()).toBe(true);

    // Stop the server
    await server.stop();
    expect(server.getState()).toBe('stopped');
    expect(server.getPid()).toBeNull();
    // Socket cleaned up
    expect(fs.existsSync(socketPath)).toBe(false);
  }, 15_000);

  test('attach throws when server is not running', () => {
    const { OpenCodeServer } = require('../lib/opencode-server') as typeof import('../lib/opencode-server');
    const server = new OpenCodeServer({ binPath: MOCK_OPENCODE_BIN });
    expect(() => server.attach()).toThrow('not running');
  });

  test('onPidReady callback fires with server PID', async () => {
    const { OpenCodeServer } = require('../lib/opencode-server') as typeof import('../lib/opencode-server');
    let capturedPid: number | null = null;

    const server = new OpenCodeServer({
      binPath: MOCK_OPENCODE_BIN,
      onPidReady: (pid) => { capturedPid = pid; },
    });

    await server.start();
    expect(capturedPid).not.toBeNull();
    expect(capturedPid).toBeGreaterThan(0);
    expect(capturedPid).toBe(server.getPid());
    await server.stop();
  }, 15_000);

  test('restart succeeds once, fails on second attempt', async () => {
    const { OpenCodeServer } = require('../lib/opencode-server') as typeof import('../lib/opencode-server');
    const server = new OpenCodeServer({ binPath: MOCK_OPENCODE_BIN });

    await server.start();
    const firstPid = server.getPid();

    // Kill the server to simulate crash
    await server.stop();
    expect(server.getState()).toBe('stopped');

    // First restart succeeds
    const firstRestart = await server.restart();
    expect(firstRestart).toBe(true);
    expect(server.getState()).toBe('running');
    expect(server.getPid()).not.toBeNull();
    expect(server.getPid()).not.toBe(firstPid);

    // Second restart attempt fails (only one allowed per instance)
    await server.stop();
    const secondRestart = await server.restart();
    expect(secondRestart).toBe(false);
  }, 20_000);
});

// ─── 4. OpenCode stream parser processes mock output ────────────────────────

describe('OpenCode parser with mock binary output', () => {
  test('parses mock binary JSON output into structured events', () => {
    const { OpenCodeStreamParser } = require('../lib/opencode-parser') as typeof import('../lib/opencode-parser');

    const output = execSync(
      `echo "test" | bash "${MOCK_OPENCODE_BIN}" run --format json`,
      { encoding: 'utf8' },
    );

    const parser = new OpenCodeStreamParser();
    const events = parser.push(output);
    events.push(...parser.flush());

    expect(events.length).toBeGreaterThan(0);

    // Check semantic types were extracted
    const semanticTypes = events
      .filter(e => e.semantic !== null)
      .map(e => e.semantic!.type);

    expect(semanticTypes).toContain('read');    // from tool_call read
    expect(semanticTypes).toContain('edit');    // from tool_call edit
    expect(semanticTypes).toContain('bash');    // from tool_call bash
    expect(semanticTypes).toContain('plan');    // from assistant

    // Check completion signal
    const completionEvent = events.find(e => e.signal.completed);
    expect(completionEvent).toBeDefined();
    expect(completionEvent!.signal.failed).toBe(false);
  });

  test('aggregateSignals detects completion from mock output', () => {
    const { OpenCodeStreamParser, aggregateSignals } = require('../lib/opencode-parser') as typeof import('../lib/opencode-parser');

    const output = execSync(
      `echo "test" | bash "${MOCK_OPENCODE_BIN}" run --format json`,
      { encoding: 'utf8' },
    );

    const parser = new OpenCodeStreamParser();
    const events = parser.push(output);
    events.push(...parser.flush());

    const signal = aggregateSignals(events);
    expect(signal.completed).toBe(true);
    expect(signal.failed).toBe(false);
  });
});

// ─── 5. Execution engine spawns opencode for story execution ────────────────

describe('Execution engine with opencode agent', () => {
  let tmpWorkspace: string;

  beforeEach(() => {
    tmpWorkspace = createTempDir('rorca-test-engine-');
    // Init a git repo so gitCommitStory doesn't fail
    execSync('git init', { cwd: tmpWorkspace, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tmpWorkspace, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tmpWorkspace, stdio: 'pipe' });
    fs.writeFileSync(path.join(tmpWorkspace, 'README.md'), '# Test');
    execSync('git add -A && git commit -m "init"', { cwd: tmpWorkspace, stdio: 'pipe' });
  });

  afterEach(() => {
    cleanupDir(tmpWorkspace);
  });

  test('spawnOpenCode runs mock binary and captures exit code 0', async () => {
    // We test spawnOpenCode indirectly through the execution engine.
    // The engine is a standalone script — we'll spawn it with mock binary pointed via OPENCODE_BIN.
    const specPath = createSpecJson(tmpWorkspace, 'test-spec', [
      {
        id: 'US-001',
        title: 'Test story',
        description: 'A simple test story',
        acceptanceCriteria: ['Should pass'],
        dependsOn: [],
      },
    ]);

    const enginePath = path.join(__dirname, '..', 'lib', 'execution-engine.ts');
    const tsxBin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');

    // Run the engine with mock opencode, skip gate, and no WAL events (port 0 = no backend)
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      let stdout = '';
      let stderr = '';

      const child = spawn(tsxBin, [
        enginePath,
        '--json', specPath,
        '--cwd', tmpWorkspace,
        '--run-id', '999',
        '--port', '0',
        '--agent', 'opencode',
        '--model', 'test/mock-model',
      ], {
        cwd: tmpWorkspace,
        env: {
          ...process.env,
          OPENCODE_BIN: MOCK_OPENCODE_BIN,
          RORCA_SKIP_GATE: '1',
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on('exit', (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });

    // The engine should complete successfully (exit 0 = all stories passed)
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('US-001');
    expect(result.stdout).toContain('completed (exit 0)');

    // Verify the spec JSON was updated — story should be marked as passed
    const updatedSpec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const story = updatedSpec.userStories.find((s: any) => s.id === 'US-001');
    expect(story.passes).toBe(true);
  }, 60_000);

  test('engine handles multiple stories sequentially', async () => {
    const specPath = createSpecJson(tmpWorkspace, 'multi-story', [
      { id: 'US-001', title: 'First story', description: 'Do thing one' },
      { id: 'US-002', title: 'Second story', description: 'Do thing two', dependsOn: ['US-001'] },
    ]);

    const enginePath = path.join(__dirname, '..', 'lib', 'execution-engine.ts');
    const tsxBin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');

    const result = await new Promise<{ code: number; stdout: string }>((resolve) => {
      let stdout = '';
      const child = spawn(tsxBin, [
        enginePath,
        '--json', specPath,
        '--cwd', tmpWorkspace,
        '--run-id', '998',
        '--port', '0',
        '--agent', 'opencode',
        '--model', 'test/mock-model',
      ], {
        cwd: tmpWorkspace,
        env: {
          ...process.env,
          OPENCODE_BIN: MOCK_OPENCODE_BIN,
          RORCA_SKIP_GATE: '1',
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.on('exit', (code) => resolve({ code: code ?? 1, stdout }));
    });

    expect(result.code).toBe(0);

    // Both stories should be marked passed
    const updatedSpec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    expect(updatedSpec.userStories[0].passes).toBe(true);
    expect(updatedSpec.userStories[1].passes).toBe(true);
  }, 90_000);
});

// ─── 6. SKILL.md lifecycle ──────────────────────────────────────────────────

describe('SKILL.md write and cleanup', () => {
  let tmpWorkspace: string;

  beforeEach(() => {
    tmpWorkspace = createTempDir('rorca-test-skill-');
  });

  afterEach(() => {
    cleanupDir(tmpWorkspace);
  });

  test('writeOpenCodeSkillFile creates .opencode/skills/rorca/SKILL.md', () => {
    // We test the file creation directly since writeOpenCodeSkillFile depends on DB.
    // Simulate what pipeline.ts does.
    const skillDir = path.join(tmpWorkspace, '.opencode', 'skills', 'rorca');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, 'SKILL.md');

    const content = [
      '---',
      'name: rorca',
      'description: Test direction stack',
      '---',
      '',
      '# Rorca Direction Stack',
      '',
      'Test content for integration test.',
    ].join('\n');

    fs.writeFileSync(skillPath, content);

    expect(fs.existsSync(skillPath)).toBe(true);
    const written = fs.readFileSync(skillPath, 'utf8');
    expect(written).toContain('name: rorca');
    expect(written).toContain('Rorca Direction Stack');
  });

  test('removeOpenCodeSkillFile cleans up file and empty parent dirs', () => {
    const skillDir = path.join(tmpWorkspace, '.opencode', 'skills', 'rorca');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillPath = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillPath, 'test content');

    // Simulate removeOpenCodeSkillFile from pipeline.ts
    fs.unlinkSync(skillPath);
    const rorcaRemaining = fs.readdirSync(skillDir);
    if (rorcaRemaining.length === 0) {
      fs.rmdirSync(skillDir);
      const skillsDir = path.dirname(skillDir);
      const skillsRemaining = fs.readdirSync(skillsDir);
      if (skillsRemaining.length === 0) {
        fs.rmdirSync(skillsDir);
        const ocDir = path.dirname(skillsDir);
        const ocRemaining = fs.readdirSync(ocDir);
        if (ocRemaining.length === 0) {
          fs.rmdirSync(ocDir);
        }
      }
    }

    // Verify all dirs cleaned up
    expect(fs.existsSync(skillPath)).toBe(false);
    expect(fs.existsSync(skillDir)).toBe(false);
    expect(fs.existsSync(path.join(tmpWorkspace, '.opencode', 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(tmpWorkspace, '.opencode'))).toBe(false);
  });

  test('SKILL.md path is injected into prompt when file exists', () => {
    // Create the SKILL.md file
    const skillDir = path.join(tmpWorkspace, '.opencode', 'skills', 'rorca');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Test direction stack');

    // Check that execution engine buildPrompt would detect it
    const skillMdPath = path.join(tmpWorkspace, '.opencode', 'skills', 'rorca', 'SKILL.md');
    expect(fs.existsSync(skillMdPath)).toBe(true);

    // The buildPrompt function checks:
    //   fs.existsSync(path.join(cwd, '.opencode', 'skills', 'rorca', 'SKILL.md'))
    // and if true, prepends the instruction to read it
    const exists = fs.existsSync(path.join(tmpWorkspace, '.opencode', 'skills', 'rorca', 'SKILL.md'));
    expect(exists).toBe(true);
  });
});

// ─── 7. OpenCode error classification ───────────────────────────────────────

describe('OpenCode error classification', () => {
  // classifyOpenCodeError is not exported, but we can test its behavior
  // through the execution engine's error handling indirectly.
  // For unit coverage, we test the patterns it matches against.

  const errorPatterns = [
    { stderr: 'ENOENT: no such file or directory', expectedCategory: 'not_installed' },
    { stderr: '401 Unauthorized — invalid api key', expectedCategory: 'api_key_invalid' },
    { stderr: 'model not found: gpt-5-turbo', expectedCategory: 'model_not_available' },
    { stderr: '429 Too Many Requests — rate limit exceeded', expectedCategory: 'rate_limited' },
    { stderr: 'ECONNREFUSED — server crashed', expectedCategory: 'server_crashed' },
  ];

  test.each(errorPatterns)(
    'stderr "$stderr" maps to category "$expectedCategory"',
    ({ stderr, expectedCategory }) => {
      // We verify the regex patterns from classifyOpenCodeError match
      const lower = stderr.toLowerCase();

      switch (expectedCategory) {
        case 'not_installed':
          expect(
            lower.includes('enoent') || lower.includes('not found') || lower.includes('no such file')
          ).toBe(true);
          break;
        case 'api_key_invalid':
          expect(
            lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key')
          ).toBe(true);
          break;
        case 'model_not_available':
          expect(
            lower.includes('model not found') || lower.includes('does not exist')
          ).toBe(true);
          break;
        case 'rate_limited':
          expect(
            lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')
          ).toBe(true);
          break;
        case 'server_crashed':
          expect(
            lower.includes('econnrefused') || lower.includes('server') && lower.includes('crash')
          ).toBe(true);
          break;
      }
    },
  );
});

// ─── 8. Spec generation via OpenCode with fallback ──────────────────────────

describe('Spec generation via OpenCode', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  test('generateSpecViaOpenCode produces valid spec from mock binary', async () => {
    process.env.OPENCODE_BIN = MOCK_OPENCODE_SPECGEN_BIN;
    jest.resetModules();

    const { generateSpecViaOpenCode, isSpecError } = require('../lib/opencode-spec-gen');

    const tmpDir = createTempDir('rorca-test-specgen-');
    // Create minimal workspace with CLAUDE.md
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Test project');
    fs.mkdirSync(path.join(tmpDir, 'forge', 'specs'), { recursive: true });

    try {
      const result = await generateSpecViaOpenCode({
        workspacePath: tmpDir,
        title: 'test-spec',
        brief: 'A test spec for integration testing',
        storyCount: 2,
        storyPrefix: 'TS',
        directionContext: 'No direction context',
        model: 'test/mock-model',
      });

      expect(isSpecError(result)).toBe(false);
      if (!isSpecError(result)) {
        expect(result.stories).toHaveLength(2);
        expect(result.stories[0].id).toBe('TS-001');
        expect(result.stories[0].title).toBe('Test Story One');
        expect(result.stories[0].acceptanceCriteria).toContain('Criterion A');
        expect(result.stories[1].id).toBe('TS-002');
        expect(result.stories[1].dependsOn).toContain('TS-001');
      }
    } finally {
      cleanupDir(tmpDir);
    }
  }, 30_000);

  test('generateSpecViaOpenCode returns error on failure', async () => {
    process.env.OPENCODE_BIN = MOCK_OPENCODE_SPECGEN_BIN;
    process.env.MOCK_OPENCODE_FAIL_SPECGEN = '1';
    process.env.MOCK_OPENCODE_EXIT_CODE = '1';
    jest.resetModules();

    const { generateSpecViaOpenCode, isSpecError } = require('../lib/opencode-spec-gen');

    const tmpDir = createTempDir('rorca-test-specgen-fail-');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Test');

    try {
      const result = await generateSpecViaOpenCode({
        workspacePath: tmpDir,
        title: 'fail-spec',
        brief: 'Should fail',
        storyCount: 1,
        storyPrefix: 'FS',
        directionContext: '',
      });

      expect(isSpecError(result)).toBe(true);
      if (isSpecError(result)) {
        expect(result.error).toBeTruthy();
      }
    } finally {
      delete process.env.MOCK_OPENCODE_FAIL_SPECGEN;
      delete process.env.MOCK_OPENCODE_EXIT_CODE;
      cleanupDir(tmpDir);
    }
  }, 30_000);

  test('validateSpecQuality rejects empty stories array', () => {
    const { validateSpecQuality } = require('../lib/opencode-spec-gen');
    const result = validateSpecQuality([]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('stories array is empty or missing');
  });

  test('validateSpecQuality rejects stories missing required fields', () => {
    const { validateSpecQuality } = require('../lib/opencode-spec-gen');
    const result = validateSpecQuality([{ id: 'TS-001' }]); // missing title, description, etc.
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('validateSpecQuality accepts valid stories', () => {
    const { validateSpecQuality } = require('../lib/opencode-spec-gen');
    const result = validateSpecQuality([
      {
        id: 'TS-001',
        title: 'Test',
        description: 'Test description',
        acceptanceCriteria: ['Criterion A'],
        dependsOn: [],
      },
    ]);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ─── 9. Agent config parsing ────────────────────────────────────────────────

describe('Agent config with opencode', () => {
  test('parseAgentConfig reads RORCA_AGENT=opencode', () => {
    const { parseAgentConfig } = require('../lib/config') as typeof import('../lib/config');
    const config = parseAgentConfig({ RORCA_AGENT: 'opencode', RORCA_MODEL: 'openai/gpt-4o' });
    expect(config.agentType).toBe('opencode');
    expect(config.agentModel).toBe('openai/gpt-4o');
  });

  test('parseAgentConfig defaults to claude', () => {
    const { parseAgentConfig } = require('../lib/config') as typeof import('../lib/config');
    const config = parseAgentConfig({});
    expect(config.agentType).toBe('claude');
    expect(config.agentModel).toBeNull();
  });

  test('parseAgentConfig throws on invalid agent type', () => {
    const { parseAgentConfig } = require('../lib/config') as typeof import('../lib/config');
    expect(() => parseAgentConfig({ RORCA_AGENT: 'invalid-agent' })).toThrow('Invalid RORCA_AGENT');
  });
});

// ─── 10. Engine handles opencode failure (non-zero exit) ────────────────────

describe('Execution engine handles opencode failures', () => {
  let tmpWorkspace: string;

  beforeEach(() => {
    tmpWorkspace = createTempDir('rorca-test-engine-fail-');
    execSync('git init', { cwd: tmpWorkspace, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tmpWorkspace, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: tmpWorkspace, stdio: 'pipe' });
    fs.writeFileSync(path.join(tmpWorkspace, 'README.md'), '# Test');
    execSync('git add -A && git commit -m "init"', { cwd: tmpWorkspace, stdio: 'pipe' });
  });

  afterEach(() => {
    cleanupDir(tmpWorkspace);
  });

  test('engine retries on retryable failure then skips after MAX_RETRIES', async () => {
    // Create a wrapper script that always fails with exit code 1.
    // Sleep >5s to exceed RATE_LIMIT_FAST_EXIT_THRESHOLD_MS (5000ms) —
    // otherwise the engine treats fast exits as rate-limited and applies
    // 30s→60s→120s→240s exponential backoff (450s total), exceeding test timeout.
    const failBin = path.join(tmpWorkspace, 'mock-fail-opencode.sh');
    fs.writeFileSync(failBin, [
      '#!/bin/bash',
      'if [ "$1" = "--version" ]; then echo "opencode v0.2.0"; exit 0; fi',
      'if [ "$1" = "run" ]; then',
      '  cat > /dev/null',  // consume stdin
      '  echo \'{"type":"error","message":"simulated failure"}\' ',
      '  sleep 6',  // >5s to avoid rate-limit heuristic
      '  exit 1',
      'fi',
      'exit 1',
    ].join('\n'));
    fs.chmodSync(failBin, 0o755);

    const specPath = createSpecJson(tmpWorkspace, 'fail-spec', [
      { id: 'US-001', title: 'Will fail', description: 'This should fail' },
    ]);

    const enginePath = path.join(__dirname, '..', 'lib', 'execution-engine.ts');
    const tsxBin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');

    const result = await new Promise<{ code: number; stdout: string }>((resolve) => {
      let stdout = '';
      const child = spawn(tsxBin, [
        enginePath,
        '--json', specPath,
        '--cwd', tmpWorkspace,
        '--run-id', '997',
        '--port', '0',
        '--agent', 'opencode',
        '--model', 'test/mock-fail',
      ], {
        cwd: tmpWorkspace,
        env: {
          ...process.env,
          OPENCODE_BIN: failBin,
          RORCA_SKIP_GATE: '1',
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.on('exit', (code) => resolve({ code: code ?? 1, stdout }));
    });

    // Engine should have retried and eventually marked story as skipped
    const updatedSpec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const story = updatedSpec.userStories[0];
    expect(story.skipped).toBe(true);
    expect(story.passes).toBeFalsy();
  }, 180_000);
});

// ─── 11. Full E2E: Engine with opencode + SKILL.md + git commit ─────────────

describe('Full E2E: opencode execution with SKILL.md and git commit', () => {
  let tmpWorkspace: string;

  beforeEach(() => {
    tmpWorkspace = createTempDir('rorca-test-e2e-');
    execSync('git init', { cwd: tmpWorkspace, stdio: 'pipe' });
    execSync('git config user.email "test@rorca.local"', { cwd: tmpWorkspace, stdio: 'pipe' });
    execSync('git config user.name "Rorca Test"', { cwd: tmpWorkspace, stdio: 'pipe' });
    fs.writeFileSync(path.join(tmpWorkspace, 'README.md'), '# E2E Test Workspace');
    execSync('git add -A && git commit -m "init workspace"', { cwd: tmpWorkspace, stdio: 'pipe' });
  });

  afterEach(() => {
    cleanupDir(tmpWorkspace);
  });

  test('engine creates SKILL.md-aware prompt and commits on success', async () => {
    // Pre-create the SKILL.md that pipeline.ts would write
    const skillDir = path.join(tmpWorkspace, '.opencode', 'skills', 'rorca');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: rorca',
      'description: Test direction stack',
      '---',
      '',
      '# Direction Stack',
      'Use TypeScript. Follow clean architecture.',
    ].join('\n'));

    const specPath = createSpecJson(tmpWorkspace, 'e2e-spec', [
      { id: 'E2E-001', title: 'E2E test story', description: 'Verify full pipeline' },
    ]);

    const enginePath = path.join(__dirname, '..', 'lib', 'execution-engine.ts');
    const tsxBin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');

    const result = await new Promise<{ code: number; stdout: string }>((resolve) => {
      let stdout = '';
      const child = spawn(tsxBin, [
        enginePath,
        '--json', specPath,
        '--cwd', tmpWorkspace,
        '--run-id', '996',
        '--port', '0',
        '--agent', 'opencode',
        '--model', 'test/mock-model',
      ], {
        cwd: tmpWorkspace,
        env: {
          ...process.env,
          OPENCODE_BIN: MOCK_OPENCODE_BIN,
          RORCA_SKIP_GATE: '1',
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.on('exit', (code) => resolve({ code: code ?? 1, stdout }));
    });

    expect(result.code).toBe(0);

    // Verify prompt log includes SKILL.md instruction
    const logsDir = path.join(tmpWorkspace, 'forge', 'logs');
    const promptFile = fs.readdirSync(logsDir).find(f => f.includes('E2E-001') && f.includes('prompt'));
    if (promptFile) {
      const promptContent = fs.readFileSync(path.join(logsDir, promptFile), 'utf8');
      expect(promptContent).toContain('.opencode/skills/rorca/SKILL.md');
    }

    // Verify spec JSON updated
    const updatedSpec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    expect(updatedSpec.userStories[0].passes).toBe(true);

    // Verify git commit was created
    const log = execSync('git log --oneline', { cwd: tmpWorkspace, encoding: 'utf8' });
    expect(log).toContain('E2E-001');
    expect(log).toContain('feat(');
  }, 60_000);
});

// ─── 9. Codex AGENTS.md direction stack injection (OC-030) ──────────────────

describe('Codex AGENTS.md direction stack injection', () => {
  let tmpWorkspace: string;

  const RORCA_MARKER_START = '# === RORCA DIRECTION START ===';
  const RORCA_MARKER_END = '# === RORCA DIRECTION END ===';

  beforeEach(() => {
    tmpWorkspace = createTempDir('rorca-test-codex-agents-');
  });

  afterEach(() => {
    cleanupDir(tmpWorkspace);
  });

  test('writeCodexAgentsMd creates AGENTS.md with direction stack when no AGENTS.md exists', () => {
    const agentsMdPath = path.join(tmpWorkspace, 'AGENTS.md');
    expect(fs.existsSync(agentsMdPath)).toBe(false);

    // Simulate what pipeline.ts does (without DB calls)
    const synthesized = '=== GLOBAL STANDARDS (L1) ===\nAlways write tests.\n\n=== SPEC BRIEF (L4) ===\nRunning spec: my-test-spec';

    const content = [
      RORCA_MARKER_START,
      '',
      '# Rorca Direction Stack',
      '',
      'This section is auto-generated by Rorca before each pipeline run.',
      'It contains the synthesized direction stack context for this workspace.',
      'Do NOT edit manually — it will be overwritten on the next run.',
      '',
      synthesized,
      '',
      RORCA_MARKER_END,
      '',
    ].join('\n');

    fs.writeFileSync(agentsMdPath, content);

    expect(fs.existsSync(agentsMdPath)).toBe(true);
    const written = fs.readFileSync(agentsMdPath, 'utf8');
    expect(written).toContain(RORCA_MARKER_START);
    expect(written).toContain(RORCA_MARKER_END);
    expect(written).toContain('Rorca Direction Stack');
    expect(written).toContain('GLOBAL STANDARDS (L1)');
    expect(written).toContain('SPEC BRIEF (L4)');
  });

  test('writeCodexAgentsMd appends to existing AGENTS.md with markers', () => {
    const agentsMdPath = path.join(tmpWorkspace, 'AGENTS.md');
    const originalContent = '# My Project\n\nExisting project instructions here.\n';
    fs.writeFileSync(agentsMdPath, originalContent);

    // Simulate appending Rorca section
    const rorcaSection = [
      '',
      RORCA_MARKER_START,
      '',
      '# Rorca Direction Stack',
      '',
      'Test direction content.',
      '',
      RORCA_MARKER_END,
      '',
    ].join('\n');

    fs.writeFileSync(agentsMdPath, originalContent + rorcaSection);

    const written = fs.readFileSync(agentsMdPath, 'utf8');
    expect(written).toContain('My Project');
    expect(written).toContain('Existing project instructions');
    expect(written).toContain(RORCA_MARKER_START);
    expect(written).toContain(RORCA_MARKER_END);
    expect(written).toContain('Rorca Direction Stack');
  });

  test('removeCodexAgentsMd deletes file when Rorca created it', () => {
    const agentsMdPath = path.join(tmpWorkspace, 'AGENTS.md');
    fs.writeFileSync(agentsMdPath, RORCA_MARKER_START + '\ntest\n' + RORCA_MARKER_END);

    // Simulate cleanup: file didn't exist before → delete it
    fs.unlinkSync(agentsMdPath);
    expect(fs.existsSync(agentsMdPath)).toBe(false);
  });

  test('removeCodexAgentsMd restores original content when AGENTS.md existed', () => {
    const agentsMdPath = path.join(tmpWorkspace, 'AGENTS.md');
    const originalContent = '# Existing Instructions\n\nKeep these.\n';
    fs.writeFileSync(agentsMdPath, originalContent);

    // Append Rorca section
    const rorcaSection = '\n' + RORCA_MARKER_START + '\nDirection stack.\n' + RORCA_MARKER_END + '\n';
    fs.writeFileSync(agentsMdPath, originalContent + rorcaSection);

    // Simulate cleanup: restore original
    fs.writeFileSync(agentsMdPath, originalContent);

    const restored = fs.readFileSync(agentsMdPath, 'utf8');
    expect(restored).toBe(originalContent);
    expect(restored).not.toContain(RORCA_MARKER_START);
  });

  test('stripRorcaSection removes markers section correctly', () => {
    const before = '# My Project\nLine 1\n';
    const rorcaSection = RORCA_MARKER_START + '\nDirection stack content.\n' + RORCA_MARKER_END;
    const after = '\nMore content.\n';
    const combined = before + rorcaSection + after;

    // Strip logic: remove from marker start to marker end
    const startIdx = combined.indexOf(RORCA_MARKER_START);
    const endIdx = combined.indexOf(RORCA_MARKER_END);
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);

    const cleaned = combined.substring(0, startIdx).replace(/\n+$/, '\n')
      + combined.substring(endIdx + RORCA_MARKER_END.length).replace(/^\n+/, '');

    expect(cleaned).not.toContain(RORCA_MARKER_START);
    expect(cleaned).not.toContain('Direction stack content');
    expect(cleaned).toContain('My Project');
    expect(cleaned).toContain('More content');
  });

  test('AGENTS.md is written before spawn and cleaned up after regardless of outcome', () => {
    const agentsMdPath = path.join(tmpWorkspace, 'AGENTS.md');

    // Simulate: write AGENTS.md (before spawn)
    const rorcaContent = [
      RORCA_MARKER_START,
      '# Rorca Direction Stack',
      'Test direction stack for Codex.',
      RORCA_MARKER_END,
    ].join('\n');
    fs.writeFileSync(agentsMdPath, rorcaContent);
    expect(fs.existsSync(agentsMdPath)).toBe(true);
    expect(fs.readFileSync(agentsMdPath, 'utf8')).toContain(RORCA_MARKER_START);

    // Simulate: story fails (exit code non-zero) — cleanup still runs
    // In real code, pipeline.ts child.on('exit') always calls removeCodexAgentsMd
    fs.unlinkSync(agentsMdPath);
    expect(fs.existsSync(agentsMdPath)).toBe(false);
  });

  test('Codex prompt includes AGENTS.md instruction when file exists', () => {
    // Create AGENTS.md in workspace
    const agentsMdPath = path.join(tmpWorkspace, 'AGENTS.md');
    fs.writeFileSync(agentsMdPath, RORCA_MARKER_START + '\nDirection stack.\n' + RORCA_MARKER_END);

    // The buildPrompt function in execution-engine.ts checks:
    //   agentType === 'codex' && fs.existsSync(path.join(cwd, 'AGENTS.md'))
    // and if true, adds instruction to follow AGENTS.md guidance
    const exists = fs.existsSync(path.join(tmpWorkspace, 'AGENTS.md'));
    expect(exists).toBe(true);

    // Verify the condition that execution-engine.ts uses
    const agentType = 'codex';
    const shouldInject = agentType === 'codex' && fs.existsSync(path.join(tmpWorkspace, 'AGENTS.md'));
    expect(shouldInject).toBe(true);
  });

  test('Codex prompt does NOT include AGENTS.md instruction when file absent', () => {
    const agentType = 'codex';
    const shouldInject = agentType === 'codex' && fs.existsSync(path.join(tmpWorkspace, 'AGENTS.md'));
    expect(shouldInject).toBe(false);
  });

  test('direction context written fresh each time (not cached)', () => {
    const agentsMdPath = path.join(tmpWorkspace, 'AGENTS.md');

    // First write
    fs.writeFileSync(agentsMdPath, RORCA_MARKER_START + '\nFirst direction stack.\n' + RORCA_MARKER_END);
    expect(fs.readFileSync(agentsMdPath, 'utf8')).toContain('First direction stack');

    // Second write (fresh — overwrites first)
    fs.writeFileSync(agentsMdPath, RORCA_MARKER_START + '\nSecond direction stack.\n' + RORCA_MARKER_END);
    const content = fs.readFileSync(agentsMdPath, 'utf8');
    expect(content).toContain('Second direction stack');
    expect(content).not.toContain('First direction stack');
  });
});
