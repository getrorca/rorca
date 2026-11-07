/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const migrationFile = '20260812122000_pre_staging_qualification_claims.sql';
const migrationDirectory = path.join(__dirname, '..', 'pg-migrations');
const sql = fs.readFileSync(path.join(migrationDirectory, migrationFile), 'utf8');
const qualificationRuntime = fs.readFileSync(
  path.join(__dirname, '..', '..', 'lib', 'pre-staging-qualification.ts'),
  'utf8',
);

describe('LFC-MIG-001 pre-staging qualification attempt grants', () => {
  test('matches the table privileges to the API and worker operations', () => {
    expect(qualificationRuntime).toMatch(/INSERT INTO ssdlc_qualification_attempts/);
    expect(qualificationRuntime).toMatch(/SELECT \* FROM ssdlc_qualification_attempts/);
    expect(qualificationRuntime).toMatch(/UPDATE ssdlc_qualification_attempts/);
    expect(qualificationRuntime).not.toMatch(/DELETE FROM ssdlc_qualification_attempts/);

    const runtimeGrant = sql.match(
      /'GRANT ([A-Z, ]+) ON rorca\.ssdlc_qualification_attempts TO %I'/,
    );
    expect(runtimeGrant?.[1]?.split(',').map((privilege) => privilege.trim())).toEqual([
      'SELECT',
      'INSERT',
      'UPDATE',
    ]);
    expect(sql).not.toMatch(/GRANT\s+[^']*\b(?:DELETE|TRUNCATE|REFERENCES|TRIGGER)\b[^']*ssdlc_qualification_attempts/i);
    expect(sql).not.toMatch(/GRANT\s+[^']*ON\s+(?:ALL\s+)?SEQUENCES?\b/i);
  });

  test('derives both bounded roles from fail-loud configured GUCs', () => {
    expect(sql).toContain("current_setting('rorca.runtime_database_user', TRUE)");
    expect(sql).toContain("current_setting('rorca.canonical_writer_database_user', TRUE)");
    expect(sql).toContain("IF runtime_user IS NULL OR runtime_user = '' THEN");
    expect(sql).toContain("RAISE EXCEPTION 'rorca.runtime_database_user must identify the runtime principal'");
    expect(sql).toContain("IF writer_user IS NULL OR writer_user = '' OR writer_user = runtime_user THEN");
    expect(sql).toContain("RAISE EXCEPTION 'rorca.canonical_writer_database_user must identify a distinct finalizer principal'");
    expect(sql).toContain('TO %I');
    expect(sql.match(/current_setting\('rorca\.runtime_database_user', TRUE\)/g)).toHaveLength(1);
    expect(sql.match(/current_setting\('rorca\.canonical_writer_database_user', TRUE\)/g)).toHaveLength(1);
  });

  test('keeps receipt finalization out of the runtime role and bounds the canonical writer', () => {
    expect(sql).toMatch(
      /'GRANT SELECT, INSERT, UPDATE ON rorca\.ssdlc_qualification_attempts TO %I',\s*runtime_user/s,
    );
    expect(sql).not.toMatch(
      /'GRANT [^']*(?:INSERT|UPDATE|DELETE|TRUNCATE)[^']*ssdlc_release_qualifications TO %I',\s*runtime_user/is,
    );
    expect(sql).not.toMatch(
      /'GRANT [^']*(?:INSERT|UPDATE|DELETE|TRUNCATE)[^']*ssdlc_lifecycle_evidence TO %I',\s*runtime_user/is,
    );
    expect(sql).toMatch(
      /'GRANT SELECT, UPDATE ON rorca\.ssdlc_qualification_attempts TO %I',\s*writer_user/s,
    );
    expect(sql).toMatch(
      /'GRANT SELECT, INSERT ON rorca\.ssdlc_release_qualifications TO %I',\s*writer_user/s,
    );
    expect(sql).not.toMatch(
      /'GRANT [^']*(?:DELETE|TRUNCATE|REFERENCES|TRIGGER)[^']*(?:ssdlc_qualification_attempts|ssdlc_release_qualifications) TO %I',\s*writer_user/is,
    );
    expect(sql).not.toMatch(/GRANT\s+[^']*ssdlc_lifecycle_evidence/i);
  });

  test('keeps the attempt ledger private and avoids broad or transport grants', () => {
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON rorca.ssdlc_qualification_attempts FROM PUBLIC');
    expect(sql).not.toMatch(/GRANT\s+[^']*ssdlc_qualification_attempts\s+TO\s+(?:PUBLIC|authenticated|anon)\b/i);
    expect(sql).not.toMatch(/GRANT\s+[^']*ON\s+SCHEMA\b/i);
    expect(sql).not.toMatch(/pgboss/i);
  });
});
