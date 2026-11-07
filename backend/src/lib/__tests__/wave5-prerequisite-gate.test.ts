/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  WAVE5_IMPLEMENTATION_MARKER,
  WAVE5_LEDGER_RECEIPT_HASH,
  WAVE5_PLAN_HASH,
  WAVE5_REVIEWED_WAVE2_SHA,
  WAVE5_REVIEWED_WAVE3_SHA,
  WAVE5_REVIEWED_WAVE4_SHA,
  WAVE5_SPEC_PIPELINE_RECEIPT_HASH,
  WAVE5_SPEC_REVISION,
  WAVE5_W4_010_DEMO_PACKET_HASH,
  WAVE5_WAVE2_MIGRATION_HEAD,
  WAVE5_WAVE3A_MIGRATION_HEAD,
  WAVE5_WAVE4_CLEANROOM_REVIEW_SHA,
  WAVE5_WAVE4_CODE_HEAD,
  WAVE5_WAVE4_CODE_TREE,
  WAVE5_WAVE4_MIGRATION_HEAD,
  WAVE5_WAVE4_OPS_MIGRATION_HEAD,
  WAVE5_WAVE4_TREE,
  WAVE5_CLEANROOM_CERTIFICATES_HASH,
  WAVE5_CLEANROOM_CERT_FAKE_FEDERATED,
  WAVE5_CLEANROOM_CERT_MANAGED,
  WAVE5_CLEANROOM_REALHOST_HASH,
  WAVE5_WAVE4_CONFORMANCE_RECEIPT,
  WAVE5_WAVE4_RELEASE_REVIEWER,
  WAVE5_WAVE4_SECURITY_REVIEWER,
  WAVE5_WAVE4_CLEANROOM_REVIEWER,
  WAVE5_WAVE3_CONFORMANCE_RECEIPT,
  WAVE5_WAVE3_SECURITY_REVIEW_RECEIPT,
  verifyWave5Prerequisites,
  loadCanonicalWave5PrerequisiteGate,
  type Wave5PrerequisitePacket,
} from '../wave5-prerequisite-gate';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const hash = (character: string): string => `sha256:${character.repeat(64)}`;

function packet(): Wave5PrerequisitePacket {
  return {
    schemaVersion: 'rorca.wave5-prerequisite-packet.v1',
    wave2: { implementationSha: WAVE5_REVIEWED_WAVE2_SHA, migrationHead: WAVE5_WAVE2_MIGRATION_HEAD,
      contractVersion: '1.0.0', contractHash: WAVE5_LEDGER_RECEIPT_HASH },
    wave3: { implementationSha: WAVE5_REVIEWED_WAVE3_SHA, migrationHead: WAVE5_WAVE3A_MIGRATION_HEAD,
      conformanceReceiptHash: WAVE5_WAVE3_CONFORMANCE_RECEIPT,
      securityReviewReceiptHash: WAVE5_WAVE3_SECURITY_REVIEW_RECEIPT,
      releaseReviewReceiptHash: WAVE5_LEDGER_RECEIPT_HASH,
      securityReviewerId: 'Wave3SecFinal2', releaseReviewerId: 'Wave3RelFinal2',
      reviewVerdict: 'accepted', findingCount: 0, reviewedTree: 'a8bea27e85c9340d69ed078cd15a9dbfdc586abd' },
    wave4: { implementationSha: WAVE5_REVIEWED_WAVE4_SHA, codeHead: WAVE5_WAVE4_CODE_HEAD,
      migrationHead: WAVE5_WAVE4_MIGRATION_HEAD, opsMigrationHead: WAVE5_WAVE4_OPS_MIGRATION_HEAD,
      conformanceReceiptHash: WAVE5_WAVE4_CONFORMANCE_RECEIPT,
      securityReviewerId: WAVE5_WAVE4_SECURITY_REVIEWER, releaseReviewerId: WAVE5_WAVE4_RELEASE_REVIEWER,
      reviewVerdict: 'accepted', findingCount: 0, reviewedTree: WAVE5_WAVE4_TREE, codeTree: WAVE5_WAVE4_CODE_TREE },
    cleanRoom: { certificatesFileHash: WAVE5_CLEANROOM_CERTIFICATES_HASH,
      realhostFileHash: WAVE5_CLEANROOM_REALHOST_HASH,
      certificateManagedHash: WAVE5_CLEANROOM_CERT_MANAGED,
      certificateFakeFederatedHash: WAVE5_CLEANROOM_CERT_FAKE_FEDERATED,
      reviewerId: WAVE5_WAVE4_CLEANROOM_REVIEWER, reviewVerdict: 'accepted', findingCount: 0,
      sourceSha: WAVE5_WAVE4_CODE_HEAD },
    demoPacket: { fileHash: WAVE5_W4_010_DEMO_PACKET_HASH },
    wave5: { specRevision: WAVE5_SPEC_REVISION, planHash: WAVE5_PLAN_HASH,
      specPipelineReceiptHash: WAVE5_SPEC_PIPELINE_RECEIPT_HASH },
    integration: { exactSha: WAVE5_REVIEWED_WAVE4_SHA, compatibilityVersion: '1.0.0', unresolvedConflicts: [] },
    activeImplementationWaves: [WAVE5_IMPLEMENTATION_MARKER],
    revoked: false,
  };
}

describe('Wave 5 exact prerequisite gate', () => {
  test('binds exact committed packets while granting NO execution or lifecycle authority', () => {
    expect(verifyWave5Prerequisites(packet())).toMatchObject({
      accepted: true,
      executionAuthority: 'none',
      lifecycleDecisionAuthority: 'none',
      providerHumanAuthority: 'none',
      mergeAuthority: 'none',
      deploymentAuthority: 'none',
      productionAuthority: 'none',
    });
  });

  test.each([
    ['changed Wave 4 integration SHA', (value: Wave5PrerequisitePacket) => ({
      ...value, integration: { ...value.integration, exactSha: '0'.repeat(40) },
    })],
    ['self review (same reviewer)', (value: Wave5PrerequisitePacket) => ({
      ...value, wave4: { ...value.wave4, securityReviewerId: value.wave4.releaseReviewerId },
    })],
    ['self-asserted clean-room cert hash', (value: Wave5PrerequisitePacket) => ({
      ...value, cleanRoom: { ...value.cleanRoom, certificateManagedHash: hash('b') },
    })],
    ['changed demo packet hash', (value: Wave5PrerequisitePacket) => ({
      ...value, demoPacket: { ...value.demoPacket, fileHash: hash('c') },
    })],
    ['overlapping implementation wave', (value: Wave5PrerequisitePacket) => ({
      ...value, activeImplementationWaves: [WAVE5_IMPLEMENTATION_MARKER, 'ROR-31'],
    })],
    ['nonzero clean-room findings', (value: Wave5PrerequisitePacket) => ({
      ...value, cleanRoom: { ...value.cleanRoom, findingCount: 1 },
    })],
    ['revocation', (value: Wave5PrerequisitePacket) => ({ ...value, revoked: true })],
  ])('fails closed for %s before mutation', (_label, mutate) => {
    expect(() => verifyWave5Prerequisites(mutate(packet()) as Wave5PrerequisitePacket)).toThrow();
  });

  test('loads the canonical gate by hashing exact HEAD blobs of committed artifacts', async () => {
    const gate = await loadCanonicalWave5PrerequisiteGate({ repoRoot: REPO_ROOT });
    expect(gate.accepted).toBe(true);
    expect(gate.executionAuthority).toBe('none');
    expect(gate.mergeAuthority).toBe('none');
    expect(gate.packetHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('resolves the repository root from the git top level when no options are supplied', async () => {
    const originalRepoRoot = process.env.RORCA_REPO_ROOT;
    delete process.env.RORCA_REPO_ROOT;
    try {
      const gate = await loadCanonicalWave5PrerequisiteGate();
      expect(gate.accepted).toBe(true);
    } finally {
      if (originalRepoRoot === undefined) delete process.env.RORCA_REPO_ROOT;
      else process.env.RORCA_REPO_ROOT = originalRepoRoot;
    }
  });

  test('rejects a repo where the artifacts exist only in the working tree', async () => {
    const originalRepoRoot = process.env.RORCA_REPO_ROOT;
    delete process.env.RORCA_REPO_ROOT;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-wave5-gate-wt-'));
    try {
      execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['-C', root, 'config', 'user.email', 'gate@test'], { stdio: 'ignore' });
      execFileSync('git', ['-C', root, 'config', 'user.name', 'gate'], { stdio: 'ignore' });
      // Commit a stub tree, then place the artifacts ONLY in the working tree.
      fs.writeFileSync(path.join(root, 'stub.txt'), 'stub\n');
      execFileSync('git', ['-C', root, 'add', 'stub.txt'], { stdio: 'ignore' });
      execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'stub'], { stdio: 'ignore' });
      for (const artifact of [
        '.autonomous-runner-implementation-progress.md',
        'docs/wave3-complete-gate-receipt.md',
        'docs/wave4-complete-gate-receipt.md',
        'docs/wave3-redaction-review-receipt.md',
        'docs/wave4-cleanroom-certificates.json',
        'docs/wave4-cleanroom-realhost-certificate.md',
        'docs/wave4-pilot-demo-packet.md',
        'forge/specs/pending/wave-5-forgejo-adapter-omp-shim.json',
        'docs/wave5-forgejo-omp-plan.md',
        'docs/wave5-spec-pipeline-receipt.md',
      ]) {
        const filePath = path.join(root, artifact);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `working-tree-only ${artifact}\n`);
      }
      await expect(loadCanonicalWave5PrerequisiteGate({ repoRoot: root }))
        .rejects.toThrow(/committed artifact is missing from HEAD/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      if (originalRepoRoot === undefined) delete process.env.RORCA_REPO_ROOT;
      else process.env.RORCA_REPO_ROOT = originalRepoRoot;
    }
  });

  test('rejects a repo where the reviewed SHAs exist only on unrelated refs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-wave5-gate-refs-'));
    try {
      execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['-C', root, 'config', 'user.email', 'gate@test'], { stdio: 'ignore' });
      execFileSync('git', ['-C', root, 'config', 'user.name', 'gate'], { stdio: 'ignore' });
      // Commit the REAL artifact bytes so blob-hash verification passes and
      // only the ancestry criterion can fail.
      for (const artifact of [
        '.autonomous-runner-implementation-progress.md',
        'docs/wave3-complete-gate-receipt.md',
        'docs/wave4-complete-gate-receipt.md',
        'docs/wave3-redaction-review-receipt.md',
        'docs/wave4-cleanroom-certificates.json',
        'docs/wave4-cleanroom-realhost-certificate.md',
        'docs/wave4-pilot-demo-packet.md',
        'forge/specs/pending/wave-5-forgejo-adapter-omp-shim.json',
        'docs/wave5-forgejo-omp-plan.md',
        'docs/wave5-spec-pipeline-receipt.md',
      ]) {
        const sourcePath = path.join(REPO_ROOT, artifact);
        const targetPath = path.join(root, artifact);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourcePath, targetPath);
      }
      fs.writeFileSync(path.join(root, 'stub.txt'), 'base\n');
      execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'ignore' });
      execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'base'], { stdio: 'ignore' });
      for (const sha of [WAVE5_REVIEWED_WAVE2_SHA, WAVE5_REVIEWED_WAVE3_SHA, WAVE5_REVIEWED_WAVE4_SHA,
        WAVE5_WAVE4_CODE_HEAD, WAVE5_WAVE4_CLEANROOM_REVIEW_SHA]) {
        fs.writeFileSync(path.join(root, 'stub.txt'), `${sha}\n`);
        execFileSync('git', ['-C', root, 'add', 'stub.txt'], { stdio: 'ignore' });
        execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'stub'], { stdio: 'ignore' });
        execFileSync('git', ['-C', root, 'update-ref', `refs/heads/reviewed-${sha.slice(0, 8)}`, 'HEAD'], { stdio: 'ignore' });
        execFileSync('git', ['-C', root, 'reset', '--quiet', '--hard', 'HEAD~1'], { stdio: 'ignore' });
      }
      await expect(loadCanonicalWave5PrerequisiteGate({ repoRoot: root }))
        .rejects.toThrow(/not an ancestor of the repository HEAD/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('blocks when a committed artifact is stale or missing', async () => {
    await expect(loadCanonicalWave5PrerequisiteGate({ repoRoot: '/nonexistent/repo' }))
      .rejects.toThrow(/committed artifact is missing/);
  });
});
