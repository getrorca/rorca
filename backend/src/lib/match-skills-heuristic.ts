/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { Skill } from './skill-registry';

export interface HeuristicSkillStory {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
}

export interface HeuristicSuggestedSkill {
  name: string;
  relevance: number;
  reason: string;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'if', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'use', 'via', 'with', 'without', 'while', 'than', 'then', 'their', 'them', 'they', 'you', 'your', 'our', 'its', 'can', 'will', 'not', 'does', 'did', 'done', 'add', 'update', 'make', 'keep', 'show', 'work', 'works', 'working', 'user', 'users', 'story', 'stories',
]);

const CATEGORY_HINTS: Record<string, string[]> = {
  Frontend: ['ui', 'frontend', 'react', 'component', 'panel', 'modal', 'view', 'banner', 'settings'],
  Backend: ['backend', 'api', 'route', 'server', 'worker', 'pipeline', 'queue'],
  Testing: ['test', 'tests', 'coverage', 'regression', 'verify', 'validation'],
  DevOps: ['docker', 'helm', 'deploy', 'deployment', 'install', 'ci', 'cd'],
  Security: ['auth', 'authentication', 'authorization', 'secret', 'redact', 'token', 'credential'],
  Database: ['database', 'postgres', 'sql', 'migration', 'supabase', 'neon', 'graph', 'age'],
  Workflow: ['workflow', 'orchestration', 'pipeline', 'queue', 'job', 'repair'],
  Adversarial: ['risk', 'assumption', 'challenge', 'edge', 'failure'],
  General: [],
};

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function buildStoryTokens(story: HeuristicSkillStory): string[] {
  return unique(tokenize([
    story.title,
    story.description ?? '',
    ...(story.acceptanceCriteria ?? []),
  ].join(' ')));
}

function buildSkillTokens(skill: Skill): string[] {
  return unique(tokenize([
    skill.metadata.name,
    skill.metadata.description,
    skill.metadata.category ?? '',
    ...(skill.metadata.tags ?? []),
  ].join(' ')));
}

function scoreSkillForStory(storyTokens: string[], skill: Skill): { score: number; overlap: string[] } {
  const storySet = new Set(storyTokens);
  const skillTokens = buildSkillTokens(skill);
  const overlap = skillTokens.filter((token) => storySet.has(token));
  let score = overlap.length * 3;

  const category = skill.metadata.category ?? 'General';
  for (const hint of CATEGORY_HINTS[category] ?? []) {
    if (storySet.has(hint)) score += 2;
  }

  const nameTokens = tokenize(skill.metadata.name);
  for (const token of nameTokens) {
    if (storySet.has(token)) score += 4;
  }

  return { score, overlap: unique(overlap) };
}

function relevanceForScore(score: number): number {
  if (score >= 12) return 9;
  if (score >= 9) return 8;
  if (score >= 6) return 7;
  if (score >= 4) return 6;
  return 4;
}

export function heuristicMatchSkills(
  stories: HeuristicSkillStory[],
  skills: Skill[],
): Array<{ storyId: string; suggestedSkills: HeuristicSuggestedSkill[] }> {
  return stories.map((story) => {
    const storyTokens = buildStoryTokens(story);
    const ranked = skills
      .map((skill) => {
        const { score, overlap } = scoreSkillForStory(storyTokens, skill);
        return { skill, score, overlap };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(({ skill, score, overlap }) => ({
        name: skill.metadata.name,
        relevance: relevanceForScore(score),
        reason: overlap.length > 0
          ? `Heuristic fallback matched story terms to skill metadata: ${overlap.slice(0, 4).join(', ')}`
          : `Heuristic fallback matched the story to the ${skill.metadata.category ?? 'General'} skill category`,
      }));

    return {
      storyId: story.id,
      suggestedSkills: ranked,
    };
  });
}
