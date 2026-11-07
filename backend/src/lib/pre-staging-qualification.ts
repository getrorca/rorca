/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Preview-bound, append-only software qualification before staging. */
import crypto, { randomUUID } from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type PgBoss from 'pg-boss';
import type { PoolClient } from 'pg';
import { canonicalTransaction, query, queryOne, transaction } from '../db/index';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from './errors';
import { sanitizeCapturePayload } from './context-safety';
import {
  SOFTWARE_QUALIFICATION_CATEGORIES,
  discoverSoftwareQualificationChecks,
  type SoftwareQualificationCategory,
  type SoftwareQualificationCheck,
  type SoftwareQualificationDiscovery,
} from './mechanism-discovery';
import { previewLifecycleReconciliation } from './lifecycle-reconciliation';
import { createCanonicalEvidence, persistQualificationEvidenceBatchInTransaction, type EvidenceClassification } from './ssdlc-evidence';
import { LifecyclePlanSchema, type LifecyclePlan, type PhaseId } from './ssdlc-contracts';
import { SSDLC_PLAN_COMPILER_VERSION } from './ssdlc-plan-compiler';
import { stableWalJson } from './trusted-wal';
import { WorkerRunResourceOwner, type WorkerChildTerminal } from './worker-run-resource-owner';
import { getBoss } from './pg-boss';
import {
  buildQualificationSandboxLaunch,
  loadQualificationSandboxIdentity,
  qualificationDependencyDigest,
  type QualificationSandboxIdentity,
} from './pre-staging-qualification-sandbox';

export const PRE_STAGING_QUALIFICATION_PREVIEW_VERSION = 'rorca.pre-staging-qualification-preview.v1' as const;
export const PRE_STAGING_QUALIFICATION_RECEIPT_VERSION = 'rorca.pre-staging-qualification-receipt.v1' as const;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40,64}$/;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_EXCERPT_BYTES = 8 * 1024;
const execFileAsync = promisify(execFile);
export const PRE_STAGING_QUALIFICATION_QUEUE = 'pipeline:pre-staging-qualification' as const;
const QUALIFICATION_LEASE_MS = 8 * 60 * 60_000;
const QUALIFICATION_WAIT_MS = 8 * 60 * 60_000;
const QUALIFICATION_POLL_MS = 250;
const QUALIFICATION_VERIFIER_SCRIPT = String.raw`
const crypto=require('node:crypto');let rows;try{rows=JSON.parse(process.argv[1])}catch{process.exit(126)}
if(!Array.isArray(rows)||rows.some(row=>!row||typeof row.id!=='string'||typeof row.exitCode!=='number'&&row.exitCode!==null
  ||typeof row.signal!=='string'&&row.signal!==null||typeof row.timedOut!=='boolean'
  ||typeof row.stdoutHash!=='string'||typeof row.stderrHash!=='string'))process.exit(126);
const verdicts=rows.map(row=>({id:row.id,status:row.exitCode===0&&row.signal===null&&!row.timedOut?'passed':'failed'}));
const material=JSON.stringify({schemaVersion:'rorca.pre-staging-process-verifier.v1',rows,verdicts});
process.stdout.write(JSON.stringify({schemaVersion:'rorca.pre-staging-process-verifier.v1',verdicts,
  verificationHash:'sha256:'+crypto.createHash('sha256').update(material).digest('hex')}));
`;
const QUALIFICATION_VERIFIER_DIGEST = digest(QUALIFICATION_VERIFIER_SCRIPT);

interface WorkspaceRow { id: string; path: string }
interface PlanRow {
  id: string;
  compiler_version: string;
  plan_json: unknown;
  provenance_json: unknown;
}
interface QualificationRunRow {
  id: string;
  canonical_spec_revision: string | null;
  terminal_checkout_sha: string | null;
  terminal_checkout_attested_at: Date | string | null;
  execution_worktree_path: string | null;
}
interface QualificationRow {
  id: string;
  workspace_id: string;
  spec_slug: string;
  spec_revision_hash: string;
  compiled_plan_id: string | null;
  run_id: string | null;
  head_sha: string;
  request_hash: string;
  preview_hash: string | null;
  status: 'passed' | 'failed' | 'blocked';
  mechanisms: QualificationCheckPlan[];
  check_results: QualificationCheckResult[];
  evidence_ids: string[];
  readiness: Record<string, unknown>;
  receipt_hash: string;
  created_by: string;
  created_at: Date | string;
}
interface QualificationAttemptRow {
  id: string;
  workspace_id: string;
  spec_slug: string;
  preview_hash: string;
  run_id: string | null;
  actor_id: string;
  idempotency_key: string;
  request_hash: string;
  checkout_sha: string | null;
  state: 'pending' | 'executing' | 'results_ready' | 'complete' | 'blocked';
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  result_payload: unknown | null;
  result_hash: `sha256:${string}` | null;
  receipt_id: string | null;
  error_code: string | null;
  error_message: string | null;
}
type ClaimedQualificationAttempt = QualificationAttemptRow & {
  state: 'executing';
  lease_token: string;
};

export interface QualificationCheckPlan {
  id: string;
  category: SoftwareQualificationCategory;
  label: string;
  executable: string;
  args: string[];
  cwd: string;
  discoveredFrom: string[];
  timeoutMs: number;
  controlIds?: string[];
}

export interface PreStagingQualificationPreview {
  schemaVersion: typeof PRE_STAGING_QUALIFICATION_PREVIEW_VERSION;
  workspaceId: string;
  specId: string;
  title: string;
  specRevisionHash: `sha256:${string}`;
  compiledPlanId: string | null;
  planId: string | null;
  policyVersion: string | null;
  compilerVersion: string | null;
  headSha: string;
  cleanHead: boolean;
  runId: number | null;
  checks: QualificationCheckPlan[];
  availableCategories: SoftwareQualificationCategory[];
  unavailableCategories: SoftwareQualificationCategory[];
  requiredCategories: SoftwareQualificationCategory[];
  missingRequiredCategories: SoftwareQualificationCategory[];
  preconditions: { canExecute: boolean; blockers: string[] };
  authority: { stagingAuthorityGranted: false; rationale: string };
  previewHash: `sha256:${string}`;
  observedAt: string;
}

export interface QualificationCheckResult extends QualificationCheckPlan {
  status: 'passed' | 'failed';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdoutHash: `sha256:${string}`;
  stderrHash: `sha256:${string}`;
  stdoutExcerpt: string;
  stderrExcerpt: string;
}

export interface PreStagingQualificationReceipt {
  schemaVersion: typeof PRE_STAGING_QUALIFICATION_RECEIPT_VERSION;
  id: string;
  workspaceId: string;
  specId: string;
  specRevisionHash: string;
  compiledPlanId: string | null;
  runId: number | null;
  headSha: string;
  previewHash: string | null;
  status: 'passed' | 'failed' | 'blocked';
  mechanisms: QualificationCheckPlan[];
  checkResults: QualificationCheckResult[];
  evidenceIds: string[];
  readiness: Record<string, unknown>;
  receiptHash: string;
  createdBy: string;
  createdAt: string;
  replayed: boolean;
}
interface QualificationVerifierReceipt {
  schemaVersion: 'rorca.pre-staging-process-verifier.v1';
  verifierDigest: `sha256:${string}`;
  verificationHash: `sha256:${string}`;
  verdicts: Array<{ id: string; status: 'passed' | 'failed' }>;
}

async function independentlyVerifyQualificationResults(
  results: QualificationCheckResult[],
): Promise<QualificationVerifierReceipt> {
  const rows = results.map((result) => ({
    id: result.id,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdoutHash: result.stdoutHash,
    stderrHash: result.stderrHash,
  }));
  const { stdout } = await execFileAsync(process.execPath, ['-e', QUALIFICATION_VERIFIER_SCRIPT, JSON.stringify(rows)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    timeout: 15_000,
    env: {},
  });
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new ConflictError('Qualification process verifier returned invalid output'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConflictError('Qualification process verifier returned invalid output');
  const value = parsed as Partial<QualificationVerifierReceipt>;
  if (value.schemaVersion !== 'rorca.pre-staging-process-verifier.v1'
    || !SHA256.test(value.verificationHash ?? '') || !Array.isArray(value.verdicts)
    || value.verdicts.length !== results.length) {
    throw new ConflictError('Qualification process verifier receipt is incomplete');
  }
  const verdictById = new Map(value.verdicts.map((verdict) => [verdict.id, verdict.status]));
  for (const result of results) {
    if (verdictById.get(result.id) !== result.status) {
      throw new ConflictError('Qualification process verifier disagreed with the executor result', { checkId: result.id });
    }
  }
  return {
    schemaVersion: value.schemaVersion,
    verifierDigest: QUALIFICATION_VERIFIER_DIGEST,
    verificationHash: value.verificationHash as `sha256:${string}`,
    verdicts: value.verdicts,
  };
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(stableWalJson(value)).digest('hex')}`;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function receipt(row: QualificationRow, replayed: boolean): PreStagingQualificationReceipt {
  return {
    schemaVersion: PRE_STAGING_QUALIFICATION_RECEIPT_VERSION,
    id: row.id,
    workspaceId: row.workspace_id,
    specId: row.spec_slug,
    specRevisionHash: row.spec_revision_hash,
    compiledPlanId: row.compiled_plan_id,
    runId: row.run_id === null ? null : Number(row.run_id),
    headSha: row.head_sha,
    previewHash: row.preview_hash,
    status: row.status,
    mechanisms: row.mechanisms,
    checkResults: row.check_results,
    evidenceIds: row.evidence_ids,
    readiness: row.readiness,
    receiptHash: row.receipt_hash,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
    replayed,
  };
}

async function workspace(workspaceId: string): Promise<WorkspaceRow> {
  const row = await queryOne<WorkspaceRow>('SELECT id, path FROM workspaces WHERE id = $1', [workspaceId]);
  if (!row) throw new NotFoundError('Workspace', workspaceId);
  return { ...row, path: await fs.realpath(row.path) };
}

function parsePlan(value: unknown): LifecyclePlan {
  const raw = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  return LifecyclePlanSchema.parse(raw);
}

function provenanceSpecHash(value: unknown): string | null {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('specHash' in raw)) return null;
  const specHash = raw.specHash;
  return typeof specHash === 'string' && SHA256.test(specHash) ? specHash : null;
}

async function planFor(workspaceId: string, compiledPlanId: string | null): Promise<{
  databaseId: string;
  compilerVersion: string;
  specRevisionHash: string | null;
  plan: LifecyclePlan;
} | null> {
  if (!compiledPlanId) return null;
  const row = await queryOne<PlanRow>(
    `SELECT id::text, compiler_version, plan_json, provenance_json
     FROM ssdlc_compiled_plans
     WHERE workspace_id = $1 AND id = $2::bigint
       AND is_current = TRUE AND validation_status = 'validated'`,
    [workspaceId, compiledPlanId],
  );
  return row ? {
    databaseId: row.id,
    compilerVersion: row.compiler_version,
    specRevisionHash: provenanceSpecHash(row.provenance_json),
    plan: parsePlan(row.plan_json),
  } : null;
}

async function gitState(workspacePath: string): Promise<{ headSha: string; clean: boolean }> {
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: workspacePath, encoding: 'utf8', maxBuffer: 64 * 1024 }),
    execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: workspacePath, encoding: 'utf8', maxBuffer: 512 * 1024 }),
  ]);
  const headSha = head.trim().toLowerCase();
  if (!GIT_SHA.test(headSha)) throw new UnprocessableError('Workspace HEAD is not a valid immutable Git commit', 'QUALIFICATION_HEAD_INVALID');
  return { headSha, clean: status.trim().length === 0 };
}

function relativeCheck(root: string, check: SoftwareQualificationCheck): QualificationCheckPlan {
  const cwd = path.relative(root, check.cwd).split(path.sep).join('/') || '.';
  if (cwd === '..' || cwd.startsWith('../') || path.isAbsolute(cwd)) {
    throw new ValidationError('Discovered qualification command escaped the workspace');
  }
  return { ...check, args: [...check.args], cwd };
}

async function gitCommonDirectory(repositoryPath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--git-common-dir'], {
    cwd: repositoryPath,
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
  });
  return fs.realpath(path.resolve(repositoryPath, stdout.trim()));
}

async function exactRunDiscoverySource(
  workspaceRoot: string,
  run: QualificationRunRow,
): Promise<{ path: string; release: () => Promise<void> }> {
  const terminalSha = run.terminal_checkout_sha?.toLowerCase();
  if (!terminalSha || !GIT_SHA.test(terminalSha)) {
    throw new ConflictError('Pipeline run lacks a valid attested terminal checkout revision', { runId: run.id });
  }
  if (run.execution_worktree_path) {
    try {
      const candidate = await fs.realpath(run.execution_worktree_path);
      const [candidateState, candidateCommon, workspaceCommon, status] = await Promise.all([
        gitState(candidate),
        gitCommonDirectory(candidate),
        gitCommonDirectory(workspaceRoot),
        execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
          cwd: candidate,
          encoding: 'utf8',
          maxBuffer: 512 * 1024,
        }),
      ]);
      const materialDrift = status.stdout.split(/\r?\n/).filter(Boolean).some((line) => {
        const changedPath = line.slice(3).replace(/^"|"$/g, '');
        return changedPath !== '.rorca' && !changedPath.startsWith('.rorca/');
      });
      if (candidateState.headSha === terminalSha
        && candidateCommon === workspaceCommon
        && !materialDrift) {
        return { path: candidate, release: async () => undefined };
      }
    } catch {
      // Missing, foreign, advanced, or materially dirty execution worktrees
      // are never used as evidence-discovery authority.
    }
  }
  const detached = await materializeRevisionArchive(workspaceRoot, terminalSha);
  return { path: detached.path, release: () => removeWorktree(workspaceRoot, detached) };
}

function requiredCategories(plan: LifecyclePlan | null): SoftwareQualificationCategory[] {
  if (!plan) return [];
  const required = new Set<SoftwareQualificationCategory>();
  if (plan.gates.some((gate) => gate.phaseId === 'testing')) {
    for (const category of ['lint', 'typecheck', 'unit', 'build', 'e2e'] as const) required.add(category);
  }
  if (plan.gates.some((gate) => gate.phaseId === 'deployment')) required.add('security');
  return SOFTWARE_QUALIFICATION_CATEGORIES.filter((category) => required.has(category));
}

export async function previewPreStagingQualification(input: {
  workspaceId: string;
  specId: string;
  runId?: number;
}): Promise<PreStagingQualificationPreview> {
  if (input.runId !== undefined && (!Number.isSafeInteger(input.runId) || input.runId <= 0)) {
    throw new ValidationError('runId must be a positive integer', { field: 'runId' });
  }
  const [ws, reconciliation] = await Promise.all([
    workspace(input.workspaceId),
    previewLifecycleReconciliation({ workspaceId: input.workspaceId, specId: input.specId }),
  ]);
  let boundRun: QualificationRunRow | undefined;
  if (input.runId !== undefined) {
    boundRun = await queryOne<QualificationRunRow>(
      `SELECT id::text, canonical_spec_revision, terminal_checkout_sha,
              terminal_checkout_attested_at, execution_worktree_path
       FROM pipeline_runs
       WHERE id = $1 AND workspace_id = $2 AND spec_path = $3`,
      [input.runId, input.workspaceId, `forge/specs/approved/${reconciliation.specId}.json`],
    );
    if (!boundRun) throw new NotFoundError('Pipeline run', String(input.runId));
    if (boundRun.canonical_spec_revision !== reconciliation.specRevisionHash) {
      throw new ConflictError('Pipeline run is not bound to the current canonical spec revision', {
        runId: input.runId,
        runSpecRevisionHash: boundRun.canonical_spec_revision,
        currentSpecRevisionHash: reconciliation.specRevisionHash,
      });
    }
    if (!boundRun.terminal_checkout_sha || !boundRun.terminal_checkout_attested_at) {
      throw new ConflictError('Pipeline run lacks an attested terminal checkout revision', {
        runId: input.runId,
      });
    }
  }
  const currentPlanPromise = planFor(input.workspaceId, reconciliation.compiledPlanId);
  let git: { headSha: string; clean: boolean };
  let discovery: SoftwareQualificationDiscovery;
  let checks: QualificationCheckPlan[];
  if (boundRun) {
    const exactSource = await exactRunDiscoverySource(ws.path, boundRun);
    try {
      discovery = await discoverSoftwareQualificationChecks(exactSource.path);
      checks = discovery.checks.map((check) => relativeCheck(exactSource.path, check));
    } finally {
      await exactSource.release();
    }
    git = { headSha: boundRun.terminal_checkout_sha!.toLowerCase(), clean: true };
  } else {
    [git, discovery] = await Promise.all([
      gitState(ws.path),
      discoverSoftwareQualificationChecks(ws.path),
    ]);
    checks = discovery.checks.map((check) => relativeCheck(ws.path, check));
  }
  const currentPlan = await currentPlanPromise;
  const required = requiredCategories(currentPlan?.plan ?? null);
  const missingRequired = required.filter((category) => {
    if (category === 'e2e') return !discovery.availableCategories.includes('e2e') && !discovery.availableCategories.includes('smoke');
    return !discovery.availableCategories.includes(category);
  });
  const blockers = [
    ...(!boundRun && !git.clean ? ['Workspace has tracked or untracked changes; qualification must execute against a clean immutable HEAD.'] : []),
    ...(reconciliation.planState !== 'current' ? ['The lifecycle reconciliation plan is not current for this canonical spec revision.'] : []),
    ...(!currentPlan ? ['No exact-revision compiled lifecycle plan is available.'] : []),
    ...(currentPlan && currentPlan.specRevisionHash !== reconciliation.specRevisionHash
      ? ['The compiled lifecycle plan provenance is not bound to this exact canonical spec revision.'] : []),
    ...(currentPlan && (currentPlan.compilerVersion !== SSDLC_PLAN_COMPILER_VERSION
      || currentPlan.plan.compilerVersion !== SSDLC_PLAN_COMPILER_VERSION)
      ? [`The compiled lifecycle plan was not produced by the current compiler ${SSDLC_PLAN_COMPILER_VERSION}.`] : []),
    ...(checks.length === 0 ? ['No repository-declared software qualification commands were discovered.'] : []),
  ];
  const stable = {
    schemaVersion: PRE_STAGING_QUALIFICATION_PREVIEW_VERSION,
    workspaceId: ws.id,
    specId: reconciliation.specId,
    title: reconciliation.title,
    specRevisionHash: reconciliation.specRevisionHash,
    compiledPlanId: currentPlan?.databaseId ?? null,
    planId: currentPlan?.plan.planId ?? null,
    policyVersion: currentPlan?.plan.policyVersion ?? null,
    compilerVersion: currentPlan?.plan.compilerVersion ?? null,
    headSha: git.headSha,
    cleanHead: git.clean,
    runId: input.runId ?? null,
    checks,
    availableCategories: discovery.availableCategories,
    unavailableCategories: discovery.unavailableCategories,
    requiredCategories: required,
    missingRequiredCategories: missingRequired,
    preconditions: { canExecute: blockers.length === 0, blockers },
    authority: {
      stagingAuthorityGranted: false as const,
      rationale: 'Qualification records host-observed evidence only; governed approvals and staging authority remain separate.',
    },
  };
  return { ...stable, previewHash: digest(stable), observedAt: new Date().toISOString() };
}


function appendBounded(current: Buffer, chunk: Buffer): Buffer {
  if (current.length >= MAX_CAPTURE_BYTES) return current;
  return Buffer.concat([current, chunk.subarray(0, MAX_CAPTURE_BYTES - current.length)]);
}

function safeExcerpt(value: Buffer): string {
  const text = value.subarray(0, MAX_EXCERPT_BYTES).toString('utf8');
  const sanitized = sanitizeCapturePayload({ value: text }).payload;
  return sanitized && typeof sanitized === 'object' && typeof (sanitized as Record<string, unknown>).value === 'string'
    ? (sanitized as Record<string, string>).value
    : '';
}

async function executeCheck(
  check: QualificationCheckPlan,
  worktreeRoot: string,
  sandbox: QualificationSandboxIdentity,
  ownerRunId: number,
): Promise<QualificationCheckResult> {
  const started = Date.now();
  const cwd = path.resolve(worktreeRoot, check.cwd);
  if (cwd !== worktreeRoot && !cwd.startsWith(`${worktreeRoot}${path.sep}`)) throw new ValidationError('Qualification check cwd escaped the isolated worktree');
  const owner = new WorkerRunResourceOwner({ runId: ownerRunId, termTimeoutMs: 5_000, killTimeoutMs: 5_000 });
  let stdout: Buffer = Buffer.alloc(0);
  let stderr: Buffer = Buffer.alloc(0);
  let terminal: WorkerChildTerminal;
  let timedOut = false;
  let timeoutMarker: NodeJS.Timeout | undefined;
  try {
    const launch = await buildQualificationSandboxLaunch({
      identity: sandbox,
      checkoutRoot: worktreeRoot,
      cwd,
      executable: check.executable,
      args: check.args,
    });
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    child.stdout?.on('data', (chunk: Buffer | string) => { stdout = appendBounded(stdout, Buffer.from(chunk)); });
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr = appendBounded(stderr, Buffer.from(chunk)); });
    owner.ownChild(child, ownerRunId);
    timeoutMarker = setTimeout(() => { timedOut = true; }, check.timeoutMs);
    timeoutMarker.unref?.();
    terminal = await owner.ownChildDeadline(check.timeoutMs);
  } catch (error) {
    stderr = appendBounded(stderr, Buffer.from(error instanceof Error ? error.message : String(error)));
    terminal = { kind: 'error', code: null, signal: null, error: error instanceof Error ? error : new Error(String(error)) };
  } finally {
    clearTimeout(timeoutMarker);
    await owner.dispose().catch((error: unknown) => {
      stderr = appendBounded(stderr, Buffer.from(error instanceof Error ? error.message : String(error)));
    });
  }
  const passed = terminal.kind === 'close' && terminal.code === 0 && terminal.signal === null && !timedOut;
  return {
    ...check,
    status: passed ? 'passed' : 'failed',
    exitCode: terminal.code,
    signal: terminal.signal,
    timedOut,
    durationMs: Date.now() - started,
    stdoutHash: digest(stdout.toString('base64')),
    stderrHash: digest(stderr.toString('base64')),
    stdoutExcerpt: safeExcerpt(stdout),
    stderrExcerpt: safeExcerpt(stderr),
  };
}

interface QualificationWorktree {
  path: string;
  removeBase: boolean;
}

const GIT_MATERIALIZATION_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '/bin/false',
};

async function extractGitArchive(repository: string, headSha: string, target: string): Promise<void> {
  await fs.mkdir(target, { mode: 0o700 });
  const archive = spawn('git', ['-c', 'core.hooksPath=/dev/null', 'archive', '--format=tar', headSha], {
    cwd: repository,
    env: GIT_MATERIALIZATION_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  const extractor = spawn('tar', ['-x', '-f', '-', '-C', target], {
    cwd: target,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdio: ['pipe', 'ignore', 'pipe'],
    shell: false,
  });
  archive.stdout!.pipe(extractor.stdin!);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  archive.stderr!.on('data', (chunk: Buffer | string) => { stderr = appendBounded(stderr, Buffer.from(chunk)); });
  extractor.stderr!.on('data', (chunk: Buffer | string) => { stderr = appendBounded(stderr, Buffer.from(chunk)); });
  const closed = (child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
    const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
    return promise;
  };
  const [archiveExit, extractorExit] = await Promise.all([closed(archive), closed(extractor)]);
  if (archiveExit.code !== 0 || archiveExit.signal || extractorExit.code !== 0 || extractorExit.signal) {
    throw new ConflictError('Exact qualification revision could not be materialized without repository-controlled checkout hooks', {
      archiveExit, extractorExit, stderr: safeExcerpt(stderr),
    });
  }
}

async function materializeRevisionArchive(root: string, headSha: string, base?: string): Promise<QualificationWorktree> {
  const repository = await fs.realpath(root);
  const parent = base ?? await fs.mkdtemp(path.join(os.tmpdir(), 'rorca-qualification-preview-'));
  const removeBase = base === undefined;
  const target = path.join(parent, `revision-${headSha.slice(0, 12)}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    await extractGitArchive(repository, headSha, target);
    return { path: await fs.realpath(target), removeBase };
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    if (removeBase) await fs.rm(parent, { recursive: true, force: true });
    throw error;
  }
}

async function addWorktree(root: string, headSha: string): Promise<QualificationWorktree> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  const configuredBase = String(process.env.RORCA_QUALIFICATION_WORKTREE_ROOT
    ?? path.join(os.tmpdir(), `rorca-qualification-worker-${uid}`));
  if (!path.isAbsolute(configuredBase)) throw new ValidationError('Qualification worktree root must be absolute');
  await fs.mkdir(configuredBase, { recursive: true, mode: 0o700 });
  const base = await fs.realpath(configuredBase);
  const baseStat = await fs.stat(base);
  const repository = await fs.realpath(root);
  const overlap = path.relative(repository, base);
  const reverseOverlap = path.relative(base, repository);
  if (!baseStat.isDirectory() || baseStat.uid !== uid || (baseStat.mode & 0o077) !== 0
    || overlap === '' || (!overlap.startsWith('..') && !path.isAbsolute(overlap))
    || reverseOverlap === '' || (!reverseOverlap.startsWith('..') && !path.isAbsolute(reverseOverlap))) {
    throw new ValidationError('Qualification worktree root must be private, worker-owned, and separate from the repository');
  }
  return materializeRevisionArchive(repository, headSha, base);
}

async function removeWorktree(_root: string, worktree: QualificationWorktree): Promise<void> {
  await fs.rm(worktree.path, { recursive: true, force: true });
  if (worktree.removeBase) await fs.rm(path.dirname(worktree.path), { recursive: true, force: true });
}

function checkBinding(check: QualificationCheckPlan): Record<string, unknown> {
  return {
    id: check.id,
    category: check.category,
    label: check.label,
    executable: check.executable,
    args: check.args,
    cwd: check.cwd,
    discoveredFrom: check.discoveredFrom,
    timeoutMs: check.timeoutMs,
    controlIds: check.controlIds ?? [],
  };
}

async function rediscoverExactChecks(
  worktreeRoot: string,
  previewChecks: QualificationCheckPlan[],
): Promise<QualificationCheckPlan[]> {
  const discovery = await discoverSoftwareQualificationChecks(worktreeRoot);
  const exactChecks = discovery.checks.map((check) => relativeCheck(worktreeRoot, check));
  if (digest(previewChecks.map(checkBinding)) !== digest(exactChecks.map(checkBinding))) {
    throw new ConflictError('Qualification mechanisms changed between preview and exact detached execution', {
      previewMechanismsHash: digest(previewChecks.map(checkBinding)),
      executionMechanismsHash: digest(exactChecks.map(checkBinding)),
    });
  }
  return exactChecks;
}


function gateCategories(gateId: string): SoftwareQualificationCategory[] {
  if (gateId === 'gate-ctrl-testing-req-regression') return ['unit', 'integration'];
  if (gateId === 'gate-ctrl-testing-quality-attributes') return ['lint', 'typecheck', 'performance', 'build', 'package'];
  if (gateId === 'gate-ctrl-testing-acceptance') return ['e2e', 'smoke'];
  return [];
}

function relevantGateResults(
  gateId: string,
  results: QualificationCheckResult[],
): QualificationCheckResult[] {
  if (gateId === 'gate-ctrl-testing-threat-authz-secrets') {
    return results.filter((result) => result.category === 'security'
      && result.controlIds?.includes('CTRL-TESTING-THREAT-AUTHZ-SECRETS'));
  }
  if (gateId === 'gate-ctrl-testing-supply-chain') {
    return results.filter((result) => result.category === 'security'
      && result.controlIds?.includes('CTRL-TESTING-SUPPLY-CHAIN'));
  }
  const categories = gateCategories(gateId);
  return results.filter((result) => categories.includes(result.category));
}

function requiredGateCategories(gateId: string): SoftwareQualificationCategory[] {
  if (gateId === 'gate-ctrl-testing-req-regression') return ['unit'];
  if (gateId === 'gate-ctrl-testing-quality-attributes') return ['lint', 'typecheck', 'build'];
  if (gateId === 'gate-ctrl-testing-acceptance') return ['e2e'];
  return [];
}

function evidenceClassification(phaseId: PhaseId, planClassification: string): EvidenceClassification | null {
  if (planClassification === 'approval') return null;
  if (planClassification === 'test_result') return 'testing';
  if (planClassification === 'security_finding') return 'risk_judgment';
  if (planClassification === 'code_change') return 'revision';
  if (planClassification === 'documentation') return 'documentation';
  if (planClassification === 'release_operation') return 'deployment';
  if (planClassification === 'runtime_observation') return 'completion';
  return null;
}

async function emitQualificationEvidence(input: {
  preview: PreStagingQualificationPreview;
  plan: LifecyclePlan;
  results: QualificationCheckResult[];
  requestHash: `sha256:${string}`;
  actorId: string;
  verifierReceipt: QualificationVerifierReceipt;
  client: PoolClient;
  attemptId: string;
  resultHash: `sha256:${string}`;
  receiptId: string;
  status: QualificationRow['status'];
}): Promise<{ evidenceIds: string[]; gateIds: string[]; receiptHash: `sha256:${string}` }> {
  const compiledPlanId = input.preview.compiledPlanId;
  if (!compiledPlanId) {
    throw new ConflictError('Qualification evidence requires the exact compiled plan identity');
  }
  const evidences = [];
  const gateIds: string[] = [];
  for (const gate of input.plan.gates) {
    const relevant = relevantGateResults(gate.gateId, input.results);
    if (relevant.length === 0 || gate.approvalRequirement !== 'none') continue;
    const required = requiredGateCategories(gate.gateId);
    const requiredPresent = required.every((category) => {
      if (category === 'e2e') return relevant.some((result) => result.category === 'e2e' || result.category === 'smoke');
      return relevant.some((result) => result.category === category);
    });
    const passed = relevant.every((result) => result.status === 'passed');
    if (passed && !requiredPresent) continue;
    const requirements = input.plan.evidenceRequirements.filter((requirement) => gate.evidenceRequirementIds.includes(requirement.evidenceRequirementId));
    const classification = evidenceClassification(gate.phaseId, requirements[0]?.classification ?? '');
    if (!classification) continue;
    evidences.push(createCanonicalEvidence({
      sourceType: 'staging_result',
      sourceSystem: 'rorca-pre-staging-qualification',
      sourceEventId: `${input.requestHash}:${gate.gateId}`,
      observedAt: new Date(),
      scope: {
        workspaceId: input.preview.workspaceId,
        specSlug: input.preview.specId,
        runId: input.preview.runId,
        storyId: null,
        phaseId: gate.phaseId,
        gateId: gate.gateId,
      },
      subject: { type: 'commit_sha', value: input.preview.headSha },
      phaseSubject: { type: 'commit_sha', value: input.preview.headSha },
      releaseIdentity: { commitSha: input.preview.headSha },
      classification,
      status: passed ? 'passed' : 'failed',
      trustLevel: 'host_observed',
      confidence: 1,
      excerpt: `${relevant.length} isolated ${gate.phaseId} qualification checks ${passed ? 'passed' : 'failed'} at exact HEAD ${input.preview.headSha}.`,
      rawReference: `qualification:${input.requestHash}`,
      details: {
        schemaVersion: PRE_STAGING_QUALIFICATION_RECEIPT_VERSION,
        previewHash: input.preview.previewHash,
        policyVersion: input.plan.policyVersion,
        compilerVersion: input.plan.compilerVersion,
        evidenceRequirementIds: requirements.map((requirement) => requirement.evidenceRequirementId),
        checkIds: relevant.map((result) => result.id),
        executionPrincipal: {
          id: 'rorca:pre-staging-qualification-executor',
          initiatedBy: input.actorId,
        },
        verifierPrincipal: {
          id: 'rorca:pre-staging-process-verifier',
          independentFromExecution: false,
          processSeparatedFromExecution: true,
          attribution: 'executor_supplied_material_recomputation',
          schemaVersion: input.verifierReceipt.schemaVersion,
          verifierDigest: input.verifierReceipt.verifierDigest,
          verificationHash: input.verifierReceipt.verificationHash,
        },
        checks: relevant.map((result) => ({
          id: result.id,
          category: result.category,
          status: result.status,
          stdout: { hash: result.stdoutHash, excerpt: result.stdoutExcerpt, classification: 'bounded_sanitized_process_stdout' },
          stderr: { hash: result.stderrHash, excerpt: result.stderrExcerpt, classification: 'bounded_sanitized_process_stderr' },
        })),
      },
    }));
    gateIds.push(gate.gateId);
  }
  const receiptHash = digest({
    schemaVersion: PRE_STAGING_QUALIFICATION_RECEIPT_VERSION,
    requestHash: input.requestHash,
    previewHash: input.preview.previewHash,
    headSha: input.preview.headSha,
    status: input.status,
    results: input.results,
    evidence: evidences.map((evidence) => ({
      sourceEventId: evidence.source.eventId,
      payloadHash: evidence.payloadHash,
      gateId: evidence.scope.gateId,
    })),
  });
  const persisted = await persistQualificationEvidenceBatchInTransaction(
    evidences, input.client, input.requestHash, {
      workspaceId: input.preview.workspaceId,
      attemptId: input.attemptId,
      resultHash: input.resultHash,
      previewHash: input.preview.previewHash,
      compiledPlanId,
      checkoutSha: input.preview.headSha,
      specRevisionHash: input.preview.specRevisionHash,
      receiptId: input.receiptId,
      receiptHash,
      receipt: {
        specSlug: input.preview.specId,
        previewHash: input.preview.previewHash,
        status: input.status,
        headSha: input.preview.headSha,
        specRevisionHash: input.preview.specRevisionHash,
        runId: input.preview.runId,
      },
    },
  );
  return { evidenceIds: persisted.map((item) => item.evidence.id).sort(), gateIds: gateIds.sort(), receiptHash };
}

async function findReceipt(workspaceId: string, idempotencyKey: string): Promise<QualificationRow | undefined> {
  return queryOne<QualificationRow>(`
    SELECT id, workspace_id, spec_slug, spec_revision_hash, compiled_plan_id::text,
           run_id::text, head_sha, request_hash, preview_hash, status, mechanisms,
           check_results, evidence_ids, readiness, receipt_hash, created_by, created_at
    FROM ssdlc_release_qualifications
    WHERE workspace_id = $1 AND idempotency_key = $2
  `, [workspaceId, idempotencyKey]);
}

interface QualificationRequestBinding {
  workspaceId: string;
  specId: string;
  previewHash: string;
  runId: number | null;
  actorId: string;
}

function assertReceiptBinding(
  row: QualificationRow,
  binding: QualificationRequestBinding,
  requestHash: string,
): void {
  const storedRunId = row.run_id === null ? null : Number(row.run_id);
  if (row.workspace_id !== binding.workspaceId
    || row.spec_slug !== binding.specId
    || row.preview_hash !== binding.previewHash
    || storedRunId !== binding.runId
    || row.created_by !== binding.actorId
    || row.request_hash !== requestHash) {
    throw new ConflictError('Idempotency-Key was already used for a different qualification request');
  }
}

function qualificationBinding(input: {
  workspaceId: string;
  specId: string;
  previewHash: string;
  idempotencyKey: string;
  actorId: string;
  runId?: number;
}): { binding: QualificationRequestBinding; idempotencyKey: string; requestHash: `sha256:${string}` } {
  if (!SHA256.test(input.previewHash)) throw new ValidationError('previewHash must be a lowercase sha256 digest', { field: 'previewHash' });
  if (input.runId !== undefined && (!Number.isSafeInteger(input.runId) || input.runId <= 0)) {
    throw new ValidationError('runId must be a positive integer', { field: 'runId' });
  }
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 256) throw new ValidationError('Idempotency-Key must contain 8-256 characters');
  const binding: QualificationRequestBinding = {
    workspaceId: input.workspaceId,
    specId: input.specId.trim(),
    previewHash: input.previewHash,
    runId: input.runId ?? null,
    actorId: input.actorId,
  };
  return { binding, idempotencyKey, requestHash: digest(binding) };
}

function assertAttemptBinding(row: QualificationAttemptRow, binding: QualificationRequestBinding, requestHash: string): void {
  const runId = row.run_id === null ? null : Number(row.run_id);
  if (row.workspace_id !== binding.workspaceId || row.spec_slug !== binding.specId
    || row.preview_hash !== binding.previewHash || runId !== binding.runId
    || row.actor_id !== binding.actorId || row.request_hash !== requestHash) {
    throw new ConflictError('Idempotency-Key was already used for a different qualification request');
  }
}

async function acquireQualificationAttempt(
  binding: QualificationRequestBinding,
  idempotencyKey: string,
  requestHash: string,
): Promise<{ attempt: QualificationAttemptRow; created: boolean }> {
  return transaction(async (client: PoolClient) => {
    const inserted = await client.query<QualificationAttemptRow>(`
      INSERT INTO ssdlc_qualification_attempts (
        workspace_id, spec_slug, preview_hash, run_id, actor_id, idempotency_key, request_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
      RETURNING *
    `, [binding.workspaceId, binding.specId, binding.previewHash, binding.runId,
      binding.actorId, idempotencyKey, requestHash]);
    const attempt = inserted.rows[0] ?? (await client.query<QualificationAttemptRow>(`
      SELECT * FROM ssdlc_qualification_attempts
      WHERE workspace_id = $1 AND idempotency_key = $2
      FOR UPDATE
    `, [binding.workspaceId, idempotencyKey])).rows[0];
    if (!attempt) throw new ConflictError('Qualification attempt could not be durably acquired');
    assertAttemptBinding(attempt, binding, requestHash);
    return { attempt, created: Boolean(inserted.rows[0]) };
  });
}

async function findAttempt(attemptId: string, workspaceId: string): Promise<QualificationAttemptRow | undefined> {
  return queryOne<QualificationAttemptRow>(`
    SELECT * FROM ssdlc_qualification_attempts
    WHERE id = $1 AND workspace_id = $2
  `, [attemptId, workspaceId]);
}

async function finalizeQualificationAttempt(
  attemptId: string,
  binding: QualificationRequestBinding,
  requestHash: `sha256:${string}`,
): Promise<void> {
  await canonicalTransaction(async (client: PoolClient) => {
    await client.query(`SELECT set_config('rorca.workspace_id',$1,TRUE)`, [binding.workspaceId]);
    const attempt = (await client.query<QualificationAttemptRow>(`
      SELECT * FROM ssdlc_qualification_attempts
      WHERE id = $1 AND workspace_id = $2
      FOR UPDATE
    `, [attemptId, binding.workspaceId])).rows[0];
    if (!attempt || attempt.state === 'complete') return;
    assertAttemptBinding(attempt, binding, requestHash);
    if (attempt.state !== 'results_ready' || !attempt.result_payload || !attempt.result_hash
      || digest(attempt.result_payload) !== attempt.result_hash) {
      throw new ConflictError('Qualification results-ready payload is absent or does not match its durable hash');
    }
    const resultHash = attempt.result_hash;
    const payload = attempt.result_payload as {
      schemaVersion?: unknown;
      preview?: PreStagingQualificationPreview;
      planId?: unknown;
      results?: QualificationCheckResult[];
      verifierReceipt?: QualificationVerifierReceipt;
      executionIdentity?: Record<string, unknown>;
    };
    if (payload.schemaVersion !== 'rorca.pre-staging-qualification-results.v1'
      || !payload.preview || !Array.isArray(payload.results) || !payload.verifierReceipt
      || !payload.executionIdentity || payload.preview.previewHash !== binding.previewHash
      || payload.preview.workspaceId !== binding.workspaceId || payload.preview.specId !== binding.specId
      || payload.preview.runId !== binding.runId || payload.preview.headSha !== attempt.checkout_sha) {
      throw new ConflictError('Qualification results-ready payload identity is invalid');
    }
    const exactPlan = (await client.query<PlanRow>(`
      SELECT id::text, compiler_version, plan_json, provenance_json
      FROM ssdlc_compiled_plans
      WHERE id = $1::bigint AND workspace_id = $2 AND spec_slug = $3
        AND is_current = TRUE AND validation_status = 'validated'
      FOR SHARE
    `, [payload.preview.compiledPlanId, binding.workspaceId, binding.specId])).rows[0];
    if (!exactPlan || exactPlan.compiler_version !== SSDLC_PLAN_COMPILER_VERSION
      || provenanceSpecHash(exactPlan.provenance_json) !== payload.preview.specRevisionHash) {
      throw new ConflictError('Exact compiled lifecycle plan changed before canonical qualification finalization');
    }
    const plan = LifecyclePlanSchema.parse(exactPlan.plan_json);
    if (plan.planId !== payload.planId) throw new ConflictError('Qualification results target a different compiled plan identity');
    const allPassed = payload.results.every((result) => result.status === 'passed');
    const status: QualificationRow['status'] = !allPassed ? 'failed'
      : payload.preview.missingRequiredCategories.length > 0 ? 'blocked' : 'passed';
    const receiptId = randomUUID();
    const emittedEvidence = await emitQualificationEvidence({
      preview: payload.preview, plan, results: payload.results,
      requestHash,
      actorId: binding.actorId, verifierReceipt: payload.verifierReceipt, client,
      attemptId: attempt.id, resultHash,
      receiptId, status,
    });
    const readiness = {
      allDiscoveredChecksPassed: allPassed,
      missingRequiredCategories: payload.preview.missingRequiredCategories,
      evidenceEmittedGateIds: emittedEvidence.gateIds,
      pendingGovernedGateIds: plan.gates.filter((gate) => gate.approvalRequirement !== 'none').map((gate) => gate.gateId).sort(),
      stagingAuthorityGranted: false,
      executionIdentity: payload.executionIdentity,
      rationale: status === 'passed'
        ? 'Every discovered check and required qualification category passed; governed staging approval remains separate.'
        : status === 'blocked'
          ? `Discovered checks passed, but required categories are unavailable: ${payload.preview.missingRequiredCategories.join(', ')}.`
          : 'At least one isolated qualification check failed.',
    };
    const inserted = await client.query<QualificationRow>(`
      INSERT INTO ssdlc_release_qualifications (
        id, workspace_id, spec_slug, spec_revision_hash, compiled_plan_id, run_id,
        head_sha, idempotency_key, request_hash, preview_hash, status, mechanisms,
        check_results, evidence_ids, readiness, receipt_hash, created_by
      ) VALUES ($1::uuid,$2,$3,$4,$5::bigint,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17)
      RETURNING *
    `, [
      receiptId, binding.workspaceId, payload.preview.specId, payload.preview.specRevisionHash, payload.preview.compiledPlanId,
      payload.preview.runId, payload.preview.headSha, attempt.idempotency_key, requestHash,
      payload.preview.previewHash, status, JSON.stringify(payload.preview.checks), JSON.stringify(payload.results),
      JSON.stringify(emittedEvidence.evidenceIds), JSON.stringify(readiness), emittedEvidence.receiptHash, binding.actorId,
    ]);
    await client.query(`
      UPDATE ssdlc_qualification_attempts
      SET state='complete', receipt_id=$3, completed_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE id=$1 AND workspace_id=$2 AND state='results_ready' AND result_hash=$4
    `, [attempt.id, binding.workspaceId, inserted.rows[0]!.id, resultHash]);
  });
}

async function waitForQualificationAttempt(
  attemptId: string,
  binding: QualificationRequestBinding,
  requestHash: `sha256:${string}`,
  replayed: boolean,
): Promise<PreStagingQualificationReceipt> {
  const deadline = Date.now() + QUALIFICATION_WAIT_MS;
  while (Date.now() < deadline) {
    const attempt = await findAttempt(attemptId, binding.workspaceId);
    if (!attempt) throw new ConflictError('Durable qualification attempt disappeared while awaiting completion');
    assertAttemptBinding(attempt, binding, requestHash);
    if (attempt.state === 'results_ready') {
      await finalizeQualificationAttempt(attempt.id, binding, requestHash);
      continue;
    }
    if (attempt.state === 'complete') {
      const completed = await findReceipt(binding.workspaceId, attempt.idempotency_key);
      if (!completed || completed.id !== attempt.receipt_id) throw new ConflictError('Completed qualification attempt lacks its exact receipt');
      assertReceiptBinding(completed, binding, requestHash);
      return receipt(completed, replayed);
    }
    if (attempt.state === 'blocked') {
      throw new UnprocessableError(
        attempt.error_message ?? 'Qualification was blocked before a complete isolated result was established',
        attempt.error_code ?? 'QUALIFICATION_ATTEMPT_BLOCKED',
      );
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, QUALIFICATION_POLL_MS);
    await promise;
  }
  throw new UnprocessableError('Qualification did not complete within its bounded worker lease', 'QUALIFICATION_ATTEMPT_TIMEOUT');
}

export async function runPreStagingQualification(input: {
  workspaceId: string;
  specId: string;
  previewHash: string;
  idempotencyKey: string;
  actorId: string;
  runId?: number;
}): Promise<PreStagingQualificationReceipt> {
  const { binding, idempotencyKey, requestHash } = qualificationBinding(input);
  const existing = await findReceipt(binding.workspaceId, idempotencyKey);
  if (existing) {
    assertReceiptBinding(existing, binding, requestHash);
    return receipt(existing, true);
  }
  const { attempt, created } = await acquireQualificationAttempt(binding, idempotencyKey, requestHash);
  if (attempt.state === 'pending') {
    await getBoss().send(PRE_STAGING_QUALIFICATION_QUEUE, {
      schemaVersion: 'rorca.pre-staging-qualification-job.v1',
      attemptId: attempt.id,
      workspaceId: binding.workspaceId,
    }, {
      retryLimit: 3,
      retryDelay: 30,
      expireInSeconds: Math.ceil(QUALIFICATION_LEASE_MS / 1000),
    });
  }
  return waitForQualificationAttempt(attempt.id, binding, requestHash, !created);
}

async function claimQualificationAttempt(attemptId: string, workspaceId: string): Promise<ClaimedQualificationAttempt | null> {
  return transaction(async (client: PoolClient) => {
    const row = (await client.query<QualificationAttemptRow>(`
      SELECT * FROM ssdlc_qualification_attempts
      WHERE id = $1 AND workspace_id = $2
      FOR UPDATE
    `, [attemptId, workspaceId])).rows[0];
    if (!row || row.state === 'complete' || row.state === 'blocked') return null;
    if (row.state === 'executing') {
      if (row.lease_expires_at && new Date(row.lease_expires_at).getTime() > Date.now()) return null;
      await client.query(`
        UPDATE ssdlc_qualification_attempts
        SET state = 'blocked', completed_at = clock_timestamp(), updated_at = clock_timestamp(),
            error_code = 'QUALIFICATION_STALE_LEASE',
            error_message = 'A prior qualification worker lease expired with indeterminate command side effects; replay is forbidden'
        WHERE id = $1 AND workspace_id = $2 AND state = 'executing'
      `, [attemptId, workspaceId]);
      return null;
    }
    const leaseToken = randomUUID();
    const claimed = (await client.query<QualificationAttemptRow>(`
      UPDATE ssdlc_qualification_attempts
      SET state = 'executing', lease_token = $3,
          lease_expires_at = clock_timestamp() + ($4 * interval '1 millisecond'),
          updated_at = clock_timestamp()
      WHERE id = $1 AND workspace_id = $2 AND state = 'pending'
      RETURNING *
    `, [attemptId, workspaceId, leaseToken, QUALIFICATION_LEASE_MS])).rows[0];
    return claimed ? { ...claimed, state: 'executing', lease_token: leaseToken } : null;
  });
}

async function blockQualificationAttempt(attempt: ClaimedQualificationAttempt, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
  await query(`
    UPDATE ssdlc_qualification_attempts
    SET state = 'blocked', completed_at = clock_timestamp(), updated_at = clock_timestamp(),
        error_code = 'QUALIFICATION_ISOLATION_BLOCKED', error_message = $4
    WHERE id = $1 AND workspace_id = $2 AND state = 'executing' AND lease_token = $3
  `, [attempt.id, attempt.workspace_id, attempt.lease_token, message]);
}

async function executeClaimedQualification(attempt: ClaimedQualificationAttempt): Promise<void> {
  const binding: QualificationRequestBinding = {
    workspaceId: attempt.workspace_id,
    specId: attempt.spec_slug,
    previewHash: attempt.preview_hash,
    runId: attempt.run_id === null ? null : Number(attempt.run_id),
    actorId: attempt.actor_id,
  };
  assertAttemptBinding(attempt, binding, attempt.request_hash);
  const preview = await previewPreStagingQualification({
    workspaceId: binding.workspaceId,
    specId: binding.specId,
    ...(binding.runId === null ? {} : { runId: binding.runId }),
  });
  if (preview.previewHash !== binding.previewHash || preview.specId !== binding.specId || preview.runId !== binding.runId) {
    throw new ConflictError('Pre-staging qualification preview identity changed before worker execution');
  }
  if (!preview.preconditions.canExecute) {
    throw new UnprocessableError('Pre-staging qualification cannot execute until its immutable preconditions are satisfied', 'QUALIFICATION_PRECONDITION_BLOCKED', { blockers: preview.preconditions.blockers });
  }
  const ws = await workspace(binding.workspaceId);
  const loadedPlan = await planFor(binding.workspaceId, preview.compiledPlanId);
  if (!loadedPlan || loadedPlan.specRevisionHash !== preview.specRevisionHash
    || loadedPlan.compilerVersion !== SSDLC_PLAN_COMPILER_VERSION
    || loadedPlan.plan.compilerVersion !== SSDLC_PLAN_COMPILER_VERSION) {
    throw new ConflictError('Exact compiled lifecycle plan identity changed before qualification worker execution');
  }
  const worktree = await addWorktree(ws.path, preview.headSha);
  const results: QualificationCheckResult[] = [];
  let sandbox: QualificationSandboxIdentity | null = null;
  try {
    const exactChecks = await rediscoverExactChecks(worktree.path, preview.checks);
    const dependencyDigest = await qualificationDependencyDigest(
      worktree.path,
      exactChecks.flatMap((check) => check.discoveredFrom),
    );
    sandbox = await loadQualificationSandboxIdentity({ checkoutRoot: worktree.path, dependencyDigest });
    const identityUpdate = await query<{ id: string }>(`
      UPDATE ssdlc_qualification_attempts
      SET checkout_sha = $4, toolchain_digest = $5, dependency_digest = $6,
          sandbox_digest = $7, updated_at = clock_timestamp()
      WHERE id = $1 AND workspace_id = $2 AND state = 'executing' AND lease_token = $3
      RETURNING id
    `, [attempt.id, attempt.workspace_id, attempt.lease_token, preview.headSha,
      sandbox.toolchainDigest, sandbox.dependencyDigest, sandbox.sandboxDigest]);
    if (identityUpdate.length !== 1) throw new ConflictError('Qualification worker lost its durable lease before command execution');
    for (const check of exactChecks) {
      results.push(await executeCheck(check, worktree.path, sandbox, preview.runId ?? 1));
    }
  } finally {
    await removeWorktree(ws.path, worktree);
  }
  const establishedSandbox = sandbox;
  if (!establishedSandbox) throw new ConflictError('Qualification sandbox identity was not established');
  const verifierReceipt = await independentlyVerifyQualificationResults(results);
  const resultPayload = {
    schemaVersion: 'rorca.pre-staging-qualification-results.v1',
    preview,
    planId: loadedPlan.plan.planId,
    results,
    verifierReceipt,
    executionIdentity: {
      checkoutSha: preview.headSha,
      toolchainDigest: establishedSandbox.toolchainDigest,
      dependencyDigest: establishedSandbox.dependencyDigest,
      sandboxDigest: establishedSandbox.sandboxDigest,
      sandboxMode: establishedSandbox.mode,
      networkAccess: 'denied',
      credentialAccess: 'denied',
    },
  };
  const resultHash = digest(resultPayload);
  const staged = await query<{ id: string }>(`
    UPDATE ssdlc_qualification_attempts
    SET state = 'results_ready', result_payload = $4::jsonb, result_hash = $5,
        updated_at = clock_timestamp()
    WHERE id = $1 AND workspace_id = $2 AND lease_token = $3 AND state = 'executing'
      AND lease_expires_at > clock_timestamp()
    RETURNING id
  `, [attempt.id, attempt.workspace_id, attempt.lease_token, JSON.stringify(resultPayload), resultHash]);
  if (staged.length !== 1) throw new ConflictError('Qualification worker lost its lease before staging immutable results');
}

export async function executePreStagingQualificationAttempt(attemptId: string, workspaceId: string): Promise<void> {
  if (process.env.NODE_ENV !== 'test' && process.env.RORCA_PROCESS_ROLE !== 'worker') {
    throw new ValidationError('Qualification command execution requires worker process authority');
  }
  if (!/^[0-9a-f-]{36}$/i.test(attemptId) || !workspaceId.trim()) throw new ValidationError('Qualification job identity is invalid');
  const claimed = await claimQualificationAttempt(attemptId, workspaceId);
  if (!claimed) return;
  try {
    await executeClaimedQualification(claimed);
  } catch (error) {
    await blockQualificationAttempt(claimed, error);
  }
}

export async function registerPreStagingQualificationWorker(boss: PgBoss): Promise<void> {
  await boss.work(PRE_STAGING_QUALIFICATION_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const payload = job.data as { schemaVersion?: unknown; attemptId?: unknown; workspaceId?: unknown };
      if (payload.schemaVersion !== 'rorca.pre-staging-qualification-job.v1'
        || typeof payload.attemptId !== 'string' || typeof payload.workspaceId !== 'string') continue;
      await executePreStagingQualificationAttempt(payload.attemptId, payload.workspaceId);
    }
  });
}

export async function listPreStagingQualifications(input: {
  workspaceId: string;
  specId: string;
  limit?: number;
}): Promise<PreStagingQualificationReceipt[]> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const rows = await query<QualificationRow>(`
    SELECT id, workspace_id, spec_slug, spec_revision_hash, compiled_plan_id::text,
           run_id::text, head_sha, request_hash, preview_hash, status, mechanisms,
           check_results, evidence_ids, readiness, receipt_hash, created_by, created_at
    FROM ssdlc_release_qualifications
    WHERE workspace_id = $1 AND spec_slug = $2
    ORDER BY created_at DESC, id DESC
    LIMIT $3
  `, [input.workspaceId, input.specId, limit]);
  return rows.map((row) => receipt(row, false));
}
