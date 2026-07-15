#!/usr/bin/env npx tsx
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Disposable Wave 3 PostgreSQL certification harness.
 *
 * This process never starts a Rorca server or worker. It lets pg-boss create its
 * own schema, explicitly creates the two Always-On queues, and synchronously
 * pumps deterministic fixtures through the production capture/distill handlers.
 */
import crypto from 'node:crypto';
import PgBoss from 'pg-boss';
import { closePool, execute, query, queryOne } from '../src/db/index';
import {
  CONTEXT_CAPTURE_QUEUE,
  CONTEXT_DISTILL_QUEUE,
  handleContextCaptureJobs,
  handleContextDistillationJobs,
} from '../src/lib/context-distillation';
import {
  ContextCaptureEventJobPayload,
  deriveContextEventIdempotencyKey,
  type ContextCaptureEventJobPayloadType,
} from '../src/lib/context-capture-contracts';
import { hashCaptureContent, sanitizeCliCommandEvent } from '../src/lib/context-safety';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!databaseName.includes('rorca_wave3_cert_')) {
  throw new Error(`Refusing non-certification database: ${databaseName || '(ambiguous)'}`);
}

const workspaceId = `wave3-${crypto.randomBytes(5).toString('hex')}`;
const occurredAt = '2026-07-15T00:00:00.000Z';

function baseEnvelope() {
  return {
    payload_schema_version: '2026-07-ucc-007.v1' as const,
    source_identity: {
      source_system: 'shell' as const,
      tool_name: 'shell',
      host_application: null,
      session_id: 'wave3-session',
      workspace_id: workspaceId,
      repo_path_hash: null,
    },
    source_system: 'shell' as const,
    tool_name: 'shell',
    host_application: null,
    session_id: 'wave3-session',
    workspace_id: workspaceId,
    repo_path_hash: null,
    git_branch: null,
    git_sha: null,
    related_files: [],
    capture_policy: {
      policy_version: '2026-07-ucc-007',
      mode: 'metadata-only' as const,
      raw_content: 'metadata' as const,
    },
    trust_tier: 'local' as const,
    provenance: {
      capture_source: 'shellIntegration' as const,
      source_event_id: 'wave3-metadata-event',
      adapter_version: 'wave3-cert',
      emitted_at: occurredAt,
      received_at: occurredAt,
      local_only: true,
    },
  };
}

function metadataOnlyJob(): ContextCaptureEventJobPayloadType {
  const sanitized = sanitizeCliCommandEvent({
    eventType: 'shell_command',
    command: 'printf wave3-certification',
    policyMode: 'metadata-only',
    source_system: 'shell',
    tool_name: 'shell',
    session_id: 'wave3-session',
    phase: 'end',
    exitCode: 0,
  });
  if (!sanitized.payload) throw new Error('metadata-only fixture was unexpectedly suppressed');
  const idempotencyKey = deriveContextEventIdempotencyKey({
    eventType: 'shell_command',
    source_system: 'shell',
    tool_name: 'shell',
    session_id: 'wave3-session',
    workspace_id: workspaceId,
    occurred_at: occurredAt,
    command_hash: String(sanitized.payload.command_hash),
    phase: 'end',
    exit_code: 0,
  });
  const payload = {
    ...baseEnvelope(),
    ...sanitized.payload,
    idempotency_key: idempotencyKey,
  };
  return ContextCaptureEventJobPayload.parse({
    workspaceId,
    source: 'shellIntegration',
    occurredAt,
    payload,
    safety: {
      contextSafetyModule: 'backend/src/lib/context-safety.ts',
      policyVersion: '2026-07-ucc-007',
      redactionCount: sanitized.safety.redactionCount,
      ignoredPathCount: sanitized.safety.ignoredPathCount,
      truncated: sanitized.safety.truncated,
      hashAlgorithm: 'sha256',
      contentHash: hashCaptureContent(payload),
      redactionTypes: sanitized.safety.redactionTypes,
      regulatedSignals: sanitized.safety.regulatedSignals,
    },
  });
}

function explicitMemoryJob(): ContextCaptureEventJobPayloadType {
  const memorySummary = 'Always create pg-boss queues before sending jobs.';
  const memoryHash = `sha256:${crypto.createHash('sha256').update(memorySummary).digest('hex')}`;
  const idempotencyKey = deriveContextEventIdempotencyKey({
    eventType: 'explicit_memory',
    source_system: 'mcp',
    tool_name: 'wave3-cert',
    session_id: 'wave3-session',
    workspace_id: workspaceId,
    occurred_at: occurredAt,
    memory_hash: memoryHash,
  });
  const payload = {
    ...baseEnvelope(),
    source_identity: {
      ...baseEnvelope().source_identity,
      source_system: 'mcp' as const,
      tool_name: 'wave3-cert',
    },
    source_system: 'mcp' as const,
    tool_name: 'wave3-cert',
    capture_policy: {
      policy_version: '2026-07-ucc-007',
      mode: 'full' as const,
      raw_content: 'explicit' as const,
    },
    provenance: {
      ...baseEnvelope().provenance,
      capture_source: 'mcpSlashCommand' as const,
      source_event_id: 'wave3-explicit-event',
    },
    eventType: 'explicit_memory' as const,
    idempotency_key: idempotencyKey,
    memory_hash: memoryHash,
    memory_summary: memorySummary,
    category: 'Decision',
    requested_by: 'human' as const,
  };
  return ContextCaptureEventJobPayload.parse({
    workspaceId,
    source: 'mcpSlashCommand',
    occurredAt,
    payload,
    safety: {
      contextSafetyModule: 'backend/src/lib/context-safety.ts',
      policyVersion: '2026-07-ucc-007',
      redactionCount: 0,
      ignoredPathCount: 0,
      truncated: false,
      hashAlgorithm: 'sha256',
      contentHash: hashCaptureContent(payload),
      redactionTypes: [],
      regulatedSignals: [],
    },
  });
}

async function pumpCapture(boss: PgBoss, payload: ContextCaptureEventJobPayloadType): Promise<void> {
  const sent = await boss.send(CONTEXT_CAPTURE_QUEUE, payload, { retryLimit: 0 });
  if (!sent) throw new Error('context:capture send returned null');
  const captureJobs = await boss.fetch<unknown>(CONTEXT_CAPTURE_QUEUE, { batchSize: 1 });
  if (captureJobs.length !== 1) throw new Error(`expected one capture job, got ${captureJobs.length}`);
  await handleContextCaptureJobs(captureJobs, boss);
  await boss.complete(CONTEXT_CAPTURE_QUEUE, captureJobs[0].id);

  const distillJobs = await boss.fetch<unknown>(CONTEXT_DISTILL_QUEUE, { batchSize: 1 });
  if (distillJobs.length !== 1) throw new Error(`expected one distill job, got ${distillJobs.length}`);
  await handleContextDistillationJobs(distillJobs);
  await boss.complete(CONTEXT_DISTILL_QUEUE, distillJobs[0].id);
}

async function main(): Promise<void> {
  await execute(
    `INSERT INTO workspaces (id, label, path)
     VALUES ($1, 'Wave 3 disposable certification', '/tmp/wave3-cert-workspace')`,
    [workspaceId],
  );
  await execute(
    `INSERT INTO context_capture_settings (workspace_id, policy_mode, paused)
     VALUES ($1, 'metadata-only', FALSE)`,
    [workspaceId],
  );
  await execute(
    `INSERT INTO memory_distillation_settings
       (workspace_id, mode, operator_auto_approve, llm_summarization, max_events_per_job)
     VALUES ($1, 'conservative-auto-candidates', FALSE, FALSE, 25)`,
    [workspaceId],
  );

  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'pgboss' });
  boss.on('error', (error) => console.error('[wave3-cert] pg-boss error class:', error?.constructor?.name ?? 'unknown'));
  await boss.start();
  try {
    await boss.createQueue(CONTEXT_CAPTURE_QUEUE);
    await boss.createQueue(CONTEXT_DISTILL_QUEUE);
    await pumpCapture(boss, metadataOnlyJob());
    await pumpCapture(boss, explicitMemoryJob());

    const eventSummary = await queryOne<{
      total: string;
      metadata_only: string;
      leaked_summary: string;
      skipped: string;
      candidate: string;
    }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE payload->'capture_policy'->>'mode' = 'metadata-only')::text AS metadata_only,
              COUNT(*) FILTER (WHERE payload->>'command_summary' IS NOT NULL)::text AS leaked_summary,
              COUNT(*) FILTER (WHERE distillation_status = 'skipped')::text AS skipped,
              COUNT(*) FILTER (WHERE distillation_status = 'candidate')::text AS candidate
         FROM context_events WHERE workspace_id = $1`,
      [workspaceId],
    );
    const candidates = await query<{ review_status: string; suggested_category: string; default_retrieval_eligible: boolean }>(
      `SELECT review_status, suggested_category, default_retrieval_eligible
         FROM memory_candidates WHERE workspace_id = $1`,
      [workspaceId],
    );
    const queues = await query<{ name: string }>(
      `SELECT name FROM pgboss.queue WHERE name IN ($1, $2) ORDER BY name`,
      [CONTEXT_CAPTURE_QUEUE, CONTEXT_DISTILL_QUEUE],
    );

    if (!eventSummary || Number(eventSummary.total) !== 2) throw new Error('capture persistence invariant failed');
    if (Number(eventSummary.metadata_only) !== 1 || Number(eventSummary.leaked_summary) !== 0) {
      throw new Error('metadata-only privacy invariant failed');
    }
    if (Number(eventSummary.skipped) !== 1 || Number(eventSummary.candidate) !== 1) {
      throw new Error('distillation outcome invariant failed');
    }
    if (candidates.length !== 1 || candidates[0].review_status !== 'pending' || candidates[0].default_retrieval_eligible) {
      throw new Error('candidate governance invariant failed');
    }
    if (queues.length !== 2) throw new Error('explicit pg-boss queue invariant failed');

    console.log(JSON.stringify({
      database: databaseName,
      workspace: workspaceId,
      events: eventSummary,
      candidates,
      queues: queues.map((queue) => queue.name),
      noWorkerOrServiceStarted: true,
    }));
  } finally {
    await boss.stop({ close: true, graceful: true, timeout: 5_000 });
  }
}

main()
  .then(() => closePool())
  .catch(async (error) => {
    console.error('[wave3-cert] capture harness failed:', error instanceof Error ? error.message : String(error));
    await closePool().catch(() => undefined);
    process.exitCode = 1;
  });
