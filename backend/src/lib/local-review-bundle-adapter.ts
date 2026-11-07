/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Immutable, content-addressed, no-network delivery projection for local review. */
import { execFileSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PoolClient } from 'pg';

import { query, queryOne, transaction } from '../db/index';
import { detectSecretLikeString } from './context-safety';
import {
  canonicalDeliveryJson,
  deliverySha256,
  DELIVERY_ADAPTER_CONTRACT_VERSION,
  LOCAL_REVIEW_BUNDLE_ADAPTER_DESCRIPTOR,
  LOCAL_REVIEW_BUNDLE_ADAPTER_ID,
  LOCAL_REVIEW_BUNDLE_ADAPTER_VERSION,
  LOCAL_REVIEW_BUNDLE_READ_MODEL_VERSION,
  LOCAL_REVIEW_BUNDLE_SCHEMA_VERSION,
  LocalReviewBundleManifestSchema,
  SHA1_PATTERN,
  SHA256_PATTERN,
  UUID_PATTERN,
  type DeliveryAdapter,
  type DeliveryCreateRequest,
  type DeliveryCreateResult,
  type LocalReviewBundleManifest,
  type LocalReviewBundleReadModel,
} from './delivery-adapter';
import { ConflictError, NotFoundError, PayloadTooLargeError, ValidationError } from './errors';
import { retryHash } from './retry-governance';
import { deriveStoryContractRevision } from './story-execution-packet';
import { assertNotProtectedWave1Run, WAVE_1_PROTECTED_GENESIS_RUN_ID } from './wave-1-stabilization';
import { isRorcaRuntimeMetadataPath } from './worktree-freshness';

export const LOCAL_REVIEW_LIMITS = Object.freeze({
  maxChangedFiles: 500,
  maxFileBytes: 1024 * 1024,
  maxChangedContentBytes: 8 * 1024 * 1024,
  maxPatchBytes: 8 * 1024 * 1024,
  maxManifestBytes: 256 * 1024,
  maxSpecBytes: 2 * 1024 * 1024,
  maxGitMetadataBytes: 1024 * 1024,
  maxProjectionFiles: 4,
  maxProjectionDepth: 3,
  maxProjectionBytes: 8 * 1024 * 1024 + 256 * 1024,
  maxMaintenanceEntriesPerDirectory: 10_000,
});

const ARTIFACT_FILE = 'changes.patch';
const MANIFEST_FILE = 'manifest.json';
const PROJECTION_PATTERN = /^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const SECRET_PATH_SEGMENT = /^(?:\.git(?:modules)?|\.ssh|\.aws|\.azure|\.gcloud|\.gnupg|\.docker|\.kube|\.env(?:\..*)?|\.npmrc|\.pypirc|credentials?(?:[-_.].*)?|secrets?(?:[-_.].*)?|auth(?:[-_.].*)?|tokens?(?:[-_.].*)?|service[-_.]?accounts?(?:[-_.].*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|jks|keystore|secret|kdbx))$/i;
const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  /\b(?:github_pat_|gh[pousr]_|glpat-|sk_(?:live|test)_|AKIA|ASIA)[A-Za-z0-9_-]{16,}\b/,
  /\b(?:authorization|proxy-authorization)\s*:\s*(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"']{8,}/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/@:]+:[^\s/@]+@/i,
] as const;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

function strictUtf8(bytes: Buffer, label: string, allowNulSeparator = false): string {
  try {
    const text = STRICT_UTF8.decode(bytes);
    let disallowedControls = 0;
    for (const character of text) {
      const code = character.codePointAt(0)!;
      if ((code < 0x20 && character !== '\n' && character !== '\r' && character !== '\t'
          && !(allowNulSeparator && code === 0)) || code === 0x7f) {
        disallowedControls += 1;
      }
    }
    if (disallowedControls > 0) throw new Error('non-text controls');
    return text;
  } catch {
    throw new ConflictError(`Local review bundle rejected non-UTF-8 or non-text ${label}`);
  }
}

function assertNoSecretContent(text: string, label: string): void {
  if (detectSecretLikeString(text) || SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new ConflictError(`Local review bundle rejected secret-like ${label}`);
  }
}

interface AuthorityRow {
  envelope_id: string;
  workspace_id: string;
  run_id: number | string;
  story_id: string;
  attempt: number | string;
  launch_generation: string;
  cancellation_fence: string;
  manifest_hash: string;
  spec_id: string;
  spec_revision: string;
  story_revision: string;
  canonical_spec_path: string;
  canonical_spec_revision: string | null;
  canonical_spec_bytes_hash: string | null;
  repository_realpath: string;
  repository_identity: string;
  base_git_sha: string;
  observed_git_sha: string;
  worktree_realpath: string;
  worktree_identity: string;
  worktree_branch: string;
  payload_hash: string;
  authority_state: string;
  outcome: string | null;
  outcome_provenance: string | null;
  exit_code: number | null;
  exit_signal: string | null;
  attempt_completed_at: Date | string | null;
  run_workspace_id: string;
  run_spec_path: string;
  run_dispatch_fence: string | null;
  cancellation_requested: boolean;
  run_branch_name: string | null;
  run_worktree_path: string | null;
  workspace_path: string;
  story_result_id: number | string | null;
  story_result_status: string | null;
  story_commit_sha: string | null;
  story_result_count: number | string;
  result_provenance: string | null;
  result_source: string | null;
  result_integrated: boolean | null;
  result_commit_author: string | null;
  result_commit_branch: string | null;
  result_worktree_path: string | null;
  attempt_result_id: string | null;
  closeout_decision_id: string | null;
  closeout_status: string | null;
  closeout_manifest_hash: string | null;
  closeout_decision_count: number | string;
  host_closeout_event_id: number | string | null;
  host_closeout_identity_hash: string | null;
  exact_host_pass: boolean;
}

interface ValidationReceiptRow {
  id: string;
  validation_gate: string;
  checkpoint_sha: string;
  evidence_digest: string;
  passed_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
}

interface BundleRow {
  bundle_id: string;
  contract_version: string;
  schema_version: string;
  adapter_id: string;
  adapter_version: string;
  workspace_id: string;
  spec_id: string;
  story_id: string;
  run_id: number | string;
  attempt: number | string;
  launch_generation: string;
  host_attempt_envelope_id: string;
  idempotency_key: string;
  request_hash: string;
  content_hash: string;
  manifest_hash: string;
  projection_key: string;
  manifest_json: LocalReviewBundleManifest | string;
  validation_status: 'passed' | 'blocked';
  merge_status: 'not_authorized';
  deployment_status: 'not_authorized';
  created_by: string;
  created_at: Date | string;
  finalized_at: Date | string;
  authority_current?: boolean;
}

export interface LocalReviewBundleListResult {
  schemaVersion: typeof LOCAL_REVIEW_BUNDLE_READ_MODEL_VERSION;
  items: LocalReviewBundleReadModel[];
  limit: number;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseManifest(value: LocalReviewBundleManifest | string): LocalReviewBundleManifest {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    return LocalReviewBundleManifestSchema.parse(parsed);
  } catch {
    throw new ConflictError('Local review bundle canonical manifest is malformed');
  }
}

function manifestContentBasis(manifest: LocalReviewBundleManifest): string {
  const { bundleId: _bundleId, contentHash: _contentHash, ...draft } = manifest;
  return canonicalDeliveryJson(draft);
}

function assertBundleRowRelationships(row: BundleRow): LocalReviewBundleManifest {
  const manifest = parseManifest(row.manifest_json);
  const contentHash = deliverySha256(manifestContentBasis(manifest));
  const digest = contentHash.slice('sha256:'.length);
  if (row.contract_version !== DELIVERY_ADAPTER_CONTRACT_VERSION
    || row.schema_version !== LOCAL_REVIEW_BUNDLE_SCHEMA_VERSION
    || row.adapter_id !== LOCAL_REVIEW_BUNDLE_ADAPTER_ID
    || row.adapter_version !== manifest.adapter.adapterVersion
    || row.bundle_id !== manifest.bundleId
    || row.bundle_id !== `lrb-${digest}`
    || row.content_hash !== contentHash
    || row.content_hash !== manifest.contentHash
    || row.manifest_hash !== deliverySha256(canonicalDeliveryJson(manifest))
    || row.projection_key !== `sha256/${digest.slice(0, 2)}/${digest}`
    || row.workspace_id !== manifest.identity.workspaceId
    || row.spec_id !== manifest.identity.specId
    || row.story_id !== manifest.identity.storyId
    || Number(row.run_id) !== manifest.identity.runId
    || Number(row.attempt) !== manifest.identity.attempt
    || row.launch_generation !== manifest.identity.generation
    || row.host_attempt_envelope_id !== manifest.identity.hostAttemptEnvelopeId
    || row.idempotency_key !== manifest.idempotencyKey
    || row.validation_status !== manifest.validation.status
    || row.merge_status !== manifest.delivery.mergeStatus
    || row.deployment_status !== manifest.delivery.deploymentStatus
    || timestamp(row.created_at) !== manifest.createdAt
    || timestamp(row.finalized_at) !== manifest.createdAt) {
    throw new ConflictError('Local review bundle canonical row relationships are corrupt');
  }
  if (row.authority_current === false) {
    throw new ConflictError('Local review bundle is disqualified by changed host authority');
  }
  return manifest;
}

function normalizeRequest(request: DeliveryCreateRequest): DeliveryCreateRequest {
  const workspaceId = String(request.workspaceId ?? '').trim();
  const storyId = String(request.storyId ?? '').trim();
  const idempotencyKey = String(request.idempotencyKey ?? '').trim();
  const requestedBy = String(request.requestedBy ?? '').trim();
  if (!SAFE_ID.test(workspaceId) || workspaceId.length > 255) {
    throw new ValidationError('Invalid local review bundle workspace identity');
  }
  if (!storyId || storyId.length > 160 || CONTROL_CHARACTER.test(storyId) || detectSecretLikeString(storyId)) {
    throw new ValidationError('Invalid local review bundle story identity');
  }
  if (!Number.isSafeInteger(request.runId) || request.runId <= 0) {
    throw new ValidationError('Invalid local review bundle run identity');
  }
  if (!Number.isSafeInteger(request.attempt) || request.attempt <= 0
    || !UUID_PATTERN.test(request.generation) || !UUID_PATTERN.test(request.hostAttemptEnvelopeId)) {
    throw new ValidationError('Exact positive attempt, UUID generation, and host-attempt envelope are required');
  }
  assertNotProtectedWave1Run(request.runId);
  if (idempotencyKey.length < 8 || idempotencyKey.length > 200 || !SAFE_ID.test(idempotencyKey)
    || detectSecretLikeString(idempotencyKey)) {
    throw new ValidationError('Local review bundle idempotency key must be 8-200 non-secret safe characters');
  }
  if (!requestedBy || requestedBy.length > 255 || CONTROL_CHARACTER.test(requestedBy)) {
    throw new ValidationError('Local review bundle creator identity is invalid');
  }
  return {
    workspaceId, runId: request.runId, storyId,
    attempt: request.attempt, generation: request.generation,
    hostAttemptEnvelopeId: request.hostAttemptEnvelopeId,
    idempotencyKey, requestedBy,
  };
}

function requestBasis(request: DeliveryCreateRequest): string {
  return canonicalDeliveryJson({
    contractVersion: LOCAL_REVIEW_BUNDLE_ADAPTER_DESCRIPTOR.contractVersion,
    adapterId: LOCAL_REVIEW_BUNDLE_ADAPTER_DESCRIPTOR.adapterId,
    adapterVersion: LOCAL_REVIEW_BUNDLE_ADAPTER_DESCRIPTOR.adapterVersion,
    workspaceId: request.workspaceId,
    runId: request.runId,
    storyId: request.storyId,
    attempt: request.attempt,
    generation: request.generation,
    hostAttemptEnvelopeId: request.hostAttemptEnvelopeId,
    requestedBy: request.requestedBy,
  });
}

function requestHash(request: DeliveryCreateRequest): string {
  return deliverySha256(requestBasis(request));
}

function defaultArtifactRoot(): string {
  const dataRoot = String(process.env.RORCA_DATA_DIR ?? '').trim()
    || path.join(os.homedir(), '.rorca');
  return path.resolve(String(process.env.RORCA_DELIVERY_ARTIFACT_ROOT ?? '').trim()
    || path.join(dataRoot, 'delivery', 'review-bundles'));
}

function safeProjectionPath(root: string, projectionKey: string): string {
  if (!PROJECTION_PATTERN.test(projectionKey)) throw new ConflictError('Local review bundle projection key is invalid');
  const candidate = path.resolve(root, ...projectionKey.split('/'));
  const relative = path.relative(path.resolve(root), candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ConflictError('Local review bundle projection escaped its content-addressed root');
  }
  return candidate;
}

function localGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? 'C',
    LC_ALL: 'C',
    HOME: path.join(os.tmpdir(), 'rorca-local-review-no-home'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: fsSync.existsSync('/dev/null') ? '/dev/null' : '',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

function gitBuffer(cwd: string, args: string[], maxBuffer: number): Buffer {
  try {
    return execFileSync('git', [
      '-c', 'credential.helper=',
      '-c', 'core.hooksPath=',
      '-c', 'core.fsmonitor=false',
      '-c', 'diff.external=',
      ...args,
    ], {
      cwd,
      encoding: 'buffer',
      env: localGitEnvironment(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30_000,
      maxBuffer,
    }) as Buffer;
  } catch {
    throw new ConflictError('Local review bundle Git observation failed closed');
  }
}

function gitText(cwd: string, args: string[], maxBuffer = LOCAL_REVIEW_LIMITS.maxGitMetadataBytes): string {
  return gitBuffer(cwd, args, maxBuffer).toString('utf8').trim();
}

function pathDigest(value: string): string {
  return deliverySha256(Buffer.from(value, 'utf8'));
}

function exactRealDirectory(stored: string, label: string): string {
  const expected = path.resolve(stored);
  let observed: string;
  try {
    observed = fsSync.realpathSync(expected);
    if (!fsSync.statSync(observed).isDirectory()) throw new Error('not directory');
  } catch {
    throw new ConflictError(`${label} is missing or unreadable`);
  }
  if (observed !== expected) throw new ConflictError(`${label} moved or traversed a symlink`);
  return observed;
}

function worktreeIdentity(realpath: string): string {
  const stat = fsSync.statSync(realpath);
  return retryHash({ realpath, device: String(stat.dev), inode: String(stat.ino) });
}

function observeCanonicalSpec(input: {
  repositoryRealpath: string;
  canonicalPath: string;
  expectedBytesHash: string;
  expectedRevision: string;
}): void {
  const relativePath = validateChangedPath(input.canonicalPath);
  const expectedPath = path.resolve(input.repositoryRealpath, ...relativePath.split('/'));
  const containment = path.relative(input.repositoryRealpath, expectedPath);
  if (!containment || containment.startsWith('..') || path.isAbsolute(containment)) {
    throw new ConflictError('Canonical spec path escaped repository authority');
  }
  let observedPath: string;
  let bytes: Buffer;
  try {
    observedPath = fsSync.realpathSync(expectedPath);
    const stat = fsSync.lstatSync(expectedPath);
    if (observedPath !== expectedPath || stat.isSymbolicLink() || !stat.isFile()) throw new Error('moved');
    if (stat.size > LOCAL_REVIEW_LIMITS.maxSpecBytes) {
      throw new PayloadTooLargeError('Canonical spec exceeds the local review bundle observation limit');
    }
    const fd = fsSync.openSync(expectedPath, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fsSync.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isFile()) throw new Error('raced');
      bytes = fsSync.readFileSync(fd);
      const after = fsSync.lstatSync(expectedPath);
      if (after.dev !== opened.dev || after.ino !== opened.ino || fsSync.realpathSync(expectedPath) !== expectedPath) {
        throw new Error('raced');
      }
    } finally {
      fsSync.closeSync(fd);
    }
  } catch (error) {
    if (error instanceof PayloadTooLargeError) throw error;
    throw new ConflictError('Canonical spec is missing, moved, symlinked, or unreadable');
  }
  if (deliverySha256(bytes) !== input.expectedBytesHash) {
    throw new ConflictError('Canonical spec bytes changed after host attempt observation');
  }
  try {
    const parsed = JSON.parse(strictUtf8(bytes, 'canonical spec')) as unknown;
    if (deriveStoryContractRevision(parsed) !== input.expectedRevision) {
      throw new ConflictError('Canonical spec revision changed after host attempt observation');
    }
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    throw new ConflictError('Canonical spec is not valid JSON');
  }
}

function validateChangedPath(value: string): string {
  if (!value || value.length > 4096 || CONTROL_CHARACTER.test(value)
    || value.includes('\\') || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value.split('/').some((segment) => !segment || segment === '..' || SECRET_PATH_SEGMENT.test(segment))) {
    throw new ConflictError('Local review bundle rejected an unsafe or secret-bearing changed path');
  }
  return value;
}

function changeName(status: string): LocalReviewBundleManifest['changedFiles'][number]['change'] {
  switch (status[0]) {
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'T': return 'type_changed';
    case 'U': return 'unmerged';
    default: return 'unknown';
  }
}

interface TreeSnapshot {
  bytes: number;
  sha256: string;
}

function treeSnapshot(cwd: string, revision: string, filePath: string): TreeSnapshot | null {
  const listing = gitBuffer(cwd, ['ls-tree', '-z', revision, '--', filePath], LOCAL_REVIEW_LIMITS.maxGitMetadataBytes);
  if (listing.length === 0) return null;
  const entry = strictUtf8(listing, 'Git tree metadata', true).replace(/\0$/, '');
  const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(entry);
  if (!match || match[4] !== filePath || match[1] === '120000' || match[2] !== 'blob'
    || !['100644', '100755'].includes(match[1])) {
    throw new ConflictError('Local review bundle rejects symlinks, submodules, and unsupported Git object types');
  }
  const declaredSize = Number(gitText(cwd, ['cat-file', '-s', match[3]]));
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
    throw new ConflictError('Local review bundle Git object size is invalid');
  }
  if (declaredSize > LOCAL_REVIEW_LIMITS.maxFileBytes) {
    throw new PayloadTooLargeError('Changed file exceeds the local review bundle per-file limit');
  }
  const bytes = gitBuffer(cwd, ['cat-file', 'blob', match[3]], LOCAL_REVIEW_LIMITS.maxFileBytes + 1);
  if (bytes.length !== declaredSize) throw new ConflictError('Changed file bytes differ from their exact Git object size');
  if (bytes.includes(0)) throw new ConflictError('Local review bundle rejects binary changed content');
  const text = strictUtf8(bytes, 'changed content');
  assertNoSecretContent(text, 'changed content');
  return { bytes: bytes.length, sha256: deliverySha256(bytes) };
}

function collectChangedFiles(cwd: string, baseSha: string, headSha: string): {
  files: LocalReviewBundleManifest['changedFiles'];
  contentBytes: number;
} {
  const raw = gitBuffer(cwd, ['diff', '--name-status', '-z', '--no-renames', baseSha, headSha, '--'], LOCAL_REVIEW_LIMITS.maxGitMetadataBytes);
  const fields = strictUtf8(raw, 'Git path metadata', true).split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 2 !== 0) throw new ConflictError('Local review bundle received malformed Git path metadata');
  if (fields.length / 2 > LOCAL_REVIEW_LIMITS.maxChangedFiles) {
    throw new PayloadTooLargeError('Local review bundle changed-file count exceeds its limit');
  }
  const files: LocalReviewBundleManifest['changedFiles'] = [];
  let contentBytes = 0;
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const filePath = validateChangedPath(fields[index + 1]);
    const before = treeSnapshot(cwd, baseSha, filePath);
    const after = treeSnapshot(cwd, headSha, filePath);
    if (!before && !after) throw new ConflictError('Local review bundle changed path has no bound Git object');
    contentBytes += (before?.bytes ?? 0) + (after?.bytes ?? 0);
    if (contentBytes > LOCAL_REVIEW_LIMITS.maxChangedContentBytes) {
      throw new PayloadTooLargeError('Local review bundle changed content exceeds its total limit');
    }
    files.push({ path: filePath, change: changeName(status), before, after });
  }
  return { files, contentBytes };
}

function createPatch(cwd: string, baseSha: string, headSha: string): Buffer {
  const patch = gitBuffer(cwd, [
    'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames',
    baseSha, headSha, '--',
  ], LOCAL_REVIEW_LIMITS.maxPatchBytes + 1);
  if (patch.length > LOCAL_REVIEW_LIMITS.maxPatchBytes) {
    throw new PayloadTooLargeError('Local review bundle patch exceeds its limit');
  }
  assertNoSecretContent(strictUtf8(patch, 'patch content'), 'patch content');
  return patch;
}

function digestFromContentAddressedId(value: string | null): string | null {
  if (!value) return null;
  const match = /(?:sha256:)([0-9a-f]{64})$/.exec(value);
  return match ? `sha256:${match[1]}` : null;
}

async function loadAuthority(request: DeliveryCreateRequest, client?: PoolClient): Promise<{
  row: AuthorityRow;
  receipts: ValidationReceiptRow[];
}> {
  const authoritySql = `
    SELECT envelope.envelope_id, envelope.workspace_id, envelope.run_id,
           envelope.story_id, envelope.attempt, envelope.launch_generation,
           envelope.cancellation_fence, envelope.manifest_hash,
           envelope.spec_id, envelope.spec_revision,
           envelope.story_revision, envelope.canonical_spec_path,
           envelope.canonical_spec_revision, envelope.canonical_spec_bytes_hash,
           envelope.repository_realpath,
           envelope.repository_identity, envelope.base_git_sha,
           envelope.observed_git_sha, envelope.worktree_realpath,
           envelope.worktree_identity, envelope.worktree_branch,
           envelope.payload_hash, envelope.authority_state, envelope.outcome,
           envelope.outcome_provenance, envelope.exit_code, envelope.exit_signal,
           envelope.finished_at AS attempt_completed_at,
           run.workspace_id AS run_workspace_id, run.spec_path AS run_spec_path,
           run.dispatch_fence AS run_dispatch_fence,
           (EXISTS (SELECT 1 FROM pipeline_run_cancellation_requests cancellation WHERE cancellation.run_id = run.id)
             OR EXISTS (SELECT 1 FROM governed_retry_dispatches retry
                         WHERE retry.retry_run_id = run.id AND retry.cancellation_requested_at IS NOT NULL)) AS cancellation_requested,
           run.branch_name AS run_branch_name,
           run.execution_worktree_path AS run_worktree_path,
           workspace.path AS workspace_path,
           result.id AS story_result_id, result.status AS story_result_status,
           result.commit_sha AS story_commit_sha,
           result.result_provenance, result.result_source,
           result.integrated AS result_integrated,
           result.commit_author AS result_commit_author,
           result.commit_branch AS result_commit_branch,
           result.worktree_path AS result_worktree_path,
           COALESCE(result_scope.result_count, 0) AS story_result_count,
           decision.attempt_result_id, decision.decision_id AS closeout_decision_id,
           decision.status AS closeout_status,
           decision.manifest_hash AS closeout_manifest_hash,
           COALESCE(decision_scope.decision_count, 0) AS closeout_decision_count,
           closeout.id AS host_closeout_event_id,
           CASE WHEN closeout.event_identity_hash ~ '^[0-9a-f]{64}$'
             THEN 'sha256:' || closeout.event_identity_hash ELSE NULL END AS host_closeout_identity_hash,
           local_review_bundle_exact_pass_authority(
             envelope.envelope_id, envelope.finished_at, result.commit_sha) AS exact_host_pass
      FROM host_story_attempt_envelopes envelope
      JOIN pipeline_runs run ON run.id = envelope.run_id
      JOIN workspaces workspace ON workspace.id = run.workspace_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::integer AS decision_count
          FROM story_closeout_decisions counted_decision
         WHERE counted_decision.workspace_id = envelope.workspace_id
           AND counted_decision.run_id = envelope.run_id
           AND counted_decision.story_id = envelope.story_id
           AND counted_decision.attempt = envelope.attempt
           AND counted_decision.manifest_hash = envelope.manifest_hash
      ) decision_scope ON TRUE
      LEFT JOIN LATERAL (
        SELECT decision.* FROM story_closeout_decisions decision
         WHERE decision.workspace_id = envelope.workspace_id
           AND decision.run_id = envelope.run_id
           AND decision.story_id = envelope.story_id
           AND decision.attempt = envelope.attempt
           AND decision.manifest_hash = envelope.manifest_hash
         ORDER BY decision.created_at DESC, decision.decision_id DESC LIMIT 1
      ) decision ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::integer AS result_count
          FROM story_results counted_result
         WHERE counted_result.run_id = envelope.run_id
           AND counted_result.story_id = envelope.story_id
           AND counted_result.closeout_decision_id = decision.decision_id
      ) result_scope ON TRUE
      LEFT JOIN LATERAL (
        SELECT result.* FROM story_results result
         WHERE result.run_id = envelope.run_id
           AND result.story_id = envelope.story_id
           AND result.closeout_decision_id = decision.decision_id
         ORDER BY result.id DESC LIMIT 1
      ) result ON TRUE
      LEFT JOIN wal_events closeout
        ON closeout.id = run.host_closeout_event_id
       AND closeout.event_type = 'run_closeout'
       AND closeout.trust_provenance = 'host'
     WHERE envelope.workspace_id = $1 AND envelope.run_id = $2
       AND envelope.story_id = $3 AND envelope.attempt = $4
       AND envelope.launch_generation = $5::uuid
       AND envelope.envelope_id = $6::uuid
       AND NOT EXISTS (
         SELECT 1 FROM host_story_attempt_conflicts conflict
          WHERE conflict.workspace_id = envelope.workspace_id
            AND conflict.run_id = envelope.run_id
            AND conflict.story_id = envelope.story_id
            AND conflict.attempt = envelope.attempt
       )
  `;
  const authorityParams = [request.workspaceId, request.runId, request.storyId, request.attempt,
    request.generation, request.hostAttemptEnvelopeId];
  const row = client
    ? (await client.query<AuthorityRow>(authoritySql, authorityParams)).rows[0]
    : await queryOne<AuthorityRow>(authoritySql, authorityParams);
  if (!row || row.run_workspace_id !== request.workspaceId) {
    throw new NotFoundError('Exact host story attempt authority');
  }
  const receiptSql = `
    SELECT id::text, validation_gate, checkpoint_sha, evidence_digest,
           passed_at, expires_at, revoked_at
      FROM checkpoint_validation_attestations
     WHERE workspace_id = $1 AND run_id = $2 AND story_id = $3
       AND branch_name = $4 AND checkpoint_sha = $5
     ORDER BY passed_at, id
     LIMIT 33
  `;
  const receiptParams = [request.workspaceId, request.runId, request.storyId,
    row.worktree_branch, row.story_commit_sha];
  const receipts = row.story_commit_sha && SHA1_PATTERN.test(row.story_commit_sha)
    ? (client
      ? (await client.query<ValidationReceiptRow>(receiptSql, receiptParams)).rows
      : await query<ValidationReceiptRow>(receiptSql, receiptParams))
    : [];
  if (receipts.length > 32) throw new ConflictError('Local review bundle validation receipt count exceeds its authority limit');
  return { row, receipts };
}

function validateAuthority(authority: AuthorityRow): {
  repositoryRealpath: string;
  worktreeRealpath: string;
  headSha: string;
} {
  if (authority.authority_state !== 'valid'
    || !UUID_PATTERN.test(authority.envelope_id)
    || !UUID_PATTERN.test(authority.launch_generation)
    || !SHA256_PATTERN.test(authority.cancellation_fence)
    || !SHA256_PATTERN.test(authority.manifest_hash)
    || !SHA256_PATTERN.test(authority.spec_revision)
    || !SHA256_PATTERN.test(authority.story_revision)
    || !authority.attempt_completed_at
    || !Number.isFinite(Date.parse(String(authority.attempt_completed_at)))
    || !SHA256_PATTERN.test(authority.canonical_spec_revision ?? '')
    || !SHA256_PATTERN.test(authority.canonical_spec_bytes_hash ?? '')
    || !SHA256_PATTERN.test(authority.repository_identity)
    || !SHA256_PATTERN.test(authority.worktree_identity)
    || !SHA256_PATTERN.test(authority.payload_hash)
    || !SHA1_PATTERN.test(authority.base_git_sha)
    || !SHA1_PATTERN.test(authority.observed_git_sha)) {
    throw new ConflictError('Local review bundle lacks complete immutable host authority');
  }
  const repositoryRealpath = exactRealDirectory(authority.repository_realpath, 'Repository authority path');
  const worktreeRealpath = exactRealDirectory(authority.worktree_realpath, 'Worktree authority path');
  if (path.resolve(authority.workspace_path) !== repositoryRealpath
    || path.resolve(authority.run_worktree_path ?? '') !== worktreeRealpath
    || authority.run_spec_path !== authority.canonical_spec_path
    || authority.run_branch_name !== authority.worktree_branch
    || worktreeIdentity(worktreeRealpath) !== authority.worktree_identity) {
    throw new ConflictError('Local review bundle repository or worktree identity is stale');
  }
  const repositoryCommon = path.resolve(repositoryRealpath, gitText(repositoryRealpath, ['rev-parse', '--git-common-dir']));
  const worktreeCommon = path.resolve(worktreeRealpath, gitText(worktreeRealpath, ['rev-parse', '--git-common-dir']));
  try {
    if (fsSync.realpathSync(repositoryCommon) !== fsSync.realpathSync(worktreeCommon)) {
      throw new ConflictError('Local review bundle worktree is not a member of the exact repository');
    }
  } catch (error) {
    if (error instanceof ConflictError) throw error;
    throw new ConflictError('Local review bundle Git common-directory authority is missing or unreadable');
  }
  const currentBranch = gitText(worktreeRealpath, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const worktreeStatus = gitBuffer(worktreeRealpath, [
    'status', '--porcelain=v1', '--untracked-files=all',
  ], LOCAL_REVIEW_LIMITS.maxGitMetadataBytes).toString('utf8');
  const dirtyPaths = worktreeStatus
    ? worktreeStatus.split('\n').map((line) => line.slice(3).trim()).filter(Boolean)
    : [];
  if (dirtyPaths.some((dirtyPath) => !isRorcaRuntimeMetadataPath(dirtyPath))) {
    throw new ConflictError('Local review bundle requires a clean exact story worktree');
  }
  if (detectSecretLikeString(authority.spec_id)
    || detectSecretLikeString(authority.story_id)
    || detectSecretLikeString(authority.worktree_branch)) {
    throw new ConflictError('Local review bundle rejected secret-like authority metadata');
  }
  observeCanonicalSpec({
    repositoryRealpath,
    canonicalPath: authority.canonical_spec_path,
    expectedBytesHash: authority.canonical_spec_bytes_hash!,
    expectedRevision: authority.canonical_spec_revision!,
  });
  const currentHead = gitText(worktreeRealpath, ['rev-parse', 'HEAD^{commit}']).toLowerCase();
  if (!SHA1_PATTERN.test(currentHead) || currentBranch !== authority.worktree_branch) {
    throw new ConflictError('Local review bundle branch or head observation is invalid');
  }
  if (authority.story_commit_sha && currentHead !== authority.story_commit_sha.toLowerCase()) {
    throw new ConflictError('Local review bundle rejects a stale story head SHA');
  }
  gitText(worktreeRealpath, ['merge-base', '--is-ancestor', authority.observed_git_sha, currentHead]);
  return { repositoryRealpath, worktreeRealpath, headSha: currentHead };
}

function buildManifest(input: {
  request: DeliveryCreateRequest;
  authority: AuthorityRow;
  receipts: ValidationReceiptRow[];
  changedFiles: LocalReviewBundleManifest['changedFiles'];
  patch: Buffer;
  headSha: string;
  createdAt: string;
}): LocalReviewBundleManifest {
  const now = Date.parse(input.createdAt);
  const validationReceipts = input.receipts.map((receipt) => ({
    receiptId: receipt.id,
    gate: receipt.validation_gate,
    checkpointSha: receipt.checkpoint_sha.toLowerCase(),
    evidenceDigest: receipt.evidence_digest.startsWith('sha256:')
      ? receipt.evidence_digest : `sha256:${receipt.evidence_digest}`,
    passedAt: timestamp(receipt.passed_at),
    expiresAt: timestamp(receipt.expires_at),
    revoked: receipt.revoked_at !== null,
    trustClass: 'host_observed' as const,
  }));
  const activeReceipts = validationReceipts.filter((receipt) => !receipt.revoked && Date.parse(receipt.expiresAt) > now);
  const hostPass = input.authority.exact_host_pass === true
    && input.authority.story_commit_sha?.toLowerCase() === input.headSha
    && validationReceipts.length === 1
    && activeReceipts.length === 1
    && activeReceipts[0].gate === 'execution-engine';
  const evidenceReferences: LocalReviewBundleManifest['evidenceReferences'] = [
    { kind: 'host_attempt', reference: input.authority.envelope_id, digest: input.authority.payload_hash, trustClass: 'host_observed' },
    { kind: 'execution_manifest', reference: input.authority.manifest_hash, digest: input.authority.manifest_hash, trustClass: 'host_observed' },
  ];
  if (input.authority.attempt_result_id) evidenceReferences.push({
    kind: 'attempt_result', reference: input.authority.attempt_result_id,
    digest: digestFromContentAddressedId(input.authority.attempt_result_id), trustClass: 'host_observed',
  });
  if (input.authority.closeout_decision_id) evidenceReferences.push({
    kind: 'closeout_decision', reference: input.authority.closeout_decision_id,
    digest: digestFromContentAddressedId(input.authority.closeout_decision_id), trustClass: 'host_observed',
  });
  for (const receipt of validationReceipts) evidenceReferences.push({
    kind: 'validation_receipt', reference: receipt.receiptId,
    digest: receipt.evidenceDigest, trustClass: 'host_observed',
  });
  if (input.authority.host_closeout_event_id != null) evidenceReferences.push({
    kind: 'run_closeout', reference: String(input.authority.host_closeout_event_id),
    digest: input.authority.host_closeout_identity_hash, trustClass: 'host_observed',
  });
  const draft = {
    schemaVersion: LOCAL_REVIEW_BUNDLE_SCHEMA_VERSION,
    adapter: LOCAL_REVIEW_BUNDLE_ADAPTER_DESCRIPTOR,
    idempotencyKey: input.request.idempotencyKey,
    identity: {
      workspaceId: input.authority.workspace_id,
      specId: input.authority.spec_id,
      storyId: input.authority.story_id,
      runId: Number(input.authority.run_id),
      attempt: Number(input.authority.attempt),
      generation: input.authority.launch_generation,
      hostAttemptEnvelopeId: input.authority.envelope_id,
    },
    specification: {
      canonicalPath: input.authority.canonical_spec_path,
      revision: input.authority.canonical_spec_revision!,
      bytesHash: input.authority.canonical_spec_bytes_hash!,
      storyRevision: input.authority.story_revision,
      executionManifestHash: input.authority.manifest_hash,
    },
    repository: {
      repositoryIdentity: input.authority.repository_identity,
      repositoryPathDigest: pathDigest(input.authority.repository_realpath),
      worktreeIdentity: input.authority.worktree_identity,
      worktreePathDigest: pathDigest(input.authority.worktree_realpath),
      runBaseSha: input.authority.base_git_sha,
      baseSha: input.authority.observed_git_sha,
      headSha: input.headSha,
      branch: input.authority.worktree_branch,
    },
    changedFiles: input.changedFiles,
    artifacts: [{
      name: ARTIFACT_FILE,
      mediaType: 'text/x-diff' as const,
      bytes: input.patch.length,
      sha256: deliverySha256(input.patch),
    }],
    validation: {
      status: hostPass ? 'passed' as const : 'blocked' as const,
      authoredBy: hostPass ? 'host_closeout' as const : 'none' as const,
      receipts: validationReceipts,
      agentProseAccepted: false as const,
      ptyAccepted: false as const,
      processExitAcceptedAsPass: false as const,
      memoryAccepted: false as const,
    },
    evidenceReferences,
    createdAt: input.createdAt,
    delivery: {
      reviewStatus: 'awaiting_local_review' as const,
      mergeStatus: 'not_authorized' as const,
      deploymentStatus: 'not_authorized' as const,
      mergeAuthority: 'none' as const,
      deploymentAuthority: 'none' as const,
    },
  };
  const contentHash = deliverySha256(canonicalDeliveryJson(draft));
  const bundleId = `lrb-${contentHash.slice('sha256:'.length)}`;
  return LocalReviewBundleManifestSchema.parse({ ...draft, bundleId, contentHash });
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

async function assertOwnedPrivateDirectory(directory: string, expectedMode: number): Promise<fsSync.Stats> {
  const resolved = path.resolve(directory);
  const stat = await fs.lstat(resolved);
  const uid = currentUid();
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(resolved) !== resolved
    || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o777) !== expectedMode) {
    throw new ConflictError('Local review bundle artifact directory must be exact, owner-controlled, and private');
  }
  return stat;
}

async function ensureRoot(root: string): Promise<string> {
  const resolved = path.resolve(root);
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  await assertOwnedPrivateDirectory(resolved, 0o700);
  return resolved;
}

async function readRegularFile(filePath: string, maxBytes: number): Promise<Buffer> {
  const before = await fs.lstat(filePath);
  const uid = currentUid();
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || (uid !== undefined && before.uid !== uid) || before.size > maxBytes) {
    throw new ConflictError('Local review bundle projection contains an unsafe, linked, or oversized file');
  }
  const handle = await fs.open(filePath, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.nlink !== 1 || opened.size > maxBytes || (uid !== undefined && opened.uid !== uid)) {
      throw new ConflictError('Local review bundle projection file changed during bounded no-follow open');
    }
    const bytes = Buffer.alloc(Number(opened.size));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length) throw new ConflictError('Local review bundle projection file was truncated during read');
    const after = await fs.lstat(filePath);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino
      || after.nlink !== 1 || after.size !== opened.size
      || await fs.realpath(path.dirname(filePath)) !== path.dirname(filePath)) {
      throw new ConflictError('Local review bundle projection file changed during read');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, fsSync.constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeExclusive(filePath: string, content: Buffer | string): Promise<void> {
  const handle = await fs.open(
    filePath,
    fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | (fsSync.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyProjection(root: string, row: BundleRow): Promise<'verified' | 'missing' | 'corrupt'> {
  let dir: string;
  try { dir = safeProjectionPath(root, row.projection_key); } catch { return 'corrupt'; }
  try {
    await assertOwnedPrivateDirectory(dir, 0o500);
    const entries = (await fs.readdir(dir)).sort();
    if (entries.length !== 2 || entries[0] !== ARTIFACT_FILE || entries[1] !== MANIFEST_FILE) return 'corrupt';
    const manifestBytes = await readRegularFile(path.join(dir, MANIFEST_FILE), LOCAL_REVIEW_LIMITS.maxManifestBytes);
    const patchBytes = await readRegularFile(path.join(dir, ARTIFACT_FILE), LOCAL_REVIEW_LIMITS.maxPatchBytes);
    const manifest = assertBundleRowRelationships(row);
    const derivedContentHash = deliverySha256(manifestContentBasis(manifest));
    const digest = derivedContentHash.slice('sha256:'.length);
    if (derivedContentHash !== row.content_hash
      || manifest.contentHash !== row.content_hash
      || manifest.bundleId !== row.bundle_id
      || manifest.bundleId !== `lrb-${digest}`
      || row.projection_key !== `sha256/${digest.slice(0, 2)}/${digest}`
      || deliverySha256(manifestBytes) !== row.manifest_hash
      || canonicalDeliveryJson(manifest) !== manifestBytes.toString('utf8')
      || deliverySha256(patchBytes) !== manifest.artifacts[0].sha256
      || patchBytes.length !== manifest.artifacts[0].bytes) return 'corrupt';
    return 'verified';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'corrupt';
  }
}

async function projectBundle(root: string, manifest: LocalReviewBundleManifest, patch: Buffer): Promise<string> {
  const realRoot = await ensureRoot(root);
  const digest = manifest.contentHash.slice('sha256:'.length);
  const projectionKey = `sha256/${digest.slice(0, 2)}/${digest}`;
  const finalDir = safeProjectionPath(realRoot, projectionKey);
  const parent = path.dirname(finalDir);
  const stagingRoot = path.join(realRoot, '.staging');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await assertOwnedPrivateDirectory(parent, 0o700);
  await assertOwnedPrivateDirectory(stagingRoot, 0o700);
  const manifestJson = canonicalDeliveryJson(manifest);
  if (Buffer.byteLength(manifestJson) > LOCAL_REVIEW_LIMITS.maxManifestBytes) {
    throw new PayloadTooLargeError('Local review bundle manifest exceeds its limit');
  }
  try {
    await assertOwnedPrivateDirectory(finalDir, 0o500);
    const existingEntries = (await fs.readdir(finalDir)).sort();
    if (existingEntries.length !== 2 || existingEntries[0] !== ARTIFACT_FILE || existingEntries[1] !== MANIFEST_FILE) {
      throw new ConflictError('Content-addressed bundle projection has an unexpected file set');
    }
    const existingManifest = await readRegularFile(path.join(finalDir, MANIFEST_FILE), LOCAL_REVIEW_LIMITS.maxManifestBytes);
    const existingPatch = await readRegularFile(path.join(finalDir, ARTIFACT_FILE), LOCAL_REVIEW_LIMITS.maxPatchBytes);
    if (existingManifest.toString('utf8') !== manifestJson || !existingPatch.equals(patch)) {
      throw new ConflictError('Content-addressed bundle projection failed immutable integrity verification');
    }
    return projectionKey;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const stage = await fs.mkdtemp(path.join(stagingRoot, '.bundle-'));
  // Do not recursively delete a failed/concurrent stage by pathname. Node has
  // no portable descriptor-relative tree removal primitive, so restart
  // maintenance observes and audits crash-left stages without mutating them.
  // A successful rename makes `stage` absent; every other outcome is retained
  // under the private root for explicit operator maintenance.
  await writeExclusive(path.join(stage, ARTIFACT_FILE), patch);
  await writeExclusive(path.join(stage, MANIFEST_FILE), manifestJson);
  await fs.chmod(path.join(stage, ARTIFACT_FILE), 0o400);
  await fs.chmod(path.join(stage, MANIFEST_FILE), 0o400);
  await syncDirectory(stage);
  // Keep the staging directory owner-writable through the atomic rename;
  // macOS denies renaming a read-only directory in some sandboxed filesystems.
  try {
    await fs.rename(stage, finalDir);
    await fs.chmod(finalDir, 0o500);
    await syncDirectory(parent);
    await syncDirectory(stagingRoot);
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
    await assertOwnedPrivateDirectory(finalDir, 0o500);
    const existingEntries = (await fs.readdir(finalDir)).sort();
    if (existingEntries.length !== 2 || existingEntries[0] !== ARTIFACT_FILE || existingEntries[1] !== MANIFEST_FILE) {
      throw new ConflictError('Concurrent bundle projection has an unexpected file set');
    }
    const existingManifest = await readRegularFile(path.join(finalDir, MANIFEST_FILE), LOCAL_REVIEW_LIMITS.maxManifestBytes);
    const existingPatch = await readRegularFile(path.join(finalDir, ARTIFACT_FILE), LOCAL_REVIEW_LIMITS.maxPatchBytes);
    if (existingManifest.toString('utf8') !== manifestJson || !existingPatch.equals(patch)) {
      throw new ConflictError('Concurrent content-addressed bundle projection conflicts with immutable content');
    }
  }
  return projectionKey;
}

async function loadLockedCreationSnapshot(request: DeliveryCreateRequest, normalizedRequestHash: string): Promise<{
  authority: AuthorityRow;
  receipts: ValidationReceiptRow[];
  existing?: BundleRow;
  changedReplay: boolean;
}> {
  return transaction(async (client: PoolClient) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `pipeline-run-authority:${request.runId}`,
    ]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `local-review-bundle:${request.workspaceId}:${request.idempotencyKey}`,
    ]);
    // Authority is deliberately loaded before an existing row. Exact replay is
    // never allowed to bypass a stale generation, cancellation, fence, conflict,
    // host-attempt envelope, or actor binding.
    const { row: authority, receipts } = await loadAuthority(request, client);
    const existing = (await client.query<BundleRow>(`
      SELECT bundle.*, local_review_bundle_is_current(bundle.bundle_id) AS authority_current
        FROM local_review_bundles bundle
       WHERE bundle.workspace_id = $1 AND bundle.adapter_id = $2 AND bundle.idempotency_key = $3
       FOR SHARE
    `, [request.workspaceId, LOCAL_REVIEW_BUNDLE_ADAPTER_DESCRIPTOR.adapterId,
      request.idempotencyKey])).rows[0];
    if (!existing) return { authority, receipts, changedReplay: false };
    const exactIdentity = existing.host_attempt_envelope_id === authority.envelope_id
      && Number(existing.attempt) === request.attempt
      && existing.launch_generation === request.generation
      && existing.created_by === request.requestedBy;
    if (existing.request_hash === normalizedRequestHash && exactIdentity) {
      assertBundleRowRelationships(existing);
      return { authority, receipts, existing, changedReplay: false };
    }
    await client.query(`
      INSERT INTO local_review_bundle_conflicts (
        workspace_id, adapter_id, idempotency_key,
        existing_request_hash, conflicting_request_hash, reason_code, observed_by
      ) VALUES ($1,$2,$3,$4,$5,'changed_replay',$6)
    `, [request.workspaceId, LOCAL_REVIEW_BUNDLE_ADAPTER_DESCRIPTOR.adapterId,
      request.idempotencyKey, existing.request_hash, normalizedRequestHash, request.requestedBy]);
    return { authority, receipts, existing, changedReplay: true };
  });
}

async function persistBundle(input: {
  request: DeliveryCreateRequest;
  requestHash: string;
  manifest: LocalReviewBundleManifest;
  manifestHash: string;
  artifactRoot: string;
  patch: Buffer;
}): Promise<{ row: BundleRow; replayed: boolean; changedReplay?: { existingRequestHash: string } }> {
  return transaction(async (client: PoolClient) => {
    // Serialize with host conflict/cancellation authority before finalization.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `pipeline-run-authority:${input.request.runId}`,
    ]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `local-review-bundle:${input.request.workspaceId}:${input.request.idempotencyKey}`,
    ]);
    const digest = input.manifest.contentHash.slice('sha256:'.length);
    const expectedProjectionKey = `sha256/${digest.slice(0, 2)}/${digest}`;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `local-review-projection:${expectedProjectionKey}`,
    ]);
    const projectionKey = await projectBundle(input.artifactRoot, input.manifest, input.patch);
    if (projectionKey !== expectedProjectionKey) {
      throw new ConflictError('Local review bundle projection identity changed during finalization');
    }
    const existing = (await client.query<BundleRow>(`
      SELECT bundle.*, local_review_bundle_is_current(bundle.bundle_id) AS authority_current
        FROM local_review_bundles bundle
       WHERE bundle.workspace_id = $1 AND bundle.adapter_id = $2 AND bundle.idempotency_key = $3
       FOR SHARE
    `, [input.request.workspaceId, LOCAL_REVIEW_BUNDLE_ADAPTER_DESCRIPTOR.adapterId,
      input.request.idempotencyKey])).rows[0];
    if (existing) {
      if (existing.request_hash === input.requestHash) return { row: existing, replayed: true };
      await client.query(`
        INSERT INTO local_review_bundle_conflicts (
          workspace_id, adapter_id, idempotency_key,
          existing_request_hash, conflicting_request_hash, reason_code, observed_by
        ) VALUES ($1,$2,$3,$4,$5,'changed_replay',$6)
      `, [input.request.workspaceId, LOCAL_REVIEW_BUNDLE_ADAPTER_DESCRIPTOR.adapterId,
        input.request.idempotencyKey, existing.request_hash, input.requestHash,
        input.request.requestedBy]);
      return { row: existing, replayed: false, changedReplay: { existingRequestHash: existing.request_hash } };
    }
    const row = (await client.query<BundleRow>(`
      INSERT INTO local_review_bundles (
        bundle_id, contract_version, schema_version, adapter_id, adapter_version,
        workspace_id, spec_id, story_id, run_id, attempt, launch_generation,
        host_attempt_envelope_id, idempotency_key, request_hash, request_bytes, content_hash,
        manifest_hash, content_basis_bytes, manifest_bytes, projection_key, manifest_json,
        validation_status, merge_status, deployment_status, created_by, created_at, finalized_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,
        $22,'not_authorized','not_authorized',$23,$24::timestamptz,$24::timestamptz
      ) RETURNING *
    `, [
      input.manifest.bundleId, input.manifest.adapter.contractVersion,
      input.manifest.schemaVersion, input.manifest.adapter.adapterId,
      input.manifest.adapter.adapterVersion, input.manifest.identity.workspaceId,
      input.manifest.identity.specId, input.manifest.identity.storyId,
      input.manifest.identity.runId, input.manifest.identity.attempt,
      input.manifest.identity.generation, input.manifest.identity.hostAttemptEnvelopeId,
      input.manifest.idempotencyKey, input.requestHash, Buffer.from(requestBasis(input.request), 'utf8'),
      input.manifest.contentHash, input.manifestHash,
      Buffer.from(manifestContentBasis(input.manifest), 'utf8'),
      Buffer.from(canonicalDeliveryJson(input.manifest), 'utf8'), projectionKey,
      canonicalDeliveryJson(input.manifest), input.manifest.validation.status,
      input.request.requestedBy, input.manifest.createdAt,
    ])).rows[0];
    if (!row) throw new ConflictError('Local review bundle metadata was not finalized');
    return { row, replayed: false };
  });
}

function resultFromRow(row: BundleRow, replayed: boolean): DeliveryCreateResult {
  return {
    manifest: assertBundleRowRelationships(row),
    manifestHash: row.manifest_hash,
    projectionKey: row.projection_key,
    replayed,
  };
}

async function safeReadModel(row: BundleRow, root: string): Promise<LocalReviewBundleReadModel> {
  const manifest = assertBundleRowRelationships(row);
  const projectionIntegrity = await verifyProjection(root, row);
  return {
    schemaVersion: LOCAL_REVIEW_BUNDLE_READ_MODEL_VERSION,
    bundleId: row.bundle_id,
    adapter: {
      contractVersion: DELIVERY_ADAPTER_CONTRACT_VERSION,
      adapterId: LOCAL_REVIEW_BUNDLE_ADAPTER_ID,
      adapterVersion: manifest.adapter.adapterVersion,
      default: true,
      requiresNetwork: false,
      requiresCredentials: false,
    },
    identity: manifest.identity,
    specification: manifest.specification,
    repository: manifest.repository,
    changedFileCount: manifest.changedFiles.length,
    changedContentBytes: manifest.changedFiles.reduce((sum, file) => sum
      + (file.before?.bytes ?? 0) + (file.after?.bytes ?? 0), 0),
    artifacts: manifest.artifacts,
    validation: {
      status: manifest.validation.status,
      authoredBy: manifest.validation.authoredBy,
      receiptCount: manifest.validation.receipts.length,
      evidenceReferenceCount: manifest.evidenceReferences.length,
      rejectsAgentAuthoredPass: true,
    },
    createdAt: timestamp(row.created_at),
    projectionKey: row.projection_key,
    projectionIntegrity,
    delivery: manifest.delivery,
  };
}

export interface LocalReviewProjectionGcResult {
  scanned: number;
  deleted: number;
  referenced: number;
  stagingDeleted: number;
  retained: number;
  stagingObserved: number;
  plannedReconciled: number;
  operatorMaintenanceRequired: number;
}

interface PrivateTreeBudget {
  nodes: number;
  files: number;
  bytes: number;
}

async function assertAnchoredPath(root: string, rootIdentity: fsSync.Stats, candidate: string): Promise<void> {
  const rootNow = await fs.lstat(root);
  const relative = path.relative(root, candidate);
  if (rootNow.dev !== rootIdentity.dev || rootNow.ino !== rootIdentity.ino
    || rootNow.isSymbolicLink() || await fs.realpath(root) !== root
    || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ConflictError('Local review projection root or parent changed during maintenance observation');
  }
  let current = path.dirname(candidate);
  while (current !== root) {
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current) {
      throw new ConflictError('Local review projection parent changed during maintenance observation');
    }
    current = path.dirname(current);
  }
}

function sameFilesystemIdentity(left: fsSync.Stats, right: fsSync.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readDirectoryNamesBounded(
  root: string,
  rootIdentity: fsSync.Stats,
  directory: string,
  maxEntries: number,
): Promise<string[]> {
  await assertAnchoredPath(root, rootIdentity, directory);
  const before = await fs.lstat(directory);
  const uid = currentUid();
  if (!before.isDirectory() || before.isSymbolicLink()
    || (uid !== undefined && before.uid !== uid)) {
    throw new ConflictError('Local review projection maintenance rejects linked or foreign-owned directories');
  }
  const names: string[] = [];
  const opened = await fs.opendir(directory);
  try {
    for await (const entry of opened) {
      if (entry.name === '.' || entry.name === '..' || CONTROL_CHARACTER.test(entry.name)) {
        throw new ConflictError('Local review projection maintenance rejects unsafe directory entries');
      }
      names.push(entry.name);
      if (names.length > maxEntries) {
        throw new ConflictError('Local review projection maintenance directory count exceeds its limit');
      }
    }
  } finally {
    await opened.close().catch(() => undefined);
  }
  await assertAnchoredPath(root, rootIdentity, directory);
  const after = await fs.lstat(directory);
  if (!after.isDirectory() || after.isSymbolicLink() || !sameFilesystemIdentity(before, after)) {
    throw new ConflictError('Local review projection parent changed during maintenance observation');
  }
  return names.sort();
}

async function inspectPrivateTree(
  root: string,
  rootIdentity: fsSync.Stats,
  candidate: string,
  depth = 0,
  budget: PrivateTreeBudget = { nodes: 0, files: 0, bytes: 0 },
): Promise<PrivateTreeBudget> {
  if (depth > LOCAL_REVIEW_LIMITS.maxProjectionDepth) {
    throw new ConflictError('Local review projection maintenance traversal depth exceeds its limit');
  }
  await assertAnchoredPath(root, rootIdentity, candidate);
  const before = await fs.lstat(candidate);
  const uid = currentUid();
  if (before.isSymbolicLink() || (uid !== undefined && before.uid !== uid)) {
    throw new ConflictError('Local review projection maintenance rejects linked or foreign-owned candidates');
  }
  budget.nodes += 1;
  if (budget.nodes > LOCAL_REVIEW_LIMITS.maxProjectionFiles) {
    throw new ConflictError('Local review projection maintenance node count exceeds its limit');
  }
  if (before.isDirectory()) {
    const entries = await readDirectoryNamesBounded(
      root, rootIdentity, candidate, LOCAL_REVIEW_LIMITS.maxProjectionFiles,
    );
    for (const child of entries) {
      await inspectPrivateTree(root, rootIdentity, path.join(candidate, child), depth + 1, budget);
    }
  } else {
    if (!before.isFile() || before.nlink !== 1) {
      throw new ConflictError('Local review projection maintenance rejects non-regular or hard-linked candidates');
    }
    budget.files += 1;
    budget.bytes += before.size;
    if (budget.files > LOCAL_REVIEW_LIMITS.maxProjectionFiles
      || budget.bytes > LOCAL_REVIEW_LIMITS.maxProjectionBytes
      || before.size > LOCAL_REVIEW_LIMITS.maxPatchBytes) {
      throw new ConflictError('Local review projection maintenance file or byte bounds exceeded');
    }
  }
  await assertAnchoredPath(root, rootIdentity, candidate);
  const after = await fs.lstat(candidate);
  if (!sameFilesystemIdentity(before, after) || after.isSymbolicLink()
    || before.isDirectory() !== after.isDirectory() || before.isFile() !== after.isFile()
    || (!before.isDirectory() && (before.size !== after.size || after.nlink !== 1))) {
    throw new ConflictError('Local review projection changed during maintenance observation');
  }
  return budget;
}

function stagingObservationIdentity(entryName: string): { projectionKey: string; digest: string } {
  const contentHash = deliverySha256(`staging:${entryName}`);
  const digest = contentHash.slice('sha256:'.length);
  return { projectionKey: `staging/sha256/${digest}`, digest };
}

/**
 * Bounded restart maintenance for immutable local-review artifacts.
 *
 * Node does not expose a portable descriptor-relative recursive removal
 * primitive. This routine therefore never chmods, renames, unlinks, or removes
 * a descendant. It observes stale content-addressed or crash-left staging trees,
 * preserves canonical references, reconciles historical `planned` actions, and
 * appends only truthful non-destructive/operator-maintenance outcomes.
 */
export async function collectUnreferencedLocalReviewProjections(input: {
  artifactRoot?: string;
  limit?: number;
  minAgeMs?: number;
  observedBy?: string;
} = {}): Promise<LocalReviewProjectionGcResult> {
  const limit = input.limit ?? 16;
  const minAgeMs = input.minAgeMs ?? 24 * 60 * 60 * 1000;
  const observedBy = String(input.observedBy ?? 'rorca-local-delivery-maintenance').trim();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || !Number.isSafeInteger(minAgeMs) || minAgeMs < 0
    || !observedBy || observedBy.length > 255 || CONTROL_CHARACTER.test(observedBy)) {
    throw new ValidationError('Invalid bounded local review projection maintenance request');
  }
  const result: LocalReviewProjectionGcResult = {
    scanned: 0,
    deleted: 0,
    referenced: 0,
    stagingDeleted: 0,
    retained: 0,
    stagingObserved: 0,
    plannedReconciled: 0,
    operatorMaintenanceRequired: 0,
  };
  const root = path.resolve(input.artifactRoot ?? defaultArtifactRoot());
  let rootIdentity: fsSync.Stats;
  try {
    rootIdentity = await assertOwnedPrivateDirectory(root, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }
  const cutoff = Date.now() - minAgeMs;
  const processed = new Set<string>();

  type MaintenanceAction = 'preserved' | 'retained' | 'operator_maintenance_required';
  type MaintenanceReason = 'canonical_reference_present' | 'automatic_deletion_unsupported'
    | 'staging_restart_recovery' | 'unsafe_projection_tree' | 'prior_action_outcome_indeterminate';
  const appendAction = async (
    client: PoolClient,
    projectionKey: string,
    digest: string,
    actionType: MaintenanceAction,
    reasonCode: MaintenanceReason,
    detailCode?: string,
  ): Promise<void> => {
    await client.query(`
      INSERT INTO local_review_projection_gc_actions(
        projection_key,content_hash,action_type,reason_code,observed_by,detail_code
      ) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT (projection_key,action_type) DO NOTHING
    `, [projectionKey, `sha256:${digest}`, actionType, reasonCode, observedBy, detailCode ?? null]);
  };

  const recordProjection = async (
    projectionKey: string,
    digest: string,
    candidate: string,
    priorPlanned: boolean,
  ): Promise<void> => {
    try {
      await inspectPrivateTree(root, rootIdentity, candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && priorPlanned) {
        await transaction(async (client: PoolClient) => {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
            `local-review-projection:${projectionKey}`,
          ]);
          await appendAction(client, projectionKey, digest, 'operator_maintenance_required',
            'prior_action_outcome_indeterminate', 'planned_candidate_missing');
        });
        result.plannedReconciled += 1;
        result.operatorMaintenanceRequired += 1;
        return;
      }
      await transaction(async (client: PoolClient) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `local-review-projection:${projectionKey}`,
        ]);
        await appendAction(client, projectionKey, digest, 'operator_maintenance_required',
          'unsafe_projection_tree', 'bounded_no_follow_observation_failed');
      }).catch(() => undefined);
      result.operatorMaintenanceRequired += 1;
      throw error;
    }

    const disposition = await transaction(async (client: PoolClient) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `local-review-projection:${projectionKey}`,
      ]);
      const referenced = (await client.query<{ bundle_id: string }>(`
        SELECT bundle_id FROM local_review_bundles WHERE projection_key=$1 FOR SHARE
      `, [projectionKey])).rows[0];
      if (referenced) {
        await appendAction(client, projectionKey, digest, 'preserved',
          'canonical_reference_present', priorPlanned ? 'planned_action_reconciled_reference' : undefined);
        return 'referenced' as const;
      }
      await appendAction(client, projectionKey, digest, 'retained',
        'automatic_deletion_unsupported', priorPlanned
          ? 'planned_action_reconciled_without_deletion'
          : 'operator_maintenance_required');
      return 'retained' as const;
    });
    if (priorPlanned) result.plannedReconciled += 1;
    if (disposition === 'referenced') result.referenced += 1;
    else {
      result.retained += 1;
      result.operatorMaintenanceRequired += 1;
    }
  };

  const plannedRows = await transaction(async (client: PoolClient) => (
    await client.query<{ projection_key: string; content_hash: string }>(`
      SELECT planned.projection_key,planned.content_hash
        FROM local_review_projection_gc_actions planned
       WHERE planned.action_type='planned'
         AND planned.projection_key LIKE 'sha256/%'
         AND NOT EXISTS (
           SELECT 1 FROM local_review_projection_gc_actions outcome
            WHERE outcome.projection_key=planned.projection_key
              AND outcome.action_type IN ('deleted','preserved','retained','operator_maintenance_required')
         )
       ORDER BY planned.observed_at,planned.action_id
       LIMIT $1
    `, [limit])
  ).rows);
  for (const planned of plannedRows) {
    if (result.scanned >= limit || !PROJECTION_PATTERN.test(planned.projection_key)
      || planned.content_hash !== `sha256:${planned.projection_key.slice(-64)}`) continue;
    const digest = planned.projection_key.slice(-64);
    const candidate = safeProjectionPath(root, planned.projection_key);
    processed.add(planned.projection_key);
    result.scanned += 1;
    await recordProjection(planned.projection_key, digest, candidate, true);
  }

  const shaRoot = path.join(root, 'sha256');
  let prefixes: string[] = [];
  try {
    await assertOwnedPrivateDirectory(shaRoot, 0o700);
    prefixes = await readDirectoryNamesBounded(
      root, rootIdentity, shaRoot, LOCAL_REVIEW_LIMITS.maxMaintenanceEntriesPerDirectory,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const prefix of prefixes) {
    if (!/^[0-9a-f]{2}$/.test(prefix) || result.scanned >= limit) continue;
    const prefixPath = path.join(shaRoot, prefix);
    await assertOwnedPrivateDirectory(prefixPath, 0o700);
    const digests = await readDirectoryNamesBounded(
      root, rootIdentity, prefixPath, LOCAL_REVIEW_LIMITS.maxMaintenanceEntriesPerDirectory,
    );
    for (const digest of digests) {
      if (result.scanned >= limit) break;
      const projectionKey = `sha256/${prefix}/${digest}`;
      if (!/^[0-9a-f]{64}$/.test(digest) || digest.slice(0, 2) !== prefix
        || processed.has(projectionKey)) continue;
      const candidate = safeProjectionPath(root, projectionKey);
      const stat = await fs.lstat(candidate);
      if (stat.mtimeMs > cutoff) continue;
      processed.add(projectionKey);
      result.scanned += 1;
      await recordProjection(projectionKey, digest, candidate, false);
    }
  }

  const stagingRoot = path.join(root, '.staging');
  let stages: string[] = [];
  try {
    await assertOwnedPrivateDirectory(stagingRoot, 0o700);
    stages = await readDirectoryNamesBounded(
      root, rootIdentity, stagingRoot, LOCAL_REVIEW_LIMITS.maxMaintenanceEntriesPerDirectory,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const stageName of stages) {
    if (result.scanned >= limit) break;
    const stage = path.join(stagingRoot, stageName);
    await assertAnchoredPath(root, rootIdentity, stage);
    const stat = await fs.lstat(stage);
    if (stat.mtimeMs > cutoff) continue;
    const { projectionKey, digest } = stagingObservationIdentity(stageName);
    result.scanned += 1;
    result.stagingObserved += 1;
    try {
      if (!/^\.bundle-[A-Za-z0-9_-]{1,120}$/.test(stageName)) {
        throw new ConflictError('Local review projection maintenance rejects an invalid staging identity');
      }
      await inspectPrivateTree(root, rootIdentity, stage);
      await transaction(async (client: PoolClient) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `local-review-staging:${digest}`,
        ]);
        await appendAction(client, projectionKey, digest, 'retained',
          'staging_restart_recovery', 'operator_maintenance_required');
      });
      result.retained += 1;
      result.operatorMaintenanceRequired += 1;
    } catch (error) {
      await transaction(async (client: PoolClient) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `local-review-staging:${digest}`,
        ]);
        await appendAction(client, projectionKey, digest, 'operator_maintenance_required',
          'unsafe_projection_tree', 'staging_observation_failed');
      }).catch(() => undefined);
      result.operatorMaintenanceRequired += 1;
      throw error;
    }
  }
  await assertAnchoredPath(root, rootIdentity, path.join(root, '.maintenance-complete'));
  return result;
}

export class LocalReviewBundleAdapter implements DeliveryAdapter {
  readonly descriptor = LOCAL_REVIEW_BUNDLE_ADAPTER_DESCRIPTOR;
  readonly artifactRoot: string;

  constructor(options: { artifactRoot?: string } = {}) {
    this.artifactRoot = path.resolve(options.artifactRoot ?? defaultArtifactRoot());
  }

  async create(rawRequest: DeliveryCreateRequest): Promise<DeliveryCreateResult> {
    const request = normalizeRequest(rawRequest);
    // Projection observation is a separate explicit maintenance operation. Creation must
    // perform no unrelated mutation before exact target/authority validation.
    const normalizedRequestHash = requestHash(request);
    const snapshot = await loadLockedCreationSnapshot(request, normalizedRequestHash);
    if (snapshot.changedReplay) {
      throw new ConflictError('Local review bundle idempotency key was replayed with a changed payload');
    }
    if (snapshot.existing) {
      const integrity = await verifyProjection(this.artifactRoot, snapshot.existing);
      if (integrity !== 'verified') throw new ConflictError(`Local review bundle projection integrity is ${integrity}`);
      return resultFromRow(snapshot.existing, true);
    }

    const { authority, receipts } = snapshot;
    const observed = validateAuthority(authority);
    const { files } = collectChangedFiles(observed.worktreeRealpath, authority.observed_git_sha, observed.headSha);
    const patch = createPatch(observed.worktreeRealpath, authority.observed_git_sha, observed.headSha);
    const reobserved = validateAuthority(authority);
    if (reobserved.headSha !== observed.headSha
      || reobserved.repositoryRealpath !== observed.repositoryRealpath
      || reobserved.worktreeRealpath !== observed.worktreeRealpath) {
      throw new ConflictError('Local review bundle authority changed during finalization');
    }
    const manifest = buildManifest({
      request,
      authority,
      receipts,
      changedFiles: files,
      patch,
      headSha: observed.headSha,
      createdAt: timestamp(authority.attempt_completed_at!),
    });
    const manifestHash = deliverySha256(canonicalDeliveryJson(manifest));
    const persisted = await persistBundle({
      request, requestHash: normalizedRequestHash, manifest, manifestHash,
      artifactRoot: this.artifactRoot, patch,
    });
    if (persisted.changedReplay) {
      throw new ConflictError('Local review bundle idempotency key was replayed with a changed payload');
    }
    const integrity = await verifyProjection(this.artifactRoot, persisted.row);
    if (integrity !== 'verified') throw new ConflictError(`Finalized local review bundle projection integrity is ${integrity}`);
    return resultFromRow(persisted.row, persisted.replayed);
  }
}

export async function getLocalReviewBundle(input: {
  workspaceId: string;
  runId: number;
  bundleId: string;
  artifactRoot?: string;
}): Promise<LocalReviewBundleReadModel> {
  assertNotProtectedWave1Run(input.runId);
  if (!SAFE_ID.test(input.workspaceId) || !Number.isSafeInteger(input.runId) || input.runId <= 0
    || !/^lrb-[0-9a-f]{64}$/.test(input.bundleId)) {
    throw new ValidationError('Invalid local review bundle read identity');
  }
  const row = await queryOne<BundleRow>(`
    SELECT bundle.*, local_review_bundle_is_current(bundle.bundle_id) AS authority_current
      FROM local_review_bundles bundle
     WHERE bundle.workspace_id = $1 AND bundle.run_id = $2 AND bundle.bundle_id = $3
  `, [input.workspaceId, input.runId, input.bundleId]);
  if (!row) throw new NotFoundError('Local review bundle', input.bundleId);
  return safeReadModel(row, path.resolve(input.artifactRoot ?? defaultArtifactRoot()));
}

export async function listLocalReviewBundles(input: {
  workspaceId: string;
  runId?: number;
  limit?: number;
  artifactRoot?: string;
}): Promise<LocalReviewBundleListResult> {
  if (!SAFE_ID.test(input.workspaceId)) throw new ValidationError('Invalid local review bundle workspace identity');
  if (input.runId !== undefined) assertNotProtectedWave1Run(input.runId);
  if (input.runId !== undefined && (!Number.isSafeInteger(input.runId) || input.runId <= 0)) {
    throw new ValidationError('Invalid local review bundle run filter');
  }
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError('Local review bundle limit must be an integer from 1 to 100');
  }
  const rows = await query<BundleRow>(`
    SELECT bundle.*, local_review_bundle_is_current(bundle.bundle_id) AS authority_current
      FROM local_review_bundles bundle
     WHERE bundle.workspace_id = $1
       AND bundle.run_id <> $4
       AND ($2::bigint IS NULL OR bundle.run_id = $2)
     ORDER BY bundle.finalized_at DESC, bundle.bundle_id DESC LIMIT $3
  `, [input.workspaceId, input.runId ?? null, limit, WAVE_1_PROTECTED_GENESIS_RUN_ID]);
  const root = path.resolve(input.artifactRoot ?? defaultArtifactRoot());
  return {
    schemaVersion: LOCAL_REVIEW_BUNDLE_READ_MODEL_VERSION,
    items: await Promise.all(rows.map((row) => safeReadModel(row, root))),
    limit,
  };
}

export function localReviewBundleAdapterVersion(): string {
  return LOCAL_REVIEW_BUNDLE_ADAPTER_VERSION;
}
