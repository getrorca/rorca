/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import {
  DOCTOR_TRANSITIONS,
  GovernedDoctorController,
  PermanentDoctorReplayError,
  createDoctorPreview,
  doctorInvocationRequestHash,
  sealDoctorCheck,
  sealDoctorFix,
  validateDoctorDefinitions,
  type DoctorCallbacks,
  type DoctorCheckDefinition,
  type DoctorFixDefinition,
  type DoctorInvocationInput,
  type DoctorObservation,
} from '../governed-doctor-controller';
import { boundedRedactedObservation, governedOperationsHash } from '../governed-operations-primitives';

const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const observation = (condition: DoctorObservation['condition']): DoctorObservation => ({
  sourceId: 'observer:host', sourceRevision: 'observer-revision:7',
  observedAt: new Date(NOW - 100).toISOString(), condition,
  evidenceHash: governedOperationsHash({ condition, now: NOW }), summary: `condition=${condition}`,
});

function definitions(subjectClass: DoctorCheckDefinition['subjectClass'] = 'rebuildable_projection'):
{ check: DoctorCheckDefinition; fix?: DoctorFixDefinition } {
  const check = sealDoctorCheck({ schemaVersion: 'rorca.governed-doctor-check.v1', checkId: 'doctor.check.projection-lag.v1',
    workspaceId: 'workspace:a', subjectId: 'projection:status', subjectRevision: 'revision:17', subjectClass,
    severity: 'error', capability: subjectClass === 'rebuildable_projection' ? 'rebuild_projection' : 'observe',
    evidence: { sourceId: 'observer:host', sourceRevision: 'observer-revision:7', maximumAgeMs: 10_000 },
    precondition: { condition: 'drifted', predicateId: 'predicate:lagged', predicateRevision: '1' },
    postcondition: { condition: 'healthy', predicateId: 'predicate:current', predicateRevision: '1' } });
  if (subjectClass !== 'rebuildable_projection') return { check };
  return { check, fix: sealDoctorFix({ schemaVersion: 'rorca.governed-doctor-fix.v1', fixId: 'doctor.fix.rebuild-status.v1',
    checkId: check.checkId, workspaceId: check.workspaceId, subjectId: check.subjectId,
    subjectRevision: check.subjectRevision, mutationClass: 'rebuildable_projection', capability: 'rebuild_projection',
    precondition: check.precondition, postcondition: check.postcondition, compensationId: 'compensation:discard-projection-build',
    safeNextAction: 'request governed operator review', bounds: { maximumAttempts: 2, wallClockMs: 10_000,
      providerCostMicros: 100, resourceUnits: 10, rateLimitPerMinute: 2, cooldownMs: 0 } }) };
}

function callbacks(verifyCondition: DoctorObservation['condition'] = 'healthy', executeStatus: 'applied' | 'failed' | 'indeterminate' = 'applied'): DoctorCallbacks {
  return {
    async detect() { return observation('drifted'); },
    async execute() { return { executorSourceId: 'executor:projection-builder', status: executeStatus,
      providerCostMicros: 10, resourceUnits: 1, detail: 'local fixture execution' }; },
    async verify() { return observation(verifyCondition); },
    async compensate() { return 'compensated'; },
  };
}

function invocation(check: DoctorCheckDefinition, fix: DoctorFixDefinition | undefined,
  overrides: Partial<Omit<DoctorInvocationInput, 'check' | 'fix' | 'preview'>> = {}): DoctorInvocationInput {
  const material = { invocationId: overrides.invocationId ?? 'doctor-invocation:1', idempotencyKey: overrides.idempotencyKey ?? 'doctor-idempotency:1',
    workspaceId: 'workspace:a', subjectId: check.subjectId, subjectRevision: check.subjectRevision, check, fix,
    apply: overrides.apply ?? true, fence: overrides.fence ?? 9, requestedAt: overrides.requestedAt ?? new Date(NOW).toISOString(),
    expectedProviderCostMicros: overrides.expectedProviderCostMicros ?? 20, expectedResourceUnits: overrides.expectedResourceUnits ?? 2 };
  const requestHash = doctorInvocationRequestHash(material);
  const preview = createDoctorPreview({ previewId: `preview:${material.invocationId}`, workspaceId: material.workspaceId,
    subjectId: material.subjectId, subjectRevision: material.subjectRevision, checkDefinitionHash: check.definitionHash,
    fixDefinitionHash: fix?.definitionHash ?? null, requestHash, fence: material.fence,
    expiresAt: new Date(NOW + 60_000).toISOString() });
  return { ...material, preview };
}

test('W4-011 persists every governed phase and independently verifies a bounded fix', async () => {
  const { check, fix } = definitions();
  assert.ok(fix);
  const controller = new GovernedDoctorController(callbacks(), () => NOW);
  const result = await controller.invoke(invocation(check, fix));
  assert.deepEqual(result.transitions.map(entry => entry.transition), DOCTOR_TRANSITIONS);
  assert.equal(result.transitions[2]?.transition, 'propose');
  assert.equal(result.transitions[3]?.transition, 'authority');
  assert.equal(result.transitions[5]?.status, 'verified');
  assert.equal(result.outcome, 'fixed');
  assert.equal(result.mutated, true);
  assert.equal(result.escalation, null);
  assert.equal(result.transitions.length, 8);
});

test('W4-011 definition hashes are immutable and canonical truth remains observe-only', async () => {
  const canonical = definitions('canonical_evidence');
  assert.throws(() => validateDoctorDefinitions({ ...canonical.check, severity: 'critical' }), /hash mismatch/);
  const illegalFix = sealDoctorFix({ schemaVersion: 'rorca.governed-doctor-fix.v1', fixId: 'illegal:canonical-fix',
    checkId: canonical.check.checkId, workspaceId: canonical.check.workspaceId, subjectId: canonical.check.subjectId,
    subjectRevision: canonical.check.subjectRevision, mutationClass: 'rebuildable_projection', capability: 'rebuild_projection',
    precondition: canonical.check.precondition, postcondition: canonical.check.postcondition, compensationId: 'compensation:none',
    safeNextAction: 'operator review', bounds: { maximumAttempts: 1, wallClockMs: 1, providerCostMicros: 0,
      resourceUnits: 1, rateLimitPerMinute: 1, cooldownMs: 0 } });
  assert.throws(() => validateDoctorDefinitions(canonical.check, illegalFix), /exact check capability|observe-only/);
  let executionCount = 0;
  const noMutation = callbacks(); noMutation.execute = async () => { executionCount += 1; throw new Error('must not execute'); };
  const result = await new GovernedDoctorController(noMutation, () => NOW)
    .invoke(invocation(canonical.check, undefined, { apply: true }));
  assert.equal(result.outcome, 'observe_only');
  assert.equal(result.mutated, false);
  assert.equal(executionCount, 0);
});
test('W4-011 requires exact capability and complete condition revisions and rejects negative budgets', async () => {
  const { check, fix } = definitions(); assert.ok(fix);
  const { definitionHash: _checkHash, ...checkMaterial } = check;
  const observeCheck = sealDoctorCheck({ ...checkMaterial, capability: 'observe' });
  assert.throws(() => validateDoctorDefinitions(observeCheck, fix), /exact check capability/);
  const { definitionHash: _hash, ...fixMaterial } = fix;
  const staleConditionFix = sealDoctorFix({ ...fixMaterial,
    precondition: { ...fix.precondition, predicateRevision: 'stale' } });
  assert.throws(() => validateDoctorDefinitions(check, staleConditionFix), /complete conditions/);
  const negative = invocation(check, fix, { expectedProviderCostMicros: -1 });
  await assert.rejects(new GovernedDoctorController(callbacks(), () => NOW).invoke(negative), /non-negative safe integers/);
  const negativeReceipt = callbacks();
  negativeReceipt.execute = async () => ({ executorSourceId: 'executor', status: 'applied',
    providerCostMicros: -5, resourceUnits: -2, detail: 'negative receipt' });
  const result = await new GovernedDoctorController(negativeReceipt, () => NOW)
    .invoke(invocation(check, fix, { invocationId: 'negative-receipt', idempotencyKey: 'negative-receipt' }));
  assert.equal(result.outcome, 'compensated');
});

test('W4 operational redaction covers quoted JSON and supported free-text secret forms', () => {
  const input = '{\"authorization\":\"Bearer abc\",\"token\":\"xyz\"} secret is hidden password=hunter2';
  const redacted = boundedRedactedObservation(input);
  assert.doesNotMatch(redacted, /Bearer abc|xyz|hidden|hunter2/);
  assert.match(redacted, /\[REDACTED\]/);
});


test('W4-011 defaults to dry-run and exact unexpired previews and fences are mandatory', async () => {
  const { check, fix } = definitions(); assert.ok(fix);
  let executions = 0;
  const cb = callbacks(); cb.execute = async definition => { executions += 1; return callbacks().execute(definition); };
  const dryRun = invocation(check, fix, { apply: false });
  const result = await new GovernedDoctorController(cb, () => NOW).invoke(dryRun);
  assert.equal(result.outcome, 'dry_run');
  assert.equal(executions, 0);
  const stale = invocation(check, fix, { invocationId: 'doctor-invocation:stale', idempotencyKey: 'doctor-idempotency:stale' });
  stale.preview = createDoctorPreview({ ...stale.preview, requestHash: doctorInvocationRequestHash(stale),
    previewId: 'preview:stale', expiresAt: new Date(NOW - 1).toISOString() });
  await assert.rejects(new GovernedDoctorController(cb, () => NOW).invoke(stale), /Unexpired exact Doctor preview/);
  const wrongFence = invocation(check, fix, { invocationId: 'doctor-invocation:fence', idempotencyKey: 'doctor-idempotency:fence' });
  wrongFence.fence += 1;
  await assert.rejects(new GovernedDoctorController(cb, () => NOW).invoke(wrongFence), /exact Doctor preview/);
});

test('W4-011 identical replay returns prior result while changed replay is permanent and audited', async () => {
  const { check, fix } = definitions(); assert.ok(fix);
  const controller = new GovernedDoctorController(callbacks(), () => NOW);
  const firstInput = invocation(check, fix);
  const first = await controller.invoke(firstInput);
  assert.deepEqual(await controller.invoke(firstInput), first);
  const changed = invocation(check, fix, { expectedResourceUnits: 3 });
  await assert.rejects(controller.invoke(changed), (error: unknown) => error instanceof PermanentDoctorReplayError && !error.retryable);
  assert.match(JSON.stringify(controller.getAudit('workspace:a')), /changed_replay_permanently_rejected/);
});

test('W4-011 independent postcondition, not command output or test count, controls compensation', async () => {
  const { check, fix } = definitions(); assert.ok(fix);
  const cb = callbacks('drifted', 'applied');
  cb.execute = async () => ({ executorSourceId: 'executor:projection-builder', status: 'applied',
    providerCostMicros: 10, resourceUnits: 1, detail: 'exit=0 tests=999 password=hunter2' });
  const result = await new GovernedDoctorController(cb, () => NOW).invoke(invocation(check, fix));
  assert.equal(result.outcome, 'compensated');
  assert.equal(result.compensated, true);
  assert.equal(result.mutated, false);
  assert.doesNotMatch(JSON.stringify(result), /hunter2/);
  assert.equal(result.escalation?.safeNextAction, 'request governed operator review');
});

test('W4-011 wall-clock, per-minute rate, provider cost, and resource receipts fail closed', async () => {
  const { check, fix: originalFix } = definitions(); assert.ok(originalFix);
  const { definitionHash: _definitionHash, ...fixMaterial } = originalFix;
  const fix = sealDoctorFix({ ...fixMaterial, bounds: { ...originalFix.bounds, maximumAttempts: 3,
    rateLimitPerMinute: 1, wallClockMs: 100 } });
  let clock = NOW;
  const dynamicCallbacks = callbacks();
  dynamicCallbacks.detect = async () => ({ ...observation('drifted'), observedAt: new Date(clock - 1).toISOString() });
  dynamicCallbacks.verify = async () => ({ ...observation('healthy'), observedAt: new Date(clock - 1).toISOString() });
  const controller = new GovernedDoctorController(dynamicCallbacks, () => clock);
  assert.equal((await controller.invoke(invocation(check, fix))).outcome, 'fixed');
  const rateLimited = invocation(check, fix, { invocationId: 'doctor-invocation:rate',
    idempotencyKey: 'doctor-idempotency:rate', requestedAt: new Date(clock).toISOString() });
  assert.equal((await controller.invoke(rateLimited)).outcome, 'quarantined');
  clock += 60_000;
  const reset = invocation(check, fix, { invocationId: 'doctor-invocation:rate-reset',
    idempotencyKey: 'doctor-idempotency:rate-reset', requestedAt: new Date(clock).toISOString() });
  reset.preview = createDoctorPreview({ previewId: reset.preview.previewId, workspaceId: reset.workspaceId,
    subjectId: reset.subjectId, subjectRevision: reset.subjectRevision, checkDefinitionHash: check.definitionHash,
    fixDefinitionHash: fix.definitionHash, requestHash: doctorInvocationRequestHash(reset), fence: reset.fence,
    expiresAt: new Date(clock + 60_000).toISOString() });
  assert.equal((await controller.invoke(reset)).outcome, 'fixed');

  const expired = invocation(check, fix, { invocationId: 'doctor-invocation:wall-clock',
    idempotencyKey: 'doctor-idempotency:wall-clock', requestedAt: new Date(NOW - 101).toISOString() });
  assert.equal((await new GovernedDoctorController(callbacks(), () => NOW).invoke(expired)).outcome, 'quarantined');
  const costCallbacks = callbacks();
  costCallbacks.execute = async () => ({ executorSourceId: 'executor:projection-builder', status: 'applied',
    providerCostMicros: 21, resourceUnits: 3, detail: 'receipt exceeds previewed cost and resources' });
  const overReceipt = invocation(check, fix, { invocationId: 'doctor-invocation:receipt',
    idempotencyKey: 'doctor-idempotency:receipt' });
  assert.equal((await new GovernedDoctorController(costCallbacks, () => NOW).invoke(overReceipt)).outcome, 'compensated');
});

test('W4-011 overlapping deliveries share one scoped lock and aggregate attempt budget', async () => {
  const { check, fix: originalFix } = definitions(); assert.ok(originalFix);
  const { definitionHash: _definitionHash, ...fixMaterial } = originalFix;
  const fix = sealDoctorFix({ ...fixMaterial, bounds: { ...originalFix.bounds, maximumAttempts: 1 } });
  const gate = Promise.withResolvers<void>();
  const blocked = gate.promise;
  const cb = callbacks();
  cb.execute = async () => { await blocked; return { executorSourceId: 'executor:projection-builder',
    status: 'applied', providerCostMicros: 10, resourceUnits: 1, detail: 'settled' }; };
  const controller = new GovernedDoctorController(cb, () => NOW);
  const firstPromise = controller.invoke(invocation(check, fix));
  await waitForImmediate();
  const overlap = invocation(check, fix, { invocationId: 'doctor-invocation:overlap', idempotencyKey: 'doctor-idempotency:overlap' });
  await assert.rejects(controller.invoke(overlap), /scoped lock/);
  gate.resolve(); await firstPromise;
  const exhausted = invocation(check, fix, { invocationId: 'doctor-invocation:exhausted', idempotencyKey: 'doctor-idempotency:exhausted' });
  const exhaustedResult = await controller.invoke(exhausted);
  assert.equal(exhaustedResult.outcome, 'quarantined');
  assert.equal(exhaustedResult.transitions.find(entry => entry.transition === 'execute')?.status, 'skipped');
});
