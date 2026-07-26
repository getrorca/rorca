/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../autonomous-model-egress', () => ({
  ensureAutonomousModelEgress: jest.fn().mockResolvedValue('/test/model-egress.sock'),
}));
jest.mock('../autonomous-sandbox', () => ({
  prepareAutonomousSandboxLaunch: jest.fn((options: any) => ({
    command: options.command, args: [...options.args], cwd: options.cwd, env: options.env, isolated: true,
  })),
}));

import {
  GITREINS_EVIDENCE_SCHEMA,
  runGitReinsJudge,
  type GitReinsJudgeInput,
} from '../gitreins-runner';

function evidence(passed = true, summary = 'all good') {
  return {
    $schema: GITREINS_EVIDENCE_SCHEMA,
    schemaVersion: '1.0',
    producer: { name: 'gitreins', version: '0.9.0' },
    command: 'judge',
    generatedAt: new Date().toISOString(),
    scope: 'working-tree',
    outcome: passed ? 'pass' : 'fail',
    passed,
    summary,
    subject: { taskId: 'rorca-7-US-001', title: 'story', ephemeral: true },
    checks: [],
    metadata: {
      redacted: true,
      redactionsApplied: false,
      truncated: false,
      historyPersisted: false,
    },
  };
}

function fixture(script: string, gitFile = false): { cwd: string; binary: string } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-gitreins-'));
  if (gitFile) fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: /tmp/example\n');
  else fs.mkdirSync(path.join(cwd, '.git'));
  fs.mkdirSync(path.join(cwd, '.gitreins'));
  fs.writeFileSync(path.join(cwd, '.gitreins', 'config.yaml'), 'history:\n  enabled: false\n');
  const binary = path.join(cwd, 'gitreins-fixture');
  fs.writeFileSync(binary, `#!/usr/bin/env node\n${script}\n`);
  fs.chmodSync(binary, 0o755);
  return { cwd, binary };
}

function input(cwd: string, binary?: string, mode: 'disabled' | 'observe' | 'enforce' = 'enforce'): GitReinsJudgeInput {
  return {
    cwd,
    binary,
    mode,
    timeoutMs: 5_000,
    maxEvidenceBytes: 32 * 1024,
    runId: 7,
    storyId: 'US-001',
    title: 'Implement story',
    criteria: ['criterion one'],
    attempt: 1,
  };
}

describe('GitReins no-shell runner', () => {
  test('uses fixed ephemeral working-tree argv and does not interpret story shell syntax', async () => {
    const payload = evidence();
    const { cwd, binary } = fixture(`
      require('node:fs').writeFileSync(process.env.GITREINS_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
      process.stdout.write(${JSON.stringify(JSON.stringify(payload))});
    `);
    const argsFile = path.join(cwd, 'args.json');
    const marker = path.join(cwd, 'SHOULD_NOT_EXIST');
    process.env.GITREINS_ARGS_FILE = argsFile;
    try {
      const request = input(cwd, binary);
      request.title = `story $(touch ${marker})`;
      const result = await runGitReinsJudge(request);
      expect(result.status).toBe('pass');
      expect(result.shouldBlock).toBe(false);
      expect(fs.existsSync(marker)).toBe(false);
      expect(JSON.parse(fs.readFileSync(argsFile, 'utf8'))).toEqual([
        'judge', 'rorca-7-US-001', '--ephemeral', '--title', request.title,
        '--criterion', 'criterion one', '--scope', 'working-tree', '--json',
      ]);
    } finally {
      delete process.env.GITREINS_ARGS_FILE;
    }
  });

  test.each([
    ['observe', false],
    ['enforce', true],
  ] as const)('%s mode records judge failure with correct blocking behavior', async (mode, shouldBlock) => {
    const payload = evidence(false, 'acceptance criterion failed');
    const { cwd, binary } = fixture(`
      process.stdout.write(${JSON.stringify(JSON.stringify(payload))});
      process.exitCode = 1;
    `);
    const result = await runGitReinsJudge(input(cwd, binary, mode));
    expect(result.status).toBe('fail');
    expect(result.reasonCode).toBe('judge_failed');
    expect(result.shouldBlock).toBe(shouldBlock);
  });

  test('disabled mode does not require config or spawn a process', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-gitreins-disabled-'));
    const result = await runGitReinsJudge(input(cwd, '/missing/binary', 'disabled'));
    expect(result.status).toBe('skipped');
    expect(result.reasonCode).toBe('disabled');
    expect(result.shouldBlock).toBe(false);
  });

  test.each([
    ['observe', false],
    ['enforce', true],
  ] as const)('%s mode handles missing config conservatively', async (mode, shouldBlock) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-gitreins-no-config-'));
    fs.mkdirSync(path.join(cwd, '.git'));
    const result = await runGitReinsJudge(input(cwd, '/missing/binary', mode));
    expect(result.reasonCode).toBe('missing_config');
    expect(result.shouldBlock).toBe(shouldBlock);
  });

  test('classifies missing binary, timeout, invalid evidence, output limit, and exit mismatch', async () => {
    const missing = fixture('');
    expect((await runGitReinsJudge(input(missing.cwd, path.join(missing.cwd, 'absent')))).reasonCode)
      .toBe('missing_binary');
    expect((await runGitReinsJudge(input(missing.cwd, '\0invalid'))).reasonCode)
      .toBe('missing_binary');

    const timeout = fixture('setTimeout(() => {}, 10000)');
    const timeoutInput = input(timeout.cwd, timeout.binary);
    timeoutInput.timeoutMs = 1_000;
    expect((await runGitReinsJudge(timeoutInput)).reasonCode).toBe('timeout');

    const invalid = fixture("process.stdout.write('not-json')");
    expect((await runGitReinsJudge(input(invalid.cwd, invalid.binary))).reasonCode)
      .toBe('invalid_evidence');

    const oversized = fixture("process.stdout.write('x'.repeat(70000))");
    expect((await runGitReinsJudge(input(oversized.cwd, oversized.binary))).reasonCode)
      .toBe('output_limit');

    const mismatchPayload = evidence(true);
    const mismatch = fixture(`
      process.stdout.write(${JSON.stringify(JSON.stringify(mismatchPayload))});
      process.exitCode = 1;
    `);
    expect((await runGitReinsJudge(input(mismatch.cwd, mismatch.binary))).reasonCode)
      .toBe('exit_mismatch');
  });

  test('rejects evidence for a different task and supplies a fallback criterion', async () => {
    const wrongTask = evidence();
    wrongTask.subject.taskId = 'different-task';
    const wrong = fixture(`process.stdout.write(${JSON.stringify(JSON.stringify(wrongTask))});`);
    expect((await runGitReinsJudge(input(wrong.cwd, wrong.binary))).reasonCode)
      .toBe('invalid_evidence');

    const valid = evidence();
    const fallback = fixture(`
      const args = process.argv.slice(2);
      if (!args.includes('--criterion')) process.exit(2);
      process.stdout.write(${JSON.stringify(JSON.stringify(valid))});
    `);
    const request = input(fallback.cwd, fallback.binary);
    request.criteria = [];
    expect((await runGitReinsJudge(request)).status).toBe('pass');
  });

  test('redacts evidence and identifies linked worktrees without exposing the path', async () => {
    const payload = evidence(true, 'Bearer abcdefghijklmnopqrstuvwxyz123456');
    const { cwd, binary } = fixture(`process.stdout.write(${JSON.stringify(JSON.stringify(payload))});`, true);
    const result = await runGitReinsJudge(input(cwd, binary));
    expect(result.worktree).toBe(true);
    expect(result.evidence?.summary).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(JSON.stringify(result)).not.toContain(cwd);
  });
});
