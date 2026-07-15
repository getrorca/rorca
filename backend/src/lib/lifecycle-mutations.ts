/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { execute, queryOne } from '../db/index';
import { ConflictError, ValidationError } from './errors';
import { broadcastAll, type WalEvent } from './sse-hub';

export type LifecycleChangeKind =
  | 'evidence_persisted'
  | 'plan_recompiled'
  | 'plan_compilation_failed'
  | 'plans_backfilled'
  | 'decision_created'
  | 'decision_revoked'
  | 'retry_dispatched';

export interface LifecycleInvalidation {
  workspaceId: string;
  specId?: string | null;
  phaseId?: string | null;
  runId?: number | null;
  changeKind: LifecycleChangeKind;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function lifecycleRequestHash(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(canonical(value)).digest('hex')}`;
}

export function requireLifecycleIdempotencyKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key || key.length < 8 || key.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new ValidationError('Idempotency-Key must be 8-200 URL-safe characters', { field: 'Idempotency-Key' });
  }
  return key;
}

interface MutationRequestRow {
  request_hash: string;
  status: 'pending' | 'completed';
  response_status: number | null;
  response_body: unknown;
}

/**
 * Durable replay boundary for lifecycle adapters. The underlying compiler and
 * retry-preview dispatch remain independently idempotent, so a process restart
 * after their commit but before this response commit can safely resume.
 */
export async function runIdempotentLifecycleMutation<T>(input: {
  workspaceId: string;
  operation: string;
  idempotencyKey: string;
  request: unknown;
  responseStatus?: number;
  mutate: () => Promise<T>;
}): Promise<{ value: T; replayed: boolean; responseStatus: number }> {
  const requestHash = lifecycleRequestHash(input.request);
  await execute(
    `INSERT INTO lifecycle_mutation_requests (
       workspace_id, operation, idempotency_key, request_hash, status
     ) VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (workspace_id, operation, idempotency_key) DO NOTHING`,
    [input.workspaceId, input.operation, input.idempotencyKey, requestHash],
  );
  const existing = await queryOne<MutationRequestRow>(
    `SELECT request_hash, status, response_status, response_body
     FROM lifecycle_mutation_requests
     WHERE workspace_id = $1 AND operation = $2 AND idempotency_key = $3`,
    [input.workspaceId, input.operation, input.idempotencyKey],
  );
  if (!existing) throw new ConflictError('Lifecycle mutation idempotency claim could not be acquired');
  if (existing.request_hash !== requestHash) {
    throw new ConflictError('Idempotency-Key was reused with a different lifecycle request', {
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
    });
  }
  if (existing.status === 'completed') {
    return {
      value: existing.response_body as T,
      replayed: true,
      responseStatus: existing.response_status ?? input.responseStatus ?? 200,
    };
  }

  const value = await input.mutate();
  const responseStatus = input.responseStatus ?? 200;
  await execute(
    `UPDATE lifecycle_mutation_requests
     SET status = 'completed', response_status = $4, response_body = $5::jsonb, completed_at = NOW()
     WHERE workspace_id = $1 AND operation = $2 AND idempotency_key = $3
       AND request_hash = $6`,
    [input.workspaceId, input.operation, input.idempotencyKey, responseStatus, JSON.stringify(value), requestHash],
  );
  return { value, replayed: false, responseStatus };
}

/** Persist bounded invalidation metadata, then publish that exact WAL row. */
export async function emitLifecycleInvalidation(input: LifecycleInvalidation): Promise<void> {
  const payload = {
    workspaceId: input.workspaceId,
    specId: input.specId ?? null,
    phaseId: input.phaseId ?? null,
    runId: input.runId ?? null,
    changeKind: input.changeKind,
  };
  const event = await queryOne<WalEvent>(
    `INSERT INTO wal_events (event_type, workspace_id, spec_id, actor, payload)
     VALUES ('lifecycle_changed', $1, $2, 'lifecycle-api', $3::jsonb)
     RETURNING *`,
    [input.workspaceId, input.specId ?? null, JSON.stringify(payload)],
  );
  if (event) broadcastAll(event);
}
