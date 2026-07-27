/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  isSkillEligible,
  type Skill,
  type SkillEligibilityContext,
} from './skill-registry';

export interface SkillMatchStory {
  id: string;
  title?: string;
  phase?: unknown;
  phases?: unknown;
  ssdlcPhase?: unknown;
  lifecyclePhase?: unknown;
  artifacts?: unknown;
  artifactTypes?: unknown;
  expectedArtifacts?: unknown;
  risk?: unknown;
  risks?: unknown;
  riskLevel?: unknown;
  tags?: unknown;
}

export interface MatchingEligibilityDefaults extends SkillEligibilityContext {}

export interface ValidatedSuggestedSkill {
  name: string;
  relevance: number;
  reason: string;
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' && value.trim() ? [value] : [];
}

function tagged(tags: unknown, prefix: string): string[] {
  return list(tags)
    .filter(tag => tag.toLowerCase().startsWith(`${prefix}:`))
    .map(tag => tag.slice(prefix.length + 1));
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

export function skillEligibilityForStory(
  story: SkillMatchStory,
  defaults: MatchingEligibilityDefaults = {},
): SkillEligibilityContext {
  const storyPhases = unique([
    ...list(story.phase),
    ...list(story.phases),
    ...list(story.ssdlcPhase),
    ...list(story.lifecyclePhase),
    ...tagged(story.tags, 'phase'),
  ]);
  return {
    // An explicit story phase narrows rather than broadens a spec default.
    phases: storyPhases.length > 0 ? storyPhases : unique(defaults.phases ?? []),
    artifacts: unique([
      ...(defaults.artifacts ?? []),
      ...list(story.artifacts),
      ...list(story.artifactTypes),
      ...list(story.expectedArtifacts),
      ...tagged(story.tags, 'artifact'),
    ]),
    risks: unique([
      ...(defaults.risks ?? []),
      ...list(story.risk),
      ...list(story.risks),
      ...list(story.riskLevel),
      ...tagged(story.tags, 'risk'),
    ]),
  };
}

/** Automatic matching never exposes user-invocation-only skills to an LLM. */
export function eligibleSkillsForStory(
  story: SkillMatchStory,
  skills: Skill[],
  defaults: MatchingEligibilityDefaults = {},
): Skill[] {
  const context = skillEligibilityForStory(story, defaults);
  return skills.filter(skill => !skill.metadata.disableModelInvocation && isSkillEligible(skill, context));
}

export function matchingDefaultsFromSpec(spec: Record<string, unknown>): MatchingEligibilityDefaults {
  const mode = typeof spec.mode === 'string' ? spec.mode.toLowerCase() : '';
  const explicitPhases = [
    ...list(spec.phase),
    ...list(spec.phases),
    ...list(spec.ssdlcPhase),
    ...list(spec.lifecyclePhase),
  ];
  const defaultPhase = mode === 'qa' || mode === 'journey'
    ? 'validation_review'
    : 'implementation_review';
  return {
    phases: explicitPhases.length > 0 ? unique(explicitPhases) : [defaultPhase],
    artifacts: unique([
      ...list(spec.artifacts),
      ...list(spec.artifactTypes),
      ...list(spec.expectedArtifacts),
    ]),
    risks: unique([
      ...list(spec.risk),
      ...list(spec.risks),
      ...list(spec.riskLevel),
    ]),
  };
}

/** Per-story catalog prevents a ranker from seeing ineligible guidance as selectable. */
export function buildEligibleSkillCatalog(
  stories: SkillMatchStory[],
  skills: Skill[],
  defaults: MatchingEligibilityDefaults = {},
): string {
  return stories.map(story => {
    const eligible = eligibleSkillsForStory(story, skills, defaults);
    const lines = eligible.length > 0
      ? eligible.map(skill => `${skill.metadata.name}: ${skill.metadata.description}`)
      : ['(none)'];
    return [`[${story.id}]`, ...lines].join('\n');
  }).join('\n\n');
}

export function validateSuggestedSkillsForStory(
  story: SkillMatchStory,
  rawSuggestions: unknown,
  allSkills: Skill[],
  defaults: MatchingEligibilityDefaults = {},
  onWarning: (message: string) => void = () => {},
): ValidatedSuggestedSkill[] {
  if (!Array.isArray(rawSuggestions)) return [];
  const allByName = new Map(allSkills.map(skill => [skill.metadata.name.toLowerCase(), skill]));
  const eligibleNames = new Set(eligibleSkillsForStory(story, allSkills, defaults).map(skill => skill.metadata.name.toLowerCase()));
  const validated = new Map<string, ValidatedSuggestedSkill>();

  for (const raw of rawSuggestions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      onWarning(`Stripped malformed skill suggestion for story ${story.id}`);
      continue;
    }
    const record = raw as Record<string, unknown>;
    const rawName = typeof record.name === 'string' ? record.name.trim() : '';
    const relevance = typeof record.relevance === 'number' ? record.relevance : Number.NaN;
    const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
    if (!rawName || !Number.isFinite(relevance) || relevance < 4 || relevance > 10 || !reason) {
      onWarning(`Stripped malformed skill "${rawName || '(unnamed)'}" from story ${story.id}`);
      continue;
    }

    const key = rawName.toLowerCase();
    const skill = allByName.get(key);
    if (!skill) {
      onWarning(`Stripped unknown skill "${rawName}" from story ${story.id}`);
      continue;
    }
    if (!eligibleNames.has(key)) {
      onWarning(`Stripped ineligible skill "${rawName}" from story ${story.id}`);
      continue;
    }

    const suggestion: ValidatedSuggestedSkill = {
      name: skill.metadata.name,
      relevance,
      reason: reason.slice(0, 1_000),
    };
    const existing = validated.get(key);
    if (!existing || suggestion.relevance > existing.relevance) {
      if (existing) onWarning(`Deduplicated skill "${rawName}" for story ${story.id}; kept higher relevance`);
      validated.set(key, suggestion);
    } else {
      onWarning(`Deduplicated skill "${rawName}" for story ${story.id}`);
    }
  }

  return [...validated.values()].sort((left, right) => right.relevance - left.relevance || left.name.localeCompare(right.name));
}
