
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  createStoryExecutionManifest,
  deriveStoryCommandHash,
  type StoryExecutionManifestInput,
} from '../story-execution-packet';
import {
  LEGACY_CLOSEOUT_RULE_NAME,
  appendStoryAttemptResult,
  createHostValidationObservation,
  createStoryAttemptResult,
  evaluateStoryCloseout,
  persistStoryCloseoutBundle,
  type CloseoutDb,
  type HostValidationObservation,
  type ObservedStoryCommit,
  type StoryAttemptResult,
  type StoryCloseoutHostFacts,
  type StoryManifest,
} from '../story-closeout';

const NOW = '2026-07-15T12:00:00.000Z';
const LATER = '2026-07-15T12:01:00.000Z';
const SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const WORKTREE = '/tmp/rorca-story-worktree';
const BRANCH = 'feat/ssdlc';
const CRITERION = 'LFC-008:ac:1';
const EVIDENCE = `EVD-sha256:${'c'.repeat(64)}`;

function manifestInput(overrides: Partial<StoryExecutionManifestInput> = {}): StoryExecutionManifestInput {
  return {
    identity: { workspaceId: 'rorca', specId: 'ssdlc', storyId: 'LFC-008', runId: 42, attempt: 1 },
    revisions: { specRevision: 'sha256:spec', storyRevision: 'sha256:story' },
    executionMode: 'impl',
    execution: {
      agent: 'pi',
      model: 'openai-codex/gpt-5.4',
      effort: 'high',
      terminal: 'ansi-html',
      worktree: { enabled: true, path: WORKTREE, branch: BRANCH, baseRevision: BASE_SHA },
      merge: { enabled: false, strategy: 'branch-only', targetBranch: 'main' },
    },
    validationPlan: [{
      id: 'backend-typecheck',
      command: 'npx',
      args: ['tsc', '--noEmit'],
      required: true,
      revisionSensitive: true,
      timeoutMs: 300_000,
    }],
    evidenceExpectations: [{
      criterionId: CRITERION,
      description: 'The contract is proven by host-observed validation.',
      requiredEvidenceKinds: ['validation', 'revision'],
    }],
    repositoryProfile: {
      profileId: 'code-change-v1',
      changePolicy: 'code_required',
      noCodeReason: null,
      runtimeMetadataPaths: ['.rorca/progress/**', 'MEMORY.md'],
    },
    commandSafety: {
      profileId: 'autonomous-safe-v1',
      guardVersion: '1',
      guardedWorkingDirectory: WORKTREE,
      allowedWorkingDirectories: [WORKTREE],
      blockedCommandPatterns: ['backend jest against live database'],
      redactedEnvironmentKeys: ['API_TOKEN', 'DATABASE_URL'],
      allowBackendJest: false,
      baselineFailurePolicy: 'allow_with_host_evidence',
    },
    ...overrides,
  };
}

function validation(overrides: Partial<HostValidationObservation> = {}): HostValidationObservation {
  return createHostValidationObservation({
    observationId: 'validation-1',
    requirementId: 'backend-typecheck',
    observer: 'rorca_host',
    command: 'npx',
    args: ['tsc', '--noEmit'],
    commandHash: deriveStoryCommandHash('npx', ['tsc', '--noEmit']),
    guardedWorkingDirectory: WORKTREE,
    environment: {
      profileId: 'autonomous-safe-v1',
      fingerprint: `sha256:${'d'.repeat(64)}`,
      redactedKeys: ['DATABASE_URL', 'API_TOKEN'],
    },
    startedAt: NOW,
    finishedAt: LATER,
    termination: { kind: 'exited', exitCode: 0 },
    classification: 'passed',
    output: {
      kind: 'validation_output',
      reference: 'run-output:42:validation-1',
      byteLength: 21,
      sha256: `sha256:${'e'.repeat(64)}`,
      redactedExcerpt: 'Typecheck passed.',
      truncated: false,
    },
    subject: { commitSha: SHA, worktreePath: WORKTREE, branch: BRANCH },
    repositoryRevisionBefore: SHA,
    repositoryRevisionAfter: SHA,
    criterionIds: [CRITERION],
    baselineEvidenceReferences: [],
    policyTreatmentReference: null,
    remediation: null,
    ...overrides,
  });
}

function commit(manifest: StoryManifest, overrides: Partial<ObservedStoryCommit> = {}): ObservedStoryCommit {
  return {
    workspaceId: manifest.identity.workspaceId,
    specId: manifest.identity.specId,
    runId: manifest.identity.runId,
    storyId: manifest.identity.storyId,
    sha: SHA,
    branch: BRANCH,
    message: 'feat(LFC-008): story closeout contracts',
    author: 'rorca-host',
    committedAt: NOW,
    observedBy: 'worktree_branch',
    ...overrides,
  };
}

function attempt(manifest: StoryManifest, overrides: Partial<Parameters<typeof createStoryAttemptResult>[0]> = {}): StoryAttemptResult {
  return createStoryAttemptResult({
    identity: { ...manifest.identity },
    revisions: { ...manifest.revisions },
    manifestHash: manifest.manifestHash,
    agentProcess: { agent: manifest.execution.agent, model: manifest.execution.model, effort: manifest.execution.effort, processId: 123, sessionId: 'pi-session' },
    startedAt: NOW,
    finishedAt: LATER,
    termination: { kind: 'exited', exitCode: 0 },
    outputReferences: [{
      kind: 'story_log',
      reference: 'story-output:42:LFC-008',
      byteLength: 100,
      sha256: `sha256:${'f'.repeat(64)}`,
      redactedExcerpt: 'Agent proposed completion.',
      truncated: false,
    }],
    proposedCompletionPacket: {
      manifestHash: manifest.manifestHash,
      identity: { ...manifest.identity },
      revisions: { ...manifest.revisions },
      proposal: 'complete',
      summary: 'Implementation proposed as complete.',
      criterionEvidence: [{ criterionId: CRITERION, evidenceReferences: ['agent-claim:not-authoritative'] }],
    },
    observedFiles: [],
    observedCommits: [],
    hostValidationObservations: [validation()],
    knownIssues: [],
    ...overrides,
  });
}

function scoped(manifest: StoryManifest) {
  return {
    workspaceId: manifest.identity.workspaceId,
    specId: manifest.identity.specId,
    runId: manifest.identity.runId,
    storyId: manifest.identity.storyId,
    manifestHash: manifest.manifestHash,
    specRevision: manifest.revisions.specRevision,
    storyRevision: manifest.revisions.storyRevision,
  };
}

function host(manifest: StoryManifest, overrides: Partial<StoryCloseoutHostFacts> = {}): StoryCloseoutHostFacts {
  return {
    identity: { ...manifest.identity },
    activeSubjectRevision: { commitSha: SHA, worktreePath: WORKTREE, branch: BRANCH },
    repository: {
      worktreeClean: true,
      changedFiles: [],
      runtimeMetadataFiles: [],
      headBeforeValidation: SHA,
      headAfterValidation: SHA,
    },
    validations: [validation()],
    criterionEvidence: [{
      criterionId: CRITERION,
      evidenceReferences: [EVIDENCE],
      subjectRevision: SHA,
      observedBy: 'rorca_host',
    }],
    storyCommits: [commit(manifest)],
    progress: { ...scoped(manifest), reportsComplete: true },
    storyResult: { ...scoped(manifest), status: 'pass' },
    ...overrides,
  };
}

describe('story-closeout', () => {
  test('accepts host evidence and direct story commits when the worktree is clean', () => {
    const manifest = createStoryExecutionManifest(manifestInput());
    const result = evaluateStoryCloseout({ manifest, attempt: attempt(manifest), host: host(manifest) });

    expect(result.status).toBe('accepted');
    expect(result.reasonCodes).toEqual(['ACCEPTED']);
    expect(result.acceptanceCriteria).toEqual([{
      criterionId: CRITERION,
      status: 'satisfied',
      evidenceReferences: [EVIDENCE],
      blockerReasonCodes: [],
    }]);
    expect(result.normalizedEvidenceReferences).toHaveLength(2);
    expect(result).not.toHaveProperty('phaseStatus');
    expect(result).not.toHaveProperty('approval');
    expect(evaluateStoryCloseout({ manifest, attempt: attempt(manifest), host: host(manifest) }).decisionId).toBe(result.decisionId);
  });

  test('agent success and claimed output cannot replace missing host evidence', () => {
    const manifest = createStoryExecutionManifest(manifestInput());
    const result = evaluateStoryCloseout({
      manifest,
      attempt: attempt(manifest),
      host: host(manifest, { validations: [], criterionEvidence: [], storyCommits: [] }),
    });

    expect(result.status).toBe('blocked');
    expect(result.reasonCodes).toEqual(expect.arrayContaining(['MISSING_REQUIRED_VALIDATION', 'MISSING_CRITERION_EVIDENCE', 'MISSING_OBSERVED_OUTPUT']));
  });

  test('blocks dirty worktrees and metadata-only false positives', () => {
    const manifest = createStoryExecutionManifest(manifestInput());
    const result = evaluateStoryCloseout({
      manifest,
      attempt: attempt(manifest),
      host: host(manifest, {
        repository: {
          worktreeClean: false,
          changedFiles: ['MEMORY.md', '.rorca/progress/run/story.md'],
          runtimeMetadataFiles: ['MEMORY.md', '.rorca/progress/run/story.md'],
          headBeforeValidation: SHA,
          headAfterValidation: SHA,
        },
        storyCommits: [],
      }),
    });

    expect(result.reasonCodes).toEqual(expect.arrayContaining(['DIRTY_WORKTREE', 'METADATA_ONLY_OUTPUT']));
    expect(result.nextSafeAction.code).toBe('inspect_worktree');
  });

  test.each(['impl', 'qa', 'journey'] as const)('permits explicit no-code work in %s mode only through the manifest profile', (executionMode) => {
    const manifest = createStoryExecutionManifest(manifestInput({
      executionMode,
      repositoryProfile: {
        profileId: `${executionMode}-evidence-only-v1`,
        changePolicy: 'no_code_allowed',
        noCodeReason: `The governed ${executionMode} profile requires evidence but no repository mutation.`,
        runtimeMetadataPaths: [],
      },
    }));
    const result = evaluateStoryCloseout({
      manifest,
      attempt: attempt(manifest),
      host: host(manifest, { storyCommits: [] }),
    });

    expect(result.status).toBe('accepted');
  });

  test('blocks forged host validation and contradictory packet/progress/result/commit identities', () => {
    const manifest = createStoryExecutionManifest(manifestInput());
    const forged = { ...validation(), observer: 'agent' as HostValidationObservation['observer'] };
    const result = evaluateStoryCloseout({
      manifest,
      attempt: attempt(manifest, {
        proposedCompletionPacket: {
          ...attempt(manifest).proposedCompletionPacket!,
          manifestHash: `sha256:${'0'.repeat(64)}`,
        },
      }),
      host: host(manifest, {
        validations: [forged],
        progress: { ...scoped(manifest), storyId: 'OTHER-001', reportsComplete: true },
        storyResult: { ...scoped(manifest), status: 'fail' },
        storyCommits: [commit(manifest, { runId: 99 })],
      }),
    });

    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      'FORGED_VALIDATION',
      'PACKET_CONTRADICTION',
      'PROGRESS_CONTRADICTION',
      'STORY_RESULT_CONTRADICTION',
      'STORY_COMMIT_CONTRADICTION',
    ]));
  });

  test('allows unrelated baseline only with host evidence and explicit policy treatment', () => {
    const manifest = createStoryExecutionManifest(manifestInput());
    const unsupported = validation({ classification: 'unrelated_baseline', termination: { kind: 'exited', exitCode: 1 } });
    expect(evaluateStoryCloseout({
      manifest,
      attempt: attempt(manifest),
      host: host(manifest, { validations: [unsupported] }),
    }).reasonCodes).toContain('BASELINE_FAILURE_UNSUPPORTED');

    const supported = validation({
      classification: 'unrelated_baseline',
      termination: { kind: 'exited', exitCode: 1 },
      baselineEvidenceReferences: ['baseline:main:validation-1'],
      policyTreatmentReference: 'policy:baseline-v1',
    });
    expect(evaluateStoryCloseout({
      manifest,
      attempt: attempt(manifest, { hostValidationObservations: [supported] }),
      host: host(manifest, { validations: [supported] }),
    }).status).toBe('accepted');
  });

  test.each([
    ['blocked_by_policy', 'VALIDATION_BLOCKED_BY_POLICY'],
    ['environment_unavailable', 'VALIDATION_ENVIRONMENT_UNAVAILABLE'],
  ] as const)('keeps %s validation as a typed blocker', (classification, reason) => {
    const manifest = createStoryExecutionManifest(manifestInput());
    const result = evaluateStoryCloseout({
      manifest,
      attempt: attempt(manifest),
      host: host(manifest, {
        validations: [validation({
          classification,
          termination: { kind: 'cancelled', reason: classification },
          remediation: 'Provision a test database and rerun under the autonomous command guard.',
        })],
      }),
    });

    expect(result.status).toBe('blocked');
    expect(result.reasonCodes).toContain(reason);
    expect(result.nextSafeAction.code).toBe('remediate_environment');
  });

  test('blocks revision mutation and stale revision-sensitive validation', () => {
    const manifest = createStoryExecutionManifest(manifestInput());
    const result = evaluateStoryCloseout({
      manifest,
      attempt: attempt(manifest),
      host: host(manifest, {
        repository: {
          worktreeClean: true,
          changedFiles: [],
          runtimeMetadataFiles: [],
          headBeforeValidation: BASE_SHA,
          headAfterValidation: SHA,
        },
        validations: [validation({ repositoryRevisionBefore: BASE_SHA, repositoryRevisionAfter: SHA })],
      }),
    });

    expect(result.reasonCodes).toEqual(expect.arrayContaining(['REVISION_MUTATED_DURING_VALIDATION', 'STALE_VALIDATION_REVISION']));
    expect(result.nextSafeAction.code).toBe('rerun_validation');
  });

  test('attempt retries append, exact restart replay is idempotent, and replacement is rejected', () => {
    const firstManifest = createStoryExecutionManifest(manifestInput());
    const first = attempt(firstManifest, { termination: { kind: 'exited', exitCode: 1 } });
    const replayed = appendStoryAttemptResult([first], first);
    expect(replayed).toBe(replayed);
    expect(replayed).toHaveLength(1);

    const retryManifest = createStoryExecutionManifest(manifestInput({
      identity: { ...firstManifest.identity, attempt: 2 },
    }));
    const retry = attempt(retryManifest);
    expect(appendStoryAttemptResult(replayed, retry).map((item) => item.identity.attempt)).toEqual([1, 2]);

    const replacement = attempt(firstManifest, { knownIssues: ['Changed after restart.'] });
    expect(() => appendStoryAttemptResult(replayed, replacement)).toThrow('different immutable content');
  });

  test('enforces the named legacy compatibility cutoff and rejects new missing-manifest runs', () => {
    const accepted = evaluateStoryCloseout({
      manifest: null,
      attempt: null,
      host: null,
      legacyCompatibility: {
        ruleName: LEGACY_CLOSEOUT_RULE_NAME,
        manifestVersion: 0,
        runCreatedAt: '2026-07-14T23:59:59.000Z',
        cutoff: '2026-07-15T00:00:00.000Z',
        auditReference: 'wal:legacy-closeout:42',
        workspaceId: 'rorca',
        specId: 'ssdlc',
        runId: 42,
        storyId: 'LFC-008',
        activeSubjectRevision: { commitSha: SHA, worktreePath: WORKTREE, branch: BRANCH },
        hostEvidenceReferences: [EVIDENCE],
      },
    });
    expect(accepted.status).toBe('accepted');
    expect(accepted.reasonCodes).toEqual(['LEGACY_COMPATIBILITY_APPLIED']);

    const denied = evaluateStoryCloseout({
      manifest: null,
      attempt: null,
      host: null,
      legacyCompatibility: {
        ...accepted.compatibility!,
        ruleName: LEGACY_CLOSEOUT_RULE_NAME,
        manifestVersion: 0,
        runCreatedAt: '2026-07-15T00:00:01.000Z',
        cutoff: '2026-07-15T00:00:00.000Z',
        workspaceId: 'rorca',
        specId: 'ssdlc',
        runId: 43,
        storyId: 'LFC-009',
        activeSubjectRevision: { commitSha: SHA, worktreePath: WORKTREE, branch: BRANCH },
        hostEvidenceReferences: [EVIDENCE],
      },
    });
    expect(denied.status).toBe('blocked');
    expect(denied.reasonCodes).toEqual(['LEGACY_COMPATIBILITY_DENIED']);
    expect(evaluateStoryCloseout({ manifest: null, attempt: null, host: null }).reasonCodes).toEqual(['MISSING_MANIFEST']);
  });

  test('persistence replays immutable attempts and decisions idempotently across restart', async () => {
    const manifest = createStoryExecutionManifest(manifestInput());
    const attemptResult = attempt(manifest);
    const hostFacts = host(manifest);
    const decision = evaluateStoryCloseout({ manifest, attempt: attemptResult, host: hostFacts });
    const tables = new Map<string, Map<string, unknown>>([
      ['story_execution_manifests', new Map()],
      ['story_attempt_results', new Map()],
      ['story_closeout_decisions', new Map()],
    ]);
    const db: CloseoutDb = {
      query: async <T>() => [] as T[],
      execute: async () => ({ rowCount: 0 }),
      queryOne: async <T>(sql: string, params: unknown[] = []) => {
        const table = [...tables.keys()].find((name) => sql.includes(name));
        if (!table) return undefined;
        const store = tables.get(table)!;
        const key = String(params[0]);
        if (sql.includes('INSERT INTO')) {
          if (store.has(key)) return undefined;
          const payloadIndex = table === 'story_execution_manifests' ? 9 : table === 'story_attempt_results' ? 7 : 9;
          store.set(key, JSON.parse(String(params[payloadIndex])));
          return (table === 'story_execution_manifests'
            ? { manifest_hash: key }
            : table === 'story_attempt_results'
              ? { attempt_result_id: key }
              : { decision_id: key }) as T;
        }
        return (store.has(key) ? { payload: store.get(key) } : undefined) as T | undefined;
      },
    };
    const bundle = { manifest, attempt: attemptResult, decision, evidence: [] };

    await expect(persistStoryCloseoutBundle(bundle, db)).resolves.toMatchObject({
      manifest: 'inserted', attempt: 'inserted', decision: 'inserted',
    });
    await expect(persistStoryCloseoutBundle(bundle, db)).resolves.toMatchObject({
      manifest: 'replayed', attempt: 'replayed', decision: 'replayed',
    });
    expect(tables.get('story_attempt_results')?.size).toBe(1);
    expect(tables.get('story_closeout_decisions')?.size).toBe(1);
  });
});
