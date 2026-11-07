/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { Pool, PoolClient } from 'pg';

/** The only production Apache AGE graph identity supported by current Rorca. */
export const RORCA_GRAPH_NAME = 'rorca_v2' as const;
const RORCA_GRAPH_BOOTSTRAP_LOCK_KEY = 8_244_250_520_001;

export const RORCA_KEYED_NODE_LABELS = [
  'Story',
  'File',
  'Spec',
  'Memory',
  'Convention',
  'Skill',
] as const;

export const RORCA_UNKEYED_NODE_LABELS = ['Workspace'] as const;

export const RORCA_EDGE_LABELS = [
  'TOUCHES',
  'BELONGS_TO',
  'DEPENDS_ON',
  'LEARNED_FROM',
  'ABOUT',
  'APPLIES_TO',
  'VIOLATED_BY',
  'USED_IN',
  'IN_WORKSPACE',
  'FROM_SPEC',
  'SUPERSEDES',
  'CONFLICTS_WITH',
] as const;

export type RorcaKeyedNodeLabel = typeof RORCA_KEYED_NODE_LABELS[number];

export interface RorcaGraphBootstrapReady {
  available: true;
  graphName: typeof RORCA_GRAPH_NAME;
  labels: RorcaKeyedNodeLabel[];
  keyIndexes: string[];
}

export interface RorcaGraphLifecycleUnavailable {
  available: false;
  reason: 'extension-not-installed' | 'capability-unavailable';
  errorCode: string | null;
}

export type RorcaGraphLifecycleResult = RorcaGraphBootstrapReady | RorcaGraphLifecycleUnavailable;

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function keyIndexName(label: RorcaKeyedNodeLabel): string {
  return `idx_${RORCA_GRAPH_NAME}_${label.toLowerCase()}_key`;
}

/** Build the SQL bridge for every production Cypher call from one reviewed identity. */
export function buildRorcaCypherSql(cypher: string, columnDefinition: string): string {
  if (!columnDefinition.trim()) throw new Error('Cypher return-column definition is required');
  return `SELECT * FROM cypher('${RORCA_GRAPH_NAME}', $$ ${cypher} $$) AS (${columnDefinition})`;
}

/**
 * Activate AGE on this connection before parsing Cypher.
 *
 * Calling a pinned AGE C function loads the extension library and installs its
 * parser hook without granting the application principals PostgreSQL's
 * superuser-only LOAD privilege.
 */
export async function setupRorcaAgeSession(client: PoolClient): Promise<void> {
  await client.query('SELECT ag_catalog.age_pi()');
  await client.query('SET search_path = ag_catalog, "$user", public');
}

async function ensureGraphExists(client: PoolClient): Promise<void> {
  const existing = await client.query(
    'SELECT 1 FROM ag_catalog.ag_graph WHERE name = $1',
    [RORCA_GRAPH_NAME],
  );
  if (existing.rowCount === 0) {
    await client.query('SELECT create_graph($1)', [RORCA_GRAPH_NAME]);
  }
}

type RorcaNodeLabel = RorcaKeyedNodeLabel | typeof RORCA_UNKEYED_NODE_LABELS[number];

async function ensureVertexLabelExists(client: PoolClient, label: RorcaNodeLabel): Promise<void> {
  const existing = await client.query(
    `SELECT 1 FROM ag_catalog.ag_label
     WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = $1)
       AND name = $2
       AND kind = 'v'`,
    [RORCA_GRAPH_NAME, label],
  );
  if (existing.rowCount === 0) {
    await client.query('SELECT create_vlabel($1, $2)', [RORCA_GRAPH_NAME, label]);
  }
}

async function ensureEdgeLabelExists(
  client: PoolClient,
  label: typeof RORCA_EDGE_LABELS[number],
): Promise<void> {
  const existing = await client.query(
    `SELECT 1 FROM ag_catalog.ag_label
     WHERE graph = (SELECT graphid FROM ag_catalog.ag_graph WHERE name = $1)
       AND name = $2
       AND kind = 'e'`,
    [RORCA_GRAPH_NAME, label],
  );
  if (existing.rowCount === 0) {
    await client.query('SELECT create_elabel($1, $2)', [RORCA_GRAPH_NAME, label]);
  }
}

async function ensureCanonicalKeyIndex(client: PoolClient, label: RorcaKeyedNodeLabel): Promise<string> {
  const indexName = keyIndexName(label);
  await client.query(
    `CREATE INDEX IF NOT EXISTS ${quoteIdent(indexName)}
     ON ${quoteIdent(RORCA_GRAPH_NAME)}.${quoteIdent(label)}
     USING btree (agtype_access_operator(properties, '"key"'::agtype))`,
  );
  return indexName;
}

async function ensureRuntimeGraphPrivileges(client: PoolClient): Promise<void> {
  const runtimeUser = process.env.RORCA_RUNTIME_DATABASE_USER?.trim();
  if (!runtimeUser) return;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(runtimeUser)) {
    throw new Error('RORCA_RUNTIME_DATABASE_USER must be a PostgreSQL identifier');
  }
  const runtime = quoteIdent(runtimeUser);
  const graph = quoteIdent(RORCA_GRAPH_NAME);
  await client.query(`GRANT USAGE ON SCHEMA ${graph} TO ${runtime}`);
  await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${graph} TO ${runtime}`);
  await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${graph} TO ${runtime}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${graph} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime}`);
  await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${graph} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${runtime}`);
}

/**
 * Idempotently create the reviewed graph and lookup indexes on an AGE-capable
 * session. This never probes, creates, reads, or writes the obsolete `rorca`
 * graph; that identifier remains the application schema and historical only.
 */
export async function bootstrapRorcaV2GraphOnClient(client: PoolClient): Promise<RorcaGraphBootstrapReady> {
  await setupRorcaAgeSession(client);
  await ensureGraphExists(client);

  const keyIndexes: string[] = [];
  for (const label of RORCA_KEYED_NODE_LABELS) {
    await ensureVertexLabelExists(client, label);
    keyIndexes.push(await ensureCanonicalKeyIndex(client, label));
  }

  for (const label of RORCA_UNKEYED_NODE_LABELS) {
    await ensureVertexLabelExists(client, label);
  }
  for (const label of RORCA_EDGE_LABELS) {
    await ensureEdgeLabelExists(client, label);
  }

  return {
    available: true,
    graphName: RORCA_GRAPH_NAME,
    labels: [...RORCA_KEYED_NODE_LABELS],
    keyIndexes,
  };
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/** Errors that mean this database/role must remain in Graph Lite. */
export function isAgeCapabilityUnavailableError(error: unknown): boolean {
  return new Set([
    '0A000', // feature_not_supported
    '3F000', // invalid_schema_name / AGE catalog unavailable
    '42501', // insufficient_privilege
    '42883', // undefined_function (AGE not loaded for this distribution)
    '58P01', // undefined_file (AGE shared library unavailable)
  ]).has(errorCode(error) ?? '');
}

/**
 * Migration-lifecycle bootstrap. It runs even when migration 050 was already
 * recorded, which upgrades existing installations without replaying or creating
 * the obsolete graph. A separate connection contains AGE activation failures so
 * the advisory-lock-owning migration session cannot be poisoned.
 */
export async function bootstrapRorcaV2GraphForLifecycle(pool: Pool): Promise<RorcaGraphLifecycleResult> {
  const client = await pool.connect();
  let destroyClient = false;
  let transactionOpen = false;
  let bootstrapLockHeld = false;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [RORCA_GRAPH_BOOTSTRAP_LOCK_KEY]);
    bootstrapLockHeld = true;
    const extension = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'age'");
    if (extension.rowCount === 0) {
      return { available: false, reason: 'extension-not-installed', errorCode: null };
    }

    await client.query('BEGIN');
    transactionOpen = true;
    const result = await bootstrapRorcaV2GraphOnClient(client);
    await ensureRuntimeGraphPrivileges(client);
    await client.query('COMMIT');
    transactionOpen = false;
    return result;
  } catch (error) {
    if (transactionOpen) {
      try { await client.query('ROLLBACK'); } catch { destroyClient = true; }
      transactionOpen = false;
    }
    if (isAgeCapabilityUnavailableError(error)) {
      destroyClient = true;
      return {
        available: false,
        reason: 'capability-unavailable',
        errorCode: errorCode(error),
      };
    }
    throw error;
  } finally {
    if (!destroyClient && bootstrapLockHeld) {
      try { await client.query('SELECT pg_advisory_unlock($1)', [RORCA_GRAPH_BOOTSTRAP_LOCK_KEY]); } catch { destroyClient = true; }
    }
    if (!destroyClient) {
      try { await client.query('SET search_path = rorca, public'); } catch { destroyClient = true; }
    }
    client.release(destroyClient);
  }
}
