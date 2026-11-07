/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockQueryOne = jest.fn();
const mockInspectRunHostAuthority = jest.fn();
const mockPersistCanonicalEvidence = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));
jest.mock('../ssdlc-evidence', () => ({
  ...jest.requireActual('../ssdlc-evidence'),
  persistCanonicalEvidence: (record: unknown) => mockPersistCanonicalEvidence(record),
}));
jest.mock('../run-host-authority', () => ({
  inspectRunHostAuthority: (...args: unknown[]) => mockInspectRunHostAuthority(...args),
}));

import { projectCurrentLifecyclePlanEvidence, projectLifecycleEvidenceForRun } from '../run-lifecycle-projection';
import { normalizeSsdlcContractJson } from '../ssdlc-contracts';
import {
  COMMIT_SUBJECT,
  EVALUATOR_PLAN,
  SPEC_SUBJECT,
} from './fixtures/ssdlc-phase-evaluator.fixtures';

const workspaceId = 'workspace-evaluator';
const runId = 947;
const specSlug = 'fixture-phase-evaluator';
const hash = (value: string | Buffer): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

function writeProjectionPack(workspace: string, authoritative: boolean, specHash: `sha256:${string}`): void {
  const packageId = 'projection-authority-pack';
  const directory = path.join(workspace, 'genesis', 'artifacts', 'export-packs', packageId);
  fs.mkdirSync(directory, { recursive: true });
  const documents: Record<string, string> = {
    'PRD.md': '# Projection authority\n\n## Intent\nBind requirements to exact source bytes.\n\n## Functional requirements\n- Preserve subject lineage.\n',
    'SDD.md': '# Projection authority\n\n## Target model\nReceipt-bound source material.\n',
    'PLAN.md': '# Projection authority\n\n## Caveats\n- Local declarations are context only.\n',
  };
  for (const [name, content] of Object.entries(documents)) fs.writeFileSync(path.join(directory, name), content);
  const manifest: Record<string, unknown> = {
    contractVersion: 'genesis.intent-curation-export/v1',
    status: authoritative ? 'published' : 'ready_for_review',
    publicationStatus: authoritative ? 'published' : 'draft-not-published',
    authoritative,
    workspaceId,
    packageId,
    contentHash: hash('projection-package'),
    previewHash: hash('projection-preview'),
    snapshotHash: hash('projection-snapshot'),
    files: [...Object.keys(documents), 'manifest.json'],
    evidence: [{ title: 'projection-authority-pack' }],
  };
  if (authoritative) manifest.authorityReceiptPath = 'publication-receipt.json';
  const rawManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(directory, 'manifest.json'), rawManifest);
  if (!authoritative) return;
  const eventHash = hash('projection-receipt');
  fs.writeFileSync(path.join(directory, 'publication-receipt.json'), JSON.stringify({
    contractVersion: 'genesis.package-publication-receipt/v1',
    receiptId: `package-event:${eventHash}`,
    eventHash,
    state: 'published',
    authoritative: true,
    workspaceId,
    packageId,
    packagePath: `genesis/artifacts/export-packs/${packageId}`,
    packageHash: manifest.contentHash,
    previewHash: manifest.previewHash,
    snapshotHash: manifest.snapshotHash,
    manifestHash: hash(rawManifest),
    releaseSubject: { type: 'spec_hash', value: specHash },
    artifacts: Object.entries(documents).map(([artifactPath, content]) => ({
      path: artifactPath,
      contentHash: hash(content),
      sizeBytes: Buffer.byteLength(content),
    })),
  }, null, 2));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPersistCanonicalEvidence.mockResolvedValue({ replayed: false });
  mockQueryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM pipeline_runs')) {
      return {
        id: String(runId),
        workspace_id: workspaceId,
        spec_path: `forge/specs/approved/${specSlug}.json`,
        status: 'done',
        canonical_spec_revision: SPEC_SUBJECT.value,
        terminal_checkout_sha: COMMIT_SUBJECT.value,
        branch_name: 'feature/lifecycle',
        merge_strategy: 'branch-only',
        started_at: '2026-07-15T10:00:00.000Z',
        finished_at: '2026-07-15T12:00:00.000Z',
        expected_story_ids: ['LFC-006'],
      };
    }
    if (sql.includes('FROM ssdlc_compiled_plans')) {
      return {
        id: 'compiled-plan-1',
        plan_json: EVALUATOR_PLAN,
        provenance_json: { specHash: SPEC_SUBJECT.value },
      };
    }
    throw new Error(`Unexpected queryOne: ${sql}`);
  });
  mockInspectRunHostAuthority.mockResolvedValue({
    workspaceId,
    specId: specSlug,
    releaseEligible: true,
    terminalRevision: COMMIT_SUBJECT.value,
    finalCommitSha: COMMIT_SUBJECT.value,
    authoritativePassedStoryIds: ['LFC-006'],
    expectedStoryIds: ['LFC-006'],
  });
});

test('projects host-attested completion facts without inventing downstream release proof', async () => {
  const result = await projectLifecycleEvidenceForRun({ workspaceId, runId });
  expect(mockInspectRunHostAuthority).toHaveBeenCalledWith(runId);
  const evidence = mockPersistCanonicalEvidence.mock.calls.map(([record]) => record);
  expect(evidence).not.toContain(undefined);
  const observations = evidence.filter((record) =>
    record.source.system === 'rorca:lifecycle-run-projection' && record.scope.gateId === null);
  const gateEvidence = evidence.filter((record) =>
    record.source.system === 'rorca:lifecycle-run-projection' && record.scope.gateId !== null);

  expect(result).toMatchObject({
    runId,
    workspaceId,
    specSlug,
    status: 'projected',
    reason: null,
    persisted: evidence.length,
    replayed: 0,
  });
  expect(observations).toHaveLength(EVALUATOR_PLAN.phaseOrder.length);
  expect(observations).toEqual(expect.arrayContaining([
    expect.objectContaining({
      classification: 'completion',
      trustLevel: 'host_observed',
      subject: COMMIT_SUBJECT,
      scope: expect.objectContaining({ runId, gateId: null }),
    }),
  ]));
  expect(gateEvidence).not.toHaveLength(0);
  expect(gateEvidence).toEqual(expect.arrayContaining([
    expect.objectContaining({
      subject: COMMIT_SUBJECT,
      releaseIdentity: expect.objectContaining({ commitSha: COMMIT_SUBJECT.value }),
      scope: expect.objectContaining({ runId }),
    }),
  ]));
  expect(evidence.some((record) => record.scope.gateId === 'gate-ctrl-testing-quality-attributes')).toBe(false);
  // Only the run-provable trace-unit/req-regression gates get gate evidence
  // (both testing-phase in the merged model); deployment gates stay unproven.
  expect(evidence.some((record) => record.scope.phaseId === 'deployment' && record.scope.gateId !== null)).toBe(false);
});

test('withholds run-gate proof without exact terminal host authority', async () => {
  mockInspectRunHostAuthority.mockResolvedValue({
    workspaceId,
    specId: specSlug,
    releaseEligible: false,
    terminalRevision: null,
    finalCommitSha: null,
    authoritativePassedStoryIds: [],
    expectedStoryIds: ['LFC-006'],
  });

  const result = await projectLifecycleEvidenceForRun({ workspaceId, runId });
  const evidence = mockPersistCanonicalEvidence.mock.calls.map(([record]) => record);
  expect(mockInspectRunHostAuthority).toHaveBeenCalledWith(runId);
  expect(evidence).not.toContain(undefined);

  expect(result).toMatchObject({
    status: 'projected',
    reason: 'terminal_host_authority_not_available',
    persisted: evidence.length,
    replayed: 0,
  });
  expect(evidence.every((record) => record.scope.runId === null)).toBe(true);
  expect(evidence.every((record) => record.source.system === 'rorca:lifecycle-plan-projection')).toBe(true);
});

test('rejects completion projection after the current plan changes revision', async () => {
  mockQueryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM pipeline_runs')) {
      return {
        id: runId,
        workspace_id: workspaceId,
        spec_path: `forge/specs/approved/${specSlug}.json`,
        status: 'done',
        canonical_spec_revision: SPEC_SUBJECT.value,
        terminal_checkout_sha: COMMIT_SUBJECT.value,
        branch_name: 'feature/lifecycle',
        merge_strategy: 'branch-only',
        started_at: '2026-07-15T10:00:00.000Z',
        finished_at: '2026-07-15T12:00:00.000Z',
        expected_story_ids: ['LFC-006'],
      };
    }
    if (sql.includes('FROM ssdlc_compiled_plans')) {
      return {
        id: 'compiled-plan-1',
        plan_json: EVALUATOR_PLAN,
        provenance_json: { specHash: `sha256:${'f'.repeat(64)}` },
      };
    }
    throw new Error(`Unexpected queryOne: ${sql}`);
  });

  await expect(projectLifecycleEvidenceForRun({ workspaceId, runId })).resolves.toMatchObject({
    status: 'skipped',
    reason: 'current_plan_not_bound_to_run_revision',
    persisted: 0,
    replayed: 0,
  });
  expect(mockPersistCanonicalEvidence).not.toHaveBeenCalled();
  expect(mockInspectRunHostAuthority).not.toHaveBeenCalled();
});

test.each([
  ['self-declared draft', false, false],
  ['self-issued publication receipt', true, false],
  ['trusted persisted publication receipt', true, true],
] as const)('projects %s source material with the correct gating authority', async (_caseName, authoritative, trusted) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-source-projection-'));
  try {
    const approvedRoot = path.join(workspace, 'forge', 'specs', 'approved');
    fs.mkdirSync(approvedRoot, { recursive: true });
    const specContent = {
      title: 'Projection authority',
      sourcePackageId: 'projection-authority-pack',
      contextUsed: { meta: { filesReferenced: [] } },
    };
    fs.writeFileSync(path.join(approvedRoot, `${specSlug}.json`), JSON.stringify(specContent));
    const specHash = hash(normalizeSsdlcContractJson(specContent));
    writeProjectionPack(workspace, authoritative, specHash);
    mockQueryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM workspaces')) return { id: workspaceId, path: workspace };
      if (sql.includes('FROM ssdlc_compiled_plans')) {
        return {
          id: 'compiled-plan-source-authority',
          plan_json: EVALUATOR_PLAN,
          provenance_json: { specHash },
        };
      }
      if (sql.includes('FROM rorca.lifecycle_source_publication_receipts')) {
        return trusted ? { receipt_id: `package-event:${hash('projection-receipt')}` } : undefined;
      }
      throw new Error(`Unexpected queryOne: ${sql}`);
    });

    const result = await projectCurrentLifecyclePlanEvidence({ workspaceId, specId: specSlug });
    const evidence = mockPersistCanonicalEvidence.mock.calls.map(([record]) => record);
    const sourceEvidence = evidence.filter((record) =>
      record.source.system === 'rorca:lifecycle-source-evidence-projection');
    expect(result).toMatchObject({
      status: 'projected',
      reason: null,
      persisted: evidence.length,
      replayed: 0,
    });
    if (!trusted) {
      expect(sourceEvidence).toHaveLength(0);
      expect(evidence.every((record) => record.source.system === 'rorca:lifecycle-plan-projection')).toBe(true);
      if (authoritative) {
        expect(mockQueryOne).toHaveBeenCalledWith(
          expect.stringContaining('FROM rorca.lifecycle_source_publication_receipts'),
          expect.arrayContaining([
            workspaceId,
            specSlug,
            specHash,
            'projection-authority-pack',
          ]),
        );
      }
      return;
    }
    expect(sourceEvidence.length).toBeGreaterThan(0);
    expect(sourceEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'passed',
        trustLevel: 'host_observed',
        subject: { type: 'spec_hash', value: specHash },
        provenanceChain: [expect.objectContaining({
          system: 'genesis:canonical-package-publication',
          verification: 'trusted-ledger-publication-receipt-manifest-and-artifact-byte-verification',
        })],
        details: expect.objectContaining({
          authorityReceiptId: expect.stringMatching(/^package-event:/),
          authorityReceiptHash: expect.stringMatching(/^sha256:/),
          manifestHash: expect.stringMatching(/^sha256:/),
          authorityTrustRoot: 'rorca.lifecycle_source_publication_receipts',
          authorityVerification: 'exact_persisted_receipt',
          authorityIssuerPrincipal: { id: 'rorca:canonical-writer' },
          releaseSubject: { type: 'spec_hash', value: specHash },
        }),
      }),
    ]));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
