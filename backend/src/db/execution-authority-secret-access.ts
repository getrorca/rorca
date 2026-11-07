/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execute } from './index';
import type { AuthorityJson } from './execution-authority';

export const AUTHORITY_SECRET_ACCESS_AUDIT_SCHEMA_VERSION = 'rorca.authority-secret-access-audit.v1' as const;

export type SecretAccessAuditEvent =
  | 'resolution_started'
  | 'resolution_succeeded'
  | 'resolution_failed'
  | 'revocation_started'
  | 'revocation_succeeded'
  | 'revocation_failed';

export interface SecretAccessAuditRecordInput {
  workspaceId: string;
  leaseId: string;
  bindingReference: string;
  bindingGeneration: number;
  principal: string;
  leasePurpose: string;
  provider: string;
  environment: string;
  providerResourceId: string;
  action: string;
  secretReference: string;
  secretFingerprint: string;
  event: SecretAccessAuditEvent;
  failureCode: string | null;
  provenance: AuthorityJson;
}

/** Append one redacted access event. Audit rows are immutable in PostgreSQL. */
export async function recordSecretAccessAudit(input: SecretAccessAuditRecordInput): Promise<void> {
  await execute(
    `INSERT INTO authority_secret_access_audit
       (workspace_id, lease_id, binding_reference, binding_generation,
        principal, lease_purpose, provider, environment, provider_resource_id,
        action, secret_reference, secret_fingerprint, event, failure_code, provenance_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::JSONB)`,
    [
      input.workspaceId,
      input.leaseId,
      input.bindingReference,
      input.bindingGeneration,
      input.principal,
      input.leasePurpose,
      input.provider,
      input.environment,
      input.providerResourceId,
      input.action,
      input.secretReference,
      input.secretFingerprint,
      input.event,
      input.failureCode,
      JSON.stringify(input.provenance),
    ],
  );
}
