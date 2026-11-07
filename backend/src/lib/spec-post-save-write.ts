/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Pure generation-safe merge helpers for durable post-save workers. */

import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeSsdlcContractJson } from './ssdlc-contracts';
import { UnprocessableError } from './errors';

type JsonRecord = Record<string, unknown>;
const GENERATED_CONTEXT_PATTERN = /\n\n## Context\n[\s\S]*$/;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizedText(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().replace(/\s+/g, ' ')
    : '';
}

function sortedStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(normalizedText).filter(Boolean).sort()
    : [];
}

/**
 * Fields that make generated annotations stale. Execution controls and result
 * flags are intentionally excluded because workers merge into (never replace)
 * their latest values.
 */
export function computePostSaveWorkerMaterialHash(content: JsonRecord): `sha256:${string}` {
  const stories = (Array.isArray(content.userStories) ? content.userStories : [])
    .filter(isRecord)
    .map((story) => ({
      id: normalizedText(story.id),
      title: normalizedText(story.title),
      description: normalizedText(typeof story.description === 'string'
        ? story.description.replace(GENERATED_CONTEXT_PATTERN, '')
        : story.description),
      acceptanceCriteria: sortedStrings(story.acceptanceCriteria),
      dependsOn: sortedStrings(story.dependsOn ?? story.dependencies),
      tags: sortedStrings(story.tags),
      risk: story.risk ?? null,
      riskLevel: story.riskLevel ?? null,
      lifecycleAnnotations: story.lifecycleAnnotations ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const identity = {
    stories,
    tags: sortedStrings(content.tags),
    risk: content.risk ?? null,
    riskLevel: content.riskLevel ?? null,
    lifecycleAnnotations: content.lifecycleAnnotations ?? null,
  };
  return `sha256:${crypto.createHash('sha256').update(normalizeSsdlcContractJson(identity), 'utf8').digest('hex')}`;
}

function latestStories(content: JsonRecord): JsonRecord[] {
  return (Array.isArray(content.userStories) ? content.userStories : []).filter(isRecord);
}

function assertMaterialUnchanged(content: JsonRecord, expectedMaterialHash: string): void {
  const currentMaterialHash = computePostSaveWorkerMaterialHash(content);
  if (currentMaterialHash !== expectedMaterialHash) {
    throw new UnprocessableError(
      'Spec material changed while post-save work was running',
      'STALE_POST_SAVE_GENERATION',
      { expectedMaterialHash, currentMaterialHash, retryable: true },
    );
  }
}

export interface EnrichmentStoryPatch {
  storyId: string;
  annotation: string;
  sourceDescription?: string;
}

/** Merge only generated Context blocks; all latest metadata and flags survive. */
export function mergeEnrichmentIntoLatest(
  latestContent: JsonRecord,
  expectedMaterialHash: string,
  patches: EnrichmentStoryPatch[],
): JsonRecord {
  assertMaterialUnchanged(latestContent, expectedMaterialHash);
  const byStory = new Map(patches.map((patch) => [patch.storyId, patch.annotation]));
  for (const story of latestStories(latestContent)) {
    const storyId = normalizedText(story.id);
    const annotation = byStory.get(storyId);
    if (!annotation) continue;
    const patch = patches.find((candidate) => candidate.storyId === storyId);
    const description = typeof story.description === 'string' ? story.description : '';
    // A newer annotation/context write is story content too. Preserve it rather
    // than letting an older replay win merely because base material is equal.
    if (patch?.sourceDescription !== undefined && description !== patch.sourceDescription) continue;
    const base = description.replace(GENERATED_CONTEXT_PATTERN, '');
    story.description = `${base}\n\n## Context\n${annotation.trim()}`;
  }
  return latestContent;
}

export interface SkillStoryPatch {
  storyId: string;
  suggestedSkills: unknown[];
  sourceSuggestedSkills?: unknown;
}

/** Merge only suggestedSkills; all latest story and top-level fields survive. */
export function mergeSkillsIntoLatest(
  latestContent: JsonRecord,
  expectedMaterialHash: string,
  patches: SkillStoryPatch[],
): JsonRecord {
  assertMaterialUnchanged(latestContent, expectedMaterialHash);
  const byStory = new Map(patches.map((patch) => [patch.storyId, patch.suggestedSkills]));
  for (const story of latestStories(latestContent)) {
    const storyId = normalizedText(story.id);
    const suggestedSkills = byStory.get(storyId);
    const patch = patches.find((candidate) => candidate.storyId === storyId);
    if (
      suggestedSkills
      && (!patch || !Object.prototype.hasOwnProperty.call(patch, 'sourceSuggestedSkills')
        || normalizeSsdlcContractJson(story.suggestedSkills ?? null) === normalizeSsdlcContractJson(patch.sourceSuggestedSkills ?? null))
    ) {
      story.suggestedSkills = suggestedSkills;
    }
  }
  return latestContent;
}

/** Same-process atomic replacement: no partially written JSON can become visible. */
export function writeSpecAtomically(specPath: string, content: JsonRecord): void {
  const temporaryPath = path.join(
    path.dirname(specPath),
    `.${path.basename(specPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, specPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
}
