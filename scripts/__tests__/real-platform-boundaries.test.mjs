#!/usr/bin/env node
/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  canonicalJson,
  verifyRealPlatformBoundaries,
} from '../verify-real-platform-boundaries.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repository(root) {
  const repo = path.join(root, 'source');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'rb02@example.test');
  git(repo, 'config', 'user.name', 'RB-02 Test');
  fs.writeFileSync(path.join(repo, 'README.md'), 'source\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'source');
  return repo;
}

function writeEvidence(root, relative, text) {
  const bytes = Buffer.from(text);
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, bytes, { mode: 0o600 });
  return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
}

function fixture(root) {
  const source = repository(root);
  const evidenceRoot = path.join(root, 'evidence');
  fs.mkdirSync(evidenceRoot, { mode: 0o700 });
  const refs = {
    admission: writeEvidence(evidenceRoot, 'fixture/admission.json', '{"admitted":true}\n'),
    teardown: writeEvidence(evidenceRoot, 'fixture/teardown.json', '{"removed":true}\n'),
    broker: writeEvidence(evidenceRoot, 'network/broker.json', '{"connect":443}\n'),
    linuxA: writeEvidence(evidenceRoot, 'linux/preflight.log', 'passed\n'),
    linuxB: writeEvidence(evidenceRoot, 'linux/sensitivity.json', '{"private":true}\n'),
    pgA: writeEvidence(evidenceRoot, 'postgres/bootstrap.log', 'rorca_v2\n'),
    pgB: writeEvidence(evidenceRoot, 'postgres/cypher.json', '{"matched":1}\n'),
    piRaw: writeEvidence(evidenceRoot, 'pi/raw.bin', 'pi raw provider transcript\n'),
    piNormalized: writeEvidence(evidenceRoot, 'pi/normalized.jsonl', '{"type":"assistant","content":"RORCA_RB02_PI_CAPTURE_OK_0001"}\n'),
    piVersion: writeEvidence(evidenceRoot, 'pi/version.json', '{"version":"0.80.7"}\n'),
    ocRaw: writeEvidence(evidenceRoot, 'opencode/raw.bin', 'opencode raw provider transcript\n'),
    ocNormalized: writeEvidence(evidenceRoot, 'opencode/normalized.jsonl', '{"type":"assistant","content":"RORCA_RB02_OPENCODE_CAPTURE_OK_0001"}\n'),
    ocVersion: writeEvidence(evidenceRoot, 'opencode/version.json', '{"version":"1.17.10"}\n'),
  };
  const head = git(source, 'rev-parse', 'HEAD');
  const tree = git(source, 'rev-parse', 'HEAD^{tree}');
  const identity = {
    platform: 'linux',
    architecture: 'arm64',
    kernel: '7.0.12',
    resourceNonceSha256: sha256('nonce'),
    sourceArchiveSha256: sha256('archive'),
    sourceArchiveCommit: head,
    sourceArchiveTree: tree,
  };
  const policy = {
    mode: 'exact-host-unix-socket-connect',
    transport: 'unix-socket',
    connectPort: 443,
    allowedHosts: ['api.openai.com'],
    noAmbientCredentialDirectories: true,
  };
  const brokerInstanceSha256 = sha256('shared-broker-instance');
  const capture = (engine, version, rawTranscript, normalizedTranscript, versionEvidence) => {
    const responseMarker = engine === 'pi'
      ? 'RORCA_RB02_PI_CAPTURE_OK_0001'
      : 'RORCA_RB02_OPENCODE_CAPTURE_OK_0001';
    return {
      status: 'passed', actual: true, skipped: 0,
      engine,
      executable: { version, sha256: sha256(`${engine}-executable`) },
      provider: 'openai',
      model: engine === 'pi' ? 'gpt-5.4' : 'gpt-4o',
      terminal: { cols: 80, rows: 24 },
      fixtureIdentitySha256: sha256(canonicalJson(identity)),
      grant: {
        grantId: 'rb02-shared-provider-grant',
        authoritySha256: sha256('shared-provider-grant'),
        issuedAt: '2026-07-25T00:00:00.000Z',
        expiresAt: '2026-07-25T02:00:00.000Z',
        maxCostUsd: 1,
      },
      brokerPolicySha256: sha256(canonicalJson(policy)),
      brokerInstanceSha256,
      semantic: {
        assistantEventCount: 1,
        responseMarker,
        responseMarkerSha256: sha256(responseMarker),
      },
      rawTranscript,
      normalizedTranscript,
      engineWorkspaceRemoved: true,
      evidence: [versionEvidence],
    };
  };
  const manifest = {
    schemaVersion: 'rorca.real-platform-boundaries.v1',
    status: 'passed', actual: true, skipped: 0,
    observedAt: '2026-07-25T01:00:00.000Z',
    source: { rorcaHead: head, rorcaTree: tree },
    fixture: {
      identity,
      identitySha256: sha256(canonicalJson(identity)),
      admissionEvidence: refs.admission,
      teardown: {
        status: 'passed', actual: true, skipped: 0,
        resourceDestroyed: true,
        networkNamespaceDestroyed: true,
        evidence: refs.teardown,
      },
    },
    networkPolicy: {
      ...policy,
      policySha256: sha256(canonicalJson(policy)),
      brokerInstanceSha256,
      evidence: refs.broker,
    },
    boundaries: {
      linuxBwrap: {
        status: 'passed', actual: true, skipped: 0,
        mechanism: 'linux-bwrap',
        fixtureIdentitySha256: sha256(canonicalJson(identity)),
        namespaces: { user: true, mount: true, pid: true, network: true, privateProc: true, privateRoot: true },
        executable: { version: '0.11.0', sha256: sha256('bwrap') },
        evidence: [refs.linuxA, refs.linuxB],
      },
      postgresAgeCypher: {
        status: 'passed', actual: true, skipped: 0,
        postgresMajor: 16,
        postgresVersion: '16.14',
        ageVersion: '1.5.0',
        graphName: 'rorca_v2',
        fixtureIdentitySha256: sha256(canonicalJson(identity)),
        imageSha256: sha256('pg-image'),
        cypher: {
          mergeExecutions: 2,
          matchedNodes: 1,
          keyedLabels: ['Story', 'File', 'Spec', 'Memory', 'Convention', 'Skill'],
          keyIndexes: [
            'idx_rorca_v2_story_key',
            'idx_rorca_v2_file_key',
            'idx_rorca_v2_spec_key',
            'idx_rorca_v2_memory_key',
            'idx_rorca_v2_convention_key',
            'idx_rorca_v2_skill_key',
          ],
        },
        evidence: [refs.pgA, refs.pgB],
      },
      piCapture: capture('pi', '0.80.7', refs.piRaw, refs.piNormalized, refs.piVersion),
      openCodeCapture: capture('opencode', '1.17.10', refs.ocRaw, refs.ocNormalized, refs.ocVersion),
    },
    teardown: {
      status: 'passed', actual: true, skipped: 0,
      fixtureIdentitySha256: sha256(canonicalJson(identity)),
      fixtureDestroyed: true,
      postgresDestroyed: true,
      brokerClosed: true,
      captureWorkspacesRemoved: true,
      evidence: refs.teardown,
    },
  };
  const manifestPath = path.join(evidenceRoot, 'real-platform-boundaries.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { source, evidenceRoot, manifestPath, manifest };
}

test('verifier binds four actual non-skipped boundaries, transcripts, runtime hashes, broker policy, fixture, and teardown', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-real-platform-'));
  try {
    const current = fixture(root);
    const output = path.join(root, 'verified.json');
    const result = verifyRealPlatformBoundaries({
      manifestPath: current.manifestPath,
      rorcaRoot: current.source,
      outputPath: output,
    });
    assert.equal(result.status, 'passed');
    assert.equal(result.actual, true);
    assert.equal(result.skipped, 0);
    assert.deepEqual(Object.keys(result.boundaries).sort(), ['linuxBwrap', 'openCodeCapture', 'piCapture', 'postgresAgeCypher']);
    assert.equal(result.boundaries.piCapture.executable.version, '0.80.7');
    assert.equal(result.boundaries.openCodeCapture.executable.version, '1.17.10');
    assert.equal(result.boundaries.postgresAgeCypher.graphName, 'rorca_v2');
    assert.equal(result.networkPolicy.mode, 'exact-host-unix-socket-connect');
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).sourceManifestSha256, sha256(fs.readFileSync(current.manifestPath)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verifier rejects any skip or fixture replay masquerading as actual platform evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-real-platform-skip-'));
  try {
    const current = fixture(root);
    current.manifest.boundaries.piCapture.skipped = 1;
    current.manifest.boundaries.piCapture.actual = false;
    fs.writeFileSync(current.manifestPath, `${JSON.stringify(current.manifest, null, 2)}\n`, { mode: 0o600 });
    assert.throws(() => verifyRealPlatformBoundaries({
      manifestPath: current.manifestPath,
      rorcaRoot: current.source,
      outputPath: path.join(root, 'verified.json'),
    }), /status=passed, actual=true, skipped=0/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verifier rejects expired or split provider-capture authority', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-real-platform-grant-'));
  try {
    const current = fixture(root);
    current.manifest.boundaries.openCodeCapture.grant.authoritySha256 = sha256('different-grant');
    fs.writeFileSync(current.manifestPath, `${JSON.stringify(current.manifest, null, 2)}\n`, { mode: 0o600 });
    assert.throws(() => verifyRealPlatformBoundaries({
      manifestPath: current.manifestPath,
      rorcaRoot: current.source,
      outputPath: path.join(root, 'verified.json'),
    }), /same scoped provider grant/);

    current.manifest.boundaries.openCodeCapture.grant.authoritySha256 = sha256('shared-provider-grant');
    current.manifest.boundaries.piCapture.grant.expiresAt = current.manifest.observedAt;
    fs.writeFileSync(current.manifestPath, `${JSON.stringify(current.manifest, null, 2)}\n`, { mode: 0o600 });
    assert.throws(() => verifyRealPlatformBoundaries({
      manifestPath: current.manifestPath,
      rorcaRoot: current.source,
      outputPath: path.join(root, 'verified.json'),
    }), /scoped provider grant is invalid\/expired/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verifier rejects transcript hash drift and source-identity drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-real-platform-drift-'));
  try {
    const current = fixture(root);
    fs.appendFileSync(path.join(current.evidenceRoot, current.manifest.boundaries.openCodeCapture.rawTranscript.path), 'tampered');
    assert.throws(() => verifyRealPlatformBoundaries({
      manifestPath: current.manifestPath,
      rorcaRoot: current.source,
      outputPath: path.join(root, 'verified-a.json'),
    }), /evidence bytes do not match/);

    const current2 = fixture(path.join(root, 'second'));
    fs.appendFileSync(path.join(current2.source, 'README.md'), 'dirty\n');
    assert.throws(() => verifyRealPlatformBoundaries({
      manifestPath: current2.manifestPath,
      rorcaRoot: current2.source,
      outputPath: path.join(root, 'verified-b.json'),
    }), /clean exact Rorca source tree/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
