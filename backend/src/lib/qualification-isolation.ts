/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const QUALIFICATION_RUN_ID_PATTERN = /^qrun_[a-f0-9]{24}$/;
export const QUALIFICATION_OWNER_MARKER = '.rorca-qualification-owner.json';
export const QUALIFICATION_REPOSITORY_MARKER = '.rorca-qualification-repository.json';
export const QUALIFICATION_INVARIANT_IDS = [
  'WPE-INV-001',
  'WPE-INV-002',
  'WPE-INV-003',
  'WPE-INV-004',
  'WPE-INV-005',
  'WPE-INV-006',
  'WPE-INV-007',
] as const;

export type QualificationInvariantId = typeof QUALIFICATION_INVARIANT_IDS[number];

interface QueryResult<T> {
  rows: T[];
}

export interface QualificationQueryable {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
}

export interface QualificationBoss {
  createQueue(name: string): Promise<unknown>;
  deleteQueue(name: string): Promise<unknown>;
}

export interface QualificationIdentity {
  runId: string;
  isolationMarker: string;
  database: string;
  role: string;
  applicationName: string;
  workspaceId: string;
  repositoryId: string;
  branchPrefix: string;
  specId: string;
  syntheticRunId: string;
  queuePrefix: string;
}

export interface VerifiedQualificationDatabase {
  database: string;
  role: string;
  owner: string;
  applicationName: string;
  isolationMarker: string;
}

export interface QualificationBoundary extends QualificationIdentity {
  artifactRoot: string;
  repositoryRoot: string;
  worktreeRoot: string;
}

interface DatabaseIdentityRow {
  database: string;
  role: string;
  owner: string;
  application_name: string;
  isolation_marker: string | null;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
}

interface OwnershipMarker {
  version: 1;
  runId: string;
  isolationMarker: string;
  repositoryId: string;
  repositoryPath: string;
  worktreePaths: string[];
}

const RUNTIME_ALLOWED_KEYS = new Set([
  'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'CI', 'NODE_ENV',
  'RORCA_QUALIFICATION_RUN_ID', 'RORCA_QUALIFICATION_ISOLATION_MARKER',
  'RORCA_QUALIFICATION_DATABASE_URL', 'RORCA_QUALIFICATION_SCENARIO',
]);

const IDENTITY_OR_CREDENTIAL_KEY = /(?:^|_)(?:DATABASE|PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE|QUEUE|WORKSPACE|REPOSITORY|REPO|AWS|AZURE|GCP|GOOGLE|CLOUD|ANTHROPIC|CLAUDE|OPENAI|OPENROUTER|GITHUB|GITLAB|BITBUCKET|STRIPE|VERCEL|SUPABASE|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)(?:_|$)/i;
const PRODUCTION_LIKE_IDENTITY = /(?:^|[._-])(?:prod(?:uction)?|live|primary|mainline)(?:[._-]|$)/i;
const SAFE_CLEANUP_TABLE = /^[a-z_][a-z0-9_]*$/;
const SAFE_CLEANUP_COLUMN = new Set([
  'qualification_namespace', 'workspace_id', 'spec_id', 'run_namespace', 'queue_name',
]);
const IMMUTABLE_TABLE_FRAGMENT = /(?:evidence|history|audit|wal_event|decision|attestation|checkpoint)/i;

function fail(message: string): never {
  throw new Error(`[qualification-isolation] ${message}`);
}

function assertRunId(runId: string): void {
  if (!QUALIFICATION_RUN_ID_PATTERN.test(runId)) {
    fail('qualification run ID must be an unpredictable qrun_<24 lowercase hex> value');
  }
}

export function createQualificationRunId(): string {
  return `qrun_${randomBytes(12).toString('hex')}`;
}

export function qualificationIsolationMarker(runId: string): string {
  assertRunId(runId);
  return `rorca-qualification-owned:${runId}`;
}

function tokenFor(runId: string): string {
  assertRunId(runId);
  return runId.slice('qrun_'.length);
}

function assertNoProductionLikeIdentity(label: string, value: string): void {
  if (PRODUCTION_LIKE_IDENTITY.test(value)) {
    fail(`${label} contains a production-like identity`);
  }
}

export function buildQualificationIdentity(runId: string, databaseUrl: string): QualificationIdentity {
  const token = tokenFor(runId);
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return fail('RORCA_QUALIFICATION_DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    fail('qualification database URL must use postgres:// or postgresql://');
  }

  const expectedDatabase = `rorca_qtest_${token}`;
  const expectedRole = `rorca_qrole_${token}`;
  const expectedApplicationName = `rorca-qualification:${runId}`;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const role = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const applicationName = parsed.searchParams.get('application_name') ?? '';

  if (database !== expectedDatabase || role !== expectedRole) {
    fail('database and role must exactly match the qualification run namespace');
  }
  if (!password) fail('qualification database URL must use dedicated test-role credentials');
  if (applicationName !== expectedApplicationName) {
    fail('qualification database URL must carry the exact test-only application_name');
  }
  assertNoProductionLikeIdentity('database host', parsed.hostname);
  assertNoProductionLikeIdentity('database', database);
  assertNoProductionLikeIdentity('database role', role);

  return {
    runId,
    isolationMarker: qualificationIsolationMarker(runId),
    database,
    role,
    applicationName,
    workspaceId: `qws-${runId}`,
    repositoryId: `qrepo-${runId}`,
    branchPrefix: `qualification/${runId}/`,
    specId: `qspec-${runId}`,
    syntheticRunId: `qualification-run-${runId}`,
    queuePrefix: `qualification:${runId}:`,
  };
}

/**
 * Build the only environment permitted for the qualification child process.
 * Application DB configuration and workspace/repository/provider credentials are
 * never copied. The child repeats the mixed-identity check before DB preflight.
 */
export function buildSanitizedQualificationEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const runId = source.RORCA_QUALIFICATION_RUN_ID ?? '';
  const databaseUrl = source.RORCA_QUALIFICATION_DATABASE_URL ?? '';
  const identity = buildQualificationIdentity(runId, databaseUrl);
  const suppliedMarker = source.RORCA_QUALIFICATION_ISOLATION_MARKER ?? '';
  if (suppliedMarker !== identity.isolationMarker) {
    fail('explicit per-run isolation marker is missing or does not match the run ID');
  }

  const result: Record<string, string> = {
    NODE_ENV: 'test',
    RORCA_QUALIFICATION_RUN_ID: runId,
    RORCA_QUALIFICATION_ISOLATION_MARKER: suppliedMarker,
    RORCA_QUALIFICATION_DATABASE_URL: databaseUrl,
  };
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TERM', 'CI']) {
    if (source[key]) result[key] = source[key]!;
  }
  if (source.RORCA_QUALIFICATION_SCENARIO) {
    result.RORCA_QUALIFICATION_SCENARIO = source.RORCA_QUALIFICATION_SCENARIO;
  }
  return result;
}

export function assertSanitizedQualificationRuntimeEnv(env: NodeJS.ProcessEnv): QualificationIdentity {
  for (const [key, value] of Object.entries(env)) {
    if (!value || RUNTIME_ALLOWED_KEYS.has(key)) continue;
    if (IDENTITY_OR_CREDENTIAL_KEY.test(key)) {
      fail(`mixed or inherited identity/credential key ${key} is forbidden at runtime`);
    }
  }
  if (env.NODE_ENV !== 'test') fail('qualification runtime must use NODE_ENV=test');

  const runId = env.RORCA_QUALIFICATION_RUN_ID ?? '';
  const databaseUrl = env.RORCA_QUALIFICATION_DATABASE_URL ?? '';
  const identity = buildQualificationIdentity(runId, databaseUrl);
  if (env.RORCA_QUALIFICATION_ISOLATION_MARKER !== identity.isolationMarker) {
    fail('runtime isolation marker is missing or ambiguous');
  }
  return identity;
}

/** Read-only server-truth proof. Call before creating fixtures, schemas, queues, or files. */
export async function verifyQualificationDatabase(
  client: QualificationQueryable,
  env: NodeJS.ProcessEnv,
): Promise<{ identity: QualificationIdentity; database: VerifiedQualificationDatabase }> {
  const identity = assertSanitizedQualificationRuntimeEnv(env);
  const result = await client.query<DatabaseIdentityRow>(`
    SELECT current_database() AS database,
           current_user AS role,
           pg_get_userbyid(d.datdba) AS owner,
           current_setting('application_name') AS application_name,
           shobj_description(d.oid, 'pg_database') AS isolation_marker,
           r.rolsuper,
           r.rolcreatedb,
           r.rolcreaterole,
           r.rolreplication,
           r.rolbypassrls
      FROM pg_database d
      JOIN pg_roles r ON r.rolname = current_user
     WHERE d.datname = current_database()
  `);
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) fail('database identity proof is missing or ambiguous');
  if (row.database !== identity.database) fail('server-reported database does not match the qualification namespace');
  if (row.role !== identity.role || row.owner !== identity.role) {
    fail('dedicated qualification role must be both current role and database owner');
  }
  if (row.application_name !== identity.applicationName) fail('server connection identity does not match qualification runtime');
  if (row.isolation_marker !== identity.isolationMarker) fail('pre-provisioned database isolation marker is missing or mismatched');
  if (row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolreplication || row.rolbypassrls) {
    fail('qualification role has production-capable privileges');
  }

  return {
    identity,
    database: {
      database: row.database,
      role: row.role,
      owner: row.owner,
      applicationName: row.application_name,
      isolationMarker: row.isolation_marker,
    },
  };
}

function isStrictlyContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function resolveTemporaryRoot(requestedRoot: string): string {
  const systemRoot = fs.realpathSync(os.tmpdir());
  const requested = fs.realpathSync(requestedRoot);
  if (requested !== systemRoot && !isStrictlyContained(systemRoot, requested)) {
    fail('qualification artifacts must use the operating-system temporary root');
  }
  return requested;
}

function writeOwnershipMarker(root: string, marker: OwnershipMarker): void {
  const markerPath = path.join(root, QUALIFICATION_OWNER_MARKER);
  const temporaryPath = path.join(root, `${QUALIFICATION_OWNER_MARKER}.${randomBytes(8).toString('hex')}.tmp`);
  fs.writeFileSync(temporaryPath, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temporaryPath, markerPath);
}

function readRegularJsonMarker(markerPath: string, label: string): unknown {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(markerPath);
  } catch {
    return fail(`${label} is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    return fail(`${label} is unreadable`);
  }
}

function readOwnershipMarker(root: string): OwnershipMarker {
  const markerPath = path.join(root, QUALIFICATION_OWNER_MARKER);
  const parsed = readRegularJsonMarker(markerPath, 'artifact ownership marker');
  const marker = parsed as Partial<OwnershipMarker>;
  if (
    marker.version !== 1
    || typeof marker.runId !== 'string'
    || typeof marker.isolationMarker !== 'string'
    || typeof marker.repositoryId !== 'string'
    || typeof marker.repositoryPath !== 'string'
    || !Array.isArray(marker.worktreePaths)
    || marker.worktreePaths.some(item => typeof item !== 'string')
  ) {
    fail('artifact ownership marker is incomplete');
  }
  return marker as OwnershipMarker;
}

function assertRepositoryMarker(repositoryRoot: string, boundary: QualificationBoundary): void {
  const parsed = readRegularJsonMarker(
    path.join(repositoryRoot, QUALIFICATION_REPOSITORY_MARKER),
    'fixture repository ownership marker',
  ) as Record<string, unknown>;
  if (
    parsed.version !== 1
    || parsed.runId !== boundary.runId
    || parsed.isolationMarker !== boundary.isolationMarker
    || parsed.repositoryId !== boundary.repositoryId
  ) {
    fail('fixture repository ownership marker does not match the qualification boundary');
  }
}

/** Create synthetic filesystem fixtures only after database proof succeeds. */
export async function activateQualificationBoundary(
  client: QualificationQueryable,
  env: NodeJS.ProcessEnv,
  temporaryRoot = os.tmpdir(),
): Promise<{ boundary: QualificationBoundary; database: VerifiedQualificationDatabase }> {
  const verified = await verifyQualificationDatabase(client, env);
  const osTemporaryRoot = resolveTemporaryRoot(temporaryRoot);
  const root = fs.mkdtempSync(path.join(osTemporaryRoot, `rorca-qualification-${verified.identity.runId}-`));
  const realRoot = fs.realpathSync(root);
  if (!isStrictlyContained(osTemporaryRoot, realRoot)) fail('artifact root escaped the OS temporary root');

  const repositoryPath = verified.identity.repositoryId;
  const repositoryRoot = path.join(realRoot, repositoryPath);
  const worktreeRoot = path.join(realRoot, 'worktrees');
  fs.mkdirSync(repositoryRoot, { mode: 0o700 });
  fs.mkdirSync(worktreeRoot, { mode: 0o700 });
  fs.writeFileSync(
    path.join(repositoryRoot, QUALIFICATION_REPOSITORY_MARKER),
    `${JSON.stringify({
      version: 1,
      runId: verified.identity.runId,
      isolationMarker: verified.identity.isolationMarker,
      repositoryId: verified.identity.repositoryId,
    })}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
  writeOwnershipMarker(realRoot, {
    version: 1,
    runId: verified.identity.runId,
    isolationMarker: verified.identity.isolationMarker,
    repositoryId: verified.identity.repositoryId,
    repositoryPath,
    worktreePaths: [],
  });

  return {
    boundary: { ...verified.identity, artifactRoot: realRoot, repositoryRoot, worktreeRoot },
    database: verified.database,
  };
}

export function registerQualificationWorktree(boundary: QualificationBoundary, suffix: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(suffix)) fail('worktree suffix is invalid');
  const root = fs.realpathSync(boundary.artifactRoot);
  const marker = readOwnershipMarker(root);
  assertMarkerMatchesBoundary(marker, boundary);
  const relativePath = path.join('worktrees', `${boundary.runId}-${suffix}`);
  const target = path.join(root, relativePath);
  if (!isStrictlyContained(root, target) || fs.existsSync(target)) fail('worktree target is not a new owned path');
  marker.worktreePaths.push(relativePath);
  writeOwnershipMarker(root, marker);
  fs.mkdirSync(target, { mode: 0o700 });
  return target;
}

function assertMarkerMatchesBoundary(marker: OwnershipMarker, boundary: QualificationBoundary): void {
  if (
    marker.runId !== boundary.runId
    || marker.isolationMarker !== boundary.isolationMarker
    || marker.repositoryId !== boundary.repositoryId
    || marker.repositoryPath !== boundary.repositoryId
  ) {
    fail('artifact ownership marker does not match the qualification boundary');
  }
}

function inspectOwnedTree(root: string, marker: OwnershipMarker): void {
  const allowedGitParents = new Set([
    path.join(root, marker.repositoryPath),
    ...marker.worktreePaths.map(item => path.join(root, item)),
  ]);
  const recordedWorktrees = new Set(marker.worktreePaths.map(item => path.join(root, item)));
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current)) {
      const candidate = path.join(current, entry);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) fail('symlinks are forbidden in an owned qualification artifact tree');
      if (entry === '.git' && !allowedGitParents.has(current)) {
        fail('repository/worktree identity is not recorded in the ownership marker');
      }
      if (stat.isDirectory()) pending.push(candidate);
    }
  }

  const actualWorktrees = fs.readdirSync(path.join(root, 'worktrees'))
    .map(item => path.join(root, 'worktrees', item));
  if (actualWorktrees.some(item => !recordedWorktrees.has(item))) {
    fail('unrelated worktree exists under the qualification artifact root');
  }
}

/** Fail-closed cleanup: no force option, no missing-marker fallback, no symlink traversal. */
export function cleanupQualificationArtifacts(boundary: QualificationBoundary, temporaryRoot = os.tmpdir()): void {
  const osTemporaryRoot = resolveTemporaryRoot(temporaryRoot);
  const rootStat = fs.lstatSync(boundary.artifactRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('artifact root must be a real directory');
  const root = fs.realpathSync(boundary.artifactRoot);
  if (root !== boundary.artifactRoot || !isStrictlyContained(osTemporaryRoot, root)) {
    fail('artifact root is not a canonical child of the OS temporary root');
  }
  const marker = readOwnershipMarker(root);
  assertMarkerMatchesBoundary(marker, boundary);
  if (fs.realpathSync(path.join(root, marker.repositoryPath)) !== boundary.repositoryRoot) {
    fail('fixture repository does not match the ownership marker');
  }
  assertRepositoryMarker(boundary.repositoryRoot, boundary);
  inspectOwnedTree(root, marker);
  fs.rmSync(root, { recursive: true, force: false });
}

export function qualificationQueueName(boundary: QualificationIdentity, purpose: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(purpose)) fail('qualification queue purpose is invalid');
  return `${boundary.queuePrefix}${purpose}`;
}

export async function createQualificationQueue(
  boss: Pick<QualificationBoss, 'createQueue'>,
  boundary: QualificationIdentity,
  purpose: string,
): Promise<string> {
  const name = qualificationQueueName(boundary, purpose);
  await boss.createQueue(name);
  return name;
}

export async function deleteQualificationQueue(
  boss: Pick<QualificationBoss, 'deleteQueue'>,
  boundary: QualificationIdentity,
  queueName: string,
): Promise<void> {
  const purpose = queueName.slice(boundary.queuePrefix.length);
  if (queueName !== qualificationQueueName(boundary, purpose)) {
    fail('refusing to delete a queue outside the qualification namespace');
  }
  await boss.deleteQueue(queueName);
}

/**
 * Execute one narrowly-shaped fixture cleanup. Broad SQL, pgboss schema access,
 * and immutable evidence/WAL/history tables are structurally rejected.
 */
export async function deleteOwnedQualificationRows(
  client: QualificationQueryable,
  boundary: QualificationIdentity,
  table: string,
  ownershipColumn: string,
  ownershipValue: string,
): Promise<number> {
  if (!SAFE_CLEANUP_TABLE.test(table) || table === 'schema_migrations' || IMMUTABLE_TABLE_FRAGMENT.test(table)) {
    fail('cleanup table is unsafe or immutable');
  }
  if (table.startsWith('pgboss') || !SAFE_CLEANUP_COLUMN.has(ownershipColumn)) {
    fail('pgboss and unscoped cleanup targets are forbidden');
  }
  const ownedValues = new Set([
    boundary.runId,
    boundary.workspaceId,
    boundary.specId,
    boundary.syntheticRunId,
  ]);
  if (!ownedValues.has(ownershipValue)) fail('cleanup value is not owned by this qualification namespace');
  const result = await client.query(`DELETE FROM ${table} WHERE ${ownershipColumn} = $1 RETURNING 1`, [ownershipValue]);
  return result.rows.length;
}

function redactIdentity(label: string, value: string): string {
  return `${label}:sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

export function qualificationSentinel(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function buildQualificationEvidence(
  boundary: QualificationBoundary,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  return {
    run: redactIdentity('run', boundary.runId),
    database: redactIdentity('database', boundary.database),
    role: redactIdentity('role', boundary.role),
    workspace: redactIdentity('workspace', boundary.workspaceId),
    repository: redactIdentity('repository', boundary.repositoryId),
    queueNamespace: redactIdentity('queue', boundary.queuePrefix),
    artifactRoot: redactIdentity('artifact', path.basename(boundary.artifactRoot)),
    before: Object.fromEntries(Object.entries(before).map(([key, value]) => [key, qualificationSentinel(value)])),
    after: Object.fromEntries(Object.entries(after).map(([key, value]) => [key, qualificationSentinel(value)])),
    invariantIds: [...QUALIFICATION_INVARIANT_IDS],
  };
}
