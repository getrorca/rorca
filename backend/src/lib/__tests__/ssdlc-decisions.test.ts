/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

jest.mock('../../db/index', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  transaction: jest.fn(),
}));

import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../errors';
import {
  deriveDecisionPrincipal,
  getSsdlcDecisionState,
  recordSsdlcDecision,
  revokeSsdlcDecision,
  type RecordSsdlcDecisionInput,
  type SsdlcDecisionDependencies,
} from '../ssdlc-decisions';
import {
  ARTIFACT_SUBJECT,
  COMMIT_SUBJECT,
  EVALUATION_TIME,
  EVALUATOR_PLAN,
} from './fixtures/ssdlc-phase-evaluator.fixtures';

const NOW = new Date(EVALUATION_TIME);
const FUTURE = '2026-07-20T12:00:00.000Z';
type Store = NonNullable<SsdlcDecisionDependencies['store']>;
type Candidate = Parameters<Store['persist']>[0];
type Row = Awaited<ReturnType<Store['list']>>[number];

const localAdmin = deriveDecisionPrincipal({
  id: 'local-admin',
  email: 'admin@rorca.local',
  role: 'admin',
});

const ordinaryUser = deriveDecisionPrincipal({
  id: 'user-7',
  email: 'reviewer@example.test',
  role: 'user',
});

function rowFromCandidate(candidate: Candidate, overrides: Partial<Row> = {}): Row {
  return {
    id: String(overrides.id ?? '1'),
    workspace_id: candidate.workspaceId,
    spec_slug: candidate.specSlug,
    spec_version: candidate.specVersion,
    run_id: candidate.runId,
    story_id: candidate.storyId,
    phase_id: candidate.phaseId,
    gate_id: candidate.gateId,
    decision_type: candidate.decisionType,
    rationale: candidate.rationale,
    evidence_gap: candidate.evidenceGap,
    subject_type: candidate.subject?.type ?? null,
    subject_value: candidate.subject?.value ?? null,
    policy_version: candidate.policyVersion,
    policy_reference: candidate.policyReference,
    policy_authorized: true,
    principal_type: candidate.principal.principalType,
    principal_id: candidate.principal.principalId,
    principal_display_label: candidate.principal.displayLabel,
    actor: candidate.principal.displayLabel,
    delegated_principal_id: candidate.principal.delegatedOnBehalfOf?.principalId ?? null,
    delegated_display_label: candidate.principal.delegatedOnBehalfOf?.displayLabel ?? null,
    provider_human_receipt_id: candidate.principal.providerHumanReceiptId ?? null,
    source_request_id: candidate.sourceRequestId,
    source_channel: candidate.principal.sourceChannel,
    scope_key: candidate.scopeKey,
    request_hash: candidate.requestHash,
    created_at: NOW,
    expires_at: candidate.expiresAt,
    revoked_at: null,
    revoked_by_principal_type: null,
    revoked_by_principal_id: null,
    revoked_by_display_label: null,
    revocation_rationale: null,
    revocation_source_request_id: null,
    ...overrides,
  };
}

function wal(row: Row) {
  return {
    id: Number(row.id),
    ts: NOW.toISOString(),
    event_type: 'decision_recorded',
    workspace_id: row.workspace_id,
    spec_id: row.spec_slug,
    story_id: row.story_id,
    actor: row.principal_id,
    payload: JSON.stringify({ decisionId: row.id }),
  };
}

function createHarness(options: { currentIdentity?: string; plan?: typeof EVALUATOR_PLAN } = {}) {
  const rows: Row[] = [];
  let currentIdentity = (options.currentIdentity ?? ARTIFACT_SUBJECT.value).toLowerCase();
  const plan = options.plan ?? EVALUATOR_PLAN;
  const store: Store = {
    loadPolicyContext: jest.fn(async (workspaceId, specSlug) => {
      if (workspaceId !== plan.workspaceId || specSlug !== plan.specId) {
        throw new NotFoundError('Current lifecycle policy', `${workspaceId}/${specSlug}`);
      }
      return { workspacePath: '/tmp/workspace-evaluator', plan };
    }),
    resolveCurrentIdentity: jest.fn(async () => currentIdentity),
    persist: jest.fn(async (candidate) => {
      const byRequest = rows.find((row) => row.workspace_id === candidate.workspaceId
        && row.source_request_id === candidate.sourceRequestId);
      if (byRequest) {
        if (byRequest.request_hash !== candidate.requestHash) {
          throw new ConflictError('Decision idempotency key was reused with a different request', {
            existingDecisionId: byRequest.id,
            sourceRequestId: candidate.sourceRequestId,
          });
        }
        return { row: byRequest, replayed: true, walEvent: null };
      }
      const active = rows.find((row) => row.workspace_id === candidate.workspaceId
        && row.spec_slug === candidate.specSlug
        && row.phase_id === candidate.phaseId
        && (row.gate_id === null || candidate.gateId === null || row.gate_id === candidate.gateId)
        && row.revoked_at === null
        && (!row.expires_at || new Date(row.expires_at).getTime() > NOW.getTime()));
      if (active) {
        if (active.request_hash === candidate.requestHash) {
          return { row: active, replayed: true, walEvent: null };
        }
        throw new ConflictError('A conflicting active decision already overlaps this lifecycle scope', {
          existingDecisionId: active.id,
          existingDecisionType: active.decision_type,
          requestedDecisionType: candidate.decisionType,
        });
      }
      const row = rowFromCandidate(candidate, { id: String(rows.length + 1) });
      rows.push(row);
      return { row, replayed: false, walEvent: wal(row) };
    }),
    revoke: jest.fn(async (input, principal) => {
      const row = rows.find((candidate) => candidate.workspace_id === input.workspaceId && candidate.id === input.decisionId);
      if (!row) throw new NotFoundError('SSDLC decision', input.decisionId);
      if (row.revoked_at) throw new ConflictError('SSDLC decision has already been revoked', { decisionId: row.id });
      Object.assign(row, {
        revoked_at: NOW,
        revoked_by_principal_type: principal.principalType,
        revoked_by_principal_id: principal.principalId,
        revoked_by_display_label: principal.displayLabel,
        revocation_rationale: input.rationale,
        revocation_source_request_id: input.sourceRequestId,
      });
      return { row, replayed: false, walEvent: wal(row) };
    }),
    list: jest.fn(async (workspaceId, specSlug, phaseId, gateId, activeOnly) => rows.filter((row) =>
      row.workspace_id === workspaceId
      && row.spec_slug === specSlug
      && row.phase_id === phaseId
      && (gateId === null || row.gate_id === gateId)
      && (!activeOnly || (row.revoked_at === null
        && (!row.expires_at || new Date(row.expires_at).getTime() > NOW.getTime()))))),
  };
  return {
    store,
    rows,
    setCurrentIdentity(value: string) { currentIdentity = value.toLowerCase(); },
  };
}

function input(overrides: Partial<RecordSsdlcDecisionInput> = {}): RecordSsdlcDecisionInput {
  return {
    workspaceId: EVALUATOR_PLAN.workspaceId,
    specSlug: EVALUATOR_PLAN.specId,
    phaseId: 'architecture',
    gateId: 'gate-architecture',
    decisionType: 'gate_override',
    rationale: 'The bounded review documents why this exception is safe.',
    evidenceGap: 'The external architecture sign-off is temporarily unavailable.',
    expiresAt: FUTURE,
    sourceRequestId: 'request-1',
    ...overrides,
  };
}

function deps(store: Store, broadcast = jest.fn()): SsdlcDecisionDependencies {
  return { store, broadcast, now: () => new Date(NOW) };
}

// Mandatory protocol: prove deny paths before happy paths.
describe('governed decision deny paths', () => {
  test('hard-deny controls short-circuit before override persistence', async () => {
    const harness = createHarness();
    await expect(recordSsdlcDecision(input({
      phaseId: 'security',
      gateId: 'gate-security',
      sourceRequestId: 'hard-deny-1',
    }), localAdmin, deps(harness.store))).rejects.toThrow('non-bypassable hard-deny control');
    expect(harness.store.persist).not.toHaveBeenCalled();
    expect(harness.store.resolveCurrentIdentity).not.toHaveBeenCalled();
  });

  test('ordinary users and internal agents cannot self-declare approver authority', async () => {
    const userHarness = createHarness();
    await expect(recordSsdlcDecision(input({
      decisionType: 'defer',
      gateId: null,
      evidenceGap: null,
      sourceRequestId: 'unauthorized-user',
    }), ordinaryUser, deps(userHarness.store))).rejects.toBeInstanceOf(ForbiddenError);

    const internal = deriveDecisionPrincipal({
      id: '00000000-0000-0000-0000-000000000000',
      email: 'scheduler@rorca.internal',
      role: 'admin',
    });
    await expect(recordSsdlcDecision(input({
      phaseId: 'intake',
      gateId: null,
      decisionType: 'not_applicable_confirmation',
      evidenceGap: null,
      expiresAt: null,
      sourceRequestId: 'unauthorized-agent',
    }), internal, deps(createHarness().store))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test('deferral requires a revisit date and N/A requires a concrete rationale', async () => {
    const harness = createHarness();
    await expect(recordSsdlcDecision(input({
      decisionType: 'defer',
      gateId: null,
      evidenceGap: null,
      expiresAt: null,
    }), localAdmin, deps(harness.store))).rejects.toThrow('expiry/revisit date');

    await expect(recordSsdlcDecision(input({
      phaseId: 'intake',
      gateId: null,
      decisionType: 'not_applicable_confirmation',
      rationale: 'not needed',
      evidenceGap: null,
      expiresAt: null,
    }), localAdmin, deps(harness.store))).rejects.toThrow('concrete rationale');
  });

  test('high-risk N/A is denied when the active policy has no audited approval path', async () => {
    const harness = createHarness();
    await expect(recordSsdlcDecision(input({
      phaseId: 'staging',
      gateId: null,
      decisionType: 'not_applicable_confirmation',
      rationale: 'No staging environment exists for this offline-only package.',
      evidenceGap: null,
      expiresAt: null,
      sourceRequestId: 'staging-na',
    }), localAdmin, deps(harness.store))).rejects.toThrow('no policy-authorized audited N/A approval path');
  });

  test('gate override needs an exact policy-permitted gate, evidence gap, and expiry', async () => {
    const harness = createHarness();
    await expect(recordSsdlcDecision(input({ gateId: null }), localAdmin, deps(harness.store)))
      .rejects.toThrow('exact gateId');
    await expect(recordSsdlcDecision(input({ evidenceGap: null }), localAdmin, deps(harness.store)))
      .rejects.toThrow('concrete evidenceGap');
    await expect(recordSsdlcDecision(input({ expiresAt: null }), localAdmin, deps(harness.store)))
      .rejects.toThrow('expiry date');
    await expect(recordSsdlcDecision(input({
      phaseId: 'validation',
      gateId: 'gate-validation',
    }), localAdmin, deps(harness.store))).rejects.toThrow('Policy does not permit');
  });

  test('approval rejects a request-body revision that differs from current server state', async () => {
    const harness = createHarness({ currentIdentity: ARTIFACT_SUBJECT.value });
    const promise = recordSsdlcDecision(input({
      phaseId: 'qa',
      gateId: 'gate-qa',
      decisionType: 'qa_approval',
      subject: { type: 'artifact_digest', value: `sha256:${'c'.repeat(64)}` },
      evidenceGap: null,
      expiresAt: null,
      sourceRequestId: 'revision-mismatch',
    }), localAdmin, deps(harness.store));
    await expect(promise).rejects.toMatchObject({
      statusCode: 409,
      details: { reason: 'revision_mismatch', currentIdentity: ARTIFACT_SUBJECT.value },
    });
    expect(harness.store.persist).not.toHaveBeenCalled();
  });

  test('cross-workspace scopes cannot resolve another workspace policy', async () => {
    const harness = createHarness();
    await expect(recordSsdlcDecision(input({ workspaceId: 'workspace-other' }), localAdmin, deps(harness.store)))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(harness.store.persist).not.toHaveBeenCalled();
  });
});

describe('authorized decisions, idempotency, and derived state', () => {
  test('derives local, user, Hermes, and internal provenance and restricts delegation to Hermes', () => {
    expect(localAdmin).toMatchObject({ principalType: 'local_admin', principalId: 'local-admin', sourceChannel: 'local' });
    expect(ordinaryUser).toMatchObject({ principalType: 'authenticated_user', sourceChannel: 'api' });
    const hermes = deriveDecisionPrincipal({ id: 'hermes-service', email: 'hermes@rorca.internal', role: 'admin' }, {
      principalId: 'human-approver-9',
      displayLabel: 'Release Approver',
    });
    expect(hermes).toMatchObject({
      principalType: 'hermes',
      sourceChannel: 'hermes',
      delegatedOnBehalfOf: { principalId: 'human-approver-9', displayLabel: 'Release Approver' },
    });
    expect(() => deriveDecisionPrincipal({ id: 'user-7', email: 'reviewer@example.test', role: 'admin' }, {
      principalId: 'claimed-human', displayLabel: 'Claimed Human',
    })).toThrow(ValidationError);
  });

  test('records an expiring override without touching evidence and broadcasts after persistence', async () => {
    const harness = createHarness();
    const order: string[] = [];
    (harness.store.persist as jest.Mock).mockImplementationOnce(async (candidate: Candidate) => {
      order.push('durable');
      const row = rowFromCandidate(candidate);
      harness.rows.push(row);
      return { row, replayed: false, walEvent: wal(row) };
    });
    const broadcast = jest.fn(() => order.push('broadcast'));
    const result = await recordSsdlcDecision(input(), localAdmin, deps(harness.store, broadcast));

    expect(result.replayed).toBe(false);
    expect(result.decision).toMatchObject({
      decisionType: 'gate_override',
      gateId: 'gate-architecture',
      evidenceGap: expect.stringContaining('sign-off'),
      policy: { version: EVALUATOR_PLAN.policyVersion, authorized: true },
      actor: {
        principalType: 'local_admin',
        principalId: 'local-admin',
        displayLabel: 'admin@rorca.local',
        sourceChannel: 'local',
      },
      sourceRequestId: 'request-1',
    });
    expect(order).toEqual(['durable', 'broadcast']);
  });

  test('an active deferral leaves phase state visibly deferred rather than approved', async () => {
    const harness = createHarness();
    await recordSsdlcDecision(input({
      phaseId: 'implementation',
      gateId: null,
      decisionType: 'defer',
      evidenceGap: null,
      sourceRequestId: 'defer-1',
    }), localAdmin, deps(harness.store));
    const state = await getSsdlcDecisionState({
      workspaceId: EVALUATOR_PLAN.workspaceId,
      specSlug: EVALUATOR_PLAN.specId,
      phaseId: 'implementation',
    }, deps(harness.store));
    expect(state.state).toBe('deferred');
    expect(state.effectiveDecisions[0].activity).toBe('active');
  });

  test('exact replays are idempotent and conflicting active decisions include explanatory details', async () => {
    const harness = createHarness();
    const first = await recordSsdlcDecision(input(), localAdmin, deps(harness.store));
    const replay = await recordSsdlcDecision(input(), localAdmin, deps(harness.store));
    expect(replay).toMatchObject({ replayed: true, decision: { id: first.decision.id } });
    expect(harness.rows).toHaveLength(1);

    await expect(recordSsdlcDecision(input({
      rationale: 'A different exception rationale conflicts with the active decision.',
      sourceRequestId: 'request-2',
    }), localAdmin, deps(harness.store))).rejects.toMatchObject({
      statusCode: 409,
      details: {
        existingDecisionId: first.decision.id,
        existingDecisionType: 'gate_override',
        requestedDecisionType: 'gate_override',
      },
    });
  });

  test('QA approval becomes stale immediately when immutable image identity changes', async () => {
    const harness = createHarness({ currentIdentity: ARTIFACT_SUBJECT.value });
    await recordSsdlcDecision(input({
      phaseId: 'qa',
      gateId: 'gate-qa',
      decisionType: 'qa_approval',
      subject: ARTIFACT_SUBJECT,
      evidenceGap: null,
      expiresAt: null,
      sourceRequestId: 'qa-approval-1',
    }), localAdmin, deps(harness.store));
    expect((await getSsdlcDecisionState({
      workspaceId: EVALUATOR_PLAN.workspaceId,
      specSlug: EVALUATOR_PLAN.specId,
      phaseId: 'qa',
    }, deps(harness.store))).state).toBe('approved');

    harness.setCurrentIdentity(`sha256:${'d'.repeat(64)}`);
    const stale = await getSsdlcDecisionState({
      workspaceId: EVALUATOR_PLAN.workspaceId,
      specSlug: EVALUATOR_PLAN.specId,
      phaseId: 'qa',
    }, deps(harness.store));
    expect(stale.state).toBe('pending');
    expect(stale.history[0]).toMatchObject({ activity: 'stale_revision' });
  });

  test('commit-bound merge approvals use the exact current HEAD identity', async () => {
    const harness = createHarness({ currentIdentity: COMMIT_SUBJECT.value });
    const result = await recordSsdlcDecision(input({
      phaseId: 'merge',
      gateId: 'gate-merge',
      decisionType: 'merge_approval',
      subject: COMMIT_SUBJECT,
      evidenceGap: null,
      expiresAt: null,
      sourceRequestId: 'merge-approval-1',
    }), localAdmin, deps(harness.store));
    expect(result.decision.subject).toEqual(COMMIT_SUBJECT);
  });

  test('revocation immediately removes approval from state and remains in audit history', async () => {
    const harness = createHarness({ currentIdentity: ARTIFACT_SUBJECT.value });
    const recorded = await recordSsdlcDecision(input({
      phaseId: 'qa',
      gateId: 'gate-qa',
      decisionType: 'qa_approval',
      subject: ARTIFACT_SUBJECT,
      evidenceGap: null,
      expiresAt: null,
      sourceRequestId: 'qa-revoke-record',
    }), localAdmin, deps(harness.store));
    await revokeSsdlcDecision({
      workspaceId: EVALUATOR_PLAN.workspaceId,
      decisionId: recorded.decision.id,
      rationale: 'The QA approval was withdrawn after a review defect was found.',
      sourceRequestId: 'qa-revoke-request',
    }, localAdmin, deps(harness.store));

    const state = await getSsdlcDecisionState({
      workspaceId: EVALUATOR_PLAN.workspaceId,
      specSlug: EVALUATOR_PLAN.specId,
      phaseId: 'qa',
    }, deps(harness.store));
    expect(state.state).toBe('pending');
    expect(state.effectiveDecisions).toHaveLength(0);
    expect(state.history[0]).toMatchObject({
      activity: 'revoked',
      revocation: {
        principalId: 'local-admin',
        rationale: expect.stringContaining('withdrawn'),
        sourceRequestId: 'qa-revoke-request',
      },
    });
  });

  test('expired decisions remain visible but cannot hold a passing state', async () => {
    const harness = createHarness();
    const candidate = {
      workspaceId: EVALUATOR_PLAN.workspaceId,
      specSlug: EVALUATOR_PLAN.specId,
      specVersion: null,
      runId: null,
      storyId: null,
      phaseId: 'implementation' as const,
      gateId: null,
      decisionType: 'defer' as const,
      rationale: 'Implementation was deferred for a bounded review window.',
      evidenceGap: null,
      subject: null,
      expiresAt: new Date('2026-07-15T11:00:00.000Z'),
      policyVersion: EVALUATOR_PLAN.policyVersion,
      policyReference: `${EVALUATOR_PLAN.policyVersion}:implementation`,
      principal: localAdmin,
      sourceRequestId: 'expired-defer',
      scopeKey: 'fixture-phase-evaluator|implementation|*|*|*',
      requestHash: `sha256:${'e'.repeat(64)}`,
    } satisfies Candidate;
    harness.rows.push(rowFromCandidate(candidate));

    const state = await getSsdlcDecisionState({
      workspaceId: EVALUATOR_PLAN.workspaceId,
      specSlug: EVALUATOR_PLAN.specId,
      phaseId: 'implementation',
    }, deps(harness.store));
    expect(state.state).toBe('pending');
    expect(state.history[0].activity).toBe('expired');
  });
});
