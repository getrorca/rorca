import { hermesServiceEmail } from './auth-utils';
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { query, queryOne, transaction } from '../db/index';
import {
  AuthError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from './errors';
import { redactSecrets } from './context-safety';
import { retryHash } from './retry-governance';
import { pipelineRunQueueForPayload } from './dispatch-publication';
import {
  assertLifecycleDispatchClaim,
  type LifecycleDispatchClaim,
} from './lifecycle-dispatch-claim';
import {
  deriveStoryExecutionManifestHash,
  verifyStoryExecutionManifest,
  type StoryExecutionManifest,
} from './story-execution-packet';
import {
  verifyStoryAttemptResult,
  verifyStoryCloseoutDecision,
  type StoryAttemptResult,
  type StoryCloseoutDecision,
  type StoryManifest,
} from './story-closeout';

export const CAMPAIGN_DISPATCH_AUTHORIZATION_VERSION = 'hermes.campaign-dispatch-authorization.v1' as const;
export const CAMPAIGN_DISPATCH_CONSUMPTION_VERSION = 'rorca.campaign-dispatch-consumption.v1' as const;
export const CAMPAIGN_COMPLETION_VALIDATION_VERSION = 'rorca.provider-neutral-completion.v1' as const;

const boundedId = z.string().trim().min(1).max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]*$/);
const fullSha = z.string().regex(/^[0-9a-f]{40}$/);
const bareSha256 = z.string().regex(/^[0-9a-f]{64}$/);
const prefixedSha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const issue = z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/);
const isoTimestamp = z.string().datetime();
const decisionType = z.enum(['gate_override', 'qa_approval', 'merge_approval', 'production_approval']);
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const CAMPAIGN_AUTHORIZATION_MAX_AGE_MS = 120_000;
const CAMPAIGN_CLOCK_SKEW_MS = 5_000;

export const CampaignArmApprovalSchema = z.object({
  receiptId: boundedId,
  decisionId: boundedId,
  operatorId: boundedId,
  campaignId: boundedId,
  manifestHash: bareSha256,
  workspaceId: boundedId,
  specId: boundedId,
  specRevision: boundedId,
  phaseId: boundedId,
  gateId: boundedId,
  decisionType,
  expiresAt: isoTimestamp,
}).strict();

export const CampaignGateEnvelopeSchema = z.object({
  status: z.literal('accepted'),
  workspaceId: boundedId,
  specId: boundedId,
  specRevision: boundedId,
  sha: fullSha,
  gateId: boundedId,
  phaseId: boundedId,
  decisionType,
  decisionId: boundedId,
  signer: boundedId,
  expiresAt: isoTimestamp,
}).strict();

export const CampaignLinearEnvelopeSchema = z.object({
  status: z.literal('accepted'),
  issue,
  state: boundedId,
  approvalLabel: boundedId,
  updatedAt: isoTimestamp,
  workspaceId: boundedId,
  sourceRef: z.string().url().max(512),
}).strict();

export const CampaignGitProofSchema = z.object({
  sha: fullSha,
  repository,
  remoteHost: z.literal('github.com'),
  remoteUrl: z.string().min(1).max(512),
  clean: z.literal(true),
  detached: z.boolean(),
  root: z.string().min(1).max(1024),
  observedAt: isoTimestamp,
}).strict();

export const CampaignWorkspaceProofSchema = z.object({
  workspaceId: boundedId,
  repository,
  repositoryHost: z.literal('github.com'),
  source: z.literal('github-app-installation'),
  repositoryId: boundedId,
  bindingId: boundedId,
  observedAt: isoTimestamp,
}).strict();

export const CampaignDispatchAuthorizationSchema = z.object({
  schemaVersion: z.literal(CAMPAIGN_DISPATCH_AUTHORIZATION_VERSION),
  authorizationHash: bareSha256,
  manifestHash: bareSha256,
  campaignId: boundedId,
  waveId: boundedId,
  workspaceId: boundedId,
  repository,
  repositoryHost: z.literal('github.com'),
  sha: fullSha,
  specId: boundedId,
  specRevision: boundedId,
  storyId: issue,
  attemptFence: z.string().uuid(),
  idempotencyKey: boundedId,
  arm: CampaignArmApprovalSchema,
  gate: CampaignGateEnvelopeSchema,
  linear: z.array(CampaignLinearEnvelopeSchema).max(32),
  git: CampaignGitProofSchema,
  workspace: CampaignWorkspaceProofSchema,
  pauseFileAbsent: z.literal(true),
  issuedAt: isoTimestamp,
  expiresAt: isoTimestamp,
}).strict().superRefine((authorization, ctx) => {
  const issuedAt = Date.parse(authorization.issuedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  if (expiresAt <= issuedAt) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'expiresAt must be later than issuedAt' });
  }
  if (expiresAt > Date.parse(authorization.arm.expiresAt)
    || expiresAt > Date.parse(authorization.gate.expiresAt)) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'authorization cannot outlive arm or wave authority' });
  }
  const linearIssues = new Set<string>();
  authorization.linear.forEach((entry, index) => {
    if (linearIssues.has(entry.issue)) {
      ctx.addIssue({ code: 'custom', path: ['linear', index, 'issue'], message: 'Linear issue authority must be unique' });
    }
    linearIssues.add(entry.issue);
    try {
      const url = new URL(entry.sourceRef);
      if (url.protocol !== 'https:' || !/(^|\.)linear\.app$/i.test(url.hostname)
        || url.username || url.password || url.search || url.hash) {
        ctx.addIssue({ code: 'custom', path: ['linear', index, 'sourceRef'], message: 'Linear authority must use a credential-free linear.app HTTPS URL' });
      }
    } catch {
      ctx.addIssue({ code: 'custom', path: ['linear', index, 'sourceRef'], message: 'Linear authority URL is invalid' });
    }
  });
});

export type CampaignArmApproval = z.infer<typeof CampaignArmApprovalSchema>;
export type CampaignGateEnvelope = z.infer<typeof CampaignGateEnvelopeSchema>;
export type CampaignLinearEnvelope = z.infer<typeof CampaignLinearEnvelopeSchema>;
export type CampaignGitProof = z.infer<typeof CampaignGitProofSchema>;
export type CampaignWorkspaceProof = z.infer<typeof CampaignWorkspaceProofSchema>;
export type CampaignDispatchAuthorization = z.infer<typeof CampaignDispatchAuthorizationSchema>;

export interface CampaignExecutionIdentity {
  manifestHash: string;
  runId: number;
  attempt: number;
  agent: 'claude' | 'opencode' | 'codex' | 'pi' | 'omp';
  baseRevision: string;
  specRevision: string;
  storyRevision: string;
}

export interface CampaignDispatchConsumptionProjection {
  schemaVersion: typeof CAMPAIGN_DISPATCH_CONSUMPTION_VERSION;
  authorizationHash: string;
  requestHash: string;
  runId: number;
  workspaceId: string;
  campaignId: string;
  waveId: string;
  specId: string;
  specRevision: string;
  storyId: string;
  attemptFence: string;
  idempotencyKey: string;
  repositoryHost: 'github.com';
  repository: string;
  repositoryBindingId: string;
  baseRevision: string;
  armDecisionId: string;
  gateDecisionId: string;
  controlGeneration: number;
  consumedAt: string;
  expiresAt: string;
  state: 'consumed';
  execution: CampaignExecutionIdentity[];
}

export interface CampaignPreparedPublication {
  bossJobId: string;
  payloadHash: string;
  consumption: CampaignDispatchConsumptionProjection;
}

export interface ProviderNeutralCompletionValidation {
  schemaVersion: typeof CAMPAIGN_COMPLETION_VALIDATION_VERSION;
  validationId: string;
  status: 'validated';
  runId: number;
  workspaceId: string;
  specId: string;
  storyId: string;
  attempt: number;
  agent: 'claude' | 'opencode' | 'codex' | 'pi' | 'omp';
  baseRevision: string;
  manifestHash: string;
  attemptResultId: string;
  closeoutDecisionId: string;
  commitSha: string;
  resultProvenance: 'host';
  resultSource: 'execution-engine';
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function campaignDispatchAuthorizationHash(
  authorization: Omit<CampaignDispatchAuthorization, 'authorizationHash'>,
): string {
  return crypto.createHash('sha256').update(canonical(authorization), 'utf8').digest('hex');
}

export function buildProviderNeutralCompletionValidation(input: {
  runId: number;
  workspaceId: string;
  story: {
    storyId: string;
    status: string;
    resultProvenance: unknown;
    resultSource: unknown;
    integrated: unknown;
    commitSha: unknown;
  };
  manifest: StoryManifest;
  attempt: StoryAttemptResult;
  closeout: StoryCloseoutDecision;
}): ProviderNeutralCompletionValidation | null {
  const { manifest, attempt, closeout, story } = input;
  if (!verifyStoryExecutionManifest(manifest)
    || !verifyStoryAttemptResult(attempt)
    || !verifyStoryCloseoutDecision(closeout)
    || manifest.identity.runId !== input.runId
    || manifest.identity.workspaceId !== input.workspaceId
    || manifest.identity.storyId !== story.storyId
    || attempt.identity.runId !== input.runId
    || attempt.identity.workspaceId !== input.workspaceId
    || attempt.identity.specId !== manifest.identity.specId
    || attempt.identity.storyId !== story.storyId
    || attempt.identity.attempt !== manifest.identity.attempt
    || attempt.revisions.specRevision !== manifest.revisions.specRevision
    || attempt.revisions.storyRevision !== manifest.revisions.storyRevision
    || attempt.manifestHash !== manifest.manifestHash
    || attempt.agentProcess.agent !== manifest.execution.agent
    || closeout.status !== 'accepted'
    || !closeout.reasonCodes.includes('ACCEPTED')
    || story.status !== 'pass'
    || story.resultProvenance !== 'host'
    || story.resultSource !== 'execution-engine'
    || story.integrated !== true
    || typeof story.commitSha !== 'string'
    || !fullSha.safeParse(story.commitSha).success
    || closeout.activeSubjectRevision.commitSha !== story.commitSha) return null;
  const body = {
    schemaVersion: CAMPAIGN_COMPLETION_VALIDATION_VERSION,
    status: 'validated' as const,
    runId: input.runId,
    workspaceId: input.workspaceId,
    specId: manifest.identity.specId,
    storyId: manifest.identity.storyId,
    attempt: manifest.identity.attempt,
    agent: manifest.execution.agent,
    baseRevision: manifest.execution.worktree.baseRevision,
    manifestHash: manifest.manifestHash,
    attemptResultId: attempt.attemptResultId,
    closeoutDecisionId: closeout.decisionId,
    commitSha: story.commitSha,
    resultProvenance: 'host' as const,
    resultSource: 'execution-engine' as const,
  };
  return { ...body, validationId: retryHash(body) };
}

export function parseCampaignDispatchAuthorization(value: unknown): CampaignDispatchAuthorization {
  const parsed = CampaignDispatchAuthorizationSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError('Invalid campaign dispatch authorization', {
      code: 'CAMPAIGN_AUTHORIZATION_INVALID',
      issues: parsed.error.issues.map((item) => ({ path: item.path.join('.'), message: item.message })),
    });
  }
  const { authorizationHash, ...body } = parsed.data;
  if (campaignDispatchAuthorizationHash(body) !== authorizationHash) {
    throw new ConflictError('Campaign dispatch authorization hash does not match its canonical body', {
      code: 'CAMPAIGN_AUTHORIZATION_HASH_MISMATCH',
    });
  }
  assertCredentialFreeGitRemote(parsed.data.git.remoteUrl, parsed.data.repository);
  return parsed.data;
}

function assertCredentialFreeGitRemote(remote: string, expectedRepository: string): void {
  const value = remote.trim().replace(/\.git$/, '');
  const ssh = value.match(/^[^@\s]+@([^:\s]+):([^\s]+\/[^\s]+)$/);
  if (ssh) {
    if (ssh[1].toLowerCase() !== 'github.com' || ssh[2] !== expectedRepository) {
      throw new ValidationError('Campaign Git remote does not match the authorized GitHub repository');
    }
    return;
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new ValidationError('Campaign Git remote must be a credential-free GitHub URL'); }
  const actualRepository = url.pathname.replace(/^\//, '');
  if (!['https:', 'ssh:'].includes(url.protocol) || url.hostname.toLowerCase() !== 'github.com'
    || url.username || url.password || url.search || url.hash || actualRepository !== expectedRepository) {
    throw new ValidationError('Campaign Git remote must be credential-free and match the authorized GitHub repository');
  }
}

export function assertCampaignTriggerBinding(input: {
  authorization: CampaignDispatchAuthorization;
  workspaceId: string;
  specPath: string;
  storyId?: string;
  idempotencyKey?: string;
  requestHash: string;
  dryRun?: boolean;
  autoWorktree?: boolean;
  autoMerge?: boolean;
  mergeStrategy?: string;
  triggerType?: string;
  orchestrationMode?: string;
  parallelism?: number;
  forceSequential?: boolean;
  executionEnvironment?: string;
  readinessOverrideRequested?: boolean;
}): void {
  const auth = input.authorization;
  const expectedSpecPath = `forge/specs/approved/${auth.specId}.json`;
  if (String(input.workspaceId) !== auth.workspaceId || input.specPath !== expectedSpecPath
    || input.storyId !== auth.storyId || input.idempotencyKey !== auth.idempotencyKey) {
    throw new ConflictError('Campaign authorization does not bind the exact ordinary trigger identity', {
      code: 'CAMPAIGN_TRIGGER_IDENTITY_MISMATCH',
    });
  }
  if (input.readinessOverrideRequested) {
    throw new ForbiddenError('Campaign dispatch never permits a readiness override');
  }
  if (input.autoWorktree !== true || input.autoMerge !== false || input.mergeStrategy !== 'branch-only'
    || input.triggerType !== 'manual' || input.orchestrationMode !== 'sequential'
    || input.parallelism !== 1 || input.forceSequential !== true
    || input.executionEnvironment !== 'remote-rorca') {
    throw new ForbiddenError('Campaign dispatch requires one host-worktree story with sequential branch-only execution');
  }
  if (auth.arm.workspaceId !== auth.workspaceId || auth.arm.campaignId !== auth.campaignId
    || auth.arm.manifestHash !== auth.manifestHash || auth.arm.receiptId !== auth.arm.decisionId
    || auth.gate.workspaceId !== auth.workspaceId || auth.gate.specId !== auth.specId
    || auth.gate.specRevision !== auth.specRevision || auth.gate.sha !== auth.sha
    || auth.git.sha !== auth.sha || auth.git.repository !== auth.repository
    || auth.workspace.workspaceId !== auth.workspaceId || auth.workspace.repository !== auth.repository
    || auth.workspace.repositoryHost !== auth.repositoryHost) {
    throw new ConflictError('Campaign authorization contains contradictory authority envelopes', {
      code: 'CAMPAIGN_AUTHORITY_ENVELOPE_MISMATCH',
    });
  }
  if (!prefixedSha256.safeParse(input.requestHash).success) {
    throw new ValidationError('Campaign trigger request hash is invalid');
  }
}

interface DecisionRow {
  id: string;
  workspace_id: string;
  spec_slug: string;
  spec_version: string | null;
  phase_id: string;
  gate_id: string | null;
  decision_type: string;
  subject_type: string | null;
  subject_value: string | null;
  principal_id: string;
  policy_authorized: boolean;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
}

interface BindingRow {
  binding_id: string;
  repository_id: string | number;
  repo_owner: string;
  repo_name: string;
  binding_status: string;
  registration_status: string;
  installation_status: string;
  superseded_at: Date | string | null;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function decisionMatches(row: DecisionRow | undefined, expected: {
  id: string;
  workspaceId: string;
  specId: string;
  specRevision: string;
  phaseId: string;
  gateId: string;
  decisionType: string;
  subjectType: 'artifact_digest' | 'commit_sha';
  subjectValue: string;
  principalId: string;
  expiresAt: string;
}, now = Date.now()): boolean {
  if (!row || String(row.id) !== expected.id || row.workspace_id !== expected.workspaceId
    || row.spec_slug !== expected.specId || row.spec_version !== expected.specRevision
    || row.phase_id !== expected.phaseId || row.gate_id !== expected.gateId
    || row.decision_type !== expected.decisionType || row.subject_type !== expected.subjectType
    || row.subject_value !== expected.subjectValue || row.principal_id !== expected.principalId
    || row.policy_authorized !== true || row.revoked_at !== null || row.expires_at === null) return false;
  const expiresAt = iso(row.expires_at);
  return expiresAt === expected.expiresAt && Date.parse(expiresAt) > now;
}

async function loadDecisions(client: PoolClient | null, authorization: CampaignDispatchAuthorization): Promise<{ arm: DecisionRow | undefined; gate: DecisionRow | undefined }> {
  const queryText = `SELECT id::text, workspace_id, spec_slug, spec_version, phase_id, gate_id,
                            decision_type, subject_type, subject_value, principal_id,
                            policy_authorized, expires_at, revoked_at
                       FROM ssdlc_decisions
                      WHERE workspace_id = $1 AND id = ANY($2::bigint[])
                      ORDER BY id${client ? ' FOR UPDATE' : ''}`;
  const ids = [authorization.arm.decisionId, authorization.gate.decisionId];
  if (ids.some((value) => !/^[1-9][0-9]*$/.test(value))) {
    throw new ValidationError('Campaign lifecycle decision identities must be canonical numeric Rorca IDs');
  }
  const rows = client
    ? (await client.query<DecisionRow>(queryText, [authorization.workspaceId, ids])).rows
    : await query<DecisionRow>(queryText, [authorization.workspaceId, ids]);
  return {
    arm: rows.find((row) => String(row.id) === authorization.arm.decisionId),
    gate: rows.find((row) => String(row.id) === authorization.gate.decisionId),
  };
}

async function loadBinding(client: PoolClient | null, workspaceId: string): Promise<BindingRow | undefined> {
  const sql = `SELECT binding.id::text AS binding_id, binding.repository_id,
                      binding.repo_owner, binding.repo_name, binding.status AS binding_status,
                      registration.status AS registration_status,
                      installation.status AS installation_status, binding.superseded_at
                 FROM github_app_workspace_bindings binding
                 JOIN github_app_registrations registration ON registration.id = binding.registration_id
                 JOIN github_app_installations installation
                   ON installation.id = binding.installation_record_id
                  AND installation.registration_id = binding.registration_id
                  AND installation.installation_id = binding.installation_id
                WHERE binding.workspace_id = $1 AND binding.superseded_at IS NULL${client ? ' FOR UPDATE OF binding, registration, installation' : ''}`;
  if (client) return (await client.query<BindingRow>(sql, [workspaceId])).rows[0];
  return queryOne<BindingRow>(sql, [workspaceId]);
}

function assertCanonicalAuthorities(
  authorization: CampaignDispatchAuthorization,
  decisions: { arm: DecisionRow | undefined; gate: DecisionRow | undefined },
  binding: BindingRow | undefined,
  now = Date.now(),
): asserts binding is BindingRow {
  if (!decisionMatches(decisions.arm, {
    id: authorization.arm.decisionId,
    workspaceId: authorization.workspaceId,
    specId: authorization.arm.specId,
    specRevision: authorization.arm.specRevision,
    phaseId: authorization.arm.phaseId,
    gateId: authorization.arm.gateId,
    decisionType: authorization.arm.decisionType,
    subjectType: 'artifact_digest',
    subjectValue: `sha256:${authorization.manifestHash}`,
    principalId: authorization.arm.operatorId,
    expiresAt: authorization.arm.expiresAt,
  }, now)) {
    throw new ForbiddenError('Campaign arm authority is absent, expired, revoked, changed, or stale');
  }
  if (!decisionMatches(decisions.gate, {
    id: authorization.gate.decisionId,
    workspaceId: authorization.workspaceId,
    specId: authorization.specId,
    specRevision: authorization.specRevision,
    phaseId: authorization.gate.phaseId,
    gateId: authorization.gate.gateId,
    decisionType: authorization.gate.decisionType,
    subjectType: 'commit_sha',
    subjectValue: authorization.sha,
    principalId: authorization.gate.signer,
    expiresAt: authorization.gate.expiresAt,
  }, now)) {
    throw new ForbiddenError('Campaign wave authority is absent, expired, revoked, changed, or stale');
  }
  if (!binding || binding.binding_id !== authorization.workspace.bindingId
    || String(binding.repository_id) !== authorization.workspace.repositoryId
    || `${binding.repo_owner}/${binding.repo_name}` !== authorization.repository
    || binding.binding_status !== 'active' || binding.registration_status !== 'active'
    || binding.installation_status !== 'active' || binding.superseded_at !== null) {
    throw new ForbiddenError('Campaign repository authority is absent, changed, disabled, or stale');
  }
  const issuedAt = Date.parse(authorization.issuedAt);
  const gitObservedAt = Date.parse(authorization.git.observedAt);
  if (Date.parse(authorization.expiresAt) <= now) {
    throw new ForbiddenError('Campaign dispatch authorization expired before consumption');
  }
  if (issuedAt > now + CAMPAIGN_CLOCK_SKEW_MS
    || now - issuedAt > CAMPAIGN_AUTHORIZATION_MAX_AGE_MS
    || gitObservedAt > issuedAt + CAMPAIGN_CLOCK_SKEW_MS
    || issuedAt - gitObservedAt > CAMPAIGN_AUTHORIZATION_MAX_AGE_MS) {
    throw new ForbiddenError('Campaign dispatch authorization or Git proof is stale or future-dated');
  }
}

function gitText(workspacePath: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: workspacePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      maxBuffer: 128 * 1024,
    }).trim();
  } catch {
    throw new UnprocessableError('Canonical campaign repository state is unavailable', 'CAMPAIGN_GIT_AUTHORITY_UNAVAILABLE');
  }
}

/**
 * Early fail-closed check before trigger worktree/hook side effects. The exact
 * same DB authorities are locked and revalidated at the consumption boundary.
 */
export async function preflightCampaignDispatchAuthorization(input: {
  authorization: CampaignDispatchAuthorization;
  workspacePath: string;
}): Promise<void> {
  const [decisions, binding] = await Promise.all([
    loadDecisions(null, input.authorization),
    loadBinding(null, input.authorization.workspaceId),
  ]);
  assertCanonicalAuthorities(input.authorization, decisions, binding);

  const head = gitText(input.workspacePath, ['rev-parse', 'HEAD']);
  const status = gitText(input.workspacePath, ['status', '--porcelain=v1', '--untracked-files=all']);
  const remote = gitText(input.workspacePath, ['remote', 'get-url', 'origin']);
  if (head !== input.authorization.sha || status !== '') {
    throw new ConflictError('Rorca workspace checkout is dirty or differs from the campaign base revision');
  }
  assertCredentialFreeGitRemote(remote, input.authorization.repository);
  const root = path.resolve(gitText(input.workspacePath, ['rev-parse', '--show-toplevel']));
  if (root !== path.resolve(input.workspacePath)) {
    throw new ConflictError('Rorca workspace path does not own the authorized repository root');
  }
}

function parseManifest(value: unknown): StoryExecutionManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConflictError('Campaign run has a malformed frozen execution manifest');
  }
  return value as StoryExecutionManifest;
}

function validateExecutionManifests(
  payloads: unknown[],
  authorization: CampaignDispatchAuthorization,
  runId: number,
): CampaignExecutionIdentity[] {
  if (payloads.length !== 1) {
    throw new ConflictError('Campaign dispatch requires exactly one frozen execution manifest');
  }
  return payloads.map((value) => {
    const manifest = parseManifest(value);
    if (deriveStoryExecutionManifestHash(manifest) !== manifest.manifestHash
      || manifest.identity.workspaceId !== authorization.workspaceId
      || manifest.identity.specId !== authorization.specId
      || manifest.identity.storyId !== authorization.storyId
      || manifest.identity.runId !== runId
      || !Number.isSafeInteger(manifest.identity.attempt) || manifest.identity.attempt <= 0
      || manifest.revisions.specRevision !== authorization.specRevision
      || manifest.execution.worktree.baseRevision !== authorization.sha
      || manifest.execution.worktree.enabled !== true
      || manifest.execution.merge.enabled !== false
      || manifest.execution.merge.strategy !== 'branch-only'
      || !['claude', 'opencode', 'codex', 'pi', 'omp'].includes(manifest.execution.agent)) {
      throw new ConflictError('Frozen execution manifest contradicts campaign dispatch authority');
    }
    return {
      manifestHash: manifest.manifestHash,
      runId,
      attempt: manifest.identity.attempt,
      agent: manifest.execution.agent,
      baseRevision: manifest.execution.worktree.baseRevision,
      specRevision: manifest.revisions.specRevision,
      storyRevision: manifest.revisions.storyRevision,
    };
  });
}

function safeSnapshot(authorization: CampaignDispatchAuthorization, execution: CampaignExecutionIdentity[]): Record<string, unknown> {
  return {
    schemaVersion: CAMPAIGN_DISPATCH_AUTHORIZATION_VERSION,
    authorizationHash: authorization.authorizationHash,
    manifestHash: authorization.manifestHash,
    campaignId: authorization.campaignId,
    waveId: authorization.waveId,
    workspaceId: authorization.workspaceId,
    repository: authorization.repository,
    repositoryHost: authorization.repositoryHost,
    sha: authorization.sha,
    specId: authorization.specId,
    specRevision: authorization.specRevision,
    storyId: authorization.storyId,
    attemptFence: authorization.attemptFence,
    idempotencyKey: authorization.idempotencyKey,
    armDecisionId: authorization.arm.decisionId,
    gateDecisionId: authorization.gate.decisionId,
    linear: authorization.linear.map((entry) => ({
      issue: entry.issue,
      state: entry.state,
      approvalLabel: entry.approvalLabel,
      updatedAt: entry.updatedAt,
      workspaceId: entry.workspaceId,
    })),
    git: { sha: authorization.git.sha, repository: authorization.git.repository, remoteHost: authorization.git.remoteHost, clean: true, observedAt: authorization.git.observedAt },
    workspace: { bindingId: authorization.workspace.bindingId, repositoryId: authorization.workspace.repositoryId, observedAt: authorization.workspace.observedAt },
    issuedAt: authorization.issuedAt,
    expiresAt: authorization.expiresAt,
    execution,
  };
}

/**
 * The application-owned outbox and campaign authorization are committed in one
 * SERIALIZABLE transaction. pg-boss publication happens only after this returns.
 */
export async function prepareCampaignDispatchPublication(input: {
  authorization: CampaignDispatchAuthorization;
  runId: number;
  owner: string;
  requestHash: string;
  effectiveOptionsHash: string;
  payload: Record<string, unknown>;
  lifecycleDispatchClaim?: LifecycleDispatchClaim;
}): Promise<CampaignPreparedPublication> {
  const payloadHash = retryHash(input.payload);
  const queueName = pipelineRunQueueForPayload(input.payload);
  return transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `campaign-dispatch:${input.authorization.workspaceId}:${input.authorization.campaignId}`,
    ]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `campaign-dispatch-idempotency:${input.authorization.workspaceId}:${input.authorization.idempotencyKey}`,
    ]);
    if (input.lifecycleDispatchClaim) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        [input.lifecycleDispatchClaim.workspaceId, input.lifecycleDispatchClaim.specId],
      );
      await assertLifecycleDispatchClaim(input.lifecycleDispatchClaim, client);
    }

    await client.query(
      `INSERT INTO campaign_dispatch_controls
         (workspace_id, campaign_id, generation, state, reason, updated_by, idempotency_key)
       VALUES ($1, $2, 0, 'active', 'initial_authority', 'rorca', $3)
       ON CONFLICT (workspace_id, campaign_id) DO NOTHING`,
      [input.authorization.workspaceId, input.authorization.campaignId, `initial:${input.authorization.campaignId}`],
    );
    const control = (await client.query<{ generation: string | number; state: string; db_now: Date | string }>(
      `SELECT generation, state, NOW() AS db_now FROM campaign_dispatch_controls
        WHERE workspace_id = $1 AND campaign_id = $2 FOR UPDATE`,
      [input.authorization.workspaceId, input.authorization.campaignId],
    )).rows[0];
    if (!control || control.state !== 'active') {
      throw new ForbiddenError('Campaign dispatch is fenced by the canonical Rorca pause control');
    }

    const decisions = await loadDecisions(client, input.authorization);
    const binding = await loadBinding(client, input.authorization.workspaceId);
    assertCanonicalAuthorities(input.authorization, decisions, binding, new Date(control.db_now).getTime());

    const run = (await client.query<{
      id: number;
      workspace_id: string;
      spec_path: string;
      status: string;
      idempotency_key: string | null;
      dispatch_request_hash: string | null;
      expected_story_ids: string[] | null;
      agent_type: string | null;
      auto_worktree: boolean;
      auto_merge: boolean;
      merge_strategy: string | null;
      orchestration_mode: string | null;
      parallelism: number;
      campaign_dispatch_authorization_hash: string | null;
    }>(`SELECT id, workspace_id, spec_path, status, idempotency_key, dispatch_request_hash,
               expected_story_ids, agent_type, auto_worktree, auto_merge, merge_strategy,
               orchestration_mode, parallelism, campaign_dispatch_authorization_hash
          FROM pipeline_runs WHERE id = $1 FOR UPDATE`, [input.runId])).rows[0];
    if (!run || run.workspace_id !== input.authorization.workspaceId || run.status !== 'queued'
      || run.spec_path !== `forge/specs/approved/${input.authorization.specId}.json`
      || run.idempotency_key !== input.authorization.idempotencyKey
      || run.dispatch_request_hash !== input.requestHash
      || run.auto_worktree !== true || run.auto_merge !== false || run.merge_strategy !== 'branch-only'
      || run.orchestration_mode !== 'sequential' || Number(run.parallelism) !== 1
      || !run.expected_story_ids || run.expected_story_ids.length !== 1
      || run.expected_story_ids[0] !== input.authorization.storyId) {
      throw new ConflictError('Canonical run row contradicts campaign dispatch authority');
    }
    if (run.campaign_dispatch_authorization_hash
      && run.campaign_dispatch_authorization_hash !== input.authorization.authorizationHash) {
      throw new ConflictError('Canonical run is already bound to a different campaign authorization');
    }

    const manifestRows = (await client.query<{ payload: unknown }>(
      `SELECT payload FROM story_execution_manifests
        WHERE workspace_id = $1 AND spec_id = $2 AND run_id = $3 AND story_id = $4
        ORDER BY attempt`,
      [input.authorization.workspaceId, input.authorization.specId, input.runId, input.authorization.storyId],
    )).rows;
    const execution = validateExecutionManifests(manifestRows.map((row) => row.payload), input.authorization, input.runId);

    const publication = (await client.query<{
      boss_job_id: string;
      state: string;
      lease_owner: string | null;
      lease_expires_at: Date | string | null;
      request_hash: string | null;
      effective_options_hash: string | null;
    }>(`SELECT boss_job_id::text, state, lease_owner, lease_expires_at,
               request_hash, effective_options_hash
          FROM pipeline_dispatch_publications WHERE run_id = $1 FOR UPDATE`, [input.runId])).rows[0];
    if (!publication || publication.state !== 'preparing' || publication.lease_owner !== input.owner
      || !publication.lease_expires_at
      || new Date(publication.lease_expires_at).getTime() <= new Date(control.db_now).getTime()
      || (publication.request_hash && publication.request_hash !== input.requestHash)
      || (publication.effective_options_hash && publication.effective_options_hash !== input.effectiveOptionsHash)) {
      throw new ConflictError('Campaign dispatch lost its application outbox publication lease');
    }

    const existing = (await client.query<{
      authorization_hash: string;
      run_id: number;
      request_hash: string;
      idempotency_key: string;
      consumed_at: Date | string;
      expires_at: Date | string;
      control_generation: string | number;
      payload_snapshot: Record<string, unknown>;
    }>(`SELECT authorization_hash, run_id, request_hash, idempotency_key,
               consumed_at, expires_at, control_generation, payload_snapshot
          FROM campaign_dispatch_authorizations
         WHERE authorization_hash = $1 OR (workspace_id = $2 AND idempotency_key = $3)
         FOR UPDATE`, [
      input.authorization.authorizationHash,
      input.authorization.workspaceId,
      input.authorization.idempotencyKey,
    ])).rows[0];
    if (existing && (existing.authorization_hash !== input.authorization.authorizationHash
      || Number(existing.run_id) !== input.runId || existing.request_hash !== input.requestHash
      || existing.idempotency_key !== input.authorization.idempotencyKey)) {
      throw new ConflictError('Campaign dispatch authorization or idempotency identity was already consumed');
    }

    const controlGeneration = Number(control.generation);
    const consumed = existing ?? (await client.query<{
      authorization_hash: string;
      run_id: number;
      request_hash: string;
      idempotency_key: string;
      consumed_at: Date | string;
      expires_at: Date | string;
      control_generation: string | number;
      payload_snapshot: Record<string, unknown>;
    }>(`INSERT INTO campaign_dispatch_authorizations (
          authorization_hash, workspace_id, campaign_id, wave_id, manifest_hash,
          request_hash, idempotency_key, run_id, spec_id, spec_revision, story_id,
          attempt_fence, repository_host, repository, repository_binding_id,
          repository_id, base_sha, arm_decision_id, gate_decision_id,
          control_generation, issued_at, expires_at, payload_snapshot
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
          $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb
        ) RETURNING authorization_hash, run_id, request_hash, idempotency_key,
                    consumed_at, expires_at, control_generation, payload_snapshot`, [
      input.authorization.authorizationHash,
      input.authorization.workspaceId,
      input.authorization.campaignId,
      input.authorization.waveId,
      input.authorization.manifestHash,
      input.requestHash,
      input.authorization.idempotencyKey,
      input.runId,
      input.authorization.specId,
      input.authorization.specRevision,
      input.authorization.storyId,
      input.authorization.attemptFence,
      input.authorization.repositoryHost,
      input.authorization.repository,
      binding.binding_id,
      String(binding.repository_id),
      input.authorization.sha,
      input.authorization.arm.decisionId,
      input.authorization.gate.decisionId,
      controlGeneration,
      input.authorization.issuedAt,
      input.authorization.expiresAt,
      JSON.stringify(safeSnapshot(input.authorization, execution)),
    ])).rows[0];

    await client.query(
      `UPDATE pipeline_runs
          SET campaign_dispatch_authorization_hash = $2
        WHERE id = $1 AND (campaign_dispatch_authorization_hash IS NULL
          OR campaign_dispatch_authorization_hash = $2)`,
      [input.runId, input.authorization.authorizationHash],
    );
    const prepared = (await client.query<{ boss_job_id: string }>(
      `UPDATE pipeline_dispatch_publications
          SET request_hash = COALESCE(request_hash, $3),
              effective_options_hash = COALESCE(effective_options_hash, $4),
              payload_hash = COALESCE(payload_hash, $5),
              payload = COALESCE(payload, $6::jsonb),
              queue_name = CASE WHEN payload IS NULL THEN $7 ELSE queue_name END,
              updated_at = NOW()
        WHERE run_id = $1 AND state = 'preparing' AND lease_owner = $2
          AND (request_hash IS NULL OR request_hash = $3)
          AND (effective_options_hash IS NULL OR effective_options_hash = $4)
          AND (payload_hash IS NULL OR payload_hash = $5)
          AND (payload IS NULL OR (payload = $6::jsonb AND queue_name = $7))
        RETURNING boss_job_id::text`,
      [input.runId, input.owner, input.requestHash, input.effectiveOptionsHash, payloadHash, JSON.stringify(input.payload), queueName],
    )).rows[0];
    if (!prepared) throw new ConflictError('Campaign authorization consumption lost immutable outbox payload identity');

    if (!existing) {
      await client.query(
        `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload)
         VALUES ('campaign_dispatch_authorization_consumed', $1, $2, $3, 'campaign-authority', $4::jsonb)`,
        [input.authorization.workspaceId, input.authorization.specId, input.authorization.storyId, JSON.stringify({
          schemaVersion: CAMPAIGN_DISPATCH_CONSUMPTION_VERSION,
          authorizationHash: input.authorization.authorizationHash,
          requestHash: input.requestHash,
          campaignId: input.authorization.campaignId,
          waveId: input.authorization.waveId,
          runId: input.runId,
          armDecisionId: input.authorization.arm.decisionId,
          gateDecisionId: input.authorization.gate.decisionId,
          repositoryBindingId: binding.binding_id,
          baseRevision: input.authorization.sha,
          controlGeneration,
        })],
      );
    }

    const projection: CampaignDispatchConsumptionProjection = {
      schemaVersion: CAMPAIGN_DISPATCH_CONSUMPTION_VERSION,
      authorizationHash: input.authorization.authorizationHash,
      requestHash: input.requestHash,
      runId: input.runId,
      workspaceId: input.authorization.workspaceId,
      campaignId: input.authorization.campaignId,
      waveId: input.authorization.waveId,
      specId: input.authorization.specId,
      specRevision: input.authorization.specRevision,
      storyId: input.authorization.storyId,
      attemptFence: input.authorization.attemptFence,
      idempotencyKey: input.authorization.idempotencyKey,
      repositoryHost: input.authorization.repositoryHost,
      repository: input.authorization.repository,
      repositoryBindingId: binding.binding_id,
      baseRevision: input.authorization.sha,
      armDecisionId: input.authorization.arm.decisionId,
      gateDecisionId: input.authorization.gate.decisionId,
      controlGeneration: Number(consumed.control_generation),
      consumedAt: iso(consumed.consumed_at),
      expiresAt: iso(consumed.expires_at),
      state: 'consumed',
      execution,
    };
    return { bossJobId: prepared.boss_job_id, payloadHash, consumption: projection };
  });
}

export async function getCampaignDispatchConsumption(runId: number): Promise<CampaignDispatchConsumptionProjection | null> {
  const row = await queryOne<{
    authorization_hash: string; request_hash: string; run_id: number; workspace_id: string;
    campaign_id: string; wave_id: string; spec_id: string; spec_revision: string; story_id: string;
    attempt_fence: string; idempotency_key: string; repository_host: 'github.com'; repository: string;
    repository_binding_id: string; base_sha: string; arm_decision_id: string; gate_decision_id: string;
    control_generation: string | number; consumed_at: Date | string; expires_at: Date | string;
    payload_snapshot: { execution?: CampaignExecutionIdentity[] };
  }>(`SELECT authorization_hash, request_hash, run_id, workspace_id, campaign_id, wave_id,
             spec_id, spec_revision, story_id, attempt_fence, idempotency_key,
             repository_host, repository, repository_binding_id, base_sha,
             arm_decision_id, gate_decision_id, control_generation, consumed_at,
             expires_at, payload_snapshot
        FROM campaign_dispatch_authorizations WHERE run_id = $1`, [runId]);
  if (!row) return null;
  return {
    schemaVersion: CAMPAIGN_DISPATCH_CONSUMPTION_VERSION,
    authorizationHash: row.authorization_hash,
    requestHash: row.request_hash,
    runId: Number(row.run_id),
    workspaceId: row.workspace_id,
    campaignId: row.campaign_id,
    waveId: row.wave_id,
    specId: row.spec_id,
    specRevision: row.spec_revision,
    storyId: row.story_id,
    attemptFence: row.attempt_fence,
    idempotencyKey: row.idempotency_key,
    repositoryHost: row.repository_host,
    repository: row.repository,
    repositoryBindingId: row.repository_binding_id,
    baseRevision: row.base_sha,
    armDecisionId: row.arm_decision_id,
    gateDecisionId: row.gate_decision_id,
    controlGeneration: Number(row.control_generation),
    consumedAt: iso(row.consumed_at),
    expiresAt: iso(row.expires_at),
    state: 'consumed',
    execution: Array.isArray(row.payload_snapshot?.execution) ? row.payload_snapshot.execution : [],
  };
}

export async function setCampaignDispatchPause(input: {
  workspaceId: string;
  campaignId: string;
  paused: boolean;
  reason: string;
  actor: string;
  idempotencyKey: string;
}): Promise<{ workspaceId: string; campaignId: string; state: 'active' | 'paused'; generation: number; replayed: boolean; updatedAt: string }> {
  const reason = input.reason.trim();
  const actor = input.actor.trim();
  const key = input.idempotencyKey.trim();
  if (redactSecrets(reason).redactionCount > 0) {
    throw new ValidationError('Campaign pause rationale must not contain credential material');
  }
  if (!boundedId.safeParse(input.workspaceId).success || !boundedId.safeParse(input.campaignId).success
    || reason.length < 3 || reason.length > 500 || actor.length < 1 || actor.length > 255
    || key.length < 8 || key.length > 200) {
    throw new ValidationError('Campaign pause control requires bounded workspace, campaign, reason, actor, and idempotency identity');
  }
  return transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `campaign-dispatch:${input.workspaceId}:${input.campaignId}`,
    ]);
    const workspace = (await client.query<{ id: string }>(
      'SELECT id FROM workspaces WHERE id = $1 FOR SHARE', [input.workspaceId],
    )).rows[0];
    if (!workspace) throw new NotFoundError('Workspace', input.workspaceId);
    const replay = (await client.query<{
      state: 'active' | 'paused'; generation: string | number; created_at: Date | string;
      requested_state: 'active' | 'paused'; reason: string; actor: string;
    }>(`SELECT event.state, event.generation, event.created_at, event.requested_state,
               event.reason, event.actor
          FROM campaign_dispatch_control_events event
         WHERE event.workspace_id = $1 AND event.campaign_id = $2 AND event.idempotency_key = $3
         FOR UPDATE`, [input.workspaceId, input.campaignId, key])).rows[0];
    const requestedState = input.paused ? 'paused' : 'active';
    if (replay) {
      if (replay.requested_state !== requestedState || replay.reason !== reason || replay.actor !== actor) {
        throw new ConflictError('Campaign pause idempotency key was reused for a different control request');
      }
      return { workspaceId: input.workspaceId, campaignId: input.campaignId, state: replay.state, generation: Number(replay.generation), replayed: true, updatedAt: iso(replay.created_at) };
    }
    await client.query(
      `INSERT INTO campaign_dispatch_controls
         (workspace_id, campaign_id, generation, state, reason, updated_by, idempotency_key)
       VALUES ($1, $2, 0, 'active', 'initial_authority', $3, $4)
       ON CONFLICT (workspace_id, campaign_id) DO NOTHING`,
      [input.workspaceId, input.campaignId, actor, `initial:${input.campaignId}`],
    );
    const current = (await client.query<{ generation: string | number; state: 'active' | 'paused' }>(
      `SELECT generation, state FROM campaign_dispatch_controls
        WHERE workspace_id = $1 AND campaign_id = $2 FOR UPDATE`,
      [input.workspaceId, input.campaignId],
    )).rows[0];
    if (!current) throw new ConflictError('Campaign pause control could not be initialized');
    const generation = Number(current.generation) + 1;
    const updated = (await client.query<{ updated_at: Date | string }>(
      `UPDATE campaign_dispatch_controls
          SET generation = $3, state = $4, reason = $5, updated_by = $6,
              idempotency_key = $7, updated_at = NOW()
        WHERE workspace_id = $1 AND campaign_id = $2 RETURNING updated_at`,
      [input.workspaceId, input.campaignId, generation, requestedState, reason, actor, key],
    )).rows[0];
    await client.query(
      `INSERT INTO campaign_dispatch_control_events
         (workspace_id, campaign_id, generation, requested_state, state, reason, actor, idempotency_key)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7)`,
      [input.workspaceId, input.campaignId, generation, requestedState, reason, actor, key],
    );
    await client.query(
      `INSERT INTO wal_events (event_type, workspace_id, actor, payload)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [input.paused ? 'campaign_dispatch_paused' : 'campaign_dispatch_resumed', input.workspaceId, actor, JSON.stringify({
        campaignId: input.campaignId,
        generation,
        state: requestedState,
        reason,
      })],
    );
    return { workspaceId: input.workspaceId, campaignId: input.campaignId, state: requestedState, generation, replayed: false, updatedAt: iso(updated.updated_at) };
  });
}

export function requireCampaignServiceAuthentication(req: {
  campaignServiceAuth?: string;
  user?: { id?: string; email?: string };
}): void {
  const canonicalServicePrincipal = req.user?.id === 'rorca-hermes-service'
    && req.user.email === hermesServiceEmail();
  if (!req.campaignServiceAuth && !canonicalServicePrincipal) {
    throw new AuthError('Campaign dispatch authorization requires an authenticated Hermes service credential');
  }
}
