/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { genesisEvidenceFixtures } from '../__fixtures__/evidence';
import {
  detectContradictions,
  getEvidence,
  registerGenesisEvidenceFixtures,
  resolveAuthority,
  validateControlAgainstGenesis,
} from '../source-authority';

function withFixtures(t: test.TestContext): void {
  const clear = registerGenesisEvidenceFixtures(genesisEvidenceFixtures);
  t.after(clear);
}

test('projects exact Genesis evidence and immutable bridge provenance', (t) => {
  withFixtures(t);
  assert.deepEqual(getEvidence('GEN-001'), {
    ...genesisEvidenceFixtures[0].evidence,
    bridgeProvenance: genesisEvidenceFixtures[0].bridgeProvenance,
  });
  assert.ok(Object.isFrozen(getEvidence('GEN-001')));
  assert.ok(Object.isFrozen(getEvidence('GEN-001')?.bridgeProvenance));
  assert.equal(getEvidence('GEN-003'), undefined, 'local projection must honor bridge access denial');
});

test('preserves pending bridge review state and rejects attempted local promotion', (t) => {
  withFixtures(t);
  const pending = getEvidence('GEN-004');
  assert.equal(pending?.bridgeProvenance.reviewStatus, 'pending');
  try {
    (pending?.bridgeProvenance as { reviewStatus?: string }).reviewStatus = 'approved';
  } catch (error) {
    assert.ok(error instanceof TypeError);
  }
  assert.equal(getEvidence('GEN-004')?.bridgeProvenance.reviewStatus, 'pending');

  assert.throws(() => registerGenesisEvidenceFixtures([{
    evidence: { ...genesisEvidenceFixtures[2].evidence, reviewStatus: 'approved' },
    bridgeProvenance: genesisEvidenceFixtures[2].bridgeProvenance,
  }]), /Unrecognized key.*reviewStatus/);

  assert.throws(() => registerGenesisEvidenceFixtures([{
    evidence: genesisEvidenceFixtures[3].evidence,
    bridgeProvenance: {
      ...genesisEvidenceFixtures[3].bridgeProvenance,
      reviewStatus: 'approved',
    },
  }]), /cannot change Genesis review or access provenance/);
  assert.equal(getEvidence('GEN-004')?.bridgeProvenance.reviewStatus, 'pending');

  assert.throws(() => registerGenesisEvidenceFixtures([{
    evidence: genesisEvidenceFixtures[2].evidence,
    bridgeProvenance: {
      ...genesisEvidenceFixtures[2].bridgeProvenance,
      access: 'allowed',
    },
  }]), /cannot change Genesis review or access provenance/);
  assert.equal(getEvidence('GEN-003'), undefined, 'fixture registration cannot grant local access');
});

test('fixture registration teardown restores the prior bridge projection', () => {
  const restoreOriginal = registerGenesisEvidenceFixtures([genesisEvidenceFixtures[3]]);
  const restoreNested = registerGenesisEvidenceFixtures([genesisEvidenceFixtures[2]]);

  assert.equal(getEvidence('GEN-003'), undefined, 'nested fixture remains access denied');
  assert.equal(getEvidence('GEN-004'), undefined);
  restoreNested();
  assert.equal(getEvidence('GEN-004')?.genesisEvidenceId, 'GEN-004');
  assert.equal(getEvidence('GEN-003'), undefined);
  restoreNested(); // teardown is idempotent
  restoreOriginal();
});

test('rejects unknown and raw-prose-only source references', (t) => {
  withFixtures(t);
  const unknown = validateControlAgainstGenesis({
    sourceReferences: [{ genesisEvidenceId: 'GEN-999', citation: 'Missing source' }],
  });
  assert.equal(unknown.length, 1);
  assert.match(unknown[0].message, /GEN-999/);

  const rawProse = validateControlAgainstGenesis({ sourceReferences: [{ citation: 'Trust this prose' }] });
  assert.equal(rawProse.length, 1);
  assert.equal(rawProse[0].path, 'sourceReferences.0.genesisEvidenceId');
});

test('groups one explicit contradiction with both Genesis identities', (t) => {
  withFixtures(t);
  assert.deepEqual(detectContradictions(), [{
    contradictionGroup: 'authz-conflict',
    genesisEvidenceIds: ['GEN-001', 'GEN-002'],
  }]);
});

test('resolves Genesis supersession and marks the prior projection superseded', (t) => {
  withFixtures(t);
  assert.equal(resolveAuthority('GEN-001')?.genesisEvidenceId, 'GEN-002');
  assert.equal(getEvidence('GEN-001')?.supersededBy, 'GEN-002');
});
