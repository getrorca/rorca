/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { getTestPool, closeTestPool, truncateAll } from '../../__tests__/helpers/pg-test-utils';

const pool = getTestPool();
const HASH = `sha256:${'a'.repeat(64)}`;
const ATTESTATION = `sha256:${'b'.repeat(64)}`;
const KEY = `sha256:${'c'.repeat(64)}`;

beforeEach(async () => { await truncateAll(pool); });
afterAll(async () => { await closeTestPool(); });

test('revocation never makes a provider-human lifecycle receipt reusable', async () => {
  await pool.query("INSERT INTO workspaces(id,label,path) VALUES ('receipt-ws','Receipt','/tmp/receipt-ws')");
  const receipt = (await pool.query<{ id: string }>(`
    INSERT INTO provider_human_authority_receipts (
      workspace_id,purpose,target_hash,issuer_id,key_id,key_fingerprint,provider,
      provider_tenant_id,actor_id,conversation_id,thread_id,message_id,occurred_at,
      normalized_command_hash,ingress_idempotency_key,attestation_hash
    ) VALUES ('receipt-ws','lifecycle_decision',$1,'hermes','key-1',$2,'slack',
      'team-1','human-1','channel-1','thread-1','message-1',NOW(),$1,'ingress-123',$3)
    RETURNING id`, [HASH, KEY, ATTESTATION])).rows[0];
  const insertDecision = (sourceRequestId: string) => pool.query(`
    INSERT INTO ssdlc_decisions (
      workspace_id,spec_slug,phase_id,gate_id,decision_type,rationale,
      subject_type,subject_value,policy_version,policy_reference,policy_authorized,
      principal_type,principal_id,principal_display_label,actor,source_request_id,
      source_channel,scope_key,request_hash,provider_human_receipt_id
    ) VALUES ('receipt-ws','spec-a','merge','gate-merge','merge_approval',
      'Exact reviewed merge approval','commit_sha',$1,'v1','v1:gate-merge',TRUE,
      'provider_human','human-1','slack:human-1','slack:human-1',$2,
      'provider','spec-a|merge|gate-merge|*|*',$3,$4)
    RETURNING id`, ['d'.repeat(40), sourceRequestId, HASH, receipt.id]);

  const first = (await insertDecision('decision-request-1')).rows[0];
  await pool.query(`UPDATE ssdlc_decisions SET revoked_at=NOW(),
    revoked_by_principal_type='local_admin', revoked_by_principal_id='admin-1',
    revoked_by_display_label='Admin', revocation_rationale='Approval was explicitly revoked',
    revocation_source_request_id='revoke-request-1' WHERE id=$1`, [first.id]);

  await expect(insertDecision('decision-request-2')).rejects.toMatchObject({ code: '23505' });
  const count = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM ssdlc_decisions WHERE provider_human_receipt_id=$1', [receipt.id],
  );
  expect(count.rows[0].count).toBe('1');
});
