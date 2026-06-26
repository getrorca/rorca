/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockQueryOne = jest.fn();
const mockQuery = jest.fn();
const mockExecute = jest.fn();
const mockChatComplete = jest.fn();
const mockRetrieveContext = jest.fn();
const mockQuerySkillEffectiveness = jest.fn();
const mockQuerySkillPathAffinity = jest.fn();
const mockBuildRetrievalSelectionsFromContext = jest.fn();
const mockRecordRetrievalSelectionsOutcome = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  query: (...args: unknown[]) => mockQuery(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
}));

jest.mock('../llm-client', () => ({
  chatComplete: (...args: unknown[]) => mockChatComplete(...args),
  DEFAULT_MODEL: 'test-model',
  isValidModel: jest.fn(() => true),
}));

jest.mock('../memory-router', () => ({
  retrieveContext: (...args: unknown[]) => mockRetrieveContext(...args),
}));

jest.mock('../knowledge-graph', () => ({
  querySkillEffectiveness: (...args: unknown[]) => mockQuerySkillEffectiveness(...args),
  querySkillPathAffinity: (...args: unknown[]) => mockQuerySkillPathAffinity(...args),
}));

jest.mock('../retrieval-outcome', () => ({
  buildRetrievalSelectionsFromContext: (...args: unknown[]) => mockBuildRetrievalSelectionsFromContext(...args),
  recordRetrievalSelectionsOutcome: (...args: unknown[]) => mockRecordRetrievalSelectionsOutcome(...args),
}));

jest.mock('../skill-registry', () => ({
  SkillRegistry: jest.fn().mockImplementation(() => {
    const registry = {
      discover: jest.fn().mockResolvedValue(undefined as never),
      getCatalogForPrompt: jest.fn(() => 'react: React UI skill'),
      getAll: jest.fn(() => [{ metadata: { name: 'react' } }]),
    };
    registry.discover.mockResolvedValue(registry);
    return registry;
  }),
}));

jest.mock('../agent-personas', () => ({
  PersonaRegistry: jest.fn().mockImplementation(() => {
    const registry = {
      discover: jest.fn().mockReturnValue(undefined as never),
      getPersonaCatalogForPrompt: jest.fn(() => ''),
    };
    registry.discover.mockReturnValue(registry);
    return registry;
  }),
}));

jest.mock('../skill-matcher', () => ({
  matchSkills: jest.fn(),
}));

jest.mock('../sse-hub', () => ({
  broadcastAll: jest.fn(),
}));

import { runEnrichJob, runMatchSkillsJob } from '../spec-job-handlers';

describe('spec-job handlers retrieval feedback wiring', () => {
  let tmpDir: string;
  let workspacePath: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-spec-job-feedback-'));
    workspacePath = path.join(tmpDir, 'workspace');
    fs.mkdirSync(path.join(workspacePath, 'forge', 'specs', 'approved'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, '.rorca'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, '.rorca', 'MEMORY.md'), '## Memory\nExisting context');
    fs.writeFileSync(path.join(workspacePath, 'AGENTS.md'), '# AGENTS\nRules');

    mockQuery.mockResolvedValue([]);
    mockExecute.mockResolvedValue(undefined);
    mockQuerySkillEffectiveness.mockResolvedValue([]);
    mockQuerySkillPathAffinity.mockResolvedValue([]);
    mockRecordRetrievalSelectionsOutcome.mockResolvedValue(undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('runMatchSkillsJob records positive retrieval outcome on success', async () => {
    const specPath = path.join(workspacePath, 'forge', 'specs', 'approved', 'spec-a.json');
    fs.writeFileSync(specPath, JSON.stringify({
      userStories: [
        { id: 'US-001', title: 'Build header', description: 'Create a React header' },
      ],
    }));

    mockQueryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM workspaces')) return { id: 'ws-1', label: 'Test', path: workspacePath };
      if (sql.includes('MAX(version)')) return { max_ver: 0 };
      if (sql.includes('preferred_model')) return { preferred_model: null };
      if (sql.includes('INSERT INTO wal_events')) return { id: 1 };
      return undefined;
    });

    mockRetrieveContext.mockResolvedValue({
      direction: {},
      memory: [],
      skills: [],
      graphSection: '',
      meta: {
        cagHits: 1,
        ragHits: 1,
        graphHits: 0,
        totalTokens: 100,
        latencyMs: 5,
        tier: 'hybrid',
        matchedSkills: ['React'],
        selectedCandidateIds: ['42'],
      },
    });
    mockBuildRetrievalSelectionsFromContext.mockReturnValue([
      { candidateKey: 'memory:42', candidateKind: 'memory', skillName: 'React' },
    ]);
    mockChatComplete.mockResolvedValue({
      text: JSON.stringify({
        matches: [
          { storyId: 'US-001', suggestedSkills: [{ name: 'react', relevance: 8, reason: 'React UI work' }] },
        ],
      }),
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const result = await runMatchSkillsJob('ws-1', 'spec-a');

    expect(result.matched).toBe(1);
    expect(mockRecordRetrievalSelectionsOutcome).toHaveBeenCalledWith(
      'ws-1',
      [{ candidateKey: 'memory:42', candidateKind: 'memory', skillName: 'React' }],
      true,
    );
  });

  test('runEnrichJob records positive and negative retrieval outcomes per story', async () => {
    const specPath = path.join(workspacePath, 'forge', 'specs', 'approved', 'spec-b.json');
    fs.writeFileSync(specPath, JSON.stringify({
      title: 'Spec B',
      userStories: [
        { id: 'US-001', title: 'Auth form', description: 'Add login form' },
        { id: 'US-002', title: 'Dashboard', description: 'Add dashboard cards' },
      ],
    }));

    mockQueryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM workspaces')) return { id: 'ws-1', label: 'Test', path: workspacePath };
      if (sql.includes('SELECT id FROM pipeline_runs')) return undefined;
      if (sql.includes('INSERT INTO wal_events')) return { id: 1 };
      return undefined;
    });

    mockRetrieveContext
      .mockResolvedValueOnce({
        direction: {},
        memory: [],
        skills: [],
        graphSection: '',
        meta: { cagHits: 1, ragHits: 0, graphHits: 0, totalTokens: 50, latencyMs: 3, tier: 'cache', matchedSkills: ['Auth'], selectedCandidateIds: ['11'] },
      })
      .mockResolvedValueOnce({
        direction: {},
        memory: [],
        skills: [],
        graphSection: '',
        meta: { cagHits: 0, ragHits: 1, graphHits: 0, totalTokens: 60, latencyMs: 4, tier: 'search', matchedSkills: ['Dashboard'], selectedCandidateIds: ['22'] },
      });

    mockBuildRetrievalSelectionsFromContext
      .mockReturnValueOnce([{ candidateKey: 'memory:11', candidateKind: 'memory', skillName: 'Auth' }])
      .mockReturnValueOnce([{ candidateKey: 'memory:22', candidateKind: 'memory', skillName: 'Dashboard' }]);

    mockChatComplete
      .mockResolvedValueOnce({ text: '- Use existing auth form pattern', usage: { inputTokens: 10, outputTokens: 5 } })
      .mockRejectedValueOnce(new Error('LLM unavailable'));

    const result = await runEnrichJob('ws-1', 'spec-b');

    expect(result.success).toBe(true);
    expect(result.storiesEnriched).toBe(1);
    expect(mockRecordRetrievalSelectionsOutcome).toHaveBeenCalledWith(
      'ws-1',
      [{ candidateKey: 'memory:11', candidateKind: 'memory', skillName: 'Auth' }],
      true,
    );
    expect(mockRecordRetrievalSelectionsOutcome).toHaveBeenCalledWith(
      'ws-1',
      [{ candidateKey: 'memory:22', candidateKind: 'memory', skillName: 'Dashboard' }],
      false,
    );
  });

  test('runEnrichJob preserves post-save save generation and context metadata', async () => {
    const specPath = path.join(workspacePath, 'forge', 'specs', 'approved', 'spec-c.json');
    fs.writeFileSync(specPath, JSON.stringify({
      title: 'Spec C',
      userStories: [
        { id: 'US-001', title: 'Gateway config', description: 'Define gateway config' },
      ],
    }));

    const priorSummary = {
      workspaceId: 'ws-1',
      saveGeneration: 777,
      contextCaptureStatus: { status: 'provided', reason: 'caller_supplied_context' },
      postSaveStages: {
        enrich: { requested: true, status: 'queued', reason: 'durable_job_enqueued_after_dependency' },
        matchSkills: { requested: true, status: 'pending', reason: 'requested_by_policy' },
        memorySynthesis: { requested: true, status: 'pending', reason: 'requested_by_policy' },
      },
    };

    mockQueryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM workspaces')) return { id: 'ws-1', label: 'Test', path: workspacePath };
      if (sql.includes('SELECT id FROM pipeline_runs')) return undefined;
      if (sql.includes('FROM spec_jobs')) {
        return {
          id: 'job-enrich-777',
          spec_id: 'spec-c',
          workspace_id: 'ws-1',
          job_type: 'enrich',
          status: 'running',
          boss_job_id: 'boss-777',
          save_generation: 777,
          progress_current: 0,
          progress_total: 1,
          progress_message: null,
          request_payload: { origin: 'persist-post-save', saveGeneration: 777 },
          result_payload: null,
          error_message: null,
          started_at: null,
          finished_at: null,
          created_at: new Date('2026-01-01T00:00:00.000Z'),
        };
      }
      if (sql.includes('FROM spec_generation_logs')) return { context_summary_json: priorSummary };
      if (sql.includes('INSERT INTO wal_events')) return { id: 1 };
      return undefined;
    });

    mockRetrieveContext.mockResolvedValueOnce({
      direction: {},
      memory: [],
      skills: [],
      graphSection: '',
      meta: { cagHits: 1, ragHits: 0, graphHits: 0, totalTokens: 50, latencyMs: 3, tier: 'cache', matchedSkills: ['Gateway'], selectedCandidateIds: ['33'] },
    });
    mockBuildRetrievalSelectionsFromContext.mockReturnValueOnce([{ candidateKey: 'memory:33', candidateKind: 'memory', skillName: 'Gateway' }]);
    mockChatComplete.mockResolvedValueOnce({ text: '- Preserve post-save metadata', usage: { inputTokens: 10, outputTokens: 5 } });

    await runEnrichJob('ws-1', 'spec-c', undefined, { jobId: 'job-enrich-777' });

    const generationLogInsert = mockExecute.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO spec_generation_logs'),
    );
    expect(generationLogInsert).toBeDefined();
    const params = generationLogInsert?.[1] as unknown[];
    expect(params[9]).toBe(777);
    const insertedSummary = JSON.parse(params[8] as string);
    expect(insertedSummary.saveGeneration).toBe(777);
    expect(insertedSummary.contextCaptureStatus).toEqual(priorSummary.contextCaptureStatus);
    expect(insertedSummary.postSaveStages).toEqual(priorSummary.postSaveStages);
  });
});
