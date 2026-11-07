/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { HermesWatchdogEvent } from '../../../lib/hermes-watchdog';
import {
  createHermesLearnLoopAdapter,
  type HermesHealingLearnInput,
} from '../hermes-learn-adapter';
import {
  applyCandidate,
  resetLearnLoopForTests,
  type ProductionOutcome,
} from '../learn-loop';

const catalogPath = path.resolve(__dirname, '../../catalog/controls.json');
const exactEvidenceRef = 'evidence://hermes/run-42/events/heal-7#stderr:L18-L24?sha256=abc123';

function healingEvent(): HermesWatchdogEvent {
  return {
    schemaVersion: 'hermes.watchdog.v2',
    hermesAuditIdentity: 'hermes:watchdog',
    sourceEventId: 'heal-7',
    sourceEventType: 'evidence',
    lineage: Object.freeze({
      workspaceId: 'workspace-1',
      specPath: 'forge/specs/approved/aav-022.json',
      runId: 42,
      rootRunId: 40,
      attemptId: 'attempt-42',
      executionIdentity: 'pi:AAV-022',
      executor: 'pi',
      model: 'openai-codex/gpt-5.6-sol',
      worktreeId: 'worktree-42',
    }),
    diagnosis: {
      failureClass: 'engine_exit',
      source: 'deterministic',
      reason: 'matched engine_exit',
      evidence: ['engine_exit: process exit 1'],
    },
    action: null,
    receipt: null,
    outcome: 'failed',
    reason: 'canonical action failed',
  };
}

function healingInput(overrides: Partial<HermesHealingLearnInput> = {}): HermesHealingLearnInput {
  return {
    controlId: 'CTRL-EXECUTION-RELIABILITY',
    phase: 'implementation',
    evidenceRef: exactEvidenceRef,
    candidateType: 'model-underperformed-on-task-class',
    proposedAdjustment: { target: 'mechanism', rationale: 'review executor retry mechanism' },
    provenance: { correlationId: 'corr-42', sourceEventId: 'cannot-override-canonical-id' },
    event: healingEvent(),
    ...overrides,
  };
}

test.beforeEach(() => resetLearnLoopForTests());

test('forwards heal and run outcomes with exact evidence and authoritative provenance', () => {
  const received: ProductionOutcome[] = [];
  const adapter = createHermesLearnLoopAdapter((outcome) => {
    received.push(outcome);
    return undefined;
  });

  adapter.consumeHealingEvent(healingInput());
  adapter.consumeRunOutcome({
    controlId: 'CTRL-RUN-OUTCOME',
    phase: 'validation',
    evidenceRef: exactEvidenceRef,
    candidateType: 'test-class-failed-to-predict-defect',
    proposedAdjustment: { target: 'control', rationale: 'review validation coverage' },
    provenance: { correlationId: 'corr-run', runId: 'cannot-override-canonical-id' },
    outcome: {
      eventId: 'run-outcome-42',
      runId: 42,
      rootRunId: 40,
      status: 'failed',
      executionIdentity: 'pi:AAV-022',
    },
  });

  assert.equal(received[0]?.source, 'aav-heal');
  assert.equal(received[0]?.outcomeType, 'healing');
  assert.equal(received[0]?.controlId, 'CTRL-EXECUTION-RELIABILITY');
  assert.equal(received[0]?.phase, 'implementation');
  assert.equal(received[0]?.evidenceRef, exactEvidenceRef);
  assert.deepEqual(received[0]?.provenance, {
    correlationId: 'corr-42',
    adapter: 'AAV-022',
    sourceEventId: 'heal-7',
    sourceEventType: 'evidence',
    hermesAuditIdentity: 'hermes:watchdog',
    runId: 42,
    rootRunId: 40,
    healingOutcome: 'failed',
    proposedAdjustment: { target: 'mechanism', rationale: 'review executor retry mechanism' },
  });
  assert.equal(Object.isFrozen(received[0]?.provenance), true);
  assert.equal(received[1]?.source, 'aav-run');
  assert.equal(received[1]?.outcomeType, 'run');
  assert.equal(received[1]?.controlId, 'CTRL-RUN-OUTCOME');
  assert.equal(received[1]?.phase, 'validation');
  assert.equal(received[1]?.evidenceRef, exactEvidenceRef);
  assert.deepEqual(received[1]?.provenance, {
    correlationId: 'corr-run',
    adapter: 'AAV-022',
    sourceEventId: 'run-outcome-42',
    runId: 42,
    rootRunId: 40,
    runStatus: 'failed',
    executionIdentity: 'pi:AAV-022',
    proposedAdjustment: { target: 'control', rationale: 'review validation coverage' },
  });
});

test('heal and run signals return the canonical US-007 candidate and use its deduplication', () => {
  const adapter = createHermesLearnLoopAdapter();
  const first = adapter.consumeHealingEvent(healingInput());
  assert.ok(first);

  const second = adapter.consumeRunOutcome({
    controlId: first.controlId,
    phase: first.phase,
    evidenceRef: exactEvidenceRef,
    candidateType: first.type,
    proposedAdjustment: { target: 'control', rationale: 'review validation control threshold' },
    provenance: { correlationId: 'corr-42' },
    outcome: {
      eventId: 'run-outcome-42',
      runId: 42,
      rootRunId: 40,
      status: 'failed',
      executionIdentity: 'pi:AAV-022',
    },
  });
  assert.ok(second);

  assert.equal(second.candidateId, first.candidateId);
  assert.equal(second.signalCount, 2);
  assert.equal(second.status, 'pending-review');
  assert.deepEqual(Object.keys(second).sort(), [
    'candidateId', 'controlId', 'evidenceRef', 'phase', 'provenance', 'signalCount', 'status', 'type',
  ]);
  assert.equal(second.provenance?.adapter, 'AAV-022');
  assert.equal(second.provenance?.sourceEventId, 'heal-7');
});

test('rejects any adjustment surface outside control or mechanism review proposals', () => {
  const adapter = createHermesLearnLoopAdapter();
  const invalid = healingInput({
    proposedAdjustment: { target: 'catalog-mutation', rationale: 'mutate now' } as never,
  });
  assert.throws(() => adapter.consumeHealingEvent(invalid), /proposal target/);
});

test('adapter proposals remain pending review and cannot mutate or apply controls', async () => {
  const before = await readFile(catalogPath);
  const candidate = createHermesLearnLoopAdapter().consumeHealingEvent(healingInput());
  assert.ok(candidate);
  assert.equal(candidate.status, 'pending-review');
  assert.throws(
    () => applyCandidate(candidate, { actorId: 'hermes', authorized: true }),
    /requires approved review/,
  );
  assert.deepEqual(await readFile(catalogPath), before);
});
