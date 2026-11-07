/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertCurrentSpecExportKit,
  assertSealedSpecExportKit,
  buildSpecExportKitPromptSection,
  compileSpecExportKit,
  inspectSpecExportKit,
  publishSpecExportKit,
  sealSpecExportKit,
} from '../spec-export-kit';

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-export-kit-'));
}

function spec(architecture = 'Route requests through the canonical service boundary.'): Record<string, unknown> {
  return {
    id: 'deterministic-kit',
    slug: 'deterministic-kit',
    title: 'Deterministic Kit',
    source: 'skill-first',
    userStories: [{
      id: 'KIT-001',
      title: 'Publish a kit',
      description: 'Publish deterministic documents with the canonical spec.',
      acceptanceCriteria: ['The manifest covers every artifact.'],
      dependsOn: [],
      passes: false,
    }],
    exportKit: {
      schemaVersion: 'rorca.export-kit-input.v1',
      product: {
        problem: 'Canonical specs need durable execution documents.',
        targetUsers: ['Spec authors', 'Execution agents'],
        outcomes: ['One verifiable source of truth'],
      },
      scope: { inScope: ['PRD', 'SDD', 'PLAN'], outOfScope: ['Runtime telemetry'] },
      requirements: {
        functional: [{ id: 'REQ-001', statement: 'Publish all kit artifacts.', acceptanceCriteria: ['All hashes verify.'] }],
        successMetrics: ['Every persisted spec has a current kit.'],
        nonGoals: ['Free-form generated documents'],
      },
      design: {
        architecture,
        components: [{ name: 'Compiler', responsibility: 'Compile exact bytes.', boundaries: ['No LLM calls'] }],
        dataChanges: ['Append-only generation ledger'],
        apiChanges: ['Read current kit'],
        securityAndPrivacy: ['Reject path traversal'],
        migrations: ['Create generation ledger'],
        operationalConcerns: ['Crash-safe publication'],
      },
      delivery: {
        storyOrder: ['KIT-001'],
        dependencies: [],
        verification: ['Run deterministic parity checks.'],
        rollout: ['Backfill legacy specs explicitly.'],
        rollback: ['Retain immutable generations.'],
      },
      sources: [{
        kind: 'genesis-package',
        reference: 'genesis/artifacts/export-packs/research/package.json',
        contentHash: `sha256:${'9'.repeat(64)}`,
        role: 'research-provenance',
        citationRefs: ['chunk-17'],
      }],
    },
  };
}

describe('spec export kit', () => {
  let root: string;

  beforeEach(() => {
    delete process.env.RORCA_EXPORT_KIT_FAILPOINT;
    root = workspace();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.RORCA_EXPORT_KIT_FAILPOINT;
  });

  it('compiles byte-identical artifacts and hashes from identical input', () => {
    const first = compileSpecExportKit(spec());
    const second = compileSpecExportKit(JSON.parse(JSON.stringify(spec())));

    expect(second).toEqual(first);
    expect(first.manifest.artifacts.map((artifact) => artifact.path)).toEqual([
      'spec.json', 'PRD.md', 'SDD.md', 'PLAN.md',
    ]);
    expect(first.files['PRD.md']).toContain('genesis/artifacts/export-packs/research/package.json');
    expect(first.files['PRD.md']).toContain('chunk-17');
  });

  it('changes spec, SDD, and manifest identities when architecture changes', () => {
    const first = compileSpecExportKit(spec('Architecture A'));
    const second = compileSpecExportKit(spec('Architecture B'));

    expect(second.identity.specMaterialHash).not.toBe(first.identity.specMaterialHash);
    expect(second.identity.manifestHash).not.toBe(first.identity.manifestHash);
    expect(second.identity.artifacts.design.contentHash).not.toBe(first.identity.artifacts.design.contentHash);
  });

  it('publishes idempotently and detects artifact tampering', () => {
    const document = spec();
    const identity = publishSpecExportKit(root, document);
    document.exportKitIdentity = identity;

    expect(publishSpecExportKit(root, document)).toEqual(identity);
    expect(assertCurrentSpecExportKit(root, document)).toEqual(identity);

    fs.appendFileSync(path.join(root, identity.artifacts.design.path), '\nTAMPERED\n');
    expect(inspectSpecExportKit(root, document)).toMatchObject({ status: 'tampered' });
    expect(() => assertCurrentSpecExportKit(root, document)).toThrow(/tampered/i);
  });

  it('seals exactly one approval authority and rejects another', () => {
    const document = spec();
    document.exportKitIdentity = publishSpecExportKit(root, document);

    const first = sealSpecExportKit(root, document, { actorId: 'user-1', approvalReceiptId: 'receipt-1' });

    expect(first.sealHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(assertSealedSpecExportKit(root, document)).toEqual(document.exportKitIdentity);
    expect(() => sealSpecExportKit(root, document, { actorId: 'user-2', approvalReceiptId: 'receipt-2' }))
      .toThrow(/different approval authority/i);
  });
  it('recovers deterministically when interrupted before generation publication', () => {
    const document = spec();
    const compiled = compileSpecExportKit(document);
    process.env.RORCA_EXPORT_KIT_FAILPOINT = 'before_generation_publication';
    expect(() => publishSpecExportKit(root, document)).toThrow(/before_generation_publication/);
    expect(fs.existsSync(path.join(root, compiled.identity.kitPath))).toBe(false);

    delete process.env.RORCA_EXPORT_KIT_FAILPOINT;
    const identity = publishSpecExportKit(root, document);
    document.exportKitIdentity = identity;
    expect(assertCurrentSpecExportKit(root, document)).toEqual(identity);
  });

  it('adopts the exact immutable generation after interruption before pointer publication', () => {
    const document = spec();
    const compiled = compileSpecExportKit(document);
    process.env.RORCA_EXPORT_KIT_FAILPOINT = 'after_generation_publication';
    expect(() => publishSpecExportKit(root, document)).toThrow(/after_generation_publication/);
    expect(fs.existsSync(path.join(root, compiled.identity.kitPath, 'manifest.json'))).toBe(true);

    delete process.env.RORCA_EXPORT_KIT_FAILPOINT;
    const identity = publishSpecExportKit(root, document);
    document.exportKitIdentity = identity;
    expect(assertCurrentSpecExportKit(root, document)).toEqual(identity);
  });

  it('injects exact PRD, SDD, and PLAN bytes only from a sealed execution kit', () => {
    const document = spec();
    document.exportKitIdentity = publishSpecExportKit(root, document);
    expect(() => buildSpecExportKitPromptSection(root, document)).toThrow(/not sealed/i);
    sealSpecExportKit(root, document, { actorId: 'user-1', approvalReceiptId: 'receipt-1' });
    const prompt = buildSpecExportKitPromptSection(root, document);

    expect(prompt).toContain('## Bound Rorca Export Kit');
    expect(prompt).toContain('=== REQUIREMENTS');
    expect(prompt).toContain('=== DESIGN');
    expect(prompt).toContain('=== DELIVERY');
    expect(prompt).toContain('Route requests through the canonical service boundary.');
  });
});
