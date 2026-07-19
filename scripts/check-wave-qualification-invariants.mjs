// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';

const registryPath = new URL('../docs/qualification/wave-parallel-invariants.json', import.meta.url);
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
const required = new Map([
  ['WPE-INV-001', 'no-pass-before-integration'],
  ['WPE-INV-002', 'rejection-is-semantic-failure'],
  ['WPE-INV-003', 'failed-dependencies-never-start'],
  ['WPE-INV-004', 'only-owned-resources-are-cleaned'],
  ['WPE-INV-005', 'accepted-integration-exactly-once'],
  ['WPE-INV-006', 'historical-evidence-is-immutable'],
  ['WPE-INV-007', 'production-is-never-a-target'],
]);

assert.equal(registry.schemaVersion, 1, 'unsupported invariant registry schema');
assert.ok(Array.isArray(registry.invariants), 'invariants must be an array');
assert.ok(Array.isArray(registry.scenarios), 'scenarios must be an array');

const invariantIds = new Set();
for (const invariant of registry.invariants) {
  assert.equal(required.get(invariant.id), invariant.name, `unexpected invariant ${invariant.id}`);
  assert.ok(typeof invariant.statement === 'string' && invariant.statement.length > 20, `${invariant.id} needs an executable statement`);
  assert.ok(!invariantIds.has(invariant.id), `duplicate invariant ${invariant.id}`);
  invariantIds.add(invariant.id);
}
assert.deepEqual(invariantIds, new Set(required.keys()), 'required invariant set changed');

const scenarioIds = new Set();
const mappedInvariantIds = new Set();
for (const scenario of registry.scenarios) {
  assert.match(scenario.id, /^WPE-Q-\d{3}$/, 'scenario ID must be stable and machine-readable');
  assert.ok(!scenarioIds.has(scenario.id), `duplicate scenario ${scenario.id}`);
  assert.ok(Array.isArray(scenario.invariantIds) && scenario.invariantIds.length > 0, `${scenario.id} must map to invariants`);
  assert.equal(new Set(scenario.invariantIds).size, scenario.invariantIds.length, `${scenario.id} has duplicate mappings`);
  for (const invariantId of scenario.invariantIds) {
    assert.ok(invariantIds.has(invariantId), `${scenario.id} maps unknown invariant ${invariantId}`);
    mappedInvariantIds.add(invariantId);
  }
  scenarioIds.add(scenario.id);
}
assert.deepEqual(mappedInvariantIds, invariantIds, 'every invariant must have qualification coverage');

const productionNegative = registry.scenarios.find(scenario => scenario.id === 'WPE-Q-005');
assert.deepEqual(new Set(productionNegative?.invariantIds), invariantIds, 'production negative must exercise every invariant');
console.log(`Wave qualification registry valid: ${invariantIds.size} invariants, ${scenarioIds.size} scenarios`);
