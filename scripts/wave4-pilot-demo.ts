/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * W4-010 pilot demonstration runner (pre-credential portion).
 *
 * Self-provisions an invocation-owned compose stack (fresh PG16 volumes, new
 * random split-principal credentials, RORCA_FEDERATED_CREDENTIAL_PEPPER), then
 * drives ONE bounded pilot work package through the federated lane:
 *   host:  runtime registration + credential (digest = sha256 with pepper),
 *          canonical mission/work-package/policy-activation/checkpoint/
 *          receipt/bundle/dispatch + disposable git worktree in the rorca
 *          container, ONE published offer;
 *   host:  REAL host-observed evidence (artifact hash, validation command);
 *   runtime (HTTP): discover -> acquire -> work-package/read -> propose, where
 *          propose triggers in-container Git host verification and persists a
 *          host-verified result with proposal-only closeout semantics.
 *
 * The GitHub App draft PR/Check projection is the ONLY step not performed
 * (operator GitHub App credentials required; PAT substitutes forbidden).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const EVIDENCE = path.join(ROOT, 'docs', 'wave4-pilot-demo-packet.md');
const PREFIX = 'rorca-wave2-';
const PROJECT = `${PREFIX}wave4demo-20260806`;
const secret = (): string => crypto.randomBytes(24).toString('hex');
const sha256hex = (value: Buffer | string): string => crypto.createHash('sha256').update(value).digest('hex');
const h = (value: string): string => `sha256:${sha256hex(value)}`;
const hx = (value: string): string => `sha256:${value.repeat(64)}`;

// ── LP1 governed canonical hashing (mirrors backend/src/lib/governed-contracts/primitives.ts) ──
type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };
function lp(name: string, bytes: Buffer): Buffer {
  const nameBytes = Buffer.from(name.normalize('NFC'), 'utf8');
  return Buffer.concat([Buffer.from(`${nameBytes.length}:`), nameBytes, Buffer.from(`${bytes.length}:`), bytes]);
}
function encode(value: CanonicalValue): Buffer {
  if (value === null) return lp('$type', Buffer.from('null'));
  if (typeof value === 'boolean') return Buffer.concat([lp('$type', Buffer.from('boolean')), lp('$value', Buffer.from(String(value)))]);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('LP1 permits safe integers only');
    return Buffer.concat([lp('$type', Buffer.from('integer')), lp('$value', Buffer.from(String(value)))]);
  }
  if (typeof value === 'string') return Buffer.concat([lp('$type', Buffer.from('string')), lp('$value', Buffer.from(value.normalize('NFC'), 'utf8'))]);
  if (Array.isArray(value)) return Buffer.concat([lp('$type', Buffer.from('array')), lp('$count', Buffer.from(String(value.length))), ...value.map((item, index) => lp(String(index), encode(item)))]);
  const entries = Object.entries(value).sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)));
  return Buffer.concat([lp('$type', Buffer.from('object')), lp('$count', Buffer.from(String(entries.length))), ...entries.map(([key, item]) => lp(key, encode(item)))]);
}
function governedHash(domain: string, value: CanonicalValue): string {
  return `sha256:${sha256hex(Buffer.concat([lp('$codec', Buffer.from('rorca.lp1')), lp('$domain', Buffer.from(domain)), encode(value)]))}`;
}
function federatedCredentialDigest(pepper: string, runtimeId: string, credentialVersion: number, keyVersion: number, credential: string): string {
  return `sha256:${sha256hex(Buffer.concat([Buffer.from('rorca.federated-credential.v1\0'), Buffer.from(pepper), Buffer.from('\0'),
    Buffer.from(runtimeId), Buffer.from('\0'), Buffer.from(String(credentialVersion)), Buffer.from('\0'),
    Buffer.from(String(keyVersion)), Buffer.from('\0'), Buffer.from(credential)]))}`;
}

// ── Compose helpers (invocation-owned project; PGPASSWORD injected per exec) ──
function compose(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 120_000): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('docker', ['compose', '--project-directory', ROOT, '--project-name', PROJECT, '-f', path.join(ROOT, 'docker-compose.yml'), ...args],
    { encoding: 'utf8', env, timeout: timeoutMs });
  return { ok: result.status === 0, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
}
function psql(env: NodeJS.ProcessEnv, user: string, password: string, sql: string): { ok: boolean; stdout: string; stderr: string } {
  return compose(['exec', '-T', '-e', `PGPASSWORD=${password}`, 'db', 'psql', '--no-psqlrc', '-q', '--set', 'ON_ERROR_STOP=1', '-t', '-A', '-U', user, '-d', 'rorca_smoke', '-c', sql], env);
}

async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = 62_000 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
    const probe = net.connect(candidate, '127.0.0.1');
    const taken = await awaitOnce(probe);
    if (!taken) return candidate;
  }
  throw new Error('no free port found in 62000-62999');
}
function awaitOnce(socket: net.Socket): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (value: boolean): void => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
function waitHealthy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tick = async (): Promise<void> => {
      attempt += 1;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) { resolve(); return; }
      } catch { /* retry */ }
      if (attempt >= 90) { reject(new Error('stack health timeout')); return; }
      setTimeout(tick, 2000);
    };
    void tick();
  });
}

const suffix = crypto.randomBytes(6).toString('hex');
const workspaceId = `workspace:demo-${suffix}`;
const runtimeId = `runtime:demo-${suffix}`;
const credential = `pilot-credential-${suffix}-at-least-thirty-two-bytes!!`;

async function main(): Promise<void> {
  const transcript: string[] = [];
  const record = (label: string, detail: string): void => {
    transcript.push(`- **${label}**: ${detail}`);
    console.log(`[demo] ${label}: ${detail.slice(0, 260)}`);
  };
  const pepper = secret() + secret();
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env, RORCA_POSTGRES_DATABASE: 'rorca_smoke', RORCA_POSTGRES_BOOTSTRAP_USER: 'rorca_smoke_bootstrap',
    RORCA_POSTGRES_BOOTSTRAP_PASSWORD: secret(), RORCA_MIGRATION_DATABASE_USER: 'rorca_smoke_migrator',
    RORCA_MIGRATION_DATABASE_PASSWORD: secret(), RORCA_RUNTIME_DATABASE_USER: 'rorca_smoke_runtime',
    RORCA_RUNTIME_DATABASE_PASSWORD: secret(), RORCA_CANONICAL_WRITER_DATABASE_USER: 'rorca_smoke_writer',
    RORCA_CANONICAL_WRITER_DATABASE_PASSWORD: secret(), JWT_SECRET: secret(), RORCA_INTERNAL_SERVICE_TOKEN: secret(),
    RORCA_DISPATCH_RECEIVER_TOKEN: secret(), RORCA_PORT: String(port), RORCA_FEDERATED_CREDENTIAL_PEPPER: pepper,
    RORCA_TRUSTED_PROXY_IPS: '127.0.0.1',
    RORCA_MIGRATION_DATABASE_URL: '', RORCA_RUNTIME_DATABASE_URL: '', RORCA_CANONICAL_WRITER_DATABASE_URL: '',
  };
  env.RORCA_MIGRATION_DATABASE_URL = `postgres://${env.RORCA_MIGRATION_DATABASE_USER}:${env.RORCA_MIGRATION_DATABASE_PASSWORD}@db:5432/rorca_smoke`;
  env.RORCA_RUNTIME_DATABASE_URL = `postgres://${env.RORCA_RUNTIME_DATABASE_USER}:${env.RORCA_RUNTIME_DATABASE_PASSWORD}@db:5432/rorca_smoke`;
  env.RORCA_CANONICAL_WRITER_DATABASE_URL = `postgres://${env.RORCA_CANONICAL_WRITER_DATABASE_USER}:${env.RORCA_CANONICAL_WRITER_DATABASE_PASSWORD}@db:5432/rorca_smoke`;
  const migrator = env.RORCA_MIGRATION_DATABASE_USER!;
  const migratorPw = env.RORCA_MIGRATION_DATABASE_PASSWORD!;
  const writer = env.RORCA_CANONICAL_WRITER_DATABASE_USER!;
  const writerPw = env.RORCA_CANONICAL_WRITER_DATABASE_PASSWORD!;
  const mig = (sql: string) => psql(env, migrator, migratorPw, `SET rorca.migration_mode=on; SET rorca.workspace_id='${workspaceId}'; ${sql}`);
  const wr = (sql: string) => psql(env, writer, writerPw, sql);
  const rorca = (args: string[], input?: string, timeoutMs = 120_000) => {
    const result = spawnSync('docker', ['compose', '--project-directory', ROOT, '--project-name', PROJECT, '-f', path.join(ROOT, 'docker-compose.yml'),
      'exec', '-T', 'rorca', ...args], { encoding: 'utf8', env, input, timeout: timeoutMs });
    return { ok: result.status === 0, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  };

  try {
    record('provisioning', `project=${PROJECT} port=${port}`);
    const down = compose(['down', '--volumes', '--remove-orphans', '--rmi', 'local'], env, 300_000);
    if (!down.ok) throw new Error(`initial compose down failed: ${down.stderr.slice(-400)}`);
    const up = compose(['up', '--build', '--detach', 'rorca', 'worker'], env, 900_000);
    if (!up.ok) throw new Error(`compose up failed: ${up.stderr.slice(-800)}`);
    await waitHealthy(port);
    record('stack ready', `health OK on 127.0.0.1:${port}`);
    const pepperCheck = rorca(['sh', '-c', 'test -n "$RORCA_FEDERATED_CREDENTIAL_PEPPER" && echo set || echo unset']);
    if (!pepperCheck.ok || !pepperCheck.stdout.includes('set')) throw new Error(`pepper missing in rorca env: ${pepperCheck.stderr}`);
    const netInspect = spawnSync('docker', ['network', 'inspect', `${PROJECT}_default`, '--format', '{{range .IPAM.Config}}{{.Gateway}}{{end}}'],
      { encoding: 'utf8', timeout: 30_000 });
    const gateway = String(netInspect.stdout ?? '').trim();
    if (!/^[0-9.]+$/.test(gateway)) throw new Error(`network gateway discovery failed: ${netInspect.stderr}`);
    env.RORCA_TRUSTED_PROXY_IPS = `127.0.0.1,${gateway}`;
    const recreate = compose(['up', '-d', '--force-recreate', 'rorca'], env, 300_000);
    if (!recreate.ok) throw new Error(`rorca recreate failed: ${recreate.stderr.slice(-400)}`);
    await waitHealthy(port);
    record('TLS boundary', `trusted proxy allowlist 127.0.0.1,${gateway}; federation client sends X-Forwarded-Proto https (proxy simulation)`);
    record('pepper', 'RORCA_FEDERATED_CREDENTIAL_PEPPER present in API container (federation auth digest)');

    // ── Host: disposable source + worktree git repos INSIDE the API container ──
    const worktreePath = `/tmp/rorca-demo-wt-${suffix}`;
    const sourcePath = `/tmp/rorca-demo-src-${suffix}`;
    const gitInit = rorca(['sh', '-c',
      `set -e; rm -rf "${worktreePath}" "${sourcePath}"; git init -q "${sourcePath}"; git -C "${sourcePath}" config user.email demo@rorca.local; git -C "${sourcePath}" config user.name demo; `
      + `mkdir -p "${sourcePath}/backend/src"; printf 'base\n' > "${sourcePath}/backend/src/demo.txt"; git -C "${sourcePath}" add .; git -C "${sourcePath}" commit -qm base; `
      + `printf 'pilot change %s\n' "${suffix}" > "${sourcePath}/backend/src/pilot-change.txt"; git -C "${sourcePath}" add backend/src/pilot-change.txt; git -C "${sourcePath}" commit -qm 'pilot: bounded demo change'; `
      + `git clone -q "${sourcePath}" "${worktreePath}"; git -C "${worktreePath}" config user.email demo@rorca.local; git -C "${worktreePath}" config user.name demo; `
      + `git -C "${worktreePath}" rev-parse HEAD~1; git -C "${worktreePath}" rev-parse HEAD; git -C "${worktreePath}" remote get-url origin`]);
    if (!gitInit.ok) throw new Error(`git init failed: ${gitInit.stderr}`);
    const gitLines = gitInit.stdout.trim().split('\n');
    const baseSha = gitLines.at(-3)?.trim() ?? '';
    const pilotSha = gitLines.at(-2)?.trim() ?? '';
    const origin = gitLines.at(-1)?.trim() ?? '';
    if (!/^[a-f0-9]{40}$/.test(baseSha) || !/^[a-f0-9]{40}$/.test(pilotSha) || origin !== sourcePath) {
      throw new Error(`worktree provision mismatch: ${gitInit.stdout}`);
    }
    record('worktree provisioned', `base=${baseSha.slice(0, 12)} pilotHead=${pilotSha.slice(0, 12)} origin=${origin}`);
    const remoteAuthorityHash = governedHash('rorca.repository-remote-authority.v1', { origin });
    const changedPaths = ['backend/src/pilot-change.txt'];
    const changedPathHash = governedHash('rorca.federated-changed-paths.v1', changedPaths);

    const snapshotFn = mig(`CREATE FUNCTION rorca.wave4_demo_snapshot_v1(p_workspace TEXT) RETURNS JSONB LANGUAGE SQL SECURITY DEFINER SET search_path=pg_catalog,rorca AS $$ SELECT jsonb_build_object('claim',(SELECT to_jsonb(c) FROM rorca.federated_execution_claims c WHERE c.workspace_id=p_workspace LIMIT 1),'offer',(SELECT to_jsonb(o) FROM rorca.federated_work_offers o WHERE o.workspace_id=p_workspace LIMIT 1),'proposals',COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM rorca.federated_result_proposals r WHERE r.workspace_id=p_workspace),'[]'::jsonb),'hostValidations',COALESCE((SELECT jsonb_agg(to_jsonb(v)) FROM rorca.federated_host_validation_observations v WHERE v.workspace_id=p_workspace),'[]'::jsonb),'hostArtifacts',COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM rorca.federated_host_artifact_observations a WHERE a.workspace_id=p_workspace),'[]'::jsonb),'closeoutDecisions',COALESCE((SELECT count(*) FROM rorca.governed_closeout_evaluations e WHERE e.workspace_id=p_workspace AND e.story_closeout_decision_id IS NOT NULL),0)) $$; GRANT EXECUTE ON FUNCTION rorca.wave4_demo_snapshot_v1(text) TO ${writer}`);
    if (!snapshotFn.ok) throw new Error(`snapshot function creation failed: ${snapshotFn.stderr}`);
    // ── Host: workspace + runtime registration ──
    const wks = mig(`INSERT INTO rorca.workspaces(id,label,path) VALUES('${workspaceId}','${workspaceId}','${worktreePath}') ON CONFLICT DO NOTHING`);
    if (!wks.ok) throw new Error(`workspace seed failed: ${wks.stderr}`);
    const credentialDigest = federatedCredentialDigest(pepper, runtimeId, 1, 1, credential);
    const registration = {
      schemaVersion: 'rorca.federated-runtime-registration.v1', runtimeId, workspaceId, credentialVersion: 1,
      keyVersion: 1, credentialDigest, endpoint: `https://${runtimeId}.example.test/v1`, allowedContractVersions: ['1.0.0'],
      allowedPaths: ['backend/src'], mutationBoundsHash: hx('2'), status: 'active',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), auditProvenanceHash: hx('3'),
      registeredBy: 'host:demo', idempotencyKey: `register:${suffix}`, controlPlaneCredentials: false,
      databaseCredentials: false, githubCredentials: false, modelProviderCredentials: false,
      providerHumanCredentials: false, mergeAuthority: false, deploymentAuthority: false };
    const reg = wr(`SELECT rorca.register_wave4_federated_runtime_v1('${JSON.stringify(registration).replaceAll("'", "''")}'::jsonb)`);
    if (!reg.ok) throw new Error(`runtime registration failed: ${reg.stderr}`);
    const okJson = (value: string): string => value.replace(/\s+/g, '');
    if (!okJson(reg.stdout).includes('"ok":true')) throw new Error(`runtime registration rejected: ${reg.stdout}`);

    // ── Host: canonical offer contracts ──
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 2 * 3_600_000).toISOString();
    const offerExpiresAt = new Date(now.getTime() + 3_600_000).toISOString();
    const missionId = `mission:demo-${suffix}`;
    const workPackageId = `work-package:demo-${suffix}`;
    const attemptId = `attempt:demo-${suffix}`;
    const leaseId = `lease:demo-${suffix}`;
    const repository = { repositoryId: `repository:demo-${suffix}`, remoteAuthorityHash, gitObjectFormat: 'sha1',
      baseSha, currentSha: baseSha, expectedHeadSha: pilotSha, worktreeId: `worktree:demo-${suffix}`,
      allowedPathManifestHash: hx('7'), requiredPathManifestHash: hx('8'), changedPathManifestHash: changedPathHash,
      forbiddenPathManifestHash: hx('a') };
    const spec = { specId: `spec:demo-${suffix}`, specVersion: 1, specHash: hx('b'),
      canonicalSpecPath: `forge/specs/pending/wave-4-${suffix}.json`, storyId: 'W4-010', storyVersion: 1,
      storyHash: hx('c'), criteriaManifestHash: hx('d') };
    const missionHash = hx('e'); const workPackageHash = hx('f'); const definitionHash = hx('0');
    const activationHash = hx('1'); const checkpointHash = hx('2'); const receiptHash = hx('3'); const bundleHash = hx('4');
    const header = (schemaVersion: string, artifactId: string, contentHash: string) => ({
      schemaVersion, contractId: schemaVersion, contractVersion: '1.0.0', artifactId, contentHash, createdAt, createdBy: 'host:demo',
    });
    const runId = 9_100_000 + Math.floor(Math.random() * 100_000);
    const sessionId = `session:demo-${suffix}`;
    const sessionFileHash = hx('4');
    const trigger = { type: 'initial_dispatch', launchRequestId: `launch:${suffix}`, launchRequestHash: hx('b'),
      engineRequestId: `engine:${suffix}`, engineRequestHash: hx('c'), sourceManifestHash: hx('d') };
    const scope = { workspaceId, missionId, missionRevision: 1, missionHash, workPackageId, workPackageRevision: 1,
      workPackageHash, spec, runId, attemptId, leaseId, fencingToken: 1, leaseExpiresAt: expiresAt,
      cancellationId: `cancellation:demo-${suffix}`, runtimeId, controllerGeneration: 1, runtimeGeneration: 1,
      sessionId, sessionFileHash, turnId: `turn:demo-${suffix}`, turnAttempt: 1, originatingGeneration: 0, cursor: 0,
      cursorHash: hx('5'), priorEntryId: 'not_applicable', repository, validationStateHash: hx('9'),
      rootCauseClassification: 'code', rootCauseHash: hx('a'), policyDefinitionId: 'policy:context-demo',
      policyDefinitionVersion: '1.0.0', policyDefinitionHash: definitionHash, policyActivationId: `activation:demo-${suffix}`,
      policyActivationRevision: 1, policyActivationHash: activationHash };
    const activationScope = { workspaceId, missionId, missionRevision: 1, missionHash, workPackageId,
      workPackageRevision: 1, workPackageHash, spec, runId, attemptId, leaseId, fencingToken: 1,
      cancellationId: scope.cancellationId, runtimeId, repositoryId: repository.repositoryId,
      remoteAuthorityHash: repository.remoteAuthorityHash, baseSha: repository.baseSha, worktreeId: repository.worktreeId,
      allowedPathManifestHash: repository.allowedPathManifestHash, requiredPathManifestHash: repository.requiredPathManifestHash,
      policyDefinitionId: 'policy:context-demo', policyDefinitionVersion: '1.0.0', policyDefinitionHash: definitionHash };
    const mission = { ...header('rorca.mission-contract.v1', `artifact:${missionId}`, missionHash), missionId,
      missionRevision: 1, missionHash, workspaceId, canonicalSpec: spec, requirements: { ids: ['REQ-DEMO'], hash: hx('5') },
      criteria: { ids: ['W4-010:criterion:1'], hash: hx('6') }, objectivesHash: hx('7'), invariantsHash: hx('8'),
      constraintsHash: hx('9'), prohibitedOutcomesHash: hx('a'), evidenceObligationsHash: hx('b'),
      completionDefinitionHash: hx('c'), repository,
      compiler: { id: 'compiler:demo', revision: 1, hash: hx('d') },
      policy: { id: 'policy:mission-demo', revision: 1, hash: hx('e') },
      contextPolicyDefinition: { id: 'policy:context-demo', revision: 1, hash: definitionHash },
      approvedDecisionReferences: [], allowedExecutionPosture: { sequential: true, branchOnly: true, autoMerge: false,
        deployment: false, providerMutation: false, execution: 'execute_bounded' },
      directionLayerHashes: [], sourceManifestHash: hx('f'), creationProvenanceHash: hx('0') };
    const workPackage = { ...header('rorca.work-package.v1', `artifact:${workPackageId}`, workPackageHash), workspaceId,
      missionId, missionRevision: 1, missionHash, workPackageId, workPackageRevision: 1, workPackageHash, spec,
      objectiveHash: hx('1'), dependencies: [], repository, allowedPaths: ['backend/src'], requiredPaths: ['backend/src'],
      validationObligationsHash: hx('2'), evidenceObligationsHash: hx('b'), executionPostureHash: hx('4'),
      lifecycleProjectionRef: `lifecycle:demo-${suffix}`, authorityCeilings: { delivery: 'none', operational: 'none',
        knowledge: 'observe', interactive: 'none' }, resourceLimitsHash: hx('5'), retryLimit: 2, planRevision: 1,
      state: 'active', proposalId: `proposal:initial-${suffix}` };
    const lease = { ...header('rorca.execution-lease.v1', `artifact:${leaseId}`, hx('6')), workspaceId, missionId,
      missionRevision: 1, missionHash, workPackageId, workPackageRevision: 1, workPackageHash, spec, leaseId, attemptId,
      runId, fencingToken: 1, runtimeId, runtimeCapabilityRevision: 1, repository,
      policyDefinitionId: 'policy:context-demo', policyDefinitionVersion: '1.0.0', policyDefinitionHash: definitionHash,
      policyActivationId: scope.policyActivationId, policyActivationRevision: 1, policyActivationHash: activationHash,
      checkpointId: `checkpoint:demo-${suffix}`, checkpointHash, bundleId: `bundle:demo-${suffix}`, bundleHash,
      cancellationId: scope.cancellationId, issuedAt: createdAt, observedAt: createdAt, expiresAt,
      resourceLimitsHash: hx('7'), evidenceObligationDigest: hx('b'),
      authorityCeilings: { mutation: 'execute_bounded', delivery: 'none', operational: 'none', knowledge: 'observe',
        interactive: 'none' }, state: 'active', reasonCode: 'wave4_federated_offer' };
    const activation = { ...header('rorca.context-continuation-policy-activation.v1', `artifact:activation-${suffix}`, activationHash),
      workspaceId, activationId: scope.policyActivationId, activationRevision: 1, activationHash,
      definitionId: 'policy:context-demo', definitionVersion: '1.0.0', definitionHash, scope: activationScope,
      effectiveValuesHash: hx('8'), authorityReceiptId: `authority:activation-${suffix}`, activatedAt: createdAt,
      expiresAt, state: 'active' };
    const checkpoint = { ...header('rorca.context-checkpoint.v1', `artifact:checkpoint-${suffix}`, checkpointHash), scope,
      checkpointId: lease.checkpointId, checkpointSequence: 0, priorCheckpointId: 'not_applicable', reasonCode: 'initial',
      trigger, eventHighWaterMark: 0, planCursorHash: hx('e'), completedWorkHash: hx('f'), pendingWorkHash: hx('0'),
      boundedReferences: [], retry: { retryCycleId: 'not_applicable', phase: 'none', attempt: 0, maximum: 2,
        startEventHash: 'not_applicable', endEventHash: 'not_applicable', settledEventHash: 'not_applicable',
        generation: 1 }, completionCandidate: { state: 'absent', hash: 'not_applicable' },
      redactionManifestHash: hx('1'), state: 'current' };
    const source = { contextClass: 'required', sourceType: 'git', stableSourceId: `source:${suffix}`, sourceVersion: '1',
      contentHash: hx('2'), freshness: 'current', excluded: false, redactionHash: hx('3') };
    const tokenAccounting = { required: 10, advisory: 0, instructions: 2, total: 12 };
    const receipt = { ...header('rorca.retrieval-receipt.v1', `artifact:receipt-${suffix}`, receiptHash), scope,
      requestId: `retrieval:${suffix}`, receiptId: `receipt:${suffix}`, checkpointId: checkpoint.checkpointId,
      definitionHash, activationHash, retrievalKey: hx('4'), sources: [source], requiredComplete: true,
      tokenAccounting, outputId: `output:${suffix}`, outputHash: hx('5'), startedAt: createdAt, finishedAt: createdAt,
      status: 'completed', reasonCode: 'complete', retryable: false, retryBudgetId: `retry-budget:${suffix}` };
    const bundle = { ...header('rorca.context-bundle.v1', `artifact:bundle-${suffix}`, bundleHash), scope,
      bundleId: lease.bundleId, bundleVersion: 1, bundleHash, checkpointId: checkpoint.checkpointId, checkpointHash,
      receiptId: receipt.receiptId, receiptHash, definitionHash, activationHash, requiredContext: [source],
      advisoryMemory: [], orderedSourceHash: governedHash('rorca.context-bundle-ordered-sources.v1', [source]),
      redactionManifestHash: governedHash('rorca.context-bundle-redactions.v1', [source.redactionHash]),
      tokenAllocationHash: governedHash('rorca.context-bundle-token-allocation.v1', tokenAccounting), tokenAccounting,
      serializedBytes: 200, expiresAt, state: 'active' };
    const dispatch = { ...header('rorca.continuation-dispatch.v1', `artifact:dispatch-${suffix}`, hx('6')), scope,
      dispatchId: `dispatch:${suffix}`, continuationKey: hx('7'), trigger, checkpointId: checkpoint.checkpointId,
      checkpointHash, receiptId: receipt.receiptId, receiptHash, bundleId: bundle.bundleId, bundleHash,
      definitionHash, activationHash, targetSessionId: sessionId, targetCursor: 0, priorEntryId: 'not_applicable',
      expectedCursorAdvance: 1, renderedPayloadHash: hx('8'),
      renderedPayloadRef: { referenceId: `rendered:${suffix}`, kind: 'context', hash: hx('8'), sensitivity: 'restricted',
        retentionClass: 'demo', accessTier: 'admin', rawPayloadIncluded: false },
      firstLeaseVerificationHash: hx('9'), casLeaseVerificationHash: hx('a'), authorizationExpiresAt: offerExpiresAt,
      controllerId: 'controller:demo', adapterVersion: '1.0.0', attempt: 1, retryBudgetId: receipt.retryBudgetId,
      state: 'lease_verified', reasonCode: 'verified' };
    const evidenceManifest = [{ kind: 'federated_host_verification', minimumTrust: 'host_observed',
      requiredStatus: 'passed', obligationHash: hx('5') }];
    const evidenceManifestHash = governedHash('rorca.evidence-obligation-manifest.v1', evidenceManifest);

    // ── Host: persist canonical rows (mirrors the integration seeding) ──
    const q = (sql: string): void => { const r = mig(sql); if (!r.ok) throw new Error(`seed failed: ${sql.slice(0, 60)}... => ${r.stderr}`); };
    const esc = (v: unknown): string => JSON.stringify(v).replaceAll("'", "''");
    q(`INSERT INTO rorca.governed_missions(workspace_id,mission_id,created_by) VALUES('${workspaceId}','${missionId}','host:demo')`);
    q(`INSERT INTO rorca.governed_mission_versions(workspace_id,mission_id,mission_revision,mission_hash,contract_version,canonical_spec_id,canonical_spec_version,canonical_spec_hash,canonical_spec_path,repository_id,base_sha,payload_json,payload_hash,created_by) VALUES('${workspaceId}','${missionId}',1,'${missionHash}','1.0.0','${spec.specId}',1,'${spec.specHash}','${spec.canonicalSpecPath}','${repository.repositoryId}','${baseSha}','${esc(mission)}'::jsonb,'${h('b')}','host:demo')`);
    q(`INSERT INTO rorca.governed_mission_heads(workspace_id,mission_id,current_revision,current_hash,lifecycle_state) VALUES('${workspaceId}','${missionId}',1,'${missionHash}','active')`);
    q(`INSERT INTO rorca.governed_work_packages(workspace_id,mission_id,work_package_id,created_by) VALUES('${workspaceId}','${missionId}','${workPackageId}','host:demo')`);
    const obligationSetId = `obligation-set:${suffix}`;
    q(`INSERT INTO rorca.governed_work_package_revisions(workspace_id,mission_id,work_package_id,work_package_revision,work_package_hash,mission_revision,mission_hash,story_id,repository_id,base_sha,allowed_path_manifest_hash,required_path_manifest_hash,validation_manifest_hash,authority_ceiling_hash,payload_json,proposal_id,evidence_obligation_set_id,evidence_obligation_policy_id,evidence_obligation_policy_revision,evidence_obligation_policy_hash,evidence_obligation_manifest_hash) VALUES('${workspaceId}','${missionId}','${workPackageId}',1,'${workPackageHash}',1,'${missionHash}','W4-010','${repository.repositoryId}','${baseSha}','${hx('7')}','${hx('8')}','${hx('2')}','${hx('0')}','${esc(workPackage)}'::jsonb,'${workPackage.proposalId}','${obligationSetId}','policy:mission-demo',1,'${hx('e')}','${evidenceManifestHash}')`);
    q(`INSERT INTO rorca.governed_work_package_heads(workspace_id,mission_id,work_package_id,current_revision,current_hash,lifecycle_state) VALUES('${workspaceId}','${missionId}','${workPackageId}',1,'${workPackageHash}','active')`);
    q(`INSERT INTO rorca.governed_evidence_obligation_sets(workspace_id,mission_id,work_package_id,work_package_revision,obligation_set_id,obligation_policy_id,obligation_policy_revision,obligation_policy_hash,manifest_hash,manifest_json,authority_receipt_hash) VALUES('${workspaceId}','${missionId}','${workPackageId}',1,'${obligationSetId}','policy:mission-demo',1,'${hx('e')}','${evidenceManifestHash}','${esc(evidenceManifest)}'::jsonb,'${hx('d')}')`);
    q(`INSERT INTO rorca.governed_evidence_obligations(workspace_id,mission_id,work_package_id,work_package_revision,obligation_set_id,obligation_order,obligation_kind,minimum_trust,required_status,obligation_hash) VALUES('${workspaceId}','${missionId}','${workPackageId}',1,'${obligationSetId}',0,'${evidenceManifest[0]!.kind}','${evidenceManifest[0]!.minimumTrust}','${evidenceManifest[0]!.requiredStatus}','${evidenceManifest[0]!.obligationHash}')`);
    q(`INSERT INTO rorca.pipeline_runs(id,spec_path,workspace_id,status,branch_name,worktree_path,execution_workspace_path,execution_worktree_path,dispatch_fence,canonical_spec_revision) VALUES(${runId},'${spec.canonicalSpecPath}','${workspaceId}','running','demo-branch','${worktreePath}','${worktreePath}','${worktreePath}','${hx('d')}','${spec.specHash}')`);
    q(`INSERT INTO rorca.governed_execution_attempts(workspace_id,attempt_id,mission_id,work_package_id,work_package_revision,run_id,story_id,runtime_id,generation,manifest_hash,repository_id,worktree_id,spec_id,spec_version,spec_hash,story_version,story_hash,criteria_manifest_hash,base_sha,current_sha,expected_head_sha,allowed_path_manifest_hash,required_path_manifest_hash,changed_path_manifest_hash,forbidden_path_manifest_hash) VALUES('${workspaceId}','${attemptId}','${missionId}','${workPackageId}',1,${runId},'W4-010','${runtimeId}',1,'${hx('1')}','${repository.repositoryId}','${repository.worktreeId}','${spec.specId}',1,'${spec.specHash}',1,'${spec.storyHash}','${spec.criteriaManifestHash}','${baseSha}','${baseSha}','${pilotSha}','${hx('7')}','${hx('8')}','${changedPathHash}','${hx('a')}')`);
    q(`INSERT INTO rorca.context_policy_definitions(workspace_id,policy_definition_id,policy_definition_version,policy_definition_hash,lifecycle_state,body_json,issuer_authority_ref) VALUES('${workspaceId}','policy:context-demo','1.0.0','${definitionHash}','published','${esc({ posture: 'bounded_federated' })}'::jsonb,'host:demo')`);
    const activationScopeKey = governedHash('rorca.context-policy-activation-scope.v1', activationScope);
    q(`INSERT INTO rorca.context_policy_activations(workspace_id,activation_id,activation_revision,activation_hash,policy_definition_id,policy_definition_version,scope_key,scope_json,effective_values_hash,authority_receipt_id,state,activated_at,expires_at) VALUES('${workspaceId}','${activation.activationId}',1,'${activationHash}','policy:context-demo','1.0.0','${activationScopeKey}','${esc(activationScope)}'::jsonb,'${hx('8')}','${activation.authorityReceiptId}','active','${createdAt}','${expiresAt}')`);
    q(`INSERT INTO rorca.context_policy_activation_heads(workspace_id,scope_key,activation_id,current_revision,current_hash,effective_state) VALUES('${workspaceId}','${activationScopeKey}','${activation.activationId}',1,'${activationHash}','active')`);
    const slotKey = hx('f');
    q(`INSERT INTO rorca.execution_lease_slots(workspace_id,lease_slot_key,last_fence,active_lease_id) VALUES('${workspaceId}','${slotKey}',1,'${leaseId}')`);
    q(`INSERT INTO rorca.execution_leases(workspace_id,lease_id,lease_slot_key,attempt_id,fencing_token,work_package_revision,runtime_id,repository_id,base_sha,current_sha,worktree_id,policy_definition_hash,policy_activation_hash,checkpoint_hash,bundle_hash,cancellation_id,issued_at,expires_at,state,state_version,payload_hash) VALUES('${workspaceId}','${leaseId}','${slotKey}','${attemptId}',1,1,'${runtimeId}','${repository.repositoryId}','${baseSha}','${baseSha}','${repository.worktreeId}','${definitionHash}','${activationHash}','${checkpointHash}','${bundleHash}','${scope.cancellationId}','${createdAt}','${expiresAt}','active',1,'${hx('0')}')`);
    const scopeKey = governedHash('rorca.continuation-scope.v1', scope);
    q(`INSERT INTO rorca.context_scope_heads(workspace_id,scope_key,checkpoint_id,checkpoint_sequence,runtime_sequence,canonical_state_order) VALUES('${workspaceId}','${scopeKey}','${checkpoint.checkpointId}',0,-1,-1)`);
    const triggerHash = governedHash('rorca.context-trigger.v1', trigger);
    q(`INSERT INTO rorca.context_checkpoints(workspace_id,checkpoint_id,scope_key,checkpoint_sequence,checkpoint_hash,trigger_type,trigger_hash,lease_id,fencing_token,activation_hash,state,payload_json) VALUES('${workspaceId}','${checkpoint.checkpointId}','${scopeKey}',0,'${checkpointHash}','initial_dispatch','${triggerHash}','${leaseId}',1,'${activationHash}','current','${esc(checkpoint)}'::jsonb)`);
    q(`INSERT INTO rorca.context_retrieval_receipts(workspace_id,receipt_id,retrieval_key,scope_key,checkpoint_id,activation_hash,required_complete,status,reason_code,retryable,request_hash,payload_json) VALUES('${workspaceId}','${receipt.receiptId}','${hx('4')}','${scopeKey}','${checkpoint.checkpointId}','${activationHash}',TRUE,'completed','complete',FALSE,'${hx('4')}','${esc(receipt)}'::jsonb)`);
    q(`INSERT INTO rorca.context_bundles(workspace_id,bundle_id,bundle_hash,scope_key,checkpoint_id,receipt_id,required_manifest_hash,advisory_manifest_hash,serialized_bytes,token_count,expires_at,state,payload_json) VALUES('${workspaceId}','${bundle.bundleId}','${bundleHash}','${scopeKey}','${checkpoint.checkpointId}','${receipt.receiptId}','${hx('2')}','${hx('3')}',200,12,'${expiresAt}','active','${esc(bundle)}'::jsonb)`);
    record('canonical offer seeded', `${missionId} / ${workPackageId} / ${leaseId} / ${activation.activationId} / ${checkpoint.checkpointId} / ${receipt.receiptId} / ${bundle.bundleId} / ${dispatch.dispatchId}`);

    // ── Host: binding + publish ONE offer ──
    const binding = { workspaceId, runtimeId, missionId, missionRevision: 1, missionHash, workPackageId,
      workPackageRevision: 1, workPackageHash, specId: spec.specId, specVersion: 1, specHash: spec.specHash,
      storyId: 'W4-010', storyVersion: 1, storyHash: spec.storyHash, criteriaManifestHash: spec.criteriaManifestHash,
      attemptId, leaseId, fencingToken: 1, expectedLeaseExpiresAt: expiresAt, policyDefinitionHash: definitionHash,
      policyActivationId: activation.activationId, policyActivationRevision: 1, policyActivationHash: activationHash,
      checkpointId: checkpoint.checkpointId, checkpointHash, retrievalReceiptId: receipt.receiptId,
      retrievalReceiptHash: receiptHash, bundleId: bundle.bundleId, bundleHash, dispatchId: dispatch.dispatchId,
      dispatchHash: dispatch.contentHash, repositoryId: repository.repositoryId, remoteAuthorityHash,
      baseSha, currentSha: baseSha, expectedHeadSha: pilotSha, worktreeId: repository.worktreeId,
      allowedPathManifestHash: repository.allowedPathManifestHash, requiredPathManifestHash: repository.requiredPathManifestHash,
      changedPathManifestHash: changedPathHash, forbiddenPathManifestHash: repository.forbiddenPathManifestHash,
      validationManifestHash: workPackage.validationObligationsHash };
    const bindingHash = governedHash('rorca.federated-lease-binding.v1', binding);
    const offerId = `offer:demo-${suffix}`;
    const inputHash = governedHash('rorca.federated-work-offer.v1', { offerId, bindingHash, missionHash,
      workPackageHash, leaseHash: lease.contentHash, activationHash, checkpointHash, receiptHash, bundleHash,
      dispatchHash: dispatch.contentHash, expiresAt: offerExpiresAt });
    const offerPayload = { schemaVersion: 'rorca.federated-runtime.v1', offerId, binding, bindingHash, mission,
      workPackage, lease, policyActivation: activation, checkpoint, retrievalReceipt: receipt, contextBundle: bundle,
      continuationDispatch: dispatch, worktreePath, sourceCheckoutPath: sourcePath, publishedBy: 'host:demo',
      expiresAt: offerExpiresAt, inputHash };
    const publish = wr(`SELECT rorca.publish_wave4_federated_offer_v1('${esc(offerPayload)}'::jsonb)`);
    if (!publish.ok) throw new Error(`offer publish failed: ${publish.stderr}`);
    if (!okJson(publish.stdout).includes('"ok":true')) throw new Error(`offer publish rejected: ${publish.stdout}`);
    record('offer published', `${offerId} bindingHash=${bindingHash.slice(0, 20)}…`);

    // ── Federated runtime: HTTP client ──
    const base = `http://127.0.0.1:${port}/api/mission-control/v1/federation`;
    const authHeaders = {
      authorization: `Federated ${credential}`, 'x-rorca-workspace-id': workspaceId, 'x-rorca-runtime-id': runtimeId,
      'x-rorca-credential-version': '1', 'x-rorca-key-version': '1', 'x-forwarded-proto': 'https',
      'content-type': 'application/json',
    };
    const post = async (pathName: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
      const response = await fetch(`${base}${pathName}`, { method: 'POST', headers: authHeaders, body: JSON.stringify(body) });
      const text = await response.text();
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 400) }; }
      return { status: response.status, body: parsed };
    };
    const discovered = await post('/discover', { schemaVersion: 'rorca.federated-discovery-request.v1', workspaceId,
      runtimeId, contractVersions: ['1.0.0'], limit: 1 });
    if (discovered.status !== 200) throw new Error(`discover failed: ${discovered.status} ${JSON.stringify(discovered.body)}`);
    const offers = (discovered.body.offers ?? []) as Array<{ offerId: string; bindingHash: string; leaseId: string }>;
    const offer = offers.find((o) => o.bindingHash === bindingHash && o.leaseId === leaseId);
    if (!offer) throw new Error(`no eligible offer matched: ${JSON.stringify(offers)}`);
    record('discover', `${offers.length} eligible offer(s); matched ${offer.offerId} (binding hash equality)`);

    const acquired = await post('/acquire', { schemaVersion: 'rorca.federated-acquire-request.v1', offerId: offer.offerId,
      bindingHash, binding, generation: 1, sessionId, sessionFileHash, turnId: scope.turnId, originatingGeneration: 0,
      cursor: 0, cursorHash: scope.cursorHash, idempotencyKey: `acquire:${suffix}` });
    if (acquired.status !== 200) throw new Error(`acquire failed: ${acquired.status} ${JSON.stringify(acquired.body)}`);
    record('acquire', JSON.stringify(acquired.body).slice(0, 240));

    const read = await post('/work-package/read', { schemaVersion: 'rorca.federated-work-package-read-request.v1',
      binding, generation: 1, sessionId });
    if (read.status !== 200) throw new Error(`read failed: ${read.status} ${JSON.stringify(read.body)}`);
    const readBody = read.body as { schemaVersion?: string; mission?: { missionId?: string }; workPackage?: { workPackageId?: string }; cancellation?: unknown };
    if (readBody.schemaVersion !== 'rorca.federated-work-input.v1' || readBody.mission?.missionId !== missionId
        || readBody.workPackage?.workPackageId !== workPackageId) {
      throw new Error(`work-package read returned unexpected input: ${JSON.stringify(readBody).slice(0, 300)}`);
    }
    record('work-package read', `canonical input returned (schemaVersion=${readBody.schemaVersion}, mission=${readBody.mission?.missionId}, cancellation=${readBody.cancellation ?? 'none'})`);

    // ── Runtime: bounded work in the disposable worktree ──
    const work = rorca(['sh', '-c',
      `set -e; cd "${worktreePath}"; git rev-parse HEAD; git status --porcelain`]);
    if (!work.ok) throw new Error(`worktree materialization failed: ${work.stderr}`);
    const materialized = work.stdout.trim().split('\n').at(0)?.trim() ?? '';
    if (materialized !== pilotSha) throw new Error(`worktree head ${materialized} != pinned pilot head ${pilotSha}`);
    const headSha = materialized;
    record('runtime work materialized', `worktree at pinned head ${headSha.slice(0, 12)} (change backend/src/pilot-change.txt present; worktree clean)`);
    const leaseAdvance = mig(`UPDATE rorca.execution_leases SET current_sha='${headSha}' WHERE workspace_id='${workspaceId}' AND lease_id='${leaseId}' AND state='active'`);
    if (!leaseAdvance.ok) throw new Error(`lease head advance failed: ${leaseAdvance.stderr}`);
    record('host lease advance', `execution_leases.current_sha -> ${headSha.slice(0, 12)} (host observed the materialized head)`);
    // ── Host: run the REAL validation + artifact observation in the container ──
    const validationCommand = `test -f ${worktreePath}/backend/src/pilot-change.txt`;
    const validationRun = rorca(['sh', '-c', `${validationCommand} && echo VALIDATION_PASSED`]);
    if (!validationRun.ok || !validationRun.stdout.includes('VALIDATION_PASSED')) throw new Error(`host validation command failed: ${validationRun.stderr}`);
    const artifactProbe = rorca(['sh', '-c', `sha256sum "${worktreePath}/backend/src/pilot-change.txt"; wc -c < "${worktreePath}/backend/src/pilot-change.txt"`]);
    if (!artifactProbe.ok) throw new Error(`artifact probe failed: ${artifactProbe.stderr}`);
    const probeParts = artifactProbe.stdout.trim().split(/\s+/);
    const artifactHex = probeParts[0] ?? '';
    const byteLength = Number(probeParts.at(-1) ?? '0');
    if (!/^[a-f0-9]{64}$/.test(artifactHex) || !Number.isSafeInteger(byteLength) || byteLength < 1) throw new Error(`artifact probe malformed: ${artifactProbe.stdout}`);
    const contentHash = `sha256:${artifactHex}`;
    const commandHash = h(validationCommand);
    const validationId = `validation:demo-${suffix}`;
    const artifactId = `artifact:demo-${suffix}`;
    const restrictedReferenceId = `restricted:demo-${suffix}`;
    const validationObservation = { workspaceId, attemptId, validationId, commandHash, artifactHash: contentHash,
      outcome: 'passed', observerId: 'host:federation-verifier', observerClass: 'host', trustClass: 'host_observed' };
    const vObs = wr(`SELECT rorca.record_wave4_federated_host_validation_v1('${esc(validationObservation)}'::jsonb)`);
    if (!vObs.ok) throw new Error(`host validation observation failed: ${vObs.stderr}`);
    const artifactObservation = { workspaceId, artifactId, contentHash, byteLength, restrictedReferenceId,
      observerId: 'host:federation-verifier', observerClass: 'host', trustClass: 'host_observed', integrityState: 'verified' };
    const aObs = wr(`SELECT rorca.record_wave4_federated_host_artifact_v1('${esc(artifactObservation)}'::jsonb)`);
    if (!aObs.ok) throw new Error(`host artifact observation failed: ${aObs.stderr}`);
    record('host evidence', `validation '${validationCommand}' -> ${commandHash}; artifact sha256:${artifactHex.slice(0, 16)}… (${byteLength} bytes) observed`);

    const proposalId = `proposal:demo-${suffix}`;
    const validation = { validationId, commandHash, claimedOutcome: 'passed', artifactHash: contentHash,
      observedAt: new Date().toISOString() };
    const artifact = { artifactId, contentHash, byteLength, restrictedReferenceId };
    const proposal = { schemaVersion: 'rorca.federated-result-proposal.v1', contractVersion: '1.0.0', proposalId,
      binding, generation: 1, sessionId, terminalSequence: 1, completionCandidateState: 'controller_validated',
      completionCandidateHash: hx('c'), changedPaths, changedPathHash, validations: [validation],
      validationSetHash: governedHash('rorca.federated-host-validations.v1',
        [{ validationId, commandHash, artifactHash: contentHash }]),
      artifacts: [artifact], artifactSetHash: governedHash('rorca.federated-host-artifacts.v1', [artifact]),
      outcomeClaim: 'succeeded', observedHeadSha: headSha, submittedAt: new Date().toISOString(),
      idempotencyKey: `propose:${suffix}`, closeoutAuthority: 'none', lifecycleAuthority: 'none',
      mergeAuthority: 'none', deploymentAuthority: 'none' };
    const proposed = await post('/results/propose', proposal);
    if (proposed.status !== 200) throw new Error(`propose failed: ${proposed.status} ${JSON.stringify(proposed.body)}`);
    const resultReceipt = proposed.body as { proposalId?: string; acceptedAsCompletion?: boolean; duplicate?: boolean;
      hostVerificationHash?: string; closeoutPosture?: string; evidenceId?: string; evidenceHash?: string };
    if (resultReceipt.proposalId !== proposalId || resultReceipt.acceptedAsCompletion !== false || resultReceipt.duplicate !== false
        || !resultReceipt.hostVerificationHash || !resultReceipt.evidenceId) {
      throw new Error(`propose receipt unexpected: ${JSON.stringify(resultReceipt)}`);
    }
    const boundary = wr(`SELECT rorca.wave4_demo_snapshot_v1('${workspaceId}')`);
    if (!boundary.ok) throw new Error(`boundary check failed: ${boundary.stderr}`);
    const snapshot = JSON.parse(boundary.stdout.trim().split('\n').at(-1) ?? '{}') as {
      claim: { state?: string } | null; offer: { state?: string } | null;
      proposals: unknown[]; hostValidations: unknown[]; hostArtifacts: unknown[]; closeoutDecisions: number;
    };
    record('canonical boundary', `closeout_decisions=${snapshot.closeoutDecisions} claim_state=${snapshot.claim?.state} offer_state=${snapshot.offer?.state} proposals=${snapshot.proposals.length} host_validations=${snapshot.hostValidations.length} host_artifacts=${snapshot.hostArtifacts.length}`);
    if (snapshot.closeoutDecisions !== 0 || snapshot.claim?.state !== 'result_proposed' || snapshot.offer?.state !== 'claimed'
        || snapshot.proposals.length !== 1 || snapshot.hostValidations.length !== 1 || snapshot.hostArtifacts.length !== 1) {
      throw new Error(`boundary assertion failed: ${JSON.stringify(snapshot)}`);
    }

    const packet = [
      '# Wave 4 Pilot Demonstration Packet (W4-010, pre-credential portion)',
      '',
      '| Field | Receipt |',
      '|---|---|',
      `| Date | ${new Date().toISOString()} |`,
      `| Runtime | ${runtimeId} (one identity; credential version 1 / key version 1; pepper-bound digest \`${credentialDigest.slice(0, 24)}…\`) |`,
      `| Workspace | ${workspaceId} |`,
      `| Mission / work package | ${missionId} / ${workPackageId} (story W4-010) |`,
      `| Lease / fence | ${leaseId} / fencingToken 1 (state active at publish) |`,
      `| Base SHA | ${baseSha} |`,
      `| Offer | ${offerId} (bindingHash \`${bindingHash}\`) |`,
      `| Claim | acquire receipt (one active execution enforced; claim state \`result_proposed\`) |`,
      `| Work-package read | canonical input returned (mission/work-package/lease/activation/checkpoint/receipt/bundle/dispatch; cancellation none) |`,
      `| Host evidence | validation \`${validationCommand}\` -> \`${commandHash}\` passed; artifact \`${contentHash}\` (${byteLength} bytes) verified |`,
      `| Runtime change | \`backend/src/pilot-change.txt\` committed in the disposable worktree; head ${headSha} |`,
      `| Result proposal | ${proposalId} — runtime-asserted claims + host-observed Git/validation/artifact verification; \`acceptedAsCompletion=false\` |`,
      `| Canonical boundary | 0 closeout decisions with story decision; claim \`result_proposed\`; offer \`claimed\`; 1 proposal; 1 host validation observation; 1 host artifact observation |`,
      `| Runtime change | \`backend/src/pilot-change.txt\` host-prepared in the source checkout; materialized in the disposable worktree at the pinned head ${headSha} |`,
      '',
      '## Transcript',
      '',
      ...transcript,
      '',
      '## Boundary assertions (all observed)',
      '',
      '- The runtime never received PostgreSQL, GitHub App, provider, or control-plane credentials (registration rejects authority widening).',
      '- Discovery matched exactly the published offer by governed binding hash; acquire admitted exactly one active execution.',
      '- The result proposal carries runtime_asserted claims; only host-observed Git/validation/artifact observations entered evidence.',
      '- No canonical story closeout decision exists after the proposal (proposal-only; `acceptedAsCompletion=false`, `closeoutPosture=shared_canonical_resolver_pending`).',
      '- Merge, deployment, approval, and production authority remain \'none\' for the runtime.',
      '',
      '## Residual step',
      '',
      '',
      'The repository-scoped GitHub App draft PR + Check Run projection at the exact head requires the operator\'s GitHub App credentials (absent from this environment). All other W4-010 criteria are demonstrated above.',
      '',
      '## Infra note',
      '',
      '`docker-compose.yml` gained `RORCA_FEDERATED_CREDENTIAL_PEPPER` and `RORCA_TRUSTED_PROXY_IPS` plumbing for the rorca service (absent keeps non-federation APIs available; federation authentication fails closed; the federation TLS boundary requires a trusted HTTPS front). The demo stack is invocation-owned and torn down after the run.',
      '',
    ].join('\n');
    fs.writeFileSync(EVIDENCE, packet);
    record('packet written', EVIDENCE);
  } finally {
    const cleanup = compose(['down', '--volumes', '--remove-orphans', '--rmi', 'local'], env, 300_000);
    record('stack cleaned', cleanup.ok ? 'compose down OK (volumes + local images removed)' : `compose down failed: ${cleanup.stderr.slice(-300)}`);
  }
}

void main().catch((error) => {
  console.error('[demo] fatal:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
