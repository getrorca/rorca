/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MAX_SKILL_FILE_BYTES,
  SkillRegistry,
  isSkillEligible,
  parseSkillSelectors,
  parseSkillSdlcHints,
} from '../skill-registry';

function packageMarkdown(name: string, description = `${name} guidance`, metadata = '', body = `Apply ${name}.`): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    ...(metadata ? metadata.split('\n') : []),
    '---',
    body,
  ].join('\n');
}

describe('SkillRegistry portable Agent Skill packages', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-skill-packages-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('recursively discovers only SKILL.md package entrypoints and preserves canonical roots', () => {
    const packageRoot = path.join(workspace, '.rorca', 'skills', 'review', 'architecture-review');
    fs.mkdirSync(path.join(packageRoot, 'references'), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'SKILL.md'), packageMarkdown('architecture-review'));
    fs.writeFileSync(path.join(packageRoot, 'references', 'DETAILS.md'), 'SUPPORT FILE MUST NOT BECOME A SKILL');
    fs.writeFileSync(path.join(packageRoot, 'scripts', 'audit.sh'), '#!/bin/sh\necho never-auto-run\n');

    const registry = new SkillRegistry().discoverFilesystem(workspace);
    const skills = registry.getAll();

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      identity: 'rorca-skills:review/architecture-review/SKILL.md',
      filePath: fs.realpathSync(path.join(packageRoot, 'SKILL.md')),
      packageRoot: fs.realpathSync(packageRoot),
      discoveryRoot: fs.realpathSync(path.join(workspace, '.rorca', 'skills')),
      relativePath: 'review/architecture-review/SKILL.md',
      format: 'agent-skill-package',
      source: 'rorca-skills',
      promptText: 'Apply architecture-review.',
    });
    expect(skills[0].rawContent).toBe(packageMarkdown('architecture-review'));
    expect(registry.getSkill('DETAILS')).toBeUndefined();
    expect(registry.getAll().map(skill => skill.promptText).join('\n')).not.toContain('SUPPORT FILE');
  });

  test('keeps direct-root legacy Markdown compatible while ignoring nested non-entrypoint Markdown', () => {
    const root = path.join(workspace, '.rorca', 'skills');
    fs.mkdirSync(path.join(root, 'references'), { recursive: true });
    fs.writeFileSync(path.join(root, 'legacy.md'), 'Legacy flat guidance.');
    fs.writeFileSync(path.join(root, 'references', 'not-a-skill.md'), 'Reference only.');

    const registry = new SkillRegistry().discoverFilesystem(workspace);
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.getSkill('legacy')).toMatchObject({
      promptText: 'Legacy flat guidance.',
      format: 'legacy-flat',
      relativePath: 'legacy.md',
    });
  });

  test('uses explicit deterministic collision precedence and retains shadowed candidates for native detection', () => {
    const rorcaRoot = path.join(workspace, '.rorca', 'skills');
    const rorcaPackage = path.join(rorcaRoot, 'canon', 'same');
    const claudePackage = path.join(workspace, '.claude', 'skills', 'same');
    fs.mkdirSync(rorcaPackage, { recursive: true });
    fs.mkdirSync(claudePackage, { recursive: true });
    fs.writeFileSync(path.join(rorcaRoot, 'same.md'), packageMarkdown('same', 'legacy winner candidate', '', 'rorca flat'));
    fs.writeFileSync(path.join(rorcaPackage, 'SKILL.md'), packageMarkdown('same', 'package winner', '', 'rorca package'));
    fs.writeFileSync(path.join(claudePackage, 'SKILL.md'), packageMarkdown('same', 'claude native', '', 'claude package'));

    const registry = new SkillRegistry().discoverFilesystem(workspace);

    expect(registry.getSkill('same')).toMatchObject({
      promptText: 'rorca package',
      source: 'rorca-skills',
      format: 'agent-skill-package',
    });
    expect(registry.getCandidates('same')).toHaveLength(3);
    expect(registry.hasSkillFromSource('same', 'claude-skills')).toBe(true);
    expect(registry.getWarnings().filter(warning => warning.code === 'duplicate')).toHaveLength(2);
    expect(registry.getWarnings().find(warning => warning.code === 'duplicate')?.reason).toContain('kept rorca-skills:canon/same/SKILL.md');
  });

  test('detects both standard and legacy Claude native skill forms', () => {
    const claudeRoot = path.join(workspace, '.claude', 'skills');
    fs.mkdirSync(path.join(claudeRoot, 'standard'), { recursive: true });
    fs.writeFileSync(path.join(claudeRoot, 'legacy.md'), packageMarkdown('legacy'));
    fs.writeFileSync(path.join(claudeRoot, 'standard', 'SKILL.md'), packageMarkdown('standard'));

    const registry = new SkillRegistry().discoverFilesystem(workspace);
    expect(registry.hasSkillFromSource('legacy', 'claude-skills')).toBe(true);
    expect(registry.hasSkillFromSource('standard', 'claude-skills')).toBe(true);
  });

  test.each(['.rorca', '.claude'])('rejects a symbolic-link %s skill root before traversing external content', (directory) => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-external-root-'));
    const externalPackage = path.join(external, 'escaped');
    fs.mkdirSync(externalPackage, { recursive: true });
    fs.writeFileSync(path.join(externalPackage, 'SKILL.md'), packageMarkdown('escaped-root'));
    const parent = path.join(workspace, directory);
    fs.mkdirSync(parent, { recursive: true });
    fs.symlinkSync(external, path.join(parent, 'skills'));

    try {
      const registry = new SkillRegistry().discoverFilesystem(workspace);
      expect(registry.getSkill('escaped-root')).toBeUndefined();
      expect(registry.getWarnings()).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'unsafe-symlink', filePath: path.join(parent, 'skills') }),
      ]));
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  test('rejects nested symlinks even when they point to an external valid package', () => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-external-skill-'));
    const externalPackage = path.join(external, 'escaped');
    fs.mkdirSync(externalPackage, { recursive: true });
    fs.writeFileSync(path.join(externalPackage, 'SKILL.md'), packageMarkdown('escaped'));
    const root = path.join(workspace, '.rorca', 'skills');
    fs.mkdirSync(root, { recursive: true });
    fs.symlinkSync(externalPackage, path.join(root, 'escaped'));

    try {
      const registry = new SkillRegistry().discoverFilesystem(workspace);
      expect(registry.getSkill('escaped')).toBeUndefined();
      expect(registry.getWarnings()).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'unsafe-symlink' }),
      ]));
    } finally {
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  (process.platform === 'win32' ? test.skip : test)('skips unreadable entrypoints with a diagnostic', () => {
    const packageRoot = path.join(workspace, '.rorca', 'skills', 'canon', 'unreadable');
    fs.mkdirSync(packageRoot, { recursive: true });
    const entrypoint = path.join(packageRoot, 'SKILL.md');
    fs.writeFileSync(entrypoint, packageMarkdown('unreadable'));
    fs.chmodSync(entrypoint, 0o000);

    try {
      const registry = new SkillRegistry().discoverFilesystem(workspace);
      expect(registry.getSkill('unreadable')).toBeUndefined();
      expect(registry.getWarnings()).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'unreadable-entry', filePath: fs.realpathSync(entrypoint) }),
      ]));
    } finally {
      fs.chmodSync(entrypoint, 0o600);
    }
  });

  test('skips malformed, empty, and oversized packages without losing later valid skills', () => {
    const root = path.join(workspace, '.rorca', 'skills', 'canon');
    for (const name of ['bad-yaml', 'empty', 'oversized', 'valid']) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
    }
    fs.writeFileSync(path.join(root, 'bad-yaml', 'SKILL.md'), '---\nname: [bad\n---\nBody');
    fs.writeFileSync(path.join(root, 'empty', 'SKILL.md'), packageMarkdown('empty', 'empty guidance', '', ''));
    fs.writeFileSync(path.join(root, 'oversized', 'SKILL.md'), Buffer.alloc(MAX_SKILL_FILE_BYTES + 1, 97));
    fs.writeFileSync(path.join(root, 'valid', 'SKILL.md'), packageMarkdown('valid'));

    const registry = new SkillRegistry().discoverFilesystem(workspace);
    expect(registry.getAll().map(skill => skill.metadata.name)).toEqual(['valid']);
    expect(registry.getWarnings().map(warning => warning.code)).toEqual(expect.arrayContaining([
      'malformed-frontmatter', 'empty-guidance', 'oversized',
    ]));
  });

  test('parses standard metadata selectors and applies deterministic fail-closed eligibility', () => {
    const packageRoot = path.join(workspace, '.rorca', 'skills', 'canon', 'data-review');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'SKILL.md'), packageMarkdown(
      'data-review',
      'Review high-risk SDD data changes.',
      [
        'metadata:',
        '  rorca:',
        '    phases: [architecture_review, implementation_review]',
        '    artifact-types: [sdd, code]',
        '    risk-levels: [high, critical]',
        '    priority: required',
        '    enforcement: required',
      ].join('\n'),
    ));

    const skill = new SkillRegistry().discoverFilesystem(workspace).getSkill('data-review');
    expect(skill?.metadata.selectors).toEqual({
      phases: ['architecture_review', 'implementation_review'],
      artifacts: ['sdd', 'code'],
      risks: ['high', 'critical'],
      priority: 'required',
    });
    expect(isSkillEligible(skill!, {
      phases: ['implementation_review'], artifacts: ['code'], risks: ['high'],
    })).toBe(true);
    expect(isSkillEligible(skill!, {
      phases: ['implementation_review'], artifacts: ['code'], risks: ['low'],
    })).toBe(false);
    expect(isSkillEligible(skill!, {
      phases: ['implementation_review'], artifacts: ['code'],
    })).toBe(false);
    expect(skill?.metadata.standardMetadata).toMatchObject({
      rorca: expect.objectContaining({ enforcement: 'required' }),
    });
  });

  test.each([
    '    phases: 42',
    '    artifact-types: { kind: sdd }',
    '    risk-levels: [high, 42]',
    '    priority: sometimes',
  ])('rejects malformed selector metadata instead of broadening eligibility: %s', (selectorLine) => {
    const packageRoot = path.join(workspace, '.rorca', 'skills', 'canon', 'malformed-selector');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'SKILL.md'), packageMarkdown(
      'malformed-selector',
      'Must fail closed.',
      ['metadata:', '  rorca:', selectorLine].join('\n'),
    ));

    const registry = new SkillRegistry().discoverFilesystem(workspace);
    expect(registry.getSkill('malformed-selector')).toBeUndefined();
    expect(registry.getWarnings()).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid-metadata', skillName: 'malformed-selector' }),
    ]));
  });

  test('uses locale-independent code-unit ordering for collision winners', () => {
    const root = path.join(workspace, '.rorca', 'skills');
    for (const category of ['Z-category', 'a-category']) {
      const packageRoot = path.join(root, category, 'same');
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.writeFileSync(path.join(packageRoot, 'SKILL.md'), packageMarkdown('same', category, '', category));
    }
    const registry = new SkillRegistry().discoverFilesystem(workspace);
    expect(registry.getSkill('same')?.promptText).toBe('Z-category');
    expect(registry.getSkill('same')?.relativePath).toBe('Z-category/same/SKILL.md');
  });

  test('accepts portable flat metadata aliases', () => {
    expect(parseSkillSelectors({
      'rorca.phases': 'validation_review,pr_release_review',
      'rorca.artifacts': 'test-result',
      'rorca.risks': 'medium,high',
      'injection-priority': 'required',
    })).toEqual({
      phases: ['validation_review', 'pr_release_review'],
      artifacts: ['test-result'],
      risks: ['medium', 'high'],
      priority: 'required',
    });
  });

  test('parses scope/appliesToStages/enforcement and persists them on skill metadata', () => {
    const packageRoot = path.join(workspace, '.rorca', 'skills', 'universal', 'evidence-discipline');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'SKILL.md'), packageMarkdown(
      'evidence-discipline',
      'Back claims with evidence.',
      [
        'metadata:',
        '  rorca:',
        '    scope: universal',
        '    appliesToStages: [planning, design, testing]',
        '    enforcement: required',
      ].join('\n'),
    ));

    const skill = new SkillRegistry().discoverFilesystem(workspace).getSkill('evidence-discipline');
    expect(skill?.metadata).toMatchObject({
      scope: 'universal',
      appliesToStages: ['planning', 'design', 'testing'],
      enforcement: 'required',
    });
    expect(skill?.rawContent).toContain('scope: universal');
  });

  test('catalog prompt lists scope, appliesToStages, and enforcement', () => {
    const packageRoot = path.join(workspace, '.rorca', 'skills', 'universal', 'traceability');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'SKILL.md'), packageMarkdown(
      'traceability',
      'Link changes to requirements.',
      [
        'metadata:',
        '  rorca:',
        '    scope: universal',
        '    appliesToStages: [planning, deployment]',
        '    enforcement: required',
      ].join('\n'),
    ));

    const catalog = new SkillRegistry().discoverFilesystem(workspace).getCatalogForPrompt();
    expect(catalog).toContain('traceability: Link changes to requirements.');
    expect(catalog).toContain('scope=universal');
    expect(catalog).toContain('stages=planning,deployment');
    expect(catalog).toContain('enforcement=required');
  });

  test.each([
    '    appliesToStages: [planning, build]',
    '    appliesToStages: [verify]',
    '    appliesToStages: [release]',
  ])('rejects an unknown stage id in appliesToStages instead of broadening: %s', (stageLine) => {
    const packageRoot = path.join(workspace, '.rorca', 'skills', 'canon', 'unknown-stage');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'SKILL.md'), packageMarkdown(
      'unknown-stage',
      'Must fail closed.',
      ['metadata:', '  rorca:', stageLine].join('\n'),
    ));

    const registry = new SkillRegistry().discoverFilesystem(workspace);
    expect(registry.getSkill('unknown-stage')).toBeUndefined();
    const warning = registry.getWarnings().find(item => item.code === 'invalid-metadata' && item.skillName === 'unknown-stage');
    expect(warning).toBeDefined();
    expect(warning?.reason).toContain('unknown stage id(s) in appliesToStages');
  });

  test.each([
    '    scope: always',
    '    enforcement: block',
    '    appliesToStages: [planning, 42]',
  ])('rejects malformed scope/appliesToStages/enforcement values: %s', (sdlcLine) => {
    const packageRoot = path.join(workspace, '.rorca', 'skills', 'canon', 'malformed-sdlc');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'SKILL.md'), packageMarkdown(
      'malformed-sdlc',
      'Must fail closed.',
      ['metadata:', '  rorca:', sdlcLine].join('\n'),
    ));

    const registry = new SkillRegistry().discoverFilesystem(workspace);
    expect(registry.getSkill('malformed-sdlc')).toBeUndefined();
    expect(registry.getWarnings()).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid-metadata', skillName: 'malformed-sdlc' }),
    ]));
  });

  test('accepts portable flat aliases for scope/appliesToStages/enforcement', () => {
    expect(parseSkillSdlcHints({
      'rorca.scope': 'universal',
      'rorca.appliesToStages': 'planning,requirements',
      'rorca.enforcement': 'required',
    })).toEqual({
      scope: 'universal',
      appliesToStages: ['planning', 'requirements'],
      enforcement: 'required',
    });
  });
});

const repoUniversalSkillsRoot = path.resolve(__dirname, '..', '..', '..', '..', '.rorca', 'skills', 'universal');
const repoShipsBaselinePack = fs.existsSync(repoUniversalSkillsRoot);

(repoShipsBaselinePack ? test : test.skip)('baseline pack ships the 4 general-sdlc-7 universal skills', () => {
  const expected = ['evidence-discipline', 'reversible-changes', 'no-placeholder-delivery', 'traceability'];
  const names = fs.readdirSync(repoUniversalSkillsRoot).filter(name => fs.statSync(path.join(repoUniversalSkillsRoot, name)).isDirectory());
  expect(names.sort()).toEqual([...expected].sort());

  const registry = new SkillRegistry().discoverFilesystem(path.resolve(repoUniversalSkillsRoot, '..', '..', '..'));
  const universal = registry.getAll().filter(skill => skill.relativePath.startsWith('universal/'));
  expect(universal.map(skill => skill.metadata.name).sort()).toEqual([...expected].sort());
  for (const skill of universal) {
    expect(skill.metadata.scope).toBe('universal');
    expect(skill.metadata.appliesToStages).toEqual([
      'planning', 'requirements', 'design', 'development', 'testing', 'deployment', 'maintenance',
    ]);
    expect(skill.metadata.enforcement).toBe('required');
  }
});
