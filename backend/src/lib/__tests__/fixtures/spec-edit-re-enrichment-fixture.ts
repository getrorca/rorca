/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Deterministic regression fixture for spec-edit re-enrichment timing.
 *
 * This fixture intentionally uses in-memory rows and on-disk temp specs only:
 * no Express server, no SSE hub, no dev worker, no live pg-boss queue, and no
 * manual DB poking. The row shapes mirror spec_generation_logs, postSaveStages,
 * spec_jobs, and the kanban active-state fields that the UI consumes.
 */

export type EditClass = 'metadata-only' | 'story-content-only' | 'context-affecting' | 'rapid-successive-saves';
export type StageName = 'enrich' | 'matchSkills' | 'memorySynthesis';
export type StageStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped';
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type JobType = 'enrich' | 'match-skills';

export interface PostSaveStageFixtureState {
  requested: boolean;
  status: StageStatus;
  reason: string;
  jobId?: string;
  bossJobId?: string | null;
  editRevision?: number;
  fingerprint?: string;
  error?: string | null;
}

export type PostSaveStageFixtureMap = Record<StageName, PostSaveStageFixtureState>;

export interface GenerationLogFixtureRow {
  id: number;
  spec_slug: string;
  status: 'persisted' | 'pending_enrichment' | 'failed';
  context_summary_json: {
    workspaceId: string;
    editRevision: number;
    generationFingerprint: string;
    contextFingerprint: string;
    storyFingerprint: string;
    postSaveStages: PostSaveStageFixtureMap;
    contextUsed: string[];
  };
}

export interface SpecJobFixtureRow {
  id: string;
  spec_id: string;
  workspace_id: string;
  job_type: JobType;
  status: JobStatus;
  boss_job_id: string | null;
  created_at: string;
  request_payload: {
    origin: 'persist-post-save';
    stage: 'enrich' | 'matchSkills';
    editRevision: number;
    queuePosition?: number;
    supersededByRevision?: number;
  };
  result_payload: null | {
    applied: boolean;
    editRevision: number;
    generationFingerprint: string;
    skipped?: boolean;
  };
  error_message: string | null;
}

export interface SpecJsonFixture {
  id: string;
  specName: string;
  description: string;
  tags: string[];
  context: {
    l4Brief: string;
    l5EditInstruction: string;
    stageFingerprint: string;
  };
  stories: Array<{
    id: string;
    title: string;
    acceptanceCriteria: string[];
  }>;
}

export interface SpecDiskSnapshot {
  relativePath: string;
  json: SpecJsonFixture;
}

export interface DbSpecRowSnapshot {
  spec_id: string;
  workspace_id: string;
  spec_name: string;
  context_fingerprint: string;
  story_fingerprint: string;
  edit_revision: number;
}

export interface EditStateSnapshot {
  dbSpecRow: DbSpecRowSnapshot;
  diskSpec: SpecDiskSnapshot;
  generationLog: GenerationLogFixtureRow;
  specJobs: SpecJobFixtureRow[];
}

export interface KanbanActiveFixtureState {
  activeRunStatus?: 'running' | 'queued';
  queuePosition?: number;
  sourceJobId?: string;
  editRevision?: number;
}

export interface EditRegressionCase {
  name: string;
  editClass: EditClass;
  workspaceId: string;
  specId: string;
  before: EditStateSnapshot;
  after: EditStateSnapshot;
  expected: {
    beforeJobStates: Array<Pick<SpecJobFixtureRow, 'id' | 'job_type' | 'status'>>;
    afterJobStates: Array<Pick<SpecJobFixtureRow, 'id' | 'job_type' | 'status'>>;
    beforeGenerationStatus: GenerationLogFixtureRow['status'];
    afterGenerationStatus: GenerationLogFixtureRow['status'];
    beforePostSaveStages: PostSaveStageFixtureMap;
    afterPostSaveStages: PostSaveStageFixtureMap;
    beforeKanbanActiveState: KanbanActiveFixtureState;
    afterKanbanActiveState: KanbanActiveFixtureState;
    legacyStuckKanbanState?: KanbanActiveFixtureState;
  };
}

const workspaceId = 'fixture-workspace';
const specId = 'rer-fixture-spec';

const completedStagesV1: PostSaveStageFixtureMap = {
  enrich: {
    requested: true,
    status: 'completed',
    reason: 'job_completed',
    jobId: 'job-v1-enrich',
    bossJobId: '00000000-0000-4000-8000-000000000101',
    editRevision: 1,
    fingerprint: 'gen-v1',
    error: null,
  },
  matchSkills: {
    requested: true,
    status: 'completed',
    reason: 'job_completed',
    jobId: 'job-v1-match',
    bossJobId: '00000000-0000-4000-8000-000000000102',
    editRevision: 1,
    fingerprint: 'skills-v1',
    error: null,
  },
  memorySynthesis: {
    requested: false,
    status: 'skipped',
    reason: 'disabled_by_caller',
  },
};

const baseSpecJson: SpecJsonFixture = {
  id: specId,
  specName: 'RER Fixture Spec',
  description: 'Baseline spec used to capture edit re-enrichment timing.',
  tags: ['regression', 'baseline'],
  context: {
    l4Brief: 'Original L4 brief.',
    l5EditInstruction: 'Original edit instruction.',
    stageFingerprint: 'ctx-v1',
  },
  stories: [
    {
      id: 'RER-FIX-001',
      title: 'Render honest post-save state',
      acceptanceCriteria: ['Shows completed enrichment state.'],
    },
  ],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function specPath(slug: string): string {
  return `forge/specs/approved/${slug}.json`;
}

function dbRow(overrides: Partial<DbSpecRowSnapshot> = {}): DbSpecRowSnapshot {
  return {
    spec_id: specId,
    workspace_id: workspaceId,
    spec_name: baseSpecJson.specName,
    context_fingerprint: 'ctx-v1',
    story_fingerprint: 'story-v1',
    edit_revision: 1,
    ...overrides,
  };
}

function diskSpec(json: SpecJsonFixture): SpecDiskSnapshot {
  return {
    relativePath: specPath(json.id),
    json,
  };
}

function generationLog(
  overrides: Partial<GenerationLogFixtureRow> & {
    summary?: Partial<GenerationLogFixtureRow['context_summary_json']>;
  } = {},
): GenerationLogFixtureRow {
  return {
    id: overrides.id ?? 1,
    spec_slug: specId,
    status: overrides.status ?? 'persisted',
    context_summary_json: {
      workspaceId,
      editRevision: 1,
      generationFingerprint: 'gen-v1',
      contextFingerprint: 'ctx-v1',
      storyFingerprint: 'story-v1',
      postSaveStages: clone(completedStagesV1),
      contextUsed: ['forge/specs/approved/rer-fixture-spec.json'],
      ...overrides.summary,
    },
  };
}

function job(
  id: string,
  jobType: JobType,
  status: JobStatus,
  editRevision: number,
  createdAt: string,
  stage: 'enrich' | 'matchSkills' = jobType === 'enrich' ? 'enrich' : 'matchSkills',
  overrides: Partial<SpecJobFixtureRow> = {},
): SpecJobFixtureRow {
  return {
    id,
    spec_id: specId,
    workspace_id: workspaceId,
    job_type: jobType,
    status,
    boss_job_id: `00000000-0000-4000-8000-${String(editRevision).padStart(12, '0')}`,
    created_at: createdAt,
    request_payload: {
      origin: 'persist-post-save',
      stage,
      editRevision,
    },
    result_payload: status === 'completed'
      ? {
        applied: true,
        editRevision,
        generationFingerprint: `gen-v${editRevision}`,
      }
      : null,
    error_message: null,
    ...overrides,
  };
}

const beforeState: EditStateSnapshot = {
  dbSpecRow: dbRow(),
  diskSpec: diskSpec(clone(baseSpecJson)),
  generationLog: generationLog(),
  specJobs: [
    job('job-v1-enrich', 'enrich', 'completed', 1, '2026-03-16T00:00:01.000Z'),
    job('job-v1-match', 'match-skills', 'completed', 1, '2026-03-16T00:00:02.000Z'),
  ],
};

function state(overrides: Partial<EditStateSnapshot>): EditStateSnapshot {
  return {
    dbSpecRow: clone(beforeState.dbSpecRow),
    diskSpec: clone(beforeState.diskSpec),
    generationLog: clone(beforeState.generationLog),
    specJobs: clone(beforeState.specJobs),
    ...overrides,
  };
}

function stagesWith(overrides: Partial<PostSaveStageFixtureMap>): PostSaveStageFixtureMap {
  return {
    enrich: clone(completedStagesV1.enrich),
    matchSkills: clone(completedStagesV1.matchSkills),
    memorySynthesis: clone(completedStagesV1.memorySynthesis),
    ...overrides,
  };
}

const storyOnlyStages = stagesWith({
  enrich: {
    requested: false,
    status: 'skipped',
    reason: 'story_content_only',
    editRevision: 2,
    fingerprint: 'ctx-v1',
    error: null,
  },
  matchSkills: {
    requested: true,
    status: 'queued',
    reason: 'durable_job_enqueued',
    jobId: 'job-story-v2-match',
    bossJobId: '00000000-0000-4000-8000-000000000202',
    editRevision: 2,
    fingerprint: 'story-v2',
    error: null,
  },
});

const contextStages = stagesWith({
  enrich: {
    requested: true,
    status: 'running',
    reason: 'job_started',
    jobId: 'job-context-v2-enrich',
    bossJobId: '00000000-0000-4000-8000-000000000301',
    editRevision: 2,
    fingerprint: 'ctx-v2',
    error: null,
  },
  matchSkills: {
    requested: true,
    status: 'pending',
    reason: 'waiting_for_enrich',
    jobId: 'job-context-v2-match',
    bossJobId: null,
    editRevision: 2,
    fingerprint: 'ctx-v2',
    error: null,
  },
});

const rapidStages = stagesWith({
  enrich: {
    requested: true,
    status: 'completed',
    reason: 'job_completed',
    jobId: 'job-rapid-v3-enrich',
    bossJobId: '00000000-0000-4000-8000-000000000403',
    editRevision: 3,
    fingerprint: 'gen-v3',
    error: null,
  },
  matchSkills: {
    requested: true,
    status: 'completed',
    reason: 'job_completed',
    jobId: 'job-rapid-v3-match',
    bossJobId: '00000000-0000-4000-8000-000000000404',
    editRevision: 3,
    fingerprint: 'skills-v3',
    error: null,
  },
});

function withStoryChange(): SpecJsonFixture {
  const next = clone(baseSpecJson);
  next.stories[0].title = 'Render honest post-save state after story edits';
  return next;
}

function withContextChange(): SpecJsonFixture {
  const next = clone(baseSpecJson);
  next.context.l4Brief = 'Updated L4 brief that must be resynthesized from disk.';
  next.context.l5EditInstruction = 'Refresh enrichment with the latest context-affecting edit.';
  next.context.stageFingerprint = 'ctx-v2';
  return next;
}

function withRapidFinalChange(): SpecJsonFixture {
  const next = withContextChange();
  next.context.stageFingerprint = 'ctx-v3';
  next.stories[0].acceptanceCriteria = ['Only the final rapid save output is applied.'];
  return next;
}

function jobStates(rows: SpecJobFixtureRow[]): Array<Pick<SpecJobFixtureRow, 'id' | 'job_type' | 'status'>> {
  return rows.map(({ id, job_type, status }) => ({ id, job_type, status }));
}

const metadataAfter = state({
  dbSpecRow: dbRow({ spec_name: 'RER Fixture Spec (renamed)' }),
  diskSpec: diskSpec({
    ...clone(baseSpecJson),
    specName: 'RER Fixture Spec (renamed)',
    tags: ['regression', 'baseline', 'metadata-only'],
  }),
});

const storyAfterJobs = [
  ...clone(beforeState.specJobs),
  job('job-story-v2-match', 'match-skills', 'pending', 2, '2026-03-16T00:01:02.000Z', 'matchSkills', {
    request_payload: {
      origin: 'persist-post-save',
      stage: 'matchSkills',
      editRevision: 2,
      queuePosition: 2,
    },
  }),
];

const storyAfter = state({
  dbSpecRow: dbRow({ story_fingerprint: 'story-v2', edit_revision: 2 }),
  diskSpec: diskSpec(withStoryChange()),
  generationLog: generationLog({
    id: 2,
    status: 'pending_enrichment',
    summary: {
      editRevision: 2,
      storyFingerprint: 'story-v2',
      postSaveStages: storyOnlyStages,
    },
  }),
  specJobs: storyAfterJobs,
});

const contextAfterJobs = [
  ...clone(beforeState.specJobs),
  job('job-context-v2-enrich', 'enrich', 'running', 2, '2026-03-16T00:02:01.000Z', 'enrich', {
    request_payload: {
      origin: 'persist-post-save',
      stage: 'enrich',
      editRevision: 2,
      queuePosition: 1,
    },
  }),
  job('job-context-v2-match', 'match-skills', 'pending', 2, '2026-03-16T00:02:02.000Z', 'matchSkills', {
    boss_job_id: null,
  }),
];

const contextAfter = state({
  dbSpecRow: dbRow({
    context_fingerprint: 'ctx-v2',
    story_fingerprint: 'story-v1',
    edit_revision: 2,
  }),
  diskSpec: diskSpec(withContextChange()),
  generationLog: generationLog({
    id: 3,
    status: 'pending_enrichment',
    summary: {
      editRevision: 2,
      contextFingerprint: 'ctx-v2',
      generationFingerprint: 'gen-v2-pending',
      postSaveStages: contextStages,
      contextUsed: ['forge/specs/approved/rer-fixture-spec.json', 'direction-stack:L4/L5-from-disk'],
    },
  }),
  specJobs: contextAfterJobs,
});

const rapidAfterJobs = [
  ...clone(beforeState.specJobs),
  job('job-rapid-v2-enrich', 'enrich', 'running', 2, '2026-03-16T00:03:01.000Z', 'enrich', {
    request_payload: {
      origin: 'persist-post-save',
      stage: 'enrich',
      editRevision: 2,
      queuePosition: 1,
      supersededByRevision: 3,
    },
    result_payload: {
      applied: false,
      editRevision: 2,
      generationFingerprint: 'gen-v2-superseded',
    },
  }),
  job('job-rapid-v2-match', 'match-skills', 'pending', 2, '2026-03-16T00:03:02.000Z', 'matchSkills', {
    boss_job_id: null,
    request_payload: {
      origin: 'persist-post-save',
      stage: 'matchSkills',
      editRevision: 2,
      supersededByRevision: 3,
    },
  }),
  job('job-rapid-v3-enrich', 'enrich', 'completed', 3, '2026-03-16T00:03:03.000Z', 'enrich', {
    boss_job_id: '00000000-0000-4000-8000-000000000403',
  }),
  job('job-rapid-v3-match', 'match-skills', 'completed', 3, '2026-03-16T00:03:04.000Z', 'matchSkills', {
    boss_job_id: '00000000-0000-4000-8000-000000000404',
    result_payload: {
      applied: true,
      editRevision: 3,
      generationFingerprint: 'skills-v3',
    },
  }),
];

const rapidAfter = state({
  dbSpecRow: dbRow({
    context_fingerprint: 'ctx-v3',
    story_fingerprint: 'story-v3',
    edit_revision: 3,
  }),
  diskSpec: diskSpec(withRapidFinalChange()),
  generationLog: generationLog({
    id: 4,
    status: 'persisted',
    summary: {
      editRevision: 3,
      contextFingerprint: 'ctx-v3',
      storyFingerprint: 'story-v3',
      generationFingerprint: 'gen-v3',
      postSaveStages: rapidStages,
      contextUsed: ['forge/specs/approved/rer-fixture-spec.json', 'direction-stack:L4/L5-from-disk'],
    },
  }),
  specJobs: rapidAfterJobs,
});

export function newestEditKanbanState(rows: SpecJobFixtureRow[]): KanbanActiveFixtureState {
  const newestRevision = Math.max(...rows.map((row) => row.request_payload.editRevision));
  const activeForNewestRevision = rows
    .filter((row) => row.request_payload.editRevision === newestRevision)
    .filter((row) => row.status === 'pending' || row.status === 'running')
    .sort((a, b) => {
      const priority = (row: SpecJobFixtureRow): number => {
        if (row.status === 'running') return 0;
        if (row.boss_job_id) return 1;
        return 2;
      };
      const priorityDelta = priority(a) - priority(b);
      if (priorityDelta !== 0) return priorityDelta;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    })[0];

  if (!activeForNewestRevision) return {};

  return {
    activeRunStatus: activeForNewestRevision.status === 'running' ? 'running' : 'queued',
    ...(activeForNewestRevision.request_payload.queuePosition
      ? { queuePosition: activeForNewestRevision.request_payload.queuePosition }
      : {}),
    sourceJobId: activeForNewestRevision.id,
    editRevision: activeForNewestRevision.request_payload.editRevision,
  };
}

export function legacyLingeringJobKanbanState(rows: SpecJobFixtureRow[]): KanbanActiveFixtureState {
  const active = rows
    .filter((row) => row.status === 'pending' || row.status === 'running')
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())[0];
  if (!active) return {};
  return {
    activeRunStatus: active.status === 'running' ? 'running' : 'queued',
    ...(active.request_payload.queuePosition ? { queuePosition: active.request_payload.queuePosition } : {}),
    sourceJobId: active.id,
    editRevision: active.request_payload.editRevision,
  };
}

export const specEditReEnrichmentCases: EditRegressionCase[] = [
  {
    name: 'metadata-only edit keeps enrichment logs, stages, and jobs unchanged',
    editClass: 'metadata-only',
    workspaceId,
    specId,
    before: clone(beforeState),
    after: metadataAfter,
    expected: {
      beforeJobStates: jobStates(beforeState.specJobs),
      afterJobStates: jobStates(metadataAfter.specJobs),
      beforeGenerationStatus: 'persisted',
      afterGenerationStatus: 'persisted',
      beforePostSaveStages: clone(completedStagesV1),
      afterPostSaveStages: clone(completedStagesV1),
      beforeKanbanActiveState: {},
      afterKanbanActiveState: {},
    },
  },
  {
    name: 'story-content-only edit queues match-skills without resynthesizing L4/L5 context',
    editClass: 'story-content-only',
    workspaceId,
    specId,
    before: clone(beforeState),
    after: storyAfter,
    expected: {
      beforeJobStates: jobStates(beforeState.specJobs),
      afterJobStates: jobStates(storyAfterJobs),
      beforeGenerationStatus: 'persisted',
      afterGenerationStatus: 'pending_enrichment',
      beforePostSaveStages: clone(completedStagesV1),
      afterPostSaveStages: storyOnlyStages,
      beforeKanbanActiveState: {},
      afterKanbanActiveState: {
        activeRunStatus: 'queued',
        queuePosition: 2,
        sourceJobId: 'job-story-v2-match',
        editRevision: 2,
      },
    },
  },
  {
    name: 'context-affecting edit snapshots DB row and disk spec before re-enrichment',
    editClass: 'context-affecting',
    workspaceId,
    specId,
    before: clone(beforeState),
    after: contextAfter,
    expected: {
      beforeJobStates: jobStates(beforeState.specJobs),
      afterJobStates: jobStates(contextAfterJobs),
      beforeGenerationStatus: 'persisted',
      afterGenerationStatus: 'pending_enrichment',
      beforePostSaveStages: clone(completedStagesV1),
      afterPostSaveStages: contextStages,
      beforeKanbanActiveState: {},
      afterKanbanActiveState: {
        activeRunStatus: 'running',
        queuePosition: 1,
        sourceJobId: 'job-context-v2-enrich',
        editRevision: 2,
      },
    },
  },
  {
    name: 'rapid successive saves ignore a lingering older active job and apply only final output',
    editClass: 'rapid-successive-saves',
    workspaceId,
    specId,
    before: clone(beforeState),
    after: rapidAfter,
    expected: {
      beforeJobStates: jobStates(beforeState.specJobs),
      afterJobStates: jobStates(rapidAfterJobs),
      beforeGenerationStatus: 'persisted',
      afterGenerationStatus: 'persisted',
      beforePostSaveStages: clone(completedStagesV1),
      afterPostSaveStages: rapidStages,
      beforeKanbanActiveState: {},
      afterKanbanActiveState: {},
      legacyStuckKanbanState: {
        activeRunStatus: 'running',
        queuePosition: 1,
        sourceJobId: 'job-rapid-v2-enrich',
        editRevision: 2,
      },
    },
  },
];
