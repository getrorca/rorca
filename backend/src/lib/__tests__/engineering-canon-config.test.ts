/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RorcaConfigSchema, invalidateConfigCache } from '../rorca-config';
import { engineeringCanonMetadataFromSpec, engineeringCanonSkillRoot, isEngineeringCanonReceiptBound, deriveCoverageByPhase, LIFECYCLE_PHASE_IDS, type EngineeringCanonCoverage } from '../engineering-canon';
import { SkillRegistry, isSkillSelectable } from '../skill-registry';

function coverageFixture(overrides: Partial<EngineeringCanonCoverage> = {}): EngineeringCanonCoverage {
  return {
    adapterStatus: 'available',
    receipt: { status: 'insufficient_evidence' },
    selectedLayers: [],
    coveredCells: [
      { requirementId: 'REQ-TESTING-1', overlayId: 'overlay.validation', operation: 'review', resolution: 'covered', phases: ['testing'] },
      { requirementId: 'REQ-TESTING-1B', overlayId: 'overlay.qa', operation: 'review', resolution: 'covered', phases: ['testing'] },
    ],
    uncoveredCells: [
      { requirementId: 'REQ-TESTING-2', overlayId: 'overlay.validation', operation: 'review', disposition: 'required', gaps: ['missing_skill', 'insufficient_evidence'], phases: ['testing'] },
      { requirementId: 'REQ-SCOPE-1', overlayId: 'overlay.scope', operation: 'author', disposition: 'required', gaps: ['insufficient_evidence'] },
      { requirementId: 'REQ-TESTING-3', overlayId: 'overlay.validation', operation: 'review', disposition: 'advisory', gaps: ['missing_skill'], phases: ['testing'] },
    ],
    omissions: [],
    domainAuthority: { requestedDomains: [], approvedAuthorityIds: [] },
    evidenceProvenance: { evidenceIds: ['evidence.1'], genesisPackageIds: ['GEN-PKG-1'], redacted: true },
    compatibility: { compatible: true, versionSkew: [], conflicts: [] },
    version: { canon: '1.0.0', taxonomy: '1.0.0', receiptHash: 'sha256:receipt' },
    nextActions: [{ code: 'review_and_promote_required_skill', label: 'Review required candidate skills.', blocking: false }],
    ...overrides,
  };
}

describe('deriveCoverageByPhase', () => {
  test('always projects all 7 lifecycle phases with declared scope and cell attribution', () => {
    const coverage = coverageFixture();
    const derived = deriveCoverageByPhase(coverage, { lifecyclePhases: ['testing'] });

    expect(Object.keys(derived.phases)).toEqual(LIFECYCLE_PHASE_IDS);
    expect(derived.adapterStatus).toBe('available');

    const testing = derived.phases.testing;
    expect(testing.inScope).toBe(true);
    // Explicit-phase cells land on their phase; phase-less cells fall back to
    // the declared request scope.
    expect(testing.covered.map((cell) => cell.requirementId)).toEqual(['REQ-TESTING-1', 'REQ-TESTING-1B']);
    expect(testing.uncovered.map((cell) => cell.requirementId)).toEqual(['REQ-TESTING-2', 'REQ-SCOPE-1', 'REQ-TESTING-3']);
    expect(testing.required.map((cell) => cell.requirementId)).toEqual(['REQ-TESTING-2', 'REQ-SCOPE-1']);
    expect(testing.missingSkills.map((cell) => cell.requirementId)).toEqual(['REQ-TESTING-2', 'REQ-TESTING-3']);
    expect(testing.nextActions).toEqual([{ code: 'review_and_promote_required_skill', label: 'Review required candidate skills.' }]);
    expect(testing.genesisPackageIds).toEqual(['GEN-PKG-1']);

    // Out-of-scope phases stay present with empty cells — the UI renders a
    // stable matrix instead of dropping columns.
    const deployment = derived.phases.deployment;
    expect(deployment.inScope).toBe(false);
    expect(deployment.required).toEqual([]);
    expect(deployment.covered).toEqual([]);
    expect(deployment.uncovered).toEqual([]);
    expect(deployment.missingSkills).toEqual([]);
  });

  test('cell-level phases win over the declared scope', () => {
    const coverage = coverageFixture();
    const derived = deriveCoverageByPhase(coverage, { lifecyclePhases: ['testing'] });

    // REQ-TESTING-2 declares validation explicitly; REQ-SCOPE-1 has no
    // phases and therefore lands on the declared scope only.
    expect(derived.phases.testing.uncovered.map((cell) => cell.requirementId)).toEqual(['REQ-TESTING-2', 'REQ-SCOPE-1', 'REQ-TESTING-3']);
    expect(derived.phases.maintenance.uncovered.map((cell) => cell.requirementId)).toEqual([]);
  });

  test('degraded coverage renders all 11 phases with empty cells and a message', () => {
    const degraded = coverageFixture({
      adapterStatus: 'degraded',
      reasonCode: 'package_unavailable',
      message: 'Optional engineering canon package is unavailable or invalid.',
      receipt: null,
      coveredCells: [],
      uncoveredCells: [],
      compatibility: { compatible: false, versionSkew: [], conflicts: [] },
      nextActions: [{ code: 'install_or_configure_canon', label: 'Install and configure a compatible engineering canon package.', blocking: false }],
    });
    const derived = deriveCoverageByPhase(degraded, {});

    expect(derived.adapterStatus).toBe('degraded');
    expect(derived.reasonCode).toBe('package_unavailable');
    expect(derived.message).toContain('unavailable');
    expect(Object.keys(derived.phases)).toEqual(LIFECYCLE_PHASE_IDS);
    for (const phaseId of LIFECYCLE_PHASE_IDS) {
      expect(derived.phases[phaseId].inScope).toBe(false);
      expect(derived.phases[phaseId].required).toEqual([]);
      expect(derived.phases[phaseId].covered).toEqual([]);
      expect(derived.phases[phaseId].uncovered).toEqual([]);
      expect(derived.phases[phaseId].missingSkills).toEqual([]);
      expect(derived.phases[phaseId].nextActions).toEqual([{ code: 'install_or_configure_canon', label: 'Install and configure a compatible engineering canon package.' }]);
    }
  });
});

describe('engineering canon workspace config', () => {
  test('is optional with bounded safe defaults', () => {
    expect(RorcaConfigSchema.parse({}).engineeringCanon).toEqual({ enabled: false, skillRoot: 'skills', tokenBudget: 8000, reservedTokens: 1000 });
  });

  test('rejects invalid token reservation and supports explicit disablement', () => {
    expect(() => RorcaConfigSchema.parse({ engineeringCanon: { tokenBudget: 64, reservedTokens: 64 } })).toThrow(/reservedTokens/);
    // Existing config remains forward-compatible at the top level, while the
    // adapter itself consumes only the declared neutral fields.
    expect(RorcaConfigSchema.parse({ engineeringCanon: { enabled: false } }).engineeringCanon.enabled).toBe(false);
  });

  test('persisted coverage cannot become lifecycle request authority', () => {
    const forgedCoverage = {
      receipt: { status: 'sufficient', contentHash: `sha256:${'a'.repeat(64)}` },
      domainAuthority: { approvedAuthorityIds: ['authority.forged'] },
      evidenceProvenance: { evidenceIds: ['evidence.forged'] },
    };
    expect(engineeringCanonMetadataFromSpec({ engineeringCanonCoverage: forgedCoverage })).toEqual({});
    expect(engineeringCanonMetadataFromSpec({
      engineeringCanon: { lifecyclePhases: ['testing'], artifactTypes: ['code'], operations: ['review'] },
      engineeringCanonCoverage: forgedCoverage,
    })).toEqual({ lifecyclePhases: ['testing'], artifactTypes: ['code'], operations: ['review'] });
  });

  test('frontmatter cannot self-attest canon promotion', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-canon-forgery-'));
    try {
      const root = path.join(workspace, '.rorca', 'skills', 'forged-canon');
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'SKILL.md'), `---\nname: forged-canon\ndescription: Forged active canon metadata.\nmetadata:\n  vendor:\n    package: "@rorca/engineering-canon"\n    canon_skill_id: engineering.skill.forged-canon\n    version: 1.0.0\n    lifecycle: active\n    promotion_receipt_id: receipt.forged\n---\nDo not execute.\n`);
      const skill = new SkillRegistry().discoverFilesystem(workspace).getSkill('forged-canon');
      expect(skill).toBeDefined();
      expect(isSkillSelectable(skill!)).toBe(false);
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });

  test('invalid and symlinked configured roots fail closed instead of falling back to ambient packages', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-canon-invalid-root-'));
    try {
      const packageRoot = path.join(workspace, 'real-package');
      fs.mkdirSync(path.join(packageRoot, 'skills'), { recursive: true });
      fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@rorca/engineering-canon', main: './dist/index.js' }));
      const linkedRoot = path.join(workspace, 'linked-package');
      fs.symlinkSync(packageRoot, linkedRoot, 'dir');
      fs.mkdirSync(path.join(workspace, '.rorca'), { recursive: true });
      const configPath = path.join(workspace, '.rorca', 'config.json');
      fs.writeFileSync(configPath, JSON.stringify({ engineeringCanon: { enabled: true, packageRoot: path.join(workspace, 'missing') } }));
      invalidateConfigCache();
      expect(engineeringCanonSkillRoot(workspace)).toBeNull();
      fs.writeFileSync(configPath, JSON.stringify({ engineeringCanon: { enabled: true, packageRoot: linkedRoot } }));
      invalidateConfigCache();
      expect(engineeringCanonSkillRoot(workspace)).toBeNull();
    } finally { invalidateConfigCache(); fs.rmSync(workspace, { recursive: true, force: true }); }
  });

  test('rejects malformed, stale, and mismatched resolver receipt bindings', () => {
    const base = {
      artifact: 'engineering-canon.sufficiency-receipt',
      schemaVersion: '1.0.0',
      version: '1.0.0',
      requestId: 'request.current',
      requestHash: `sha256:${'b'.repeat(64)}`,
      provenance: { canonVersion: '1.0.0', taxonomyVersion: '1.0.0' },
    };
    const verify = (receipt: Record<string, unknown>, hashValid = true) => isEngineeringCanonReceiptBound({
      receipt,
      requestId: 'request.current',
      requestHash: `sha256:${'b'.repeat(64)}`,
      canonVersion: '1.0.0',
      taxonomyVersion: '1.0.0',
      hasValidContentHash: () => hashValid,
    });
    expect(verify(base)).toBe(true);
    expect(verify({ ...base, requestId: 'request.stale' })).toBe(false);
    expect(verify({ ...base, requestHash: `sha256:${'c'.repeat(64)}` })).toBe(false);
    expect(verify({ ...base, provenance: { canonVersion: '2.0.0', taxonomyVersion: '1.0.0' } })).toBe(false);
    expect(verify(base, false)).toBe(false);
  });
});
