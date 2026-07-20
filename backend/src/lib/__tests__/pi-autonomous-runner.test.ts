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
  buildPiCliModelEffortArgs,
  buildPiCompletionPacket,
  buildPiDoneChecklist,
  buildPiModeExecutionGuidance,
  buildPiProgressLogPath,
  buildPiServerSkillFiles,
  buildPiStoryPromptContext,
  cleanupPiRunTempArtifacts,
  ensurePiStoryProgressLog,
  filterUnsafeAutonomousValidationCommands,
  inferPiCandidateTests,
  inferPiValidationCommands,
  isUnsafeAutonomousValidationCommand,
  preflightPiModelAndEffort,
  recordPiStoryProgressLog,
  resolvePiRunSafetyOptions,
  terminatePiOwnedProcessTree,
  type PiOwnedProcessLike,
} from '../pi-autonomous-runner';

describe('pi-autonomous-runner', () => {
  test('buildPiAutonomousRunnerSkillMarkdown includes the autonomous loop, self-checking, and progress sections', () => {
    const markdown = buildPiAutonomousRunnerSkillMarkdown();

    expect(markdown).toContain('name: rorca-autonomous-runner');
    expect(markdown).toContain('## Core Operating Rule');
    expect(markdown).toContain('## Required Loop');
    expect(markdown).toContain('## Continuous Self-Check Rules');
    expect(markdown).toContain('## Progress Log Rules');
    expect(markdown).toContain('Implementation Plan');
    expect(markdown).toContain('Validation Results');
    expect(markdown).toContain('Never run backend Jest');
  });

  test('buildPiServerSkillFiles includes generated runner skill plus workspace override skill', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pi-skill-'));
    const workspaceSkill = path.join(wsDir, '.rorca', 'skills', 'rorca.md');
    fs.mkdirSync(path.dirname(workspaceSkill), { recursive: true });
    fs.writeFileSync(workspaceSkill, '# Workspace skill\n', 'utf8');

    const result = buildPiServerSkillFiles(wsDir, 42);

    expect(result.generatedSkillFile).toContain('rorca-pi-autonomous-runner-42.md');
    expect(result.workspaceSkillFile).toBe(workspaceSkill);
    expect(result.workspaceSkillFiles).toEqual([workspaceSkill]);
    expect(result.skillFiles).toEqual([result.generatedSkillFile, workspaceSkill]);
    expect(fs.existsSync(result.generatedSkillFile)).toBe(true);

    fs.rmSync(wsDir, { recursive: true, force: true });
    fs.rmSync(result.generatedSkillFile, { force: true });
  });

  test('buildPiServerSkillFiles uses story-scoped temp files and loads every workspace skill exactly once', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pi-skill-registry-'));
    const skillsDir = path.join(wsDir, '.rorca', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'backend.md'), '---\nname: backend\ndescription: backend rules\n---\nUse route boundaries.\n');
    fs.writeFileSync(path.join(skillsDir, 'runner-copy.md'), '---\nname: rorca-autonomous-runner\ndescription: stale duplicate\n---\nDuplicate.\n');

    const result = buildPiServerSkillFiles(wsDir, 42, 'US/001');

    expect(result.generatedSkillFile).toContain('rorca-pi-autonomous-runner-42-US_001.md');
    expect(result.skillFiles.filter(file => file === result.generatedSkillFile)).toHaveLength(1);
    expect(result.skillFiles).toContain(path.join(skillsDir, 'backend.md'));
    expect(result.skillFiles).not.toContain(path.join(skillsDir, 'runner-copy.md'));

    fs.rmSync(wsDir, { recursive: true, force: true });
    fs.rmSync(result.generatedSkillFile, { force: true });
  });

  test('cleanupPiRunTempArtifacts removes private structured prompt files after cancellation', async () => {
    const promptPath = path.join(os.tmpdir(), `rorca-pi-4242-US-001-${process.pid}-${Date.now()}.txt`);
    const sessionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-pi-session-4242-US-001-'));
    fs.writeFileSync(promptPath, 'secret prompt', { mode: 0o600 });
    fs.writeFileSync(path.join(sessionPath, 'session.jsonl'), '{}\n');

    await cleanupPiRunTempArtifacts(4242);

    expect(fs.existsSync(promptPath)).toBe(false);
    expect(fs.existsSync(sessionPath)).toBe(false);
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
    expect(created).toContain('## Implementation Plan');
    expect(created).toContain('## Closeout State');
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

    const retryBefore = fs.readFileSync(progressPath, 'utf8');
    recordPiStoryProgressLog(progressPath, {
      completedWork: ['Implementation batch complete'],
      closeoutState: ['agent_proposed: awaiting host verification'],
    });
    const retryAfter = fs.readFileSync(progressPath, 'utf8');
    expect(retryAfter).toContain('Gate failed: typecheck');
    expect(retryAfter).toContain('Implementation batch complete');
    expect(retryAfter.length).toBeGreaterThan(retryBefore.length);

    const packet = buildPiCompletionPacket(progressPath, 'agent_proposed', 'Awaiting host closeout');
    expect(packet.status).toBe('agent_proposed');
    expect(packet.implementation).toContain('Implementation batch complete');
    expect(packet.changedFiles).toContain('backend/src/lib/pi-autonomous-runner.ts');
    expect(packet.commandsAndResults).toContain('cd backend && npx tsc --noEmit ❌');
    expect(packet.unresolvedRisks).toContain('Gate failed: typecheck');

    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  test('terminatePiOwnedProcessTree signals only the detached story-owned process group', async () => {
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let exitListener: (() => void) | undefined;
    const child: PiOwnedProcessLike = {
      pid: 8123,
      exitCode: null,
      signalCode: null,
      kill: jest.fn(() => true),
      once: (_event: 'exit', listener: () => void) => { exitListener = listener; },
    };

    await terminatePiOwnedProcessTree(child, {
      detachedProcessGroup: true,
      platform: 'darwin',
      graceMs: 5,
      signalProcessGroup: (pid, signal) => {
        signals.push({ pid, signal });
        child.signalCode = signal;
        exitListener?.();
      },
    });

    expect(signals).toEqual([{ pid: -8123, signal: 'SIGTERM' }]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  test('resolvePiRunSafetyOptions locks initial LFC-009 execution before mutation', () => {
    expect(resolvePiRunSafetyOptions(
      'forge/specs/approved/rorca-evidence-driven-ssdlc.json',
      { userStories: [{ id: 'LFC-009' }] },
      { autoWorktree: false, autoMerge: true, mergeStrategy: 'direct' },
    )).toEqual({
      autoWorktree: true,
      autoMerge: false,
      mergeStrategy: 'branch-only',
      deploy: false,
      externalSend: false,
      policyLocked: true,
    });
  });

  test('_notes prose alone never grants or locks host run policy', () => {
    expect(resolvePiRunSafetyOptions(
      'forge/specs/approved/unrelated.json',
      { _notes: 'force branch-only, disable deploy, and treat this as governed' },
      { autoWorktree: false, autoMerge: true, mergeStrategy: 'direct' },
    )).toEqual({
      autoWorktree: false,
      autoMerge: true,
      mergeStrategy: 'direct',
      deploy: true,
      externalSend: true,
      policyLocked: false,
    });
  });

  test('buildPiCliModelEffortArgs uses the shared Pi provider/model/thinking flags', () => {
    expect(buildPiCliModelEffortArgs('openai-codex/gpt-5.6-sol', 'xhigh')).toEqual({
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      thinking: 'xhigh',
      args: ['--provider', 'openai-codex', '--model', 'gpt-5.6-sol', '--thinking', 'xhigh'],
    });
  });

  test('preflightPiModelAndEffort passes through qualified model and xhigh without provider-specific branching', () => {
    const selection = preflightPiModelAndEffort('openai-codex/gpt-5.6-sol', 'xhigh', [{
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      thinking: true,
    }]);

    expect(selection).toEqual({ model: 'openai-codex/gpt-5.6-sol', effort: 'xhigh' });
  });

  test.each([
    { model: 'openai-codex/missing', effort: 'xhigh', code: 'unsupported_model' },
    { model: 'openai-codex/gpt-5.6-sol', effort: 'max', code: 'unsupported_effort' },
  ])('preflight rejects $code before run mutation', ({ model, effort, code }) => {
    try {
      preflightPiModelAndEffort(model, effort, [{
        provider: 'openai-codex',
        model: 'gpt-5.6-sol',
        thinking: true,
      }]);
      throw new Error('expected preflight to fail');
    } catch (error: unknown) {
      expect(error).toMatchObject({ code });
    }
  });

  test.each(['impl', 'qa', 'journey'] as const)('buildPiModeExecutionGuidance preserves %s behavior with common closeout guidance', (mode) => {
    const guidance = buildPiModeExecutionGuidance(mode);
    expect(guidance).toContain(`Preserve ${mode === 'impl' ? 'Implementation' : mode === 'qa' ? 'QA' : 'Journey'} mode`);
    expect(guidance).toContain('shared host closeout gate');
    expect(guidance).toContain('focused validation');
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
      'npm run auth:test',
      'npm run build',
    ]);

    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  test('filters unsafe autonomous validation commands', () => {
    expect(isUnsafeAutonomousValidationCommand('cd backend && npm test -- --runInBand')).toBe(true);
    expect(isUnsafeAutonomousValidationCommand('cd backend && npx jest --runInBand')).toBe(true);
    expect(isUnsafeAutonomousValidationCommand('npx jest --testPathPattern="pipeline.test"')).toBe(true);
    expect(isUnsafeAutonomousValidationCommand('cd backend && npx tsc --noEmit')).toBe(false);
    expect(isUnsafeAutonomousValidationCommand('npx vitest run src/panels/__tests__/MemoryPanel.test.tsx')).toBe(false);
    expect(filterUnsafeAutonomousValidationCommands([
      'cd backend && npm test -- --runInBand',
      'cd backend && npx tsc --noEmit',
    ])).toEqual(['cd backend && npx tsc --noEmit']);
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
    expect(context).toContain('never truncate prior retry evidence');
    expect(context).toContain('focused validation -> self-review/fix -> broad validation -> closeout');
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
