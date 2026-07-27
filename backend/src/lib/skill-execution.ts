/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as path from 'path';
import {
  isSkillEligible,
  type Skill,
  type SkillEligibilityContext,
  type SkillRegistry,
} from './skill-registry';

export type SkillExecutionAgent = 'claude' | 'opencode' | 'codex' | 'pi';

export interface SuggestedSkillReference {
  name: string;
  relevance: number;
  reason?: string;
}

export interface ResolvedSkill {
  name: string;
  identity: string;
  relevance: number;
  content: string;
  tokens: number;
  filePath: string;
  packageRoot: string;
  relativePath: string;
  source: string;
  required: boolean;
  order: number;
}

export type SkillOmissionCode =
  | 'invalid-suggestion'
  | 'duplicate-suggestion'
  | 'unknown-skill'
  | 'ineligible'
  | 'model-invocation-disabled'
  | 'native-agent-skill'
  | 'empty-guidance'
  | 'over-budget';

export interface SkillOmission {
  name: string;
  code: SkillOmissionCode;
  reason: string;
}

export interface SkillResolution {
  skills: ResolvedSkill[];
  omissions: SkillOmission[];
  usedTokens: number;
  tokenBudget: number;
}

function estimateTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase();
}

function toResolved(skill: Skill, suggestion: SuggestedSkillReference, order: number): ResolvedSkill {
  return {
    name: skill.metadata.name,
    identity: skill.identity,
    relevance: suggestion.relevance,
    content: skill.promptText,
    tokens: estimateTokens(skill.promptText),
    filePath: skill.filePath,
    packageRoot: skill.packageRoot,
    relativePath: skill.relativePath,
    source: skill.source,
    required: skill.metadata.selectors?.priority === 'required',
    order,
  };
}

/**
 * Resolve already-selected story guidance through registry identity/path.
 * This never reconstructs a filename, reads package support files, or executes
 * scripts. Required is an injection-budget hint only and cannot select a skill.
 */
export function resolveMatchedSkills(
  registry: SkillRegistry,
  suggestedSkills: SuggestedSkillReference[],
  agentType: SkillExecutionAgent,
  tokenBudget: number,
  eligibility: SkillEligibilityContext = {},
): SkillResolution {
  const omissions: SkillOmission[] = [];
  const deduped = new Map<string, { suggestion: SuggestedSkillReference; order: number }>();

  suggestedSkills.forEach((suggestion, order) => {
    if (!suggestion || typeof suggestion.name !== 'string' || !suggestion.name.trim()
      || typeof suggestion.relevance !== 'number' || !Number.isFinite(suggestion.relevance)) {
      omissions.push({ name: typeof suggestion?.name === 'string' ? suggestion.name : '(invalid)', code: 'invalid-suggestion', reason: 'Suggestion requires a name and finite relevance score' });
      return;
    }
    const key = normalizedName(suggestion.name);
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, { suggestion, order });
      return;
    }
    if (suggestion.relevance > existing.suggestion.relevance) {
      omissions.push({ name: existing.suggestion.name, code: 'duplicate-suggestion', reason: `Duplicate suggestion replaced by higher relevance ${suggestion.relevance}` });
      deduped.set(key, { suggestion, order: existing.order });
    } else {
      omissions.push({ name: suggestion.name, code: 'duplicate-suggestion', reason: `Duplicate suggestion ignored; kept relevance ${existing.suggestion.relevance}` });
    }
  });

  const ranked = [...deduped.values()]
    .sort((left, right) => right.suggestion.relevance - left.suggestion.relevance || left.order - right.order);
  const candidates: ResolvedSkill[] = [];

  for (const { suggestion, order } of ranked) {
    const skill = registry.getSkill(suggestion.name);
    if (!skill) {
      omissions.push({ name: suggestion.name, code: 'unknown-skill', reason: 'No readable registry entrypoint resolved for this name' });
      continue;
    }
    if (skill.metadata.disableModelInvocation) {
      omissions.push({ name: skill.metadata.name, code: 'model-invocation-disabled', reason: 'Skill frontmatter disables automatic model invocation' });
      continue;
    }
    if (!isSkillEligible(skill, eligibility)) {
      omissions.push({ name: skill.metadata.name, code: 'ineligible', reason: 'Skill metadata selectors do not match this execution context' });
      continue;
    }
    if (agentType === 'claude' && registry.hasSkillFromSource(skill.metadata.name, 'claude-skills')) {
      omissions.push({
        name: skill.metadata.name,
        code: 'native-agent-skill',
        reason: 'Available through Claude native skill discovery (flat or SKILL.md package); duplicate inline injection suppressed',
      });
      continue;
    }
    if (!skill.promptText.trim()) {
      omissions.push({ name: skill.metadata.name, code: 'empty-guidance', reason: 'Resolved registry entrypoint has no guidance body' });
      continue;
    }
    candidates.push(toResolved(skill, suggestion, order));
  }

  const boundedBudget = Math.max(0, Math.floor(tokenBudget));
  const selected = new Set<ResolvedSkill>();
  let usedTokens = 0;
  const choose = (candidate: ResolvedSkill): void => {
    if (candidate.tokens > boundedBudget - usedTokens) {
      omissions.push({
        name: candidate.name,
        code: 'over-budget',
        reason: `Estimated ${candidate.tokens} tokens exceed ${boundedBudget - usedTokens} remaining of ${boundedBudget}`,
      });
      return;
    }
    selected.add(candidate);
    usedTokens += candidate.tokens;
  };

  // Reserve budget for selected required guidance before optional guidance. This
  // changes packing only; final prompt order remains relevance-first.
  for (const candidate of candidates.filter(candidate => candidate.required)) choose(candidate);
  for (const candidate of candidates.filter(candidate => !candidate.required)) choose(candidate);

  return {
    skills: candidates.filter(candidate => selected.has(candidate)),
    omissions,
    usedTokens,
    tokenBudget: boundedBudget,
  };
}

function safeInline(value: string): string {
  return value.replace(/[\r\n`]+/g, ' ').trim().slice(0, 160);
}

/** Format exact entrypoint guidance plus progressive-disclosure provenance. */
export function formatSkillsSection(resolution: SkillResolution): string {
  const sections = resolution.skills.map(skill => {
    const sourcePrefix = skill.source === 'rorca-skills'
      ? '.rorca/skills'
      : skill.source === 'claude-skills'
        ? '.claude/skills'
        : '';
    const entryPath = sourcePrefix && skill.relativePath
      ? `${sourcePrefix}/${skill.relativePath}`
      : skill.filePath;
    const relativePackage = path.posix.dirname(skill.relativePath);
    const packagePath = skill.packageRoot
      ? sourcePrefix
        ? relativePackage === '.' ? sourcePrefix : `${sourcePrefix}/${relativePackage}`
        : skill.packageRoot
      : '';
    const provenance = [
      entryPath ? `Entrypoint: ${entryPath}` : '',
      packagePath ? `Package root: ${packagePath}` : '',
      packagePath && skill.relativePath.endsWith('/SKILL.md')
        ? 'Progressive disclosure: load referenced files from this package root only when needed. Do not load all references/assets or execute scripts merely because they exist.'
        : '',
    ].filter(Boolean).join('\n');
    return `## Skill: ${skill.name} (relevance: ${skill.relevance})\n${provenance}${provenance ? '\n' : ''}${skill.content}`;
  });

  if (resolution.omissions.length > 0) {
    sections.push([
      '## Skill loading notes',
      ...resolution.omissions.map(omission => `- ${safeInline(omission.name)}: ${omission.code} — ${safeInline(omission.reason)}`),
    ].join('\n'));
  }
  return sections.length > 0 ? `\n${sections.join('\n\n')}\n` : '';
}
