/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { stripAppendedContextBlock } from './spec-stage-fingerprints';

export const CONTEXT_BEARING_STORY_FIELDS = ['description', 'acceptanceCriteria'] as const;
export const STORY_CONTENT_ONLY_FIELDS = ['title', 'dependsOn'] as const;
export const METADATA_ONLY_STORY_FIELDS = ['complexity', 'priority', 'timeoutMinutes', 'model', 'excluded'] as const;

export type SpecEditChangeClass = 'metadata-only' | 'story-content-only' | 'context-bearing';

export interface SpecEditChangeClassification {
  changeClass: SpecEditChangeClass;
  changedFields: string[];
}

export interface SpecEditPostSaveOptions {
  enrich: boolean;
  matchSkills: boolean;
  memorySynthesis: boolean;
}

export interface SpecEditPostSaveDecision extends SpecEditChangeClassification {
  requestedPostSave: SpecEditPostSaveOptions;
  effectivePostSave: SpecEditPostSaveOptions;
}

interface SpecEditStoryInput {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  acceptanceCriteria?: unknown;
  dependsOn?: unknown;
  [key: string]: unknown;
}

export interface SpecEditInput {
  title?: unknown;
  userStories?: SpecEditStoryInput[];
  stories?: SpecEditStoryInput[];
  [key: string]: unknown;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(asString);
}

function sortedStrings(value: unknown): string[] {
  return asStringArray(value).sort((a, b) => a.localeCompare(b));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function equalJson(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

function storiesFromSpec(input: SpecEditInput): SpecEditStoryInput[] {
  if (Array.isArray(input.userStories)) return input.userStories;
  if (Array.isArray(input.stories)) return input.stories;
  return [];
}

function storyId(story: SpecEditStoryInput): string {
  return asString(story.id);
}

function storiesById(input: SpecEditInput): Map<string, SpecEditStoryInput> {
  return new Map(storiesFromSpec(input).map((story, index) => [storyId(story) || `__index_${index}`, story]));
}

function nonUserStoryTopLevel(input: SpecEditInput): Record<string, unknown> {
  const { userStories: _userStories, stories: _stories, generatedAt: _generatedAt, ...rest } = input;
  return rest;
}

function storyWithoutKnownStageFields(story: SpecEditStoryInput): Record<string, unknown> {
  const {
    id: _id,
    title: _title,
    description: _description,
    acceptanceCriteria: _acceptanceCriteria,
    dependsOn: _dependsOn,
    ...rest
  } = story;
  return rest;
}

/**
 * Classify a spec edit by the most expensive post-save stage it invalidates.
 *
 * Context-bearing is deliberately narrow: only story description and
 * acceptanceCriteria drive L5 enrichment. Story title and dependsOn changes are
 * structural/content changes for skill matching only. Everything else is
 * metadata for post-save purposes and must not enqueue durable enrich/match work.
 */
export function classifySpecEditChange(before: SpecEditInput, after: SpecEditInput): SpecEditChangeClassification {
  const changedFields = new Set<string>();
  let sawStoryContentOnlyChange = false;
  let sawMetadataOnlyChange = !equalJson(nonUserStoryTopLevel(before), nonUserStoryTopLevel(after));

  const beforeStories = storiesById(before);
  const afterStories = storiesById(after);
  const allStoryIds = new Set([...beforeStories.keys(), ...afterStories.keys()]);

  for (const id of allStoryIds) {
    const oldStory = beforeStories.get(id);
    const nextStory = afterStories.get(id);
    const prefix = id.startsWith('__index_') ? 'story' : `story.${id}`;

    if (!oldStory || !nextStory) {
      changedFields.add(`${prefix}.presence`);
      return { changeClass: 'context-bearing', changedFields: [...changedFields].sort() };
    }

    if (stripAppendedContextBlock(oldStory.description) !== stripAppendedContextBlock(nextStory.description)) {
      changedFields.add(`${prefix}.description`);
      return { changeClass: 'context-bearing', changedFields: [...changedFields].sort() };
    }

    if (!equalJson(asStringArray(oldStory.acceptanceCriteria), asStringArray(nextStory.acceptanceCriteria))) {
      changedFields.add(`${prefix}.acceptanceCriteria`);
      return { changeClass: 'context-bearing', changedFields: [...changedFields].sort() };
    }

    if (asString(oldStory.title) !== asString(nextStory.title)) {
      changedFields.add(`${prefix}.title`);
      sawStoryContentOnlyChange = true;
    }

    if (!equalJson(sortedStrings(oldStory.dependsOn), sortedStrings(nextStory.dependsOn))) {
      changedFields.add(`${prefix}.dependsOn`);
      sawStoryContentOnlyChange = true;
    }

    if (!equalJson(storyWithoutKnownStageFields(oldStory), storyWithoutKnownStageFields(nextStory))) {
      changedFields.add(`${prefix}.metadata`);
      sawMetadataOnlyChange = true;
    }
  }

  if (sawStoryContentOnlyChange) {
    return { changeClass: 'story-content-only', changedFields: [...changedFields].sort() };
  }

  if (sawMetadataOnlyChange || changedFields.size === 0) {
    return { changeClass: 'metadata-only', changedFields: [...changedFields].sort() };
  }

  return { changeClass: 'metadata-only', changedFields: [...changedFields].sort() };
}

export function resolveSpecEditPostSaveDecision(input: {
  before: SpecEditInput;
  after: SpecEditInput;
  requestedPostSave: SpecEditPostSaveOptions;
}): SpecEditPostSaveDecision {
  const classification = classifySpecEditChange(input.before, input.after);
  const base = input.requestedPostSave;
  return {
    ...classification,
    requestedPostSave: base,
    effectivePostSave: {
      ...base,
      enrich: classification.changeClass === 'context-bearing' && base.enrich,
      matchSkills: classification.changeClass !== 'metadata-only' && base.matchSkills,
    },
  };
}
