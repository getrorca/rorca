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
import {
  applyCandidate,
  configureLearnLoop,
  consumeProductionOutcome,
  resetLearnLoopForTests,
  reviewCandidate,
  type LearnCandidate,
  type ProductionOutcome,
} from '../learn-loop';

const catalogPath = path.resolve(__dirname, '../../catalog/controls.json');

function outcome(overrides: Partial<ProductionOutcome> = {}): ProductionOutcome {
  return {
    source: 'production',
    controlId: 'CTRL-VALIDATION',
    phase: 'validation',
    evidenceRef: 'evidence://release-42/validation-7',
    ...overrides,
  };
}

function required(candidate: LearnCandidate | undefined): LearnCandidate {
  assert.ok(candidate, 'expected a learn candidate');
  return candidate;
}

test.beforeEach(() => resetLearnLoopForTests());

test('classifies a production defect that passed validation as pending review', () => {
  const candidate = required(consumeProductionOutcome(outcome({
    defectReachedProduction: true,
    validationTestsPassed: true,
  })));

  assert.equal(candidate.type, 'test-class-failed-to-predict-defect');
  assert.equal(candidate.status, 'pending-review');
  assert.equal(candidate.signalCount, 1);
});

test('classifies rework caused by a granted exception', () => {
  const candidate = required(consumeProductionOutcome(outcome({
    phase: 'production',
    reworkCausedByGrantedException: true,
  })));
  assert.equal(candidate.type, 'exception-caused-rework');
});

test('emits no-signal candidates only at the configured all-gates threshold', () => {
  configureLearnLoop({ noSignalThreshold: 4 });
  assert.equal(consumeProductionOutcome(outcome({ evaluatedGateCount: 3, producedSignalCount: 0 })), undefined);
  assert.equal(consumeProductionOutcome(outcome({ evaluatedGateCount: 4, producedSignalCount: 1 })), undefined);
  assert.equal(consumeProductionOutcome(outcome({ noSignalGateCount: 4 })), undefined);
  assert.equal(consumeProductionOutcome(outcome({
    evaluatedGateCount: 4,
    producedSignalCount: 0,
    noSignalGateCount: 3,
  })), undefined);

  const candidate = required(consumeProductionOutcome(outcome({
    evaluatedGateCount: 4,
    producedSignalCount: 0,
    noSignalGateCount: 4,
  })));
  assert.equal(candidate.type, 'control-produced-no-signal');
});

test('classifies task-class model underperformance', () => {
  const candidate = required(consumeProductionOutcome(outcome({
    outcomeType: 'model-performance',
    phase: 'implementation',
    modelUnderperformed: true,
    taskClass: 'database-migration',
  })));
  assert.equal(candidate.type, 'model-underperformed-on-task-class');
});

test('deduplicates by type, control and evidence hash while incrementing signalCount', () => {
  const repeated = outcome({ defectReachedProduction: true, validationTestsPassed: true });
  const first = required(consumeProductionOutcome(repeated));
  const second = required(consumeProductionOutcome({ ...repeated }));

  assert.equal(second.candidateId, first.candidateId);
  assert.equal(second.signalCount, 2);
});

test('accepts AAV heal and run adapter inputs and returns only the canonical shape', () => {
  for (const source of ['aav-heal', 'aav-run'] as const) {
    const candidate = required(consumeProductionOutcome(outcome({
      source,
      evidenceRef: `aav://${source}/event-1`,
      candidateType: 'model-underperformed-on-task-class',
      provenance: { adapter: 'AAV-022', eventId: 'event-1' },
    })));
    assert.deepEqual(Object.keys(candidate).sort(), [
      'candidateId', 'controlId', 'evidenceRef', 'phase', 'provenance', 'signalCount', 'status', 'type',
    ]);
    assert.deepEqual(candidate.provenance, { adapter: 'AAV-022', eventId: 'event-1' });
    assert.equal(candidate.status, 'pending-review');
  }
});

test('runtime callers cannot bypass review with a pending or unknown status', () => {
  const candidate = required(consumeProductionOutcome(outcome({
    defectReachedProduction: true,
    validationTestsPassed: true,
  })));
  const reviewWithRuntimeStatus = reviewCandidate as (
    candidateId: string,
    status: string,
    actor: { actorId: string; authorized: true },
  ) => LearnCandidate;

  for (const status of ['pending-review', 'auto-approved']) {
    assert.throws(
      () => reviewWithRuntimeStatus(candidate.candidateId, status, {
        actorId: 'genesis-reviewer',
        authorized: true,
      }),
      /review status must be 'approved' or 'rejected'/,
    );
    assert.equal(required(consumeProductionOutcome(outcome({
      defectReachedProduction: true,
      validationTestsPassed: true,
    }))).status, 'pending-review');
  }
});

test('pending candidates cannot apply and controls.json remains byte-for-byte unchanged', async () => {
  const before = await readFile(catalogPath);
  const candidate = required(consumeProductionOutcome(outcome({
    defectReachedProduction: true,
    validationTestsPassed: true,
  })));

  assert.throws(
    () => applyCandidate(candidate, { actorId: 'genesis-reviewer', authorized: true }),
    (error: unknown) => error instanceof Error && /requires approved review/.test(error.message),
  );
  assert.deepEqual(await readFile(catalogPath), before);
});

test('approval and application both require an explicit authorized actor and never mutate the catalog', async () => {
  const before = await readFile(catalogPath);
  const candidate = required(consumeProductionOutcome(outcome({
    reworkCausedByGrantedException: true,
  })));

  assert.throws(() => applyCandidate(candidate), /authorized actor/);
  const approved = reviewCandidate(candidate.candidateId, 'approved', {
    actorId: 'genesis-reviewer',
    authorized: true,
  });
  const receipt = applyCandidate(approved, { actorId: 'catalog-owner', authorized: true });
  assert.deepEqual(receipt, {
    candidateId: candidate.candidateId,
    actorId: 'catalog-owner',
    applied: true,
    catalogMutated: false,
  });
  assert.deepEqual(await readFile(catalogPath), before);
});
