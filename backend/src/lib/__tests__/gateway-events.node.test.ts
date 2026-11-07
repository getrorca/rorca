/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ActionEnvelopeV1Schema, MISSION_CONTRACT_VERSIONS, type EntityRefV1 } from '../mission-contracts';
import { toRunEventDispatch } from '../run-event-subscription';
import type { WalEvent } from '../sse-hub';
import {
  GATEWAY_EVENT_KINDS,
  GatewayEventV1Schema,
  gatewayWalEventType,
  projectGatewayEvent,
  type GatewayEventInput,
  type GatewayIdentityV1,
} from '../gateway-events';

const hash = (digit: string) => `sha256:${digit.repeat(64)}`;
function ref(kind: EntityRefV1['kind'], id: string, revision?: EntityRefV1['revision']): EntityRefV1 {
  return { schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef, workspaceId: 'ws-a', kind, id, label: id, ...(revision ? { revision } : {}) };
}
const identity: GatewayIdentityV1 = {
  workspaceId: 'ws-a', mission: ref('mission', 'mission-a'),
  spec: ref('spec', 'spec-a', { kind: 'spec_version', value: '7' }), specRevisionHash: hash('a'),
  run: ref('run', '42'), story: ref('story', 'HMG-010'), attempt: ref('attempt', 'attempt-1'),
};

const details: Record<(typeof GATEWAY_EVENT_KINDS)[number], GatewayEventInput['details']> = {
  mission_draft_ready: { assuranceProfileId: 'profile-7' },
  decision_required: { decisionId: 'decision-1', question: 'Approve exact revision 7?' },
  gate_blocked: { gateId: 'security', blockingControlIds: ['CTRL-1'] },
  source_drift: { previousBundleHash: hash('b'), currentBundleHash: hash('c') },
  run_completed: { outcome: 'succeeded', evidenceBundleId: 'evidence-42' },
  release_ready: { releaseId: 'release-1', evidenceBundleId: 'evidence-42' },
};

function input(kind: (typeof GATEWAY_EVENT_KINDS)[number]): GatewayEventInput {
  return { kind, sourceEventId: `source:${kind}`, occurredAt: '2026-03-16T00:00:00.000Z', identity,
    summary: `Gateway ${kind}`, details: details[kind] } as GatewayEventInput;
}

describe('HMG-010 gateway event contract', () => {
  test('owns exactly six strict, versioned, identity-bearing payloads', () => {
    assert.deepEqual(GATEWAY_EVENT_KINDS, [
      'mission_draft_ready', 'decision_required', 'gate_blocked', 'source_drift', 'run_completed', 'release_ready',
    ]);
    for (const [index, kind] of GATEWAY_EVENT_KINDS.entries()) {
      const payload = projectGatewayEvent(input(kind), index + 1);
      assert.equal(GatewayEventV1Schema.safeParse(payload).success, true);
      assert.equal(payload.identity.spec.revision?.value, '7');
      assert.equal(payload.identity.specRevisionHash, hash('a'));
      assert.equal(gatewayWalEventType(payload), `gateway.${kind}`);
      assert.equal(ActionEnvelopeV1Schema.safeParse(payload).success, false);
      assert.equal(GatewayEventV1Schema.safeParse({ ...payload, permittedAction: {} }).success, false);
    }
  });

  test('rejects cross-workspace identity and malformed kind-specific data', () => {
    const foreign = { ...identity, story: { ...identity.story!, workspaceId: 'ws-b' } };
    assert.throws(() => projectGatewayEvent({ ...input('gate_blocked'), identity: foreign } as GatewayEventInput, 1));
    assert.throws(() => projectGatewayEvent({ ...input('release_ready'), details: { releaseId: 'release-1' } } as GatewayEventInput, 1));
  });

  test('coexists with orchestration payloads in the unchanged WAL/SSE subscription envelope', () => {
    const gateway = projectGatewayEvent(input('run_completed'), 5);
    const gatewayWal: WalEvent = { id: 101, ts: gateway.occurredAt, event_type: gatewayWalEventType(gateway),
      workspace_id: 'ws-a', spec_id: 'spec-a', story_id: 'HMG-010', actor: 'hermes-gateway', payload: JSON.stringify(gateway) };
    const orchestrationWal: WalEvent = { ...gatewayWal, id: 102, event_type: 'orchestration.agent_completed',
      payload: JSON.stringify({ schemaVersion: 'rorca.orchestration-event.v1' }) };
    const gatewayDispatch = toRunEventDispatch(gatewayWal)!;
    const orchestrationDispatch = toRunEventDispatch(orchestrationWal)!;
    assert.equal(gatewayDispatch.family, 'gateway');
    assert.equal(orchestrationDispatch.family, 'orchestration');
    assert.equal(gatewayDispatch.payloadSchemaVersion, 'rorca.gateway-event.v1');
    assert.equal(orchestrationDispatch.payloadSchemaVersion, 'rorca.orchestration-event.v1');
    assert.strictEqual(gatewayDispatch.event, gatewayWal);
  });
});
