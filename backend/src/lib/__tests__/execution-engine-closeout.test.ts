
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createStoryExecutionManifest, type StoryExecutionManifestInput } from '../story-execution-packet';
import {
  deriveIntegratedPassStoryResultIdempotencyKey,
  resolveIntegratedRunHead,
} from '../execution-engine';
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
const STORY_RESULT_PERSISTENCE_PATH = path.resolve(__dirname, '..', 'story-result-persistence.ts');
const WAL_LISTENER_PATH = path.resolve(__dirname, '..', 'wal-listener.ts');
const ENGINE_SOURCE = fs.readFileSync(ENGINE_PATH, 'utf8');
const PIPELINE_SOURCE = fs.readFileSync(PIPELINE_PATH, 'utf8');
const STORY_RESULT_PERSISTENCE_SOURCE = fs.readFileSync(STORY_RESULT_PERSISTENCE_PATH, 'utf8');
const WAL_LISTENER_SOURCE = fs.readFileSync(WAL_LISTENER_PATH, 'utf8');
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
    expect(finalizer.indexOf('resolveIntegratedRunHead(config)')).toBeLessThan(finalizer.indexOf('deriveIntegratedPassStoryResultIdempotencyKey({'));
    expect(finalizer.indexOf('deriveIntegratedPassStoryResultIdempotencyKey({')).toBeLessThan(finalizer.indexOf('await postStoryResult('));
    expect(finalizer.indexOf('resultIdempotencyKey')).toBeLessThan(finalizer.indexOf('await markStoryPassed('));
    expect(finalizer.indexOf("status: 'pass'")).toBeLessThan(finalizer.indexOf('await markStoryPassed('));
    expect(finalizer.indexOf('await postStoryResult(')).toBeLessThan(finalizer.indexOf('await markStoryPassed('));
    expect(finalizer.indexOf('await markStoryPassed(')).toBeLessThan(finalizer.indexOf('relayOrJournalTrustedWal'));
    expect(finalizer.indexOf('relayOrJournalTrustedWal')).toBeLessThan(finalizer.indexOf('if (!lifecycle.changed)'));
    expect(finalizer).toContain('commitSha: integratedHead.sha');
    expect(finalizer).toContain('commit_sha: integratedHead.sha');
    expect(finalizer).toContain('origin_commit_sha: pending.originCommitSha');
    expect(finalizer).toContain('trustedPassOutbox: { payload: passPayload }');
    expect(PIPELINE_SOURCE).toContain('await persistCanonicalStoryResult({');
    expect(STORY_RESULT_PERSISTENCE_SOURCE).toContain('return transaction(async (client) => {');
    expect(STORY_RESULT_PERSISTENCE_SOURCE).toContain('ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING');
    expect(STORY_RESULT_PERSISTENCE_SOURCE.indexOf('INSERT INTO story_results')).toBeLessThan(
      STORY_RESULT_PERSISTENCE_SOURCE.indexOf('INSERT INTO story_commits'),
    );
    expect(STORY_RESULT_PERSISTENCE_SOURCE.indexOf('INSERT INTO story_commits')).toBeLessThan(
      STORY_RESULT_PERSISTENCE_SOURCE.indexOf('INSERT INTO token_usage'),
    );
    expect(STORY_RESULT_PERSISTENCE_SOURCE).toContain('assertSameResultPayload(existing, input, projection, specId, commit, accounting, authority)');
    expect(STORY_RESULT_PERSISTENCE_SOURCE).toContain("result_provenance, result_source");
    expect(ENGINE_SOURCE.indexOf("await postStoryResult(config.port, {\n            runId: config.runId,\n            storyId: story.id,\n            status: 'fail'")).toBeGreaterThan(-1);
    expect(STORY_RESULT_PERSISTENCE_SOURCE).toContain('WHERE story_result_id = $1');
    expect(WAL_LISTENER_SOURCE).toContain('await persistLegacyStoryResultAccounting({');
    const fallbackSync = PIPELINE_SOURCE.slice(
      PIPELINE_SOURCE.indexOf('export async function syncFallbackResults('),
      PIPELINE_SOURCE.indexOf('// All Claude Code env vars', PIPELINE_SOURCE.indexOf('export async function syncFallbackResults(')),
    );
    expect(fallbackSync).toContain('await replayFallbackResults(cwd, workspaceId)');
    expect(fallbackSync).not.toContain('INSERT INTO story_results');
    expect(ENGINE_SOURCE).toContain('await deliverEngineStoryResult(context, {');
    expect(ENGINE_SOURCE).not.toContain("engineApiEndpoint(port, '/api/pipeline/story-result')");
  });

  test('reuses one bounded integrated-pass key across crash replay and scopes every immutable authority field', () => {
    const authority = {
      workspaceId: 'ws-closeout',
      runId: 31,
      storyId: 'LFC-031',
      integratedSha: SHA,
    };
    const first = deriveIntegratedPassStoryResultIdempotencyKey(authority);
    const replay = deriveIntegratedPassStoryResultIdempotencyKey({ ...authority });

    expect(replay).toBe(first);
    expect(first).toMatch(/^story-result:integrated-pass-v1:[0-9a-f]{64}$/);
    expect(first.length).toBeLessThanOrEqual(128);
    expect(deriveIntegratedPassStoryResultIdempotencyKey({ ...authority, workspaceId: 'ws-other' })).not.toBe(first);
    expect(deriveIntegratedPassStoryResultIdempotencyKey({ ...authority, runId: 32 })).not.toBe(first);
    expect(deriveIntegratedPassStoryResultIdempotencyKey({ ...authority, storyId: 'LFC-032' })).not.toBe(first);
    expect(deriveIntegratedPassStoryResultIdempotencyKey({ ...authority, integratedSha: BASE_SHA })).not.toBe(first);
    expect(deriveIntegratedPassStoryResultIdempotencyKey({
      ...authority,
      workspaceId: 'w'.repeat(10_000),
      storyId: 's'.repeat(10_000),
    }).length).toBeLessThanOrEqual(128);
  });

  test('proves the immutable integrated branch head and rejects an unfinished no-ff merge before pass', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-integrated-head-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      git('init', '-q');
      git('config', 'user.email', 'test@rorca.invalid');
      git('config', 'user.name', 'Rorca Test');
      fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
      git('add', 'base.txt');
      git('commit', '-q', '-m', 'base');
      const mainBranch = git('branch', '--show-current');
      git('checkout', '-q', '-b', 'story/test');
      fs.writeFileSync(path.join(repo, 'story.txt'), 'story\n');
      git('add', 'story.txt');
      git('commit', '-q', '-m', 'story');
      const originSha = git('rev-parse', 'HEAD');
      git('checkout', '-q', mainBranch);
      git('merge', '--no-ff', '--no-commit', 'story/test');
      expect(() => resolveIntegratedRunHead({ cwd: repo, workspacePath: repo, branchName: mainBranch })).toThrow('unfinished merge');
      git('commit', '-q', '-m', 'merge story');
      const integrated = resolveIntegratedRunHead({ cwd: repo, workspacePath: repo, branchName: mainBranch });
      expect(integrated.sha).toBe(git('rev-parse', 'HEAD'));
      expect(integrated.sha).not.toBe(originSha);
      expect(integrated.branch).toBe(mainBranch);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('establishes one immutable run fallback root and never rebinds it to story worktrees', () => {
    expect(ENGINE_SOURCE.match(/initializeRunFallbackContext\(/g)).toHaveLength(2); // definition + one run initialization
    expect(ENGINE_SOURCE).toContain('initializeRunFallbackContext(config.cwd, config.runId, workspaceId)');
    expect(ENGINE_SOURCE).not.toContain('initializeRunFallbackContext(effectiveCwd');
    expect(ENGINE_SOURCE).not.toContain('setFallbackContext(effectiveCwd');
    expect(ENGINE_SOURCE).toContain('Execution-engine fallback context cannot be rebound after run initialization');
    expect(ENGINE_SOURCE).toContain('failedIds.add(rejectedStory.id)');
    expect(ENGINE_SOURCE).toContain('processedIds.add(rejectedStory.id)');
  });

  test('covers direct/retry finalization and sequential/parallel worktree integration through one exact-head seam', () => {
    expect(ENGINE_SOURCE.match(/await finalizeIntegratedStoryPass\(/g)?.length).toBeGreaterThanOrEqual(4);
    expect(ENGINE_SOURCE).toContain('Single-story wave — direct merge');
    expect(ENGINE_SOURCE).toContain('await mergeWave(');
    expect(ENGINE_SOURCE).toContain('story, config, mode, playbook, logDir, workspaceId, retryCounts');
    expect(ENGINE_SOURCE.match(/const integratedHead = resolveIntegratedRunHead\(config\)/g)).toHaveLength(1);
    expect(ENGINE_SOURCE).not.toContain('commitSha: pending.commitSha');
  });

  test('keeps host database authority out of every model child environment', () => {
    expect(ENGINE_SOURCE).toContain('HOST_ONLY_AGENT_ENV_VARS');
    for (const key of ['DATABASE_URL', 'PGPASSWORD', 'PGDATABASE', 'RORCA_PROCESS_ROLE']) {
      expect(ENGINE_SOURCE).toContain(`'${key}'`);
    }
    expect(ENGINE_SOURCE).toContain("!k.startsWith('RORCA_WAL_TRUST_')");
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
      'ssdlc-plan-compiler',
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

  test('preserves all four nested-Claude environment removals and process cleanup paths', () => {
    const envBlock = ENGINE_SOURCE.slice(
      ENGINE_SOURCE.indexOf('const CLAUDE_ENV_VARS_TO_REMOVE'),
      ENGINE_SOURCE.indexOf('];', ENGINE_SOURCE.indexOf('const CLAUDE_ENV_VARS_TO_REMOVE')) + 2,
    );
    const names = [...envBlock.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((match) => match[1]);
    expect(names).toEqual([
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_AGENT_SDK_VERSION',
      'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
    ]);
    expect(ENGINE_SOURCE).toContain('!CLAUDE_ENV_VARS_TO_REMOVE.includes(k)');
    expect(ENGINE_SOURCE).toContain("child.kill('SIGTERM')");
    expect(ENGINE_SOURCE).toContain("child.kill('SIGKILL')");
    expect(ENGINE_SOURCE).toContain("process.on('SIGINT'");
    expect(ENGINE_SOURCE).toContain("process.on('SIGTERM'");
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
