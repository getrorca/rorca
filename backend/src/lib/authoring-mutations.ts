/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { transaction } from '../db/index';
import { ConflictError, ValidationError } from './errors';
import { retryHash } from './retry-governance';

export type AuthoringMutationOperation = 'preflight' | 'confirm' | 'persist' | 'persist-batch' | 'approve' | 'compile-legacy';

export interface AuthoringMutationClaim {
  receiptId: string;
  requestHash: string;
  replayed: boolean;
  state: 'claimed' | 'artifact_written' | 'wal_written' | 'completed' | 'recoverable_failure';
  completed: boolean;
  responseStatus: number | null;
  responseBody: Record<string, unknown> | null;
}

export function authoringMutationRequestHash(value: unknown): string {
  return retryHash(value);
}

export function authoringMutationFailpoint(name: string): void {
  if (process.env.NODE_ENV === 'test' && process.env.RORCA_AUTHORING_FAILPOINT === name) {
    throw new Error(`[authoring-failpoint] ${name}`);
  }
}

export async function readAuthoringMutationState(input: {
  workspaceId: string;
  operation: AuthoringMutationOperation;
  idempotencyKey: string;
  requestHash: string;
}): Promise<(AuthoringMutationClaim & { specId: string | null; updatedAt: string }) | null> {
  const row = await transaction(async (client) => (await client.query<{
    receipt_id: string; request_hash: string; state: AuthoringMutationClaim['state'];
    response_status: number | null; response_body: Record<string, unknown> | null;
    spec_id: string | null; updated_at: string;
  }>(
    `SELECT receipt_id, request_hash, state, response_status, response_body, spec_id, updated_at
       FROM authoring_mutation_operations
      WHERE workspace_id = $1 AND operation = $2 AND idempotency_key = $3`,
    [input.workspaceId, input.operation, input.idempotencyKey.trim()],
  )).rows[0]);
  if (!row) return null;
  if (row.request_hash !== input.requestHash) {
    throw new ConflictError('Authoring mutation state query differs from the canonical request hash');
  }
  return {
    receiptId: row.receipt_id,
    requestHash: row.request_hash,
    replayed: true,
    state: row.state,
    completed: row.state === 'completed',
    responseStatus: row.response_status,
    responseBody: row.response_body,
    specId: row.spec_id,
    updatedAt: row.updated_at,
  };
}

export async function claimAuthoringMutation(input: {
  workspaceId: string;
  operation: AuthoringMutationOperation;
  idempotencyKey: string;
  request: unknown;
  specId?: string | null;
  parentReceiptId?: string | null;
}): Promise<AuthoringMutationClaim> {
  const key = input.idempotencyKey.trim();
  if (key.length < 8 || key.length > 200) throw new ValidationError('Idempotency-Key must contain 8 to 200 characters');
  const requestHash = authoringMutationRequestHash(input.request);
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `authoring-mutation:${input.workspaceId}:${input.operation}:${key}`,
    ]);
    const existing = (await client.query<{
      receipt_id: string; request_hash: string; state: string;
      response_status: number | null; response_body: Record<string, unknown> | null;
    }>(
      `SELECT receipt_id, request_hash, state, response_status, response_body
       FROM authoring_mutation_operations
       WHERE workspace_id = $1 AND operation = $2 AND idempotency_key = $3
       FOR UPDATE`,
      [input.workspaceId, input.operation, key],
    )).rows[0];
    if (existing) {
      if (existing.request_hash !== requestHash) throw new ConflictError('Authoring Idempotency-Key was reused with a different request');
      return {
        receiptId: existing.receipt_id,
        requestHash,
        replayed: true,
        state: existing.state as AuthoringMutationClaim['state'],
        completed: existing.state === 'completed',
        responseStatus: existing.response_status,
        responseBody: existing.response_body,
      };
    }
    const inserted = (await client.query<{ receipt_id: string }>(
      `INSERT INTO authoring_mutation_operations (
         workspace_id, operation, idempotency_key, request_hash, state, spec_id, parent_receipt_id
       ) VALUES ($1,$2,$3,$4,'claimed',$5,$6)
       RETURNING receipt_id`,
      [input.workspaceId, input.operation, key, requestHash,
        input.specId ?? null, input.parentReceiptId ?? null],
    )).rows[0];
    if (!inserted) throw new ConflictError('Authoring mutation claim was not persisted');
    return { receiptId: inserted.receipt_id, requestHash, replayed: false, state: 'claimed', completed: false, responseStatus: null, responseBody: null };
  });
}

export async function markAuthoringMutationStage(input: {
  receiptId: string;
  requestHash: string;
  from: 'claimed' | 'artifact_written';
  to: 'artifact_written' | 'wal_written';
}): Promise<void> {
  await transaction(async (client) => {
    const updated = await client.query(
      `UPDATE authoring_mutation_operations
       SET state = $3, updated_at = NOW()
       WHERE receipt_id = $1 AND request_hash = $2 AND state = $4`,
      [input.receiptId, input.requestHash, input.to, input.from],
    );
    if (updated.rowCount !== 1) {
      const replay = await client.query(
        `SELECT receipt_id FROM authoring_mutation_operations
         WHERE receipt_id = $1 AND request_hash = $2 AND state IN ($3,'completed')`,
        [input.receiptId, input.requestHash, input.to],
      );
      if (replay.rowCount !== 1) throw new ConflictError('Authoring mutation stage changed during recovery');
    }
  });
}

export async function completeAuthoringMutation(input: {
  receiptId: string;
  requestHash: string;
  responseStatus: number;
  responseBody: Record<string, unknown>;
}): Promise<void> {
  const encoded = JSON.stringify(input.responseBody);
  if (Buffer.byteLength(encoded, 'utf8') > 65_536) throw new ValidationError('Authoring mutation response exceeds durable replay bound');
  await transaction(async (client) => {
    const updated = await client.query(
      `UPDATE authoring_mutation_operations
       SET state = 'completed', response_status = $3, response_body = $4::jsonb,
           completed_at = NOW(), updated_at = NOW(), last_error_code = NULL
       WHERE receipt_id = $1 AND request_hash = $2 AND state <> 'completed'`,
      [input.receiptId, input.requestHash, input.responseStatus, encoded],
    );
    if (updated.rowCount === 1) return;
    const replay = (await client.query<{ response_status: number; response_body: Record<string, unknown> }>(
      `SELECT response_status, response_body FROM authoring_mutation_operations
       WHERE receipt_id = $1 AND request_hash = $2 AND state = 'completed'`,
      [input.receiptId, input.requestHash],
    )).rows[0];
    if (!replay || replay.response_status !== input.responseStatus
      || JSON.stringify(replay.response_body) !== encoded) {
      throw new ConflictError('Completed authoring mutation response changed during replay');
    }
  });
}
