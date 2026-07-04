/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { queryOne } from '../db/index';
import { append, MEMORY_CATEGORIES, type MemoryCategory, type MemoryEntry } from './memory-ledger';
import { embedText, prepareText } from './embedding-pipeline';
import { broadcastAll } from './sse-hub';
import { invalidateMemory } from './context-cache';
import { ValidationError } from './errors';
import { normalizeRelatedFiles, type JsonObject } from './context-capture';

export const CANONICAL_MEMORY_LEDGER_PATH = 'MEMORY.md';

export const MEMORY_SOURCE_TYPES = ['synthesis', 'manual', 'mcp', 'auto-extracted', 'import'] as const;
export type MemorySourceType = typeof MEMORY_SOURCE_TYPES[number];

export interface PromoteMemoryInput {
  workspaceId: string;
  workspacePath: string;
  category: string;
  title: string;
  rule: string;
  context: string;
  source: string;
  sourceType: MemorySourceType;
  sourceStoryId?: string | null;
  sourceSpecId?: string | null;
  sourceRunId?: number | string | null;
  confidence?: 'high' | 'medium' | 'low';
  relatedFiles?: unknown;
  provenance?: JsonObject;
}

export interface PromoteMemoryResult {
  memoryId: string;
  entry: MemoryEntry;
  relatedFiles: string[];
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function toRunId(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferStoryIdFromSource(source: string): string | null {
  const trimmed = source.trim();
  if (/^[A-Z]{1,6}-\d{1,4}$/.test(trimmed)) return trimmed;
  const storyMatch = trimmed.match(/^story-(.+)$/i);
  if (storyMatch?.[1]) return storyMatch[1].trim();
  return null;
}

function assertMemoryCategory(category: string): asserts category is MemoryCategory {
  if (!MEMORY_CATEGORIES.includes(category as MemoryCategory)) {
    throw new ValidationError(`category must be one of: ${MEMORY_CATEGORIES.join(', ')}`);
  }
}

async function emitMemoryCreatedWalEvent(params: {
  workspaceId: string;
  memoryId: string;
  category: string;
  content: string;
  storyId?: string | null;
  specId?: string | null;
  relatedFiles?: string[];
  provenance?: JsonObject;
}): Promise<void> {
  try {
    const walPayload = JSON.stringify({
      id: params.memoryId,
      text: params.content,
      category: params.category,
      relatedFiles: params.relatedFiles ?? [],
      provenance: params.provenance ?? {},
    });
    const walEvent = await queryOne<{ id: number }>(
      `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id`,
      ['memory_created', params.workspaceId, params.specId ?? null, params.storyId ?? null, walPayload],
    );
    if (walEvent) {
      broadcastAll({
        id: walEvent.id,
        event_type: 'memory_created',
        workspace_id: params.workspaceId,
        spec_id: params.specId ?? null,
        story_id: params.storyId ?? null,
        payload: walPayload,
        ts: new Date().toISOString(),
      } as any);
    }
  } catch {
    // Best-effort WAL emission must not block memory persistence.
  }
}

export async function promoteMemory(input: PromoteMemoryInput): Promise<PromoteMemoryResult> {
  assertMemoryCategory(input.category);

  if (!MEMORY_SOURCE_TYPES.includes(input.sourceType)) {
    throw new ValidationError(`sourceType must be one of: ${MEMORY_SOURCE_TYPES.join(', ')}`);
  }

  const title = input.title.trim();
  const rule = input.rule.trim();
  const context = input.context.trim();
  const source = input.source.trim();
  if (!title) throw new ValidationError('title is required');
  if (!rule) throw new ValidationError('rule is required');
  if (!source) throw new ValidationError('source is required');
  if (source.length > 64) throw new ValidationError('source must be 64 characters or fewer');

  const relatedFiles = normalizeRelatedFiles(input.relatedFiles);
  const entry: MemoryEntry = {
    date: todayDate(),
    category: input.category,
    title,
    rule,
    context,
    source,
  };

  append(input.workspacePath, entry, CANONICAL_MEMORY_LEDGER_PATH);

  const content = `${title}: ${rule}`;
  const storyId = input.sourceStoryId ?? inferStoryIdFromSource(source);
  const sourceRunId = toRunId(input.sourceRunId);
  const confidence = input.confidence ?? 'medium';
  const provenance = input.provenance ?? {};

  let embedding: number[] | null = null;
  try {
    embedding = await embedText(prepareText('memory', content));
  } catch {
    embedding = null;
  }

  let inserted: { id: string } | undefined;
  const embeddingStr = embedding ? `[${embedding.join(',')}]` : null;
  if (embeddingStr) {
    try {
      inserted = await queryOne<{ id: string }>(
        `INSERT INTO memories (
           workspace_id, category, content, source_story_id, source_spec_id, source_run_id,
           confidence, related_files, embedding, source_type, source, provenance
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::vector, $10, $11, $12::jsonb)
         RETURNING id::text AS id`,
        [
          input.workspaceId,
          input.category,
          content,
          storyId,
          input.sourceSpecId ?? null,
          sourceRunId,
          confidence,
          JSON.stringify(relatedFiles),
          embeddingStr,
          input.sourceType,
          source,
          JSON.stringify(provenance),
        ],
      );
    } catch {
      // pgvector may be unavailable in some managed/test DBs; retry without embedding.
    }
  }

  if (!inserted) {
    inserted = await queryOne<{ id: string }>(
      `INSERT INTO memories (
         workspace_id, category, content, source_story_id, source_spec_id, source_run_id,
         confidence, related_files, source_type, source, provenance
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb)
       RETURNING id::text AS id`,
      [
        input.workspaceId,
        input.category,
        content,
        storyId,
        input.sourceSpecId ?? null,
        sourceRunId,
        confidence,
        JSON.stringify(relatedFiles),
        input.sourceType,
        source,
        JSON.stringify(provenance),
      ],
    );
  }

  if (!inserted) {
    throw new ValidationError('Failed to persist memory entry');
  }

  await emitMemoryCreatedWalEvent({
    workspaceId: input.workspaceId,
    memoryId: inserted.id,
    category: input.category,
    content,
    storyId,
    specId: input.sourceSpecId ?? null,
    relatedFiles,
    provenance,
  });
  invalidateMemory(input.workspaceId);

  return {
    memoryId: inserted.id,
    entry,
    relatedFiles,
  };
}
