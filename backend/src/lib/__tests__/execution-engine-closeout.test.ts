
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';

import { createStoryExecutionManifest, type StoryExecutionManifestInput } from '../story-execution-packet';
import {
  createStoryAttemptResult,
  evaluateStoryCloseout,
  persistStoryCloseoutBundle,
  type CloseoutDb,
  type StoryCloseoutHostFacts,
  type StoryManifest,
} from '../story-closeout';

const ENGINE_PATH = path.resolve(__dirname, '..', 'execution-engine.ts');
const PIPELINE_PATH = path.resolve(__dirname, '..', '..', 'routes', 'pipeline.ts');
const ENGINE_SOURCE = fs.readFileSync(ENGINE_PATH, 'utf8');
const PIPELINE_SOURCE = fs.readFileSync(PIPELINE_PATH, 'utf8');
const SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const CWD = '/tmp/rorca-closeout-story';

function manifestInput(
  executionMode: 'impl' | 'qa' | 'journey',
  agent: 'claude' | 'opencode' | 'codex' | 'pi',
  changePolicy: 'code_required' | 'no_code_allowed',
): StoryExecutionManifestInput {
  return {
    identity: { workspaceId: 'rorca', specId: 'lfc-031', storyId: 'LFC-031', runId: 31, attempt: 1 },
    revisions: { specRevision: 'sha256:spec', storyRevision: 'sha256:story' },
    executionMode,
    execution: {
      agent,
      model: null,
      effort: null,
      terminal: 'ansi-html',
      worktree: { enabled: true, path: CWD, branch: 'feat/lfc-031', baseRevision: BASE_SHA },
      merge: { enabled: false, strategy: 'branch-only', targetBranch: null },
    },
    validationPlan: [],
    evidenceExpectations: [],
    repositoryProfile: {
      profileId: `${executionMode}-${changePolicy}`,
      changePolicy,
      noCodeReason: changePolicy === 'no_code_allowed' ? 'The frozen profile authorizes evidence-only completion.' : null,
      runtimeMetadataPaths: ['.rorca/**'],
    },
    commandSafety: {
      profileId: 'autonomous-command-guard-v1',
      guardVersion: '1',
      guardedWorkingDirectory: CWD,
      allowedWorkingDirectories: [CWD],
      blockedCommandPatterns: ['backend Jest against a live database'],
      redactedEnvironmentKeys: ['DATABASE_URL'],
      allowBackendJest: false,
      baselineFailurePolicy: 'block',
    },
  };
}

function acceptedFacts(manifest: StoryManifest, codeChange: boolean) {
  const commit = {
    workspaceId: manifest.identity.workspaceId,
    specId: manifest.identity.specId,
    runId: manifest.identity.runId,
    storyId: manifest.identity.storyId,
    sha: SHA,
    branch: 'feat/lfc-031',
    message: 'feat(LFC-031): enforce closeout',
    author: 'rorca-host',
    committedAt: '2026-07-15T12:00:00.000Z',
    observedBy: 'worktree_branch' as const,
  };
  const attempt = createStoryAttemptResult({
    identity: { ...manifest.identity },
    revisions: { ...manifest.revisions },
    manifestHash: manifest.manifestHash,
    agentProcess: { agent: manifest.execution.agent, model: null, effort: null, processId: null, sessionId: null },
    startedAt: '2026-07-15T12:00:00.000Z',
    finishedAt: '2026-07-15T12:01:00.000Z',
    termination: { kind: 'exited', exitCode: 0 },
    outputReferences: [{
      kind: 'story_log',
      reference: 'story-log:LFC-031',
      byteLength: 8,
      sha256: null,
      redactedExcerpt: 'complete',
      truncated: false,
    }],
    proposedCompletionPacket: {
      manifestHash: manifest.manifestHash,
      identity: { ...manifest.identity },
      revisions: { ...manifest.revisions },
      proposal: 'complete',
      summary: 'Complete.',
      criterionEvidence: [],
    },
    observedFiles: codeChange ? [{ path: 'src/index.ts', changeType: 'modified', runtimeMetadata: false, observer: 'host' }] : [],
    observedCommits: codeChange ? [commit] : [],
    hostValidationObservations: [],
    knownIssues: [],
  });
  const host: StoryCloseoutHostFacts = {
    identity: { ...manifest.identity },
    activeSubjectRevision: { commitSha: SHA, worktreePath: CWD, branch: 'feat/lfc-031' },
    repository: {
      worktreeClean: true,
      changedFiles: codeChange ? ['src/index.ts'] : [],
      runtimeMetadataFiles: [],
      headBeforeValidation: SHA,
      headAfterValidation: SHA,
    },
    validations: [],
    criterionEvidence: [],
    storyCommits: codeChange ? [commit] : [],
    progress: null,
    storyResult: null,
  };
  return { attempt, host };
}

describe('execution-engine closeout architecture', () => {
  test('has exactly one gate invocation and calls it before every engine pass projection', () => {
    expect(ENGINE_SOURCE.match(/\bStoryCloseoutGate\(\{/g)).toHaveLength(1);
    expect(ENGINE_SOURCE.match(/await markStoryPassed\(/g)).toHaveLength(1);

    const executeStart = ENGINE_SOURCE.indexOf('async function executeStory(');
    const executeEnd = ENGINE_SOURCE.indexOf('// ─── Exported helpers for pipeline.ts', executeStart);
    const executeSource = ENGINE_SOURCE.slice(executeStart, executeEnd);
    const closeoutCall = executeSource.indexOf('closeout = await enforceStoryCloseout({');
    const localPass = executeSource.indexOf('rsMarkStoryCompleted(effectiveCwd');
    expect(closeoutCall).toBeGreaterThan(0);
    expect(localPass).toBeGreaterThan(closeoutCall);

    const finalizerStart = ENGINE_SOURCE.indexOf('async function finalizeIntegratedStoryPass(');
    const finalizerEnd = ENGINE_SOURCE.indexOf('async function recordStoryMergeConflict(', finalizerStart);
    const finalizer = ENGINE_SOURCE.slice(finalizerStart, finalizerEnd);
    expect(finalizer.indexOf('await markStoryPassed(')).toBeLessThan(finalizer.indexOf("'story_passed'"));
    expect(finalizer.indexOf('if (!transitioned)')).toBeLessThan(finalizer.indexOf("'story_passed'"));
    expect(finalizer.indexOf("'story_passed'")).toBeLessThan(finalizer.indexOf("status: 'pass'"));
  });

  test('keeps one mode/provider-neutral adapter and removes parallel merge bypasses', () => {
    const adapterStart = ENGINE_SOURCE.indexOf('export async function enforceStoryCloseout(');
    const adapterEnd = ENGINE_SOURCE.indexOf('// ─── Worktree Helpers', adapterStart);
    const adapter = ENGINE_SOURCE.slice(adapterStart, adapterEnd);
    for (const providerOrMode of ['claude', 'opencode', 'codex', "'pi'", "'impl'", "'qa'", "'journey'"]) {
      expect(adapter).not.toContain(providerOrMode);
    }
    expect(ENGINE_SOURCE).not.toMatch(/else\s*\{\s*await markStoryPassed\(/);
    expect(ENGINE_SOURCE).toContain("if (result === 'closeout_blocked' && wt)");
    expect(ENGINE_SOURCE).toContain('Preserving blocked worktree for inspection');
  });

  test('retains ANSI waves and makes the existing PTY contract explicitly sequential', () => {
    expect(ENGINE_SOURCE).toContain("config.parallelism > 1 && config.terminalMode !== 'pty' && !config.specificStory");
    expect(PIPELINE_SOURCE).toContain("const storyIsolated = input.parallelism > 1 && input.terminalMode !== 'pty'");
    expect(ENGINE_SOURCE).toContain('compileWaves(waveStories)');
    expect(ENGINE_SOURCE).toContain('runWithBoundedConcurrency(tasks, config.parallelism)');
    expect(ENGINE_SOURCE).toContain('computeBlockedStories(allStories, failedIds, processedIds)');
  });

  test('keeps retry/restart identity and timeout/cancellation paths fail closed', () => {
    const executeStart = ENGINE_SOURCE.indexOf('async function executeStory(');
    const executeEnd = ENGINE_SOURCE.indexOf('// ─── Exported helpers for pipeline.ts', executeStart);
    const executeSource = ENGINE_SOURCE.slice(executeStart, executeEnd);
    const success = executeSource.indexOf('if (result.exitCode === 0)');
    const closeout = executeSource.indexOf('closeout = await enforceStoryCloseout({');
    const timeout = executeSource.indexOf('if (result.exitCode === 124)');
    const nonZero = executeSource.indexOf('// ── Non-zero exit: classify error and retry');
    expect(success).toBeGreaterThan(0);
    expect(closeout).toBeGreaterThan(success);
    expect(timeout).toBeGreaterThan(closeout);
    expect(nonZero).toBeGreaterThan(timeout);
    expect(executeSource).toContain('requestedAttempt: executionManifest.identity.attempt + (retryCounts.get(story.id) ?? 0)');
    expect(executeSource).toContain("return 'closeout_blocked'");

    const adapterStart = ENGINE_SOURCE.indexOf('export async function enforceStoryCloseout(');
    const adapterEnd = ENGINE_SOURCE.indexOf('// ─── Worktree Helpers', adapterStart);
    const adapter = ENGINE_SOURCE.slice(adapterStart, adapterEnd);
    expect(adapter.indexOf('listStoryAttempts(')).toBeLessThan(adapter.indexOf('StoryCloseoutGate({'));
    expect(adapter.indexOf('StoryCloseoutGate({')).toBeLessThan(adapter.indexOf('persistStoryCloseoutBundle({'));
    expect(adapter).toContain('sameAttempt.attemptResultId !== bundleInput.attempt.attemptResultId');
    expect(adapter).toContain('deriveRetryStoryExecutionManifest(input.manifest, nextAttempt)');
    expect(ENGINE_SOURCE).toContain('freezeLoadedExecutionManifest(manifest)');

    expect(ENGINE_SOURCE).toContain("process.on('SIGTERM'");
    expect(ENGINE_SOURCE).toContain('process.exit(143)');
    expect(ENGINE_SOURCE).toContain("failReason: 'timeout'");
  });

  test('freezes existing legitimate no-code rules before dispatch rather than at closeout', () => {
    expect(PIPELINE_SOURCE).toContain('storyAllowsNoCodeChanges(story as EngineUserStory, mode)');
    expect(PIPELINE_SOURCE).toContain('changePolicy,');
    expect(PIPELINE_SOURCE).toContain('noCodeReason,');
    const adapterStart = ENGINE_SOURCE.indexOf('export async function enforceStoryCloseout(');
    const adapterEnd = ENGINE_SOURCE.indexOf('// ─── Worktree Helpers', adapterStart);
    expect(ENGINE_SOURCE.slice(adapterStart, adapterEnd)).not.toContain('storyAllowsNoCodeChanges');
  });

  test('does not import lifecycle authoring, approval, retry-planning, deployment, or UI modules', () => {
    const imports = [...ENGINE_SOURCE.matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1]);
    const forbidden = [
      'ssdlc-lifecycle-compiler',
      'ssdlc-phase-evaluator',
      'decomposition',
      'approval',
      'retry-planner',
      'deployment',
      '/routes/',
      '/src/components/',
      '/src/panels/',
    ];
    for (const fragment of forbidden) {
      expect(imports.some((modulePath) => modulePath.includes(fragment))).toBe(false);
    }
  });
});

describe('mode and provider closeout symmetry', () => {
  test.each(['impl', 'qa', 'journey'] as const)('%s uses the same gate contract for all four agents', (mode) => {
    for (const agent of ['claude', 'opencode', 'codex', 'pi'] as const) {
      const codeManifest = createStoryExecutionManifest(manifestInput(mode, agent, 'code_required'));
      const codeFacts = acceptedFacts(codeManifest, true);
      expect(evaluateStoryCloseout({ manifest: codeManifest, ...codeFacts }).status).toBe('accepted');

      const noCodeManifest = createStoryExecutionManifest(manifestInput(mode, agent, 'no_code_allowed'));
      const noCodeFacts = acceptedFacts(noCodeManifest, false);
      expect(evaluateStoryCloseout({ manifest: noCodeManifest, ...noCodeFacts }).status).toBe('accepted');
    }
  });

  test('stale frozen manifests fail closed before any pass path', () => {
    const manifest = createStoryExecutionManifest(manifestInput('impl', 'claude', 'code_required'));
    const facts = acceptedFacts(manifest, true);
    const stale = { ...manifest, manifestHash: `sha256:${'0'.repeat(64)}` };
    const decision = evaluateStoryCloseout({ manifest: stale, ...facts });
    expect(decision.status).toBe('blocked');
    expect(decision.reasonCodes).toContain('STALE_MANIFEST_HASH');
  });

  test.each([1, 2, 3])('persistence boundary %s rejects before pass finalization', async (failureCall) => {
    const manifest = createStoryExecutionManifest(manifestInput('impl', 'pi', 'code_required'));
    const facts = acceptedFacts(manifest, true);
    const decision = evaluateStoryCloseout({ manifest, ...facts });
    let queryOneCalls = 0;
    const db: CloseoutDb = {
      query: async <T>() => [] as T[],
      execute: async () => ({ rowCount: 0 }),
      queryOne: async <T>(sql: string) => {
        queryOneCalls += 1;
        if (queryOneCalls === failureCall) throw new Error(`injected-persistence-boundary-${failureCall}`);
        if (sql.includes('story_execution_manifests')) return { manifest_hash: manifest.manifestHash } as T;
        if (sql.includes('story_attempt_results')) return { attempt_result_id: facts.attempt.attemptResultId } as T;
        return { decision_id: decision.decisionId } as T;
      },
    };

    await expect(persistStoryCloseoutBundle({
      manifest,
      attempt: facts.attempt,
      decision,
      evidence: [],
    }, db)).rejects.toThrow(`injected-persistence-boundary-${failureCall}`);
  });
});
