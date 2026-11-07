import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as backend from '../../../backend/src/lib/source-contracts';
import {
  deriveSourceBundleHash,
  INTENT_DISPOSITIONS,
  INTENT_PERMITTED_ACTIONS,
  IntentDispositionKindV1Schema,
  IntentDispositionV1Schema,
  IntentPermittedActionV1Schema,
  SOURCE_AUTHORITIES,
  SOURCE_CONTRACT_VERSIONS,
  SOURCE_KINDS,
  SOURCE_REVIEW_STATUSES,
  SOURCE_SENSITIVITIES,
  SourceAuthorityV1Schema,
  SourceBundleV1Schema,
  SourceKindV1Schema,
  SourceReviewStatusV1Schema,
  SourceSensitivityV1Schema,
  type SourceBundleHashInput,
  type SourceBundleV1,
} from '../source';
import { MISSION_CONTRACT_VERSIONS } from '../mission';

const NOW = '2026-08-06T12:00:00Z';
const HASH = `sha256:${'a'.repeat(64)}`;

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).reverse()
      .map(([key, nested]) => [key, reverseObjectKeys(nested)]),
  );
}

function fixture(): SourceBundleV1 {
  const source = {
    schemaVersion: SOURCE_CONTRACT_VERSIONS.sourceRef,
    sourceId: 'source-1',
    kind: 'local_file' as const,
    locator: 'docs/brief.md',
    title: 'Approved brief',
    contentHash: HASH,
    sourceVersion: 'git:abc1234',
    reviewStatus: 'approved' as const,
    sensitivity: 'internal' as const,
    authority: 'user_mandated' as const,
    selectedSections: ['requirements'],
  };
  const citation = {
    schemaVersion: SOURCE_CONTRACT_VERSIONS.sourceCitation,
    citationId: 'citation-1',
    sourceId: source.sourceId,
    section: 'requirements',
    excerptHash: `sha256:${'b'.repeat(64)}`,
    rationale: 'Provides the governing requirement.',
  };
  const input = { userIntent: 'Build source-verified delivery.', includedSources: [source], citations: [citation] };
  return {
    schemaVersion: SOURCE_CONTRACT_VERSIONS.sourceBundle,
    bundleId: 'bundle-1',
    bundleHash: deriveSourceBundleHash(input),
    ...input,
    workspaceRef: {
      schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
      workspaceId: 'ws-source',
      kind: 'workspace',
      id: 'ws-source',
      label: 'Source workspace',
    },
    excludedSources: [], conflicts: [], assumptions: [], truncations: [], compiledAt: NOW,
  };
}

describe('source contract parity', () => {
  it('pins all versions and closed enums in shared and backend mirrors', () => {
    expect(SOURCE_CONTRACT_VERSIONS).toEqual({
      sourceRef: 'rorca.source-ref.v1', sourceBundle: 'rorca.source-bundle.v1',
      sourceCitation: 'rorca.source-citation.v1', sourceConflict: 'rorca.source-conflict.v1',
      contextCompilationReceipt: 'rorca.context-compilation-receipt.v1',
      intentEnvelope: 'rorca.intent-envelope.v1', intentDisposition: 'rorca.intent-disposition.v1',
    });
    expect(SOURCE_KINDS).toEqual(['genesis_package', 'genesis_evidence', 'local_file', 'url', 'github_issue', 'github_pr', 'linear_document', 'rorca_mission', 'inline']);
    expect(SOURCE_REVIEW_STATUSES).toEqual(['approved', 'trusted', 'pending', 'unreviewed', 'external']);
    expect(SOURCE_SENSITIVITIES).toEqual(['public', 'internal', 'confidential', 'restricted']);
    expect(SOURCE_AUTHORITIES).toEqual(['user_mandated', 'approved_context', 'supporting_evidence']);
    const enumContracts = {
      SOURCE_CONTRACT_VERSIONS,
      SOURCE_KINDS,
      SOURCE_REVIEW_STATUSES,
      SOURCE_SENSITIVITIES,
      SOURCE_AUTHORITIES,
      INTENT_DISPOSITIONS,
      INTENT_PERMITTED_ACTIONS,
    };
    for (const key of Object.keys(enumContracts) as Array<keyof typeof enumContracts>) {
      expect(backend[key]).toEqual(enumContracts[key]);
    }

    const closedEnumSchemas = {
      SourceKindV1Schema,
      SourceReviewStatusV1Schema,
      SourceSensitivityV1Schema,
      SourceAuthorityV1Schema,
      IntentDispositionKindV1Schema,
      IntentPermittedActionV1Schema,
    };
    for (const [schemaName, schema] of Object.entries(closedEnumSchemas)) {
      expect(backend[schemaName as keyof typeof backend]).toBeDefined();
      expect((backend[schemaName as keyof typeof backend] as unknown as typeof schema).options).toEqual(schema.options);
      expect(schema.safeParse('__unknown__').success).toBe(false);
    }

    for (const schemaName of [
      'SourceRefV1Schema',
      'SourceBundleV1Schema',
      'SourceCitationV1Schema',
      'SourceConflictV1Schema',
      'ContextCompilationReceiptV1Schema',
      'IntentEnvelopeV1Schema',
      'IntentDispositionV1Schema',
    ] as const) {
      expect(backend[schemaName]).toBeDefined();
    }
  });
});

describe('SourceBundleV1', () => {
  it('accepts a valid bundle and derives a real deterministic sha256 identity', () => {
    const valid = fixture();
    expect(SourceBundleV1Schema.parse(valid)).toEqual(valid);
    expect(backend.SourceBundleV1Schema.parse(valid)).toEqual(valid);
    expect(valid.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const canonicalIdentity = {
      citations: valid.citations,
      includedSources: valid.includedSources,
      selectedSections: valid.includedSources.map(({ sourceId, selectedSections }) => ({ selectedSections, sourceId })),
      userIntent: valid.userIntent,
    };
    const stableJson = (value: unknown): string => {
      if (value === null || typeof value !== 'object') return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
    };
    expect(valid.bundleHash).toBe(`sha256:${createHash('sha256').update(stableJson(canonicalIdentity)).digest('hex')}`);
    expect(deriveSourceBundleHash(valid)).toBe(valid.bundleHash);
    expect(backend.deriveSourceBundleHash(valid)).toBe(valid.bundleHash);
    const reordered = reverseObjectKeys({
      userIntent: valid.userIntent,
      includedSources: valid.includedSources,
      citations: valid.citations,
    }) as SourceBundleHashInput;
    expect(deriveSourceBundleHash(reordered)).toBe(valid.bundleHash);
  });

  it.each([
    ['unknown source kind', (value: any) => { value.includedSources[0].kind = 'web_search'; }],
    ['unknown review status', (value: any) => { value.includedSources[0].reviewStatus = 'reviewed'; }],
    ['unknown sensitivity', (value: any) => { value.includedSources[0].sensitivity = 'secret'; }],
    ['unknown authority', (value: any) => { value.includedSources[0].authority = 'system_generated'; }],
    ['arbitrary source field', (value: any) => { value.includedSources[0].clientStatus = 'approved'; }],
    ['external locator', (value: any) => { value.includedSources[0].locator = 'https://example.test/brief'; }],
    ['protocol-relative external locator', (value: any) => { value.includedSources[0].locator = '//example.test/brief'; }],
    ['nested external locator', (value: any) => { value.includedSources[0].locator = 'captures/https%3A%2F%2Fexample.test/brief'; }],
    ['embedded external locator', (value: any) => { value.includedSources[0].locator = 'captures:https%3Aexample.test/brief'; }],
    ['direct traversing locator', (value: any) => { value.includedSources[0].locator = 'docs/../secrets'; }],
    ['encoded traversing locator', (value: any) => { value.includedSources[0].locator = 'docs/%2e%2e/secrets'; }],
    ['double-encoded traversing locator', (value: any) => { value.includedSources[0].locator = 'docs/%252e%252e/secrets'; }],
    ['non-canonical whitespace locator', (value: any) => { value.includedSources[0].locator = ' docs/brief.md'; }],
    ['home-relative external locator', (value: any) => { value.includedSources[0].locator = '~/outside-workspace/brief.md'; }],
    ['named-home external locator', (value: any) => { value.includedSources[0].locator = '~another-user/outside-workspace/brief.md'; }],
    ['encoded home-relative external locator', (value: any) => { value.includedSources[0].locator = '%7e/outside-workspace/brief.md'; }],
    ['encoded named-home external locator', (value: any) => { value.includedSources[0].locator = '%7eanother-user/outside-workspace/brief.md'; }],
    ['missing included-source content hash', (value: any) => { delete value.includedSources[0].contentHash; }],
    ['missing excluded-source content hash', (value: any) => {
      value.excludedSources.push({ source: structuredClone(value.includedSources[0]), reason: 'Superseded.' });
      delete value.excludedSources[0].source.contentHash;
    }],
    ['non-sha256 content hash', (value: any) => { value.includedSources[0].contentHash = 'a'.repeat(64); }],
    ['duplicate selected section', (value: any) => { value.includedSources[0].selectedSections.push('requirements'); }],
    ['non-workspace workspace reference', (value: any) => { value.workspaceRef.kind = 'mission'; }],
    ['mismatched workspace identity', (value: any) => { value.workspaceRef.id = 'another-workspace'; }],
    ['duplicate citation identity', (value: any) => {
      value.citations.push(structuredClone(value.citations[0]));
      value.bundleHash = deriveSourceBundleHash(value);
    }],
    ['duplicate conflict source identity', (value: any) => {
      value.conflicts.push({
        schemaVersion: SOURCE_CONTRACT_VERSIONS.sourceConflict,
        conflictId: 'conflict-1',
        sourceIds: ['source-1', 'source-1'],
        summary: 'A source cannot conflict with itself.',
        resolution: null,
      });
    }],
    ['mismatched bundle hash', (value: any) => { value.userIntent = 'Tampered intent'; }],
  ])('rejects %s', (_name, mutate) => {
    const invalid: any = structuredClone(fixture());
    mutate(invalid);
    expect(SourceBundleV1Schema.safeParse(invalid).success).toBe(false);
    expect(backend.SourceBundleV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('binds included source data, selected sections, and citations into the bundle hash', () => {
    const valid = fixture();
    const intentChanged = structuredClone(valid);
    intentChanged.userIntent = 'Changed intent';
    const sourceChanged = structuredClone(valid);
    sourceChanged.includedSources[0].title = 'Changed title';
    const sectionChanged = structuredClone(valid);
    sectionChanged.includedSources[0].selectedSections = ['changed-section'];
    const citationChanged = structuredClone(valid);
    citationChanged.citations[0].rationale = 'Changed citation rationale.';

    expect(deriveSourceBundleHash(intentChanged)).not.toBe(valid.bundleHash);
    expect(deriveSourceBundleHash(sourceChanged)).not.toBe(valid.bundleHash);
    expect(deriveSourceBundleHash(sectionChanged)).not.toBe(valid.bundleHash);
    expect(deriveSourceBundleHash(citationChanged)).not.toBe(valid.bundleHash);
  });
});

describe('IntentDispositionV1', () => {
  const valid = {
    schemaVersion: SOURCE_CONTRACT_VERSIONS.intentDisposition,
    disposition: 'answer', targetRef: null, draftHash: null,
    rationale: 'The request can be answered safely.', requiredDecision: null, permittedAction: 'answer',
    auditIdentity: 'hermes@rorca.internal', authorityMode: 'service-audit',
  };

  it('accepts only the six disposition variants and their server-defined actions', () => {
    expect(INTENT_DISPOSITIONS).toEqual(['answer', 'clarification_required', 'mission_draft', 'existing_mission_action', 'memory_candidate', 'denied']);
    const variants = [
      ['answer', 'answer'],
      ['clarification_required', 'request_clarification'],
      ['mission_draft', 'draft_mission'],
      ['existing_mission_action', 'open_mission'],
      ['memory_candidate', 'propose_memory'],
      ['denied', 'deny'],
    ] as const;
    for (const [disposition, permittedAction] of variants) {
      const value = {
        ...valid,
        disposition,
        permittedAction,
        ...(disposition === 'mission_draft' ? { frozenBundleDigest: HASH } : {}),
      };
      expect(IntentDispositionV1Schema.safeParse(value).success).toBe(true);
      expect(backend.IntentDispositionV1Schema.safeParse(value).success).toBe(true);
    }
    for (const schema of [IntentDispositionV1Schema, backend.IntentDispositionV1Schema]) {
      expect(schema.safeParse({ ...valid, disposition: 'unknown' }).success).toBe(false);
      expect(schema.safeParse({ ...valid, permittedAction: 'run_shell_command' }).success).toBe(false);
      expect(schema.safeParse({ ...valid, permittedAction: 'deny' }).success).toBe(false);
      expect(schema.safeParse({ ...valid, clientAction: 'run_shell_command' }).success).toBe(false);
    }
  });
});
