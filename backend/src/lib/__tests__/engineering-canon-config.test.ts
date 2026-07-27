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
import { engineeringCanonMetadataFromSpec, engineeringCanonSkillRoot, isEngineeringCanonReceiptBound } from '../engineering-canon';
import { SkillRegistry, isSkillSelectable } from '../skill-registry';

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
      engineeringCanon: { lifecyclePhases: ['validation'], artifactTypes: ['code'], operations: ['review'] },
      engineeringCanonCoverage: forgedCoverage,
    })).toEqual({ lifecyclePhases: ['validation'], artifactTypes: ['code'], operations: ['review'] });
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
