/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'crypto';

export interface StageFingerprintStoryInput {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  acceptanceCriteria?: unknown;
  dependsOn?: unknown;
}

export interface StageFingerprintSpecInput {
  title?: unknown;
  userStories?: StageFingerprintStoryInput[];
  stories?: StageFingerprintStoryInput[];
}

export interface SpecStageFingerprints {
  enrichFingerprint: string;
  matchSkillsFingerprint: string;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(asString);
}

export function stripAppendedContextBlock(description: unknown): string {
  return asString(description).replace(/(?:\n\n|\n)?## Context\n[\s\S]*$/u, '');
}

function sortedStrings(value: unknown): string[] {
  return asStringArray(value).sort((a, b) => a.localeCompare(b));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

function storiesFromSpec(input: StageFingerprintSpecInput): StageFingerprintStoryInput[] {
  if (Array.isArray(input.userStories)) return input.userStories;
  if (Array.isArray(input.stories)) return input.stories;
  return [];
}

function orderStories(stories: StageFingerprintStoryInput[]): StageFingerprintStoryInput[] {
  return [...stories].sort((a, b) => {
    const aId = asString(a.id);
    const bId = asString(b.id);
    if (aId !== bId) return aId.localeCompare(bId);
    return asString(a.title).localeCompare(asString(b.title));
  });
}

export function computeSpecStageFingerprints(input: StageFingerprintSpecInput): SpecStageFingerprints {
  const stories = orderStories(storiesFromSpec(input));

  const enrichPayload = {
    specTitle: asString(input.title),
    stories: stories.map((story) => ({
      id: asString(story.id),
      description: stripAppendedContextBlock(story.description),
      acceptanceCriteria: asStringArray(story.acceptanceCriteria),
      dependsOn: sortedStrings(story.dependsOn),
    })),
  };

  const matchSkillsPayload = {
    stories: stories.map((story) => ({
      id: asString(story.id),
      title: asString(story.title),
      description: asString(story.description),
      acceptanceCriteria: asStringArray(story.acceptanceCriteria),
    })),
  };

  return {
    enrichFingerprint: hashPayload(enrichPayload),
    matchSkillsFingerprint: hashPayload(matchSkillsPayload),
  };
}

export function readStageFingerprintsFromSummary(value: unknown): Partial<SpecStageFingerprints> {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.enrichFingerprint === 'string' ? { enrichFingerprint: record.enrichFingerprint } : {}),
    ...(typeof record.matchSkillsFingerprint === 'string' ? { matchSkillsFingerprint: record.matchSkillsFingerprint } : {}),
  };
}
