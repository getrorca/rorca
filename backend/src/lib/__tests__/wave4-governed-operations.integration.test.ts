/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import { Pool, type QueryResultRow } from 'pg';
import { AUTHENTICATED_WAKE_SOURCES, sealIdlePolicy, type IdleControllerState, type WakeAuthorityVerifier } from '../event-driven-cost-circuit';
import { createProductionEventDrivenCostCircuit, PostgresIdleCircuitStore,
  type IdleCircuitCapabilityProvider } from '../postgres-idle-circuit-store';
import { governedOperationsHash } from '../governed-operations-primitives';
import { initializeWorkerIdleCostController, type WorkerIdleCostController } from '../worker-idle-cost-controller';

const migrationDatabaseUrl = process.env.RORCA_MIGRATION_DATABASE_URL ?? process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
const runtimeDatabaseUrl = process.env.DATABASE_URL;
const writerDatabaseUrl = process.env.RORCA_CANONICAL_WRITER_DATABASE_URL;
if (!migrationDatabaseUrl || !runtimeDatabaseUrl || !writerDatabaseUrl) throw new Error('Isolated migration, writer, and runtime database URLs are required');
const owner = new Pool({ connectionString: migrationDatabaseUrl, options: '--search_path=rorca,public -c rorca.migration_mode=on' });
const runtime = new Pool({ connectionString: runtimeDatabaseUrl, options: '--search_path=rorca,public' });
const writer = new Pool({ connectionString: writerDatabaseUrl, options: '--search_path=rorca,public' });
const suffix = crypto.randomUUID();
const workspaceA = `workspace:wave4-ops-a:${suffix}`;
const workspaceB = `workspace:wave4-ops-b:${suffix}`;
const H = (value: string) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;

async function scoped<T extends QueryResultRow>(pool: Pool, workspaceId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [workspaceId]);
    const result = await client.query<T>(sql, params);
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

beforeAll(async () => {
  await owner.query('INSERT INTO rorca.workspaces(id,label,path) VALUES($1,$1,$2),($3,$3,$4)',
    [workspaceA, `/tmp/${workspaceA}`, workspaceB, `/tmp/${workspaceB}`]);
});

afterAll(async () => { await Promise.all([owner.end(), writer.end(), runtime.end()]); });

test('W4 operational migration records exact readiness without authority', async () => {
  const rows = await owner.query(`SELECT schema_version,migration_version,reviewed_wave3_git_sha,authority_effect,state
    FROM rorca.wave4_operations_schema_readiness WHERE singleton=TRUE`);
  expect(rows.rows).toEqual([{ schema_version: 'rorca.wave4-operations.v1', migration_version: '20260805110000',
    reviewed_wave3_git_sha: 'a66537fc3a5607a80f6b1010ebdde238d3b6ce8f', authority_effect: 'none', state: 'ready' }]);
});

test('W4 production cost circuit persists suspension and wake replay across controller restart', async () => {
  const controllerId = `controller:idle:${suffix}`;
  const idlePolicy = sealIdlePolicy({ schemaVersion: 'rorca.idle-cost-policy.v1', policyId: `idle-policy:${suffix}`,
    policyVersion: '1.0.0', hardMaxima: { noChangeTicks: 1, elapsedMs: 1000, providerTokens: 100,
      providerRequests: 2, currencyMicros: 1000, retries: 2 },
    exponentialSleep: { baseMs: 100, multiplier: 2, maximumMs: 800, jitterPermille: 0 },
    cooldownMs: 500, allowedWakeSources: AUTHENTICATED_WAKE_SOURCES, maximumOscillations: 3 });
  await scoped(owner, workspaceA, `INSERT INTO wave4_idle_policies(policy_id,policy_version,policy_hash,hard_maxima_json,
    exponential_sleep_json,jitter_permille,cooldown_ms,wake_sources,maximum_oscillations)
    VALUES($1,$2,$3,$4::jsonb,$5::jsonb,0,500,$6,3)`, [idlePolicy.policyId,idlePolicy.policyVersion,
    idlePolicy.policyHash,JSON.stringify(idlePolicy.hardMaxima),JSON.stringify(idlePolicy.exponentialSleep),
    [...AUTHENTICATED_WAKE_SOURCES]]);
  const capabilities: IdleCircuitCapabilityProvider = { async authorize(input) {
    const capabilityId = `idle-capability:${crypto.randomUUID()}`;
    await scoped(owner, input.workspaceId, `INSERT INTO wave4_operations_mutation_capabilities(workspace_id,
      capability_id,operation,request_hash,subject_hash,expires_at,issued_by_receipt_hash)
      VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 minute',$6)`,
    [input.workspaceId,capabilityId,input.operation,input.requestHash,input.subjectHash,H(`issuer:${capabilityId}`)]);
    return { capabilityId, requestHash: input.requestHash, subjectHash: input.subjectHash };
  } };
  const wakeAuthority: WakeAuthorityVerifier = { async verifySourceAndLoadState(request) {
    const material = { receiptId: request.sourceReceiptId, workspaceId: request.workspaceId,
      controllerId: request.controllerId, source: 'canonical_event' as const,
      subjectHash: governedOperationsHash('idle-subject'), authenticatedBy: 'canonical-writer',
      relevant: true as const, observedAt: request.requestedAt-1, expiresAt: request.requestedAt+1000 };
    return { receipt: { ...material, receiptHash: governedOperationsHash(material) },
      revalidation: { dependencyCapabilityHealthy:true,workspaceQuotaAvailable:true,runtimeQuotaAvailable:true,
        leaseFenceCurrent:true,policyActive:true,sessionCursorCurrent:true,cooldownElapsed:true,singleWriter:true } };
  } };
  const store = new PostgresIdleCircuitStore(writer, capabilities);
  const now = Date.parse('2026-08-05T16:00:00.000Z');
  await store.register({ workspaceId:workspaceA,controllerId,policyHash:idlePolicy.policyHash,status:'running',
    usage:{noChangeTicks:0,elapsedMs:0,providerTokens:0,providerRequests:0,currencyMicros:0,retries:0},
    nonessentialReservations:2,providerRequestCount:0,suspensionCount:0,wakeCount:0,oscillations:0,
    lastTransitionAt:now,escalation:null,diagnosticsRetained:true,canonicalWorkCancelled:false });
  const first = await createProductionEventDrivenCostCircuit({ policy:idlePolicy,pool:writer,capabilities,wakeAuthority,
    workspaceId:workspaceA,controllerId,now:()=>now });
  expect((await first.observeIteration(workspaceA,controllerId,{noChangeTicks:1})).status).toBe('suspended');
  const restarted = await createProductionEventDrivenCostCircuit({ policy:idlePolicy,pool:writer,capabilities,wakeAuthority,
    workspaceId:workspaceA,controllerId,now:()=>now+500 });
  expect(await restarted.providerRequestAllowed(workspaceA,controllerId)).toBe(false);
  const wakeRequest = { wakeId:`wake:${suffix}`,workspaceId:workspaceA,controllerId,
    sourceReceiptId:`canonical-event:${suffix}`,requestedAt:now+500 };
  const accepted = await restarted.requestWake(wakeRequest);
  expect(accepted.accepted).toBe(true);
  expect(accepted.state.status).toBe('running');
  expect((await restarted.observeIteration(workspaceA,controllerId,{noChangeTicks:1})).status).toBe('suspended');
  expect(await restarted.providerRequestAllowed(workspaceA,controllerId)).toBe(false);
  const restartedAgain = await createProductionEventDrivenCostCircuit({ policy:idlePolicy,pool:writer,capabilities,wakeAuthority,
    workspaceId:workspaceA,controllerId,now:()=>now+500 });
  expect(await restartedAgain.requestWake(wakeRequest)).toEqual(accepted);
  expect((await store.load(workspaceA,controllerId))?.status).toBe('suspended');
  expect(await restartedAgain.providerRequestAllowed(workspaceA,controllerId)).toBe(false);
});

test('W4 worker settings loop uses the durable production circuit and exact preissued mutation capability', async () => {
  const controllerId = `controller:worker-settings:${suffix}`;
  const policy = sealIdlePolicy({ schemaVersion:'rorca.idle-cost-policy.v1',policyId:`worker-policy:${suffix}`,policyVersion:'1.0.0',
    hardMaxima:{noChangeTicks:2,elapsedMs:1000,providerTokens:100,providerRequests:2,currencyMicros:1000,retries:2},
    exponentialSleep:{baseMs:100,multiplier:2,maximumMs:800,jitterPermille:0},cooldownMs:500,
    allowedWakeSources:AUTHENTICATED_WAKE_SOURCES,maximumOscillations:3 });
  await scoped(owner,workspaceA,`INSERT INTO wave4_idle_policies(policy_id,policy_version,policy_hash,hard_maxima_json,
    exponential_sleep_json,jitter_permille,cooldown_ms,wake_sources,maximum_oscillations)
    VALUES($1,$2,$3,$4::jsonb,$5::jsonb,0,500,$6,3)`,[policy.policyId,policy.policyVersion,policy.policyHash,
    JSON.stringify(policy.hardMaxima),JSON.stringify(policy.exponentialSleep),[...AUTHENTICATED_WAKE_SOURCES]]);
  const initial:IdleControllerState={workspaceId:workspaceA,controllerId,policyHash:policy.policyHash,status:'running',
    usage:{noChangeTicks:0,elapsedMs:0,providerTokens:0,providerRequests:0,currencyMicros:0,retries:0},
    nonessentialReservations:0,providerRequestCount:0,suspensionCount:0,wakeCount:0,oscillations:0,lastTransitionAt:100,
    escalation:null,diagnosticsRetained:true,canonicalWorkCancelled:false};
  const next:IdleControllerState={...initial,usage:{...initial.usage,noChangeTicks:1,elapsedMs:100}};
  const initialHash=governedOperationsHash(initial),nextHash=governedOperationsHash(next);
  const requestHash=governedOperationsHash({operation:'idle.observe',expectedStateHash:initialHash,nextHash});
  await scoped(owner,workspaceA,`INSERT INTO wave4_idle_controller_states(workspace_id,controller_id,policy_hash,state,
    usage_json,state_json,state_hash,last_transition_at) VALUES($1,$2,$3,'running',$4::jsonb,$5::jsonb,$6,clock_timestamp())`,
  [workspaceA,controllerId,policy.policyHash,JSON.stringify(initial.usage),JSON.stringify(initial),initialHash]);
  await scoped(owner,workspaceA,`INSERT INTO wave4_operations_mutation_capabilities(workspace_id,capability_id,operation,
    request_hash,subject_hash,expires_at,issued_by_receipt_hash) VALUES($1,$2,'idle.observe',$3,$4,clock_timestamp()+interval '1 minute',$5)`,
  [workspaceA,`worker-capability:${suffix}`,requestHash,governedOperationsHash([workspaceA,controllerId]),H(`worker-issuer:${suffix}`)]);
  const previous={policy:process.env.RORCA_WAVE4_IDLE_POLICY_JSON,workspace:process.env.RORCA_WAVE4_IDLE_WORKSPACE_ID,
    controller:process.env.RORCA_WAVE4_IDLE_CONTROLLER_ID};
  process.env.RORCA_WAVE4_IDLE_POLICY_JSON=JSON.stringify(policy);
  process.env.RORCA_WAVE4_IDLE_WORKSPACE_ID=workspaceA;
  process.env.RORCA_WAVE4_IDLE_CONTROLLER_ID=controllerId;
  const wired=await initializeWorkerIdleCostController();
  try{
    expect(wired).not.toBeNull();
    expect(await wired?.beforeIteration(100)).toBe(true);
    expect(wired?.snapshot().usage).toMatchObject({noChangeTicks:1,elapsedMs:100});
  }finally{
    await wired?.close();
    if(previous.policy===undefined)delete process.env.RORCA_WAVE4_IDLE_POLICY_JSON;else process.env.RORCA_WAVE4_IDLE_POLICY_JSON=previous.policy;
    if(previous.workspace===undefined)delete process.env.RORCA_WAVE4_IDLE_WORKSPACE_ID;else process.env.RORCA_WAVE4_IDLE_WORKSPACE_ID=previous.workspace;
    if(previous.controller===undefined)delete process.env.RORCA_WAVE4_IDLE_CONTROLLER_ID;else process.env.RORCA_WAVE4_IDLE_CONTROLLER_ID=previous.controller;
  }
});

test('W4 worker skips a handled wake receipt and processes a newer valid receipt after resuspension', async () => {
  const controllerId=`controller:wake-skip:${suffix}`,fixed=Date.now();
  const policy=sealIdlePolicy({schemaVersion:'rorca.idle-cost-policy.v1',policyId:`wake-skip-policy:${suffix}`,policyVersion:'1.0.0',
    hardMaxima:{noChangeTicks:10,elapsedMs:10000,providerTokens:100,providerRequests:10,currencyMicros:1000,retries:10},
    exponentialSleep:{baseMs:100,multiplier:2,maximumMs:800,jitterPermille:0},cooldownMs:0,
    allowedWakeSources:AUTHENTICATED_WAKE_SOURCES,maximumOscillations:3});
  await scoped(owner,workspaceA,`INSERT INTO wave4_idle_policies(policy_id,policy_version,policy_hash,hard_maxima_json,
    exponential_sleep_json,jitter_permille,cooldown_ms,wake_sources,maximum_oscillations)
    VALUES($1,$2,$3,$4::jsonb,$5::jsonb,0,0,$6,3)`,[policy.policyId,policy.policyVersion,policy.policyHash,
    JSON.stringify(policy.hardMaxima),JSON.stringify(policy.exponentialSleep),[...AUTHENTICATED_WAKE_SOURCES]]);
  const suspended:IdleControllerState={workspaceId:workspaceA,controllerId,policyHash:policy.policyHash,status:'suspended',
    usage:{noChangeTicks:10,elapsedMs:0,providerTokens:0,providerRequests:0,currencyMicros:0,retries:0},
    nonessentialReservations:0,providerRequestCount:0,suspensionCount:2,wakeCount:0,oscillations:0,lastTransitionAt:fixed-1000,
    escalation:{escalationId:H(`suspended:${suffix}`),workspaceId:workspaceA,controllerId,reasonCode:'idle_hard_limit_noChangeTicks',
      detail:'redacted',authorityEffect:'none'},diagnosticsRetained:true,canonicalWorkCancelled:false};
  const suspendedHash=governedOperationsHash(suspended);
  await scoped(owner,workspaceA,`INSERT INTO wave4_idle_controller_states(workspace_id,controller_id,policy_hash,state,
    usage_json,state_json,state_hash,last_transition_at) VALUES($1,$2,$3,'suspended',$4::jsonb,$5::jsonb,$6,clock_timestamp())`,
  [workspaceA,controllerId,policy.policyHash,JSON.stringify(suspended.usage),JSON.stringify(suspended),suspendedHash]);
  const revalidation={dependencyCapabilityHealthy:true,workspaceQuotaAvailable:true,runtimeQuotaAvailable:true,
    leaseFenceCurrent:true,policyActive:true,sessionCursorCurrent:true,cooldownElapsed:true,singleWriter:true};
  const oldReceipt=`old:${suffix}`,newReceipt=`new:${suffix}`;
  for(const [receipt,offset] of [[oldReceipt,-200],[newReceipt,-100]] as const){
    await scoped(owner,workspaceA,`INSERT INTO wave4_idle_wake_source_receipts(workspace_id,controller_id,source_receipt_id,
      receipt_hash,source,subject_hash,authenticated_by,relevant,observed_at,expires_at,revalidation_json)
      VALUES($1,$2,$3,$4,'canonical_event',$5,'canonical-event-writer',TRUE,$6,$7,$8::jsonb)`,
    [workspaceA,controllerId,receipt,H(`source:${receipt}`),H(`subject:${receipt}`),new Date(fixed+offset),
      new Date(fixed+60000),JSON.stringify(revalidation)]);
  }
  const historical={accepted:true,reasonCode:'one_iteration_authorized',
    state:{...suspended,status:'running',usage:{noChangeTicks:0,elapsedMs:0,providerTokens:0,providerRequests:0,currencyMicros:0,retries:0}},
    verifiedSource:'canonical_event'};
  await scoped(owner,workspaceA,`INSERT INTO wave4_idle_wake_receipts(workspace_id,controller_id,wake_id,request_hash,
    source,authenticated,relevant,accepted,reason_code,result_json) VALUES($1,$2,$3,$4,'canonical_event',TRUE,TRUE,TRUE,
    'one_iteration_authorized',$5::jsonb)`,[workspaceA,controllerId,`source:${oldReceipt}`,H(`historical-request:${suffix}`),
    JSON.stringify(historical)]);
  const request={wakeId:`source:${newReceipt}`,workspaceId:workspaceA,controllerId,sourceReceiptId:newReceipt,requestedAt:fixed};
  const wakeRequestHash=governedOperationsHash(request);
  const woken:IdleControllerState={...suspended,status:'running',
    usage:{noChangeTicks:0,elapsedMs:0,providerTokens:0,providerRequests:0,currencyMicros:0,retries:0},
    wakeCount:1,oscillations:1,lastTransitionAt:fixed,escalation:null};
  const wokenHash=governedOperationsHash(woken);
  const wakeMutationHash=governedOperationsHash({operation:'idle.wake',expectedStateHash:suspendedHash,nextHash:wokenHash,
    wakeId:request.wakeId,requestHash:wakeRequestHash});
  const observed:IdleControllerState={...woken,usage:{...woken.usage,noChangeTicks:1,elapsedMs:100}};
  const observeMutationHash=governedOperationsHash({operation:'idle.observe',expectedStateHash:wokenHash,
    nextHash:governedOperationsHash(observed)});
  for(const [id,operation,requestHash] of [
    [`wake-skip-wake:${suffix}`,'idle.wake',wakeMutationHash],[`wake-skip-observe:${suffix}`,'idle.observe',observeMutationHash],
  ] as const){
    await scoped(owner,workspaceA,`INSERT INTO wave4_operations_mutation_capabilities(workspace_id,capability_id,operation,
      request_hash,subject_hash,expires_at,issued_by_receipt_hash) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 minute',$6)`,
    [workspaceA,id,operation,requestHash,governedOperationsHash([workspaceA,controllerId]),H(`issuer:${id}`)]);
  }
  const previous={policy:process.env.RORCA_WAVE4_IDLE_POLICY_JSON,workspace:process.env.RORCA_WAVE4_IDLE_WORKSPACE_ID,
    controller:process.env.RORCA_WAVE4_IDLE_CONTROLLER_ID};
  const originalNow=Date.now;
  process.env.RORCA_WAVE4_IDLE_POLICY_JSON=JSON.stringify(policy);
  process.env.RORCA_WAVE4_IDLE_WORKSPACE_ID=workspaceA;
  process.env.RORCA_WAVE4_IDLE_CONTROLLER_ID=controllerId;
  Date.now=()=>fixed;
  let wired:WorkerIdleCostController|null=null;
  try{
    wired=await initializeWorkerIdleCostController();
    expect(await wired?.beforeIteration(100)).toBe(true);
    expect(wired?.snapshot()).toMatchObject({status:'running',wakeCount:1,usage:{noChangeTicks:1,elapsedMs:100}});
    expect((await scoped<{wake_id:string}>(writer,workspaceA,`SELECT wake_id FROM wave4_idle_wake_receipts
      WHERE workspace_id=$1 AND controller_id=$2 ORDER BY wake_id`,[workspaceA,controllerId])).map(row=>row.wake_id))
      .toEqual([`source:${newReceipt}`,`source:${oldReceipt}`].sort());
  }finally{
    await wired?.close();
    Date.now=originalNow;
    if(previous.policy===undefined)delete process.env.RORCA_WAVE4_IDLE_POLICY_JSON;else process.env.RORCA_WAVE4_IDLE_POLICY_JSON=previous.policy;
    if(previous.workspace===undefined)delete process.env.RORCA_WAVE4_IDLE_WORKSPACE_ID;else process.env.RORCA_WAVE4_IDLE_WORKSPACE_ID=previous.workspace;
    if(previous.controller===undefined)delete process.env.RORCA_WAVE4_IDLE_CONTROLLER_ID;else process.env.RORCA_WAVE4_IDLE_CONTROLLER_ID=previous.controller;
  }
});

test('W4 Doctor transitions use one PostgreSQL lock and reject phase skipping and changed idempotency replay', async () => {
  const checkHash = H(`check:${suffix}`);
  await scoped(owner, workspaceA, `INSERT INTO wave4_doctor_definitions(workspace_id,definition_id,definition_kind,
    subject_id,subject_revision,subject_class,condition_type,severity,capability,evidence_source_id,evidence_source_revision,
    evidence_maximum_age_ms,precondition_json,postcondition_json,definition_hash)
    VALUES($1,$2,'check',$3,'revision:1','rebuildable_projection','drifted','error','rebuild_projection',$4,'revision:observer',60000,
      '{"condition":"drifted"}'::jsonb,'{"condition":"healthy"}'::jsonb,$5)`,
  [workspaceA, `check:${suffix}`, `projection:${suffix}`, `observer:${suffix}`, checkHash]);
  await scoped(owner, workspaceA, `INSERT INTO wave4_doctor_invocations(workspace_id,invocation_id,idempotency_key,request_hash,
    subject_id,subject_revision,check_definition_hash,preview_hash,preview_expires_at,fence,apply_requested,maximum_attempts,
    wall_clock_budget_ms,provider_cost_budget_micros,resource_budget_units,rate_limit_per_minute,cooldown_ms,state)
    VALUES($1,$2,$3,$4,$5,'revision:1',$6,$7,clock_timestamp()+interval '1 minute',1,FALSE,1,1000,0,1,1,0,'proposed')`,
  [workspaceA, `invocation:${suffix}`, `idempotency:${suffix}`, H(`request:${suffix}`), `projection:${suffix}`, checkHash, H(`preview:${suffix}`)]);
  await scoped(owner, workspaceA, `SELECT record_wave4_doctor_transition_v1($1,$2,1,'detect','recorded',$3,'workspace scoped observation')`,
    [workspaceA, `invocation:${suffix}`, H(`observation:${suffix}`)]);
  await expect(scoped(owner, workspaceA, `SELECT record_wave4_doctor_transition_v1($1,$2,3,'propose','recorded',$3,'skip')`,
    [workspaceA, `invocation:${suffix}`, H(`skip:${suffix}`)])).rejects.toMatchObject({ code: '55000' });
  await expect(scoped(owner, workspaceA, `INSERT INTO wave4_doctor_invocations(workspace_id,invocation_id,idempotency_key,request_hash,
    subject_id,subject_revision,check_definition_hash,preview_hash,preview_expires_at,fence,apply_requested,maximum_attempts,
    wall_clock_budget_ms,provider_cost_budget_micros,resource_budget_units,rate_limit_per_minute,cooldown_ms,state)
    VALUES($1,$2,$3,$4,$5,'revision:1',$6,$7,clock_timestamp()+interval '1 minute',1,FALSE,1,1000,0,1,1,0,'proposed')`,
    [workspaceA, `invocation:changed:${suffix}`, `idempotency:${suffix}`, H(`changed-request:${suffix}`),
      `projection:${suffix}`, checkHash, H(`changed-preview:${suffix}`)])).rejects.toMatchObject({ code: '23505' });
});

test('W4 canonical inventory is workspace isolated and immutable external/credential identity cannot be rewritten', async () => {
  for (const workspaceId of [workspaceA, workspaceB]) {
    await scoped(owner, workspaceId, `INSERT INTO wave4_resource_inventory(workspace_id,resource_type,external_id,owner_labels,
      provider,account_id,region,desired_revision,observed_revision,credential_reference_id,dependencies,retention_class,
      lifecycle_status,row_hash,created_at,updated_at)
      VALUES($1,'provider_project',$2,$3::jsonb,'fake','account','local','revision:1','revision:1',$4,'[]'::jsonb,
        'evidence_retained','admitted',$5,clock_timestamp(),clock_timestamp())`,
    [workspaceId, `external:${workspaceId}`, JSON.stringify({ workspace: workspaceId, owner: 'wave4-pilot' }),
      `vault://${workspaceId}/credential/v1`, H(`inventory:${workspaceId}`)]);
  }
  const visible = await scoped<{ workspace_id: string }>(runtime, workspaceA,
    'SELECT workspace_id FROM wave4_resource_inventory ORDER BY workspace_id');
  expect(visible).toEqual([{ workspace_id: workspaceA }]);
  await expect(scoped(owner, workspaceA, `UPDATE wave4_resource_inventory SET external_id=$1
    WHERE workspace_id=$2 AND resource_type='provider_project'`, [`replacement:${suffix}`, workspaceA]))
    .rejects.toMatchObject({ code: '42501' });
  await expect(scoped(owner, workspaceA, `UPDATE wave4_resource_inventory SET credential_reference_id=$1
    WHERE workspace_id=$2 AND resource_type='provider_project'`, [`vault://${workspaceA}/credential/v2`, workspaceA]))
    .rejects.toMatchObject({ code: '42501' });
});

test('W4 replacement saga requires exact lineage, independent review, and revalidation', async () => {
  const insert = `INSERT INTO wave4_resource_sagas(workspace_id,saga_id,operation,idempotency_key,request_hash,
    resource_type,external_id,lineage_external_id,replacement_review_hash,replacement_revalidated,separately_authorized,
    state,provider_kind) VALUES($1,$2,'new_identity_replacement',$3,$4,'provider_project',$5,$6,$7,$8,TRUE,
      'admitted','local_fake_provider')`;
  await expect(scoped(owner, workspaceA, insert, [workspaceA, `replacement:invalid:${suffix}`,
    `replacement:invalid:${suffix}`, H('replacement-invalid'), `external:new:${suffix}`,
    `external:${workspaceA}`, null, false])).rejects.toMatchObject({ code: '23514' });
  await scoped(owner, workspaceA, insert, [workspaceA, `replacement:valid:${suffix}`,
    `replacement:valid:${suffix}`, H('replacement-valid'), `external:new:${suffix}`,
    `external:${workspaceA}`, H('independent-replacement-review'), true]);
});

test('W4 runtime principal has read-only operations access and cannot self-authorize state or reviews', async () => {
  await expect(scoped(runtime, workspaceA, `UPDATE wave4_idle_controller_states SET state='running'
    WHERE workspace_id=$1`, [workspaceA])).rejects.toMatchObject({ code: '42501' });
  await expect(scoped(runtime, workspaceA, `INSERT INTO wave4_operations_independent_reviews(workspace_id,packet_hash,
    reviewer_identity_hash,architecture_findings,security_findings,operations_findings,blocking_findings,verdict)
    VALUES($1,$2,$3,0,0,0,0,'accepted')`, [workspaceA, H('forged-packet'), H('forged-reviewer')]))
    .rejects.toMatchObject({ code: '42501' });
  await expect(scoped(runtime, workspaceA, `INSERT INTO wave4_clean_room_certificates(workspace_id,certificate_hash,lane,
    source_sha,migration_hash,contract_hash,spec_hash,artifact_set_hash,tool_versions,exact_commands,observations,
    unresolved_blockers,cleanup_hash) VALUES($1,$2,'managed',$3,$4,$5,$6,$7,'{}','[]','[]','[]',$8)`,
    [workspaceA,H('forged-certificate'),'a'.repeat(40),H('migration'),H('contract'),H('spec'),H('artifact'),H('cleanup')]))
    .rejects.toMatchObject({ code: '42501' });
});

test('W4 isolation receipts require unchanged protected state and zero provider mutation', async () => {
  await expect(scoped(owner, workspaceA, `INSERT INTO wave4_isolation_fault_receipts(workspace_id,protected_workspace_id,lane,budget,
    before_hash,after_hash,zero_leakage,provider_mutation_count,receipt_hash)
    VALUES($1,$2,'managed','cpuMillis',$3,$4,TRUE,0,$5)`,
  [workspaceA, workspaceB, H('before'), H('changed'), H('receipt')])).rejects.toMatchObject({ code: '23514' });
  await scoped(owner, workspaceA, `INSERT INTO wave4_isolation_fault_receipts(workspace_id,protected_workspace_id,lane,budget,
    before_hash,after_hash,zero_leakage,provider_mutation_count,receipt_hash)
    VALUES($1,$2,'managed','cpuMillis',$3,$3,TRUE,0,$4)`,
  [workspaceA, workspaceB, H('before'), H('receipt')]);
});
