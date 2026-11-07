/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { canonicalTransaction, queryOne } from '../db/index';
import { ConflictError, NotFoundError } from './errors';
import {
  CreateReleaseIntentSchema,
  OPERATION_INTENT_GRANT_VERSION,
  OPERATION_INTENT_PROJECTION_VERSION,
  OperationIntentGrantSchema,
  OperationIntentProjectionSchema,
  canonicalReleaseIntentCiEvidence,
  canonicalReleaseIntent,
  releaseIntentCiEvidenceDigest,
  releaseIntentDigest,
  validateReleaseIntentGrant,
  type CreateReleaseIntent,
  type OperationIntentGrant,
  type OperationIntentProjection,
  type ReleaseIntentValidation,
} from './release-intent';

interface OperationIntentRow {
  id: string;
  workspace_id: string;
  intent_kind: 'release';
  schema_version: string;
  intent_payload: unknown;
  provenance_payload: unknown;
  canonical_payload: string;
  canonical_ci_evidence: string;
  intent_digest: string;
  ci_evidence_digest: string;
  created_by: string;
  created_at: Date | string;
}

interface OperationIntentGrantRow {
  id: string;
  operation_intent_id: string;
  workspace_id: string;
  intent_digest: string;
  ci_evidence_digest: string;
  issued_at: Date | string;
  expires_at: Date | string;
}

const OPERATION_INTENT_SELECT = `
  id, workspace_id, intent_kind, schema_version, intent_payload,
  provenance_payload, canonical_payload, canonical_ci_evidence,
  intent_digest, ci_evidence_digest, created_by, created_at`;

function jsonValue(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) as unknown : value;
}

function operationIntentProjection(row: OperationIntentRow): OperationIntentProjection {
  return OperationIntentProjectionSchema.parse({
    schemaVersion: OPERATION_INTENT_PROJECTION_VERSION,
    operationIntentId: row.id,
    workspaceId: row.workspace_id,
    intentKind: row.intent_kind,
    intentDigest: row.intent_digest,
    ciEvidenceDigest: row.ci_evidence_digest,
    releaseIntent: jsonValue(row.intent_payload),
    provenance: jsonValue(row.provenance_payload),
    immutable: true,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  });
}

function operationIntentGrant(row: OperationIntentGrantRow): OperationIntentGrant {
  return OperationIntentGrantSchema.parse({
    schemaVersion: OPERATION_INTENT_GRANT_VERSION,
    grantId: row.id,
    operationIntentId: row.operation_intent_id,
    workspaceId: row.workspace_id,
    intentDigest: row.intent_digest,
    ciEvidenceDigest: row.ci_evidence_digest,
    issuedAt: new Date(row.issued_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  });
}

export interface ReleaseIntentStore {
  create(input: CreateReleaseIntent, createdBy: string): Promise<OperationIntentProjection>;
  get(workspaceId: string, operationIntentId: string): Promise<OperationIntentProjection | null>;
  validate(
    workspaceId: string,
    operationIntentId: string,
    grantId: string,
    now?: Date,
  ): Promise<ReleaseIntentValidation>;
}

export class PostgresReleaseIntentStore implements ReleaseIntentStore {
  async create(input: CreateReleaseIntent, createdBy: string): Promise<OperationIntentProjection> {
    const parsed = CreateReleaseIntentSchema.parse(input);
    const canonicalPayload = canonicalReleaseIntent(parsed);
    const canonicalCiEvidence = canonicalReleaseIntentCiEvidence(parsed.provenance);
    const intentDigest = releaseIntentDigest(parsed);
    const ciEvidenceDigest = releaseIntentCiEvidenceDigest(parsed.provenance);

    return canonicalTransaction(async (client) => {
      const inserted = await client.query<OperationIntentRow>(`
        INSERT INTO rorca.authority_operation_intents
          (workspace_id, intent_kind, schema_version, intent_payload,
           provenance_payload, canonical_payload, canonical_ci_evidence,
           intent_digest, ci_evidence_digest, created_by)
        VALUES ($1, 'release', $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9)
        ON CONFLICT (workspace_id, intent_digest) DO NOTHING
        RETURNING ${OPERATION_INTENT_SELECT}
      `, [
        parsed.workspaceId,
        parsed.releaseIntent.schemaVersion,
        JSON.stringify(parsed.releaseIntent),
        JSON.stringify(parsed.provenance),
        canonicalPayload,
        canonicalCiEvidence,
        intentDigest,
        ciEvidenceDigest,
        createdBy,
      ]);
      let row = inserted.rows[0];
      if (!row) {
        const existing = await client.query<OperationIntentRow>(`
          SELECT ${OPERATION_INTENT_SELECT}
            FROM rorca.authority_operation_intents
           WHERE workspace_id = $1 AND intent_digest = $2
        `, [parsed.workspaceId, intentDigest]);
        row = existing.rows[0];
      }
      if (!row || row.canonical_payload !== canonicalPayload
        || row.canonical_ci_evidence !== canonicalCiEvidence) {
        throw new ConflictError('Release intent digest collides with different canonical material');
      }
      return operationIntentProjection(row);
    });
  }

  async get(workspaceId: string, operationIntentId: string): Promise<OperationIntentProjection | null> {
    const row = await queryOne<OperationIntentRow>(`
      SELECT ${OPERATION_INTENT_SELECT}
        FROM rorca.authority_operation_intents
       WHERE workspace_id = $1 AND id = $2
    `, [workspaceId, operationIntentId]);
    return row ? operationIntentProjection(row) : null;
  }

  async validate(
    workspaceId: string,
    operationIntentId: string,
    grantId: string,
    now = new Date(),
  ): Promise<ReleaseIntentValidation> {
    const projection = await this.get(workspaceId, operationIntentId);
    if (!projection) throw new NotFoundError('Release operation intent', operationIntentId);
    const row = await queryOne<OperationIntentGrantRow>(`
      SELECT id, operation_intent_id, workspace_id, intent_digest,
             ci_evidence_digest, issued_at, expires_at
        FROM rorca.authority_operation_intent_grants
       WHERE workspace_id = $1 AND id = $2
    `, [workspaceId, grantId]);
    if (!row) throw new NotFoundError('Release authorization grant', grantId);
    return validateReleaseIntentGrant(projection, operationIntentGrant(row), now);
  }
}
