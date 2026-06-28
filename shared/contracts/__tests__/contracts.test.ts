import { describe, it, expect } from 'vitest';
import {
  // version
  CONTEXT_CONTRACTS_VERSION,
  CONTRACT_VERSIONS,
  schemaVersionField,
  // primitives
  workspaceId,
  reviewStatus,
  confidence,
  idempotencyKey,
  gitSha,
  isoTimestamp,
  repoRelativePath,
  graphMode,
  // trust
  trustTier,
  TRUST_TIERS,
  TRUST_TIER_WEIGHT,
  trustTierRank,
  // graph
  graphFileNode,
  graphEdge,
  graphMetadata,
  // hydration
  hydrationRecord,
  // retrieval
  retrievalCandidate,
  retrievalTrace,
  // context bundle
  specContextBundle,
  // context events
  contextEvent,
  // memory candidates
  memoryCandidate,
  // review
  reviewAction,
  reviewActionRequest,
  REVIEW_ACTION_RESULT,
} from '../index';

// ─── Primitives the AC calls out explicitly ──────────────────────────────────

describe('workspaceId', () => {
  it.each(['ws-1', 'rorca-feat-context-intelligence-US-002', 'A1_b-2', 'w'])(
    'accepts %s',
    (id) => expect(workspaceId.safeParse(id).success).toBe(true),
  );

  it.each([
    '', // empty
    '../etc/passwd', // traversal
    'a/b', // slash
    'has space', // whitespace
    '-leading', // leading separator
    '.hidden', // leading dot
    'with.dot', // dots disallowed
    'a'.repeat(201), // too long
  ])('rejects malformed %s', (id) => expect(workspaceId.safeParse(id).success).toBe(false));
});

describe('reviewStatus', () => {
  it.each(['pending', 'approved', 'rejected', 'duplicate', 'superseded'])(
    'accepts %s',
    (s) => expect(reviewStatus.safeParse(s).success).toBe(true),
  );

  it.each(['revisit', 'bogus', 'PENDING', '', 'approve'])('rejects %s', (s) =>
    expect(reviewStatus.safeParse(s).success).toBe(false),
  );
});

describe('confidence', () => {
  it.each([0, 0.5, 1])('accepts %s', (c) => expect(confidence.safeParse(c).success).toBe(true));

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects out-of-range %s',
    (c) => expect(confidence.safeParse(c).success).toBe(false),
  );

  it('rejects non-numbers', () => {
    expect(confidence.safeParse('high').success).toBe(false);
    expect(confidence.safeParse(null).success).toBe(false);
  });
});

describe('idempotencyKey', () => {
  it.each(['spec-post-save-v1:ws-1:spec-retry:1', 'cap:ws-1:abc123', 'a1234567'])(
    'accepts %s',
    (k) => expect(idempotencyKey.safeParse(k).success).toBe(true),
  );

  it.each([
    '', // empty
    'short', // < 8 chars
    'has space here', // whitespace
    'cap/ws-1/abc', // slash
    ':leading-colon-key', // leading separator
  ])('rejects %s', (k) => expect(idempotencyKey.safeParse(k).success).toBe(false));
});

describe('supporting primitives', () => {
  it('gitSha accepts short and full hex, rejects non-hex', () => {
    expect(gitSha.safeParse('abc1234').success).toBe(true);
    expect(gitSha.safeParse('0'.repeat(40)).success).toBe(true);
    expect(gitSha.safeParse('XYZ').success).toBe(false);
    expect(gitSha.safeParse('abc').success).toBe(false); // too short
  });

  it('isoTimestamp requires a timezone', () => {
    expect(isoTimestamp.safeParse('2026-06-27T12:00:00Z').success).toBe(true);
    expect(isoTimestamp.safeParse('2026-06-27T12:00:00+02:00').success).toBe(true);
    expect(isoTimestamp.safeParse('2026-06-27 12:00:00').success).toBe(false);
    expect(isoTimestamp.safeParse('not-a-date').success).toBe(false);
  });

  it('repoRelativePath rejects absolute and traversal paths', () => {
    expect(repoRelativePath.safeParse('src/lib/x.ts').success).toBe(true);
    expect(repoRelativePath.safeParse('/etc/passwd').success).toBe(false);
    expect(repoRelativePath.safeParse('src/../../../etc').success).toBe(false);
  });

  it('graphMode is a closed set', () => {
    expect(graphMode.safeParse('full').success).toBe(true);
    expect(graphMode.safeParse('lite').success).toBe(true);
    expect(graphMode.safeParse('disabled').success).toBe(true);
    expect(graphMode.safeParse('off').success).toBe(false);
  });
});

// ─── Trust tiers ──────────────────────────────────────────────────────────────

describe('trust tiers', () => {
  it('accepts every declared tier and rejects unknowns', () => {
    for (const tier of TRUST_TIERS) expect(trustTier.safeParse(tier).success).toBe(true);
    expect(trustTier.safeParse('trusted').success).toBe(false);
  });

  it('orders weights from authoritative (1) to unverified (lowest)', () => {
    expect(TRUST_TIER_WEIGHT.authoritative).toBe(1.0);
    expect(TRUST_TIER_WEIGHT.unverified).toBeLessThan(TRUST_TIER_WEIGHT.authoritative);
    expect(trustTierRank('authoritative')).toBe(0);
    expect(trustTierRank('unverified')).toBe(TRUST_TIERS.length - 1);
  });
});

// ─── Schema versioning ──────────────────────────────────────────────────────

describe('schema versioning', () => {
  it('exposes umbrella + per-contract versions', () => {
    expect(CONTEXT_CONTRACTS_VERSION).toBe('v1');
    expect(CONTRACT_VERSIONS.hydration).toBe('v1');
    expect(CONTRACT_VERSIONS.reviewAction).toBe('v1');
  });

  it('schemaVersionField accepts the exact version and rejects others', () => {
    const field = schemaVersionField('v1');
    expect(field.safeParse('v1').success).toBe(true);
    expect(field.safeParse('v2').success).toBe(false);
    expect(field.safeParse(undefined).success).toBe(false);
  });
});

// ─── Top-level contracts: valid + invalid payloads ────────────────────────────

describe('graph metadata contracts', () => {
  it('accepts a valid file node, edge, and metadata', () => {
    expect(graphFileNode.safeParse({ schemaVersion: 'v1', path: 'src/index.ts', role: 'source' }).success).toBe(true);
    expect(
      graphEdge.safeParse({ schemaVersion: 'v1', from: 'a.ts', to: 'b.ts', relation: 'imports' }).success,
    ).toBe(true);
    expect(
      graphMetadata.safeParse({
        schemaVersion: 'v1',
        workspaceId: 'ws-1',
        gitSha: 'abc1234',
        generatedAt: '2026-06-27T12:00:00Z',
        nodeCount: 2,
        edgeCount: 1,
      }).success,
    ).toBe(true);
  });

  it('applies count defaults on file nodes', () => {
    const parsed = graphFileNode.parse({ schemaVersion: 'v1', path: 'a.ts', role: 'source' });
    expect(parsed.importsCount).toBe(0);
    expect(parsed.testedByCount).toBe(0);
  });

  it('rejects an unknown relation and a bad version', () => {
    expect(graphEdge.safeParse({ schemaVersion: 'v1', from: 'a', to: 'b', relation: 'calls' }).success).toBe(false);
    expect(graphFileNode.safeParse({ schemaVersion: 'v2', path: 'a.ts', role: 'source' }).success).toBe(false);
  });
});

describe('hydrationRecord', () => {
  it('accepts a valid record', () => {
    expect(
      hydrationRecord.safeParse({
        schemaVersion: 'v1',
        workspaceId: 'ws-1',
        status: 'succeeded',
        gitSha: 'abc1234',
        nodeCount: 10,
        durationMs: 1200,
      }).success,
    ).toBe(true);
  });

  it('rejects an invalid status and a malformed workspace id', () => {
    expect(
      hydrationRecord.safeParse({ schemaVersion: 'v1', workspaceId: 'ws-1', status: 'done', gitSha: 'abc1234' })
        .success,
    ).toBe(false);
    expect(
      hydrationRecord.safeParse({ schemaVersion: 'v1', workspaceId: '../x', status: 'pending', gitSha: 'abc1234' })
        .success,
    ).toBe(false);
  });
});

describe('retrieval contracts', () => {
  const candidate = {
    schemaVersion: 'v1',
    id: 'c1',
    kind: 'file',
    ref: 'src/x.ts',
    score: 0.82,
    breakdown: { semantic: 0.5, graphDistance: 0.2, trustAuthority: 0.12 },
    trust: 'derived',
  };

  it('accepts a candidate with an explainable breakdown', () => {
    expect(retrievalCandidate.safeParse(candidate).success).toBe(true);
  });

  it('rejects an out-of-range score', () => {
    expect(retrievalCandidate.safeParse({ ...candidate, score: 1.4 }).success).toBe(false);
  });

  it('accepts a replayable trace and rejects one with a bad candidate', () => {
    expect(
      retrievalTrace.safeParse({
        schemaVersion: 'v1',
        traceId: 't1',
        workspaceId: 'ws-1',
        briefHash: 'deadbeef',
        createdAt: '2026-06-27T12:00:00Z',
        graphMode: 'lite',
        degraded: true,
        candidates: [candidate],
      }).success,
    ).toBe(true);

    expect(
      retrievalTrace.safeParse({
        schemaVersion: 'v1',
        traceId: 't1',
        workspaceId: 'ws-1',
        briefHash: 'deadbeef',
        createdAt: '2026-06-27T12:00:00Z',
        candidates: [{ ...candidate, trust: 'super-trusted' }],
      }).success,
    ).toBe(false);
  });
});

describe('specContextBundle', () => {
  const valid = {
    schemaVersion: 'v1',
    workspaceId: 'ws-1',
    briefHash: 'deadbeef',
    createdAt: '2026-06-27T12:00:00Z',
    sections: [
      {
        section: 'memories',
        items: [{ content: 'a reviewed memory', provenance: { source: 'memory', ref: 'm1', trust: 'reviewed' } }],
      },
    ],
  };

  it('accepts a valid bundle with provenance on every item', () => {
    expect(specContextBundle.safeParse(valid).success).toBe(true);
  });

  it('rejects an item missing provenance and an unknown section', () => {
    expect(
      specContextBundle.safeParse({
        ...valid,
        sections: [{ section: 'memories', items: [{ content: 'no provenance' }] }],
      }).success,
    ).toBe(false);
    expect(
      specContextBundle.safeParse({
        ...valid,
        sections: [{ section: 'mystery', items: [] }],
      }).success,
    ).toBe(false);
  });
});

describe('contextEvent', () => {
  it('accepts a valid, idempotency-keyed event', () => {
    expect(
      contextEvent.safeParse({
        schemaVersion: 'v1',
        idempotencyKey: 'cap:ws-1:abc123',
        workspaceId: 'ws-1',
        kind: 'commit',
        source: 'rorca-capture',
        payload: { sha: 'abc1234', message: 'fix' },
        occurredAt: '2026-06-27T12:00:00Z',
      }).success,
    ).toBe(true);
  });

  it('rejects a malformed idempotency key and an unknown kind', () => {
    expect(
      contextEvent.safeParse({
        schemaVersion: 'v1',
        idempotencyKey: 'bad key',
        workspaceId: 'ws-1',
        kind: 'commit',
        source: 'rorca-capture',
        payload: {},
        occurredAt: '2026-06-27T12:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      contextEvent.safeParse({
        schemaVersion: 'v1',
        idempotencyKey: 'cap:ws-1:abc123',
        workspaceId: 'ws-1',
        kind: 'tweet',
        source: 'rorca-capture',
        payload: {},
        occurredAt: '2026-06-27T12:00:00Z',
      }).success,
    ).toBe(false);
  });
});

describe('memoryCandidate', () => {
  it('accepts a valid pending candidate', () => {
    expect(
      memoryCandidate.safeParse({
        schemaVersion: 'v1',
        idempotencyKey: 'cap:ws-1:abc123',
        workspaceId: 'ws-1',
        status: 'pending',
        title: 'Use numbered placeholders',
        body: 'Always use $1,$2 in pg queries.',
        trust: 'captured',
        relatedFiles: ['backend/src/db/index.ts'],
        createdAt: '2026-06-27T12:00:00Z',
      }).success,
    ).toBe(true);
  });

  it('rejects an invalid status and an absolute relatedFiles path', () => {
    expect(
      memoryCandidate.safeParse({
        schemaVersion: 'v1',
        idempotencyKey: 'cap:ws-1:abc123',
        workspaceId: 'ws-1',
        status: 'revisit',
        title: 'x',
        body: 'y',
        trust: 'captured',
        createdAt: '2026-06-27T12:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      memoryCandidate.safeParse({
        schemaVersion: 'v1',
        idempotencyKey: 'cap:ws-1:abc123',
        workspaceId: 'ws-1',
        status: 'pending',
        title: 'x',
        body: 'y',
        trust: 'captured',
        relatedFiles: ['/etc/passwd'],
        createdAt: '2026-06-27T12:00:00Z',
      }).success,
    ).toBe(false);
  });
});

describe('review actions', () => {
  it('maps every action to a resulting status', () => {
    for (const action of reviewAction.options) {
      expect(REVIEW_ACTION_RESULT[action]).toBeDefined();
    }
    expect(REVIEW_ACTION_RESULT.approve).toBe('approved');
    expect(REVIEW_ACTION_RESULT.edit_and_approve).toBe('approved');
    expect(REVIEW_ACTION_RESULT.revisit).toBe('pending');
  });

  it('accepts a plain approve', () => {
    expect(reviewActionRequest.safeParse({ schemaVersion: 'v1', candidateId: 'c1', action: 'approve' }).success).toBe(
      true,
    );
  });

  it('requires targetId for duplicate/supersede', () => {
    expect(reviewActionRequest.safeParse({ schemaVersion: 'v1', candidateId: 'c1', action: 'duplicate' }).success).toBe(
      false,
    );
    expect(
      reviewActionRequest.safeParse({ schemaVersion: 'v1', candidateId: 'c1', action: 'supersede', targetId: 'c2' })
        .success,
    ).toBe(true);
  });

  it('requires edits for edit_and_approve', () => {
    expect(
      reviewActionRequest.safeParse({ schemaVersion: 'v1', candidateId: 'c1', action: 'edit_and_approve' }).success,
    ).toBe(false);
    expect(
      reviewActionRequest.safeParse({
        schemaVersion: 'v1',
        candidateId: 'c1',
        action: 'edit_and_approve',
        edits: { title: 'better title' },
      }).success,
    ).toBe(true);
  });
});
