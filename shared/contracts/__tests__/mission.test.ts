import { describe, expect, it } from 'vitest';
import {
  ACTION_AUTHORITIES,
  ACTION_PRIORITIES,
  AUTHORITY_STATES,
  ActionEnvelopeV1Schema,
  CONFIDENCE_STATES,
  DeliveryCaseSummaryV1Schema,
  DELIVERY_STAGES,
  ENTITY_KINDS,
  EXECUTION_EFFORTS,
  EXECUTION_MODES,
  EXECUTION_SCHEDULING,
  LIFECYCLE_PROJECTION_STATES,
  MERGE_STRATEGIES,
  OWNER_KINDS,
  ExecutionReceiptV1Schema,
  FRESHNESS_STATES,
  LIVENESS_STATES,
  MISSION_CONTRACT_VERSIONS,
  OperationalStatePacketV1Schema,
  OUTCOME_STATES,
  PERMITTED_ACTION_KINDS,
  READINESS_PROJECTION_STATES,
  RELEASE_PROJECTION_STATES,
  REVISION_KINDS,
  RISK_STATES,
  REVIEW_PROJECTION_STATES,
  RUN_PROJECTION_STATES,
  ReturnContextV1Schema,
  RunControlProjectionV1Schema,
  EntityRefV1Schema,
  STATE_SOURCE_KINDS,
} from '../index';

const NOW = '2026-08-06T12:00:00Z';
const HASH = `sha256:${'a'.repeat(64)}`;
const PREVIEW_HASH = `sha256:${'b'.repeat(64)}`;

function entity(kind: (typeof ENTITY_KINDS)[number], id: string, revision?: { kind: (typeof REVISION_KINDS)[number]; value: string }) {
  return {
    schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
    workspaceId: 'ws-mission',
    kind,
    id,
    ...(revision ? { revision } : {}),
    label: `${kind} ${id}`,
  };
}

function state() {
  return {
    schemaVersion: MISSION_CONTRACT_VERSIONS.operationalStatePacket,
    outcome: 'pending',
    liveness: 'running',
    risk: 'low',
    confidence: 'high',
    freshness: 'fresh',
    authority: 'authoritative',
    observedAt: NOW,
    source: { kind: 'backend', id: 'mission-projection', label: 'Mission projection' },
    consequence: 'Delivery is still in progress.',
    nextSafeAction: {
      actionId: 'view-run',
      label: 'View run',
      rationale: 'Inspect current execution evidence.',
      requiresApproval: false,
      authority: 'user',
      href: '/runs/run-1',
    },
  };
}

function action() {
  return {
    schemaVersion: MISSION_CONTRACT_VERSIONS.actionEnvelope,
    actionId: 'view-run',
    workspaceId: 'ws-mission',
    entity: entity('run', 'run-1'),
    mission: entity('mission', 'mission-1', { kind: 'version', value: '7' }),
    priority: 'ready',
    whyNow: 'Fresh run evidence is available.',
    state: state(),
    owner: { kind: 'user', id: 'user-1', label: 'Operator' },
    createdAt: NOW,
    freshness: 'fresh',
    permittedAction: {
      actionId: 'view-run',
      kind: 'view',
      label: 'View run',
      requiresApproval: false,
      authority: 'user',
      href: '/runs/run-1',
    },
  };
}

function stage(label: string) {
  return { label, summary: `${label} projection`, state: state(), updatedAt: NOW };
}

function deliveryCase() {
  return {
    schemaVersion: MISSION_CONTRACT_VERSIONS.deliveryCaseSummary,
    workspaceId: 'ws-mission',
    mission: entity('mission', 'mission-1', { kind: 'version', value: '7' }),
    spec: entity('spec', 'spec-1', { kind: 'spec_version', value: '12' }),
    stages: {
      planning: stage('Planning'),
      requirements: stage('Requirements'),
      design: stage('Design'),
      development: stage('Development'),
      testing: stage('Testing'),
      deployment: stage('Deployment'),
      maintenance: stage('Maintenance'),
    },
    review: { state: 'in_review', requiredDecisions: 2, unresolvedDecisions: 1 },
    readiness: { state: 'at_risk', completedChecks: 4, totalChecks: 5 },
    lifecycle: { state: 'active', currentStage: 'development' },
    run: { state: 'running', run: entity('run', 'run-1') },
    release: { state: 'not_started' },
    state: state(),
    actions: [action()],
    projectedAt: NOW,
  };
}

function executionReceipt() {
  return {
    schemaVersion: MISSION_CONTRACT_VERSIONS.executionReceipt,
    workspaceId: 'ws-mission',
    spec: entity('spec', 'spec-1', { kind: 'spec_version', value: '12' }),
    specHash: HASH,
    effectiveOptions: {
      agent: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      mode: 'parallel',
      parallelism: 4,
      storyIds: ['US-001'],
      worktree: { enabled: true },
      merge: { strategy: 'branch-only', autoMerge: false },
    },
    scheduling: 'queue',
    previewHash: PREVIEW_HASH,
    idempotencyKey: 'mission:execute:spec-1:12',
    returnedEntity: entity('run', 'run-1'),
    acceptedAt: NOW,
  };
}

function runControl() {
  return {
    schemaVersion: MISSION_CONTRACT_VERSIONS.runControlProjection,
    workspaceId: 'ws-mission',
    run: entity('run', 'run-1'),
    mission: entity('mission', 'mission-1', { kind: 'version', value: '7' }),
    spec: entity('spec', 'spec-1', { kind: 'spec_version', value: '12' }),
    stories: [entity('story', 'US-001')],
    state: state(),
    waves: [{
      waveId: 'wave-1',
      label: 'Wave 1',
      ordinal: 0,
      state: state(),
      lanes: [{
        laneId: 'lane-1',
        label: 'Implementation',
        agent: 'codex',
        model: 'gpt-5.6-sol',
        story: entity('story', 'US-001'),
        state: state(),
        startedAt: NOW,
      }],
    }],
    costTokens: {
      currency: 'USD',
      estimatedCost: 2.5,
      actualCost: null,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    },
    evidenceFreshness: {
      state: 'fresh',
      observedAt: NOW,
      newestEvidenceAt: NOW,
      staleAfterSeconds: 3600,
      evidenceCount: 3,
    },
    permittedActions: [action().permittedAction],
    projectedAt: NOW,
  };
}

describe('mission contract parity constants', () => {
  it('pins every version and closed enum set', () => {
    expect(MISSION_CONTRACT_VERSIONS).toEqual({
      entityRef: 'rorca.entity-ref.v1',
      operationalStatePacket: 'rorca.operational-state-packet.v1',
      actionEnvelope: 'rorca.action-envelope.v1',
      deliveryCaseSummary: 'rorca.delivery-case-summary.v2',
      returnContext: 'rorca.return-context.v1',
      executionReceipt: 'rorca.execution-receipt.v1',
      runControlProjection: 'rorca.run-control-projection.v1',
    });
    expect(ENTITY_KINDS).toEqual(['workspace', 'mission', 'spec', 'story', 'run', 'attempt', 'process', 'phase', 'gate', 'evidence', 'decision', 'commit', 'bundle', 'knowledge', 'insight']);
    expect(REVISION_KINDS).toEqual(['spec_version', 'snapshot', 'commit_sha', 'artifact_digest', 'deployment_id', 'version']);
    expect(OUTCOME_STATES).toEqual(['unknown', 'not_available', 'pending', 'partial', 'succeeded', 'failed', 'cancelled']);
    expect(LIVENESS_STATES).toEqual(['unknown', 'not_started', 'queued', 'running', 'paused', 'stalled', 'completed']);
    expect(RISK_STATES).toEqual(['unknown', 'none', 'low', 'medium', 'high', 'critical']);
    expect(CONFIDENCE_STATES).toEqual(['unknown', 'low', 'medium', 'high']);
    expect(FRESHNESS_STATES).toEqual(['unknown', 'fresh', 'aging', 'stale']);
    expect(AUTHORITY_STATES).toEqual(['unknown', 'authoritative', 'derived', 'reported', 'unverified']);
    expect(ACTION_PRIORITIES).toEqual(['safety', 'decision', 'blocked', 'ready', 'informational']);
    expect(ACTION_AUTHORITIES).toEqual(['user', 'workspace_admin', 'mission_owner', 'reviewer', 'system']);
    expect(STATE_SOURCE_KINDS).toEqual(['backend', 'database', 'worker', 'provider', 'operator', 'derived']);
    expect(OWNER_KINDS).toEqual(['user', 'team', 'system', 'unassigned']);
    expect(DELIVERY_STAGES).toEqual(['planning', 'requirements', 'design', 'development', 'testing', 'deployment', 'maintenance']);
    expect(REVIEW_PROJECTION_STATES).toEqual(['unknown', 'not_required', 'pending', 'in_review', 'approved', 'changes_requested']);
    expect(READINESS_PROJECTION_STATES).toEqual(['unknown', 'not_ready', 'at_risk', 'ready']);
    expect(LIFECYCLE_PROJECTION_STATES).toEqual(['unknown', 'draft', 'active', 'paused', 'completed', 'cancelled']);
    expect(RUN_PROJECTION_STATES).toEqual(['unknown', 'not_scheduled', 'queued', 'running', 'blocked', 'completed', 'failed', 'cancelled']);
    expect(RELEASE_PROJECTION_STATES).toEqual(['unknown', 'not_started', 'preparing', 'ready', 'released', 'failed', 'rolled_back']);
    expect(EXECUTION_MODES).toEqual(['sequential', 'parallel']);
    expect(MERGE_STRATEGIES).toEqual(['branch-only', 'draft-pr', 'direct']);
    expect(EXECUTION_EFFORTS).toEqual(['low', 'medium', 'high']);
    expect(PERMITTED_ACTION_KINDS).not.toContain('request');
    expect(EXECUTION_SCHEDULING).toEqual(['run', 'queue']);
  });
});

describe('EntityRefV1', () => {
  it('accepts exact, versioned identity and a non-recursive parent', () => {
    const fixture = {
      ...entity('story', 'US-001', { kind: 'snapshot', value: 'story-snapshot-1' }),
      parent: {
        workspaceId: 'ws-mission',
        kind: 'spec',
        id: 'spec-1',
        revision: { kind: 'spec_version', value: '12' },
        label: 'Spec 1',
      },
    };
    expect(EntityRefV1Schema.parse(fixture)).toEqual(fixture);
  });

  it('rejects unknown kinds, nested parents, and unknown fields', () => {
    expect(EntityRefV1Schema.safeParse({ ...entity('run', 'run-1'), kind: 'queue' }).success).toBe(false);
    expect(EntityRefV1Schema.safeParse({ ...entity('run', 'run-1'), clientStatus: 'healthy' }).success).toBe(false);
    expect(EntityRefV1Schema.safeParse({
      ...entity('story', 'US-001'),
      parent: { workspaceId: 'ws-mission', kind: 'spec', id: 'spec-1', label: 'Spec', parent: entity('mission', 'mission-1') },
    }).success).toBe(false);
  });
});

describe('OperationalStatePacketV1', () => {
  it('accepts separate semantic channels including explicit unknown', () => {
    expect(OperationalStatePacketV1Schema.safeParse(state()).success).toBe(true);
    expect(OperationalStatePacketV1Schema.safeParse({
      ...state(), outcome: 'unknown', liveness: 'unknown', risk: 'unknown', confidence: 'unknown', freshness: 'unknown', authority: 'unknown',
    }).success).toBe(true);
  });

  it.each(['outcome', 'liveness', 'risk', 'confidence', 'freshness', 'authority'] as const)(
    'rejects healthy as an overloaded %s state',
    (channel) => expect(OperationalStatePacketV1Schema.safeParse({ ...state(), [channel]: 'healthy' }).success).toBe(false),
  );

  it('rejects a generic overloaded status and incomplete blockers', () => {
    expect(OperationalStatePacketV1Schema.safeParse({ ...state(), status: 'running' }).success).toBe(false);
    expect(OperationalStatePacketV1Schema.safeParse({ ...state(), blocker: { code: 'BLOCKED', message: 'No authority' } }).success).toBe(false);
  });
});

describe('ActionEnvelopeV1', () => {
  it('accepts only a closed server-authored permitted action descriptor', () => {
    expect(ActionEnvelopeV1Schema.safeParse(action()).success).toBe(true);
  });

  it('rejects arbitrary client method/url actions and mismatched action ids', () => {
    const arbitrary = {
      ...action(),
      permittedAction: { actionId: 'view-run', method: 'DELETE', url: 'https://attacker.example/run/1' },
    };
    expect(ActionEnvelopeV1Schema.safeParse(arbitrary).success).toBe(false);
    expect(ActionEnvelopeV1Schema.safeParse({
      ...action(), permittedAction: { ...action().permittedAction, actionId: 'delete-anything' },
    }).success).toBe(false);
    expect(ActionEnvelopeV1Schema.safeParse({
      ...action(), permittedAction: { ...action().permittedAction, href: 'https://attacker.example/run/1' },
    }).success).toBe(false);
  });
});

describe('DeliveryCaseSummaryV1', () => {
  it('accepts the seven-stage read projection with exact mission/spec revisions', () => {
    expect(DeliveryCaseSummaryV1Schema.safeParse(deliveryCase()).success).toBe(true);
  });

  it('rejects missing stages, workflow transitions, missing revisions, and unbounded actions', () => {
    const missingStage = deliveryCase();
    delete (missingStage.stages as Partial<typeof missingStage.stages>).maintenance;
    expect(DeliveryCaseSummaryV1Schema.safeParse(missingStage).success).toBe(false);
    expect(DeliveryCaseSummaryV1Schema.safeParse({ ...deliveryCase(), transitions: [{ from: 'development', to: 'testing' }] }).success).toBe(false);
    expect(DeliveryCaseSummaryV1Schema.safeParse({ ...deliveryCase(), spec: entity('spec', 'spec-1') }).success).toBe(false);
    expect(DeliveryCaseSummaryV1Schema.safeParse({ ...deliveryCase(), actions: Array.from({ length: 13 }, action) }).success).toBe(false);
  });
});

describe('ReturnContextV1', () => {
  it('accepts bounded internal navigation context', () => {
    expect(ReturnContextV1Schema.parse({
      schemaVersion: MISSION_CONTRACT_VERSIONS.returnContext,
      path: '/missions/mission-1',
      search: '?tab=evidence',
      focus: 'gate:release',
      lens: 'operator',
    }).path).toBe('/missions/mission-1');
  });

  it.each([
    'https://attacker.example/steal',
    '//attacker.example/steal',
    '/missions/../settings',
    '/missions/mission-1?returnTo=/admin',
  ])('rejects external, traversing, or overloaded path %s', (path) => {
    expect(ReturnContextV1Schema.safeParse({ schemaVersion: MISSION_CONTRACT_VERSIONS.returnContext, path }).success).toBe(false);
  });

  it.each(['?returnTo=/admin', '?return_to=https://attacker.example', '?next=x%26returnTo%3D%2Fadmin'])(
    'rejects nested return context %s',
    (search) => expect(ReturnContextV1Schema.safeParse({
      schemaVersion: MISSION_CONTRACT_VERSIONS.returnContext, path: '/missions/mission-1', search,
    }).success).toBe(false),
  );

  it('rejects oversized context values', () => {
    expect(ReturnContextV1Schema.safeParse({
      schemaVersion: MISSION_CONTRACT_VERSIONS.returnContext, path: `/${'a'.repeat(512)}`,
    }).success).toBe(false);
    expect(ReturnContextV1Schema.safeParse({
      schemaVersion: MISSION_CONTRACT_VERSIONS.returnContext, path: '/missions', focus: 'a'.repeat(121),
    }).success).toBe(false);
  });
});

describe('ExecutionReceiptV1', () => {
  it('accepts an exact revision/hash and backend-effective scheduling receipt', () => {
    expect(ExecutionReceiptV1Schema.safeParse(executionReceipt()).success).toBe(true);
  });

  it('rejects missing exact revision, invalid hashes, unknown options, and non-run returns', () => {
    expect(ExecutionReceiptV1Schema.safeParse({ ...executionReceipt(), spec: entity('spec', 'spec-1') }).success).toBe(false);
    expect(ExecutionReceiptV1Schema.safeParse({ ...executionReceipt(), previewHash: 'latest' }).success).toBe(false);
    expect(ExecutionReceiptV1Schema.safeParse({
      ...executionReceipt(), effectiveOptions: { ...executionReceipt().effectiveOptions, arbitraryCommand: 'rm -rf /' },
    }).success).toBe(false);
    expect(ExecutionReceiptV1Schema.safeParse({ ...executionReceipt(), returnedEntity: entity('bundle', 'queue-1') }).success).toBe(false);
  });
});

describe('RunControlProjectionV1', () => {
  it('accepts semantic run state, waves/lanes, cost/tokens, evidence freshness, and permitted actions', () => {
    expect(RunControlProjectionV1Schema.safeParse(runControl()).success).toBe(true);
  });

  it('rejects overloaded status, wrong entity kinds, token inconsistency, and arbitrary controls', () => {
    expect(RunControlProjectionV1Schema.safeParse({ ...runControl(), status: 'healthy' }).success).toBe(false);
    expect(RunControlProjectionV1Schema.safeParse({ ...runControl(), run: entity('mission', 'mission-1') }).success).toBe(false);
    expect(RunControlProjectionV1Schema.safeParse({
      ...runControl(), costTokens: { ...runControl().costTokens, totalTokens: 151 },
    }).success).toBe(false);
    expect(RunControlProjectionV1Schema.safeParse({
      ...runControl(), permittedActions: [{ method: 'POST', url: '/api/run/cancel' }],
    }).success).toBe(false);
  });
});
