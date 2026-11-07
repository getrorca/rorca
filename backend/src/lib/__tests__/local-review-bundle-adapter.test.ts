/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const queryMock = jest.fn();
const queryOneMock = jest.fn();
const transactionMock = jest.fn();

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  queryOne: (...args: unknown[]) => queryOneMock(...args),
  transaction: (...args: unknown[]) => transactionMock(...args),
}));

import { retryHash } from '../retry-governance';
import { deriveStoryContractRevision } from '../story-execution-packet';
import {
  canonicalDeliveryJson,
  deliverySha256,
  getDeliveryAdapterCatalog,
  LocalReviewBundleManifestSchema,
  LocalReviewBundleReadModelSchema,
} from '../delivery-adapter';
import {
  collectUnreferencedLocalReviewProjections,
  getLocalReviewBundle,
  listLocalReviewBundles,
  LocalReviewBundleAdapter,
} from '../local-review-bundle-adapter';

const SHA = (char: string) => `sha256:${char.repeat(64)}`;
const EXACT_ATTEMPT = {
  attempt: 1,
  generation: '22222222-2222-4222-8222-222222222222',
  hostAttemptEnvelopeId: '11111111-1111-4111-8111-111111111111',
} as const;

interface Fixture {
  root: string;
  repo: string;
  artifacts: string;
  baseSha: string;
  headSha: string;
  authority: Record<string, unknown>;
  receipt: Record<string, unknown>;
}

interface StoredRow {
  [key: string]: unknown;
  bundle_id: string;
  request_hash: string;
  projection_key: string;
  manifest_hash: string;
  manifest_json: unknown;
}

let fixture: Fixture;
let stored: StoredRow | undefined;
let failBundleInsert = false;
const conflicts: unknown[][] = [];
const gcActions: string[] = [];
const gcActionRows: unknown[][] = [];
const plannedGcRows: Array<{ projection_key: string; content_hash: string }> = [];
let failMaintenanceQuery: 'planned-load' | 'action-insert' | undefined;
let failTransactionAfterOperationAt: number | undefined;
let transactionOperationCount = 0;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function commitFile(repo: string, filePath: string, content: string | Buffer): void {
  const absolute = path.join(repo, filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  git(repo, ['add', '--', filePath]);
  git(repo, ['-c', 'user.name=Test Host', '-c', 'user.email=host@rorca.test', 'commit', '-m', `change ${filePath}`]);
}

function makeFixture(change: (repo: string) => void = (repo) => commitFile(repo, 'src/value.txt', 'after\n')): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-local-review-')));
  const repo = path.join(root, 'repo');
  const artifacts = path.join(root, 'artifacts');
  fs.mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  fs.mkdirSync(path.join(repo, 'forge/specs/approved'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const specBytes = Buffer.from('{"id":"spec-one","userStories":[{"id":"US-001"}]}\n');
  fs.writeFileSync(path.join(repo, 'forge/specs/approved/spec-one.json'), specBytes);
  fs.writeFileSync(path.join(repo, 'src/value.txt'), 'before\n');
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=Test Host', '-c', 'user.email=host@rorca.test', 'commit', '-m', 'base']);
  const baseSha = git(repo, ['rev-parse', 'HEAD']);
  change(repo);
  const headSha = git(repo, ['rev-parse', 'HEAD']);
  const stat = fs.statSync(repo);
  const identity = retryHash({ realpath: repo, device: String(stat.dev), inode: String(stat.ino) });
  const canonicalSpec = JSON.parse(specBytes.toString('utf8')) as unknown;
  const canonicalRevision = deriveStoryContractRevision(canonicalSpec);
  const authority = {
    envelope_id: '11111111-1111-4111-8111-111111111111',
    workspace_id: 'workspace-one',
    run_id: 42,
    story_id: 'US-001',
    attempt: 1,
    launch_generation: '22222222-2222-4222-8222-222222222222',
    cancellation_fence: SHA('9'),
    manifest_hash: SHA('a'),
    spec_id: 'spec-one',
    spec_revision: canonicalRevision,
    story_revision: SHA('c'),
    canonical_spec_path: 'forge/specs/approved/spec-one.json',
    canonical_spec_revision: canonicalRevision,
    canonical_spec_bytes_hash: deliverySha256(specBytes),
    repository_realpath: repo,
    repository_identity: SHA('d'),
    base_git_sha: baseSha,
    observed_git_sha: baseSha,
    worktree_realpath: repo,
    worktree_identity: identity,
    worktree_branch: 'main',
    payload_hash: SHA('e'),
    authority_state: 'valid',
    outcome: 'success',
    outcome_provenance: 'host_process',
    exit_code: 0,
    exit_signal: null,
    attempt_completed_at: '2026-07-28T12:00:00.000Z',
    run_workspace_id: 'workspace-one',
    run_spec_path: 'forge/specs/approved/spec-one.json',
    run_dispatch_fence: SHA('9'),
    cancellation_requested: false,
    run_branch_name: 'main',
    run_worktree_path: repo,
    workspace_path: repo,
    story_result_id: 900,
    story_result_status: 'pass',
    story_commit_sha: headSha,
    story_result_count: 1,
    result_provenance: 'host',
    result_source: 'execution-engine',
    result_integrated: true,
    result_commit_author: 'rorca-execution-engine',
    result_commit_branch: 'main',
    result_worktree_path: repo,
    attempt_result_id: `ATR-${SHA('f')}`,
    closeout_decision_id: `CLO-${SHA('1')}`,
    closeout_status: 'accepted',
    closeout_manifest_hash: SHA('a'),
    closeout_decision_count: 1,
    host_closeout_event_id: 901,
    host_closeout_identity_hash: SHA('2'),
    exact_host_pass: true,
  };
  const receipt = {
    id: '33333333-3333-4333-8333-333333333333',
    validation_gate: 'execution-engine',
    checkpoint_sha: headSha,
    evidence_digest: '3'.repeat(64),
    passed_at: '2026-07-28T00:00:00.000Z',
    expires_at: '2099-07-28T00:00:00.000Z',
    revoked_at: null,
  };
  return { root, repo, artifacts, baseSha, headSha, authority, receipt };
}

function installDbMocks(): void {
  queryOneMock.mockImplementation((sql: string, params: unknown[]) => {
    if (sql.includes('FROM local_review_bundles')) {
      if (!stored) return undefined;
      if (sql.includes('bundle_id = $2') && params[1] !== stored.bundle_id) return undefined;
      return stored;
    }
    if (sql.includes('FROM host_story_attempt_envelopes')) return fixture.authority;
    throw new Error(`Unexpected queryOne: ${sql}`);
  });
  queryMock.mockImplementation((sql: string, params: unknown[]) => {
    if (sql.includes('FROM checkpoint_validation_attestations')) return [fixture.receipt];
    if (sql.includes('INSERT INTO local_review_bundle_conflicts')) {
      conflicts.push(params);
      return [];
    }
    if (sql.includes('FROM local_review_bundles')) return stored ? [stored] : [];
    throw new Error(`Unexpected query: ${sql}`);
  });
  transactionMock.mockImplementation(async (operation: (client: { query: typeof queryMock }) => Promise<unknown>) => {
    const client = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (sql.includes('FROM host_story_attempt_envelopes')) {
          const exact = params[4] === fixture.authority.launch_generation
            && params[5] === fixture.authority.envelope_id;
          return { rows: exact ? [fixture.authority] : [], rowCount: exact ? 1 : 0 };
        }
        if (sql.includes('FROM checkpoint_validation_attestations')) return { rows: [fixture.receipt], rowCount: 1 };
        if (sql.includes('FROM local_review_bundles')) return { rows: stored ? [stored] : [], rowCount: stored ? 1 : 0 };
        if (sql.includes('INSERT INTO local_review_bundle_conflicts')) {
          conflicts.push(params);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('FROM local_review_projection_gc_actions planned')) {
          if (failMaintenanceQuery === 'planned-load') throw new Error('synthetic maintenance plan load failure');
          const terminal = new Set(gcActionRows
            .filter((row) => ['deleted', 'preserved', 'retained', 'operator_maintenance_required'].includes(String(row[2])))
            .map((row) => String(row[0])));
          const rows = plannedGcRows.filter((row) => !terminal.has(row.projection_key));
          return { rows, rowCount: rows.length };
        }
        if (sql.includes('INSERT INTO local_review_projection_gc_actions')) {
          if (failMaintenanceQuery === 'action-insert') throw new Error('synthetic maintenance audit failure');
          gcActions.push(String(params[2]));
          gcActionRows.push(params);
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO local_review_projection_gc_audits')) return { rows: [], rowCount: 1 };
        if (sql.includes('INSERT INTO local_review_bundles')) {
          if (failBundleInsert) throw new Error('synthetic database finalization failure');
          const manifest = JSON.parse(String(params[20])) as Record<string, unknown>;
          stored = {
            bundle_id: String(params[0]),
            contract_version: String(params[1]),
            schema_version: String(params[2]),
            adapter_id: String(params[3]),
            adapter_version: String(params[4]),
            workspace_id: String(params[5]),
            spec_id: String(params[6]),
            story_id: String(params[7]),
            run_id: Number(params[8]),
            attempt: Number(params[9]),
            launch_generation: String(params[10]),
            host_attempt_envelope_id: String(params[11]),
            idempotency_key: String(params[12]),
            request_hash: String(params[13]),
            content_hash: String(params[15]),
            manifest_hash: String(params[16]),
            projection_key: String(params[19]),
            manifest_json: manifest,
            validation_status: String(params[21]),
            merge_status: 'not_authorized',
            deployment_status: 'not_authorized',
            created_by: String(params[22]),
            created_at: String(params[23]),
            finalized_at: String(params[23]),
            authority_current: true,
          };
          return { rows: [stored], rowCount: 1 };
        }
        throw new Error(`Unexpected client query: ${sql}`);
      }),
    };
    transactionOperationCount += 1;
    const result = await operation(client);
    if (failTransactionAfterOperationAt === transactionOperationCount) {
      throw new Error('synthetic transaction commit failure');
    }
    return result;
  });
}

function unlockTree(root: string): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      fs.chmodSync(candidate, 0o700);
      unlockTree(candidate);
    } else {
      fs.chmodSync(candidate, 0o600);
    }
  }
}

async function createOrphan(idempotencyKey: string): Promise<{ projectionKey: string; candidate: string; digest: string }> {
  failBundleInsert = true;
  await expect(new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts }).create({
    workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', ...EXACT_ATTEMPT,
    idempotencyKey, requestedBy: 'local-admin',
  })).rejects.toThrow(/synthetic database finalization failure/);
  failBundleInsert = false;
  const shaRoot = path.join(fixture.artifacts, 'sha256');
  const prefix = fs.readdirSync(shaRoot)[0];
  const digest = fs.readdirSync(path.join(shaRoot, prefix))[0];
  return {
    projectionKey: `sha256/${prefix}/${digest}`,
    candidate: path.join(shaRoot, prefix, digest),
    digest,
  };
}

function immutableTreeSnapshot(root: string): string[] {
  const rows: string[] = [];
  const visit = (candidate: string, relative: string): void => {
    const stat = fs.lstatSync(candidate);
    const kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';
    const content = stat.isFile() ? deliverySha256(fs.readFileSync(candidate))
      : stat.isSymbolicLink() ? fs.readlinkSync(candidate) : '';
    rows.push([relative, kind, stat.mode & 0o777, stat.dev, stat.ino, stat.nlink, stat.size, content].join('|'));
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(candidate).sort()) visit(path.join(candidate, name), path.join(relative, name));
    }
  };
  visit(root, '.');
  return rows;
}

beforeEach(() => {
  jest.clearAllMocks();
  stored = undefined;
  failBundleInsert = false;
  conflicts.length = 0;
  gcActions.length = 0;
  gcActionRows.length = 0;
  plannedGcRows.length = 0;
  failMaintenanceQuery = undefined;
  failTransactionAfterOperationAt = undefined;
  transactionOperationCount = 0;
  fixture = makeFixture();
  installDbMocks();
});

afterEach(() => {
  unlockTree(fixture.root);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test('adapter source has no provider/network actuator and disables Git credential/lazy-fetch paths', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'local-review-bundle-adapter.ts'), 'utf8');
  expect(source).not.toMatch(/fetchGithub|resolveWorkspaceGitHubToken|github-app-credential-provider|\bhttps?:\/\//);
  expect(source).not.toMatch(/\['(?:fetch|push|pull|clone|ls-remote)'/);
  expect(source).toContain("GIT_TERMINAL_PROMPT: '0'");
  expect(source).toContain("GIT_NO_LAZY_FETCH: '1'");
  expect(source).toContain("'-c', 'credential.helper='");
});

test('catalog makes credential-free local delivery canonical and keeps GitHub optional', () => {
  const catalog = getDeliveryAdapterCatalog();
  expect(catalog.defaultAdapterId).toBe('local-review-bundle');
  expect(catalog.adapters[0]).toMatchObject({ default: true, requiresNetwork: false, requiresCredentials: false });
  expect(catalog.adapters[1]).toMatchObject({ adapterId: 'github-app', optional: true, default: false, requiresNetwork: true });
  expect(catalog.adapters.every((adapter) => adapter.mergeAuthority === 'none' && adapter.deploymentAuthority === 'none')).toBe(true);
});

test('creates an atomic content-addressed bundle from exact host evidence without merge or deploy authority', async () => {
  const adapter = new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts });
  const result = await adapter.create({
    workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', ...EXACT_ATTEMPT,
    idempotencyKey: 'review:workspace-one:42:US-001', requestedBy: 'local-admin',
  });
  expect(result.replayed).toBe(false);
  expect(LocalReviewBundleManifestSchema.parse(result.manifest)).toEqual(result.manifest);
  expect(result.manifest).toMatchObject({
    validation: {
      status: 'passed', authoredBy: 'host_closeout', agentProseAccepted: false,
      ptyAccepted: false, processExitAcceptedAsPass: false, memoryAccepted: false,
    },
    delivery: {
      reviewStatus: 'awaiting_local_review', mergeStatus: 'not_authorized',
      deploymentStatus: 'not_authorized', mergeAuthority: 'none', deploymentAuthority: 'none',
    },
  });
  expect(result.manifest.repository).toMatchObject({ baseSha: fixture.baseSha, headSha: fixture.headSha, branch: 'main' });
  expect(result.manifest.changedFiles).toHaveLength(1);
  expect(result.manifest.changedFiles[0]).toMatchObject({ path: 'src/value.txt', change: 'modified' });
  const projection = path.join(fixture.artifacts, ...result.projectionKey.split('/'));
  expect(fs.statSync(path.join(projection, 'manifest.json')).mode & 0o777).toBe(0o400);
  expect(fs.statSync(path.join(projection, 'changes.patch')).mode & 0o777).toBe(0o400);
  expect(fs.statSync(projection).mode & 0o777).toBe(0o500);
  expect(canonicalDeliveryJson(result.manifest)).toBe(fs.readFileSync(path.join(projection, 'manifest.json'), 'utf8'));
});

test('exact duplicate is idempotent across adapter restart and changed replay conflicts are audited', async () => {
  const request = {
    workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', ...EXACT_ATTEMPT,
    idempotencyKey: 'review:workspace-one:42:US-001', requestedBy: 'local-admin',
  };
  const first = await new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts }).create(request);
  const replay = await new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts }).create(request);
  expect(replay.replayed).toBe(true);
  expect(replay.manifest.bundleId).toBe(first.manifest.bundleId);
  expect(transactionMock).toHaveBeenCalledTimes(3);

  await expect(new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts }).create({
    ...request, storyId: 'US-CHANGED',
  })).rejects.toThrow(/changed payload/);
  expect(conflicts).toHaveLength(1);
  expect(JSON.stringify(conflicts)).not.toContain(fixture.repo);
});

test('safe read model verifies restart integrity and omits paths, changed filenames, idempotency keys, and receipt ids', async () => {
  const adapter = new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts });
  const created = await adapter.create({
    workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', ...EXACT_ATTEMPT,
    idempotencyKey: 'review:workspace-one:42:US-001', requestedBy: 'local-admin',
  });
  const detail = await getLocalReviewBundle({ workspaceId: 'workspace-one', runId: 42, bundleId: created.manifest.bundleId, artifactRoot: fixture.artifacts });
  const list = await listLocalReviewBundles({ workspaceId: 'workspace-one', runId: 42, artifactRoot: fixture.artifacts });
  expect(LocalReviewBundleReadModelSchema.parse(detail)).toEqual(detail);
  expect(detail.projectionIntegrity).toBe('verified');
  expect(list.items).toEqual([detail]);
  const serialized = JSON.stringify(detail);
  expect(serialized).not.toContain(fixture.repo);
  expect(serialized).not.toContain('src/value.txt');
  expect(serialized).not.toContain('review:workspace-one');
  expect(serialized).not.toContain(String(fixture.receipt.id));
  expect(serialized).not.toMatch(/rawTranscript|github_pat_|Bearer\s|password/i);
});

test('actor and exact generation are part of replay authority', async () => {
  const request = {
    workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', ...EXACT_ATTEMPT,
    idempotencyKey: 'review:workspace-one:42:US-001', requestedBy: 'local-admin',
  };
  await new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts }).create(request);
  await expect(new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts }).create({
    ...request, requestedBy: 'different-admin',
  })).rejects.toThrow(/changed payload/);
  expect(conflicts).toHaveLength(1);

  stored = undefined;
  await expect(new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts }).create({
    ...request, idempotencyKey: 'review:workspace-one:42:stale-generation',
    generation: '44444444-4444-4444-8444-444444444444',
  })).rejects.toThrow(/Exact host story attempt authority/);
});

test('maintenance does not create a missing artifact root', async () => {
  const missing = path.join(fixture.root, 'missing-artifact-root');
  const result = await collectUnreferencedLocalReviewProjections({
    artifactRoot: missing, minAgeMs: 0, observedBy: 'missing-root-test',
  });
  expect(result).toMatchObject({ scanned: 0, deleted: 0, retained: 0, stagingObserved: 0 });
  expect(fs.existsSync(missing)).toBe(false);
  expect(transactionMock).not.toHaveBeenCalled();
});

test('bounded restart maintenance retains stale orphans and never changes referenced artifacts', async () => {
  const request = {
    workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', ...EXACT_ATTEMPT,
    idempotencyKey: 'review:workspace-one:42:gc', requestedBy: 'local-admin',
  };
  failBundleInsert = true;
  await expect(new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts }).create(request))
    .rejects.toThrow(/synthetic database finalization failure/);
  failBundleInsert = false;
  const shaRoot = path.join(fixture.artifacts, 'sha256');
  expect(fs.existsSync(shaRoot)).toBe(true);
  const collected = await collectUnreferencedLocalReviewProjections({
    artifactRoot: fixture.artifacts, minAgeMs: 0, limit: 10, observedBy: 'unit-test-gc',
  });
  expect(collected).toMatchObject({
    scanned: 1, deleted: 0, referenced: 0, retained: 1, operatorMaintenanceRequired: 1,
  });
  expect(gcActions).toEqual(expect.arrayContaining(['retained']));
  expect(fs.existsSync(path.join(
    shaRoot, fs.readdirSync(shaRoot)[0], fs.readdirSync(path.join(shaRoot, fs.readdirSync(shaRoot)[0]))[0],
  ))).toBe(true);

  const created = await new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts }).create({
    ...request, idempotencyKey: 'review:workspace-one:42:referenced',
  });
  const projection = path.join(fixture.artifacts, ...created.projectionKey.split('/'));
  const beforeMaintenance = immutableTreeSnapshot(fixture.artifacts);
  const protectedResult = await collectUnreferencedLocalReviewProjections({
    artifactRoot: fixture.artifacts, minAgeMs: 0, limit: 10, observedBy: 'unit-test-gc',
  });
  expect(protectedResult.referenced).toBe(2);
  expect(gcActions).toContain('preserved');
  expect(fs.existsSync(projection)).toBe(true);
  expect(immutableTreeSnapshot(fixture.artifacts)).toEqual(beforeMaintenance);
});

test('mismatched creation cannot collect an unrelated orphan before authority validation', async () => {
  const request = {
    workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', ...EXACT_ATTEMPT,
    idempotencyKey: 'review:workspace-one:42:orphan', requestedBy: 'local-admin',
  };
  failBundleInsert = true;
  await expect(new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts }).create(request))
    .rejects.toThrow(/synthetic database finalization failure/);
  failBundleInsert = false;
  const shaRoot = path.join(fixture.artifacts, 'sha256');
  const projectionBefore = path.join(shaRoot, fs.readdirSync(shaRoot)[0], fs.readdirSync(path.join(shaRoot, fs.readdirSync(shaRoot)[0]))[0]);
  expect(fs.existsSync(projectionBefore)).toBe(true);

  await expect(new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts }).create({
    ...request, workspaceId: 'mismatched-workspace', idempotencyKey: 'review:mismatch:42:orphan',
  })).rejects.toThrow(/Exact host story attempt authority/);
  expect(fs.existsSync(projectionBefore)).toBe(true);
});

test('GC rejects permissive roots, hard-linked files, and oversized orphan bytes', async () => {
  fs.mkdirSync(fixture.artifacts, { mode: 0o755 });
  await expect(collectUnreferencedLocalReviewProjections({
    artifactRoot: fixture.artifacts, minAgeMs: 0, observedBy: 'unit-test-gc',
  })).rejects.toThrow(/owner-controlled, and private/);
  fs.chmodSync(fixture.artifacts, 0o700);

  const request = {
    workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', ...EXACT_ATTEMPT,
    idempotencyKey: 'review:workspace-one:42:unsafe-orphan', requestedBy: 'local-admin',
  };
  failBundleInsert = true;
  await expect(new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts }).create(request))
    .rejects.toThrow(/synthetic database finalization failure/);
  failBundleInsert = false;
  const shaRoot = path.join(fixture.artifacts, 'sha256');
  const prefix = fs.readdirSync(shaRoot)[0];
  const projection = path.join(shaRoot, prefix, fs.readdirSync(path.join(shaRoot, prefix))[0]);
  fs.chmodSync(projection, 0o700);
  const patch = path.join(projection, 'changes.patch');
  fs.chmodSync(patch, 0o600);
  const outside = path.join(fixture.root, 'outside-hardlink');
  fs.writeFileSync(outside, 'outside-safe\n');
  fs.unlinkSync(patch);
  fs.linkSync(outside, patch);
  fs.utimesSync(projection, new Date(0), new Date(0));
  await expect(collectUnreferencedLocalReviewProjections({
    artifactRoot: fixture.artifacts, minAgeMs: 0, observedBy: 'unit-test-gc',
  })).rejects.toThrow(/hard-linked/);
  expect(gcActions).toEqual(expect.arrayContaining(['operator_maintenance_required']));
  expect(fs.readFileSync(outside, 'utf8')).toBe('outside-safe\n');

  fs.unlinkSync(patch);
  fs.writeFileSync(patch, Buffer.alloc(8 * 1024 * 1024 + 1, 65));
  fs.utimesSync(projection, new Date(0), new Date(0));
  await expect(collectUnreferencedLocalReviewProjections({
    artifactRoot: fixture.artifacts, minAgeMs: 0, observedBy: 'unit-test-gc',
  })).rejects.toThrow(/byte bounds exceeded/);
  expect(fs.existsSync(projection)).toBe(true);
});

test('GC detects a swapped content-addressed parent without touching the swap target', async () => {
  const request = {
    workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', ...EXACT_ATTEMPT,
    idempotencyKey: 'review:workspace-one:42:parent-swap', requestedBy: 'local-admin',
  };
  failBundleInsert = true;
  await expect(new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts }).create(request))
    .rejects.toThrow(/synthetic database finalization failure/);
  failBundleInsert = false;
  const shaRoot = path.join(fixture.artifacts, 'sha256');
  const prefix = fs.readdirSync(shaRoot)[0];
  const prefixPath = path.join(shaRoot, prefix);
  const movedPath = `${prefixPath}-moved`;
  const digest = fs.readdirSync(prefixPath)[0];
  const candidatePath = path.join(prefixPath, digest);
  const sentinel = path.join(candidatePath, 'manifest.json');
  const sentinelBefore = fs.readFileSync(sentinel);
  const promises = require('node:fs/promises') as typeof import('node:fs/promises');
  const originalLstat = promises.lstat;
  const spy = jest.spyOn(promises, 'lstat').mockImplementation(async (candidate: any, options?: any) => {
    if (path.resolve(String(candidate)) === candidatePath && fs.existsSync(prefixPath) && !fs.existsSync(movedPath)) {
      fs.renameSync(prefixPath, movedPath);
      fs.symlinkSync(movedPath, prefixPath);
    }
    return (originalLstat as any)(candidate, options);
  });
  try {
    await expect(collectUnreferencedLocalReviewProjections({
      artifactRoot: fixture.artifacts, minAgeMs: 0, observedBy: 'unit-test-gc',
    })).rejects.toThrow(/parent changed|owner-controlled/);
    expect(fs.readFileSync(path.join(movedPath, digest, 'manifest.json'))).toEqual(sentinelBefore);
  } finally {
    spy.mockRestore();
    if (fs.lstatSync(prefixPath).isSymbolicLink()) fs.unlinkSync(prefixPath);
    if (fs.existsSync(movedPath)) fs.renameSync(movedPath, prefixPath);
  }
});

test('restart maintenance observes bounded crash-left staging without mutating or exposing its name', async () => {
  const stagingRoot = path.join(fixture.artifacts, '.staging');
  const stage = path.join(stagingRoot, '.bundle-crash_fixture');
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stage, 'changes.patch'), 'partial\n', { mode: 0o400 });
  fs.writeFileSync(path.join(stage, 'manifest.json'), '{}', { mode: 0o400 });
  fs.utimesSync(stage, new Date(0), new Date(0));
  const before = immutableTreeSnapshot(fixture.artifacts);

  const observed = await collectUnreferencedLocalReviewProjections({
    artifactRoot: fixture.artifacts, minAgeMs: 0, limit: 10, observedBy: 'restart-observer',
  });

  expect(observed).toMatchObject({
    deleted: 0, stagingDeleted: 0, stagingObserved: 1, retained: 1,
    operatorMaintenanceRequired: 1,
  });
  expect(immutableTreeSnapshot(fixture.artifacts)).toEqual(before);
  expect(gcActionRows.at(-1)?.[0]).toMatch(/^staging\/sha256\/[0-9a-f]{64}$/);
  expect(JSON.stringify(gcActionRows)).not.toContain('.bundle-crash_fixture');
  expect(gcActions).toContain('retained');
});

test('restart maintenance reconciles durable planned actions without deletion and reports missing outcomes truthfully', async () => {
  const orphan = await createOrphan('review:workspace-one:42:planned-recovery');
  plannedGcRows.push({ projection_key: orphan.projectionKey, content_hash: `sha256:${orphan.digest}` });
  transactionOperationCount = 0;
  const before = immutableTreeSnapshot(fixture.artifacts);
  const recovered = await collectUnreferencedLocalReviewProjections({
    artifactRoot: fixture.artifacts, minAgeMs: 0, limit: 10, observedBy: 'restart-observer',
  });
  expect(recovered).toMatchObject({ plannedReconciled: 1, retained: 1, deleted: 0 });
  expect(gcActionRows.some((row) => row[5] === 'planned_action_reconciled_without_deletion')).toBe(true);
  expect(immutableTreeSnapshot(fixture.artifacts)).toEqual(before);
  transactionOperationCount = 0;
  const restarted = await collectUnreferencedLocalReviewProjections({
    artifactRoot: fixture.artifacts, minAgeMs: 0, limit: 10, observedBy: 'restart-observer',
  });
  expect(restarted.plannedReconciled).toBe(0);
  expect(immutableTreeSnapshot(fixture.artifacts)).toEqual(before);

  plannedGcRows.length = 0;
  const missingDigest = '7'.repeat(64);
  plannedGcRows.push({
    projection_key: `sha256/77/${missingDigest}`,
    content_hash: `sha256:${missingDigest}`,
  });
  transactionOperationCount = 0;
  const missing = await collectUnreferencedLocalReviewProjections({
    artifactRoot: fixture.artifacts, minAgeMs: 0, limit: 1, observedBy: 'restart-observer',
  });
  expect(missing).toMatchObject({
    plannedReconciled: 1, operatorMaintenanceRequired: 1, deleted: 0,
  });
  expect(gcActionRows.some((row) => row[3] === 'prior_action_outcome_indeterminate'
    && row[5] === 'planned_candidate_missing')).toBe(true);
});

test('maintenance DB failures before and after bounded filesystem observation never mutate artifacts or claim deletion', async () => {
  await createOrphan('review:workspace-one:42:audit-failure');
  const before = immutableTreeSnapshot(fixture.artifacts);

  transactionOperationCount = 0;
  failMaintenanceQuery = 'planned-load';
  await expect(collectUnreferencedLocalReviewProjections({
    artifactRoot: fixture.artifacts, minAgeMs: 0, observedBy: 'audit-failure-test',
  })).rejects.toThrow(/plan load failure/);
  expect(immutableTreeSnapshot(fixture.artifacts)).toEqual(before);

  failMaintenanceQuery = 'action-insert';
  transactionOperationCount = 0;
  await expect(collectUnreferencedLocalReviewProjections({
    artifactRoot: fixture.artifacts, minAgeMs: 0, observedBy: 'audit-failure-test',
  })).rejects.toThrow(/audit failure/);
  expect(immutableTreeSnapshot(fixture.artifacts)).toEqual(before);
  expect(gcActions).not.toContain('deleted');

  failMaintenanceQuery = undefined;
  transactionOperationCount = 0;
  failTransactionAfterOperationAt = 2;
  await expect(collectUnreferencedLocalReviewProjections({
    artifactRoot: fixture.artifacts, minAgeMs: 0, observedBy: 'audit-failure-test',
  })).rejects.toThrow(/commit failure/);
  expect(immutableTreeSnapshot(fixture.artifacts)).toEqual(before);
  expect(gcActions).not.toContain('deleted');
});

test('maintenance rejects symlinked and oversized staging trees without touching external targets', async () => {
  const stagingRoot = path.join(fixture.artifacts, '.staging');
  fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const outside = path.join(fixture.root, 'outside-staging-target');
  fs.mkdirSync(outside, { mode: 0o700 });
  const sentinel = path.join(outside, 'sentinel');
  fs.writeFileSync(sentinel, 'preserve\n');
  const linkedStage = path.join(stagingRoot, '.bundle-linked');
  fs.symlinkSync(outside, linkedStage);
  fs.lutimesSync(linkedStage, new Date(0), new Date(0));
  await expect(collectUnreferencedLocalReviewProjections({
    artifactRoot: fixture.artifacts, minAgeMs: 0, observedBy: 'staging-adversary',
  })).rejects.toThrow(/linked|symlink/i);
  expect(fs.readFileSync(sentinel, 'utf8')).toBe('preserve\n');
  fs.unlinkSync(linkedStage);

  const oversized = path.join(stagingRoot, '.bundle-oversized');
  fs.mkdirSync(oversized, { mode: 0o700 });
  fs.writeFileSync(path.join(oversized, 'changes.patch'), Buffer.alloc(8 * 1024 * 1024 + 1, 65));
  fs.utimesSync(oversized, new Date(0), new Date(0));
  await expect(collectUnreferencedLocalReviewProjections({
    artifactRoot: fixture.artifacts, minAgeMs: 0, observedBy: 'staging-adversary',
  })).rejects.toThrow(/byte bounds exceeded/);
  expect(fs.existsSync(oversized)).toBe(true);

  unlockTree(oversized);
  fs.rmSync(oversized, { recursive: true, force: true });
  const invalidIdentity = path.join(stagingRoot, 'attacker-controlled-name');
  fs.mkdirSync(invalidIdentity, { mode: 0o700 });
  fs.utimesSync(invalidIdentity, new Date(0), new Date(0));
  await expect(collectUnreferencedLocalReviewProjections({
    artifactRoot: fixture.artifacts, minAgeMs: 0, observedBy: 'staging-adversary',
  })).rejects.toThrow(/invalid staging identity/);
  expect(fs.existsSync(invalidIdentity)).toBe(true);
  expect(JSON.stringify(gcActionRows)).not.toContain('attacker-controlled-name');
});

test('maintenance detects artifact-root replacement after enumeration without changing the original tree', async () => {
  const orphan = await createOrphan('review:workspace-one:42:root-swap');
  const originalRoot = fixture.artifacts;
  const movedRoot = `${originalRoot}-moved`;
  const before = immutableTreeSnapshot(originalRoot);
  const promises = require('node:fs/promises') as typeof import('node:fs/promises');
  const originalLstat = promises.lstat;
  const spy = jest.spyOn(promises, 'lstat').mockImplementation(async (candidate: any, options?: any) => {
    if (path.resolve(String(candidate)) === orphan.candidate && fs.existsSync(originalRoot)
      && !fs.existsSync(movedRoot)) {
      fs.renameSync(originalRoot, movedRoot);
      fs.symlinkSync(movedRoot, originalRoot);
    }
    return (originalLstat as any)(candidate, options);
  });
  try {
    await expect(collectUnreferencedLocalReviewProjections({
      artifactRoot: originalRoot, minAgeMs: 0, observedBy: 'root-swap-test',
    })).rejects.toThrow(/root or parent changed|parent changed/);
    expect(immutableTreeSnapshot(movedRoot)).toEqual(before);
  } finally {
    spy.mockRestore();
    if (fs.lstatSync(originalRoot).isSymbolicLink()) fs.unlinkSync(originalRoot);
    if (fs.existsSync(movedRoot)) fs.renameSync(movedRoot, originalRoot);
  }
});

test('maintenance detects sha namespace and staging parent swaps at their post-enumeration boundaries', async () => {
  const orphan = await createOrphan('review:workspace-one:42:namespace-swap');
  const shaRoot = path.join(fixture.artifacts, 'sha256');
  const movedShaRoot = `${shaRoot}-moved`;
  const shaBefore = immutableTreeSnapshot(shaRoot);
  const promises = require('node:fs/promises') as typeof import('node:fs/promises');
  const originalLstat = promises.lstat;
  let swapSha = true;
  const shaSpy = jest.spyOn(promises, 'lstat').mockImplementation(async (candidate: any, options?: any) => {
    const resolved = path.resolve(String(candidate));
    if (swapSha && resolved === path.dirname(orphan.candidate) && fs.existsSync(shaRoot)
      && !fs.existsSync(movedShaRoot)) {
      fs.renameSync(shaRoot, movedShaRoot);
      fs.symlinkSync(movedShaRoot, shaRoot);
    }
    return (originalLstat as any)(candidate, options);
  });
  try {
    await expect(collectUnreferencedLocalReviewProjections({
      artifactRoot: fixture.artifacts, minAgeMs: 0, observedBy: 'namespace-swap-test',
    })).rejects.toThrow(/parent changed|owner-controlled/);
    expect(immutableTreeSnapshot(movedShaRoot)).toEqual(shaBefore);
  } finally {
    swapSha = false;
    shaSpy.mockRestore();
    if (fs.lstatSync(shaRoot).isSymbolicLink()) fs.unlinkSync(shaRoot);
    if (fs.existsSync(movedShaRoot)) fs.renameSync(movedShaRoot, shaRoot);
  }

  unlockTree(fixture.artifacts);
  fs.rmSync(fixture.artifacts, { recursive: true, force: true });
  const stagingRoot = path.join(fixture.artifacts, '.staging');
  const stage = path.join(stagingRoot, '.bundle-parent-swap');
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stage, 'manifest.json'), '{}');
  fs.utimesSync(stage, new Date(0), new Date(0));
  const movedStagingRoot = `${stagingRoot}-moved`;
  const stagingBefore = immutableTreeSnapshot(stagingRoot);
  const stageSpy = jest.spyOn(promises, 'lstat').mockImplementation(async (candidate: any, options?: any) => {
    if (path.resolve(String(candidate)) === stage && fs.existsSync(stagingRoot)
      && !fs.existsSync(movedStagingRoot)) {
      fs.renameSync(stagingRoot, movedStagingRoot);
      fs.symlinkSync(movedStagingRoot, stagingRoot);
    }
    return (originalLstat as any)(candidate, options);
  });
  try {
    await expect(collectUnreferencedLocalReviewProjections({
      artifactRoot: fixture.artifacts, minAgeMs: 0, observedBy: 'staging-parent-swap-test',
    })).rejects.toThrow(/parent changed/);
    expect(immutableTreeSnapshot(movedStagingRoot)).toEqual(stagingBefore);
  } finally {
    stageSpy.mockRestore();
    if (fs.lstatSync(stagingRoot).isSymbolicLink()) fs.unlinkSync(stagingRoot);
    if (fs.existsSync(movedStagingRoot)) fs.renameSync(movedStagingRoot, stagingRoot);
  }
});

test('maintenance enforces staging node-count and depth bounds without recursive cleanup', async () => {
  const stagingRoot = path.join(fixture.artifacts, '.staging');
  const deepStage = path.join(stagingRoot, '.bundle-too-deep');
  fs.mkdirSync(path.join(deepStage, 'one', 'two', 'three', 'four'), { recursive: true, mode: 0o700 });
  fs.utimesSync(deepStage, new Date(0), new Date(0));
  await expect(collectUnreferencedLocalReviewProjections({
    artifactRoot: fixture.artifacts, minAgeMs: 0, observedBy: 'staging-bounds-test',
  })).rejects.toThrow(/depth exceeds/);
  expect(fs.existsSync(deepStage)).toBe(true);

  unlockTree(fixture.artifacts);
  fs.rmSync(fixture.artifacts, { recursive: true, force: true });
  const crowded = path.join(stagingRoot, '.bundle-too-many');
  fs.mkdirSync(crowded, { recursive: true, mode: 0o700 });
  for (let index = 0; index < 5; index += 1) fs.writeFileSync(path.join(crowded, `file-${index}`), 'x');
  fs.utimesSync(crowded, new Date(0), new Date(0));
  await expect(collectUnreferencedLocalReviewProjections({
    artifactRoot: fixture.artifacts, minAgeMs: 0, observedBy: 'staging-bounds-test',
  })).rejects.toThrow(/directory count exceeds|node count exceeds/);
  expect(fs.readdirSync(crowded)).toHaveLength(5);
});

test('maintenance source contains no destructive descendant operation and create authority stays separate', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'local-review-bundle-adapter.ts'), 'utf8');
  const maintenance = source.slice(
    source.indexOf('export async function collectUnreferencedLocalReviewProjections'),
    source.indexOf('export class LocalReviewBundleAdapter'),
  );
  expect(maintenance).not.toMatch(/fs\.(?:chmod|rename|rm|rmdir|unlink|writeFile)|handle\.chmod/);
  expect(maintenance).not.toContain("actionType: 'planned'");
  const creation = source.slice(source.indexOf('async create(rawRequest'));
  expect(creation).not.toContain('collectUnreferencedLocalReviewProjections');
});

test('immutable projection corruption fails closed on replay', async () => {
  const adapter = new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts });
  const request = {
    workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', ...EXACT_ATTEMPT,
    idempotencyKey: 'review:workspace-one:42:US-001', requestedBy: 'local-admin',
  };
  const created = await adapter.create(request);
  const projection = path.join(fixture.artifacts, ...created.projectionKey.split('/'));
  const patch = path.join(projection, 'changes.patch');
  fs.chmodSync(projection, 0o700);
  fs.chmodSync(patch, 0o600);
  fs.appendFileSync(patch, '\ncorrupt\n');
  await expect(new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts }).create(request))
    .rejects.toThrow(/integrity is corrupt/);
});

test.each([
  ['secret path', (repo: string) => commitFile(repo, '.env', 'SAFE_TEST_VALUE=present\n'), /unsafe or secret-bearing/],
  ['credential path variant', (repo: string) => commitFile(repo, 'config/credentials.json', '{"safe":"fixture"}\n'), /unsafe or secret-bearing/],
  ['invalid UTF-8 content', (repo: string) => commitFile(repo, 'src/value.txt', Buffer.from([0xff, 0xfe, 0x41])), /non-UTF-8/],
  ['secret content', (repo: string) => commitFile(repo, 'src/value.txt', 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890\n'), /secret-like/],
  ['symlink', (repo: string) => {
    fs.symlinkSync('../outside', path.join(repo, 'src/link'));
    git(repo, ['add', 'src/link']);
    git(repo, ['-c', 'user.name=Test Host', '-c', 'user.email=host@rorca.test', 'commit', '-m', 'symlink']);
  }, /symlinks/],
  ['oversized file', (repo: string) => commitFile(repo, 'src/value.txt', Buffer.alloc(1024 * 1024 + 1, 65)), /per-file limit/],
])('rejects %s before finalization', async (_label, change, expected) => {
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fixture = makeFixture(change as (repo: string) => void);
  installDbMocks();
  await expect(new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts }).create({
    workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', ...EXACT_ATTEMPT,
    idempotencyKey: 'review:workspace-one:42:US-001', requestedBy: 'local-admin',
  })).rejects.toThrow(expected);
  expect(stored).toBeUndefined();
});

test('rejects stale head, moved paths, protected run, and symlinked artifact roots before persistence', async () => {
  (fixture.authority.story_commit_sha as string) = fixture.baseSha;
  const adapter = new LocalReviewBundleAdapter({ artifactRoot: fixture.artifacts });
  await expect(adapter.create({
    workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', ...EXACT_ATTEMPT,
    idempotencyKey: 'review:workspace-one:42:US-001', requestedBy: 'local-admin',
  })).rejects.toThrow(/stale story head SHA/);

  const readsBeforeProtectedRun = queryOneMock.mock.calls.length;
  await expect(adapter.create({
    workspaceId: 'workspace-one', runId: 20260316000549, storyId: 'US-001', ...EXACT_ATTEMPT,
    idempotencyKey: 'review:protected:run:US-001', requestedBy: 'local-admin',
  })).rejects.toThrow(/Genesis run|protected/i);
  expect(queryOneMock).toHaveBeenCalledTimes(readsBeforeProtectedRun);
  await expect(listLocalReviewBundles({
    workspaceId: 'workspace-one', runId: 20260316000549, artifactRoot: fixture.artifacts,
  })).rejects.toThrow(/Genesis run|protected/i);
  await expect(getLocalReviewBundle({
    workspaceId: 'workspace-one', runId: 20260316000549,
    bundleId: `lrb-${'a'.repeat(64)}`, artifactRoot: fixture.artifacts,
  })).rejects.toThrow(/Genesis run|protected/i);
  expect(queryOneMock).toHaveBeenCalledTimes(readsBeforeProtectedRun);

  (fixture.authority.story_commit_sha as string) = fixture.headSha;
  const realArtifacts = path.join(fixture.root, 'real-artifacts');
  fs.mkdirSync(realArtifacts);
  const linkedArtifacts = path.join(fixture.root, 'linked-artifacts');
  fs.symlinkSync(realArtifacts, linkedArtifacts);
  await expect(new LocalReviewBundleAdapter({ artifactRoot: linkedArtifacts }).create({
    workspaceId: 'workspace-one', runId: 42, storyId: 'US-001', ...EXACT_ATTEMPT,
    idempotencyKey: 'review:symlink:root:US-001', requestedBy: 'local-admin',
  })).rejects.toThrow(/artifact (?:root contains a symlink|directory must be exact)/);
  expect(stored).toBeUndefined();
});
