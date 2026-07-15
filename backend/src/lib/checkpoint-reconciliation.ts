/**
 * Governed checkpoint reconciliation.
 *
 * External recovery supervisors may present a checkpoint, but this service
 * verifies all Rorca-owned identities and moves the canonical story lifecycle
 * only through the execution engine's canonical story-pass service.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import simpleGit from 'simple-git';
import { z } from 'zod';
import { queryOne } from '../db/index';
import { broadcastAll, type WalEvent } from './sse-hub';
import { markStoryPassed } from './execution-engine';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from './errors';

const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sha = /^[0-9a-f]{7,64}$/i;
const branch = /^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export const checkpointReconciliationSchema = z.object({
  workspaceId: z.string().regex(identifier, 'workspaceId must be a bounded identifier'),
  specId: z.string().regex(identifier, 'specId must be a bounded identifier'),
  runId: z.number().int().positive(),
  storyId: z.string().regex(identifier, 'storyId must be a bounded identifier'),
  branch: z.string().regex(branch, 'branch must be a bounded branch name'),
  commitSha: z.string().regex(sha, 'commitSha must be a 7-64 character hexadecimal SHA'),
  validation: z.object({
    passed: z.literal(true),
    completedAt: z.string().datetime(),
    commitSha: z.string().regex(sha, 'validation.commitSha must be a SHA'),
    command: z.string().min(1).max(500),
    summary: z.string().min(1).max(4_000),
  }).strict(),
}).strict();

export type CheckpointReconciliationInput = z.infer<typeof checkpointReconciliationSchema>;

interface WorkspaceRow { path: string; }
interface RunRow { workspace_id: string; spec_path: string; status: string; branch_name: string | null; }
interface Story { id?: string; passes?: boolean; status?: string; dependsOn?: string[]; }
interface SpecDocument { userStories?: Story[]; stories?: Story[]; }

function evidenceDigest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalSpecPath(specId: string): string {
  return path.posix.join('forge', 'specs', 'approved', `${specId}.json`);
}

function readSpec(specPath: string): SpecDocument {
  try {
    return JSON.parse(fs.readFileSync(specPath, 'utf8')) as SpecDocument;
  } catch {
    throw new UnprocessableError('Canonical spec is unreadable', 'CHECKPOINT_SPEC_UNREADABLE');
  }
}

function storiesFromSpec(spec: SpecDocument): Story[] {
  return spec.userStories ?? spec.stories ?? [];
}

function assertFreshEvidence(validation: CheckpointReconciliationInput['validation'], commitSha: string): void {
  if (validation.commitSha.toLowerCase() !== commitSha.toLowerCase()) {
    throw new UnprocessableError('Validation evidence commit does not match checkpoint commit', 'CHECKPOINT_EVIDENCE_COMMIT_MISMATCH');
  }
  const completedAt = Date.parse(validation.completedAt);
  if (Number.isNaN(completedAt)) {
    throw new ValidationError('validation.completedAt must be a valid ISO timestamp');
  }
  const now = Date.now();
  if (completedAt > now + MAX_FUTURE_SKEW_MS || now - completedAt > MAX_EVIDENCE_AGE_MS) {
    throw new UnprocessableError('Validation evidence is stale or has an invalid timestamp', 'CHECKPOINT_EVIDENCE_STALE');
  }
}

async function assertCommitOnBranch(workspacePath: string, commitSha: string, branchName: string): Promise<string> {
  const git = simpleGit(workspacePath);
  let resolvedCommit: string;
  try {
    resolvedCommit = (await git.raw(['rev-parse', '--verify', `${commitSha}^{commit}`])).trim();
  } catch {
    throw new UnprocessableError('Checkpoint commit is not available in this workspace', 'CHECKPOINT_COMMIT_NOT_FOUND');
  }

  try {
    await git.raw(['merge-base', '--is-ancestor', resolvedCommit, branchName]);
  } catch {
    throw new ConflictError('Checkpoint commit is not reachable from the run branch', {
      code: 'CHECKPOINT_COMMIT_NOT_ON_BRANCH',
    });
  }
  return resolvedCommit;
}

export interface CheckpointReconciliationResult {
  reconciled: boolean;
  idempotent: boolean;
  workspaceId: string;
  specId: string;
  runId: number;
  storyId: string;
  branch: string;
  commitSha: string;
  validation: { passed: true; completedAt: string; commandDigest: string; summaryDigest: string };
  walEventId?: number;
}

export async function reconcileCheckpoint(input: CheckpointReconciliationInput): Promise<CheckpointReconciliationResult> {
  assertFreshEvidence(input.validation, input.commitSha);

  const [workspace, run] = await Promise.all([
    queryOne<WorkspaceRow>('SELECT path FROM workspaces WHERE id = $1', [input.workspaceId]),
    queryOne<RunRow>('SELECT workspace_id, spec_path, status, branch_name FROM pipeline_runs WHERE id = $1', [input.runId]),
  ]);
  if (!workspace) throw new NotFoundError('Workspace', input.workspaceId);
  if (!run) throw new NotFoundError('Pipeline run', String(input.runId));
  if (run.workspace_id !== input.workspaceId) {
    throw new ConflictError('Pipeline run does not belong to workspace', { code: 'CHECKPOINT_WORKSPACE_MISMATCH' });
  }
  if (run.spec_path !== canonicalSpecPath(input.specId)) {
    throw new ConflictError('Pipeline run does not belong to spec', { code: 'CHECKPOINT_SPEC_MISMATCH' });
  }
  if (!['failed', 'cancelled'].includes(run.status)) {
    throw new ConflictError('Pipeline run is not terminal and recoverable', { code: 'CHECKPOINT_RUN_NOT_RECOVERABLE' });
  }
  if (!run.branch_name || run.branch_name !== input.branch) {
    throw new ConflictError('Checkpoint branch does not match pipeline run branch', { code: 'CHECKPOINT_BRANCH_MISMATCH' });
  }

  const specPath = path.join(workspace.path, canonicalSpecPath(input.specId));
  if (!fs.existsSync(specPath)) throw new NotFoundError('Approved spec', input.specId);
  const spec = readSpec(specPath);
  const stories = storiesFromSpec(spec);
  const story = stories.find((candidate) => candidate.id === input.storyId);
  if (!story) throw new NotFoundError('Story', input.storyId);
  const dependencies = story.dependsOn ?? [];
  const unmetDependencies = dependencies.filter((id) => !stories.find((candidate) => candidate.id === id)?.passes);
  if (unmetDependencies.length > 0) {
    throw new ConflictError('Checkpoint story dependencies are not complete', {
      code: 'CHECKPOINT_DEPENDENCY_INCOMPLETE',
      dependencies: unmetDependencies,
    });
  }

  const resolvedCommit = await assertCommitOnBranch(workspace.path, input.commitSha, input.branch);
  const validation = {
    passed: true as const,
    completedAt: input.validation.completedAt,
    commandDigest: evidenceDigest(input.validation.command),
    summaryDigest: evidenceDigest(input.validation.summary),
  };

  // This is the same lock and mutation path used by normal engine completion;
  // no route or external caller receives database lifecycle authority.
  const lifecycle = await markStoryPassed(specPath, input.storyId);
  if (!lifecycle.changed) {
    return {
      reconciled: true,
      idempotent: true,
      workspaceId: input.workspaceId,
      specId: input.specId,
      runId: input.runId,
      storyId: input.storyId,
      branch: input.branch,
      commitSha: resolvedCommit,
      validation,
    };
  }

  const payload = {
    contractVersion: 'v1',
    source: 'governed_checkpoint_reconciliation',
    runId: input.runId,
    storyId: input.storyId,
    branch: input.branch,
    commitSha: resolvedCommit,
    validation,
  };
  const walEvent = await queryOne<WalEvent>(
    `INSERT INTO wal_events (event_type, workspace_id, spec_id, run_id, payload)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    ['checkpoint_reconciled', input.workspaceId, input.specId, input.runId, JSON.stringify(payload)],
  );
  if (walEvent) broadcastAll(walEvent);

  return {
    reconciled: true,
    idempotent: false,
    workspaceId: input.workspaceId,
    specId: input.specId,
    runId: input.runId,
    storyId: input.storyId,
    branch: input.branch,
    commitSha: resolvedCommit,
    validation,
    ...(walEvent ? { walEventId: walEvent.id } : {}),
  };
}
