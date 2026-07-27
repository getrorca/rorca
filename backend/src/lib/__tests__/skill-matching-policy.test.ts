/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { heuristicMatchSkills } from '../match-skills-heuristic';
import {
  buildEligibleSkillCatalog,
  eligibleSkillsForStory,
  matchingDefaultsFromSpec,
  skillEligibilityForStory,
  validateSuggestedSkillsForStory,
} from '../skill-matching-policy';
import type { Skill, SkillSelectors } from '../skill-registry';

function skill(name: string, selectors?: Partial<SkillSelectors>, options: { disabled?: boolean; description?: string } = {}): Skill {
  return {
    metadata: {
      name,
      description: options.description ?? `${name} security validation testing`,
      category: 'Security',
      tags: ['security'],
      disableModelInvocation: options.disabled,
      selectors: {
        phases: selectors?.phases ?? [],
        artifacts: selectors?.artifacts ?? [],
        risks: selectors?.risks ?? [],
        priority: selectors?.priority ?? 'normal',
      },
    },
    identity: `rorca-skills:canon/${name}/SKILL.md`,
    promptText: `${name} guidance`,
    filePath: `/workspace/.rorca/skills/canon/${name}/SKILL.md`,
    packageRoot: `/workspace/.rorca/skills/canon/${name}`,
    discoveryRoot: '/workspace/.rorca/skills',
    relativePath: `canon/${name}/SKILL.md`,
    format: 'agent-skill-package',
    source: 'rorca-skills',
  };
}

describe('deterministic skill matching policy', () => {
  const general = skill('general-review');
  const highRiskSdd = skill('high-risk-sdd', {
    phases: ['architecture_review'],
    artifacts: ['sdd'],
    risks: ['high'],
  });
  const implementation = skill('implementation-review', { phases: ['implementation_review'] });
  const manualOnly = skill('manual-only', undefined, { disabled: true });
  const skills = [general, highRiskSdd, implementation, manualOnly];

  test('combines explicit story selectors, tags, and deterministic spec defaults', () => {
    const defaults = matchingDefaultsFromSpec({ mode: 'impl', riskLevel: 'medium' });
    expect(skillEligibilityForStory({
      id: 'US-001',
      title: 'Architecture',
      phase: 'architecture_review',
      artifactTypes: ['sdd'],
      tags: ['risk:high', 'artifact:adr'],
    }, defaults)).toEqual({
      phases: ['architecture_review'],
      artifacts: ['sdd', 'adr'],
      risks: ['medium', 'high'],
    });
  });

  test('fails constrained dimensions closed and never exposes model-invocation-disabled skills', () => {
    expect(eligibleSkillsForStory({
      id: 'US-001', title: 'Architecture', phase: 'architecture_review', artifacts: ['sdd'], risk: 'high',
    }, skills).map(item => item.metadata.name)).toEqual(['general-review', 'high-risk-sdd']);

    expect(eligibleSkillsForStory({
      id: 'US-002', title: 'Unknown risk', phase: 'architecture_review', artifacts: ['sdd'],
    }, skills).map(item => item.metadata.name)).toEqual(['general-review']);
  });

  test('builds a per-story catalog so an LLM sees only eligible names', () => {
    const catalog = buildEligibleSkillCatalog([
      { id: 'US-A', title: 'SDD', phase: 'architecture_review', artifacts: ['sdd'], risk: 'high' },
      { id: 'US-B', title: 'Code', phase: 'implementation_review' },
    ], skills);

    const [first, second] = catalog.split('\n\n');
    expect(first).toContain('[US-A]');
    expect(first).toContain('high-risk-sdd:');
    expect(first).not.toContain('implementation-review:');
    expect(second).toContain('[US-B]');
    expect(second).toContain('implementation-review:');
    expect(second).not.toContain('high-risk-sdd:');
    expect(catalog).not.toContain('manual-only:');
  });

  test('validates LLM output against exact eligible registry names and deduplicates deterministically', () => {
    const warnings: string[] = [];
    const validated = validateSuggestedSkillsForStory(
      { id: 'US-001', title: 'Code', phase: 'implementation_review' },
      [
        { name: 'implementation-review', relevance: 7, reason: 'implementation work' },
        { name: 'IMPLEMENTATION-REVIEW', relevance: 9, reason: 'higher confidence' },
        { name: 'high-risk-sdd', relevance: 10, reason: 'LLM tried to activate ineligible guidance' },
        { name: 'invented-governance-gate', relevance: 10, reason: 'invented' },
        { name: 'general-review', relevance: 99, reason: 'invalid score' },
        { name: 'manual-only', relevance: 8, reason: 'manual only' },
      ],
      skills,
      {},
      warning => warnings.push(warning),
    );

    expect(validated).toEqual([
      { name: 'implementation-review', relevance: 9, reason: 'higher confidence' },
    ]);
    expect(warnings.join('\n')).toContain('ineligible skill "high-risk-sdd"');
    expect(warnings.join('\n')).toContain('unknown skill "invented-governance-gate"');
    expect(warnings.join('\n')).toContain('malformed skill "general-review"');
    expect(warnings.join('\n')).toContain('ineligible skill "manual-only"');
    expect(warnings.join('\n')).toContain('Deduplicated skill');
  });

  test('heuristic fallback ranks only deterministically eligible guidance', () => {
    const matches = heuristicMatchSkills([
      {
        id: 'US-001',
        title: 'Implement security validation tests',
        description: 'Add implementation security validation coverage',
      },
    ], skills, { phases: ['implementation_review'] });

    expect(matches[0].suggestedSkills.map(item => item.name)).toEqual(expect.arrayContaining([
      'general-review', 'implementation-review',
    ]));
    expect(matches[0].suggestedSkills.map(item => item.name)).not.toContain('high-risk-sdd');
    expect(matches[0].suggestedSkills.map(item => item.name)).not.toContain('manual-only');
  });
});
