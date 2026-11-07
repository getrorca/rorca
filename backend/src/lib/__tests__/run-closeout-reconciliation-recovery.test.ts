/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  closeoutReconciliationJobPayloadForTests,
  closeoutReconciliationRequestHashForTests,
  executeCloseoutOnlySequence,
  requireCloseoutReconciliationIdempotencyKey,
} from '../run-closeout-reconciliation';
import type { RunHostAuthority } from '../run-host-authority';

const SHA = 'a'.repeat(40);
const authority: RunHostAuthority = {
  runId: 20260316000550,
  workspaceId: 'proof-workspace',
  specId: 'proof-spec',
  status: 'failed',
  lifecycleStatus: 'failed',
  finishedAt: '2026-07-26T10:30:00.000Z',
  branchName: 'feat/isolated-proof',
  checkoutPath: '/tmp/proof-worktree',
  repositoryTopLevel: '/tmp/proof-repository',
  expectedStoryIds: ['E2E-001'],
  excludedStoryIds: [],
  stories: [{ storyId: 'E2E-001', status: 'pass', reason: null, finishedAt: '2026-07-26T10:29:00.000Z', resultId: 1, commitSha: SHA }],
  authoritativePassedStoryIds: ['E2E-001'],
  authoritativePredecessorPasses: [],
  finalCommitSha: SHA,
  closeoutEligible: true,
  terminalRevision: SHA,
  integrationAncestry: [SHA],
  acceptedStoryIds: ['E2E-001'],
  complete: true,
  releaseEligible: true,
  invalidReason: null,
};

test.each([
  'before_host_closeout',
  'after_host_closeout',
  'after_release_intent',
  'after_terminal_event',
  'after_public_done',
  'after_terminal_relay',
  'after_release_reconciliation',
] as const)('exact replay converges after crash boundary %s without duplicating durable effects', async (crashPoint) => {
  const state = {
    hostCloseout: false,
    releaseIntent: false,
    terminalEvent: false,
    publicDone: false,
    terminalRelay: false,
    finalized: false,
  };
  const writes = {
    hostCloseout: 0,
    releaseIntent: 0,
    terminalEvent: 0,
    publicDone: 0,
    terminalRelay: 0,
    finalized: 0,
  };
  let crashPending = true;
  const fail = (point: string) => {
    if (crashPending && point === crashPoint) {
      crashPending = false;
      throw new Error(`simulated-crash:${point}`);
    }
  };

  const actions = {
    revalidate: async () => ({ authority }),
    hostAuthority: (validation: { authority: RunHostAuthority }) => validation.authority,
    persistHostCloseout: async () => {
      if (!state.hostCloseout) { state.hostCloseout = true; writes.hostCloseout++; }
    },
    prepareBranchOnlyRelease: async (observed: RunHostAuthority) => {
      expect(observed).toBe(authority);
      if (!state.releaseIntent) { state.releaseIntent = true; writes.releaseIntent++; }
    },
    reconcileBranchOnlyRelease: async () => {
      if (!state.terminalEvent) {
        state.terminalEvent = true; writes.terminalEvent++;
        fail('after_terminal_event');
      }
      if (!state.publicDone) {
        state.publicDone = true; writes.publicDone++;
        fail('after_public_done');
      }
      if (!state.terminalRelay) {
        state.terminalRelay = true; writes.terminalRelay++;
        fail('after_terminal_relay');
      }
      return { status: 'completed' as const };
    },
    finalize: async () => {
      if (!state.finalized) { state.finalized = true; writes.finalized++; }
      return 'receipt';
    },
    failpoint: fail,
  };

  await expect(executeCloseoutOnlySequence(actions)).rejects.toThrow(`simulated-crash:${crashPoint}`);
  await expect(executeCloseoutOnlySequence(actions)).resolves.toBe('receipt');
  expect(state).toEqual({
    hostCloseout: true,
    releaseIntent: true,
    terminalEvent: true,
    publicDone: true,
    terminalRelay: true,
    finalized: true,
  });
  expect(writes).toEqual({
    hostCloseout: 1,
    releaseIntent: 1,
    terminalEvent: 1,
    publicDone: 1,
    terminalRelay: 1,
    finalized: 1,
  });
});

test('dedicated transport payload is strict and carries no execution or release option', () => {
  const payload = closeoutReconciliationJobPayloadForTests({
    reconciliationId: '11111111-1111-4111-8111-111111111111',
    runId: 20260316000550,
    workspaceId: 'proof-workspace',
    previewHash: `sha256:${'b'.repeat(64)}`,
  });
  expect(payload).toEqual({
    schemaVersion: 'rorca.run-closeout-reconciliation-job.v1',
    reconciliationId: '11111111-1111-4111-8111-111111111111',
    transportGeneration: 1,
    runId: 20260316000550,
    workspaceId: 'proof-workspace',
    previewHash: `sha256:${'b'.repeat(64)}`,
  });
  expect(() => closeoutReconciliationJobPayloadForTests({
    ...payload,
    mergeStrategy: 'direct',
  } as never)).toThrow();
});

test('idempotency keys are bounded to one unambiguous ASCII grammar', () => {
  expect(requireCloseoutReconciliationIdempotencyKey('closeout:550:one')).toBe('closeout:550:one');
  for (const invalid of ['', 'short', ' contains-space', 'x'.repeat(201), 'é'.repeat(8)]) {
    expect(() => requireCloseoutReconciliationIdempotencyKey(invalid)).toThrow('8-200 bounded ASCII');
  }
});

test('implementation has no run scanner, execution engine, model, memory, provider, or cleanup actuator', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'run-closeout-reconciliation.ts'), 'utf8');
  expect(source).not.toMatch(/FROM pipeline_runs[^;]*WHERE[^;]*summary\s*=\s*['"]worker_closeout_failed/is);
  expect(source).not.toMatch(/from ['"].*execution-engine|tryGenerateLearnCloseoutCandidates|createMemory|resolveWorkspaceGitHubToken|performMerge|cleanupExecutionWorktree/);
  expect(source).toContain("mergeStrategy: 'branch-only'");
  expect(source).toContain('autoMerge: false');
  expect(source).toContain('externalSend: false');
  expect(source).toContain("CLOSEOUT_RECONCILIATION_QUEUE = 'pipeline:closeout-reconcile'");
  expect(source).toContain('This scans only already-authorized application rows');
  const recovery = source.slice(
    source.indexOf('export async function recoverPendingCloseoutReconciliationPublications'),
    source.indexOf('/** Contract-test helper'),
  );
  expect(recovery).toContain('FROM pipeline_run_closeout_reconciliations');
  expect(recovery).not.toContain('FROM pipeline_runs');
});

test('worker registers the exact closeout consumer after startup publication recovery', () => {
  const worker = fs.readFileSync(path.resolve(__dirname, '..', '..', 'worker.ts'), 'utf8');
  const boss = fs.readFileSync(path.resolve(__dirname, '..', 'pg-boss.ts'), 'utf8');
  const handler = worker.slice(
    worker.indexOf('export async function handlePipelineCloseoutReconciliation'),
    worker.indexOf('// ── Stale job recovery'),
  );
  const startup = worker.slice(worker.indexOf('async function start()'));

  expect(boss).toContain("boss.createQueue('pipeline:closeout-reconcile')");
  expect(worker).toContain(
    'boss.work(CLOSEOUT_RECONCILIATION_QUEUE, { batchSize: 1 }, handlePipelineCloseoutReconciliation)',
  );
  expect(handler).toContain('jobId: job.id');
  expect(handler).toContain('jobId: job.id,');
  expect(startup.indexOf('recoverPendingCloseoutReconciliationPublications()')).toBeLessThan(
    startup.indexOf('boss.work(CLOSEOUT_RECONCILIATION_QUEUE'),
  );
});

test('protected Genesis can never reuse proof-run authorization or enter a batch payload', () => {
  const baseEvent = {
    schemaVersion: 'provider-human-event.v1' as const,
    issuerId: 'external-owner', keyId: 'key', provider: 'slack', providerTenantId: 'tenant',
    actorId: 'proof-owner', conversationId: 'conversation', threadId: 'thread', messageId: 'message-proof',
    occurredAt: '2026-07-26T10:00:00.000Z', normalizedCommandHash: `sha256:${'5'.repeat(64)}`,
    ingressIdempotencyKey: 'ingress-proof', signature: 's'.repeat(40),
  };
  const proofHash = closeoutReconciliationRequestHashForTests({
    runId: 20260316000550, workspaceId: 'proof-workspace', previewHash: `sha256:${'5'.repeat(64)}`,
    rationale: 'Owner authorizes only the exact managed proof run.', requesterActorId: 'local-admin',
    ownerAuthorization: baseEvent,
  });
  const genesisHash = closeoutReconciliationRequestHashForTests({
    runId: 20260316000549, workspaceId: 'rorca-genesis', previewHash: `sha256:${'4'.repeat(64)}`,
    rationale: 'Genesis requires its own exact owner decision.', requesterActorId: 'local-admin',
    ownerAuthorization: {
      ...baseEvent,
      actorId: 'genesis-owner',
      messageId: 'message-genesis',
      ingressIdempotencyKey: 'ingress-genesis',
      normalizedCommandHash: `sha256:${'4'.repeat(64)}`,
    },
  });
  expect(genesisHash).not.toBe(proofHash);
  expect(() => closeoutReconciliationJobPayloadForTests({
    reconciliationId: '99999999-9999-4999-8999-999999999999',
    runId: 20260316000549,
    workspaceId: 'rorca-genesis',
    previewHash: `sha256:${'4'.repeat(64)}`,
  })).toThrow();
});
