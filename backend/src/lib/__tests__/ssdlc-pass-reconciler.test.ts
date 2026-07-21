/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  classifyPassReconciliation,
  reconcileApprovedSpecPasses,
  type ApprovedSpecDocument,
  type PassReconcilerDependencies,
  type ReconciliationEvidenceRecord,
} from '../ssdlc-pass-reconciler';
import { deriveStoryContractRevision } from '../story-execution-packet';

function spec(passes = false, extra: Record<string, unknown> = {}): ApprovedSpecDocument {
  return {
    id: 'reconcile-spec',
    userStories: [{
      id: 'US-001',
      title: 'Implement evidence gate',
      description: 'Change source files.',
      acceptanceCriteria: ['Evidence is durable'],
      dependsOn: [],
      passes,
      ...extra,
    }],
  };
}

function proof(
  sourceSpec: ApprovedSpecDocument,
  overrides: Partial<ReconciliationEvidenceRecord> = {},
): ReconciliationEvidenceRecord {
  const story = (sourceSpec.userStories as Record<string, unknown>[])[0];
  return {
    storyId: String(story.id),
    resultId: 11,
    runId: 7,
    resultStatus: 'pass',
    resultReason: null,
    resultObservedAt: '2026-07-15T12:00:00.000Z',
    manifestHash: 'sha256:manifest',
    specRevision: deriveStoryContractRevision(sourceSpec),
    storyRevision: deriveStoryContractRevision(story),
    decisionId: 'CLO-sha256:decision',
    decisionStatus: 'accepted',
    attemptResultId: 'ATR-sha256:attempt',
    completionPacketPresent: true,
    completionPacketValidated: true,
    noCodeAllowed: false,
    commitReferences: ['story_commit:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    progressReference: '/workspace/.rorca/progress/run-7/US-001.md',
    ...overrides,
  };
}

function classify(currentSpec: ApprovedSpecDocument, evidence: ReconciliationEvidenceRecord[]) {
  return classifyPassReconciliation({
    workspaceId: 'ws-a',
    specId: 'reconcile-spec',
    specPath: 'forge/specs/approved/reconcile-spec.json',
    spec: currentSpec,
    evidence,
  });
}

describe('classifyPassReconciliation', () => {
  test('repairs retry drift when a current-version packet, result, and direct commit prove pass', () => {
    const original = spec(false);
    const report = classify(original, [proof(original)]);
    expect(report.stories[0]).toMatchObject({ status: 'safely-repairable', reasonCodes: ['STALE_FALSE_PROVEN'] });
  });

  test('accepts checkpoint commit evidence and is consistent after the pass projection is repaired', () => {
    const original = spec(false);
    const current = spec(true, { notes: 'Completed by Rorca pass reconciler' });
    const report = classify(current, [proof(original, { commitReferences: ['story_commit:checkpoint-sha'] })]);
    expect(report.stories[0].status).toBe('consistent-passed');
  });

  test('allows an explicitly profiled no-code story without a commit', () => {
    const original = spec(false, { title: 'Verify generated documentation', description: 'Read-only verification.' });
    const report = classify(original, [proof(original, { noCodeAllowed: true, commitReferences: [] })]);
    expect(report.stories[0].status).toBe('safely-repairable');
  });

  test('does not let a copied pass result acquire packet authority', () => {
    const original = spec(false);
    const copied = proof(original, {
      resultId: 12,
      runId: 8,
      manifestHash: null,
      specRevision: null,
      storyRevision: null,
      decisionId: null,
      decisionStatus: null,
      attemptResultId: null,
      completionPacketPresent: false,
      completionPacketValidated: false,
      commitReferences: [],
    });
    const report = classify(original, [copied]);
    expect(report.stories[0]).toMatchObject({ status: 'ambiguous' });
    expect(report.stories[0].reasonCodes).toContain('REVISION_MISMATCH');
  });

  test('uses original proof rather than treating a copied retry result as new authority', () => {
    const original = spec(false);
    const copied = proof(original, {
      resultId: 12,
      runId: 8,
      manifestHash: null,
      specRevision: null,
      storyRevision: null,
      decisionId: null,
      decisionStatus: null,
      attemptResultId: null,
      completionPacketPresent: false,
      completionPacketValidated: false,
      commitReferences: [],
    });
    const report = classify(original, [proof(original), copied]);
    expect(report.stories[0].status).toBe('safely-repairable');
  });

  test('never trusts stale true, missing packets, or revision mismatch', () => {
    const original = spec(false);
    const revised = spec(true, { description: 'A revised story contract.' });
    const report = classify(revised, [proof(original, { completionPacketPresent: false })]);
    expect(report.stories[0].status).toBe('ambiguous');
    expect(report.stories[0].reasonCodes).toEqual(expect.arrayContaining(['REVISION_MISMATCH', 'MISSING_VALIDATED_PACKET', 'STALE_TRUE_UNPROVEN']));
    expect(report.stories[0].operatorActions.length).toBeGreaterThan(0);
  });

  test('a later contradictory result defeats an older accepted pass', () => {
    const original = spec(false);
    const failedLater = proof(original, {
      resultId: 13,
      runId: 9,
      resultStatus: 'fail',
      resultObservedAt: '2026-07-15T13:00:00.000Z',
      decisionId: null,
      decisionStatus: null,
      attemptResultId: null,
      completionPacketPresent: false,
      completionPacketValidated: false,
      commitReferences: [],
    });
    const report = classify(original, [proof(original), failedLater]);
    expect(report.stories[0].status).toBe('ambiguous');
    expect(report.stories[0].reasonCodes).toContain('CONTRADICTORY_RESULT');
  });

  test('a later previously-passed skip preserves accepted pass evidence', () => {
    const original = spec(false);
    const carriedForward = proof(original, {
      resultId: 13,
      runId: 9,
      resultStatus: 'skip',
      resultReason: 'previously_passed',
      resultObservedAt: '2026-07-15T13:00:00.000Z',
      decisionId: null,
      decisionStatus: null,
      attemptResultId: null,
      completionPacketPresent: false,
      completionPacketValidated: false,
      commitReferences: [],
    });
    const report = classify(original, [proof(original), carriedForward]);
    expect(report.stories[0]).toMatchObject({ status: 'safely-repairable' });
    expect(report.stories[0].reasonCodes).not.toContain('CONTRADICTORY_RESULT');
  });

  test('progress Markdown remains supporting evidence and cannot prove pass', () => {
    const current = spec(true);
    const progressOnly = proof(spec(false), {
      resultStatus: 'fail',
      decisionId: null,
      decisionStatus: null,
      attemptResultId: null,
      completionPacketPresent: false,
      completionPacketValidated: false,
      commitReferences: [],
    });
    const report = classify(current, [progressOnly]);
    expect(report.stories[0].status).toBe('ambiguous');
    expect(report.stories[0].evidenceReferences).toContain('progress:/workspace/.rorca/progress/run-7/US-001.md');
  });

  test('dependency changes make a proven pass ambiguous', () => {
    const original: ApprovedSpecDocument = {
      id: 'reconcile-spec',
      userStories: [
        { id: 'US-001', title: 'Foundation', description: 'Foundation', dependsOn: [], passes: false },
        { id: 'US-002', title: 'Dependent', description: 'Dependent', dependsOn: ['US-001'], passes: false },
      ],
    };
    const current = JSON.parse(JSON.stringify(original)) as ApprovedSpecDocument;
    (current.userStories as Record<string, unknown>[])[1].passes = true;
    const dependentStory = (original.userStories as Record<string, unknown>[])[1];
    const dependentProof = {
      ...proof(original),
      storyId: 'US-002',
      storyRevision: deriveStoryContractRevision(dependentStory),
    };
    const report = classify(current, [dependentProof]);
    expect(report.stories.find((story) => story.storyId === 'US-002')).toMatchObject({ status: 'ambiguous' });
    expect(report.stories.find((story) => story.storyId === 'US-002')?.reasonCodes).toContain('DEPENDENCY_INCONSISTENT');
  });

  test('invalid and cyclic DAGs are returned as invalid instead of guessed', () => {
    const current: ApprovedSpecDocument = {
      userStories: [
        { id: 'US-001', dependsOn: ['US-002'], passes: false },
        { id: 'US-002', dependsOn: ['US-001'], passes: false },
        { id: 'US-003', dependsOn: ['US-404'], passes: false },
      ],
    };
    const report = classify(current, []);
    expect(report.blocking).toBe(true);
    expect(report.stories[0].reasonCodes).toContain('DEPENDENCY_CYCLE');
    expect(report.stories[2].reasonCodes).toContain('DEPENDENCY_NOT_FOUND');
  });
});

describe('pipeline reconciliation ordering', () => {
  test('runs before new-run scheduling and retry temp-spec generation/pg-boss dispatch', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'pipeline.ts'), 'utf8');
    const triggerStart = source.indexOf("router.post('/trigger'");
    const retryRoute = source.indexOf("router.post('/runs/:runId/retry'");
    const retryStart = source.indexOf('export async function retryPipelineRunHandler', retryRoute);
    const retryEnd = source.indexOf("router.post('/runs/:runId/retry-merge'", retryStart);
    const triggerSource = source.slice(triggerStart, retryRoute);
    const retrySource = source.slice(retryStart, retryEnd);

    expect(triggerSource.indexOf('await reconcileApprovedSpecPasses(')).toBeGreaterThan(-1);
    expect(triggerSource.indexOf('await reconcileApprovedSpecPasses(')).toBeLessThan(triggerSource.indexOf("send('pipeline:run'"));
    const retryReconciliation = retrySource.indexOf('await (previewHash ? reconcileApprovedSpecPasses : inspectApprovedSpecPasses)(');
    expect(retryReconciliation).toBeGreaterThan(-1);
    expect(retryReconciliation).toBeLessThan(retrySource.indexOf('const retrySpecName'));
    expect(retryReconciliation).toBeLessThan(retrySource.indexOf("send('pipeline:retry'"));
    expect(retrySource.match(/reconciliation\?\.status === 'safely-repairable'/g)).toHaveLength(1);
    expect(retrySource.match(/reconciled\?\.status === 'safely-repairable'/g)).toHaveLength(1);
  });
});

describe('reconcileApprovedSpecPasses transaction boundary', () => {
  test('snapshots, emits WAL, and is idempotent under serialized concurrent reconciliation', async () => {
    const filePath = '/workspace/forge/specs/approved/reconcile-spec.json';
    const original = spec(false);
    let raw = JSON.stringify(original);
    const evidence = proof(original);
    const evidenceRow = {
      story_id: evidence.storyId,
      result_id: evidence.resultId,
      run_id: evidence.runId,
      result_status: evidence.resultStatus,
      result_reason: evidence.resultReason,
      result_observed_at: evidence.resultObservedAt,
      completion_packet: { status: 'validated', progressLogPath: '/workspace/.rorca/progress/run-7/US-001.md' },
      manifest_hash: evidence.manifestHash,
      spec_revision: evidence.specRevision,
      story_revision: evidence.storyRevision,
      manifest_payload: {
        identity: { storyId: 'US-001' },
        repositoryProfile: { changePolicy: 'code_required' },
      },
      decision_id: evidence.decisionId,
      decision_status: evidence.decisionStatus,
      attempt_result_id: evidence.attemptResultId,
      attempt_payload: { proposedCompletionPacket: { proposal: 'complete' } },
      commit_references: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    };
    const statements: Array<{ sql: string; params?: unknown[] }> = [];
    let lock = Promise.resolve();
    const dependencies: PassReconcilerDependencies = {
      transaction: async (fn) => {
        const previous = lock;
        let release!: () => void;
        lock = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
          return await fn({
            query: async <T>(sql: string, params?: unknown[]) => {
              statements.push({ sql, params });
              if (sql.includes('FROM story_results')) return { rows: [evidenceRow as T] };
              if (sql.includes('MAX(version)')) return { rows: [{ next_version: 1 } as T] };
              return { rows: [] };
            },
          });
        } finally {
          release();
        }
      },
      readFile: () => raw,
      writeFileAtomically: (_path, content) => { raw = content; },
      fileExists: (candidate) => candidate === filePath,
    };

    const [first, second] = await Promise.all([
      reconcileApprovedSpecPasses({ workspaceId: 'ws-a', workspacePath: '/workspace', specPath: 'forge/specs/approved/reconcile-spec.json' }, dependencies),
      reconcileApprovedSpecPasses({ workspaceId: 'ws-a', workspacePath: '/workspace', specPath: 'forge/specs/approved/reconcile-spec.json' }, dependencies),
    ]);

    expect([first.repairedStoryIds, second.repairedStoryIds]).toContainEqual(['US-001']);
    expect(JSON.parse(raw).userStories[0].passes).toBe(true);
    expect(statements.filter(({ sql }) => sql.includes('INSERT INTO spec_versions'))).toHaveLength(1);
    expect(statements.filter(({ sql }) => sql.includes("'story_reconciled'"))).toHaveLength(1);
    expect(statements.find(({ sql }) => sql.includes('FROM story_results'))?.params?.slice(0, 2)).toEqual(['ws-a', 'reconcile-spec']);
  });

  test('denies a cross-workspace approved-spec path before querying evidence', async () => {
    const dependencies: PassReconcilerDependencies = {
      transaction: jest.fn(),
      readFile: jest.fn(),
      writeFileAtomically: jest.fn(),
      fileExists: jest.fn(() => true),
    };
    await expect(reconcileApprovedSpecPasses({
      workspaceId: 'ws-b',
      workspacePath: '/workspace-b',
      specPath: '../workspace-a/forge/specs/approved/reconcile-spec.json',
    }, dependencies)).rejects.toThrow('workspace-scoped approved spec path');
    expect(dependencies.transaction).not.toHaveBeenCalled();
  });
});
