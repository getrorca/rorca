/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

type SqlExecutor = {
  query: (sql: string) => Promise<unknown>;
};


/**
 * Destructive test-only cleanup for a disposable invocation-bound database.
 * Production behavior remains fail-closed and is asserted before this helper is
 * ever called. Every user-defined TRUNCATE trigger is discovered dynamically,
 * and invocation-global workspace fixtures are restored after the reset.
 */
export async function resetDisposableWave1Database(pool: SqlExecutor): Promise<void> {
  const immutableGuards = await pool.query(`
    SELECT c.relname AS table_name,t.tgname AS trigger_name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='rorca' AND NOT t.tgisinternal
       AND (t.tgtype & 32) = 32
     ORDER BY c.relname,t.tgname
  `) as { rows: Array<{ table_name: string; trigger_name: string }> };
  const guards = immutableGuards.rows.map(({ table_name, trigger_name }) => [table_name, trigger_name] as const);
  for (const [table, trigger] of guards) {
    await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  }
  try {
    await pool.query('TRUNCATE TABLE workspaces CASCADE');
  } finally {
    for (const [table, trigger] of [...guards].reverse()) {
      await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
  }
  await pool.query(`INSERT INTO workspaces(id,label,path) VALUES
    ('workspace:wave-two','Wave 2 service integration','/tmp/wave2-service-integration'),
    ('workspace:other','Wave 2 cross-tenant fixture','/tmp/wave2-other')
    ON CONFLICT(id) DO NOTHING`);
}
