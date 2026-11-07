/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { queryOne } from '../db/index';
import { ConflictError, ValidationError } from './errors';

export interface PersistedReviewComment {
  id: string;
  spec_id: string;
  story_id: string;
  body: string;
  author_name: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
  review_persona?: string | null;
  review_type?: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface PersistReviewCommentInput {
  workspaceId: string;
  specId: string;
  storyId: string;
  body: string;
  authorName: string;
  reviewPersona: string | null;
  reviewType: string | null;
  actorScope: 'guest' | 'operator' | 'system';
  replayKey: string;
}


function deterministicCommentId(input: PersistReviewCommentInput): string {
  const scope = JSON.stringify([input.actorScope, input.workspaceId, input.replayKey, 'add-review-comment']);
  const bytes = Buffer.from(crypto.createHash('sha256').update(scope).digest('hex').slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sameSemantic(existing: PersistedReviewComment, input: PersistReviewCommentInput): boolean {
  return existing.spec_id === input.specId
    && existing.story_id === input.storyId
    && existing.body === input.body
    && (existing.author_name ?? existing.display_name ?? '') === input.authorName
    && (existing.review_persona ?? null) === input.reviewPersona
    && (existing.review_type ?? null) === input.reviewType;
}

/** Canonical replay-safe persistence used by HTTP routes and the execution child. */
export async function persistReviewComment(
  input: PersistReviewCommentInput,
): Promise<{ comment: PersistedReviewComment; replayed: boolean }> {
  if (!input.workspaceId || !input.specId || !input.storyId || !input.body || !input.authorName) {
    throw new ValidationError('Review comment persistence requires workspace, spec, story, body, and actor');
  }
  if (input.workspaceId.length > 200 || input.specId.length > 200 || input.storyId.length > 200
    || input.authorName.length > 200 || input.body.length > 100_000
    || String(input.reviewPersona ?? '').length > 200 || String(input.reviewType ?? '').length > 200) {
    throw new ValidationError('Review comment persistence fields exceed their allowed size');
  }
  if (!input.replayKey || Buffer.byteLength(input.replayKey, 'utf8') > 200) {
    throw new ValidationError('Review comment replay key must contain between 1 and 200 bytes');
  }

  const id = deterministicCommentId(input);
  const inserted = await queryOne<PersistedReviewComment>(
    `INSERT INTO story_comments
       (id, spec_id, story_id, user_id, body, author_name, review_persona, review_type)
     VALUES ($1, $2, $3, NULL, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [id, input.specId, input.storyId, input.body,
      input.authorName, input.reviewPersona, input.reviewType],
  );
  if (inserted) return { comment: inserted, replayed: false };

  const existing = await queryOne<PersistedReviewComment>(
    'SELECT * FROM story_comments WHERE id = $1',
    [id],
  );
  if (!existing || !sameSemantic(existing, input)) {
    throw new ConflictError('Idempotency key is already bound to different review comment semantics');
  }
  return { comment: existing, replayed: true };
}

