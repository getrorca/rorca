
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
import { storyLifecycleFixture } from './fixtures/story-execution-manifest.fixture';

const ENGINE_PATH = path.resolve(__dirname, '..', 'execution-engine.ts');
const PIPELINE_PATH = path.resolve(__dirname, '..', '..', 'routes', 'pipeline.ts');
const STORY_RESULT_PERSISTENCE_PATH = path.resolve(__dirname, '..', 'story-result-persistence.ts');
const COMPLETION_RUNNER_PATH = path.resolve(__dirname, '..', 'completion-runner.ts');
const COMPLETION_HOST_ADAPTER_PATH = path.resolve(__dirname, '..', 'completion-runner-host-adapter.ts');
const COMPLETION_CONTEXT_PATH = path.resolve(__dirname, '..', 'completion-runner-production-context.ts');
const WAL_LISTENER_PATH = path.resolve(__dirname, '..', 'wal-listener.ts');
const WORKER_PATH = path.resolve(__dirname, '..', '..', 'worker.ts');
const RELEASE_AUTHORITY_PATH = path.resolve(__dirname, '..', 'release-authority.ts');
const ENGINE_SOURCE = fs.readFileSync(ENGINE_PATH, 'utf8');
const PIPELINE_SOURCE = fs.readFileSync(PIPELINE_PATH, 'utf8');
const STORY_RESULT_PERSISTENCE_SOURCE = fs.readFileSync(STORY_RESULT_PERSISTENCE_PATH, 'utf8');
const COMPLETION_RUNNER_SOURCE = fs.readFileSync(COMPLETION_RUNNER_PATH, 'utf8');
const COMPLETION_HOST_ADAPTER_SOURCE = fs.readFileSync(COMPLETION_HOST_ADAPTER_PATH, 'utf8');
const COMPLETION_CONTEXT_SOURCE = fs.readFileSync(COMPLETION_CONTEXT_PATH, 'utf8');
const WAL_LISTENER_SOURCE = fs.readFileSync(WAL_LISTENER_PATH, 'utf8');
const WORKER_SOURCE = fs.readFileSync(WORKER_PATH, 'utf8');
const RELEASE_AUTHORITY_SOURCE = fs.readFileSync(RELEASE_AUTHORITY_PATH, 'utf8');
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
    lifecycle: storyLifecycleFixture('rorca', 'lfc-031', 'LFC-031'),
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
    const completionRunner = executeSource.indexOf('const completion = await runProductionCompletionStory({');
    const localPass = executeSource.indexOf('rsMarkStoryCompleted(effectiveCwd');
    expect(completionRunner).toBeGreaterThan(0);
    expect(localPass).toBeGreaterThan(completionRunner);

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
      PIPELINE_SOURCE.indexOf('function assertReusableWorktreeFresh(', PIPELINE_SOURCE.indexOf('export async function syncFallbackResults(')),
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
    expect(ENGINE_SOURCE).toContain("settlement: 'rejected'");
    expect(ENGINE_SOURCE).toContain('accountWaveSettlement({');
    expect(ENGINE_SOURCE).toContain('pendingIntegratedPasses.delete(storyId)');
  });

  test('covers direct/retry finalization and sequential/parallel worktree integration through one exact-head seam', () => {
    expect(ENGINE_SOURCE.match(/await finalizeIntegratedStoryPass\(/g)).toHaveLength(3);
    expect(ENGINE_SOURCE).toContain('Single-story wave — direct merge');
    expect(ENGINE_SOURCE).toContain('await integrateAndFinalizeWaveContribution(');
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
    expect(ENGINE_SOURCE).toContain("settled.value === 'closeout_blocked' && execution.wt");
    expect(ENGINE_SOURCE).toContain('Preserving blocked worktree for inspection');
  });

  test('retains ANSI waves and makes the existing PTY contract explicitly sequential', () => {
    expect(ENGINE_SOURCE).toContain('config.parallelism > 1 && !isPtyTerminalMode(config.terminalMode) && !config.specificStory');
    expect(PIPELINE_SOURCE).toContain('const storyIsolated = isolatedStoryIds.has(story.id)');
    expect(ENGINE_SOURCE).toContain('compileWaves(waveStories)');
    expect(ENGINE_SOURCE).toContain('runWaveTasksWithRejectionFence(waveExecutions.map(item => item.task), config.parallelism)');
    expect(ENGINE_SOURCE).toContain('computeTransitivelyBlockedStories(currentStories, failedIds, processedIds)');
    expect(ENGINE_SOURCE).toContain('Single-story wave — executing directly on the run branch (no per-story worktree)');
    expect(PIPELINE_SOURCE).toContain('if (!requiresPerStoryWorktree(wave.stories.length)) continue');
  });

  test('turns rejected wave promises into durable failure evidence before blocking and cleanup', () => {
    const parallelStart = ENGINE_SOURCE.indexOf('async function runParallel(');
    const parallel = ENGINE_SOURCE.slice(parallelStart);
    const rejectedAccounting = parallel.indexOf("settlement: 'rejected'");
    const durableFailure = parallel.indexOf("reasonCode: 'wave_promise_rejected'", rejectedAccounting);
    const dependencyBlocking = parallel.indexOf('await persistNewlyBlockedStories(wave.index)', durableFailure);
    const cleanup = parallel.indexOf('selectWaveWorktreeCleanup(', dependencyBlocking);

    expect(rejectedAccounting).toBeGreaterThan(0);
    expect(durableFailure).toBeGreaterThan(rejectedAccounting);
    expect(dependencyBlocking).toBeGreaterThan(durableFailure);
    expect(cleanup).toBeGreaterThan(dependencyBlocking);
    expect(parallel).toContain('pendingIntegratedPasses.delete(storyId)');
    expect(parallel).toContain('Rejected executor promises:');
    expect(parallel).toContain('pendingCloseoutIds: new Set(pendingIntegratedPasses.keys())');
    expect(WORKER_SOURCE).not.toContain('promoting execution closeout to done');
    expect(WORKER_SOURCE).toContain('Refusing to promote non-zero engine closeout despite complete-looking host authority');
    expect(WORKER_SOURCE).toContain("const hostReleaseOwned = status === 'done' && hostAuthority?.releaseEligible === true");
    expect(WORKER_SOURCE).toContain('await prepareRunReleaseIntent({');
    expect(WORKER_SOURCE).not.toContain('shouldRouteCompletedRunWorktree({');

    const persistenceStart = ENGINE_SOURCE.indexOf('async function recordParallelStoryInfrastructureFailure(');
    const persistenceEnd = ENGINE_SOURCE.indexOf('// ─── CA-011', persistenceStart);
    const persistence = ENGINE_SOURCE.slice(persistenceStart, persistenceEnd);
    expect(persistence).toContain("label: 'spec-story-failure'");
    expect(persistence).toContain("label: 'run-state-failure'");
    expect(persistence).toContain("label: 'story_failed-wal'");
    expect(persistence).toContain("label: 'story-result-failure'");
    expect(persistence).toContain('error_message: diagnostic.message');
    expect(persistence).toContain('error_stack: diagnostic.stack');
    expect(persistence).toContain('worktree_preserved: true');
    expect(ENGINE_SOURCE).toContain("fs.chmodSync(diagnosticPath, 0o600)");
    expect(persistence.match(/diagnostic\.rawDiagnostic/g)).toHaveLength(1);
    expect(persistence).not.toContain('error_raw');
    expect(persistence).not.toContain('diagnostic_log:');
    expect(persistence).not.toContain('logPath: diagnosticPath');

    const rejectedMutationStart = ENGINE_SOURCE.indexOf('async function markStoryPromiseRejected(');
    const rejectedMutationEnd = ENGINE_SOURCE.indexOf('/** Revert a story', rejectedMutationStart);
    const rejectedMutation = ENGINE_SOURCE.slice(rejectedMutationStart, rejectedMutationEnd);
    expect(rejectedMutation).toContain("story.status = 'failed'");
    expect(rejectedMutation).toContain('delete story.skipped');
    expect(rejectedMutation).not.toContain('story.skipped = true');
  });

  test('publishes broad run completion only after authoritative semantic closeout', () => {
    const handlerStart = WORKER_SOURCE.indexOf('async function handlePipelineRun(');
    const handlerEnd = WORKER_SOURCE.indexOf('// ── Job handler: pipeline:retry', handlerStart);
    const handler = WORKER_SOURCE.slice(handlerStart, handlerEnd);
    const interruptedFailure = handler.indexOf('await synthesizeInterruptedStoryFailure({');
    const remainingFailures = handler.indexOf("await synthesizeAllMissingFrozenStoryFailures(runId, String(workspaceId), 'engine_exit_incomplete');");
    const processFinished = handler.indexOf("emitWalEvent('run_process_finished'");
    const successfulHostCloseout = handler.indexOf('await persistHostRunCloseout({', processFinished);
    const releasePreparation = handler.indexOf('await prepareRunReleaseIntent({', successfulHostCloseout);
    const releaseReconciliation = handler.indexOf('await reconcileRunReleaseIntent(', releasePreparation);
    const failureHostCloseout = handler.indexOf('await persistHostRunCloseout({', successfulHostCloseout + 1);
    const closeHandlerEnd = handler.indexOf('const handleChildError', failureHostCloseout);

    expect(interruptedFailure).toBeGreaterThan(0);
    expect(remainingFailures).toBeGreaterThan(interruptedFailure);
    expect(processFinished).toBeGreaterThan(remainingFailures);
    expect(successfulHostCloseout).toBeGreaterThan(processFinished);
    expect(releasePreparation).toBeGreaterThan(successfulHostCloseout);
    expect(releaseReconciliation).toBeGreaterThan(releasePreparation);
    expect(failureHostCloseout).toBeGreaterThan(releaseReconciliation);
    expect(closeHandlerEnd).toBeGreaterThan(failureHostCloseout);
    expect(handler.slice(processFinished, closeHandlerEnd)).not.toContain("emitWalEvent('run_finished'");
    expect(handler).toContain('semanticCloseoutCompleted = true');
    expect(handler).toContain("status = release.status === 'completed' ? 'done' : 'release_pending'");
    expect(handler).toContain("'[worker] close handler failed'");
    expect(handler).toContain("throw new WorkerTerminalPersistenceError('Fresh run terminal persistence did not complete', err)");
    expect(handler).toContain('terminalizeFreshRunPreflightFailure(runId, reason');
    expect(handler).toContain('freshRunPreflightFailureDeps(runId)');
    expect(WORKER_SOURCE).toContain('synthesizeAllMissingFrozenStoryFailures(id, failureWorkspaceId, failureReason)');

    const releaseStart = RELEASE_AUTHORITY_SOURCE.indexOf('export async function reconcileRunReleaseIntent(');
    const release = RELEASE_AUTHORITY_SOURCE.slice(releaseStart);
    const durableCloseout = release.indexOf('const closeout = await loadHostRunCloseoutReference(runId)');
    const closeoutValidation = release.indexOf('if (closeout.reference.id !== row.host_closeout_event_id', durableCloseout);
    const terminalIntent = release.indexOf('terminal = await persistTerminalIntent(row)', closeoutValidation);
    const publicDone = release.indexOf('await commitPublicDoneAndTerminalReady(row, terminal)', terminalIntent);
    const terminalRelay = release.indexOf('await relayTrustedWalEvent(terminal)', publicDone);
    expect(durableCloseout).toBeGreaterThan(0);
    expect(closeoutValidation).toBeGreaterThan(durableCloseout);
    expect(terminalIntent).toBeGreaterThan(closeoutValidation);
    expect(publicDone).toBeGreaterThan(terminalIntent);
    expect(terminalRelay).toBeGreaterThan(publicDone);
    expect(RELEASE_AUTHORITY_SOURCE).toContain('semantic_closeout: true');
  });

  test('keeps retry/restart identity and timeout/cancellation paths fail closed', () => {
    const executeStart = ENGINE_SOURCE.indexOf('async function executeStory(');
    const executeEnd = ENGINE_SOURCE.indexOf('// ─── Exported helpers for pipeline.ts', executeStart);
    const executeSource = ENGINE_SOURCE.slice(executeStart, executeEnd);
    const success = executeSource.indexOf('if (result.exitCode === 0)');
    const completionRunner = executeSource.indexOf('const completion = await runProductionCompletionStory({');
    const timeout = executeSource.indexOf('if (result.exitCode === 124)');
    const nonZero = executeSource.indexOf('// ── Non-zero exit: classify error and retry');
    expect(success).toBeGreaterThan(0);
    expect(completionRunner).toBeGreaterThan(success);
    expect(timeout).toBeGreaterThan(completionRunner);
    expect(nonZero).toBeGreaterThan(timeout);
    expect(executeSource).toContain('requestedAttempt: hostAttemptAuthority?.manifest.identity.attempt');
    expect(executeSource).toContain('executionManifest.identity.attempt + (retryCounts.get(story.id) ?? 0)');
    expect(executeSource).toContain('hostAttemptAuthority,');
    expect(executeSource).toContain('?? executionManifest.identity.attempt + (retryCounts.get(story.id) ?? 0)');
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

  test('dispatches governed production closeout through durable runner host-gate authority without a raw-result bypass', () => {
    const executeStart = ENGINE_SOURCE.indexOf('async function executeStory(');
    const executeEnd = ENGINE_SOURCE.indexOf('// ─── Exported helpers for pipeline.ts', executeStart);
    const executeSource = ENGINE_SOURCE.slice(executeStart, executeEnd);
    const runnerDispatch = executeSource.indexOf('const completion = await runProductionCompletionStory({');
    const governedSubmit = executeSource.indexOf('submitCloseout: async () => {', runnerDispatch);
    const governedCloseout = executeSource.indexOf('const enforcedCloseout = await enforceStoryCloseout(closeoutInput);', governedSubmit);
    const missingGovernedBranch = executeSource.indexOf("if (completion.kind === 'not_governed')", governedCloseout);
    const missingGovernedFallback = executeSource.indexOf('closeout = await enforceStoryCloseout(closeoutInput);', missingGovernedBranch);
    const acceptanceCheck = executeSource.indexOf('completion.runner.finalReportEligible', missingGovernedFallback);
    const localPass = executeSource.indexOf('rsMarkStoryCompleted(effectiveCwd', acceptanceCheck);

    expect(runnerDispatch).toBeGreaterThan(0);
    expect(governedSubmit).toBeGreaterThan(runnerDispatch);
    expect(governedCloseout).toBeGreaterThan(governedSubmit);
    expect(missingGovernedBranch).toBeGreaterThan(governedCloseout);
    // Standard dispatch writes execution manifests without a governed attempt;
    // the not_governed case is legacy, not a bypass: it falls back to the same
    // closeout enforcement the governed lane submits through.
    expect(missingGovernedFallback).toBeGreaterThan(missingGovernedBranch);
    expect(executeSource).toContain('governedCompletionPath = false');
    expect(acceptanceCheck).toBeGreaterThan(missingGovernedFallback);
    expect(localPass).toBeGreaterThan(acceptanceCheck);
    expect(executeSource.match(/await enforceStoryCloseout\(closeoutInput\)/g)).toHaveLength(2);
    expect(executeSource).toContain("completion.kind === 'blocked'");
    expect(executeSource).toContain("completion.runner.status !== 'closeout_accepted'");
    expect(executeSource).toContain('completion.runner.closeoutDecisionId !== governedCloseout.decision.decisionId');
    const runnerFailureCatch = executeSource.indexOf('} catch (error: unknown) {', acceptanceCheck);
    const discardCapturedCloseout = executeSource.indexOf('closeout = null;', runnerFailureCatch);
    const outerAcceptance = executeSource.indexOf("if (!closeout || closeout.decision.status !== 'accepted')", discardCapturedCloseout);
    expect(runnerFailureCatch).toBeGreaterThan(acceptanceCheck);
    expect(discardCapturedCloseout).toBeGreaterThan(runnerFailureCatch);
    expect(outerAcceptance).toBeGreaterThan(discardCapturedCloseout);
    const governedStop = executeSource.indexOf("if (governedCompletionPath) return 'closeout_blocked';", outerAcceptance);
    const legacyRetry = executeSource.indexOf("await emitWalEvent(config.port, 'story_retry'", governedStop);
    expect(governedStop).toBeGreaterThan(outerAcceptance);
    expect(legacyRetry).toBeGreaterThan(governedStop);
    expect(executeSource).toContain('if (!governedCompletionPath) retryCounts.set(story.id, currentRetries)');

    const durableOpen = COMPLETION_RUNNER_SOURCE.indexOf('const persistence = await createCompletionRunnerPersistence({');
    const durableReload = COMPLETION_RUNNER_SOURCE.indexOf('await persistence.durable.reloadAndReconcile', durableOpen);
    const wrappedTurn = COMPLETION_RUNNER_SOURCE.indexOf('persistence.wrapPorts(ports)', durableReload);
    expect(durableOpen).toBeGreaterThan(0);
    expect(durableReload).toBeGreaterThan(durableOpen);
    expect(wrappedTurn).toBeGreaterThan(durableReload);
    expect(COMPLETION_RUNNER_SOURCE).toContain('consumptionId: continuationConsumptionId(lifecycle)');
    expect(COMPLETION_RUNNER_SOURCE).toContain('const consumed = await persistence.consumeContinuation(acceptedClaim)');
    expect(COMPLETION_RUNNER_SOURCE).toContain("consumed.disposition !== 'accepted'");
    expect(COMPLETION_RUNNER_SOURCE).not.toContain('settledContinuationReceipt');

    const productionEntry = COMPLETION_HOST_ADAPTER_SOURCE.indexOf('export async function runProductionCompletionStory(');
    const contextLoad = COMPLETION_HOST_ADAPTER_SOURCE.indexOf('await loadProductionCompletionContext(input.identity)', productionEntry);
    const durableRunner = COMPLETION_HOST_ADAPTER_SOURCE.indexOf('const runner = await runCompletionRunner({', contextLoad);
    expect(productionEntry).toBeGreaterThan(0);
    expect(contextLoad).toBeGreaterThan(productionEntry);
    expect(durableRunner).toBeGreaterThan(contextLoad);
    expect(COMPLETION_CONTEXT_SOURCE).toContain('WHERE workspace_id=$1 AND run_id=$2 AND story_id=$3');
    expect(COMPLETION_CONTEXT_SOURCE).toContain('const exactGoverned = governed.rows.filter((row) => row.manifest_hash === identity.manifestHash)');
    expect(COMPLETION_CONTEXT_SOURCE).toContain("if (governed.rows.length === 0) return { kind: 'not_governed' }");
    expect(COMPLETION_CONTEXT_SOURCE).toContain("if (exactGoverned.length !== 1) return { kind: 'governed_incomplete'");
    expect(COMPLETION_HOST_ADAPTER_SOURCE).not.toContain('enforceStoryCloseout');
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
