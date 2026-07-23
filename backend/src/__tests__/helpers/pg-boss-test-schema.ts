// Copyright (c) 2026 Rorca Inc.
// SPDX-License-Identifier: Apache-2.0

import { getPgBossSchemaName } from '../../lib/pg-boss-schema';

/**
 * Give every real-runtime suite its own pg-boss-owned schema. The certification
 * runner supplies an evidence-bound base, while local runs retain a stable base.
 */
export function pgBossTestSchema(suite: string): string {
  if (!/^[a-z0-9_]{1,24}$/.test(suite)) {
    throw new Error(`Invalid pg-boss test suite schema suffix: ${suite}`);
  }
  const schema = `${getPgBossSchemaName()}_${suite}`;
  if (Buffer.byteLength(schema, 'utf8') > 63) {
    throw new Error(`pg-boss test schema exceeds PostgreSQL identifier limit: ${schema}`);
  }
  return schema;
}
