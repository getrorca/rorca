/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatSkillsSection, resolveMatchedSkills } from '../skill-execution';
import { SkillRegistry } from '../skill-registry';

function markdown(name: string, body: string, rorcaMetadata: string[] = []): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${name} execution guidance`,
    ...(rorcaMetadata.length > 0 ? ['metadata:', '  rorca:', ...rorcaMetadata.map(line => `    ${line}`)] : []),
    '---',
    body,
  ].join('\n');
}

describe('registry-identity skill execution', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-skill-execution-'));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  function writePackage(category: string, name: string, body: string, metadata: string[] = []): string {
    const packageRoot = path.join(workspace, '.rorca', 'skills', category, name);
    fs.mkdirSync(packageRoot, { recursive: true });
    const filePath = path.join(packageRoot, 'SKILL.md');
    fs.writeFileSync(filePath, markdown(name, body, metadata));
    return filePath;
  }

  test('loads the exact discovered package entrypoint rather than reconstructing a flat filename', () => {
    const entrypoint = writePackage('canon', 'architecture-review', 'PACKAGE GUIDANCE');
    const flatPath = path.join(workspace, '.rorca', 'skills', 'architecture-review.md');
    fs.writeFileSync(flatPath, markdown('different-flat-name', 'WRONG FLAT GUIDANCE'));

    const registry = new SkillRegistry().discoverFilesystem(workspace);
    const resolution = resolveMatchedSkills(registry, [
      { name: 'architecture-review', relevance: 9, reason: 'architecture work' },
    ], 'codex', 1_000);

    expect(resolution.skills).toHaveLength(1);
    expect(resolution.skills[0]).toMatchObject({
      identity: 'rorca-skills:canon/architecture-review/SKILL.md',
      filePath: fs.realpathSync(entrypoint),
      packageRoot: fs.realpathSync(path.dirname(entrypoint)),
      content: 'PACKAGE GUIDANCE',
    });
    expect(formatSkillsSection(resolution)).toContain('PACKAGE GUIDANCE');
    expect(formatSkillsSection(resolution)).not.toContain('WRONG FLAT GUIDANCE');
  });

  test('exposes package-root metadata but never auto-injects references, assets, or scripts', () => {
    const entrypoint = writePackage('canon', 'secure-review', 'ENTRYPOINT ONLY');
    fs.mkdirSync(path.join(path.dirname(entrypoint), 'references'));
    fs.mkdirSync(path.join(path.dirname(entrypoint), 'scripts'));
    fs.writeFileSync(path.join(path.dirname(entrypoint), 'references', 'DETAIL.md'), 'REFERENCE SECRET');
    fs.writeFileSync(path.join(path.dirname(entrypoint), 'scripts', 'run.sh'), 'SCRIPT PAYLOAD');

    const registry = new SkillRegistry().discoverFilesystem(workspace);
    const section = formatSkillsSection(resolveMatchedSkills(registry, [
      { name: 'secure-review', relevance: 8 },
    ], 'opencode', 1_000));

    expect(section).toContain('Entrypoint: .rorca/skills/canon/secure-review/SKILL.md');
    expect(section).toContain('Package root: .rorca/skills/canon/secure-review');
    expect(section).toContain('Do not load all references/assets or execute scripts merely because they exist.');
    expect(section).not.toContain('REFERENCE SECRET');
    expect(section).not.toContain('SCRIPT PAYLOAD');
  });

  test('continues after an oversized high-relevance skill so a later smaller skill is injected', () => {
    writePackage('canon', 'huge', 'x'.repeat(400));
    writePackage('canon', 'small', 'small');
    const registry = new SkillRegistry().discoverFilesystem(workspace);

    const resolution = resolveMatchedSkills(registry, [
      { name: 'huge', relevance: 10 },
      { name: 'small', relevance: 7 },
    ], 'codex', 100);

    expect(resolution.skills.map(skill => skill.name)).toEqual(['small']);
    expect(resolution.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'huge', code: 'over-budget' }),
    ]));
    const section = formatSkillsSection(resolution);
    expect(section).toContain('small');
    expect(Math.ceil(section.length / 4)).toBeLessThanOrEqual(resolution.tokenBudget);
    expect(resolution.usedTokens).toBe(Math.ceil(section.length / 4));
  });

  test('reserves budget for already-selected required guidance while preserving relevance prompt order', () => {
    writePackage('canon', 'optional', 'o'.repeat(24)); // 6 tokens
    writePackage('canon', 'required', 'r'.repeat(24), ['priority: required']);
    writePackage('canon', 'tiny-required', 'tiny', ['required: true']);
    const registry = new SkillRegistry().discoverFilesystem(workspace);

    const resolution = resolveMatchedSkills(registry, [
      { name: 'optional', relevance: 10 },
      { name: 'required', relevance: 8 },
      { name: 'tiny-required', relevance: 7 },
    ], 'opencode', 170);

    expect(resolution.skills.map(skill => skill.name)).toEqual(['required', 'tiny-required']);
    expect(resolution.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'optional', code: 'over-budget' }),
    ]));
    expect(Math.ceil(formatSkillsSection(resolution).length / 4)).toBeLessThanOrEqual(resolution.tokenBudget);
  });

  test.each(['legacy', 'standard'] as const)('keeps the higher-precedence Rorca winner when a differing %s Claude skill is shadowed', (form) => {
    writePackage('canon', 'native-review', 'RORCA INLINE WINNER');
    const claudeRoot = path.join(workspace, '.claude', 'skills');
    if (form === 'legacy') {
      fs.mkdirSync(claudeRoot, { recursive: true });
      fs.writeFileSync(path.join(claudeRoot, 'native-review.md'), markdown('native-review', 'CLAUDE SHADOWED'));
    } else {
      fs.mkdirSync(path.join(claudeRoot, 'native-review'), { recursive: true });
      fs.writeFileSync(path.join(claudeRoot, 'native-review', 'SKILL.md'), markdown('native-review', 'CLAUDE SHADOWED'));
    }

    const registry = new SkillRegistry().discoverFilesystem(workspace);
    const resolution = resolveMatchedSkills(registry, [
      { name: 'native-review', relevance: 9 },
    ], 'claude', 1_000);

    expect(resolution.skills).toHaveLength(1);
    expect(resolution.skills[0]).toMatchObject({ source: 'rorca-skills', content: 'RORCA INLINE WINNER' });
    expect(resolution.omissions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'native-agent-skill' }),
    ]));
  });

  test('suppresses inline injection when the deterministic winner itself is Claude-native', () => {
    const claudePackage = path.join(workspace, '.claude', 'skills', 'native-only');
    fs.mkdirSync(claudePackage, { recursive: true });
    fs.writeFileSync(path.join(claudePackage, 'SKILL.md'), markdown('native-only', 'CLAUDE NATIVE'));
    const registry = new SkillRegistry().discoverFilesystem(workspace);
    const resolution = resolveMatchedSkills(registry, [{ name: 'native-only', relevance: 9 }], 'claude', 1_000);
    expect(resolution.skills).toEqual([]);
    expect(resolution.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'native-only', code: 'native-agent-skill' }),
    ]));
  });

  test('bounds provenance and many omission diagnostics inside the declared token budget', () => {
    writePackage('canon', 'small', 'small');
    const registry = new SkillRegistry().discoverFilesystem(workspace);
    const suggestions = [
      { name: 'small', relevance: 10 },
      ...Array.from({ length: 100 }, (_, index) => ({ name: `missing-${index}`, relevance: 9 - index / 100 })),
    ];
    const resolution = resolveMatchedSkills(registry, suggestions, 'codex', 100);
    const section = formatSkillsSection(resolution);
    expect(resolution.omissions).toHaveLength(100);
    expect(resolution.skills.map(skill => skill.name)).toEqual(['small']);
    expect(Math.ceil(section.length / 4)).toBeLessThanOrEqual(100);
    expect(resolution.usedTokens).toBe(Math.ceil(section.length / 4));
  });

  test('reports unknown, duplicate, disabled, and selector-ineligible guidance honestly', () => {
    writePackage('canon', 'disabled', 'disabled', []);
    writePackage('canon', 'risk-review', 'risk', ['risk-levels: [high]']);
    const disabledPath = path.join(workspace, '.rorca', 'skills', 'canon', 'disabled', 'SKILL.md');
    fs.writeFileSync(disabledPath, markdown('disabled', 'disabled').replace('---\ndisabled', 'disable-model-invocation: true\n---\ndisabled'));

    const registry = new SkillRegistry().discoverFilesystem(workspace);
    const resolution = resolveMatchedSkills(registry, [
      { name: 'missing', relevance: 10 },
      { name: 'risk-review', relevance: 9 },
      { name: 'disabled', relevance: 8 },
      { name: 'risk-review', relevance: 7 },
    ], 'codex', 1_000, { risks: ['low'] });

    expect(resolution.skills).toEqual([]);
    expect(resolution.omissions.map(omission => omission.code)).toEqual(expect.arrayContaining([
      'unknown-skill', 'ineligible', 'model-invocation-disabled', 'duplicate-suggestion',
    ]));
  });
});
