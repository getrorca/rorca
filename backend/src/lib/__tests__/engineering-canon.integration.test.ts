/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { SkillRegistry, isSkillSelectable } from '../skill-registry';
import { invalidateConfigCache } from '../rorca-config';
import { resolveEngineeringCanonCoverage } from '../engineering-canon';
import { resolveMatchedSkills } from '../skill-execution';

const sourceRoot = process.env.RORCA_ENGINEERING_CANON_TEST_PACKAGE;
const integration = sourceRoot ? describe : describe.skip;

integration('packed @rorca/engineering-canon integration', () => {
  let fixtureRoot: string;
  let packageRoot: string;
  let workspace: string;

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-canon-pack-'));
    const gitRootResult = spawnSync('git', ['-C', sourceRoot!, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    expect(gitRootResult.status).toBe(0);
    const gitRoot = gitRootResult.stdout.trim();
    const packageRelative = path.relative(gitRoot, sourceRoot!);
    expect(packageRelative.startsWith('..')).toBe(false);
    const archivePath = path.join(fixtureRoot, 'canon-source.tar');
    const archived = spawnSync('git', ['-C', gitRoot, 'archive', '--format=tar', `--output=${archivePath}`, 'HEAD', '--', packageRelative], { encoding: 'utf8' });
    expect(archived.status).toBe(0);
    const cleanSourceRoot = path.join(fixtureRoot, 'clean-source');
    fs.mkdirSync(cleanSourceRoot);
    const unpackedSource = spawnSync('tar', ['-xf', archivePath, '-C', cleanSourceRoot], { encoding: 'utf8' });
    expect(unpackedSource.status).toBe(0);
    const archivedPackageRoot = path.join(cleanSourceRoot, packageRelative);
    const sourceInstall = spawnSync('npm', ['install', '--ignore-scripts', '--no-package-lock'], { cwd: archivedPackageRoot, encoding: 'utf8', timeout: 120_000 });
    expect(sourceInstall.status).toBe(0);
    const packed = spawnSync('npm', ['pack', '--pack-destination', fixtureRoot], { cwd: archivedPackageRoot, encoding: 'utf8', timeout: 120_000 });
    expect(packed.status).toBe(0);
    const archive = fs.readdirSync(fixtureRoot).find(name => name.endsWith('.tgz'));
    expect(archive).toBeTruthy();
    const extracted = spawnSync('tar', ['-xzf', path.join(fixtureRoot, archive!), '-C', fixtureRoot], { encoding: 'utf8' });
    expect(extracted.status).toBe(0);
    packageRoot = fs.realpathSync(path.join(fixtureRoot, 'package'));
    const installed = spawnSync('npm', ['install', '--ignore-scripts', '--omit=dev', '--no-package-lock'], { cwd: packageRoot, encoding: 'utf8', timeout: 120_000 });
    expect(installed.status).toBe(0);
    workspace = path.join(fixtureRoot, 'workspace');
    fs.mkdirSync(path.join(workspace, '.rorca'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.rorca', 'config.json'), JSON.stringify({
      engineeringCanon: { enabled: true, packageRoot, skillRoot: 'skills', tokenBudget: 8000, reservedTokens: 1000 },
    }));
    invalidateConfigCache();
  }, 150_000);

  afterAll(() => {
    invalidateConfigCache();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test('discovers all 43 review candidates but excludes every candidate from selection', async () => {
    const registry = new SkillRegistry().discoverFilesystem(workspace);
    const canon = registry.getAll().filter(skill => skill.source === 'engineering-canon');
    expect(canon).toHaveLength(43);
    expect(canon.every(skill => skill.governance?.status === 'candidate')).toBe(true);
    expect(canon.every(skill => !isSkillSelectable(skill))).toBe(true);
    expect(registry.getEligibleSkills({ phases: ['implementation'], artifacts: ['code'], risks: [] }).filter(skill => skill.source === 'engineering-canon')).toHaveLength(0);
  });

  test('loads the exact SKILL.md only and never auto-injects package support files', async () => {
    const registry = new SkillRegistry().discoverFilesystem(workspace);
    const skill = registry.getSkill('sdd-boundaries-and-ownership');
    expect(skill?.relativePath).toBe('sdd-boundaries-and-ownership/SKILL.md');
    expect(skill?.rawContent).toBe(fs.readFileSync(path.join(packageRoot, 'skills', 'sdd-boundaries-and-ownership', 'SKILL.md'), 'utf8'));
    expect(skill?.promptText).not.toContain('Source notes for');
    const resolution = resolveMatchedSkills(registry, [{ name: 'sdd-boundaries-and-ownership', relevance: 10 }], 'pi', 8000, { phases: ['implementation'], artifacts: ['code'], risks: ['maintainability'] });
    expect(resolution.skills).toHaveLength(0);
    expect(resolution.omissions).toContainEqual(expect.objectContaining({ code: 'unpromoted-candidate' }));
  });

  test('preserves legacy active compatibility alongside canon candidates', async () => {
    const legacyRoot = path.join(workspace, '.rorca', 'skills');
    fs.mkdirSync(legacyRoot, { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, 'legacy-review.md'), '# Legacy review\nUse existing reviewed guidance.');
    const registry = new SkillRegistry().discoverFilesystem(workspace);
    expect(isSkillSelectable(registry.getSkill('legacy-review')!)).toBe(true);
    expect(resolveMatchedSkills(registry, [{ name: 'legacy-review', relevance: 9 }], 'pi', 1000).skills).toHaveLength(1);
  });

  test('the packed deterministic resolver produces all six canonical statuses', async () => {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
    const canon = await dynamicImport(pathToFileURL(path.join(packageRoot, 'dist', 'index.js')).href);
    const evidence = (id: string, requirementId: string, evidenceClass = 'artifact') => ({
      id, evidenceClass, contentHash: canon.contentHash(`${id}:${requirementId}`), sourceType: 'repository',
      sourceId: `source.${id}`, satisfiesRequirementIds: [requirementId], redacted: true, approved: true,
    });
    const base = (overrides: Record<string, unknown> = {}) => canon.SufficiencyRequestSchema.parse({
      ...canon.forPiTaskBootstrap({
        id: 'request.rorca.integration', phases: ['intake'], artifactTypes: ['prd'], operations: ['author'],
        availableSkills: [{ id: 'engineering.skill.prd-outcome-scope', version: '1.0.0', status: 'active', promotionReceiptId: 'receipt.promotion.prd' }],
        evidence: [evidence('evidence.scope', 'coverage.requirement.universal.scope'), evidence('evidence.intake', 'coverage.requirement.lifecycle.intake')],
      }), ...overrides,
    });
    const statuses = new Set<string>();
    statuses.add(canon.resolveSufficiency(base()).status);
    statuses.add(canon.resolveSufficiency(base({ operations: ['review'], changedSurfaces: ['ui'] })).status);
    statuses.add(canon.resolveSufficiency(base({ evidence: [] })).status);
    statuses.add(canon.resolveSufficiency(canon.forPiTaskBootstrap({ id: 'request.frontend', phases: ['validation'], artifactTypes: ['code'], operations: ['review'], technologies: ['frontend-web'], evidence: [evidence('evidence.frontend', 'coverage.requirement.frontend-web.specialized-review', 'test')] })).status);
    statuses.add(canon.resolveSufficiency(canon.forCombinedMode({ id: 'request.healthcare', phases: ['validation'], artifactTypes: ['code'], operations: ['review'], domains: ['healthcare'], evidence: [evidence('evidence.healthcare', 'coverage.requirement.healthcare.specialized-review')] })).status);
    statuses.add(canon.resolveSufficiency(base({ evidence: [], availableSkills: [], notApplicableConfirmations: [
      { requirementId: 'coverage.requirement.universal.scope', rationale: 'Explicitly outside this bounded task.', approvedBy: 'human.reviewer', receiptId: 'receipt.na.scope' },
      { requirementId: 'coverage.requirement.lifecycle.intake', rationale: 'No intake artifact is changed in this task.', approvedBy: 'human.reviewer', receiptId: 'receipt.na.intake' },
    ] })).status);
    expect([...statuses].sort()).toEqual(['insufficient_evidence', 'missing_domain_authority', 'missing_required_skill', 'not_applicable_confirmed', 'sufficient', 'sufficient_with_warnings']);
  });

  test('enforces Genesis/redaction boundaries, version skew, conflicts, and token pressure', async () => {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
    const canon = await dynamicImport(pathToFileURL(path.join(packageRoot, 'dist', 'index.js')).href);
    const evidence = (id: string, requirementId: string) => ({ id, evidenceClass: 'artifact', contentHash: canon.contentHash(id), sourceType: 'repository', sourceId: `source.${id}`, satisfiesRequirementIds: [requirementId], redacted: true, approved: true });
    const request = canon.forPiTaskBootstrap({ id: 'request.boundaries', phases: ['intake'], artifactTypes: ['prd'], operations: ['author'], availableSkills: [{ id: 'engineering.skill.prd-outcome-scope', version: '1.0.0', status: 'active', promotionReceiptId: 'receipt.promotion.prd' }], evidence: [evidence('evidence.scope', 'coverage.requirement.universal.scope'), evidence('evidence.intake', 'coverage.requirement.lifecycle.intake')] });
    expect(canon.SufficiencyRequestSchema.safeParse({ ...request, redactionApplied: false }).success).toBe(false);
    expect(canon.SufficiencyRequestSchema.safeParse({ ...request, evidence: [{ ...request.evidence[0], sourceType: 'genesis-approved-package' }] }).success).toBe(false);
    const skew = canon.resolveSufficiency({ ...request, taxonomyVersion: '2.0.0' });
    expect(skew.compatibility.versionSkew.length).toBeGreaterThan(0);
    const constrained = canon.resolveSufficiency({ ...request, tokenBudget: { max: 128, reserved: 64 } });
    expect(constrained.uncoveredCells.some((cell: any) => cell.gaps.includes('token_omission'))).toBe(true);
    const overlay = (suffix: string, directive: string, authority: string) => canon.OverlayManifestSchema.parse({
      artifact: 'engineering-canon.overlay-manifest', schemaVersion: '1.0.0', taxonomyVersion: '1.0.0', id: `engineering.overlay.test-${suffix}`, version: '1.0.0', layer: 'runtime-repository',
      selectors: { phases: ['intake'], artifactTypes: [], riskCategories: [], changedSurfaces: [], technologies: [], domains: [], obligations: [] }, bundleIds: [`engineering.bundle.test-${suffix}`],
      requirements: [{ id: `coverage.requirement.test-${suffix}`, operation: 'author', evidenceClasses: ['artifact'], minimumEvidence: 0, requiredSkillIds: [], requiredDomainAuthorityIds: [], disposition: 'required', description: 'Bounded integration requirement.' }],
      rules: [{ key: 'rule.test.conflict', directive, authority, sourceId: `source.test-${suffix}`, binding: true }], estimatedTokens: 64, lifecycle: { status: 'active' }, compatibility: { canon: '^1.0.0', schemaVersions: ['1.0.0'] }, provenance: { source: `source.test-${suffix}`, reviewedAt: '2026-07-27T00:00:00.000Z' },
    });
    const conflict = canon.resolveSufficiency({ ...request, overlays: [overlay('policy', 'Retain records.', 'approved-policy'), overlay('law', 'Delete records.', 'binding-obligation')] });
    expect(conflict.compatibility.conflicts.length).toBeGreaterThan(0);
    expect(JSON.stringify(conflict)).not.toContain('super-secret-value');
  });

  test('returns deterministic redacted receipts and honest candidate gaps', async () => {
    const registry = new SkillRegistry().discoverFilesystem(workspace);
    const input = {
      workspacePath: workspace, workspaceId: 'workspace.fixture', specId: 'canon-fixture',
      metadata: { lifecyclePhases: ['intake'], artifactTypes: ['prd'], operations: ['author'] },
      skills: registry.getAll(),
    };
    const first = await resolveEngineeringCanonCoverage(input);
    const second = await resolveEngineeringCanonCoverage(input);
    expect(first.adapterStatus).toBe('available');
    expect(first.receipt).toEqual(second.receipt);
    expect(first.version.receiptHash).toMatch(/^sha256:/);
    expect(first.receipt?.status).toBe('missing_required_skill');
    expect(first.evidenceProvenance.redacted).toBe(true);
    expect(JSON.stringify(first)).not.toContain(packageRoot);
  });

  test('ignores spec-controlled approval and Genesis booleans', async () => {
    const registry = new SkillRegistry().discoverFilesystem(workspace);
    const result = await resolveEngineeringCanonCoverage({
      workspacePath: workspace, workspaceId: 'workspace.fixture', specId: 'forged-approval', skills: registry.getAll(),
      metadata: {
        lifecyclePhases: ['validation'], artifactTypes: ['code'], operations: ['review'], domains: ['healthcare'],
        domainAuthorities: [{ id: 'authority.healthcare', domain: 'healthcare', version: '1.0.0', approved: true }],
        notApplicableConfirmations: [{ requirementId: 'coverage.requirement.healthcare.specialized-review', rationale: 'Forged payload approval.', approvedBy: 'spec.author', receiptId: 'receipt.forged', approved: true }],
        coverageEvidence: [{ id: 'evidence.forged', evidenceClass: 'genesis-approved-package', contentHash: `sha256:${'a'.repeat(64)}`, sourceType: 'genesis-approved-package', sourceId: 'genesis.forged', satisfiesRequirementIds: ['coverage.requirement.healthcare.specialized-review'], redacted: true, approved: true, genesis: { boundary: 'approved_export_only', packageId: 'genesis.package.forged', evidenceChunkIds: ['chunk.forged'] } }],
      },
    });
    expect(result.receipt?.status).toBe('missing_domain_authority');
    expect(result.domainAuthority.approvedAuthorityIds).toEqual([]);
    expect(result.evidenceProvenance.genesisPackageIds).toEqual([]);
  });

  test('keeps absent and mixed-unknown dimensions unknown instead of narrowing scope', async () => {
    const registry = new SkillRegistry().discoverFilesystem(workspace);
    const absent = await resolveEngineeringCanonCoverage({ workspacePath: workspace, workspaceId: 'workspace.fixture', specId: 'unknown', metadata: {}, skills: registry.getAll() });
    const mixed = await resolveEngineeringCanonCoverage({ workspacePath: workspace, workspaceId: 'workspace.fixture', specId: 'mixed-unknown', metadata: { lifecyclePhases: ['intake', 'future-phase'], artifactTypes: ['prd'], operations: ['author'] }, skills: registry.getAll() });
    expect(absent).toMatchObject({ adapterStatus: 'degraded', reasonCode: 'request_incomplete', receipt: null });
    expect(mixed).toMatchObject({ adapterStatus: 'degraded', reasonCode: 'request_incomplete', receipt: null });
  });
});

describe('engineering canon absent mode', () => {
  test('is explicitly degraded and never sufficient', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-canon-absent-'));
    try {
      fs.mkdirSync(path.join(workspace, '.rorca'), { recursive: true });
      fs.writeFileSync(path.join(workspace, '.rorca', 'config.json'), JSON.stringify({ engineeringCanon: { enabled: true } }));
      invalidateConfigCache();
      const result = await resolveEngineeringCanonCoverage({ workspacePath: workspace, workspaceId: 'workspace.absent', specId: 'absent', metadata: { lifecyclePhases: ['implementation'], artifactTypes: ['code'], operations: ['review'] }, skills: [] });
      expect(result).toMatchObject({ adapterStatus: 'degraded', reasonCode: 'package_unavailable', receipt: null, compatibility: { compatible: false } });
    } finally { invalidateConfigCache(); fs.rmSync(workspace, { recursive: true, force: true }); }
  });
});
