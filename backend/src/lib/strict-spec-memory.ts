/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { runtimeTransaction } from '../db/index';
import { detectSecretLikeString } from './context-safety';
import {
  hashStrictMemoryValue,
  normalizeStrictMemoryInput,
  runStrictMemorySandbox,
} from './strict-memory-sandbox';

export interface StrictSpecMemorySynthesisResult {
  success: true;
  saved: 0 | 1;
  replayed: boolean;
  memoryId: number;
}

/**
 * Provider-neutral strict synthesis. The child receives structural facts only.
 * After it returns, the security-definer function locks stage -> run ->
 * generation log -> application job, revalidates exact live material, and
 * atomically inserts the advisory memory, immutable receipt, and payload-safe
 * WAL event. Runtime has no direct memories INSERT privilege.
 */
export async function synthesizeStrictSpecMemory(input: {
  workspaceId: string;
  specId: string;
  jobId: string;
  metadata: {
    workflowRunId: number;
    workflowStageId: number;
    generationLogId: number;
    saveGeneration: number;
    effectivePolicyHash: string;
    materialHash: string;
  };
  memory: Record<string, unknown>;
}): Promise<StrictSpecMemorySynthesisResult> {
  const sandboxInput = normalizeStrictMemoryInput({
    specId: input.specId,
    brief: input.memory.brief,
    stories: input.memory.stories,
    contextSummary: input.memory.contextSummary,
  });
  const output = await runStrictMemorySandbox(sandboxInput);
  if (detectSecretLikeString(output.content)
    || detectSecretLikeString(JSON.stringify(output.derivationReferences))
    || hashStrictMemoryValue(output.derivationReferences) !== output.derivationHash) {
    throw new Error('Strict memory output failed persistence safety validation');
  }
  const outputHash = hashStrictMemoryValue(output);
  const provenance = {
    schemaVersion: 'rorca.strict-spec-memory.provenance.v2',
    applicationJobId: input.jobId,
    workflowRunId: input.metadata.workflowRunId,
    workflowStageId: input.metadata.workflowStageId,
    generationLogId: input.metadata.generationLogId,
    saveGeneration: input.metadata.saveGeneration,
    policyHash: input.metadata.effectivePolicyHash,
    materialHash: input.metadata.materialHash,
    inputHash: output.inputHash,
    outputHash,
    derivationHash: output.derivationHash,
    sandboxProfile: output.sandboxProfile,
    authority: 'none',
    trust: 'untrusted_advisory',
    framing: 'data_not_instructions',
    derivationReferences: output.derivationReferences,
  };

  // Strict memory receipts enforce session_user identity against the immutable
  // runtime-authority anchor. The owner-connected application pool cannot
  // satisfy that check, so persist through the sanctioned runtime principal.
  return runtimeTransaction(async (client) => {
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`,[input.workspaceId]);
    const row = (await client.query<{ memory_id: number | string; replayed: boolean }>(
      `SELECT * FROM insert_strict_spec_derived_memory_v2(
        $1,$2,$3,$4,$5,$6,$7,$8::uuid,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18
      )`,
      [input.workspaceId,input.specId,input.metadata.workflowRunId,input.metadata.workflowStageId,
        input.metadata.generationLogId,input.metadata.saveGeneration,input.metadata.effectivePolicyHash,input.jobId,
        input.metadata.materialHash,output.inputHash,outputHash,output.derivationHash,output.category,output.content,
        output.confidence,JSON.stringify(output.relatedFiles),JSON.stringify(provenance),output.sandboxProfile],
    )).rows[0];
    if (!row) throw new Error('Strict memory insertion function returned no receipt');
    return { success:true,saved:row.replayed?0:1,replayed:row.replayed,memoryId:Number(row.memory_id) };
  });
}
