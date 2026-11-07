#!/usr/bin/env node
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..');
const SCHEMA_VERSION = 'rorca.real-platform-boundaries.v1';
const EXACT_CAPTURE_VERSIONS = { pi: '0.80.7', opencode: '1.17.10' };
const BOUNDARY_KEYS = ['linuxBwrap', 'postgresAgeCypher', 'piCapture', 'openCodeCapture'];
const REQUIRED_GRAPH_LABELS = ['Convention', 'File', 'Memory', 'Skill', 'Spec', 'Story'];
const REQUIRED_GRAPH_INDEXES = REQUIRED_GRAPH_LABELS
  .map(label => `idx_rorca_v2_${label.toLowerCase()}_key`)
  .sort();

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function assertPassedActual(value, label) {
  const item = requireObject(value, label);
  if (item.status !== 'passed' || item.actual !== true || item.skipped !== 0) {
    throw new Error(`${label} must report semantic status=passed, actual=true, skipped=0`);
  }
  return item;
}

function assertExactHost(host) {
  if (typeof host !== 'string' || host !== host.toLowerCase() || host === 'localhost' || host.includes('*')
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+[a-z0-9][a-z0-9-]{0,62}$/.test(host)) {
    throw new Error(`Network policy contains a non-exact public host: ${String(host)}`);
  }
}

function within(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function resolveNewPathThroughExistingParent(candidate) {
  let current = path.resolve(candidate);
  const missing = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...missing);
}

function assertPrivateOwner(stat, label) {
  if ((stat.mode & 0o077) !== 0) throw new Error(`${label} must not be group/world accessible`);
  if (typeof process.geteuid === 'function' && stat.uid !== process.geteuid()) {
    throw new Error(`${label} must be owned by the verifier process user`);
  }
}

function evidenceVerifier(manifestPath) {
  const root = path.dirname(manifestPath);
  const verified = new Map();
  const verify = (reference, label) => {
    const ref = requireObject(reference, `${label} evidence reference`);
    if (typeof ref.path !== 'string' || path.isAbsolute(ref.path) || ref.path.includes('\\') || ref.path.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`${label} evidence path must be a normalized relative path`);
    }
    if (!isSha256(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0) throw new Error(`${label} evidence hash/size is invalid`);
    const existing = verified.get(ref.path);
    if (existing) {
      if (existing.summary.bytes !== ref.bytes || existing.summary.sha256 !== ref.sha256) {
        throw new Error(`${label} reuses an evidence path with a different binding`);
      }
      return existing.summary;
    }
    const absolute = path.resolve(root, ref.path);
    if (!within(absolute, root)) throw new Error(`${label} evidence escapes its fixture root`);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} evidence must be a regular non-symlink file`);
    assertPrivateOwner(stat, `${label} evidence`);
    const bytes = fs.readFileSync(absolute);
    if (bytes.length !== ref.bytes || sha256(bytes) !== ref.sha256) throw new Error(`${label} evidence bytes do not match the declared binding`);
    const summary = { path: ref.path, bytes: bytes.length, sha256: ref.sha256 };
    verified.set(ref.path, { summary, bytes });
    return summary;
  };
  verify.read = reference => {
    const existing = verified.get(reference.path);
    if (!existing) throw new Error('Evidence must be verified before it is read');
    return Buffer.from(existing.bytes);
  };
  return verify;
}

function verifyEvidenceArray(value, label, verifyEvidence, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum) throw new Error(`${label} requires at least ${minimum} evidence artifact(s)`);
  return value.map((ref, index) => verifyEvidence(ref, `${label}[${index}]`));
}

function gitIdentity(root) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  }).trim();
  const status = git('status', '--porcelain=v1', '--untracked-files=all');
  if (status) throw new Error('Real platform verification requires a clean exact Rorca source tree');
  return { head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
}

function verifyFixture(manifest, verifyEvidence) {
  const fixture = requireObject(manifest.fixture, 'fixture');
  const identity = requireObject(fixture.identity, 'fixture.identity');
  if (!isSha256(fixture.identitySha256) || sha256(canonicalJson(identity)) !== fixture.identitySha256) throw new Error('Fixture identity hash does not match its canonical identity');
  if (identity.platform !== 'linux' || typeof identity.architecture !== 'string' || !identity.architecture
    || typeof identity.kernel !== 'string' || !identity.kernel || !isSha256(identity.resourceNonceSha256)
    || !isSha256(identity.sourceArchiveSha256)) throw new Error('Fixture identity is missing Linux/resource/source authority');
  const admission = verifyEvidence(fixture.admissionEvidence, 'fixture admission');
  const teardown = assertPassedActual(fixture.teardown, 'fixture teardown');
  if (teardown.resourceDestroyed !== true || teardown.networkNamespaceDestroyed !== true) {
    throw new Error('Fixture teardown lacks resource/network-namespace destruction proof');
  }
  const teardownEvidence = verifyEvidence(teardown.evidence, 'fixture teardown');
  return {
    identity,
    identitySha256: fixture.identitySha256,
    admissionEvidence: admission,
    teardown: {
      status: 'passed', actual: true, skipped: 0,
      resourceDestroyed: true,
      networkNamespaceDestroyed: true,
      evidence: teardownEvidence,
    },
  };
}

function verifyNetworkPolicy(manifest, verifyEvidence) {
  const network = requireObject(manifest.networkPolicy, 'networkPolicy');
  const policy = {
    mode: network.mode,
    transport: network.transport,
    connectPort: network.connectPort,
    allowedHosts: network.allowedHosts,
    noAmbientCredentialDirectories: network.noAmbientCredentialDirectories,
  };
  if (policy.mode !== 'exact-host-unix-socket-connect' || policy.transport !== 'unix-socket'
    || policy.connectPort !== 443 || policy.noAmbientCredentialDirectories !== true
    || !Array.isArray(policy.allowedHosts) || policy.allowedHosts.length === 0 || policy.allowedHosts.length > 32) {
    throw new Error('Network policy is not the exact-host Unix-socket CONNECT contract');
  }
  const sorted = [...policy.allowedHosts].sort();
  if (new Set(sorted).size !== sorted.length || JSON.stringify(sorted) !== JSON.stringify(policy.allowedHosts)) throw new Error('Network policy hosts must be unique and sorted');
  sorted.forEach(assertExactHost);
  if (!isSha256(network.policySha256) || sha256(canonicalJson(policy)) !== network.policySha256
    || !isSha256(network.brokerInstanceSha256)) throw new Error('Network policy/broker-instance hash is invalid');
  return {
    ...policy,
    policySha256: network.policySha256,
    brokerInstanceSha256: network.brokerInstanceSha256,
    evidence: verifyEvidence(network.evidence, 'network policy'),
  };
}

function verifyLinuxBoundary(value, fixture, verifyEvidence) {
  const boundary = assertPassedActual(value, 'linuxBwrap');
  if (boundary.mechanism !== 'linux-bwrap' || boundary.fixtureIdentitySha256 !== fixture.identitySha256) throw new Error('Linux boundary identity/mechanism is invalid');
  const namespaces = requireObject(boundary.namespaces, 'linuxBwrap.namespaces');
  for (const key of ['user', 'mount', 'pid', 'network', 'privateProc', 'privateRoot']) {
    if (namespaces[key] !== true) throw new Error(`Linux boundary is missing ${key} isolation`);
  }
  const executable = requireObject(boundary.executable, 'linuxBwrap.executable');
  if (typeof executable.version !== 'string' || !executable.version || !isSha256(executable.sha256)) throw new Error('Linux bwrap executable binding is invalid');
  return {
    status: 'passed', actual: true, skipped: 0,
    mechanism: boundary.mechanism,
    fixtureIdentitySha256: boundary.fixtureIdentitySha256,
    namespaces,
    executable,
    evidence: verifyEvidenceArray(boundary.evidence, 'linuxBwrap.evidence', verifyEvidence, 2),
  };
}

function verifyPostgresBoundary(value, fixture, verifyEvidence) {
  const boundary = assertPassedActual(value, 'postgresAgeCypher');
  const declaredMajor = typeof boundary.postgresVersion === 'string'
    ? Number(boundary.postgresVersion.match(/^(\d+)\./)?.[1])
    : Number.NaN;
  if (!Number.isSafeInteger(boundary.postgresMajor) || boundary.postgresMajor < 16
    || declaredMajor !== boundary.postgresMajor
    || typeof boundary.ageVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(boundary.ageVersion)
    || boundary.graphName !== 'rorca_v2' || boundary.fixtureIdentitySha256 !== fixture.identitySha256
    || !isSha256(boundary.imageSha256)) throw new Error('PG16+AGE boundary identity/version/graph binding is invalid');
  const cypher = requireObject(boundary.cypher, 'postgresAgeCypher.cypher');
  const labels = Array.isArray(cypher.keyedLabels) ? [...new Set(cypher.keyedLabels)].sort() : [];
  const keyIndexes = Array.isArray(cypher.keyIndexes) ? [...new Set(cypher.keyIndexes)].sort() : [];
  if (!Number.isSafeInteger(cypher.mergeExecutions) || cypher.mergeExecutions < 2
    || cypher.matchedNodes !== 1
    || JSON.stringify(labels) !== JSON.stringify(REQUIRED_GRAPH_LABELS)
    || JSON.stringify(keyIndexes) !== JSON.stringify(REQUIRED_GRAPH_INDEXES)) {
    throw new Error('PG16+AGE boundary lacks real idempotent Cypher semantics');
  }
  return {
    status: 'passed', actual: true, skipped: 0,
    postgresMajor: boundary.postgresMajor,
    postgresVersion: boundary.postgresVersion,
    ageVersion: boundary.ageVersion,
    graphName: boundary.graphName,
    fixtureIdentitySha256: boundary.fixtureIdentitySha256,
    imageSha256: boundary.imageSha256,
    cypher,
    evidence: verifyEvidenceArray(boundary.evidence, 'postgresAgeCypher.evidence', verifyEvidence, 2),
  };
}

function verifyCapture(value, engine, fixture, network, observedAt, verifyEvidence) {
  const label = engine === 'pi' ? 'piCapture' : 'openCodeCapture';
  const boundary = assertPassedActual(value, label);
  if (boundary.engine !== engine || boundary.fixtureIdentitySha256 !== fixture.identitySha256
    || boundary.brokerPolicySha256 !== network.policySha256
    || boundary.brokerInstanceSha256 !== network.brokerInstanceSha256
    || boundary.engineWorkspaceRemoved !== true) {
    throw new Error(`${label} engine/fixture/broker identity is invalid`);
  }
  const executable = requireObject(boundary.executable, `${label}.executable`);
  if (executable.version !== EXACT_CAPTURE_VERSIONS[engine] || !isSha256(executable.sha256)) throw new Error(`${label} executable must exactly match the shipped version/hash`);
  if (typeof boundary.provider !== 'string' || !boundary.provider || typeof boundary.model !== 'string' || !boundary.model) throw new Error(`${label} lacks exact provider/model authority`);
  const terminal = requireObject(boundary.terminal, `${label}.terminal`);
  if (terminal.cols !== 80 || terminal.rows !== 24) throw new Error(`${label} must use fixed 80x24 geometry`);
  const grant = requireObject(boundary.grant, `${label}.grant`);
  const issuedAt = Date.parse(String(grant.issuedAt ?? ''));
  const expiresAt = Date.parse(String(grant.expiresAt ?? ''));
  if (typeof grant.grantId !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/.test(grant.grantId)
    || !isSha256(grant.authoritySha256) || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || issuedAt > observedAt || observedAt >= expiresAt || expiresAt - issuedAt > 24 * 60 * 60 * 1000
    || typeof grant.maxCostUsd !== 'number' || !Number.isFinite(grant.maxCostUsd)
    || grant.maxCostUsd <= 0 || grant.maxCostUsd > 100) throw new Error(`${label} scoped provider grant is invalid/expired`);
  const rawTranscript = verifyEvidence(boundary.rawTranscript, `${label} raw transcript`);
  const normalizedTranscript = verifyEvidence(boundary.normalizedTranscript, `${label} normalized transcript`);
  const semantic = requireObject(boundary.semantic, `${label}.semantic`);
  if (typeof semantic.responseMarker !== 'string' || !/^RORCA_RB02_[A-Z0-9_]{12,96}$/.test(semantic.responseMarker)
    || semantic.responseMarkerSha256 !== sha256(semantic.responseMarker)
    || !Number.isSafeInteger(semantic.assistantEventCount) || semantic.assistantEventCount < 1
    || !verifyEvidence.read(boundary.normalizedTranscript).toString('utf8').includes(semantic.responseMarker)) {
    throw new Error(`${label} lacks a bound semantic assistant response`);
  }
  return {
    status: 'passed', actual: true, skipped: 0,
    engine,
    executable,
    provider: boundary.provider,
    model: boundary.model,
    terminal,
    fixtureIdentitySha256: boundary.fixtureIdentitySha256,
    grant,
    brokerPolicySha256: boundary.brokerPolicySha256,
    brokerInstanceSha256: boundary.brokerInstanceSha256,
    semantic,
    rawTranscript,
    normalizedTranscript,
    engineWorkspaceRemoved: true,
    evidence: verifyEvidenceArray(boundary.evidence, `${label}.evidence`, verifyEvidence),
  };
}

export function verifyRealPlatformBoundaries({ manifestPath, rorcaRoot, outputPath }) {
  const sourceRoot = fs.realpathSync(rorcaRoot);
  const requestedManifest = path.resolve(manifestPath);
  const output = resolveNewPathThroughExistingParent(outputPath);
  const stat = fs.lstatSync(requestedManifest);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Real platform manifest must be a regular non-symlink file');
  const absoluteManifest = fs.realpathSync(requestedManifest);
  if (within(absoluteManifest, sourceRoot) || within(output, sourceRoot)) {
    throw new Error('Real platform input/output evidence must remain outside the source repository');
  }
  assertPrivateOwner(stat, 'Real platform manifest');
  const evidenceRootStat = fs.lstatSync(path.dirname(absoluteManifest));
  if (!evidenceRootStat.isDirectory() || evidenceRootStat.isSymbolicLink()) {
    throw new Error('Real platform evidence root must be a regular directory');
  }
  assertPrivateOwner(evidenceRootStat, 'Real platform evidence root');
  const manifestBytes = fs.readFileSync(absoluteManifest);
  const manifest = assertPassedActual(JSON.parse(manifestBytes.toString('utf8')), 'real-platform-boundaries');
  if (manifest.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported real platform boundary schema');
  const observedAt = Date.parse(String(manifest.observedAt ?? ''));
  if (!Number.isFinite(observedAt)) throw new Error('Real platform manifest observedAt is invalid');
  const currentSource = gitIdentity(sourceRoot);
  const source = requireObject(manifest.source, 'source');
  if (source.rorcaHead !== currentSource.head || source.rorcaTree !== currentSource.tree) throw new Error('Real platform evidence does not bind the exact current Rorca commit/tree');

  const verifyEvidence = evidenceVerifier(absoluteManifest);
  const fixture = verifyFixture(manifest, verifyEvidence);
  if (fixture.identity.sourceArchiveCommit !== currentSource.head || fixture.identity.sourceArchiveTree !== currentSource.tree) throw new Error('Fixture archive identity does not bind the current source');
  const networkPolicy = verifyNetworkPolicy(manifest, verifyEvidence);
  const boundaries = requireObject(manifest.boundaries, 'boundaries');
  if (Object.keys(boundaries).sort().join(',') !== [...BOUNDARY_KEYS].sort().join(',')) throw new Error('Real platform manifest must contain exactly four required boundaries');

  const verifiedBoundaries = {
    linuxBwrap: verifyLinuxBoundary(boundaries.linuxBwrap, fixture, verifyEvidence),
    postgresAgeCypher: verifyPostgresBoundary(boundaries.postgresAgeCypher, fixture, verifyEvidence),
    piCapture: verifyCapture(boundaries.piCapture, 'pi', fixture, networkPolicy, observedAt, verifyEvidence),
    openCodeCapture: verifyCapture(boundaries.openCodeCapture, 'opencode', fixture, networkPolicy, observedAt, verifyEvidence),
  };
  if (verifiedBoundaries.piCapture.grant.grantId !== verifiedBoundaries.openCodeCapture.grant.grantId
    || verifiedBoundaries.piCapture.grant.authoritySha256
    !== verifiedBoundaries.openCodeCapture.grant.authoritySha256) {
    throw new Error('Pi and OpenCode captures must bind the same scoped provider grant');
  }
  if (verifiedBoundaries.piCapture.semantic.responseMarker
    === verifiedBoundaries.openCodeCapture.semantic.responseMarker) {
    throw new Error('Pi and OpenCode captures require distinct semantic response markers');
  }
  const teardown = assertPassedActual(manifest.teardown, 'real-platform-boundaries teardown');
  const teardownEvidence = verifyEvidence(teardown.evidence, 'real-platform-boundaries teardown');
  if (teardown.fixtureIdentitySha256 !== fixture.identitySha256
    || teardown.fixtureDestroyed !== true || teardown.postgresDestroyed !== true
    || teardown.brokerClosed !== true || teardown.captureWorkspacesRemoved !== true) {
    throw new Error('Overall teardown is incomplete or not fixture-bound');
  }

  const finalSource = gitIdentity(sourceRoot);
  if (finalSource.head !== currentSource.head || finalSource.tree !== currentSource.tree) {
    throw new Error('Rorca source identity changed during real platform verification');
  }

  const summary = {
    schemaVersion: 'rorca.verified-real-platform-boundaries.v1',
    status: 'passed',
    actual: true,
    skipped: 0,
    observedAt: manifest.observedAt,
    source: { rorcaHead: currentSource.head, rorcaTree: currentSource.tree },
    sourceManifestSha256: sha256(manifestBytes),
    fixture,
    networkPolicy,
    boundaries: verifiedBoundaries,
    teardown: {
      status: 'passed', actual: true, skipped: 0,
      fixtureIdentitySha256: fixture.identitySha256,
      fixtureDestroyed: true,
      postgresDestroyed: true,
      brokerClosed: true,
      captureWorkspacesRemoved: true,
      evidence: teardownEvidence,
    },
  };
  const bytes = Buffer.from(`${JSON.stringify(summary, null, 2)}\n`);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, bytes, { mode: 0o600, flag: 'wx' });
  return summary;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument ${token}`);
    const key = token.slice(2);
    if (!['manifest', 'rorca-root', 'output'].includes(key)) throw new Error(`Unknown argument ${token}`);
    if (key in values) throw new Error(`Duplicate argument ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
    values[key] = value;
    index += 1;
  }
  for (const key of ['manifest', 'output']) if (!values[key]) throw new Error(`--${key} is required`);
  return values;
}

if (path.resolve(process.argv[1] ?? '') === scriptPath) {
  try {
    const values = parseArgs(process.argv.slice(2));
    const result = verifyRealPlatformBoundaries({
      manifestPath: values.manifest,
      rorcaRoot: path.resolve(values['rorca-root'] ?? repositoryRoot),
      outputPath: values.output,
    });
    process.stdout.write(`Real platform boundaries PASSED: ${JSON.stringify({
      status: result.status,
      actual: result.actual,
      skipped: result.skipped,
      source: result.source,
    })}\n`);
  } catch (error) {
    process.stderr.write(`Real platform boundaries FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
