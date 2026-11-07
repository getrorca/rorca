/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * One-off operator recovery for the Hermes Gateway spec enrich stage.
 *
 * State: pgboss spec:enrich job `0dfc291c-…` is terminal-failed (old worker's
 * pre-fix code threw `text = uuid` during stage claim), while the application
 * job `4284e810-…` stayed `pending` and the stage/run stayed `queued`.
 * Repair is blocked by active_workflow_run; admin reconcile rejects with
 * application_job_nonterminal; transport re-publication of a terminal job
 * cannot succeed. The designed terminal CAS for this exact state is the
 * exported, tested `recoverExactPostSaveJob` (same function the repair flow
 * calls via markStaleQueuedJobRecovering). This script applies exactly that
 * CAS with the frozen identities, then the operator reconcile endpoint settles
 * the stage from terminal evidence.
 */
import { recoverExactPostSaveJob } from '../src/db/spec-jobs';
import { closePool } from '../src/db/index';

async function main(): Promise<void> {
  const recovered = await recoverExactPostSaveJob({
    jobId: '4284e810-3145-4823-b310-3c7c363d40f9',
    workspaceId: 'rorca-mission-os',
    specId: 'hermes-mission-gateway-evidence-driven-mission-compilation',
    stageKey: 'enrich',
    bossJobId: '0dfc291c-7a80-45f9-ad4c-8396b32d063e',
    transportSchema: 'pgboss',
    saveGeneration: 461,
    message: 'Recovered by exact repair CAS: transport terminal before runner (old worker text=uuid cast defect)',
  });
  console.log(`recoverExactPostSaveJob -> ${recovered}`);
  await closePool();
  process.exit(recovered ? 0 : 1);
}

void main();
