/* Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
export {};
const mockExecute=jest.fn();
jest.mock('../../db/index',()=>({execute:(...args:unknown[])=>mockExecute(...args),query:jest.fn(),queryOne:jest.fn()}));

describe('exact post-save recovery CAS',()=>{
  beforeEach(()=>jest.clearAllMocks());
  test('returns false when completion or ownership change wins the single statement',async()=>{
    mockExecute.mockResolvedValue({rowCount:0});
    const {recoverExactPostSaveJob}=await import('../../db/spec-jobs');
    await expect(recoverExactPostSaveJob({jobId:'11111111-1111-4111-8111-111111111111',workspaceId:'ws',specId:'spec',
      stageKey:'enrich',bossJobId:'22222222-2222-4222-8222-222222222222',transportSchema:'pgboss',saveGeneration:7,
      message:'recover'})).resolves.toBe(false);
    expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining("job.status IN('pending','running')"),expect.any(Array));
    expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining("stage.status IN('queued','running')"),expect.any(Array));
    expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining('run.save_generation=job.save_generation'),expect.any(Array));
  });
  test('reports one exact recovery winner',async()=>{
    mockExecute.mockResolvedValue({rowCount:1});
    const {recoverExactPostSaveJob}=await import('../../db/spec-jobs');
    await expect(recoverExactPostSaveJob({jobId:'11111111-1111-4111-8111-111111111111',workspaceId:'ws',specId:'spec',
      stageKey:'memorySynthesis',bossJobId:'22222222-2222-4222-8222-222222222222',transportSchema:'pgboss',saveGeneration:8,
      message:'recover'})).resolves.toBe(true);
  });
});
