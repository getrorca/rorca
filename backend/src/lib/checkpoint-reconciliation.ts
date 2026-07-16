/**
 * Admin-only, attestation-backed checkpoint reconciliation.
 *
 * A recovery caller can name an attestation but cannot manufacture validation by
 * submitting a command or a prose summary. Attestations are immutable records
 * created by a trusted validation gate and checked while a PostgreSQL advisory
 * lock serializes reconciliation across backend processes.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import simpleGit from 'simple-git';
import { z } from 'zod';
import { queryOne, transaction } from '../db/index';
import { broadcastAll, type WalEvent } from './sse-hub';
import { markStoryPassed } from './execution-engine';
import { ConflictError, NotFoundError, UnprocessableError } from './errors';

const FULL_SHA = /^[0-9a-f]{40}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BRANCH = /^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const DIGEST = /^[0-9a-f]{64}$/i;
export const CANONICAL_VALIDATION_GATES = ['execution-engine', 'ci'] as const;

export const checkpointReconciliationSchema = z.object({
  workspaceId: z.string().regex(IDENTIFIER, 'workspaceId must be a bounded identifier'),
  specId: z.string().regex(IDENTIFIER, 'specId must be a bounded identifier'),
  runId: z.number().int().positive(),
  storyId: z.string().regex(IDENTIFIER, 'storyId must be a bounded identifier'),
  branch: z.string().regex(BRANCH, 'branch must be a bounded branch name'),
  checkpointSha: z.string().regex(FULL_SHA, 'checkpointSha must be a full 40-character SHA'),
  attestationId: z.string().uuid(),
  attestationDigest: z.string().regex(DIGEST, 'attestationDigest must be a SHA-256 digest'),
}).strict();
export type CheckpointReconciliationInput = z.infer<typeof checkpointReconciliationSchema>;

export const checkpointAttestationLookupSchema = checkpointReconciliationSchema.pick({
  workspaceId: true,
  runId: true,
  storyId: true,
  branch: true,
  checkpointSha: true,
}).strict();
export type CheckpointAttestationLookupInput = z.infer<typeof checkpointAttestationLookupSchema>;

export const checkpointValidationAttestationSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().regex(IDENTIFIER),
  runId: z.number().int().positive(),
  storyId: z.string().regex(IDENTIFIER),
  branch: z.string().regex(BRANCH),
  checkpointSha: z.string().regex(FULL_SHA),
  validationGate: z.enum(CANONICAL_VALIDATION_GATES),
  evidenceDigest: z.string().regex(DIGEST),
  passedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();
export type CheckpointValidationAttestation = z.infer<typeof checkpointValidationAttestationSchema>;

interface WorkspaceRow { path: string; }
interface RunRow {
  workspace_id: string;
  spec_path: string;
  status: string;
  branch_name: string | null;
  auto_merge: boolean | null;
  merge_strategy: string | null;
  merge_status: string | null;
}
interface AttestationRow {
  id: string; workspace_id: string; run_id: number; story_id: string; branch_name: string;
  checkpoint_sha: string; validation_gate: string; evidence_digest: string; passed_at: string; expires_at: string; revoked_at: string | null;
}
interface ProvenanceRow { checkpoint_sha: string; attestation_id: string; attestation_digest: string; }
interface Story { id?: string; passes?: boolean; status?: string; dependsOn?: string[]; }
interface SpecDocument { userStories?: Story[]; stories?: Story[]; }

function canonicalSpecPath(specId: string): string { return path.posix.join('forge', 'specs', 'approved', `${specId}.json`); }
function storiesFromSpec(spec: SpecDocument): Story[] { return spec.userStories ?? spec.stories ?? []; }
function readSpec(specPath: string): SpecDocument {
  try { return JSON.parse(fs.readFileSync(specPath, 'utf8')) as SpecDocument; }
  catch { throw new UnprocessableError('Canonical spec is unreadable', 'CHECKPOINT_SPEC_UNREADABLE'); }
}
function attestationHash(attestation: CheckpointValidationAttestation): string {
  // The trusted gate supplies this immutable digest; this helper is intentionally
  // exported for gate implementations and does not accept user prose.
  return crypto.createHash('sha256').update(JSON.stringify({
    id: attestation.id, workspaceId: attestation.workspaceId, runId: attestation.runId,
    storyId: attestation.storyId, branch: attestation.branch, checkpointSha: attestation.checkpointSha,
    validationGate: attestation.validationGate, evidenceDigest: attestation.evidenceDigest,
    passedAt: attestation.passedAt, expiresAt: attestation.expiresAt,
  })).digest('hex');
}
export { attestationHash };

/** Read-only lookup used by trusted supervisors; it never creates an attestation. */
export async function getCheckpointAttestationReference(input: CheckpointAttestationLookupInput): Promise<{
  attestationId: string;
  attestationDigest: string;
  validationGate: string;
  expiresAt: string;
} | undefined> {
  const parsed = checkpointAttestationLookupSchema.parse(input);
  const row = await queryOne<{
    id: string;
    evidence_digest: string;
    validation_gate: string;
    expires_at: string;
  }>(
    `SELECT id, evidence_digest, validation_gate, expires_at
       FROM checkpoint_validation_attestations
      WHERE workspace_id = $1 AND run_id = $2 AND story_id = $3
        AND branch_name = $4 AND checkpoint_sha = $5
        AND revoked_at IS NULL AND expires_at > NOW()
      ORDER BY passed_at DESC
      LIMIT 1`,
    [parsed.workspaceId, parsed.runId, parsed.storyId, parsed.branch, parsed.checkpointSha.toLowerCase()],
  );
  return row ? {
    attestationId: row.id,
    attestationDigest: row.evidence_digest,
    validationGate: row.validation_gate,
    expiresAt: new Date(row.expires_at).toISOString(),
  } : undefined;
}

/** Called by trusted validation-gate code; there is deliberately no write HTTP/MCP route. */
export async function recordCheckpointValidationAttestation(attestation: CheckpointValidationAttestation): Promise<void> {
  const parsed = checkpointValidationAttestationSchema.parse(attestation);
  if (Date.parse(parsed.expiresAt) <= Date.parse(parsed.passedAt)) {
    throw new UnprocessableError('Attestation expiry must follow gate pass time', 'CHECKPOINT_ATTESTATION_INVALID_EXPIRY');
  }
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO checkpoint_validation_attestations
       (id, workspace_id, run_id, story_id, branch_name, checkpoint_sha, validation_gate, evidence_digest, passed_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (workspace_id, run_id, story_id, branch_name, checkpoint_sha, validation_gate) DO NOTHING`,
      [parsed.id, parsed.workspaceId, parsed.runId, parsed.storyId, parsed.branch, parsed.checkpointSha.toLowerCase(), parsed.validationGate, parsed.evidenceDigest.toLowerCase(), parsed.passedAt, parsed.expiresAt],
    );
  });
}

async function assertExactBranchHead(workspacePath: string, checkpointSha: string, branchName: string): Promise<string> {
  const git = simpleGit(workspacePath);
  let head: string;
  try { head = (await git.raw(['rev-parse', '--verify', `${branchName}^{commit}`])).trim(); }
  catch { throw new UnprocessableError('Run branch head is unavailable', 'CHECKPOINT_BRANCH_HEAD_NOT_FOUND'); }
  if (!FULL_SHA.test(head) || head.toLowerCase() !== checkpointSha.toLowerCase()) {
    throw new ConflictError('Checkpoint must be the exact current full run-branch head, not an ancestor', { code: 'CHECKPOINT_NOT_BRANCH_HEAD' });
  }
  return head.toLowerCase();
}

async function assertCommitReachableFromBase(workspacePath: string, checkpointSha: string): Promise<void> {
  try {
    await simpleGit(workspacePath).raw(['merge-base', '--is-ancestor', checkpointSha, 'HEAD']);
  } catch {
    throw new ConflictError('Checkpoint commit is not reachable from the integrated base', {
      code: 'CHECKPOINT_NOT_BASE_INTEGRATED',
    });
  }
}

export interface CheckpointReconciliationResult {
  reconciled: true; idempotent: boolean; workspaceId: string; specId: string; runId: number;
  storyId: string; branch: string; checkpointSha: string; attestationId: string;
  validationGate: string; walEventId?: number;
}

export async function reconcileCheckpoint(input: CheckpointReconciliationInput): Promise<CheckpointReconciliationResult> {
  return transaction(async (client) => {
    // A transaction-scoped advisory lock is process-safe and covers both the
    // provenance check and the canonical file mutation below.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`checkpoint:${input.workspaceId}:${input.runId}:${input.storyId}`]);

    const [workspaceResult, runResult, attestationResult] = await Promise.all([
      client.query<WorkspaceRow>('SELECT path FROM workspaces WHERE id = $1', [input.workspaceId]),
      client.query<RunRow>(
        'SELECT workspace_id, spec_path, status, branch_name, auto_merge, merge_strategy, merge_status FROM pipeline_runs WHERE id = $1',
        [input.runId],
      ),
      client.query<AttestationRow>(
        `SELECT id, workspace_id, run_id, story_id, branch_name, checkpoint_sha, validation_gate, evidence_digest, passed_at, expires_at, revoked_at
         FROM checkpoint_validation_attestations WHERE id = $1 FOR SHARE`, [input.attestationId],
      ),
    ]);
    const workspace = workspaceResult.rows[0];
    const run = runResult.rows[0];
    const attestation = attestationResult.rows[0];
    if (!workspace) throw new NotFoundError('Workspace', input.workspaceId);
    if (!run) throw new NotFoundError('Pipeline run', String(input.runId));
    if (!attestation) throw new NotFoundError('Checkpoint validation attestation', input.attestationId);
    if (attestation.revoked_at || Date.parse(attestation.expires_at) <= Date.now()) {
      throw new UnprocessableError('Checkpoint validation attestation is revoked or expired', 'CHECKPOINT_ATTESTATION_INVALID');
    }
    if (attestation.validation_gate !== 'execution-engine' && attestation.validation_gate !== 'ci') {
      throw new UnprocessableError('Checkpoint validation gate is not canonical', 'CHECKPOINT_VALIDATION_GATE_INVALID');
    }
    const attestationMatches = attestation.workspace_id === input.workspaceId && attestation.run_id === input.runId &&
      attestation.story_id === input.storyId && attestation.branch_name === input.branch &&
      attestation.checkpoint_sha.toLowerCase() === input.checkpointSha.toLowerCase() &&
      attestation.evidence_digest.toLowerCase() === input.attestationDigest.toLowerCase();
    if (!attestationMatches) throw new ConflictError('Attestation does not bind this exact checkpoint identity', { code: 'CHECKPOINT_ATTESTATION_MISMATCH' });
    if (run.workspace_id !== input.workspaceId || run.spec_path !== canonicalSpecPath(input.specId)) {
      throw new ConflictError('Pipeline run ownership does not match checkpoint', { code: 'CHECKPOINT_RUN_OWNERSHIP_MISMATCH' });
    }
    if (!['failed', 'cancelled'].includes(run.status)) throw new ConflictError('Pipeline run is not terminal and recoverable', { code: 'CHECKPOINT_RUN_NOT_RECOVERABLE' });
    if (!run.branch_name || run.branch_name !== input.branch) throw new ConflictError('Checkpoint branch does not match pipeline run branch', { code: 'CHECKPOINT_BRANCH_MISMATCH' });
    if (run.auto_merge !== true || run.merge_strategy !== 'direct' || run.merge_status !== 'merged') {
      throw new ConflictError('Checkpoint contribution is not base-integrated', { code: 'CHECKPOINT_BRANCH_NOT_INTEGRATED' });
    }

    const checkpointSha = await assertExactBranchHead(workspace.path, input.checkpointSha, input.branch);
    const provenanceResult = await client.query<ProvenanceRow>(
      `SELECT checkpoint_sha, attestation_id, attestation_digest FROM checkpoint_reconciliations
       WHERE workspace_id = $1 AND run_id = $2 AND story_id = $3 FOR UPDATE`, [input.workspaceId, input.runId, input.storyId],
    );
    const provenance = provenanceResult.rows[0];
    if (provenance) {
      const same = provenance.checkpoint_sha.toLowerCase() === checkpointSha && provenance.attestation_id === input.attestationId &&
        provenance.attestation_digest.toLowerCase() === input.attestationDigest.toLowerCase();
      if (!same) throw new ConflictError('Story was already reconciled with different immutable checkpoint provenance', { code: 'CHECKPOINT_PROVENANCE_CONFLICT' });
      return { reconciled: true, idempotent: true, workspaceId: input.workspaceId, specId: input.specId, runId: input.runId, storyId: input.storyId, branch: input.branch, checkpointSha, attestationId: input.attestationId, validationGate: attestation.validation_gate };
    }

    await assertCommitReachableFromBase(workspace.path, checkpointSha);

    // Re-read while locked: a story deleted after gate validation is never passed.
    const specPath = path.join(workspace.path, canonicalSpecPath(input.specId));
    if (!fs.existsSync(specPath)) throw new NotFoundError('Approved spec', input.specId);
    const stories = storiesFromSpec(readSpec(specPath));
    const story = stories.find((candidate) => candidate.id === input.storyId);
    if (!story) throw new ConflictError('Attested story no longer exists in canonical spec', { code: 'CHECKPOINT_STORY_DISAPPEARED' });
    if (story.passes === true || story.status === 'passed') {
      throw new ConflictError('Story is already passed without reconciliation provenance', { code: 'CHECKPOINT_PASSED_WITHOUT_PROVENANCE' });
    }
    const unmet = (story.dependsOn ?? []).filter((id) => !stories.find((candidate) => candidate.id === id)?.passes);
    if (unmet.length) throw new ConflictError('Checkpoint story dependencies are not complete', { code: 'CHECKPOINT_DEPENDENCY_INCOMPLETE', dependencies: unmet });

    const lifecycle = await markStoryPassed(specPath, input.storyId);
    if (!lifecycle.storyFound || !lifecycle.changed) {
      throw new ConflictError('Canonical story changed during reconciliation', { code: 'CHECKPOINT_STORY_RACE' });
    }
    await client.query(
      `INSERT INTO checkpoint_reconciliations
       (workspace_id, run_id, story_id, spec_id, branch_name, checkpoint_sha, attestation_id, attestation_digest, validation_gate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [input.workspaceId, input.runId, input.storyId, input.specId, input.branch, checkpointSha, input.attestationId, input.attestationDigest.toLowerCase(), attestation.validation_gate],
    );
    const walResult = await client.query<WalEvent>(
      `INSERT INTO wal_events (event_type, workspace_id, spec_id, run_id, payload) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      ['checkpoint_reconciled', input.workspaceId, input.specId, input.runId, JSON.stringify({ contractVersion: 'v1', source: 'governed_checkpoint_reconciliation', runId: input.runId, storyId: input.storyId, branch: input.branch, checkpointSha, attestationId: input.attestationId, validationGate: attestation.validation_gate, attestationDigest: input.attestationDigest.toLowerCase() })],
    );
    const walEvent = walResult.rows[0];
    // SSE after commit would be ideal; this hub event is only a notification and
    // the WAL row remains durable source of truth if a listener misses it.
    if (walEvent) broadcastAll(walEvent);
    return { reconciled: true, idempotent: false, workspaceId: input.workspaceId, specId: input.specId, runId: input.runId, storyId: input.storyId, branch: input.branch, checkpointSha, attestationId: input.attestationId, validationGate: attestation.validation_gate, ...(walEvent ? { walEventId: walEvent.id } : {}) };
  });
}
