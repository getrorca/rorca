/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import * as fs from 'node:fs';import * as path from 'node:path';
const sql=fs.readFileSync(path.join(__dirname,'..','pg-migrations','20260729150000_wave2_reconciler_review_remediation.sql'),'utf8');
describe('Wave 2 reconciler review remediation migration',()=>{
  test('persists transport schema and actor/request-bound idempotency without raw keys',()=>{
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS transport_schema TEXT');
    expect(sql).toContain('spec_post_save_reconciliation_operations');
    expect(sql).toContain('operation_key_hash');expect(sql).toContain('request_hash');expect(sql).toContain('authority_class');
    expect(sql).toContain('UNIQUE(workspace_id,actor_id,authority_class,operation_kind,operation_key_hash)');
    expect(sql).toContain('uq_spec_post_save_reconciliation_changed_replay');
  });
  test('revokes broad memory insert and uses one exact post-sandbox function',()=>{
    expect(sql).toContain('REVOKE INSERT ON rorca.memories');
    expect(sql).toContain('insert_strict_spec_derived_memory_v2');
    expect(sql).toContain("stage_row.status<>'running'");expect(sql).toContain("job_row.status<>'running'");
    expect(sql).toContain('computed_material_hash<>p_material_hash');expect(sql).toContain('strict-spec-derived-facts-v2');
    expect(sql).toContain("VALUES('memory_created'");
  });
  test('extends receipt identities with FKs and immutable material/derivation hashes',()=>{
    for(const token of ['workflow_run_id BIGINT REFERENCES','workflow_stage_id BIGINT REFERENCES','generation_log_id INTEGER REFERENCES','material_hash TEXT','derivation_hash TEXT','validate_strict_memory_receipt_v2'])expect(sql).toContain(token);
    expect(sql).toContain('migration_version=20260729150000');
  });
});
