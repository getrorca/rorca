/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */
/** One-shot production pg-boss installer. Never run under the runtime URL. */
import { prepareSplitPrincipalPgBoss } from '../lib/pg-boss';
import { getPgBossSchemaName } from '../lib/pg-boss-schema';

async function main():Promise<void>{
  const connectionString=process.env.DATABASE_URL;
  const runtimeUser=String(process.env.RORCA_RUNTIME_DATABASE_USER??'').trim();
  if(!connectionString)throw new Error('Migration-owner DATABASE_URL is required for pg-boss installation');
  const installerUser=decodeURIComponent(new URL(connectionString).username);
  if(!installerUser||installerUser===runtimeUser)throw new Error('pg-boss installer must be distinct from the runtime principal');
  await prepareSplitPrincipalPgBoss(connectionString,getPgBossSchemaName());
}

main().then(()=>{
  // This is an isolated one-shot migration container. Flush the receipt, then
  // exit because pg-boss may retain an internal handle after stop().
  process.stdout.write('[pg-boss-install] split-principal transport schema ready\n',()=>process.exit(0));
}).catch((error)=>{
  console.error('[pg-boss-install] failed',error);
  process.exit(1);
});
