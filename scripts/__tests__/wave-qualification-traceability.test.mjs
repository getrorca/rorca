// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadWaveQualificationTraceability,
  validateWaveQualificationTraceability,
} from '../check-wave-qualification-invariants.mjs';

function fixture() {
  return loadWaveQualificationTraceability();
}

test('accepts the complete checked-in 125-requirement traceability set', () => {
  assert.deepEqual(validateWaveQualificationTraceability(fixture()), {
    invariantCount: 7,
    scenarioCount: 10,
    storyCount: 12,
    requirementCount: 125,
    crossReferenceCount: 125,
  });
});

test('rejects duplicate or missing requirement mappings', () => {
  const duplicate = fixture();
  duplicate.crossReference.entries[1] = structuredClone(duplicate.crossReference.entries[0]);
  assert.throws(
    () => validateWaveQualificationTraceability(duplicate),
    /cross-reference requirement IDs contains duplicate/,
  );

  const missing = fixture();
  missing.crossReference.entries.pop();
  assert.throws(
    () => validateWaveQualificationTraceability(missing),
    /cross-reference must contain exactly 125 entries/,
  );
});

test('rejects duplicate and unrecognized evidence classes', () => {
  const duplicate = fixture();
  duplicate.crossReference.entries[0].evidenceClasses.push(
    duplicate.crossReference.entries[0].evidenceClasses[0],
  );
  assert.throws(
    () => validateWaveQualificationTraceability(duplicate),
    /contains duplicate durable_database_wal/,
  );

  const unknown = fixture();
  unknown.crossReference.entries[0].evidenceClasses[0] = 'terminal_output';
  assert.throws(
    () => validateWaveQualificationTraceability(unknown),
    /unknown evidence class terminal_output/,
  );
});

test('requires canary soak and rollback rehearsal as measured evidence classes', () => {
  const missingCanary = fixture();
  missingCanary.crossReference.evidenceClassTaxonomy.measured =
    missingCanary.crossReference.evidenceClassTaxonomy.measured.filter(value => value !== 'canary_soak');
  assert.throws(
    () => validateWaveQualificationTraceability(missingCanary),
    /measured evidence classes changed|canary_soak must remain/,
  );

  const missingRollback = fixture();
  missingRollback.crossReference.evidenceClassTaxonomy.measured =
    missingRollback.crossReference.evidenceClassTaxonomy.measured.filter(value => value !== 'rollback_rehearsal');
  assert.throws(
    () => validateWaveQualificationTraceability(missingRollback),
    /measured evidence classes changed|rollback_rehearsal must remain/,
  );
});

test('rejects any mutation of the immutable local requirements artifact', () => {
  const input = fixture();
  input.requirementsArtifact.stories[0].acceptanceCriteria[0].text += ' changed';
  input.requirementsBytes = Buffer.from(`${JSON.stringify(input.requirementsArtifact, null, 2)}\n`, 'utf8');

  assert.throws(
    () => validateWaveQualificationTraceability(input),
    /immutable requirements artifact hash changed/,
  );
});
