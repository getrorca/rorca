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
  BUNDLE_SECTIONS,
  isExcludedCandidateStatus,
  shouldExcludeItem,
  composeWithApprovedCandidates,
  createEmptyBundle,
  adaptFromContextSummary,
  adaptToContextSummary,
  type BundleItem,
  type ContextBundleSection,
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

  const makeItem = (source: string, ref: string, trust: string, overrides: Record<string, unknown> = {}) => ({
    content: `item from ${source}`,
    provenance: { source, ref, trust, ...overrides },
  });

  // ── Required field validation ──────────────────────────────────────────

  it('rejects a bundle missing schemaVersion', () => {
    const { schemaVersion: _, ...rest } = valid;
    expect(specContextBundle.safeParse(rest).success).toBe(false);
  });

  it('rejects a bundle with wrong schemaVersion', () => {
    expect(specContextBundle.safeParse({ ...valid, schemaVersion: 'v2' }).success).toBe(false);
  });

  it('rejects a bundle missing workspaceId', () => {
    const { workspaceId: _, ...rest } = valid;
    expect(specContextBundle.safeParse(rest).success).toBe(false);
  });

  it('rejects a malformed workspaceId', () => {
    expect(specContextBundle.safeParse({ ...valid, workspaceId: '../x' }).success).toBe(false);
    expect(specContextBundle.safeParse({ ...valid, workspaceId: '' }).success).toBe(false);
  });

  it('rejects a bundle missing briefHash', () => {
    const { briefHash: _, ...rest } = valid;
    expect(specContextBundle.safeParse(rest).success).toBe(false);
  });

  it('rejects a bundle missing createdAt', () => {
    const { createdAt: _, ...rest } = valid;
    expect(specContextBundle.safeParse(rest).success).toBe(false);
  });

  it('rejects a malformed createdAt', () => {
    expect(specContextBundle.safeParse({ ...valid, createdAt: '2026-06-27' }).success).toBe(false);
  });

  // ── Full provenance validation on every item ───────────────────────────

  it('accepts a valid bundle with provenance on every item', () => {
    expect(specContextBundle.safeParse(valid).success).toBe(true);
  });

  it('rejects an item missing provenance', () => {
    expect(
      specContextBundle.safeParse({
        ...valid,
        sections: [{ section: 'memories', items: [{ content: 'no provenance' }] }],
      }).success,
    ).toBe(false);
  });

  it('rejects an item with missing provenance.source', () => {
    const item = { content: 'x', provenance: { ref: 'r1', trust: 'reviewed' } };
    expect(
      specContextBundle.safeParse({
        ...valid,
        sections: [{ section: 'memories', items: [item] }],
      }).success,
    ).toBe(false);
  });

  it('rejects an item with missing provenance.ref', () => {
    const item = { content: 'x', provenance: { source: 'memory', trust: 'reviewed' } };
    expect(
      specContextBundle.safeParse({
        ...valid,
        sections: [{ section: 'memories', items: [item] }],
      }).success,
    ).toBe(false);
  });

  it('rejects an item with missing provenance.trust', () => {
    const item = { content: 'x', provenance: { source: 'memory', ref: 'm1' } };
    expect(
      specContextBundle.safeParse({
        ...valid,
        sections: [{ section: 'memories', items: [item] }],
      }).success,
    ).toBe(false);
  });

  it('rejects an item with invalid provenance.trust', () => {
    expect(
      specContextBundle.safeParse({
        ...valid,
        sections: [{
          section: 'memories',
          items: [makeItem('memory', 'm1', 'super-trusted')],
        }],
      }).success,
    ).toBe(false);
  });

  it('accepts provenance with optional reason and confidence', () => {
    const item = {
      content: 'x',
      provenance: {
        source: 'memory' as const,
        ref: 'm1',
        trust: 'reviewed' as const,
        reason: 'Manually reviewed and approved',
        confidence: 0.95,
      },
    };
    expect(
      specContextBundle.safeParse({
        ...valid,
        sections: [{ section: 'memories', items: [item] }],
      }).success,
    ).toBe(true);
  });

  it('rejects provenance confidence out of 0-1 range', () => {
    const item = makeItem('memory', 'm1', 'reviewed', { confidence: 1.5 });
    expect(
      specContextBundle.safeParse({
        ...valid,
        sections: [{ section: 'memories', items: [item] }],
      }).success,
    ).toBe(false);
  });

  it('accepts provenance with traceId for traceability', () => {
    const item = {
      content: 'x',
      provenance: {
        source: 'source' as const,
        ref: 'src/lib/foo.ts',
        trust: 'derived' as const,
        traceId: 'trace:42:context',
      },
    };
    expect(
      specContextBundle.safeParse({
        ...valid,
        sections: [{ section: 'sourceFiles', items: [item] }],
      }).success,
    ).toBe(true);
  });

  // ── All section types with provenance ──────────────────────────────────

  it.each(BUNDLE_SECTIONS)(
    'accepts section "%s" with valid provenance items',
    (section) => {
      const sourceMap: Record<string, string> = {
        directions: 'direction',
        memories: 'memory',
        docs: 'doc',
        sourceFiles: 'source',
        tests: 'test',
        graphSummary: 'graph',
        branchDiff: 'diff',
        risksGotchas: 'risk',
      };
      const source = sourceMap[section] ?? 'memory';
      const bundle = {
        schemaVersion: 'v1' as const,
        workspaceId: 'ws-1',
        briefHash: 'deadbeef',
        createdAt: '2026-06-27T12:00:00Z',
        sections: [{
          section,
          items: [{ content: 'x', provenance: { source, ref: 'r1', trust: 'reviewed' as const } }],
        }],
      };
      expect(specContextBundle.safeParse(bundle).success).toBe(true);
    },
  );

  it('rejects an unknown section name', () => {
    expect(
      specContextBundle.safeParse({
        ...valid,
        sections: [{ section: 'mystery', items: [] }],
      }).success,
    ).toBe(false);
  });

  // ── Budget metadata on sections ────────────────────────────────────────

  it('accepts a section with tokenBudget and tokensUsed', () => {
    const bundle = {
      schemaVersion: 'v1' as const,
      workspaceId: 'ws-1',
      briefHash: 'deadbeef',
      createdAt: '2026-06-27T12:00:00Z',
      sections: [
        {
          section: 'memories' as const,
          items: [makeItem('memory', 'm1', 'reviewed')],
          tokenBudget: 500,
          tokensUsed: 120,
        },
        {
          section: 'sourceFiles' as const,
          items: [
            makeItem('source', 'src/a.ts', 'derived'),
            makeItem('source', 'src/b.ts', 'derived'),
          ],
          tokenBudget: 2000,
          tokensUsed: 350,
        },
      ],
      totalTokens: 470,
    };
    expect(specContextBundle.safeParse(bundle).success).toBe(true);
  });

  it('rejects negative tokenBudget', () => {
    expect(
      specContextBundle.safeParse({
        ...valid,
        sections: [{
          section: 'memories',
          items: [makeItem('memory', 'm1', 'reviewed')],
          tokenBudget: -1,
        }],
      }).success,
    ).toBe(false);
  });

  it('rejects negative tokensUsed', () => {
    expect(
      specContextBundle.safeParse({
        ...valid,
        sections: [{
          section: 'memories',
          items: [makeItem('memory', 'm1', 'reviewed')],
          tokensUsed: -1,
        }],
      }).success,
    ).toBe(false);
  });

  it('rejects negative totalTokens', () => {
    expect(
      specContextBundle.safeParse({
        ...valid,
        totalTokens: -1,
      }).success,
    ).toBe(false);
  });

  it('accepts a bundle with traceIds and degraded flag', () => {
    const bundle = {
      ...valid,
      traceIds: ['trace:1:context', 'trace:1:memory'],
      degraded: true,
    };
    expect(specContextBundle.safeParse(bundle).success).toBe(true);
  });

  it('accepts optional gitSha for hydration freshness', () => {
    expect(specContextBundle.safeParse({ ...valid, gitSha: 'abc1234' }).success).toBe(true);
    expect(specContextBundle.safeParse({ ...valid, gitSha: '0'.repeat(40) }).success).toBe(true);
    expect(specContextBundle.safeParse({ ...valid, gitSha: 'bad!hex' }).success).toBe(false);
  });

  // ── Candidate exclusion behavior (US-035 gate) ─────────────────────────

  it('excludeNonApprovedCandidates rejects pending/rejected/duplicate/superseded', () => {
    expect(isExcludedCandidateStatus('pending')).toBe(true);
    expect(isExcludedCandidateStatus('rejected')).toBe(true);
    expect(isExcludedCandidateStatus('duplicate')).toBe(true);
    expect(isExcludedCandidateStatus('superseded')).toBe(true);
    expect(isExcludedCandidateStatus('approved')).toBe(false);
  });

  it('shouldExcludeItem rejects captured and unverified trust items', () => {
    
    const captured: BundleItem = {
      content: 'x',
      provenance: { source: 'memory', ref: 'm1', trust: 'captured' },
    };
    const unverified: BundleItem = {
      content: 'x',
      provenance: { source: 'memory', ref: 'm1', trust: 'unverified' },
    };
    const reviewed: BundleItem = {
      content: 'x',
      provenance: { source: 'memory', ref: 'm1', trust: 'reviewed' },
    };
    expect(shouldExcludeItem(captured)).toBe(true);
    expect(shouldExcludeItem(unverified)).toBe(true);
    expect(shouldExcludeItem(reviewed)).toBe(false);
  });

  // ── Composition with approved candidates ───────────────────────────────

  it('composeWithApprovedCandidates excludes captured/unverified items', () => {
    
    const base = createEmptyBundle('ws-1', 'deadbeef');

    const approved: BundleItem = {
      content: 'approved content',
      provenance: { source: 'memory', ref: 'm1', trust: 'reviewed' },
    };
    const excluded: BundleItem = {
      content: 'excluded content',
      provenance: { source: 'memory', ref: 'm2', trust: 'captured' },
    };

    const result = composeWithApprovedCandidates(base, [
      { item: approved, section: 'memories' as const },
      { item: excluded, section: 'memories' as const },
    ]);

    expect(result.sections.length).toBeGreaterThanOrEqual(1);
    const memSection = result.sections.find((s: ContextBundleSection) => s.section === 'memories')!;
    expect(memSection.items.length).toBe(1);
    expect(memSection.items[0].content).toBe('approved content');
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it('composeWithApprovedCandidates adds new sections', () => {
    
    const base = createEmptyBundle('ws-1', 'deadbeef');

    const item: BundleItem = {
      content: 'test file content',
      provenance: { source: 'test', ref: 'src/__tests__/foo.test.ts', trust: 'derived' },
    };

    const result = composeWithApprovedCandidates(base, [
      { item, section: 'tests' as const },
    ]);

    const testSection = result.sections.find((s: ContextBundleSection) => s.section === 'tests')!;
    expect(testSection.items.length).toBe(1);
    expect(testSection.tokensUsed).toBeGreaterThan(0);
  });

  it('composeWithApprovedCandidates appends traceIds from item provenance', () => {
    
    const base = createEmptyBundle('ws-1', 'deadbeef');

    const item: BundleItem = {
      content: 'x',
      provenance: { source: 'memory', ref: 'm1', trust: 'reviewed', traceId: 'trace:42:context' },
    };

    const result = composeWithApprovedCandidates(base, [
      { item, section: 'memories' as const },
    ]);

    expect(result.traceIds).toBeDefined();
    expect(result.traceIds!.length).toBe(1);
    expect(result.traceIds![0]).toBe('trace:42:context');
  });

  // ── Empty bundle factory ───────────────────────────────────────────────

  it('createEmptyBundle returns a valid bundle with all 8 sections empty', () => {
    
    const bundle = createEmptyBundle('ws-1', 'deadbeef');

    expect(specContextBundle.safeParse(bundle).success).toBe(true);
    expect(bundle.sections.length).toBe(8);
    expect(bundle.totalTokens).toBe(0);
    expect(bundle.degraded).toBe(false);

    for (const section of bundle.sections) {
      expect(section.items).toHaveLength(0);
      expect(section.tokenBudget).toBe(0);
      expect(section.tokensUsed).toBe(0);
    }
  });

  it('createEmptyBundle stamps workspaceId, briefHash, and createdAt', () => {
    
    const bundle = createEmptyBundle('ws-test', 'hash123', 'abc1234');

    expect(bundle.workspaceId).toBe('ws-test');
    expect(bundle.briefHash).toBe('hash123');
    expect(bundle.gitSha).toBe('abc1234');
    expect(bundle.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // ── Adaptation: context_summary_json ↔ SpecContextBundle ───────────────

  it('adaptFromContextSummary maps direction layers into directions section', () => {
    
    const summary = {
      directionLayers: {
        l1: 'Use async/await for all DB calls',
        l2: null,
        l3: 'Project: Rorca — spec orchestration platform',
      },
      skills: ['excalidraw-diagram', 'rorca-approve'],
      estimatedTokens: 5000,
    };

    const bundle = adaptFromContextSummary(summary, 'ws-1', 'deadbeef');
    expect(specContextBundle.safeParse(bundle).success).toBe(true);

    const dirSection = bundle.sections.find((s) => s.section === 'directions');
    expect(dirSection).toBeDefined();
    expect(dirSection!.items.length).toBe(2); // l1 + l3
    expect(dirSection!.items[0].provenance.source).toBe('direction');
    expect(dirSection!.items[0].provenance.trust).toBe('authoritative');
    expect(dirSection!.items[0].provenance.confidence).toBe(1.0);
  });

  it('adaptFromContextSummary maps skills into memories section', () => {
    
    const summary = {
      skills: ['excalidraw-diagram', 'rorca-approve'],
    };

    const bundle = adaptFromContextSummary(summary, 'ws-1', 'deadbeef');
    const memSection = bundle.sections.find((s) => s.section === 'memories');
    expect(memSection).toBeDefined();
    expect(memSection!.items.length).toBe(2);
    expect(memSection!.items[0].content).toContain('excalidraw-diagram');
    expect(memSection!.items[0].provenance.source).toBe('memory');
  });

  it('adaptFromContextSummary handles null/undefined summary gracefully', () => {
    

    const nullBundle = adaptFromContextSummary(null, 'ws-1', 'deadbeef');
    expect(specContextBundle.safeParse(nullBundle).success).toBe(true);
    expect(nullBundle.sections.length).toBe(0);
    expect(nullBundle.totalTokens).toBe(0);

    const undefinedBundle = adaptFromContextSummary(undefined, 'ws-1', 'deadbeef');
    expect(specContextBundle.safeParse(undefinedBundle).success).toBe(true);
  });

  it('adaptFromContextSummary sets degraded when estimatedTokens exceeds model window', () => {
    
    const summary = {
      estimatedTokens: 300_000,
      modelContextWindow: 200_000,
    };
    const bundle = adaptFromContextSummary(summary, 'ws-1', 'deadbeef');
    expect(bundle.degraded).toBe(true);
  });

  it('adaptToContextSummary round-trips basic direction and skills', () => {
    
    const summary = {
      directionLayers: {
        l1: 'Direction L1: Global Standards',
        l2: null,
        l3: 'Direction L3: Project Context',
      },
      skills: ['excalidraw-diagram', 'rorca-approve'],
      estimatedTokens: 5000,
    };

    const bundle = adaptFromContextSummary(summary, 'ws-1', 'deadbeef');
    const rtSummary = adaptToContextSummary(bundle);

    expect(rtSummary.directionLayers?.l1).toBe(summary.directionLayers.l1);
    expect(rtSummary.directionLayers?.l3).toBe(summary.directionLayers.l3);
    expect(rtSummary.skills).toEqual(summary.skills);
  });

  it('adaptFromContextSummary tolerates empty summary (no directionLayers, no skills)', () => {
    
    const bundle = adaptFromContextSummary({}, 'ws-1', 'deadbeef');
    expect(specContextBundle.safeParse(bundle).success).toBe(true);
    expect(bundle.sections.length).toBe(0);
  });

  it('adaptFromContextSummary tolerates extra unknown keys (forward compat)', () => {
    
    const summary = {
      directionLayers: { l1: 'Some direction' },
      futureFeatureFlag: true,
      unknownNested: { nested: 'value' },
    };
    const bundle = adaptFromContextSummary(summary, 'ws-1', 'deadbeef');
    expect(specContextBundle.safeParse(bundle).success).toBe(true);
    expect(bundle.sections.length).toBe(1); // only directions
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
