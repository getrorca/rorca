/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Process-local composition root for durable bounty services. Secrets stay inside the credential broker. */
import { transaction } from '../db';
import { DurableBountyCredentialBroker } from './bounty-durable-credential-broker';
import { GovernedCaidoAdapter } from './bounty-caido-adapter';
import { ProductionCaidoBroker, ProductionCaidoEvidenceGateway, ProductionCaidoTransport } from './bounty-production-caido';

export const bountyCredentialBroker = new DurableBountyCredentialBroker({
  async closeBrowserPartition(binding) { await transaction(async client=>{await client.query('UPDATE bounty_browser_partitions SET closed_at=COALESCE(closed_at,now()) WHERE workspace_id=$1 AND mission_id=$2 AND account_id=$3 AND closed_at IS NULL',[binding.workspaceId,binding.missionId,binding.accountId]);}); },
  async holdMission(binding,reason){await transaction(async client=>{const mission=await client.query<{state:string}>('SELECT state FROM bounty_missions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[binding.workspaceId,binding.missionId]);if(mission.rows[0]?.state!=='active')return;await client.query('INSERT INTO bounty_holds(workspace_id,mission_id,reason) VALUES($1,$2,$3)',[binding.workspaceId,binding.missionId,reason]);await client.query("UPDATE bounty_missions SET state='held',epoch=epoch+1,control_reason=$3,controlled_at=now() WHERE workspace_id=$1 AND id=$2",[binding.workspaceId,binding.missionId,reason]);});},
});

/** Construct only in the dedicated effect service after policy and mission preflight pass. */
export function createProductionCaidoAdapter(input:{proxyOrigin:string;currentEpoch:()=>number;trafficAllowed:()=>boolean;rejectUnauthorized:boolean}){
  return new GovernedCaidoAdapter(new ProductionCaidoBroker(),new ProductionCaidoTransport(input.proxyOrigin,bountyCredentialBroker,input.rejectUnauthorized),new ProductionCaidoEvidenceGateway(),input.currentEpoch,input.trafficAllowed);
}
