#!/usr/bin/env node
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptRoot = path.resolve(path.dirname(scriptPath), '..');
const protectedRoots = new Set([
  '/Users/dimitriteravanessian/rorca',
  '/Users/dimitriteravanessian/hermes-rorca',
]);
const allowedPlaceholders = new Set([
  'node', 'rorcaRoot', 'hermesRoot', 'outputDir', 'historicalBroadJson',
  'pairNonce', 'hermesClient', 'hermesManifest',
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function git(root, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', root, ...args], {
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 128 * 1024 * 1024,
  });
}

function relativeStatusEntries(root) {
  const output = git(root, ['status', '--short', '--untracked-files=all']).trimEnd();
  if (!output) return [];
  return output.split('\n').map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
}

function untrackedFiles(root) {
  const output = git(root, ['ls-files', '--others', '--exclude-standard', '-z'], 'buffer');
  const files = output.toString('utf8').split('\0').filter(Boolean).sort();
  return files.map((relative) => {
    const absolute = path.resolve(root, relative);
    const expectedPrefix = `${path.resolve(root)}${path.sep}`;
    if (!absolute.startsWith(expectedPrefix)) throw new Error(`Untracked path escapes repository: ${relative}`);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      return { path: relative, type: 'symlink', bytes: Buffer.byteLength(target), sha256: sha256(target) };
    }
    if (!stat.isFile()) throw new Error(`Unsupported untracked entry type: ${relative}`);
    const bytes = fs.readFileSync(absolute);
    return { path: relative, type: 'file', bytes: bytes.length, sha256: sha256(bytes) };
  });
}

export function snapshotRepository(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const tree = git(root, ['rev-parse', 'HEAD^{tree}']).trim();
  const branch = git(root, ['branch', '--show-current']).trim();
  const statusBytes = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'buffer');
  const unstagedBytes = git(root, ['diff', '--binary'], 'buffer');
  const stagedBytes = git(root, ['diff', '--binary', '--cached'], 'buffer');
  const headDiffBytes = git(root, ['diff', '--binary', 'HEAD'], 'buffer');
  const status = relativeStatusEntries(root);
  const untracked = untrackedFiles(root);
  const content = {
    head,
    tree,
    statusSha256: sha256(statusBytes),
    unstagedDiffSha256: sha256(unstagedBytes),
    stagedDiffSha256: sha256(stagedBytes),
    headDiffSha256: sha256(headDiffBytes),
    untrackedFiles: untracked,
  };
  return {
    root,
    branch,
    head,
    tree,
    clean: status.length === 0,
    statusEntries: status.length,
    status,
    statusSha256: content.statusSha256,
    unstagedDiffSha256: content.unstagedDiffSha256,
    stagedDiffSha256: content.stagedDiffSha256,
    headDiffSha256: content.headDiffSha256,
    untrackedFiles: untracked,
    worktreeContentSha256: sha256(canonicalJson(content)),
  };
}

function validatePlaceholders(value, context) {
  for (const match of String(value).matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) {
    if (!allowedPlaceholders.has(match[1])) throw new Error(`${context} uses unknown placeholder {${match[1]}}`);
  }
}

function commandSteps(gate) {
  if (Array.isArray(gate.steps)) return gate.steps;
  if (gate.command) return [{ command: gate.command, args: gate.args ?? [] }];
  return [];
}

function validateCommand(step, gateId) {
  if (!step || typeof step.command !== 'string' || step.command.trim() === '') {
    throw new Error(`Gate ${gateId} has an invalid command`);
  }
  if (!Array.isArray(step.args) || !step.args.every((arg) => typeof arg === 'string')) {
    throw new Error(`Gate ${gateId} command args must be a string array`);
  }
  if (step.cwd !== undefined && !['rorca', 'rorca-backend', 'hermes'].includes(step.cwd)) {
    throw new Error(`Gate ${gateId} has invalid step cwd ${step.cwd}`);
  }
  validatePlaceholders(step.command, `Gate ${gateId} command`);
  for (const arg of step.args) validatePlaceholders(arg, `Gate ${gateId} argument`);

  const executable = path.basename(step.command).toLowerCase();
  if (['sh', 'bash', 'zsh', 'fish', 'curl', 'gh', 'kubectl', 'ssh', 'scp'].includes(executable)) {
    throw new Error(`Gate ${gateId} uses forbidden release actuator/shell ${executable}`);
  }
  if (executable === 'docker' && step.args[0] !== 'build') {
    throw new Error(`Gate ${gateId} may only use local docker build`);
  }
  if (executable === 'npm' && step.args.some((arg) => arg === 'publish' || arg === 'deploy')) {
    throw new Error(`Gate ${gateId} may not publish or deploy`);
  }
  if (executable === 'git' && !['diff', 'status', 'rev-parse'].includes(step.args[0])) {
    throw new Error(`Gate ${gateId} may only use read-only git commands`);
  }
}

export function validateGateDefinition(definition) {
  if (!definition || definition.schemaVersion !== 'rorca.release-one-certification-gates.v1') {
    throw new Error('Unsupported Release-1 certification gate schema');
  }
  if (definition.profileId !== 'release-1-supervised-core' || definition.roadmapAuthority !== 'Linear ROR-21') {
    throw new Error('Gate definition is not bound to the Release-1 ROR-21 authority');
  }
  if (!Array.isArray(definition.gates) || definition.gates.length === 0) throw new Error('Gate definition has no gates');
  const ids = new Set();
  for (const gate of definition.gates) {
    if (!gate || typeof gate.id !== 'string' || !/^[a-z0-9][a-z0-9-]+$/.test(gate.id)) throw new Error('Invalid gate ID');
    if (ids.has(gate.id)) throw new Error(`Duplicate gate ID ${gate.id}`);
    ids.add(gate.id);
    if (!['rorca', 'rorca-backend', 'hermes', 'pair'].includes(gate.repo)) throw new Error(`Gate ${gate.id} has invalid repository`);
    const hasBuiltin = gate.builtin !== undefined;
    const steps = commandSteps(gate);
    if (hasBuiltin === (steps.length > 0)) throw new Error(`Gate ${gate.id} must define either one builtin or command steps`);
    if (hasBuiltin && gate.builtin !== 'pair-diff-audit') throw new Error(`Gate ${gate.id} has unknown builtin ${gate.builtin}`);
    for (const step of steps) validateCommand(step, gate.id);
    if (!Number.isSafeInteger(gate.timeoutMs) || gate.timeoutMs < 1_000 || gate.timeoutMs > 3_600_000) {
      throw new Error(`Gate ${gate.id} timeout is outside the safe range`);
    }
    if (gate.env !== undefined) {
      if (!gate.env || typeof gate.env !== 'object' || Array.isArray(gate.env)) throw new Error(`Gate ${gate.id} env must be an object`);
      for (const [key, value] of Object.entries(gate.env)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== 'string') throw new Error(`Gate ${gate.id} has invalid env`);
        validatePlaceholders(value, `Gate ${gate.id} env ${key}`);
      }
    }
    if (gate.artifacts !== undefined) {
      if (!Array.isArray(gate.artifacts) || !gate.artifacts.every((artifact) => typeof artifact === 'string')) {
        throw new Error(`Gate ${gate.id} artifacts must be a string array`);
      }
      for (const artifact of gate.artifacts) validatePlaceholders(artifact, `Gate ${gate.id} artifact`);
    }
  }
  for (const phaseName of ['gate0', 'gate1']) {
    const phase = definition.phases?.[phaseName];
    if (!phase || typeof phase.requireCleanRepositories !== 'boolean' || !Array.isArray(phase.gateIds)) {
      throw new Error(`Gate definition is missing ${phaseName}`);
    }
    if (new Set(phase.gateIds).size !== phase.gateIds.length) throw new Error(`${phaseName} repeats a gate`);
    for (const id of phase.gateIds) if (!ids.has(id)) throw new Error(`${phaseName} references unknown gate ${id}`);
  }
  const gate1 = new Set(definition.phases.gate1.gateIds);
  for (const id of definition.phases.gate0.gateIds) if (!gate1.has(id)) throw new Error(`Gate 1 omits Gate 0 requirement ${id}`);
  return definition;
}

export function loadGateDefinition(file) {
  return validateGateDefinition(JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
}

function parseEnvFile(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

async function verifyDatabaseIdentity(rorcaRoot, credentialFile) {
  const file = path.resolve(credentialFile);
  const stat = fs.statSync(file);
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) throw new Error(`Certification credential file must be mode 0600; observed ${mode.toString(8)}`);
  const values = parseEnvFile(fs.readFileSync(file, 'utf8'));
  const connectionString = values.RORCA_TEST_DATABASE_URL || values.DATABASE_URL_TEST;
  if (!connectionString) throw new Error('Certification credential file has no test database URL');
  const parsed = new URL(connectionString);
  const expectedUser = decodeURIComponent(parsed.username);
  const expectedDatabase = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || expectedUser !== 'rorca_test_runner'
    || expectedDatabase !== 'rorca_cert_test') {
    throw new Error('Only rorca_test_runner@rorca_cert_test is authorized for certification');
  }

  const require = createRequire(path.join(rorcaRoot, 'backend/package.json'));
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, max: 1, application_name: 'rorca-release-one-certification' });
  try {
    const result = await pool.query(`
      SELECT current_database() AS database,
             current_user AS user_name,
             pg_get_userbyid(datdba) AS owner,
             current_schema() AS schema_name,
             current_setting('server_version_num')::integer AS server_version_num,
             (SELECT COUNT(*)::integer FROM public.schema_migrations) AS migration_count
        FROM pg_database
       WHERE datname = current_database()
    `);
    const row = result.rows[0];
    if (!row || row.database !== expectedDatabase || row.user_name !== expectedUser || row.owner !== expectedUser
      || row.schema_name !== 'rorca' || Number(row.server_version_num) < 160000) {
      throw new Error(`Certification DB identity mismatch: ${JSON.stringify({
        database: row?.database,
        user: row?.user_name,
        owner: row?.owner,
        schema: row?.schema_name,
        serverVersionNum: row?.server_version_num,
      })}`);
    }
    return {
      database: row.database,
      user: row.user_name,
      owner: row.owner,
      schema: row.schema_name,
      serverVersionNum: Number(row.server_version_num),
      migrationCount: Number(row.migration_count),
      credentialMode: '0600',
      connectionAuthority: 'existing pre-provisioned test identity; URL and password omitted',
      connectionString,
    };
  } finally {
    await pool.end();
  }
}

function expand(value, placeholders) {
  return String(value).replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, key) => {
    if (!(key in placeholders)) throw new Error(`No value for placeholder {${key}}`);
    return placeholders[key];
  });
}

function repoDirectory(repo, roots) {
  if (repo === 'rorca') return roots.rorca;
  if (repo === 'rorca-backend') return path.join(roots.rorca, 'backend');
  if (repo === 'hermes') return roots.hermes;
  throw new Error(`No command directory for ${repo}`);
}

function resolveStep(step, gate, roots, placeholders) {
  const cwdKey = step.cwd ?? gate.repo;
  return {
    command: expand(step.command, placeholders),
    args: step.args.map((arg) => expand(arg, placeholders)),
    cwd: repoDirectory(cwdKey, roots),
  };
}

async function runChild(step, env, logFd, timeoutMs) {
  const header = `\n=== command ===\ncwd=${step.cwd}\nargv=${JSON.stringify([step.command, ...step.args])}\nstarted=${new Date().toISOString()}\n`;
  fs.writeSync(logFd, header);
  return await new Promise((resolve) => {
    let timedOut = false;
    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', logFd, logFd],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      fs.writeSync(logFd, `\nspawn-error=${error.stack || error.message}\n`);
      resolve({ exitCode: null, signal: null, timedOut, error: error.message });
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      fs.writeSync(logFd, `\nfinished=${new Date().toISOString()}\nexitCode=${code ?? 'null'}\nsignal=${signal ?? 'none'}\ntimedOut=${timedOut}\n`);
      resolve({ exitCode: code, signal, timedOut, error: null });
    });
  });
}

function hashArtifact(target) {
  const absolute = path.resolve(target);
  if (!fs.existsSync(absolute)) throw new Error(`Expected certification artifact is missing: ${absolute}`);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    const link = fs.readlinkSync(absolute);
    return { path: absolute, type: 'symlink', bytes: Buffer.byteLength(link), sha256: sha256(link) };
  }
  if (stat.isFile()) {
    const bytes = fs.readFileSync(absolute);
    return { path: absolute, type: 'file', bytes: bytes.length, sha256: sha256(bytes) };
  }
  if (!stat.isDirectory()) throw new Error(`Unsupported artifact type: ${absolute}`);
  const entries = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(directory, entry.name);
      const relative = path.relative(absolute, child).replaceAll(path.sep, '/');
      const childStat = fs.lstatSync(child);
      if (childStat.isDirectory()) visit(child);
      else if (childStat.isSymbolicLink()) {
        const link = fs.readlinkSync(child);
        entries.push({ path: relative, type: 'symlink', bytes: Buffer.byteLength(link), sha256: sha256(link) });
      } else if (childStat.isFile()) {
        const bytes = fs.readFileSync(child);
        entries.push({ path: relative, type: 'file', bytes: bytes.length, sha256: sha256(bytes) });
      } else throw new Error(`Unsupported artifact entry: ${child}`);
    }
  };
  visit(absolute);
  return {
    path: absolute,
    type: 'directory',
    entries: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    sha256: sha256(canonicalJson(entries)),
  };
}

function writeSelfBindingManifest(outputDir, payload) {
  const unsigned = { ...payload };
  delete unsigned.payloadSha256;
  const manifest = { ...unsigned, payloadSha256: sha256(canonicalJson(unsigned)) };
  const file = path.join(outputDir, 'pair-manifest.json');
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  fs.writeFileSync(`${file}.sha256`, `${sha256(bytes)}  pair-manifest.json\n`, { mode: 0o600 });
  return manifest;
}

function changeManifestFor(initialRepositories, phase, definitionSha256) {
  return {
    schemaVersion: 'rorca.release-one-change-manifest.v1',
    phase,
    gateDefinitionSha256: definitionSha256,
    repositories: Object.fromEntries(Object.entries(initialRepositories).map(([name, snapshot]) => [name, {
      head: snapshot.head,
      tree: snapshot.tree,
      branch: snapshot.branch,
      clean: snapshot.clean,
      statusEntries: snapshot.status,
      statusSha256: snapshot.statusSha256,
      unstagedDiffSha256: snapshot.unstagedDiffSha256,
      stagedDiffSha256: snapshot.stagedDiffSha256,
      headDiffSha256: snapshot.headDiffSha256,
      untrackedFiles: snapshot.untrackedFiles,
      worktreeContentSha256: snapshot.worktreeContentSha256,
    }])),
  };
}

function snapshotsEqual(initial, final) {
  return initial.rorca.worktreeContentSha256 === final.rorca.worktreeContentSha256
    && initial.hermes.worktreeContentSha256 === final.hermes.worktreeContentSha256;
}

function safeRoot(root, label) {
  const resolved = path.resolve(root);
  if (protectedRoots.has(resolved)) throw new Error(`Refusing protected ${label} checkout ${resolved}`);
  if (!fs.existsSync(path.join(resolved, '.git'))) throw new Error(`${label} root is not a Git checkout: ${resolved}`);
  return resolved;
}

export async function runCertification(options) {
  const startedAt = new Date().toISOString();
  const phase = options.phase;
  let outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(outputDir, 0o700);

  let result = {
    schemaVersion: 'rorca.release-one-certification-result.v1',
    profileId: 'release-1-supervised-core',
    roadmapAuthority: 'Linear ROR-21',
    phase,
    status: 'running',
    startedAt,
    finishedAt: null,
    publicationBoundary: 'STOP before push, publication, PR/provider mutation, merge, deployment, App/ingress/policy activation, or protected-checkout mutation.',
    gateDefinition: null,
    pairNonce: null,
    databaseIdentity: null,
    repositories: { initial: null, final: null },
    changeManifest: null,
    gates: [],
    artifacts: [],
    failure: null,
  };
  const checkpoint = () => { result = writeSelfBindingManifest(outputDir, result); };

  try {
    if (!['gate0', 'gate1'].includes(phase)) throw new Error(`Unsupported certification phase ${phase}`);
    const roots = {
      rorca: safeRoot(options.rorcaRoot, 'Rorca'),
      hermes: safeRoot(options.hermesRoot, 'Hermes'),
    };
    if (roots.rorca === roots.hermes || roots.rorca.startsWith(`${roots.hermes}${path.sep}`) || roots.hermes.startsWith(`${roots.rorca}${path.sep}`)) {
      throw new Error('Rorca and Hermes certification roots must be distinct');
    }
    for (const root of Object.values(roots)) {
      if (outputDir === root || outputDir.startsWith(`${root}${path.sep}`)) throw new Error('Certification output must be outside both source repositories');
    }

    const definitionPath = path.resolve(options.definitionPath);
    const definitionBytes = fs.readFileSync(definitionPath);
    const definition = validateGateDefinition(JSON.parse(definitionBytes.toString('utf8')));
    const phaseDefinition = definition.phases[phase];
    const byId = new Map(definition.gates.map((gate) => [gate.id, gate]));
    const selected = phaseDefinition.gateIds.map((id) => byId.get(id));
    const initial = { rorca: snapshotRepository(roots.rorca), hermes: snapshotRepository(roots.hermes) };
    result.repositories.initial = initial;
    const definitionSha256 = sha256(definitionBytes);
    result.gateDefinition = { path: definitionPath, sha256: definitionSha256, selectedGateIds: phaseDefinition.gateIds };
    result.pairNonce = sha256(canonicalJson({ phase, definitionSha256, repositories: initial })).slice(0, 20);

    const changeManifest = changeManifestFor(initial, phase, definitionSha256);
    const changePath = path.join(outputDir, 'change-manifest.json');
    const changeBytes = Buffer.from(`${JSON.stringify(changeManifest, null, 2)}\n`);
    fs.writeFileSync(changePath, changeBytes, { mode: 0o600 });
    result.changeManifest = { path: 'change-manifest.json', sha256: sha256(changeBytes) };

    if (phaseDefinition.requireCleanRepositories && (!initial.rorca.clean || !initial.hermes.clean)) {
      throw new Error('Gate 1 requires clean repositories before any command runs');
    }

    let database;
    if (selected.some((gate) => gate.requiresDb)) {
      database = await verifyDatabaseIdentity(roots.rorca, options.credentialFile);
      const { connectionString, ...publicIdentity } = database;
      result.databaseIdentity = publicIdentity;
    }

    const placeholders = {
      node: process.execPath,
      rorcaRoot: roots.rorca,
      hermesRoot: roots.hermes,
      outputDir,
      historicalBroadJson: path.resolve(options.historicalBroadJson ?? '/private/tmp/rorca-f2-broad-rerun1-results.json'),
      pairNonce: result.pairNonce,
      hermesClient: path.join(roots.hermes, 'dist/src/clients/rorca.js'),
      hermesManifest: path.join(roots.hermes, 'dist/src/runtime/task-manifest.js'),
    };
    const baseEnv = {
      ...process.env,
      ...(database ? {
        RORCA_TEST_DATABASE_URL: database.connectionString,
        DATABASE_URL_TEST: database.connectionString,
        DATABASE_URL: database.connectionString,
      } : {}),
    };
    checkpoint();

    for (let index = 0; index < selected.length; index += 1) {
      const gate = selected[index];
      const logName = `${String(index + 1).padStart(2, '0')}-${gate.id}.log`;
      const logPath = path.join(outputDir, logName);
      const logFd = fs.openSync(logPath, 'wx', 0o600);
      const gateStarted = new Date().toISOString();
      let outcome = { exitCode: 0, signal: null, timedOut: false, error: null };
      let gateArtifacts = [];
      try {
        fs.writeSync(logFd, `gate=${gate.id}\ndescription=${gate.description ?? ''}\nphase=${phase}\npairNonce=${result.pairNonce}\n`);
        const env = { ...baseEnv };
        for (const [key, value] of Object.entries(gate.env ?? {})) env[key] = expand(value, placeholders);
        const steps = gate.builtin === 'pair-diff-audit'
          ? [
              { command: 'git', args: ['diff', '--check'], cwd: roots.rorca },
              { command: 'git', args: ['diff', '--cached', '--check'], cwd: roots.rorca },
              { command: 'git', args: ['diff', '--check'], cwd: roots.hermes },
              { command: 'git', args: ['diff', '--cached', '--check'], cwd: roots.hermes },
            ]
          : commandSteps(gate).map((step) => resolveStep(step, gate, roots, placeholders));
        for (const step of steps) {
          outcome = await runChild(step, env, logFd, gate.timeoutMs);
          if (outcome.exitCode !== 0 || outcome.signal || outcome.timedOut || outcome.error) break;
        }
        if (gate.builtin === 'pair-diff-audit' && outcome.exitCode === 0) {
          const current = { rorca: snapshotRepository(roots.rorca), hermes: snapshotRepository(roots.hermes) };
          if (!snapshotsEqual(initial, current)) {
            outcome = { exitCode: 1, signal: null, timedOut: false, error: 'Repository content changed during certification' };
            fs.writeSync(logFd, '\nrepository-content-changed=true\n');
          }
        }
        for (const artifact of gate.artifacts ?? []) {
          const target = expand(artifact, placeholders);
          if (fs.existsSync(target)) {
            gateArtifacts.push(hashArtifact(target));
            continue;
          }
          const message = `Expected certification artifact is missing: ${path.resolve(target)}`;
          fs.writeSync(logFd, `\nartifact-error=${message}\n`);
          if (outcome.exitCode === 0 && !outcome.signal && !outcome.timedOut && !outcome.error) {
            outcome = { exitCode: 1, signal: null, timedOut: false, error: message };
          }
        }
      } finally {
        fs.closeSync(logFd);
      }
      const logBytes = fs.readFileSync(logPath);
      result.artifacts.push(...gateArtifacts.map((artifact) => ({ gateId: gate.id, ...artifact })));
      result.gates.push({
        id: gate.id,
        description: gate.description ?? '',
        status: outcome.exitCode === 0 && !outcome.signal && !outcome.timedOut && !outcome.error ? 'passed' : 'failed',
        startedAt: gateStarted,
        finishedAt: new Date().toISOString(),
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        error: outcome.error,
        log: { path: logName, bytes: logBytes.length, sha256: sha256(logBytes) },
        artifacts: gateArtifacts,
      });
      console.log(`${result.gates.at(-1).status.toUpperCase()} ${gate.id} log=${logPath}`);
      if (result.gates.at(-1).status !== 'passed') {
        result.status = 'failed';
        result.failure = { gateId: gate.id, message: outcome.error || `Gate exited ${outcome.exitCode ?? outcome.signal ?? 'unknown'}` };
        checkpoint();
        break;
      }
      checkpoint();
    }

    const final = { rorca: snapshotRepository(roots.rorca), hermes: snapshotRepository(roots.hermes) };
    result.repositories.final = final;
    if (!snapshotsEqual(initial, final)) {
      result.status = 'failed';
      result.failure ??= { gateId: null, message: 'Repository content changed during certification' };
    } else if (result.status === 'running') {
      result.status = result.gates.length === selected.length ? 'passed' : 'failed';
      if (result.status === 'failed') result.failure = { gateId: null, message: 'Certification did not execute every selected gate' };
    }
  } catch (error) {
    result.status = 'failed';
    result.failure = { gateId: null, message: error instanceof Error ? error.message : String(error) };
  }

  result.finishedAt = new Date().toISOString();
  return writeSelfBindingManifest(outputDir, result);
}

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument ${token}`);
    const separator = token.indexOf('=');
    if (separator > 2) values[token.slice(2, separator)] = token.slice(separator + 1);
    else {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
      values[token.slice(2)] = value;
      index += 1;
    }
  }
  const phase = values.phase;
  if (!phase) throw new Error('--phase gate0|gate1 is required');
  const rorcaRoot = path.resolve(values['rorca-root'] ?? scriptRoot);
  const hermesRoot = path.resolve(values['hermes-root'] ?? process.env.HERMES_REPOSITORY_ROOT ?? '/private/tmp/hermes-rorca-production-integration');
  const definitionPath = path.resolve(values.definition ?? path.join(rorcaRoot, 'config/release-one-certification-gates.json'));
  const historicalBroadJson = path.resolve(values['historical-broad-json'] ?? '/private/tmp/rorca-f2-broad-rerun1-results.json');
  const credentialFile = path.resolve(values['credential-file'] ?? process.env.RORCA_TEST_DB_ENV_FILE ?? path.join(os.homedir(), '.rorca/test-db.env'));
  const seed = sha256(canonicalJson({ phase, rorcaRoot, hermesRoot, definitionPath })).slice(0, 12);
  const outputDir = path.resolve(values.output ?? `/private/tmp/rorca-release-one-${phase}-${seed}`);
  return { phase, rorcaRoot, hermesRoot, definitionPath, historicalBroadJson, credentialFile, outputDir };
}

if (path.resolve(process.argv[1] ?? '') === scriptPath) {
  try {
    const options = parseCli(process.argv.slice(2));
    const result = await runCertification(options);
    console.log(`Release-1 ${result.phase} certification ${result.status.toUpperCase()}: ${path.join(options.outputDir, 'pair-manifest.json')}`);
    process.exitCode = result.status === 'passed' ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 2;
  }
}
