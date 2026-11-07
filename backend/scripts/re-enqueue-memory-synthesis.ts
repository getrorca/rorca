/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import dotenv from 'dotenv';
import path from 'path';
import { randomUUID } from 'crypto';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
import { initBoss, getBoss } from '../src/lib/pg-boss';
import { execute } from '../src/db/index';

async function main(): Promise<void> {
  const specId = process.argv[2] ?? 'categoric-consolidated-reporting-accountant-copilot';
  const workspaceId = process.argv[3] ?? 'categoric';
  const jobId = process.argv[4] ?? '289fbb17-8712-4504-86b0-0b618a01f910';
  const workflowRunId = Number(process.argv[5] ?? '33');
  const stage = 'memorySynthesis';
  const queueName = 'spec:memory-synthesis';
  const transportSchema = 'pgboss';
  const bossJobId = randomUUID();

  const updated = await execute(
    `UPDATE rorca.spec_jobs
        SET boss_job_id = $1, transport_schema = $2, status = 'pending',
            error_message = NULL, finished_at = NULL
      WHERE id = $3 AND workspace_id = $4 AND spec_id = $5 AND job_type = 'memory-synthesis'
      RETURNING id`,
    [bossJobId, transportSchema, jobId, workspaceId, specId],
  );
  if ((updated.rowCount ?? 0) !== 1) throw new Error(`spec_jobs row not rebound: ${jobId}`);
  const stageUpdated = await execute(
    `UPDATE rorca.spec_post_save_workflow_stages
        SET boss_job_id = $1, status = 'queued', queue_name = $2, transport_schema = $3,
            error_message = NULL, finished_at = NULL
      WHERE run_id = $4 AND stage_key = $5 AND job_id = $6
      RETURNING id`,
    [bossJobId, queueName, transportSchema, workflowRunId, stage, jobId],
  );
  if ((stageUpdated.rowCount ?? 0) !== 1) throw new Error(`stage row not rebound: run ${workflowRunId} ${stage}`);
  const runUpdated = await execute(
    `UPDATE rorca.spec_post_save_workflow_runs
        SET status = 'queued', finished_at = NULL, updated_at = NOW()
      WHERE id = $1 AND spec_id = $2 AND workspace_id = $3
      RETURNING id`,
    [workflowRunId, specId, workspaceId],
  );
  if ((runUpdated.rowCount ?? 0) !== 1) throw new Error(`workflow run not requeued: ${workflowRunId}`);
  const payloadPatched = await execute(
    `UPDATE rorca.spec_jobs
        SET request_payload = jsonb_set(
              jsonb_set(
                jsonb_set(
                  jsonb_set(
                    jsonb_set(request_payload::jsonb, '{bossJobId}', to_jsonb($1::text)),
                    '{queueName}', to_jsonb($2::text)),
                  '{transportSchema}', to_jsonb($3::text)),
                '{workflowRunId}', to_jsonb($4::int)),
              '{stage}', to_jsonb($5::text))
      WHERE id = $6 AND workspace_id = $7 AND spec_id = $8
      RETURNING id`,
    [bossJobId, queueName, transportSchema, workflowRunId, stage, jobId, workspaceId, specId],
  );
  if ((payloadPatched.rowCount ?? 0) !== 1) throw new Error(`request payload not patched: ${jobId}`);

  await initBoss();
  const boss = getBoss();
  await boss.createQueue(queueName);
  const sent = await boss.send(queueName, {
    jobId,
    specId,
    workspaceId,
    workflowRunId,
    stage,
    bossJobId,
    queueName,
    transportSchema,
  }, { id: bossJobId, priority: 1, retryLimit: 0 });
  process.stdout.write(JSON.stringify({ sent, bossJobId, jobId, workflowRunId }) + '\n');
  process.exit(0);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
