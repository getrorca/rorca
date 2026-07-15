/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

jest.mock('../../db/index', () => ({
  execute: jest.fn(),
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { ConflictError } from '../errors';
import {
  HERMES_EVIDENCE_SCHEMA_VERSION,
  canEvidenceSatisfyGate,
  createCanonicalEvidence,
  normalizeExistingRunEvidence,
  normalizeHermesEvidence,
  normalizeRunOutputReferenceEvidence,
  persistCanonicalEvidence,
  type CanonicalLifecycleEvidence,
  type EvidencePrincipal,
  type HermesEvidenceEnvelope,
} from '../ssdlc-evidence';

const observedAt = '2026-07-15T12:00:00.000Z';
const scope = {
  workspaceId: 'ws-evidence',
  specSlug: 'safe-delivery',
  runId: 42,
  storyId: 'LFC-005',
  phaseId: 'validation',
  gateId: 'validation-current-revision',
};

const verifiedPrincipal: EvidencePrincipal = {
  id: 'hermes-service',
  displayName: 'hermes@rorca.internal',
  adapterVerified: true,
};

function envelope(overrides: Partial<HermesEvidenceEnvelope> = {}): HermesEvidenceEnvelope {
  return {
    schemaVersion: HERMES_EVIDENCE_SCHEMA_VERSION,
    kind: 'gitreins_judgment',
    sourceSystem: 'gitreins',
    sourceEventId: 'judgment-123',
    observedAt,
    scope,
    subject: { type: 'commit_sha', value: 'abc123' },
    phaseSubject: { type: 'commit_sha', value: 'abc123' },
    releaseIdentity: { commitSha: 'abc123' },
    status: 'passed',
    confidence: 0.95,
    payloadHash: 'a'.repeat(64),
    excerpt: 'risk checks passed',
    rawReference: 'https://hermes.local/evidence/judgment-123',
    provenanceChain: [{ system: 'gitreins', eventId: 'judgment-123', observedAt }],
    ...overrides,
  };
}

function evidenceRow(evidence: CanonicalLifecycleEvidence) {
  return {
    id: '9',
    workspace_id: evidence.scope.workspaceId,
    spec_slug: evidence.scope.specSlug,
    run_id: evidence.scope.runId,
    story_id: evidence.scope.storyId,
    phase_id: evidence.scope.phaseId,
    gate_id: evidence.scope.gateId,
    evidence_type: evidence.classification,
    subject_type: evidence.subject.type,
    subject_value: evidence.subject.value,
    source_system: evidence.source.system,
    source_idempotency_key: evidence.source.eventId,
    payload_hash: evidence.payloadHash,
    metadata: {
      schemaVersion: evidence.schemaVersion,
      details: evidence.details,
      sourcePayloadHash: evidence.sourcePayloadHash,
    },
    provenance: { chain: evidence.provenanceChain },
    source_ref: evidence.rawReference,
    observed_at: evidence.observedAt,
    created_at: observedAt,
    source_type: evidence.source.type,
    classification: evidence.classification,
    evidence_status: evidence.status,
    trust_level: evidence.trustLevel,
    confidence: evidence.confidence,
    excerpt: evidence.excerpt,
    release_identity: evidence.releaseIdentity,
    phase_subject_type: evidence.phaseSubject?.type ?? null,
    phase_subject_value: evidence.phaseSubject?.value ?? null,
    revision_mismatch: evidence.revisionMismatch,
    lineage_verified: evidence.lineageVerified,
    actor: evidence.actor,
    rationale: evidence.rationale,
  };
}

describe('canonical lifecycle evidence normalization', () => {
  test('redacts seeded secret canaries before the canonical payload can be persisted', () => {
    const canaries = [
      'sk-ant-lifecycleCanary',
      'ghp_lifecycleCanary',
      'Bearer lifecycle-canary',
      'xoxb-lifecycle-slack-canary',
    ];
    const normalized = normalizeHermesEvidence(envelope({
      excerpt: canaries.join(' '),
      details: {
        credential: canaries[0],
        privateSlackPayload: { text: canaries[3] },
        commandOutput: canaries[1],
      },
    }), verifiedPrincipal);
    const serialized = JSON.stringify(normalized);

    for (const canary of canaries) expect(serialized).not.toContain(canary);
    expect(normalized).toMatchObject({
      source: { type: 'gitreins_judgment', system: 'hermes:gitreins', eventId: 'judgment-123' },
      observedAt,
      scope,
      subject: { type: 'commit_sha', value: 'abc123' },
      classification: 'risk_judgment',
      status: 'passed',
      trustLevel: 'provider_verified',
      confidence: 0.95,
      sourcePayloadHash: 'a'.repeat(64),
      revisionMismatch: false,
    });
  });

  test('derives manual actor and trust from request identity and ignores impersonation claims', () => {
    const normalized = normalizeHermesEvidence(envelope({
      kind: 'manual_qa',
      sourceSystem: 'claimed-ci',
      sourceEventId: 'manual-7',
      actor: 'github-actions[bot]',
      trustLevel: 'provider_verified',
      automated: true,
      rationale: 'QA reproduced the acceptance path',
      rawReference: null,
      attachmentReference: 'attachments:qa/manual-7',
    }), {
      id: 'reviewer-1',
      displayName: 'reviewer@rorca.local',
      adapterVerified: false,
    });

    expect(normalized.source.type).toBe('manual_qa');
    expect(normalized.trustLevel).toBe('authenticated_manual');
    expect(normalized.actor).toBe('reviewer@rorca.local');
    expect(normalized.actor).not.toBe('github-actions[bot]');
    expect(normalized.rationale).toBe('QA reproduced the acceptance path');
    expect(normalized.rawReference).toBe('attachments:qa/manual-7');
  });

  test('does not let an authenticated request claim provider verification', () => {
    const normalized = normalizeHermesEvidence(envelope({ trustLevel: 'provider_verified', automated: true }), {
      id: 'user-1',
      displayName: 'user@example.test',
      adapterVerified: false,
    });
    expect(normalized.trustLevel).toBe('host_observed');
    expect(normalized.actor).toBeNull();
  });

  test('keeps mismatched revision evidence visible but gate-ineligible', () => {
    const mismatched = normalizeHermesEvidence(envelope({
      subject: { type: 'commit_sha', value: 'old-commit' },
      phaseSubject: { type: 'commit_sha', value: 'current-commit' },
      releaseIdentity: { commitSha: 'old-commit' },
    }), verifiedPrincipal);

    expect(mismatched.revisionMismatch).toBe(true);
    expect(canEvidenceSatisfyGate(mismatched, {
      gateType: 'code',
      acceptedTrustLevels: ['provider_verified'],
      phaseSubject: { type: 'commit_sha', value: 'current-commit' },
    })).toBe(false);
  });

  test('unknown never passes and trust must be explicitly accepted', () => {
    const unknown = normalizeHermesEvidence(envelope({ status: 'unknown' }), verifiedPrincipal);
    expect(canEvidenceSatisfyGate(unknown, {
      gateType: 'code', acceptedTrustLevels: ['provider_verified'],
    })).toBe(false);

    const passed = normalizeHermesEvidence(envelope(), verifiedPrincipal);
    expect(canEvidenceSatisfyGate(passed, {
      gateType: 'code', acceptedTrustLevels: ['host_observed'],
    })).toBe(false);
  });

  test('production proof binds deployment to exact artifact digest and commit lineage', () => {
    const proof = normalizeHermesEvidence(envelope({
      kind: 'deployment_proof',
      sourceEventId: 'deployment-77',
      subject: { type: 'deployment_id', value: 'deploy-77' },
      phaseSubject: { type: 'artifact_digest', value: 'sha256:image' },
      releaseIdentity: {
        commitSha: 'abc123',
        artifactDigest: 'sha256:image',
        deploymentId: 'deploy-77',
      },
    }), verifiedPrincipal);

    expect(proof.lineageVerified).toBe(true);
    expect(canEvidenceSatisfyGate(proof, {
      gateType: 'production',
      acceptedTrustLevels: ['provider_verified'],
      phaseSubject: { type: 'artifact_digest', value: 'sha256:image' },
      expectedReleaseIdentity: {
        commitSha: 'abc123',
        artifactDigest: 'sha256:image',
        deploymentId: 'deploy-77',
      },
    })).toBe(true);
    expect(canEvidenceSatisfyGate(proof, {
      gateType: 'production',
      acceptedTrustLevels: ['provider_verified'],
      expectedReleaseIdentity: { commitSha: 'different-commit' },
    })).toBe(false);
  });

  test('preserves typed commit/digest identity while redacting free-text payloads', async () => {
    const commitSha = 'a'.repeat(40);
    const normalized = normalizeHermesEvidence(envelope({
      subject: { type: 'commit_sha', value: commitSha },
      phaseSubject: { type: 'commit_sha', value: commitSha },
      releaseIdentity: { commitSha },
    }), verifiedPrincipal);
    const db = {
      query: jest.fn(),
      execute: jest.fn(),
      queryOne: jest.fn().mockResolvedValueOnce(evidenceRow(normalized)),
    } as any;

    const stored = await persistCanonicalEvidence(normalized, db);
    expect(stored.evidence.subject.value).toBe(commitSha);
    expect(stored.evidence.releaseIdentity.commitSha).toBe(commitSha);
  });

  test('represents large output only by bounded metadata and an existing raw reference', () => {
    const normalized = normalizeRunOutputReferenceEvidence({
      first_sequence: 1,
      last_sequence: 900,
      byte_length: 5_000_000,
      observed_at: observedAt,
    }, { scope, phaseSubject: { type: 'commit_sha', value: 'abc123' } }, observedAt);

    expect(normalized.excerpt).toBeNull();
    expect(normalized.rawReference).toBe('run-output-chunks:42?sequence=1-900');
    expect(normalized.details).toMatchObject({ byteLength: 5_000_000 });
    expect(normalized.details).not.toHaveProperty('chunk');
    expect(normalized.status).toBe('unknown');
  });
});

describe('immutable persistence and adapter isolation', () => {
  test('uses INSERT ON CONFLICT DO NOTHING and returns exact replay idempotently', async () => {
    const evidence = normalizeHermesEvidence(envelope(), verifiedPrincipal);
    const row = evidenceRow(evidence);
    const db = {
      query: jest.fn(),
      execute: jest.fn(),
      queryOne: jest.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(row),
    } as any;

    const result = await persistCanonicalEvidence(evidence, db);

    expect(result.replayed).toBe(true);
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.queryOne.mock.calls[0][0]).toContain('ON CONFLICT (workspace_id, source_system, source_idempotency_key) DO NOTHING');
  });

  test('audits a conflicting payload under the same stable source event ID', async () => {
    const original = normalizeHermesEvidence(envelope(), verifiedPrincipal);
    const changed = normalizeHermesEvidence(envelope({ excerpt: 'different immutable payload' }), verifiedPrincipal);
    const db = {
      query: jest.fn(),
      execute: jest.fn().mockResolvedValue({ rowCount: 1 }),
      queryOne: jest.fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(evidenceRow(original)),
    } as any;

    await expect(persistCanonicalEvidence(changed, db)).rejects.toBeInstanceOf(ConflictError);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.execute.mock.calls[0][0]).toContain('ssdlc_evidence_source_conflict');
    const auditPayload = String(db.execute.mock.calls[0][1][3]);
    expect(auditPayload).toContain(original.payloadHash);
    expect(auditPayload).toContain(changed.payloadHash);
    expect(auditPayload).not.toContain('different immutable payload');
  });

  test('isolates an adapter failure, uses wal_events.ts ordering, and never updates story status', async () => {
    const sqlSeen: string[] = [];
    const db = {
      queryOne: jest.fn(),
      execute: jest.fn().mockImplementation(async (sql: string) => {
        sqlSeen.push(sql);
        return { rowCount: 1 };
      }),
      query: jest.fn().mockImplementation(async (sql: string) => {
        sqlSeen.push(sql);
        if (sql.includes('FROM story_results')) throw new Error('seeded adapter failure');
        return [];
      }),
    } as any;

    const results = await normalizeExistingRunEvidence({ scope, phaseSubject: null }, db);

    expect(results.find((result) => result.adapter === 'story_results')?.failed).toBe(true);
    expect(results.filter((result) => result.adapter !== 'story_results').every((result) => !result.failed)).toBe(true);
    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('ssdlc_evidence_adapter_error'),
      expect.any(Array),
    );
    expect(sqlSeen.filter((sql) => sql.includes('wal_events')).every((sql) => sql.includes('ORDER BY ts') || sql.includes('INSERT INTO'))).toBe(true);
    expect(sqlSeen.join('\n')).not.toMatch(/UPDATE\s+story_results/i);
  });

  test('canonical creation rejects automated actor impersonation', () => {
    expect(() => createCanonicalEvidence({
      sourceType: 'github_check',
      sourceSystem: 'github',
      sourceEventId: 'check-1',
      observedAt,
      scope,
      subject: { type: 'commit_sha', value: 'abc123' },
      classification: 'validation',
      status: 'passed',
      trustLevel: 'provider_verified',
      confidence: 1,
      actor: 'claimed-automation',
    })).toThrow(/reserved for manual_qa/);
  });
});
