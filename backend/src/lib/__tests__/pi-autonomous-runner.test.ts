/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildPiAutonomousRunnerSkillMarkdown,
  buildPiDoneChecklist,
  buildPiProgressLogPath,
  buildPiServerSkillFiles,
  buildPiStoryPromptContext,
  ensurePiStoryProgressLog,
  inferPiCandidateTests,
  inferPiValidationCommands,
  recordPiStoryProgressLog,
} from '../pi-autonomous-runner';

describe('pi-autonomous-runner', () => {
  test('buildPiAutonomousRunnerSkillMarkdown includes the autonomous loop, self-checking, and progress sections', () => {
    const markdown = buildPiAutonomousRunnerSkillMarkdown();

    expect(markdown).toContain('name: rorca-autonomous-runner');
    expect(markdown).toContain('## Core Operating Rule');
    expect(markdown).toContain('## Required Loop');
    expect(markdown).toContain('## Continuous Self-Check Rules');
    expect(markdown).toContain('## Progress Log Rules');
    expect(markdown).toContain('Validation Results');
  });

  test('buildPiServerSkillFiles includes generated runner skill plus workspace override skill', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pi-skill-'));
    const workspaceSkill = path.join(wsDir, '.rorca', 'skills', 'rorca.md');
    fs.mkdirSync(path.dirname(workspaceSkill), { recursive: true });
    fs.writeFileSync(workspaceSkill, '# Workspace skill\n', 'utf8');

    const result = buildPiServerSkillFiles(wsDir, 42);

    expect(result.generatedSkillFile).toContain('rorca-pi-autonomous-runner-42.md');
    expect(result.workspaceSkillFile).toBe(workspaceSkill);
    expect(result.skillFiles).toEqual([result.generatedSkillFile, workspaceSkill]);
    expect(fs.existsSync(result.generatedSkillFile)).toBe(true);

    fs.rmSync(wsDir, { recursive: true, force: true });
    fs.rmSync(result.generatedSkillFile, { force: true });
  });

  test('ensurePiStoryProgressLog creates a seeded template and never overwrites an existing log', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pi-progress-'));
    const progressPath = buildPiProgressLogPath(wsDir, 7, 'US-001');

    ensurePiStoryProgressLog(progressPath, {
      runId: 7,
      storyId: 'US-001',
      storyTitle: 'Implement Pi runner',
      mode: 'impl',
      acceptanceCriteria: '- AC1\n- AC2',
      doneChecklist: ['Finish implementation', 'Run validation'],
      candidateFiles: ['backend/src/lib/pi-autonomous-runner.ts'],
      candidateTests: ['backend/src/lib/__tests__/pi-autonomous-runner.test.ts'],
      validationCommands: ['cd backend && npx tsc --noEmit'],
      expectedArtifacts: ['tests', 'backend route changes'],
      readinessWarnings: ['No concrete file targets were named.'],
    });

    const created = fs.readFileSync(progressPath, 'utf8');
    expect(created).toContain('## Done Definition');
    expect(created).toContain('## Candidate Files');
    expect(created).toContain('## Candidate Tests');
    expect(created).toContain('## Expected Artifacts');
    expect(created).toContain('## Validation Plan');
    expect(created).toContain('## Execution Risks');
    expect(created).toContain('Implement Pi runner');
    expect(created).toContain('backend/src/lib/pi-autonomous-runner.ts');

    fs.writeFileSync(progressPath, 'custom progress', 'utf8');
    ensurePiStoryProgressLog(progressPath, {
      runId: 7,
      storyId: 'US-001',
      storyTitle: 'Implement Pi runner',
    });

    expect(fs.readFileSync(progressPath, 'utf8')).toBe('custom progress');

    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  test('recordPiStoryProgressLog appends unique engine-visible updates to tracked sections', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pi-progress-merge-'));
    const progressPath = buildPiProgressLogPath(wsDir, 11, 'US-002');

    ensurePiStoryProgressLog(progressPath, {
      runId: 11,
      storyId: 'US-002',
      storyTitle: 'Retry with context',
    });

    recordPiStoryProgressLog(progressPath, {
      knownIssues: ['Gate failed: typecheck'],
      validationResults: ['cd backend && npx tsc --noEmit ❌'],
      modifiedFiles: ['backend/src/lib/execution-engine.ts'],
    });
    recordPiStoryProgressLog(progressPath, {
      knownIssues: ['Gate failed: typecheck'],
      validationResults: ['cd backend && npx tsc --noEmit ❌'],
      modifiedFiles: ['backend/src/lib/execution-engine.ts', 'backend/src/lib/pi-autonomous-runner.ts'],
    });

    const content = fs.readFileSync(progressPath, 'utf8');
    expect(content.match(/Gate failed: typecheck/g)?.length).toBe(1);
    expect(content).toContain('backend/src/lib/execution-engine.ts');
    expect(content).toContain('backend/src/lib/pi-autonomous-runner.ts');

    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  test('inferPiCandidateTests finds likely existing tests for predicted files', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pi-tests-'));
    const libFile = path.join(wsDir, 'backend', 'src', 'lib', 'feature.ts');
    const libTest = path.join(wsDir, 'backend', 'src', 'lib', '__tests__', 'feature.test.ts');
    fs.mkdirSync(path.dirname(libFile), { recursive: true });
    fs.mkdirSync(path.dirname(libTest), { recursive: true });
    fs.writeFileSync(libFile, 'export const x = 1;\n', 'utf8');
    fs.writeFileSync(libTest, 'test("x", () => {});\n', 'utf8');

    const tests = inferPiCandidateTests(wsDir, ['backend/src/lib/feature.ts']);

    expect(tests).toEqual(['backend/src/lib/__tests__/feature.test.ts']);

    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  test('inferPiValidationCommands prefers repo-native lint/typecheck/test/build commands when present', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pi-commands-'));
    fs.writeFileSync(path.join(wsDir, 'package.json'), JSON.stringify({
      scripts: {
        lint: 'eslint src/',
        typecheck: 'tsc --noEmit',
        build: 'vite build',
        'auth:test': 'playwright test tests/auth.spec.ts',
      },
    }, null, 2));
    fs.writeFileSync(path.join(wsDir, 'tsconfig.json'), '{}\n', 'utf8');

    const backendDir = path.join(wsDir, 'backend');
    fs.mkdirSync(backendDir, { recursive: true });
    fs.writeFileSync(path.join(backendDir, 'package.json'), JSON.stringify({
      scripts: {
        lint: 'eslint src/',
        test: 'jest',
      },
    }, null, 2));
    fs.writeFileSync(path.join(backendDir, 'tsconfig.json'), '{}\n', 'utf8');

    const commands = inferPiValidationCommands(wsDir, 'journey');

    expect(commands).toEqual([
      'npm run lint',
      'npm run typecheck',
      'npx tsc --noEmit',
      'cd backend && npx tsc --noEmit',
      'cd backend && npm run lint',
      'cd backend && npm test -- --runInBand',
      'npm run auth:test',
      'npm run build',
    ]);

    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  test('buildPiDoneChecklist folds in acceptance criteria and mode-specific expectations', () => {
    const checklist = buildPiDoneChecklist('- AC1\n- AC2', 'qa');

    expect(checklist[0]).toContain('Required automated tests');
    expect(checklist).toContain('Acceptance criterion satisfied: AC1');
    expect(checklist).toContain('Acceptance criterion satisfied: AC2');
  });

  test('buildPiStoryPromptContext includes attempt, done definition, likely files/tests, and validation plan', () => {
    const context = buildPiStoryPromptContext({
      progressLogPath: '/tmp/run-1/US-001.md',
      attempt: 2,
      maxAttempts: 3,
      doneChecklist: ['Finish implementation'],
      candidateFiles: ['backend/src/lib/execution-engine.ts'],
      candidateTests: ['backend/src/lib/__tests__/pi-autonomous-runner.test.ts'],
      validationCommands: ['cd backend && npx tsc --noEmit'],
      expectedArtifacts: ['tests'],
      readinessWarnings: ['Story reads like analysis/baseline work and may cause non-edit attempts.'],
      directionText: 'L1\nL2\nL3',
    });

    expect(context).toContain('Progress log path: /tmp/run-1/US-001.md');
    expect(context).toContain('Current attempt: 2/3');
    expect(context).toContain('## Done Definition');
    expect(context).toContain('## Likely Files / Modules');
    expect(context).toContain('## Likely Tests');
    expect(context).toContain('## Validation Plan');
    expect(context).toContain('## Expected Artifacts');
    expect(context).toContain('## Execution Risks');
    expect(context).toContain('=== RORCA DIRECTION STACK ===');
    expect(context).toContain('L1\nL2\nL3');
  });
});
