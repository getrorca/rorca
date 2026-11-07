/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
import { Pool } from 'pg';
import { assertTestDatabaseUrl } from './src/lib/test-db-safety';

export default async function setup(): Promise<void> {
  const url = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
  if (!url) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required for authority fixture setup');
  assertTestDatabaseUrl(url, 'Wave 2 migration fixture database');
  const pool = new Pool({ connectionString: url, options: '--search_path=rorca,public -c rorca.migration_mode=on' });
  try {
    await pool.query(`INSERT INTO workspaces(id,label,path) VALUES
      ('workspace:wave-two','Wave 2 service integration','/tmp/wave2-service-integration'),
      ('workspace:other','Wave 2 cross-tenant fixture','/tmp/wave2-other') ON CONFLICT(id) DO NOTHING`);
  } finally { await pool.end(); }
}
