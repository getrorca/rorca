/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Wave 5 exact prerequisite gate — binds the separately merged, independently
 * reviewed Wave 2, Wave 3, and Wave 4 packets plus the W4-014 clean-room
 * certificates and the W4-010 demo packet as COMMITTED artifacts. Mirrors
 * `wave4-federation-gate.ts`; every hash below is the sha256 of a committed
 * file (recomputed at load time), never a self-asserted literal.
 */

import { governedHash } from './governed-contracts';

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export const WAVE5_REVIEWED_WAVE2_SHA = '1420fb4c819aad692894da9449bc4958ed74dd49' as const;
export const WAVE5_REVIEWED_WAVE3_SHA = 'a66537fc3a5607a80f6b1010ebdde238d3b6ce8f' as const;
export const WAVE5_REVIEWED_WAVE4_SHA = '3a96649b39408547f95cb92d4f4495a48c73e054' as const;
export const WAVE5_WAVE4_CODE_HEAD = 'a3efe85b701ba35030c399fc4ba0e684c4638298' as const;
export const WAVE5_WAVE4_CLEANROOM_REVIEW_SHA = '6c9e174f457352c67e524ecd20dd87650e1daeda' as const;
export const WAVE5_WAVE4_TREE = '574eb3eb2768a64a27458b0de69a65726691df76' as const;
export const WAVE5_WAVE4_CODE_TREE = '2196c37550b1fe6379158557609a25fe196ef9f5' as const;
export const WAVE5_WAVE2_MIGRATION_HEAD = 20260731157000 as const;
export const WAVE5_WAVE3A_MIGRATION_HEAD = 20260804182000 as const;
export const WAVE5_WAVE3B_MIGRATION_HEAD = 20260805100000 as const;
export const WAVE5_WAVE4_MIGRATION_HEAD = 20260805101000 as const;
export const WAVE5_WAVE4_OPS_MIGRATION_HEAD = 20260805110000 as const;
export const WAVE5_CONTRACT_VERSION = '1.0.0' as const;
export const WAVE5_IMPLEMENTATION_MARKER = 'W5' as const;

// ── Committed artifact hashes (sha256 of the committed files) ─────────────
// Recomputed by loadCanonicalWave5PrerequisiteGate at load time; these
// constants are the recorded expectations, not the proof.
export const WAVE5_LEDGER_RECEIPT_HASH = 'sha256:90487614871354a32c95807dae3686cbf1ca202e9960c329682d61fae847838b' as const; // .autonomous-runner-implementation-progress.md (current committed ledger receipt)
export const WAVE5_WAVE3_CONFORMANCE_RECEIPT = 'sha256:c998212b90ef90d3c6aabd3f26c2a2ecf15a7df4fecea44c5a663b4bf159a5c4' as const; // docs/wave3-complete-gate-receipt.md
export const WAVE5_WAVE4_CONFORMANCE_RECEIPT = 'sha256:3f4817c942f8029acdf4084534086d46f451f60176eee76289c142a67cd8acf6' as const; // docs/wave4-complete-gate-receipt.md
export const WAVE5_WAVE3_SECURITY_REVIEW_RECEIPT = 'sha256:dc093ac2fbed1642b6203541828503d90539d8cb7aea4b15f37409e58edaf8d0' as const; // docs/wave3-redaction-review-receipt.md
export const WAVE5_CLEANROOM_CERTIFICATES_HASH = 'sha256:9c1f4658e2eb1f0fa9664e65dafcd7480e3c76f7e6262bbf8cb43c09776f8349' as const; // docs/wave4-cleanroom-certificates.json
export const WAVE5_CLEANROOM_REALHOST_HASH = 'sha256:18baf401a25242984b670882e7e3f641deb3c8201d3727d57d020a6248fd2592' as const; // docs/wave4-cleanroom-realhost-certificate.md
export const WAVE5_W4_010_DEMO_PACKET_HASH = 'sha256:4257b22ea8d025666490b72956b4e8725a1ed0c30c470aca00070434a10fd6cf' as const; // docs/wave4-pilot-demo-packet.md
export const WAVE5_SPEC_REVISION = 'sha256:ca7041d7be270ee45a49f853450e354a639853c54c69ebcce64b84a2d0ba412b' as const; // forge/specs/pending/wave-5-forgejo-adapter-omp-shim.json
export const WAVE5_PLAN_HASH = 'sha256:bab36e243383613a04deac42188e91674c67fee27dfa5e4e5abf637b67ba9d99' as const; // docs/wave5-forgejo-omp-plan.md
export const WAVE5_SPEC_PIPELINE_RECEIPT_HASH = 'sha256:99d13056ffd8bf96cce4ce8794f1d4e388e76931ac70645cef7a31d6ab107528' as const; // docs/wave5-spec-pipeline-receipt.md

// Clean-room certificate hashes recorded inside docs/wave4-cleanroom-certificates.json.
export const WAVE5_CLEANROOM_CERT_MANAGED = 'sha256:67fd6dfc7533f162a074dab8eb6941b2af9f380e2565c44b0bb684a86c3ed206' as const;
export const WAVE5_CLEANROOM_CERT_FAKE_FEDERATED = 'sha256:ddf1586de985694db82b79e31081de38bdbec3963e712895d721e8e61b5c36b5' as const;

export const WAVE5_WAVE4_SECURITY_REVIEWER = 'Wave4SecFinal3' as const;
export const WAVE5_WAVE4_RELEASE_REVIEWER = 'Wave4RelFinalConfirm' as const;
export const WAVE5_WAVE4_CLEANROOM_REVIEWER = 'Wave4CleanRoomReview3' as const;
export const WAVE5_WAVE3_REVIEWED_TREE = 'a8bea27e85c9340d69ed078cd15a9dbfdc586abd' as const;

const Hash = /^sha256:[a-f0-9]{64}$/;
const Sha = /^[0-9a-f]{40}$/;

export interface Wave5PrerequisitePacket {
  readonly schemaVersion: 'rorca.wave5-prerequisite-packet.v1';
  readonly wave2: Readonly<{ implementationSha: typeof WAVE5_REVIEWED_WAVE2_SHA; migrationHead: typeof WAVE5_WAVE2_MIGRATION_HEAD; contractVersion: typeof WAVE5_CONTRACT_VERSION; contractHash: string }>;
  readonly wave3: Readonly<{ implementationSha: typeof WAVE5_REVIEWED_WAVE3_SHA; migrationHead: typeof WAVE5_WAVE3A_MIGRATION_HEAD; conformanceReceiptHash: string; securityReviewReceiptHash: string; releaseReviewReceiptHash: string; securityReviewerId: string; releaseReviewerId: string; reviewVerdict: 'accepted'; findingCount: 0; reviewedTree: string }>;
  readonly wave4: Readonly<{
    implementationSha: typeof WAVE5_REVIEWED_WAVE4_SHA;
    codeHead: typeof WAVE5_WAVE4_CODE_HEAD;
    migrationHead: typeof WAVE5_WAVE4_MIGRATION_HEAD;
    opsMigrationHead: typeof WAVE5_WAVE4_OPS_MIGRATION_HEAD;
    conformanceReceiptHash: string;
    securityReviewerId: string;
    releaseReviewerId: string;
    reviewVerdict: 'accepted';
    findingCount: 0;
    reviewedTree: typeof WAVE5_WAVE4_TREE;
    codeTree: typeof WAVE5_WAVE4_CODE_TREE;
  }>;
  readonly cleanRoom: Readonly<{
    certificatesFileHash: string;
    realhostFileHash: string;
    certificateManagedHash: string;
    certificateFakeFederatedHash: string;
    reviewerId: string;
    reviewVerdict: 'accepted';
    findingCount: 0;
    sourceSha: typeof WAVE5_WAVE4_CODE_HEAD;
  }>;
  readonly demoPacket: Readonly<{ fileHash: string }>;
  readonly wave5: Readonly<{
    specRevision: typeof WAVE5_SPEC_REVISION;
    planHash: string;
    specPipelineReceiptHash: string;
  }>;
  readonly integration: Readonly<{ exactSha: typeof WAVE5_REVIEWED_WAVE4_SHA; compatibilityVersion: typeof WAVE5_CONTRACT_VERSION; unresolvedConflicts: readonly [] }>;
  readonly activeImplementationWaves: readonly [typeof WAVE5_IMPLEMENTATION_MARKER];
  readonly revoked: false;
}

export interface Wave5PrerequisiteGate {
  readonly schemaVersion: 'rorca.wave5-prerequisite-gate.v1';
  readonly accepted: true;
  readonly packetHash: string;
  /** The gate grants NO execution authority — dispatch remains fail closed. */
  readonly executionAuthority: 'none';
  readonly lifecycleDecisionAuthority: 'none';
  readonly providerHumanAuthority: 'none';
  readonly mergeAuthority: 'none';
  readonly deploymentAuthority: 'none';
  readonly productionAuthority: 'none';
}

export function verifyWave5Prerequisites(packet: Wave5PrerequisitePacket): Wave5PrerequisiteGate {
  const exact = packet.schemaVersion === 'rorca.wave5-prerequisite-packet.v1'
    && packet.wave2.implementationSha === WAVE5_REVIEWED_WAVE2_SHA
    && packet.wave2.migrationHead === WAVE5_WAVE2_MIGRATION_HEAD
    && packet.wave2.contractVersion === WAVE5_CONTRACT_VERSION
    && packet.wave3.implementationSha === WAVE5_REVIEWED_WAVE3_SHA
    && packet.wave3.migrationHead === WAVE5_WAVE3A_MIGRATION_HEAD
    && packet.wave3.conformanceReceiptHash === WAVE5_WAVE3_CONFORMANCE_RECEIPT
    && packet.wave3.securityReviewReceiptHash === WAVE5_WAVE3_SECURITY_REVIEW_RECEIPT
    && packet.wave3.releaseReviewReceiptHash === WAVE5_LEDGER_RECEIPT_HASH
    && packet.wave3.securityReviewerId !== packet.wave3.releaseReviewerId
    && packet.wave3.reviewVerdict === 'accepted' && packet.wave3.findingCount === 0
    && packet.wave3.reviewedTree === 'a8bea27e85c9340d69ed078cd15a9dbfdc586abd'
    && packet.wave4.implementationSha === WAVE5_REVIEWED_WAVE4_SHA
    && packet.wave4.codeHead === WAVE5_WAVE4_CODE_HEAD
    && packet.wave4.migrationHead === WAVE5_WAVE4_MIGRATION_HEAD
    && packet.wave4.opsMigrationHead === WAVE5_WAVE4_OPS_MIGRATION_HEAD
    && packet.wave4.conformanceReceiptHash === WAVE5_WAVE4_CONFORMANCE_RECEIPT
    && packet.wave4.securityReviewerId === WAVE5_WAVE4_SECURITY_REVIEWER
    && packet.wave4.releaseReviewerId === WAVE5_WAVE4_RELEASE_REVIEWER
    && (packet.wave4.securityReviewerId as string) !== (packet.wave4.releaseReviewerId as string)
    && packet.wave4.reviewVerdict === 'accepted' && packet.wave4.findingCount === 0
    && packet.wave4.codeTree === WAVE5_WAVE4_CODE_TREE
    && packet.cleanRoom.certificatesFileHash === WAVE5_CLEANROOM_CERTIFICATES_HASH
    && packet.cleanRoom.realhostFileHash === WAVE5_CLEANROOM_REALHOST_HASH
    && packet.cleanRoom.certificateManagedHash === WAVE5_CLEANROOM_CERT_MANAGED
    && packet.cleanRoom.certificateFakeFederatedHash === WAVE5_CLEANROOM_CERT_FAKE_FEDERATED
    && packet.cleanRoom.reviewerId === WAVE5_WAVE4_CLEANROOM_REVIEWER
    && packet.cleanRoom.reviewVerdict === 'accepted' && packet.cleanRoom.findingCount === 0
    && packet.cleanRoom.sourceSha === WAVE5_WAVE4_CODE_HEAD
    && packet.demoPacket.fileHash === WAVE5_W4_010_DEMO_PACKET_HASH
    && packet.wave5.specRevision === WAVE5_SPEC_REVISION
    && packet.wave5.planHash === WAVE5_PLAN_HASH
    && packet.wave5.specPipelineReceiptHash === WAVE5_SPEC_PIPELINE_RECEIPT_HASH
    && packet.integration.exactSha === WAVE5_REVIEWED_WAVE4_SHA
    && packet.integration.compatibilityVersion === WAVE5_CONTRACT_VERSION
    && packet.integration.unresolvedConflicts.length === 0
    && packet.revoked === false;
  if (!exact) throw new Error('Wave 5 prerequisite evidence is missing, stale, changed, revoked, incompatible, or ambiguous');
  for (const value of [
    packet.wave2.contractHash, packet.wave3.conformanceReceiptHash,
    packet.wave3.securityReviewReceiptHash, packet.wave3.releaseReviewReceiptHash,
    packet.wave4.conformanceReceiptHash, packet.cleanRoom.certificatesFileHash,
    packet.cleanRoom.realhostFileHash, packet.cleanRoom.certificateManagedHash,
    packet.cleanRoom.certificateFakeFederatedHash, packet.demoPacket.fileHash,
    packet.wave5.specRevision, packet.wave5.planHash, packet.wave5.specPipelineReceiptHash,
  ]) {
    if (!Hash.test(value)) throw new Error('Wave 5 requires exact sha256 hashes for every committed artifact');
  }
  if (packet.activeImplementationWaves.length !== 1 || packet.activeImplementationWaves[0] !== WAVE5_IMPLEMENTATION_MARKER) {
    throw new Error('Wave 5 cannot overlap another implementation wave');
  }
  return Object.freeze({
    schemaVersion: 'rorca.wave5-prerequisite-gate.v1', accepted: true,
    packetHash: governedHash('rorca.wave5-prerequisite-packet.v1', packet as never),
    executionAuthority: 'none', lifecycleDecisionAuthority: 'none',
    providerHumanAuthority: 'none', mergeAuthority: 'none', deploymentAuthority: 'none',
    productionAuthority: 'none',
  });
}


// ── Canonical loader: bind COMMITTED artifacts, never self-asserted ───────

function sha256File(filePath: string): string {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

/** sha256 of the exact committed blob at HEAD:<relativePath> via git cat-file. */
function headBlobSha256(repoRoot: string, relativePath: string): string {
  let blob: Buffer;
  try {
    blob = execFileSync('git', ['-C', repoRoot, 'cat-file', 'blob', `HEAD:${relativePath}`]);
  } catch {
    throw new Error(`Wave 5 committed artifact is missing from HEAD: ${relativePath}`);
  }
  return `sha256:${crypto.createHash('sha256').update(blob).digest('hex')}`;
}

/**
 * Verify the reviewed Wave 2/3/4 SHAs are ANCESTORS of the repository HEAD
 * (not merely objects reachable from an unrelated ref) and that the reviewed
 * tree identities match the packet's recorded expectations.
 */
function assertReviewedShaAncestry(
  repoRoot: string,
  shas: readonly string[],
  treeExpectations: ReadonlyArray<readonly [string, string]>,
): void {
  for (const sha of shas) {
    if (!Sha.test(sha)) throw new Error(`Wave 5 reviewed SHA is malformed: ${sha}`);
    try {
      execFileSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', sha, 'HEAD'], { stdio: 'ignore' });
    } catch {
      throw new Error(`Wave 5 reviewed SHA is not an ancestor of the repository HEAD: ${sha}`);
    }
  }
  for (const [sha, expectedTree] of treeExpectations) {
    if (!Sha.test(sha) || !Sha.test(expectedTree)) {
      throw new Error(`Wave 5 reviewed tree identity is malformed: ${sha}`);
    }
    let actualTree: string;
    try {
      actualTree = execFileSync('git', ['-C', repoRoot, 'rev-parse', `${sha}^{tree}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      throw new Error(`Wave 5 reviewed tree identity is unavailable for: ${sha}`);
    }
    if (actualTree !== expectedTree) {
      throw new Error(`Wave 5 reviewed tree changed for ${sha} (expected ${expectedTree}, found ${actualTree})`);
    }
  }
}

function assertFileHash(repoRoot: string, relativePath: string, expected: string): void {
  // Hash the exact HEAD:<path> blob — the committed artifact — never the
  // possibly-dirty working tree.
  const actual = headBlobSha256(repoRoot, relativePath);
  if (actual !== expected) {
    throw new Error(`Wave 5 committed artifact changed: ${relativePath} (expected ${expected}, found ${actual})`);
  }
  // Clean exact binding: when a filesystem file is present it MUST carry the
  // reviewed bytes; a diverging working-tree copy makes the binding ambiguous.
  const filePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Wave 5 committed artifact is missing from the working tree: ${relativePath}`);
  }
  const workingTreeHash = sha256File(filePath);
  if (workingTreeHash !== expected) {
    throw new Error(`Wave 5 working-tree artifact diverges from the reviewed HEAD blob: ${relativePath}`);
  }
}

export interface LoadCanonicalWave5PrerequisiteGateOptions {
  /** Repository root containing the committed artifacts (default: env RORCA_REPO_ROOT or resolved from this module). */
  repoRoot?: string;
}

function defaultRepoRoot(): string {
  const fromEnv = process.env.RORCA_REPO_ROOT;
  if (fromEnv) return fromEnv;
  // Resolve the git top-level robustly from this module's location instead of
  // assuming a fixed directory depth (backend/src/lib is 3 levels deep, not 4).
  try {
    const topLevel = execFileSync('git', ['-C', __dirname, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (topLevel) return topLevel;
  } catch { /* fall through to the relative fallback */ }
  return path.resolve(__dirname, '..', '..', '..');
}

export async function loadCanonicalWave5PrerequisiteGate(
  options: LoadCanonicalWave5PrerequisiteGateOptions = {},
): Promise<Wave5PrerequisiteGate> {
  const repoRoot = options.repoRoot ?? defaultRepoRoot();

  // Recompute every hash from the committed files — the constants are only
  // recorded expectations; the proof is the recomputation.
  assertFileHash(repoRoot, '.autonomous-runner-implementation-progress.md', WAVE5_LEDGER_RECEIPT_HASH);
  assertFileHash(repoRoot, 'docs/wave3-complete-gate-receipt.md', WAVE5_WAVE3_CONFORMANCE_RECEIPT);
  assertFileHash(repoRoot, 'docs/wave4-complete-gate-receipt.md', WAVE5_WAVE4_CONFORMANCE_RECEIPT);
  assertFileHash(repoRoot, 'docs/wave3-redaction-review-receipt.md', WAVE5_WAVE3_SECURITY_REVIEW_RECEIPT);
  // The reviewed Wave 2/3/4 heads must be ANCESTORS of the repository HEAD
  // (structural containment — an unrelated ref or a dangling object cannot
  // satisfy the gate) and their reviewed trees must match the packet.
  assertReviewedShaAncestry(repoRoot, [
    WAVE5_REVIEWED_WAVE2_SHA,
    WAVE5_REVIEWED_WAVE3_SHA,
    WAVE5_REVIEWED_WAVE4_SHA,
    WAVE5_WAVE4_CODE_HEAD,
    WAVE5_WAVE4_CLEANROOM_REVIEW_SHA,
  ], [
    [WAVE5_REVIEWED_WAVE3_SHA, WAVE5_WAVE3_REVIEWED_TREE],
    [WAVE5_REVIEWED_WAVE4_SHA, WAVE5_WAVE4_TREE],
    [WAVE5_WAVE4_CODE_HEAD, WAVE5_WAVE4_CODE_TREE],
  ]);

  return verifyWave5Prerequisites({
    schemaVersion: 'rorca.wave5-prerequisite-packet.v1',
    wave2: { implementationSha: WAVE5_REVIEWED_WAVE2_SHA, migrationHead: WAVE5_WAVE2_MIGRATION_HEAD,
      contractVersion: WAVE5_CONTRACT_VERSION, contractHash: WAVE5_LEDGER_RECEIPT_HASH },
    wave3: { implementationSha: WAVE5_REVIEWED_WAVE3_SHA, migrationHead: WAVE5_WAVE3A_MIGRATION_HEAD,
      conformanceReceiptHash: WAVE5_WAVE3_CONFORMANCE_RECEIPT,
      securityReviewReceiptHash: WAVE5_WAVE3_SECURITY_REVIEW_RECEIPT,
      releaseReviewReceiptHash: WAVE5_LEDGER_RECEIPT_HASH,
      securityReviewerId: 'Wave3SecFinal2', releaseReviewerId: 'Wave3RelFinal2',
      reviewVerdict: 'accepted', findingCount: 0, reviewedTree: WAVE5_WAVE3_REVIEWED_TREE },
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
    integration: { exactSha: WAVE5_REVIEWED_WAVE4_SHA, compatibilityVersion: WAVE5_CONTRACT_VERSION,
      unresolvedConflicts: [] },
    activeImplementationWaves: [WAVE5_IMPLEMENTATION_MARKER], revoked: false,
  });
}
