/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const migration = fs.readFileSync(
  path.resolve(__dirname, '..', 'pg-migrations', '20260820010000_spec_export_kit_generations.sql'),
  'utf8',
);


const multiCompilerMigration = fs.readFileSync(
  path.resolve(__dirname, '..', 'pg-migrations', '20260820011000_spec_export_kit_multi_compiler_generations.sql'),
  'utf8',
);
describe('spec export-kit generations migration', () => {
  it('creates exact spec and manifest identities with explicit legacy classification', () => {
    expect(migration).toContain('CREATE TABLE rorca.spec_export_kit_generations');
    expect(migration).toContain('spec_material_hash TEXT NOT NULL');
    expect(migration).toContain('manifest_hash TEXT NOT NULL');
    expect(migration).toContain("classification IN ('native_complete', 'legacy_complete', 'legacy_partial')");
    expect(migration).toContain("state IN ('draft', 'sealed')");
  });

  it('allows only draft to sealed transition and forbids deletion', () => {
    expect(migration).toContain("IF TG_OP = 'DELETE'");
    expect(migration).toContain("IF OLD.state = 'sealed'");
    expect(migration).toContain("IF NEW.state <> 'sealed'");
    expect(migration).toContain('Export-kit generation identity is immutable');
  });


  it('allows a compiler revision to publish a new manifest for unchanged spec material', () => {
    expect(migration).not.toContain('UNIQUE (workspace_id, spec_slug, spec_material_hash)');
    expect(migration).toContain('UNIQUE (workspace_id, spec_slug, manifest_hash)');
    expect(multiCompilerMigration).toContain("pg_get_constraintdef(constraint_row.oid) = 'UNIQUE (workspace_id, spec_slug, spec_material_hash)'");
    expect(multiCompilerMigration).toContain('DROP CONSTRAINT');
  });
  it('does not hand-manage pgboss or roles', () => {
    expect(migration).not.toMatch(/pgboss/i);
    expect(migration).not.toMatch(/CREATE\s+(?:ROLE|SCHEMA|EXTENSION)/i);
    expect(migration).not.toMatch(/ALTER\s+ROLE/i);
  });
});
