/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execute, query, queryOne, pool, closePool } from '../index';
import { runPgMigrations } from '../pg-index';

const MIGRATION_FILENAME = '20260704120000_context_events_memory_candidates.sql';
const MIGRATION_VERSION = 20260704120000;
const MIGRATION_PATH = path.join(__dirname, '..', 'pg-migrations', MIGRATION_FILENAME);
const TEST_WORKSPACE_ID = 'ccs-002-schema-test';

const EVENT_TYPES = [
  'manual_cli_note',
  'git_commit',
  'git_range',
  'daemon_scan',
  'pr_merge',
  'incident',
  'duckbrain_import',
  'hermes_event',
] as const;

const MEMORY_CATEGORIES = [
  'Architecture',
  'Convention',
  'Bug Fix',
  'Decision',
  'Pattern',
  'Gotcha',
] as const;

const TRUST_TIERS = [
  'agent_observation',
  'working_note',
  'engineering_decision',
  'approved_policy',
  'verified_fact',
] as const;

type ColumnRow = {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
};

type ConstraintRow = {
  conname: string;
  definition: string;
};

type IndexRow = {
  indexname: string;
  indexdef: string;
};

type IdRow = {
  id: string;
};

async function resetWorkspace(): Promise<void> {
  await execute('DELETE FROM workspaces WHERE id = $1', [TEST_WORKSPACE_ID]);
  await execute(
    `INSERT INTO workspaces (id, label, path)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [TEST_WORKSPACE_ID, 'CCS-002 Schema Test', '/tmp/ccs-002-schema-test'],
  );
}

async function insertContextEvent(suffix: string, overrides: Record<string, unknown> = {}): Promise<IdRow> {
  const eventType = String(overrides.event_type ?? 'manual_cli_note');
  const trustTier = String(overrides.trust_tier ?? 'agent_observation');
  const idempotencyKey = String(overrides.idempotency_key ?? `context:${suffix}`);
  const sourceSystem = String(overrides.source_system ?? 'cli');
  const sourceRef = String(overrides.source_ref ?? `cli:${suffix}`);

  const row = await queryOne<IdRow>(
    `INSERT INTO context_events (
       workspace_id,
       event_type,
       source_system,
       source_ref,
       actor,
       occurred_at,
       summary,
       payload,
       provenance,
       related_files,
       metadata,
       trust_tier,
       idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12)
     RETURNING id::text AS id`,
    [
      TEST_WORKSPACE_ID,
      eventType,
      sourceSystem,
      sourceRef,
      'ccs-test',
      `summary ${suffix}`,
      JSON.stringify({ suffix }),
      JSON.stringify({ adapter: sourceSystem }),
      JSON.stringify(['src/example.ts']),
      JSON.stringify({ observedBy: 'test' }),
      trustTier,
      idempotencyKey,
    ],
  );

  if (!row) throw new Error('context event insert did not return an id');
  return row;
}

async function insertMemoryCandidate(suffix: string, overrides: Record<string, unknown> = {}): Promise<IdRow> {
  const row = await queryOne<IdRow>(
    `INSERT INTO memory_candidates (
       workspace_id,
       context_event_id,
       event_type,
       source_system,
       source_ref,
       actor,
       occurred_at,
       suggested_category,
       title,
       rule,
       context,
       related_files,
       confidence,
       trust_tier,
       review_status,
       idempotency_key,
       provenance,
       metadata,
       claim,
       policy,
       incident_learning,
       security_sensitive,
       regulated_domain,
       requires_review
     ) VALUES (
       $1, $2, $3, $4, $5, $6, NOW(), $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15,
       $16::jsonb, $17::jsonb, $18, $19, $20, $21, $22, $23
     )
     RETURNING id::text AS id`,
    [
      TEST_WORKSPACE_ID,
      overrides.context_event_id ?? null,
      overrides.event_type ?? 'manual_cli_note',
      overrides.source_system ?? 'cli',
      overrides.source_ref ?? `cli:${suffix}`,
      overrides.actor ?? 'ccs-test',
      overrides.suggested_category ?? 'Decision',
      overrides.title ?? `Candidate ${suffix}`,
      overrides.rule ?? `Rule ${suffix}`,
      overrides.context ?? `Context ${suffix}`,
      JSON.stringify(overrides.related_files ?? ['src/example.ts']),
      overrides.confidence ?? 'low',
      overrides.trust_tier ?? 'agent_observation',
      overrides.review_status ?? 'pending',
      overrides.idempotency_key ?? `candidate:${suffix}`,
      JSON.stringify(overrides.provenance ?? { adapter: 'test' }),
      JSON.stringify(overrides.metadata ?? { source: 'test' }),
      overrides.claim ?? null,
      overrides.policy ?? null,
      overrides.incident_learning ?? null,
      overrides.security_sensitive ?? false,
      overrides.regulated_domain ?? false,
      overrides.requires_review ?? true,
    ],
  );

  if (!row) throw new Error('memory candidate insert did not return an id');
  return row;
}

beforeEach(async () => {
  await resetWorkspace();
});

afterAll(async () => {
  await execute('DELETE FROM workspaces WHERE id = $1', [TEST_WORKSPACE_ID]);
  await closePool();
});

describe('CCS-002 migration file', () => {
  it('uses timestamp naming and does not reference off-limits queue schemas', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
    expect(MIGRATION_FILENAME).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);

    const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8');
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS context_events');
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS memory_candidates');
    expect(migrationSql).not.toMatch(/pgboss\./i);
  });
});

describe('context_events schema', () => {
  it('has durable event, provenance, idempotency, trust, and metadata columns', async () => {
    const rows = await query<ColumnRow>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = $1`,
      ['context_events'],
    );
    const columns = new Map(rows.map((row) => [row.column_name, row]));

    for (const column of [
      'id',
      'workspace_id',
      'event_type',
      'source_system',
      'source_ref',
      'actor',
      'occurred_at',
      'summary',
      'payload',
      'provenance',
      'related_files',
      'metadata',
      'trust_tier',
      'idempotency_key',
      'created_at',
      'updated_at',
    ]) {
      expect(columns.has(column)).toBe(true);
    }

    expect(columns.get('id')?.data_type).toBe('bigint');
    expect(columns.get('payload')?.data_type).toBe('jsonb');
    expect(columns.get('provenance')?.data_type).toBe('jsonb');
    expect(columns.get('related_files')?.data_type).toBe('jsonb');
    expect(columns.get('trust_tier')?.column_default).toContain('agent_observation');
    expect(columns.get('idempotency_key')?.is_nullable).toBe('NO');
  });

  it('has check constraints for event type, trust tier, JSON shape, and nonempty idempotency', async () => {
    const rows = await query<ConstraintRow>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = $1::regclass
         AND contype = 'c'
       ORDER BY conname`,
      ['context_events'],
    );
    const definitions = rows.map((row) => `${row.conname}: ${row.definition}`).join('\n');

    for (const eventType of EVENT_TYPES) {
      expect(definitions).toContain(eventType);
    }
    for (const trustTier of TRUST_TIERS) {
      expect(definitions).toContain(trustTier);
    }
    expect(definitions).toContain('jsonb_typeof(payload)');
    expect(definitions).toContain('jsonb_typeof(related_files)');
    expect(definitions).toContain('idempotency_key');
  });

  it('has a unique idempotency key index and source/time lookup indexes', async () => {
    const rows = await query<IndexRow>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = $1`,
      ['context_events'],
    );
    const indexes = rows.map((row) => `${row.indexname}: ${row.indexdef}`).join('\n');

    expect(indexes).toMatch(/UNIQUE.*idempotency_key/i);
    expect(indexes).toContain('idx_context_events_workspace_occurred_at');
    expect(indexes).toContain('idx_context_events_workspace_event_type');
    expect(indexes).toContain('idx_context_events_source');
    expect(indexes).toContain('idx_context_events_related_files');
  });

  it('accepts all MVP and later-phase event sources', async () => {
    for (const eventType of EVENT_TYPES) {
      const row = await insertContextEvent(`event-type-${eventType}`, {
        event_type: eventType,
        source_system: eventType.startsWith('git') ? 'git' : eventType.split('_')[0],
        source_ref: `${eventType}:ref`,
        idempotency_key: `context:event-type:${eventType}`,
      });
      expect(Number(row.id)).toBeGreaterThan(0);
    }
  });

  it('rejects unknown event types and trust tiers', async () => {
    await expect(
      insertContextEvent('bad-event-type', {
        event_type: 'calendar_invite',
        idempotency_key: 'context:bad-event-type',
      }),
    ).rejects.toThrow(/check|context_events_event_type/i);

    await expect(
      insertContextEvent('bad-trust-tier', {
        trust_tier: 'high',
        idempotency_key: 'context:bad-trust-tier',
      }),
    ).rejects.toThrow(/check|context_events_trust_tier/i);
  });

  it('deduplicates concurrent observations through ON CONFLICT on idempotency_key', async () => {
    await insertContextEvent('dedupe', { idempotency_key: 'context:dedupe' });

    const duplicate = await execute(
      `INSERT INTO context_events (
         workspace_id, event_type, source_system, source_ref, summary, payload, idempotency_key
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        TEST_WORKSPACE_ID,
        'manual_cli_note',
        'cli',
        'cli:dedupe-again',
        'duplicate event',
        JSON.stringify({ duplicate: true }),
        'context:dedupe',
      ],
    );

    const rows = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM context_events
       WHERE workspace_id = $1
         AND idempotency_key = $2`,
      [TEST_WORKSPACE_ID, 'context:dedupe'],
    );
    expect(duplicate.rowCount).toBe(0);
    expect(rows[0].count).toBe('1');
  });
});

describe('memory_candidates schema', () => {
  it('has review, confidence, trust, provenance, promotion, metadata, and candidate-only columns', async () => {
    const rows = await query<ColumnRow>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = $1`,
      ['memory_candidates'],
    );
    const columns = new Map(rows.map((row) => [row.column_name, row]));

    for (const column of [
      'id',
      'workspace_id',
      'context_event_id',
      'event_type',
      'source_system',
      'source_ref',
      'suggested_category',
      'title',
      'rule',
      'context',
      'related_files',
      'confidence',
      'trust_tier',
      'review_status',
      'reviewer',
      'reviewed_at',
      'promoted_memory_id',
      'promoted_at',
      'idempotency_key',
      'provenance',
      'metadata',
      'claim',
      'policy',
      'incident_learning',
      'security_sensitive',
      'regulated_domain',
      'requires_review',
      'created_at',
      'updated_at',
    ]) {
      expect(columns.has(column)).toBe(true);
    }

    expect(columns.get('context_event_id')?.data_type).toBe('bigint');
    expect(columns.get('promoted_memory_id')?.data_type).toBe('integer');
    expect(columns.get('confidence')?.column_default).toContain('low');
    expect(columns.get('trust_tier')?.column_default).toContain('agent_observation');
    expect(columns.get('review_status')?.column_default).toContain('pending');
    expect(columns.get('requires_review')?.column_default).toContain('true');
  });

  it('has category, confidence, trust tier, review status, JSON shape, and FK constraints', async () => {
    const rows = await query<ConstraintRow>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = $1::regclass
       ORDER BY conname`,
      ['memory_candidates'],
    );
    const definitions = rows.map((row) => `${row.conname}: ${row.definition}`).join('\n');

    for (const category of MEMORY_CATEGORIES) {
      expect(definitions).toContain(category);
    }
    for (const trustTier of TRUST_TIERS) {
      expect(definitions).toContain(trustTier);
    }
    expect(definitions).toContain('high');
    expect(definitions).toContain('medium');
    expect(definitions).toContain('low');
    expect(definitions).toContain('pending');
    expect(definitions).toContain('approved');
    expect(definitions).toContain('rejected');
    expect(definitions).toContain('superseded');
    expect(definitions).toContain('FOREIGN KEY (context_event_id)');
    expect(definitions).toContain('FOREIGN KEY (promoted_memory_id)');
    expect(definitions).toContain('jsonb_typeof(related_files)');
    expect(definitions).toContain('jsonb_typeof(metadata)');
  });

  it('has unique idempotency and review/source/promotion indexes', async () => {
    const rows = await query<IndexRow>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = $1`,
      ['memory_candidates'],
    );
    const indexes = rows.map((row) => `${row.indexname}: ${row.indexdef}`).join('\n');

    expect(indexes).toMatch(/UNIQUE.*idempotency_key/i);
    expect(indexes).toContain('idx_memory_candidates_workspace_status');
    expect(indexes).toContain('idx_memory_candidates_workspace_category');
    expect(indexes).toContain('idx_memory_candidates_context_event');
    expect(indexes).toContain('idx_memory_candidates_promoted_memory');
    expect(indexes).toContain('idx_memory_candidates_requires_review');
    expect(indexes).toContain('idx_memory_candidates_related_files');
  });

  it('accepts exactly the six durable memory categories', async () => {
    for (const category of MEMORY_CATEGORIES) {
      const row = await insertMemoryCandidate(`category-${category}`, {
        suggested_category: category,
        idempotency_key: `candidate:category:${category}`,
      });
      expect(Number(row.id)).toBeGreaterThan(0);
    }
  });

  it('stores candidate-only metadata and links candidates to context events', async () => {
    const event = await insertContextEvent('candidate-metadata', {
      event_type: 'incident',
      source_system: 'pagerduty',
      source_ref: 'incident:123',
      idempotency_key: 'context:candidate-metadata',
      trust_tier: 'working_note',
    });
    const candidate = await insertMemoryCandidate('metadata', {
      context_event_id: event.id,
      event_type: 'incident',
      source_system: 'pagerduty',
      source_ref: 'incident:123',
      suggested_category: 'Gotcha',
      confidence: 'medium',
      trust_tier: 'working_note',
      claim: 'Retries hid a webhook outage.',
      policy: 'Incident learnings require review before retrieval.',
      incident_learning: 'Queue failed webhooks before acknowledging receipt.',
      security_sensitive: true,
      regulated_domain: true,
      requires_review: true,
      metadata: {
        claim: 'Retries hid a webhook outage.',
        policy: 'Incident learnings require review before retrieval.',
        incident_learning: true,
        security_sensitive: true,
        regulated_domain: true,
        requires_review: true,
      },
      idempotency_key: 'candidate:metadata',
    });

    const row = await queryOne<{
      context_event_id: string;
      suggested_category: string;
      claim: string;
      policy: string;
      incident_learning: string;
      security_sensitive: boolean;
      regulated_domain: boolean;
      requires_review: boolean;
      metadata: {
        security_sensitive: boolean;
        regulated_domain: boolean;
        requires_review: boolean;
      };
    }>(
      `SELECT context_event_id::text,
              suggested_category,
              claim,
              policy,
              incident_learning,
              security_sensitive,
              regulated_domain,
              requires_review,
              metadata
       FROM memory_candidates
       WHERE id = $1`,
      [candidate.id],
    );

    expect(row?.context_event_id).toBe(event.id);
    expect(row?.suggested_category).toBe('Gotcha');
    expect(row?.claim).toContain('Retries');
    expect(row?.policy).toContain('review');
    expect(row?.incident_learning).toContain('Queue failed');
    expect(row?.security_sensitive).toBe(true);
    expect(row?.regulated_domain).toBe(true);
    expect(row?.requires_review).toBe(true);
    expect(row?.metadata.security_sensitive).toBe(true);
    expect(row?.metadata.regulated_domain).toBe(true);
    expect(row?.metadata.requires_review).toBe(true);
  });

  it('rejects unsupported categories and raw confidence-as-trust-tier mismatches', async () => {
    await expect(
      insertMemoryCandidate('bad-category', {
        suggested_category: 'Spec Observation',
        idempotency_key: 'candidate:bad-category',
      }),
    ).rejects.toThrow(/check|memory_candidates_category/i);

    await expect(
      insertMemoryCandidate('bad-trust-tier', {
        trust_tier: 'high',
        idempotency_key: 'candidate:bad-trust-tier',
      }),
    ).rejects.toThrow(/check|memory_candidates_trust_tier/i);
  });

  it('deduplicates candidate creation through ON CONFLICT on idempotency_key', async () => {
    await insertMemoryCandidate('dedupe', { idempotency_key: 'candidate:dedupe' });

    const duplicate = await execute(
      `INSERT INTO memory_candidates (
         workspace_id, suggested_category, title, rule, idempotency_key
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        TEST_WORKSPACE_ID,
        'Decision',
        'Duplicate candidate',
        'Duplicate rule',
        'candidate:dedupe',
      ],
    );

    const row = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM memory_candidates
       WHERE workspace_id = $1
         AND idempotency_key = $2`,
      [TEST_WORKSPACE_ID, 'candidate:dedupe'],
    );
    expect(duplicate.rowCount).toBe(0);
    expect(row?.count).toBe('1');
  });
});

describe('migration idempotency', () => {
  it('can apply the CCS-002 migration SQL to an already-migrated schema twice', async () => {
    await execute('DELETE FROM public.schema_migrations WHERE version = $1', [MIGRATION_VERSION]);
    await expect(runPgMigrations(pool)).resolves.toBeUndefined();

    await execute('DELETE FROM public.schema_migrations WHERE version = $1', [MIGRATION_VERSION]);
    await expect(runPgMigrations(pool)).resolves.toBeUndefined();

    const row = await queryOne<{ version: string; filename: string }>(
      `SELECT version::text AS version, filename
       FROM public.schema_migrations
       WHERE version = $1`,
      [MIGRATION_VERSION],
    );
    expect(row?.version).toBe(String(MIGRATION_VERSION));
    expect(row?.filename).toBe(MIGRATION_FILENAME);
  });
});
