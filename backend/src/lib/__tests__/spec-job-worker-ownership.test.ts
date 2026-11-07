/* Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
export {};
const mockGetJob=jest.fn();const mockGetByTransport=jest.fn();const mockTerminalize=jest.fn();const mockCas=jest.fn();
const mockAttempt=jest.fn();const mockRunner=jest.fn();const mockClaim=jest.fn();
jest.mock('../../db/spec-jobs',()=>({getJob:(...a:unknown[])=>mockGetJob(...a),
  getJobByTransportOwnership:(...a:unknown[])=>mockGetByTransport(...a),
  terminalizeOwnedSpecJobTransportFailure:(...a:unknown[])=>mockTerminalize(...a),
  compareAndSetJobStatus:(...a:unknown[])=>mockCas(...a),recordSpecJobTransportAttempt:(...a:unknown[])=>mockAttempt(...a)}));
jest.mock('../spec-job-handlers',()=>({runContextEnrichJob:jest.fn(),runEnrichJob:jest.fn(),runMatchSkillsJob:jest.fn(),runMemorySynthesisJob:jest.fn(),runSuggestSkillsJob:jest.fn()}));
jest.mock('../spec-job-events',()=>({publishSpecJobSnapshot:jest.fn()}));
jest.mock('../spec-post-save-workflow',()=>({
  getSpecPostSaveWorkflowJobMetadata:(job:any)=>job.requestPayload?.workflow==='spec-post-save-v1'?job.requestPayload:null,
  claimExactPostSaveWorkflowJob:(...a:unknown[])=>mockClaim(...a),markSpecPostSaveWorkflowJobSupersededIfStale:jest.fn(async()=>false),
  syncSpecPostSaveWorkflowStageFromJob:jest.fn(),advanceSpecPostSaveWorkflowDependencies:jest.fn(),
}));
jest.mock('../pg-boss-schema',()=>({getPgBossSchemaName:()=> 'pgboss'}));
jest.mock('../logger',()=>({logger:{info:jest.fn(),warn:jest.fn(),error:jest.fn(),debug:jest.fn()}}));
function transport(data:Record<string,unknown>,id='11111111-1111-4111-8111-111111111111',name='spec:enrich'){return {id,name,data} as any;}
const appJob={id:'22222222-2222-4222-8222-222222222222',workspaceId:'ws-1',specId:'spec-1',jobType:'enrich',status:'pending',bossJobId:'11111111-1111-4111-8111-111111111111',transportSchema:'pgboss',createdAt:new Date(),requestPayload:null};
const payload={jobId:appJob.id,specId:'spec-1',workspaceId:'ws-1'};
beforeEach(()=>{jest.clearAllMocks();mockGetByTransport.mockResolvedValue(appJob);mockTerminalize.mockResolvedValue({...appJob,status:'failed'});
  mockGetJob.mockResolvedValue(appJob);mockCas.mockResolvedValue(true);mockClaim.mockResolvedValue(true);
  mockAttempt.mockResolvedValue(undefined);mockRunner.mockResolvedValue({ok:true});});
describe('spec worker exact ownership gate',()=>{
  test('rejects nonexistent application jobs to the transport before runner execution',async()=>{
    mockGetByTransport.mockResolvedValue(null);const {handleSpecJobs}=await import('../spec-job-worker');
    await expect(handleSpecJobs([transport(payload)],'spec:enrich',mockRunner)).rejects.toThrow('Unowned spec:enrich transport was rejected');
    expect(mockRunner).not.toHaveBeenCalled();expect(mockCas).not.toHaveBeenCalled();expect(mockTerminalize).not.toHaveBeenCalled();
  });
  test('terminalizes an exact owned job whose payload substitutes workspace identity',async()=>{
    const {handleSpecJobs}=await import('../spec-job-worker');
    await expect(handleSpecJobs([transport({...payload,workspaceId:'ws-other'})],'spec:enrich',mockRunner)).rejects.toThrow('ownership was rejected');
    expect(mockTerminalize).toHaveBeenCalledWith(expect.objectContaining({bossJobId:appJob.bossJobId,reasonCode:'transport_ownership_mismatch'}));
    expect(mockRunner).not.toHaveBeenCalled();
  });
  test('does not mutate any application job when immutable transport identity has no owner',async()=>{
    mockGetByTransport.mockResolvedValue(null);const {handleSpecJobs}=await import('../spec-job-worker');
    await expect(handleSpecJobs([transport(payload)],'spec:enrich',mockRunner)).rejects.toThrow('Unowned spec:enrich transport');
    expect(mockRunner).not.toHaveBeenCalled();expect(mockCas).not.toHaveBeenCalled();expect(mockTerminalize).not.toHaveBeenCalled();
  });
  test.each([
    {},
    {jobId:'not-a-uuid'},
    {jobId:'33333333-3333-4333-8333-333333333333'},
  ])('terminalizes the immutable transport owner for malformed/invalid/substituted locator %#',async(data)=>{
    const {handleSpecJobs}=await import('../spec-job-worker');
    await expect(handleSpecJobs([transport(data)],'spec:enrich',mockRunner)).rejects.toThrow(/Invalid spec:enrich payload|ownership was rejected/);
    expect(mockTerminalize).toHaveBeenCalledWith(expect.objectContaining({bossJobId:appJob.bossJobId,
      reasonCode:expect.stringMatching(/invalid_transport_payload|transport_ownership_mismatch/)}));
  });
  test('terminalizes the exact owner when the received-attempt ledger write fails before claim',async()=>{
    mockAttempt.mockRejectedValueOnce(new Error('attempt ledger unavailable'));const {handleSpecJobs}=await import('../spec-job-worker');
    await expect(handleSpecJobs([transport(payload)],'spec:enrich',mockRunner)).rejects.toThrow('attempt ledger unavailable');
    expect(mockTerminalize).toHaveBeenCalledWith(expect.objectContaining({reasonCode:'attempt_ledger_write_failed'}));
    expect(mockRunner).not.toHaveBeenCalled();
  });
  test('restart delivery cannot resurrect an already terminal failed application job',async()=>{
    mockGetByTransport.mockResolvedValue({...appJob,status:'failed'});mockGetJob.mockResolvedValue({...appJob,status:'failed'});mockCas.mockResolvedValue(false);
    const {handleSpecJobs}=await import('../spec-job-worker');
    await expect(handleSpecJobs([transport(payload)],'spec:enrich',mockRunner)).rejects.toThrow('start ownership CAS was rejected');
    expect(mockRunner).not.toHaveBeenCalled();
    expect(mockCas).toHaveBeenCalledWith(expect.objectContaining({status:'running',expectedStatuses:['pending']}));
    expect(mockTerminalize).toHaveBeenCalledWith(expect.objectContaining({reasonCode:'start_claim_cas_rejected'}));
  });
  test('requires full workflow payload and exact atomic stage claim',async()=>{
    const metadata={origin:'persist-post-save',workflow:'spec-post-save-v1',workflowRunId:7,stage:'enrich',saveGeneration:1,generationLogId:3,effectivePolicyHash:'8'.repeat(64),transportSchema:'pgboss',queueName:'spec:enrich',bossJobId:appJob.bossJobId,priority:1,singletonKey:'key'};
    mockGetByTransport.mockResolvedValue({...appJob,requestPayload:metadata});
    mockGetJob.mockResolvedValue({...appJob,requestPayload:metadata});const {handleSpecJobs}=await import('../spec-job-worker');
    await handleSpecJobs([transport({...payload,workflowRunId:7,stage:'enrich',bossJobId:appJob.bossJobId,queueName:'spec:enrich',transportSchema:'pgboss'})],'spec:enrich',mockRunner);
    expect(mockClaim).toHaveBeenCalledWith(expect.objectContaining({jobId:appJob.id,workflowRunId:7,bossJobId:appJob.bossJobId,queueName:'spec:enrich',transportSchema:'pgboss'}));
    expect(mockRunner).toHaveBeenCalledTimes(1);
  });
  test('terminal cancellation wins a completion CAS loss',async()=>{
    mockGetJob.mockResolvedValueOnce(appJob).mockResolvedValueOnce(appJob).mockResolvedValueOnce({...appJob,status:'cancelled'});
    mockCas.mockResolvedValueOnce(true).mockResolvedValueOnce(false);const {handleSpecJobs}=await import('../spec-job-worker');
    await handleSpecJobs([transport(payload)],'spec:enrich',mockRunner);
    expect(mockRunner).toHaveBeenCalledTimes(1);
    expect(mockCas).toHaveBeenLastCalledWith(expect.objectContaining({status:'completed',expectedStatuses:['running']}));
  });
  test('runner/database failure is terminalized and still rejects to pg-boss',async()=>{
    mockGetJob.mockResolvedValue(appJob);mockRunner.mockRejectedValueOnce(new Error('transient database failure'));
    const {handleSpecJobs}=await import('../spec-job-worker');
    await expect(handleSpecJobs([transport(payload)],'spec:enrich',mockRunner)).rejects.toThrow('transient database failure');
    expect(mockCas).toHaveBeenCalledWith(expect.objectContaining({status:'failed',expectedStatuses:['running']}));
    expect(mockAttempt).toHaveBeenCalledWith(expect.objectContaining({outcome:'failed'}));
  });
});
