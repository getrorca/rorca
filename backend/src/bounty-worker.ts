/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Dedicated Linux-only bounty worker. Never import from the ordinary pipeline worker. */
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { queryOne } from './db';
import { initBoss, getBoss } from './lib/pg-boss';
import { resolveBountyFeaturePolicy } from './lib/bounty-feature-policy';
import { registerBountyEffectWorkers } from './lib/bounty-worker-boundary';
import { registerIsolatedBountyProposalLane, type BountyIsolatedProposalJob } from './lib/bounty-isolated-worker-lane';
import { persistBountyWorkerProposal } from './lib/bounty-controller';
import { ServiceUnavailableError } from './lib/errors';

interface Assignment { id:string; mission_id:string; work_package_id:string; attempt_id:string; route_package_hash:string; worker_executable_hash:string; target_broker_socket_identity:string; provider_policy_hash:string; provider_exact_origin_hash:string; authority_epoch:string; assignment_body:{ providerExactOrigin?:string } }
const required=(name:string):string=>{const value=String(process.env[name]??'').trim();if(!value)throw new ServiceUnavailableError(`${name} is required for the dedicated bounty worker`);return value;};
async function packagePath(root:string,id:string):Promise<string>{const canonicalRoot=await realpath(root);const candidate=await realpath(resolve(canonicalRoot,`${id}.json`));if(relative(canonicalRoot,candidate).startsWith('..'))throw new ServiceUnavailableError('Bounty package escaped its immutable root');return candidate;}

export async function startBountyWorker():Promise<void>{
  if(process.platform!=='linux')throw new ServiceUnavailableError('The production bounty worker requires qualified Linux isolation');
  const packageRoot=required('RORCA_BOUNTY_PACKAGE_ROOT');if(!isAbsolute(packageRoot))throw new ServiceUnavailableError('RORCA_BOUNTY_PACKAGE_ROOT must be absolute');
  const workerExecutable=required('RORCA_BOUNTY_WORKER_EXECUTABLE'); const targetBrokerRoot=required('RORCA_BOUNTY_TARGET_BROKER_ROOT'); const targetBrokerSocket=required('RORCA_BOUNTY_TARGET_BROKER_SOCKET'); const providerBrokerRoot=required('RORCA_BOUNTY_PROVIDER_BROKER_ROOT'); const providerBrokerSocket=required('RORCA_BOUNTY_PROVIDER_BROKER_SOCKET'); const providerExactOrigin=required('RORCA_BOUNTY_PROVIDER_EXACT_ORIGIN');
  await initBoss();
  const policy=await resolveBountyFeaturePolicy();
  const registration=await registerBountyEffectWorkers({resolvePolicy:async()=>policy,registrars:[async enabled=>{await registerIsolatedBountyProposalLane({boss:getBoss(),policy:enabled,resolvePolicy:resolveBountyFeaturePolicy,async resolveAssignment(job:BountyIsolatedProposalJob){const row=await queryOne<Assignment>(`SELECT * FROM bounty_worker_runtime_assignments WHERE workspace_id=$1 AND mission_id=$2 AND work_package_id=$3 AND route_package_hash=$4 AND authority_epoch=$5`,[job.workspaceId,job.missionId,job.workPackageId,job.routePackageHash,job.missionEpoch]);if(!row)throw new ServiceUnavailableError('No exact durable bounty runtime assignment');return{packagePath:await packagePath(packageRoot,row.id),runtime:{workerExecutable,workerExecutableHash:row.worker_executable_hash,targetBrokerRoot,targetBrokerSocket,targetBrokerSocketIdentity:row.target_broker_socket_identity,providerBrokerRoot,providerBrokerSocket,providerExactOrigin,providerPolicyHash:row.provider_policy_hash,expectedMissionId:job.missionId,expectedWorkPackageId:job.workPackageId,expectedRoutePackageHash:job.routePackageHash,expectedAuthorityEpoch:job.missionEpoch}};},async persistProposal(job,proposal){const row=await queryOne<{id:string}>('SELECT id FROM bounty_worker_runtime_assignments WHERE workspace_id=$1 AND attempt_id=$2',[job.workspaceId,proposal.attemptId]);if(!row)throw new ServiceUnavailableError('Bounty proposal assignment disappeared');await persistBountyWorkerProposal(job.workspaceId,row.id,proposal);}});} ]});
  if(!registration.registered)throw new ServiceUnavailableError('Bounty worker registration denied by disabled policy');
}
if(require.main===module)startBountyWorker().catch((error)=>{console.error('[bounty-worker] startup failed',error instanceof Error?error.message:'unknown');process.exitCode=1;});
