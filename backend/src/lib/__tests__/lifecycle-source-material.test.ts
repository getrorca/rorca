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

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));
import {
  lifecycleSourceEvidenceProjection,
  openLifecycleSourceArtifact,
  projectLifecycleSourceMaterial,
  readLifecycleSourceArtifact,
  type EditorLaunch,
  type LifecycleSourceArtifact,
} from '../lifecycle-source-material';

const hash = (value: string | Buffer): `sha256:${string}` => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function writePack(workspace: string, packageId = 'billing-security-delivery-pack', sourceName = 'docs/security.md'): string {
  const directory = path.join(workspace, 'genesis', 'artifacts', 'export-packs', packageId);
  fs.mkdirSync(directory, { recursive: true });
  const files: Record<string, string> = {
    'PRD.md': [
      '# Billing Security — PRD',
      '',
      '## Intent',
      'Protect tenant-owned billing data.',
      '',
      '## 4. Goals',
      '- G-1 Isolate every tenant.',
      '',
      '## 5. Non-goals',
      '- No cross-tenant aggregation.',
      '',
      '## 6. Functional requirements',
      '### FR-1 — Tenant boundary',
      'Requests never return another tenant.',
      '',
      '## 7. Non-functional requirements',
      '- NFR-1 Fail closed.',
      '',
      '## Rorca Stories',
      '### SEC-001 — Enforce authorization',
      'Implement the boundary.',
      '',
      '## Phase 0 — Establish truth',
      '- Inventory current routes.',
      '',
      '## Phase 1 — Cut over',
      '- Enforce the boundary.',
      '',
      '## Success signals',
      '- Zero cross-tenant reads.',
      '',
      '## Acceptance criteria',
      '1. A foreign tenant request is denied.',
      '',
      '## Out of scope',
      '- Cross-region replication.',
      '',
      '## Definition of done',
      '- Contract and browser verification pass.',
    ].join('\n'),
    'SDD.md': [
      '# Billing Security — SDD',
      '',
      '## 1. Target model',
      'Tenant id is immutable.',
      '',
      '## 2. Lifecycle state machine',
      'draft -> approved -> released',
      '',
      '## 1. Component inventory',
      '- Policy middleware',
      '',
      '## 2. Required UX states (every flow)',
      '- Forbidden',
      '',
      '## 1. Authorization rules',
      '- Workspace member required.',
      '',
      '## 2. RLS model',
      '- Forced RLS.',
      '',
      '## 3. Redaction and privacy',
      '- Never expose raw secrets.',
      '',
      '## 2. History transfers',
      '- POST /history/preview',
      '',
      '## 7. Migration strategy',
      '- Expand first.',
      '',
      '## 1. Verification matrix',
      '- API contract tests.',
    ].join('\n'),
    'PLAN.md': '# Billing Security — Plan\n\n## Caveats\n- Review status is not a completion gate.\n',
    'manifest.json': '',
  };
  const manifest = {
    contractVersion: 'genesis.intent-curation-export/v1',
    status: 'ready_for_review',
    publicationStatus: 'draft-not-published',
    authoritative: false,
    scope: 'entire-project-kb',
    workspaceId: 'billing',
    packageId,
    contentHash: hash(`${packageId}:content`),
    previewHash: hash(`${packageId}:preview`),
    snapshotHash: hash(`${packageId}:snapshot`),
    files: Object.keys(files),
    evidence: [{ title: sourceName, excerpt: `Source ${sourceName}` }],
    excluded: [{ evidenceId: 'excluded-1', reason: 'explicit filter' }],
    warnings: ['Selected evidence includes non-approved material.'],
    contradictions: [],
    uncertainties: [],
  };
  files['manifest.json'] = JSON.stringify(manifest, null, 2);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content);
  return directory;
}
const SPEC_HASH = hash('billing-security-spec');

function authorizePack(workspace: string, directory: string, releaseSubject = SPEC_HASH): void {
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.status = 'published';
  manifest.authoritative = true;
  manifest.publicationStatus = 'published';
  manifest.authorityReceiptPath = 'publication-receipt.json';
  const rawManifest = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(manifestPath, rawManifest);
  const files = manifest.files as string[];
  const artifacts = files.filter((file) => file !== 'manifest.json' && file !== 'publication-receipt.json')
    .map((file) => {
      const bytes = fs.readFileSync(path.join(directory, file));
      return { path: file, contentHash: hash(bytes), sizeBytes: bytes.length };
    });
  const eventHash = hash(String(manifest.packageId));
  fs.writeFileSync(path.join(directory, 'publication-receipt.json'), JSON.stringify({
    contractVersion: 'genesis.package-publication-receipt/v1',
    receiptId: `package-event:${eventHash}`,
    eventHash,
    state: 'published',
    authoritative: true,
    workspaceId: manifest.workspaceId,
    packageId: manifest.packageId,
    packagePath: path.relative(workspace, directory).split(path.sep).join('/'),
    packageHash: manifest.contentHash,
    previewHash: manifest.previewHash,
    snapshotHash: manifest.snapshotHash,
    manifestHash: hash(rawManifest),
    releaseSubject: { type: 'spec_hash', value: releaseSubject },
    artifacts,
  }, null, 2));
}


function projectionInput(workspace: string, lens: 'planning' | 'requirements' | 'design') {
  return {
    workspacePath: workspace,
    specId: 'billing-security',
    specTitle: 'Billing tenant security',
    specContent: {
      contextUsed: { meta: { filesReferenced: ['docs/security.md'] } },
    },
    lens,
  };
}

describe('lifecycle export source material', () => {
  let workspace: string;
  const originalEditor = process.env.RORCA_EDITOR_BIN;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-lifecycle-source-'));
    mockQueryOne.mockReset();
    mockQueryOne.mockResolvedValue(undefined);
    writePack(workspace);
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    if (originalEditor === undefined) delete process.env.RORCA_EDITOR_BIN;
    else process.env.RORCA_EDITOR_BIN = originalEditor;
  });

  test.each([
    ['planning', ['Mission and scope', 'Goals', 'Delivery workstreams', 'Phase 0 — Establish truth', 'Definition of done', 'Source review caveats']],
    ['requirements', ['Problem and intent', 'Functional requirements', 'Non-functional requirements', 'Acceptance criteria', 'Out of scope']],
    ['design', ['Domain and lifecycle model', 'Lifecycle state machine', 'Component inventory', 'Authorization boundaries', 'Migration strategy', 'Verification design']],
  ] as const)('projects a traceable %s synthesis from the same exact package', async (lens, expectedSections) => {
    const result = await projectLifecycleSourceMaterial(projectionInput(workspace, lens));

    expect(result.state).toBe('available');
    if (result.state !== 'available') return;
    expect(result.package).toMatchObject({
      packageId: 'billing-security-delivery-pack',
      title: 'Billing Security',
      authoritative: false,
      status: 'ready_for_review',
    });
    expect(result.match).toMatchObject({ method: 'referenced_source_overlap', referencesMatched: ['docs/security.md'] });
    expect(result.inventory).toMatchObject({ evidenceCount: 1, excludedCount: 1, warningCount: 1 });
    expect(result.artifacts.map((artifact) => artifact.name)).toEqual(['PRD.md', 'SDD.md', 'PLAN.md', 'manifest.json']);
    expect(result.artifacts.every((artifact) => artifact.relativePath.startsWith('genesis/artifacts/export-packs/'))).toBe(true);
    expect(result.synthesis.sourcePackageHash).toBe(result.package.contentHash);
    expect(result.synthesis.sections.map((section) => section.title)).toEqual(expect.arrayContaining([...expectedSections]));
    expect(result.synthesis.sections.every((section) => section.startLine > 0 && section.endLine >= section.startLine)).toBe(true);
    expect(result.authority).toMatchObject({
      status: 'context_only',
      reasonCode: 'authority_receipt_not_declared',
    });
    expect(lifecycleSourceEvidenceProjection(result)).toBeNull();
  });

  test('promotes an exact receipt-backed package to bounded host-observed source evidence', async () => {
    const directory = path.join(workspace, 'genesis', 'artifacts', 'export-packs', 'billing-security-delivery-pack');
    authorizePack(workspace, directory);
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'publication-receipt.json'), 'utf8')) as Record<string, unknown>;
    const receiptId = String(receipt.receiptId);
    mockQueryOne.mockImplementation(async (_sql: string, params: unknown[]) =>
      params[0] === 'billing'
      && params[1] === 'billing-security'
      && params[2] === SPEC_HASH
      && params[3] === 'billing-security-delivery-pack'
      && params[5] === receiptId
      && params[6] === hash(fs.readFileSync(path.join(directory, 'publication-receipt.json')))
        ? { receipt_id: receiptId }
        : undefined);
    const result = await projectLifecycleSourceMaterial({
      ...projectionInput(workspace, 'requirements'),
      workspaceId: 'billing',
      releaseSubject: { type: 'spec_hash', value: SPEC_HASH },
    });

    expect(result.state).toBe('available');
    if (result.state !== 'available') return;
    expect(result.authority).toMatchObject({
      status: 'verified',
      reasonCode: 'verified',
      receiptId: expect.stringMatching(/^package-event:/),
      receiptHash: expect.stringMatching(/^sha256:/),
      manifestHash: expect.stringMatching(/^sha256:/),
      releaseSubject: { type: 'spec_hash', value: SPEC_HASH },
    });
    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM rorca.lifecycle_source_publication_receipts'),
      [
        'billing',
        'billing-security',
        SPEC_HASH,
        'billing-security-delivery-pack',
        'genesis/artifacts/export-packs/billing-security-delivery-pack',
        receiptId,
        hash(fs.readFileSync(path.join(directory, 'publication-receipt.json'))),
        receipt.eventHash,
        receipt.manifestHash,
        receipt.packageHash,
        receipt.previewHash,
        receipt.snapshotHash,
      ],
    );
    const evidence = lifecycleSourceEvidenceProjection(result);
    expect(evidence).toMatchObject({
      lens: 'requirements',
      packageId: 'billing-security-delivery-pack',
      authorityReceiptId: result.authority.receiptId,
      authorityReceiptHash: result.authority.receiptHash,
      manifestHash: result.authority.manifestHash,
      releaseSubject: { type: 'spec_hash', value: SPEC_HASH },
      references: expect.arrayContaining([
        expect.objectContaining({ artifactHash: expect.stringMatching(/^sha256:/) }),
      ]),
    });
    expect(JSON.stringify(evidence)).not.toContain('Requests never return another tenant.');
  });

  test('keeps a structurally valid self-issued receipt non-passing without persisted authority', async () => {
    const directory = path.join(workspace, 'genesis', 'artifacts', 'export-packs', 'billing-security-delivery-pack');
    authorizePack(workspace, directory);

    const result = await projectLifecycleSourceMaterial({
      ...projectionInput(workspace, 'requirements'),
      workspaceId: 'billing',
      releaseSubject: { type: 'spec_hash', value: SPEC_HASH },
    });

    expect(result.state).toBe('available');
    if (result.state !== 'available') return;
    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('FROM rorca.lifecycle_source_publication_receipts'),
      expect.arrayContaining([
        'billing',
        'billing-security',
        SPEC_HASH,
        'billing-security-delivery-pack',
      ]),
    );
    expect(result.authority).toMatchObject({
      status: 'context_only',
      reasonCode: 'authority_receipt_not_trusted',
      receiptId: null,
      receiptHash: null,
    });
    expect(lifecycleSourceEvidenceProjection(result)).toBeNull();
  });

  test('keeps a receipt non-passing when its bytes differ from the trusted persisted receipt', async () => {
    const directory = path.join(workspace, 'genesis', 'artifacts', 'export-packs', 'billing-security-delivery-pack');
    authorizePack(workspace, directory);
    const receiptPath = path.join(directory, 'publication-receipt.json');
    const trustedReceiptHash = hash(fs.readFileSync(receiptPath));
    fs.appendFileSync(receiptPath, '\n');
    mockQueryOne.mockImplementation(async (_sql: string, params: unknown[]) =>
      params[6] === trustedReceiptHash
        ? { receipt_id: params[5] }
        : undefined);

    const result = await projectLifecycleSourceMaterial({
      ...projectionInput(workspace, 'requirements'),
      workspaceId: 'billing',
      releaseSubject: { type: 'spec_hash', value: SPEC_HASH },
    });

    expect(result.state).toBe('available');
    if (result.state !== 'available') return;
    expect(result.authority).toMatchObject({
      status: 'context_only',
      reasonCode: 'authority_receipt_not_trusted',
    });
    expect(lifecycleSourceEvidenceProjection(result)).toBeNull();
  });

  test('does not project a package bound to another workspace', async () => {
    const directory = path.join(workspace, 'genesis', 'artifacts', 'export-packs', 'billing-security-delivery-pack');
    authorizePack(workspace, directory);
    mockQueryOne.mockResolvedValue({
      receipt_id: `package-event:${hash('billing-security-delivery-pack')}`,
    });

    const result = await projectLifecycleSourceMaterial({
      ...projectionInput(workspace, 'requirements'),
      workspaceId: 'another-workspace',
      releaseSubject: { type: 'spec_hash', value: SPEC_HASH },
    });

    expect(result).toMatchObject({ state: 'not_found', lens: 'requirements' });
    expect(mockQueryOne).not.toHaveBeenCalled();
    expect(lifecycleSourceEvidenceProjection(result)).toBeNull();
  });

  test('rejects a trusted receipt ledger row bound to another spec', async () => {
    const directory = path.join(workspace, 'genesis', 'artifacts', 'export-packs', 'billing-security-delivery-pack');
    authorizePack(workspace, directory);
    mockQueryOne.mockImplementation(async (_sql: string, params: unknown[]) =>
      params[1] === 'another-spec'
        ? { receipt_id: params[5] }
        : undefined);

    const result = await projectLifecycleSourceMaterial({
      ...projectionInput(workspace, 'requirements'),
      workspaceId: 'billing',
      releaseSubject: { type: 'spec_hash', value: SPEC_HASH },
    });

    expect(result.state).toBe('available');
    if (result.state !== 'available') return;
    expect(result.authority).toMatchObject({
      status: 'context_only',
      reasonCode: 'authority_receipt_not_trusted',
    });
    expect(lifecycleSourceEvidenceProjection(result)).toBeNull();
  });

  test.each([
    ['missing artifact', 'artifact_missing', (directory: string): void => {
      fs.rmSync(path.join(directory, 'PRD.md'));
    }],
    ['artifact byte mismatch', 'artifact_hash_mismatch', (directory: string): void => {
      fs.appendFileSync(path.join(directory, 'PRD.md'), '\nChanged after publication.\n');
    }],
    ['release subject mismatch', 'release_subject_mismatch', (_directory: string): void => undefined],
    ['manifest/package identity mismatch', 'manifest_identity_mismatch', (directory: string): void => {
      const manifestPath = path.join(directory, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest.packageId = 'different-package';
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }],
  ] as const)('keeps a receipt-backed pack non-passing after %s', async (_caseName, reasonCode, mutate) => {
    const directory = path.join(workspace, 'genesis', 'artifacts', 'export-packs', 'billing-security-delivery-pack');
    authorizePack(workspace, directory, reasonCode === 'release_subject_mismatch' ? hash('other-spec') : SPEC_HASH);
    mutate(directory);
    const result = await projectLifecycleSourceMaterial({
      ...projectionInput(workspace, 'requirements'),
      workspaceId: 'billing',
      releaseSubject: { type: 'spec_hash', value: SPEC_HASH },
    });

    expect(result.state).toBe('available');
    if (result.state !== 'available') return;
    expect(result.authority).toMatchObject({ status: 'context_only', reasonCode });
    expect(lifecycleSourceEvidenceProjection(result)).toBeNull();
    expect(JSON.stringify(result.authority)).not.toContain('Changed after publication.');
  });

  test('keeps a path-escaping authoritative artifact declaration non-passing', async () => {
    const directory = path.join(workspace, 'genesis', 'artifacts', 'export-packs', 'billing-security-delivery-pack');
    authorizePack(workspace, directory);
    const manifestPath = path.join(directory, 'manifest.json');
    const receiptPath = path.join(directory, 'publication-receipt.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.files = [...manifest.files as string[], '../outside.md'];
    const rawManifest = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(manifestPath, rawManifest);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    receipt.manifestHash = hash(rawManifest);
    receipt.artifacts = [
      ...receipt.artifacts as Array<Record<string, unknown>>,
      { path: '../outside.md', contentHash: hash('outside'), sizeBytes: 7 },
    ];
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

    const result = await projectLifecycleSourceMaterial({
      ...projectionInput(workspace, 'requirements'),
      workspaceId: 'billing',
      releaseSubject: { type: 'spec_hash', value: SPEC_HASH },
    });
    expect(result.state).toBe('available');
    if (result.state !== 'available') return;
    expect(result.authority).toMatchObject({ status: 'context_only', reasonCode: 'artifact_path_invalid' });
    expect(lifecycleSourceEvidenceProjection(result)).toBeNull();
  });

  test('refuses an equally matched package instead of guessing source authority', async () => {
    writePack(workspace, 'billing-security-alternate-pack');
    const result = await projectLifecycleSourceMaterial(projectionInput(workspace, 'requirements'));
    expect(result).toMatchObject({ state: 'ambiguous', lens: 'requirements' });
  });

  test('does not guess a single package from one shared brand term', async () => {
    fs.rmSync(path.join(workspace, 'genesis', 'artifacts', 'export-packs', 'billing-security-delivery-pack'), { recursive: true });
    writePack(workspace, 'categoric-p3-cross-entity-category-learning-transfer');
    const result = await projectLifecycleSourceMaterial({
      workspacePath: workspace,
      specId: 'categoric-consolidated-reporting-program',
      specTitle: 'Categoric Consolidated Reporting Program',
      specContent: {},
      lens: 'planning',
    });
    expect(result).toMatchObject({ state: 'not_found', lens: 'planning' });
  });

  test('allows a bounded title match only when at least two terms agree', async () => {
    const result = await projectLifecycleSourceMaterial({
      workspacePath: workspace,
      specId: 'billing-security-reporting',
      specTitle: 'Billing Security Reporting',
      specContent: {},
      lens: 'planning',
    });
    expect(result).toMatchObject({
      state: 'available',
      match: {
        method: 'title_overlap',
        referencesMatched: [],
      },
    });
  });

  test('projects a current Genesis v3 draft manifest as context without inventing authority hashes', async () => {
    fs.rmSync(path.join(workspace, 'genesis', 'artifacts', 'export-packs'), { recursive: true });
    const packageId = 'categoric-consolidated-reporting-kit';
    const directory = path.join(workspace, 'genesis', 'artifacts', 'export-packs', packageId);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'PRD.md'), '# Categoric Consolidated Reporting\n\n## Package intent\nBounded reporting.');
    fs.writeFileSync(path.join(directory, 'index.html'), '<h1>Categoric Consolidated Reporting</h1>');
    fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
      schemaVersion: 'genesis.package/v3',
      contractVersion: 'genesis-package.v3',
      packagePath: `genesis/artifacts/export-packs/${packageId}`,
      title: 'Categoric Consolidated Reporting',
      status: 'draft',
      publicationStatus: 'draft-not-published',
      authoritative: false,
      contentHash: hash('categoric-v3-content'),
      documents: [{ path: 'PRD.md', title: 'PRD', kind: 'prd' }],
      views: [{ path: 'index.html', type: 'html' }],
    }, null, 2));

    const result = await projectLifecycleSourceMaterial({
      workspacePath: workspace,
      workspaceId: 'categoric',
      specId: 'categoric-consolidated-reporting-program',
      specTitle: 'Categoric Consolidated Reporting Program',
      specContent: {},
      lens: 'planning',
    });

    expect(result).toMatchObject({
      state: 'available',
      package: {
        packageId,
        authoritative: false,
        previewHash: null,
        snapshotHash: null,
      },
      authority: {
        status: 'context_only',
        reasonCode: 'authority_receipt_not_declared',
      },
      match: { method: 'title_overlap' },
    });
    if (result.state !== 'available') return;
    expect(result.artifacts.map((artifact) => artifact.name)).toEqual(['PRD.md', 'manifest.json', 'index.html']);
    expect(result.synthesis.sections).toEqual([
      expect.objectContaining({ title: 'Mission and scope', content: 'Bounded reporting.' }),
    ]);
    expect(lifecycleSourceEvidenceProjection(result)).toBeNull();
  });

  test('opens only an allowlisted package artifact and preserves its source line', async () => {
    const projected = await projectLifecycleSourceMaterial(projectionInput(workspace, 'planning'));
    expect(projected.state).toBe('available');
    if (projected.state !== 'available') return;
    const prd = projected.artifacts.find((artifact) => artifact.name === 'PRD.md');
    expect(prd).toBeDefined();
    process.env.RORCA_EDITOR_BIN = '/bin/cat';
    let launch: EditorLaunch | null = null;

    const result = await openLifecycleSourceArtifact({
      workspacePath: workspace,
      artifacts: projected.artifacts,
      relativePath: prd!.relativePath,
      action: 'open',
      line: 12,
      column: 3,
    }, async (request) => { launch = request; });

    expect(result).toMatchObject({ opened: true, action: 'open', relativePath: prd!.relativePath, editor: 'cat', line: 12, column: 3 });
    expect(launch).toMatchObject({ command: '/bin/cat', args: [path.join(fs.realpathSync(workspace), prd!.relativePath)] });
  });

  test('reads a bounded line-addressable preview and fails closed on source drift', async () => {
    const projected = await projectLifecycleSourceMaterial(projectionInput(workspace, 'planning'));
    expect(projected.state).toBe('available');
    if (projected.state !== 'available') return;
    const prd = projected.artifacts.find((artifact) => artifact.name === 'PRD.md');
    expect(prd).toBeDefined();

    const preview = await readLifecycleSourceArtifact({
      workspacePath: workspace,
      artifacts: projected.artifacts,
      relativePath: prd!.relativePath,
      startLine: 3,
      endLine: 7,
    });
    expect(preview).toMatchObject({
      name: 'PRD.md',
      contentType: 'markdown',
      startLine: 3,
      endLine: 7,
      stale: false,
      projectedContentHash: prd!.contentHash,
    });
    expect(preview.content).toContain('## Intent');

    fs.appendFileSync(path.join(workspace, prd!.relativePath), '\nChanged after projection.\n');
    await expect(readLifecycleSourceArtifact({
      workspacePath: workspace,
      artifacts: projected.artifacts,
      relativePath: prd!.relativePath,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      details: expect.objectContaining({
        reasonCode: 'LIFECYCLE_SOURCE_ARTIFACT_HASH_MISMATCH',
        projectedContentHash: prd!.contentHash,
        actualContentHash: expect.stringMatching(/^sha256:/),
      }),
    });
  });

  test('returns a typed not-found error when a projected artifact disappears', async () => {
    const projected = await projectLifecycleSourceMaterial(projectionInput(workspace, 'planning'));
    expect(projected.state).toBe('available');
    if (projected.state !== 'available') return;
    const prd = projected.artifacts.find((artifact) => artifact.name === 'PRD.md');
    expect(prd).toBeDefined();
    fs.rmSync(path.join(workspace, prd!.relativePath));

    await expect(readLifecycleSourceArtifact({
      workspacePath: workspace,
      artifacts: projected.artifacts,
      relativePath: prd!.relativePath,
    })).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });

  test('rejects a caller-supplied traversal even when disguised as an artifact', async () => {
    const outside = path.join(workspace, 'outside.md');
    fs.writeFileSync(outside, 'outside');
    const forged: LifecycleSourceArtifact = {
      name: 'outside.md', label: 'Outside', role: 'other', relativePath: 'outside.md', sizeBytes: 7,
      modifiedAt: new Date(0).toISOString(), contentHash: hash('outside'),
    };
    await expect(openLifecycleSourceArtifact({
      workspacePath: workspace,
      artifacts: [forged],
      relativePath: 'outside.md',
      action: 'open',
    }, async () => undefined)).rejects.toThrow(/outside the workspace export root/);
  });
});
