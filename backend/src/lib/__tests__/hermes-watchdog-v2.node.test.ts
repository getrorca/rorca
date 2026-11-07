/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { declareHermesAuthority } from '../hermes-authority';
import {
  classifyKnownWatchdogFailure,
  createHermesWatchdogV2,
  type HermesWatchdogDependencies,
  type HermesWatchdogEvent,
  type WatchdogActionReceipt,
  type WatchdogCanonicalEvent,
  type WatchdogHealingAction,
} from '../hermes-watchdog';

const authority = declareHermesAuthority('watchdog', 'operator-dispatch');
const lineage = Object.freeze({
  workspaceId: 'workspace-aav-020',
  specPath: 'forge/specs/approved/aav-020.json',
  runId: 42,
  rootRunId: 30,
  attemptId: 'attempt-42',
  executionIdentity: 'pi:agent-AAV-020',
  executor: 'pi' as const,
  model: 'openai-codex/gpt-5.6-sol',
  worktreeId: 'worktree-aav-020',
});

function event(overrides: Partial<WatchdogCanonicalEvent> = {}): WatchdogCanonicalEvent {
  return {
    eventId: 'event-42',
    eventType: 'evidence',
    runStatus: 'failed',
    healingAttempt: 0,
    maxHealingAttempts: 3,
    lineage,
    evidence: ['engine_exit: process exit 1'],
    ...overrides,
  };
}

function receipt(action: WatchdogHealingAction): WatchdogActionReceipt {
  return {
    receiptId: 'receipt-1',
    action: action.kind,
    accepted: true,
    outcome: 'canonical_action_applied',
    sourceRunId: action.lineage.runId,
    rootRunId: action.lineage.rootRunId,
    attemptId: action.lineage.attemptId,
    executionIdentity: action.lineage.executionIdentity,
    model: action.requestedModel,
    worktreeId: action.lineage.worktreeId,
  };
}

function harness(overrides: Partial<HermesWatchdogDependencies> = {}) {
  const actions: WatchdogHealingAction[] = [];
  const events: HermesWatchdogEvent[] = [];
  const dependencies: HermesWatchdogDependencies = {
    async invokeGovernedRorcaAction(action) {
      actions.push(action);
      return receipt(action);
    },
    async emitDurableHermesEvent(auditEvent) { events.push(auditEvent); },
    ...overrides,
  };
  return { watchdog: createHermesWatchdogV2(dependencies), actions, events };
}

test('known failure classes are deterministic and select governed actions', async () => {
  assert.equal(classifyKnownWatchdogFailure(['quota exceeded']), 'provider_usage_limit');
  assert.equal(classifyKnownWatchdogFailure(['ECONNREFUSED']), 'connection_error');
  assert.equal(classifyKnownWatchdogFailure(['authority snapshot mismatch']), 'authority_conflict');
  assert.equal(classifyKnownWatchdogFailure(['stale worktree']), 'worktree_stale');
  assert.equal(classifyKnownWatchdogFailure(['engine_interrupted']), 'engine_exit');

  const alternate = harness();
  const result = await alternate.watchdog.consume(event({ evidence: ['provider quota exceeded'] }), authority);
  assert.equal(result.outcome, 'applied');
  assert.equal(result.diagnosis?.source, 'deterministic');
  assert.equal(result.action?.kind, 'alternate_model');
  assert.equal(result.action?.requestedModel, 'deepseek/deepseek-v4-flash');
  assert.equal(alternate.events[0]?.receipt?.rootRunId, lineage.rootRunId);
  assert.equal(alternate.events[0]?.lineage.executionIdentity, lineage.executionIdentity);
});

test('novel failure synthesis is bounded to one call and cannot choose a model', async () => {
  let synthesisCalls = 0;
  const novel = harness({
    async synthesizeNovelFailure(input) {
      synthesisCalls += 1;
      assert.deepEqual(input.allowedActions, ['restart', 'alternate_model', 'worktree_refresh', 'authority_reprovision']);
      assert.equal(input.evidence.length, 8);
      return { failureClass: 'novel_lock', action: 'worktree_refresh', reason: 'novel lock signature' };
    },
  });
  const result = await novel.watchdog.consume(event({ evidence: Array.from({ length: 12 }, (_, index) => `novel-${index}`) }), authority);
  assert.equal(synthesisCalls, 1);
  assert.equal(result.diagnosis?.source, 'bounded_llm');
  assert.equal(result.action?.kind, 'worktree_refresh');
  assert.equal(result.action?.requestedModel, lineage.model);
});

test('failed novel synthesis falls back once and still emits a complete durable outcome', async () => {
  let synthesisCalls = 0;
  const fallback = harness({
    async synthesizeNovelFailure() {
      synthesisCalls += 1;
      throw new Error('provider unavailable');
    },
  });
  const result = await fallback.watchdog.consume(event({ evidence: ['unrecognized failure'] }), authority);
  assert.equal(synthesisCalls, 1);
  assert.equal(result.outcome, 'applied');
  assert.equal(result.action?.kind, 'restart');
  assert.equal(fallback.events[0]?.diagnosis?.source, 'bounded_llm');
  assert.equal(fallback.events[0]?.receipt?.receiptId, 'receipt-1');
});

test('exhausted and queued states emit durable holds without invoking Rorca actions or synthesis', async () => {
  let synthesisCalls = 0;
  const held = harness({
    async synthesizeNovelFailure() {
      synthesisCalls += 1;
      return { failureClass: 'x', action: 'restart', reason: 'x' };
    },
  });
  assert.equal((await held.watchdog.consume(event({ runStatus: 'queued' }), authority)).outcome, 'held_in_flight');
  assert.equal((await held.watchdog.consume(event({ healingAttempt: 3, maxHealingAttempts: 3 }), authority)).outcome, 'exhausted');
  assert.equal(held.actions.length, 0);
  assert.equal(synthesisCalls, 0);
  assert.deepEqual(held.events.map((item) => item.outcome), ['held_in_flight', 'exhausted']);
});

test('authority healing preserves identity/model/lineage and rejects a mismatched canonical receipt', async () => {
  const governed = harness();
  const applied = await governed.watchdog.consume(event({ evidence: ['lease fence authority denied'] }), authority);
  assert.equal(applied.action?.kind, 'authority_reprovision');
  assert.equal(applied.action?.lineage, lineage);
  assert.equal(applied.receipt?.executionIdentity, lineage.executionIdentity);
  assert.equal(applied.receipt?.model, lineage.model);

  const mismatched = harness({
    async invokeGovernedRorcaAction(action) {
      return { ...receipt(action), executionIdentity: 'different-agent' };
    },
  });
  assert.equal((await mismatched.watchdog.consume(event(), authority)).outcome, 'refused');
  assert.equal(mismatched.events[0]?.reason, 'canonical receipt did not preserve exact lineage');
  await assert.rejects(() => governed.watchdog.consume(event(), declareHermesAuthority('subscription', 'service-audit') as never));
});

test('watchdog boundary contains no scheduler or direct canonical mutation path', () => {
  const root = fs.existsSync(path.resolve(process.cwd(), 'backend', 'src'))
    ? path.resolve(process.cwd(), 'backend', 'src')
    : path.resolve(process.cwd(), 'src');
  const source = fs.readFileSync(path.join(root, 'lib', 'hermes-watchdog.ts'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.ts'), 'utf8');
  assert.doesNotMatch(source, /setInterval|setTimeout\s*\([^)]*tick|startWatchdogLoop|pipeline\/trigger|boss\.send|UPDATE pipeline_runs/);
  assert.doesNotMatch(server, /startWatchdogLoop/);
  assert.match(source, /invokeGovernedRorcaAction/);
  assert.match(source, /emitDurableHermesEvent/);
});
