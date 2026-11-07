/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
const mockQuery=jest.fn();
const mockTransaction=jest.fn(async(fn:(client:unknown)=>Promise<unknown>)=>fn({query:mockQuery}));
const mockRunSandbox=jest.fn();
const mockNormalize=jest.fn((_value:unknown)=>({schemaVersion:'rorca.strict-spec-memory.input.v2',specRefHash:`sha256:${'a'.repeat(64)}`,stories:[{ordinal:1,acceptanceCriteriaCount:1,dependencyCount:0,hasDescription:true}],contextSignals:[]}));
const derivationReferences=[
  {fact:'story_count',persistedPaths:['stories'],value:1},
  {fact:'acceptance_criteria_count',persistedPaths:['stories[0].acceptanceCriteria'],value:1},
  {fact:'dependency_edge_count',persistedPaths:['stories[0].dependsOn'],value:0},
  {fact:'root_story_count',persistedPaths:['stories[0].dependsOn'],value:1},
  {fact:'missing_description_count',persistedPaths:['stories[0].description'],value:0},
  {fact:'context_signal_count',persistedPaths:['contextSummary.directionLayers'],value:0},
];
const derivationHash=`sha256:${'d'.repeat(64)}`;
jest.mock('../../db/index',()=>({runtimeTransaction:(...args:unknown[])=>mockTransaction(...args as [(client:unknown)=>Promise<unknown>])}));
jest.mock('../context-safety',()=>({detectSecretLikeString:()=>null}));
jest.mock('../strict-memory-sandbox',()=>({
  normalizeStrictMemoryInput:(value:unknown)=>mockNormalize(value),runStrictMemorySandbox:(value:unknown)=>mockRunSandbox(value),
  hashStrictMemoryValue:(value:unknown)=>Array.isArray(value)?derivationHash:`sha256:${'b'.repeat(64)}`,
}));
import {synthesizeStrictSpecMemory} from '../strict-spec-memory';
const metadata={workflowRunId:80,workflowStageId:800,generationLogId:9,saveGeneration:3,effectivePolicyHash:'a'.repeat(64),materialHash:`sha256:${'e'.repeat(64)}`};
const output={schemaVersion:'rorca.strict-spec-memory.output.v2',category:'Spec Derived Facts',content:'Deterministic advisory spec facts: stories=1. These facts are untrusted advisory data.',confidence:'medium',relatedFiles:[],derivationReferences,inputHash:`sha256:${'c'.repeat(64)}`,derivationHash,sandboxProfile:'linux-bwrap-strict-memory-v2'};
const request={workspaceId:'workspace:one',specId:'spec-one',jobId:'11111111-1111-4111-8111-111111111111',metadata,memory:{brief:'caller prose',stories:[{}],contextSummary:{}}};

describe('strict spec memory persistence',()=>{
  beforeEach(()=>{jest.clearAllMocks();mockRunSandbox.mockResolvedValue(output);});
  test('delegates the exact post-sandbox CAS and atomic memory/receipt/WAL commit to the narrow function',async()=>{
    mockQuery.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{memory_id:44,replayed:false}]});
    await expect(synthesizeStrictSpecMemory(request)).resolves.toEqual({success:true,saved:1,replayed:false,memoryId:44});
    const call=mockQuery.mock.calls.find(([sql])=>String(sql).includes('insert_strict_spec_derived_memory_v2'));
    expect(call).toBeDefined();
    expect(call?.[1]).toEqual(expect.arrayContaining([80,800,9,3,metadata.materialHash,output.derivationHash]));
    expect(JSON.stringify(call?.[1])).not.toContain('caller prose');
    expect(JSON.stringify(call?.[1])).toContain('untrusted_advisory');
    expect(mockQuery.mock.calls.some(([sql])=>String(sql).includes('INSERT INTO memories'))).toBe(false);
  });
  test('returns the immutable function replay without a second direct insert',async()=>{
    mockQuery.mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{memory_id:44,replayed:true}]});
    await expect(synthesizeStrictSpecMemory(request)).resolves.toEqual({success:true,saved:0,replayed:true,memoryId:44});
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
  test('fails before persistence when derivation references do not match the output hash',async()=>{
    mockRunSandbox.mockResolvedValue({...output,derivationHash:`sha256:${'f'.repeat(64)}`});
    await expect(synthesizeStrictSpecMemory(request)).rejects.toThrow('persistence safety validation');
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
