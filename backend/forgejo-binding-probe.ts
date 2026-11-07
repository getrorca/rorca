/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import dotenv from 'dotenv';

async function main(): Promise<void> {
  dotenv.config({ path: '../.env.local' });
  const { pool, query } = await import('./src/db/index.js');
  try {
    const rows = await query<{
      workspace_id: string;
      instance_url: string;
      repo_owner: string;
      repo_name: string;
      status: string;
      credential_version: number;
      key_version: number;
      webhook_secret_version: number;
      current: boolean;
    }>(`SELECT workspace_id, instance_url, repo_owner, repo_name, status,
               credential_version, key_version, webhook_secret_version,
               superseded_at IS NULL AS current
          FROM forgejo_workspace_credentials
         ORDER BY workspace_id, credential_version`);
    console.log(JSON.stringify({ configuredDatabase: Boolean(process.env.DATABASE_URL), rows }));
  } finally {
    await pool.end();
  }
}

void main();
