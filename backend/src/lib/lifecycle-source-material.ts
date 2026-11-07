/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { queryOne } from '../db/index';
import { ConflictError, NotFoundError, ValidationError } from './errors';

const EXPORT_ROOT = path.join('genesis', 'artifacts', 'export-packs');
const MAX_PACKS = 64;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_PREVIEW_LINES = 400;
const MAX_SECTION_CHARS = 12_000;
const HASH = /^sha256:[a-f0-9]{64}$/;
const AUTHORITY_RECEIPT_CONTRACT = 'genesis.package-publication-receipt/v1';


export type LifecycleSourceLens = 'planning' | 'requirements' | 'design';
export type LifecycleSourceArtifactAction = 'open' | 'reveal';

export interface LifecycleSourceArtifact {
  name: string;
  label: string;
  role: 'requirements' | 'design' | 'planning' | 'context' | 'citations' | 'manifest' | 'rendered' | 'other';
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
  contentHash: `sha256:${string}`;
}

export interface LifecycleSourceSynthesisSection {
  id: string;
  title: string;
  content: string;
  sourcePath: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
  sourceContentHash: `sha256:${string}` | null;
  freshness: 'current' | 'stale';
}
export type LifecycleSourceAuthorityReason =
  | 'verified'
  | 'authority_receipt_not_declared'
  | 'authority_receipt_path_invalid'
  | 'authority_receipt_missing'
  | 'authority_receipt_invalid'
  | 'authority_receipt_not_trusted'
  | 'authority_ledger_unavailable'
  | 'manifest_identity_mismatch'
  | 'workspace_binding_mismatch'
  | 'release_subject_not_available'
  | 'release_subject_mismatch'
  | 'artifact_manifest_invalid'
  | 'artifact_path_invalid'
  | 'artifact_missing'
  | 'artifact_hash_mismatch';

export interface LifecycleSourceAuthority {
  status: 'verified' | 'context_only';
  reasonCode: LifecycleSourceAuthorityReason;
  rationale: string;
  receiptId: string | null;
  receiptHash: `sha256:${string}` | null;
  manifestHash: `sha256:${string}` | null;
  releaseSubject: { type: 'spec_hash'; value: `sha256:${string}` } | null;
}


interface AvailableLifecycleSourceMaterial {
  state: 'available';
  schemaVersion: 'rorca.lifecycle-source-material.v1';
  lens: LifecycleSourceLens;
  package: {
    packageId: string;
    title: string;
    workspaceId: string | null;
    status: string;
    publicationStatus: string;
    authoritative: boolean;
    scope: string | null;
    contentHash: string;
    previewHash: string | null;
    snapshotHash: string | null;
  };
  authority: LifecycleSourceAuthority;

  match: {
    method: 'explicit_binding' | 'referenced_source_overlap' | 'title_overlap';
    confidence: number;
    referencesMatched: string[];
    rationale: string;
  };
  inventory: {
    evidenceCount: number;
    excludedCount: number;
    warningCount: number;
    contradictionCount: number;
    uncertaintyCount: number;
    warnings: string[];
    contradictions: string[];
    uncertainties: string[];
  };
  artifacts: LifecycleSourceArtifact[];
  synthesis: {
    title: string;
    description: string;
    sections: LifecycleSourceSynthesisSection[];
    sourcePackageHash: string;
  };
}

interface UnavailableLifecycleSourceMaterial {
  state: 'not_found' | 'ambiguous' | 'invalid';
  schemaVersion: 'rorca.lifecycle-source-material.v1';
  lens: LifecycleSourceLens;
  rationale: string;
}

export type LifecycleSourceMaterial = AvailableLifecycleSourceMaterial | UnavailableLifecycleSourceMaterial;

export interface LifecycleSourceEvidenceReference {
  artifactPath: string;
  artifactHash: `sha256:${string}`;
  startLine: number;
  endLine: number;
}

export interface LifecycleSourceEvidenceProjection {
  lens: LifecycleSourceLens;
  packageId: string;
  packageHash: `sha256:${string}`;
  previewHash: `sha256:${string}`;
  snapshotHash: `sha256:${string}`;
  references: LifecycleSourceEvidenceReference[];
  authorityReceiptId: string;
  authorityReceiptHash: `sha256:${string}`;
  manifestHash: `sha256:${string}`;
  releaseSubject: { type: 'spec_hash'; value: `sha256:${string}` };

  projectionHash: `sha256:${string}`;
}

/**
 * Reduce a source-material projection to hash- and line-bound evidence. The
 * returned value deliberately excludes package and section content so callers
 * cannot copy a Genesis export pack into the lifecycle evidence ledger.
 */
export function lifecycleSourceEvidenceProjection(
  material: LifecycleSourceMaterial,
): LifecycleSourceEvidenceProjection | null {
  if (material.state !== 'available'
    || material.authority.status !== 'verified'
    || material.authority.receiptId === null
    || material.authority.receiptHash === null
    || material.authority.manifestHash === null
    || material.authority.releaseSubject === null
    || !HASH.test(material.package.contentHash)
    || typeof material.package.previewHash !== 'string'
    || !HASH.test(material.package.previewHash)
    || typeof material.package.snapshotHash !== 'string'
    || !HASH.test(material.package.snapshotHash)) return null;
  const references = material.synthesis.sections
    .filter((section) => section.freshness === 'current'
      && section.sourceContentHash !== null
      && HASH.test(section.sourceContentHash)
      && Number.isSafeInteger(section.startLine)
      && Number.isSafeInteger(section.endLine)
      && section.startLine > 0
      && section.endLine >= section.startLine)
    .map((section) => ({
      artifactPath: section.sourcePath,
      artifactHash: section.sourceContentHash!,
      startLine: section.startLine,
      endLine: section.endLine,
    }))
    .filter((reference, index, all) => all.findIndex((candidate) =>
      candidate.artifactPath === reference.artifactPath
      && candidate.artifactHash === reference.artifactHash
      && candidate.startLine === reference.startLine
      && candidate.endLine === reference.endLine) === index)
    .slice(0, 32);
  if (references.length === 0) return null;
  const stable = {
    lens: material.lens,
    packageId: material.package.packageId,
    packageHash: material.package.contentHash as `sha256:${string}`,
    previewHash: material.package.previewHash as `sha256:${string}`,
    snapshotHash: material.package.snapshotHash as `sha256:${string}`,
    authorityReceiptId: material.authority.receiptId,
    authorityReceiptHash: material.authority.receiptHash,
    manifestHash: material.authority.manifestHash,
    releaseSubject: material.authority.releaseSubject,

    references,
  };
  return {
    ...stable,
    projectionHash: sha256(JSON.stringify(stable)),
  };
}

export interface LifecycleSourceArtifactPreview {
  relativePath: string;
  name: string;
  role: LifecycleSourceArtifact['role'];
  content: string;
  contentType: 'markdown' | 'json' | 'html' | 'text';
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
  projectedContentHash: `sha256:${string}`;
  actualContentHash: `sha256:${string}`;
  stale: boolean;
  modifiedAt: string;
}

const ExportManifestSchema = z.object({
  packageId: z.string().trim().min(1).max(256).optional(),
  workspaceId: z.string().trim().min(1).max(256).optional(),
  files: z.array(z.string().trim().min(1)).min(1).max(64).optional(),
  packagePath: z.string().trim().min(1).max(1_024).optional(),
  documents: z.array(z.object({
    path: z.string().trim().min(1).max(512),
  }).passthrough()).max(64).optional(),
  views: z.array(z.object({
    path: z.string().trim().min(1).max(512),
  }).passthrough()).max(64).optional(),
  contentHash: z.string().regex(HASH),
  previewHash: z.string().regex(HASH).optional(),
  snapshotHash: z.string().regex(HASH).optional(),
  authorityReceiptPath: z.string().trim().min(1).max(512).optional(),
}).passthrough();
const PublicationReceiptArtifactSchema = z.object({
  path: z.string().trim().min(1).max(512),
  contentHash: z.string().regex(HASH),
  sizeBytes: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
}).strict();

const PublicationReceiptSchema = z.object({
  contractVersion: z.literal(AUTHORITY_RECEIPT_CONTRACT),
  receiptId: z.string().regex(/^package-event:sha256:[a-f0-9]{64}$/),
  eventHash: z.string().regex(HASH),
  state: z.literal('published'),
  authoritative: z.literal(true),
  workspaceId: z.string().trim().min(1).max(256),
  packageId: z.string().trim().min(1).max(256),
  packagePath: z.string().trim().min(1).max(1_024),
  packageHash: z.string().regex(HASH),
  previewHash: z.string().regex(HASH),
  snapshotHash: z.string().regex(HASH),
  manifestHash: z.string().regex(HASH),
  releaseSubject: z.object({
    type: z.literal('spec_hash'),
    value: z.string().regex(HASH),
  }).strict(),
  artifacts: z.array(PublicationReceiptArtifactSchema).min(1).max(64),
}).strict();

type PublicationReceipt = z.infer<typeof PublicationReceiptSchema>;
interface ExportManifest {
  packageId: string;
  workspaceId?: string;
  files: string[];
  packagePath?: string;
  contentHash: string;
  previewHash: string | null;
  snapshotHash: string | null;
  authorityReceiptPath?: string;
  [key: string]: unknown;
}

const SpecContextReferencesSchema = z.object({
  contextUsed: z.object({
    meta: z.object({
      filesReferenced: z.array(z.string()),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

interface MarkdownSection {
  heading: string;
  normalizedHeading: string;
  level: number;
  startLine: number;
  bodyLines: string[];
}

interface PackCandidate {
  directory: string;
  manifestPath: string;
  manifest: ExportManifest;
  rawManifest: string;
  score: number;
  method: AvailableLifecycleSourceMaterial['match']['method'];
  confidence: number;
  referencesMatched: string[];
  titleMatches: string[];
}

export interface SourceProjectionInput {
  workspacePath: string;
  workspaceId?: string;
  specId: string;
  specTitle: string | null;
  specContent: Record<string, unknown> | null;
  lens: LifecycleSourceLens;
  releaseSubject?: { type: 'spec_hash'; value: `sha256:${string}` };
}


function boundedText(value: unknown, fallback: string, maximum = 512): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maximum) : fallback;
}

function boundedStrings(value: unknown, maximum = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maximum).flatMap((item) => {
    if (typeof item === 'string') return item.trim() ? [item.trim().slice(0, 1_024)] : [];
    try {
      const encoded = JSON.stringify(item);
      return encoded ? [encoded.slice(0, 1_024)] : [];
    } catch {
      return [];
    }
  });
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function posixRelative(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join('/');
}

function sha256(content: Buffer | string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function artifactRole(name: string): LifecycleSourceArtifact['role'] {
  switch (name.toLowerCase()) {
    case 'prd.md': return 'requirements';
    case 'sdd.md': return 'design';
    case 'plan.md': return 'planning';
    case 'context.md': return 'context';
    case 'citations.md':
    case 'citations.json': return 'citations';
    case 'manifest.json': return 'manifest';
    case 'index.html': return 'rendered';
    default: return 'other';
  }
}

function artifactLabel(name: string): string {
  switch (name.toLowerCase()) {
    case 'prd.md': return 'Product requirements';
    case 'sdd.md': return 'System design';
    case 'plan.md': return 'Export plan';
    case 'context.md': return 'Source context';
    case 'citations.md': return 'Citation index';
    case 'citations.json': return 'Machine-readable citations';
    case 'manifest.json': return 'Export manifest';
    case 'index.html': return 'Rendered export';
    default: return name;
  }
}

function manifest(value: unknown, expectedPackageId?: string): ExportManifest | null {
  const result = ExportManifestSchema.safeParse(value);
  if (!result.success) return null;
  const parsed = result.data;
  const pathPackageId = parsed.packagePath ? path.posix.basename(parsed.packagePath.replaceAll('\\', '/')) : null;
  const packageId = parsed.packageId ?? pathPackageId;
  if (!packageId) return null;
  if (pathPackageId && expectedPackageId && pathPackageId !== expectedPackageId) return null;
  const files = parsed.files ?? [
    ...(parsed.documents ?? []).map((document) => document.path),
    ...(parsed.views ?? []).map((view) => view.path),
    'manifest.json',
  ];
  const uniqueFiles = [...new Set(files)];
  if (uniqueFiles.length === 0 || uniqueFiles.length > 64) return null;
  return {
    ...parsed,
    packageId,
    files: uniqueFiles,
    previewHash: parsed.previewHash ?? null,
    snapshotHash: parsed.snapshotHash ?? null,
  };
}
const AUTHORITY_RATIONALE: Record<LifecycleSourceAuthorityReason, string> = {
  verified: 'Canonical package publication authority and every declared artifact byte were verified for the current spec revision.',
  authority_receipt_not_declared: 'This local package is context only because it does not declare canonical publication authority.',
  authority_receipt_path_invalid: 'This local package is context only because its authority receipt path is outside the bounded package.',
  authority_receipt_missing: 'This local package is context only because its declared authority receipt is unavailable.',
  authority_receipt_invalid: 'This local package is context only because its authority receipt is malformed or unsupported.',
  authority_receipt_not_trusted: 'This local package is context only because its exact publication receipt is absent from the server-owned authority ledger.',
  authority_ledger_unavailable: 'This local package is context only because the server-owned publication authority ledger could not be verified.',
  manifest_identity_mismatch: 'This local package is context only because its manifest identity does not match canonical publication authority.',
  workspace_binding_mismatch: 'This local package is context only because its publication authority belongs to a different workspace.',
  release_subject_not_available: 'This local package is context only because no current release subject was supplied for authority verification.',
  release_subject_mismatch: 'This local package is context only because its publication authority names a different release subject.',
  artifact_manifest_invalid: 'This local package is context only because its authoritative artifact inventory is incomplete or duplicated.',
  artifact_path_invalid: 'This local package is context only because a declared artifact path escapes the bounded package.',
  artifact_missing: 'This local package is context only because a declared artifact is unavailable.',
  artifact_hash_mismatch: 'This local package is context only because a declared artifact does not match its authoritative byte hash.',
};

function contextOnly(reasonCode: Exclude<LifecycleSourceAuthorityReason, 'verified'>): LifecycleSourceAuthority {
  return {
    status: 'context_only',
    reasonCode,
    rationale: AUTHORITY_RATIONALE[reasonCode],
    receiptId: null,
    receiptHash: null,
    manifestHash: null,
    releaseSubject: null,
  };
}

function packageRelativePath(value: string): string | null {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return path.posix.normalize(normalized) === normalized ? normalized : null;
}

async function verifySourceAuthority(input: {
  workspaceRoot: string;
  candidate: PackCandidate;
  specId: string;
  loadedArtifacts: LifecycleSourceArtifact[];
  workspaceId?: string;
  releaseSubject?: SourceProjectionInput['releaseSubject'];
}): Promise<LifecycleSourceAuthority> {
  const declaredReceiptPath = input.candidate.manifest.authorityReceiptPath;
  if (!declaredReceiptPath) return contextOnly('authority_receipt_not_declared');
  const receiptPath = packageRelativePath(declaredReceiptPath);
  if (!receiptPath) return contextOnly('authority_receipt_path_invalid');

  let rawManifest: Buffer;
  let rawReceipt: Buffer;
  let receipt: PublicationReceipt;
  try {
    const receiptDeclaredPath = path.resolve(input.candidate.directory, receiptPath);
    if (!inside(input.candidate.directory, receiptDeclaredPath)) return contextOnly('authority_receipt_path_invalid');
    const receiptLstat = await fsp.lstat(receiptDeclaredPath);
    if (receiptLstat.isSymbolicLink() || !receiptLstat.isFile()
      || receiptLstat.size <= 0 || receiptLstat.size > MAX_MANIFEST_BYTES) {
      return contextOnly('authority_receipt_invalid');
    }
    const absoluteReceiptPath = await fsp.realpath(receiptDeclaredPath);
    if (!inside(input.candidate.directory, absoluteReceiptPath)) return contextOnly('authority_receipt_path_invalid');
    [rawManifest, rawReceipt] = await Promise.all([
      fsp.readFile(input.candidate.manifestPath),
      fsp.readFile(absoluteReceiptPath),
    ]);
    if (rawManifest.length <= 0 || rawManifest.length > MAX_MANIFEST_BYTES
      || rawReceipt.length <= 0 || rawReceipt.length > MAX_MANIFEST_BYTES) {
      return contextOnly('authority_receipt_invalid');
    }
    const parsedReceipt = PublicationReceiptSchema.safeParse(JSON.parse(rawReceipt.toString('utf8')));
    if (!parsedReceipt.success) return contextOnly('authority_receipt_invalid');
    receipt = parsedReceipt.data;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return contextOnly(code === 'ENOENT' ? 'authority_receipt_missing' : 'authority_receipt_invalid');
  }

  let currentManifest: ExportManifest | null = null;
  try {
    currentManifest = manifest(JSON.parse(rawManifest.toString('utf8')));
  } catch {
    // The bounded reason below intentionally excludes parser details or manifest content.
  }
  const packagePath = posixRelative(input.workspaceRoot, input.candidate.directory);
  if (!currentManifest
    || currentManifest.packageId !== input.candidate.manifest.packageId
    || currentManifest.authorityReceiptPath !== receiptPath
    || path.basename(input.candidate.directory) !== currentManifest.packageId
    || receipt.packageId !== currentManifest.packageId
    || receipt.receiptId !== `package-event:${receipt.eventHash}`
    || receipt.packagePath !== packagePath
    || receipt.packageHash !== currentManifest.contentHash
    || receipt.previewHash !== currentManifest.previewHash
    || receipt.snapshotHash !== currentManifest.snapshotHash
    || receipt.manifestHash !== sha256(rawManifest)
    || currentManifest.authoritative !== true
    || currentManifest.status !== 'published'
    || currentManifest.publicationStatus !== 'published') {
    return contextOnly('manifest_identity_mismatch');
  }
  const manifestWorkspaceId = typeof currentManifest.workspaceId === 'string' ? currentManifest.workspaceId : null;
  if (!manifestWorkspaceId || receipt.workspaceId !== manifestWorkspaceId
    || (input.workspaceId !== undefined && receipt.workspaceId !== input.workspaceId)) {
    return contextOnly('workspace_binding_mismatch');
  }
  if (!input.releaseSubject) return contextOnly('release_subject_not_available');
  if (receipt.releaseSubject.type !== input.releaseSubject.type
    || receipt.releaseSubject.value !== input.releaseSubject.value) {
    return contextOnly('release_subject_mismatch');
  }

  const declaredFiles = currentManifest.files.map(packageRelativePath);
  if (declaredFiles.some((file): file is null => file === null)) return contextOnly('artifact_path_invalid');
  const boundedFiles = declaredFiles as string[];
  if (new Set(boundedFiles).size !== boundedFiles.length) return contextOnly('artifact_manifest_invalid');
  const artifactFiles = boundedFiles.filter((file) => file !== 'manifest.json' && file !== receiptPath);
  const receiptPaths = receipt.artifacts.map((artifact) => packageRelativePath(artifact.path));
  if (receiptPaths.some((file): file is null => file === null)) return contextOnly('artifact_path_invalid');
  const normalizedReceiptPaths = receiptPaths as string[];
  if (new Set(normalizedReceiptPaths).size !== normalizedReceiptPaths.length
    || artifactFiles.length !== normalizedReceiptPaths.length
    || artifactFiles.some((file) => !normalizedReceiptPaths.includes(file))) {
    return contextOnly('artifact_manifest_invalid');
  }

  const projectedByPath = new Map(input.loadedArtifacts.map((artifact) => [artifact.relativePath, artifact]));
  for (const artifactReceipt of receipt.artifacts) {
    const relativePath = packageRelativePath(artifactReceipt.path);
    if (!relativePath) return contextOnly('artifact_path_invalid');
    const declaredPath = path.resolve(input.candidate.directory, relativePath);
    if (!inside(input.candidate.directory, declaredPath)) return contextOnly('artifact_path_invalid');
    try {
      const declaredStat = await fsp.lstat(declaredPath);
      if (declaredStat.isSymbolicLink()) return contextOnly('artifact_path_invalid');
      if (!declaredStat.isFile() || declaredStat.size <= 0 || declaredStat.size > MAX_ARTIFACT_BYTES) {
        return contextOnly('artifact_missing');
      }
      const absolutePath = await fsp.realpath(declaredPath);
      if (!inside(input.candidate.directory, absolutePath)) return contextOnly('artifact_path_invalid');
      const handle = await fsp.open(absolutePath, 'r');
      let bytes: Buffer;
      let before: fs.Stats;
      let after: fs.Stats;
      try {
        before = await handle.stat();
        bytes = await handle.readFile();
        after = await handle.stat();
      } finally {
        await handle.close();
      }
      if (!before.isFile() || before.size <= 0 || before.size > MAX_ARTIFACT_BYTES
        || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) {
        return contextOnly('artifact_hash_mismatch');
      }
      const actualHash = sha256(bytes);
      const workspaceRelativePath = posixRelative(input.workspaceRoot, absolutePath);
      const projected = projectedByPath.get(workspaceRelativePath);
      if (actualHash !== artifactReceipt.contentHash || bytes.length !== artifactReceipt.sizeBytes
        || !projected || projected.contentHash !== actualHash || projected.sizeBytes !== bytes.length) {
        return contextOnly('artifact_hash_mismatch');
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return contextOnly(code === 'ENOENT' ? 'artifact_missing' : 'artifact_hash_mismatch');
    }
  }

  const receiptHash = sha256(rawReceipt);
  try {
    const trusted = await queryOne<{ receipt_id: string }>(`
      SELECT receipt_id
      FROM rorca.lifecycle_source_publication_receipts
      WHERE workspace_id = $1
        AND spec_slug = $2
        AND release_subject_hash = $3
        AND package_id = $4
        AND package_path = $5
        AND receipt_id = $6
        AND receipt_hash = $7
        AND event_hash = $8
        AND manifest_hash = $9
        AND package_hash = $10
        AND preview_hash = $11
        AND snapshot_hash = $12
      LIMIT 1
    `, [
      receipt.workspaceId,
      input.specId,
      receipt.releaseSubject.value,
      receipt.packageId,
      receipt.packagePath,
      receipt.receiptId,
      receiptHash,
      receipt.eventHash,
      receipt.manifestHash,
      receipt.packageHash,
      receipt.previewHash,
      receipt.snapshotHash,
    ]);
    if (!trusted || trusted.receipt_id !== receipt.receiptId) {
      return contextOnly('authority_receipt_not_trusted');
    }
  } catch {
    return contextOnly('authority_ledger_unavailable');
  }

  return {
    status: 'verified',
    reasonCode: 'verified',
    rationale: AUTHORITY_RATIONALE.verified,
    receiptId: receipt.receiptId,
    receiptHash,
    manifestHash: receipt.manifestHash as `sha256:${string}`,
    releaseSubject: {
      type: 'spec_hash',
      value: receipt.releaseSubject.value as `sha256:${string}`,
    },
  };
}


function contextReferences(specContent: Record<string, unknown> | null): string[] {
  const parsed = SpecContextReferencesSchema.safeParse(specContent);
  if (!parsed.success) return [];
  return [...new Set(parsed.data.contextUsed.meta.filesReferenced
    .flatMap((value) => value.trim() ? [value.trim()] : []))].slice(0, 256);
}

const TITLE_STOP_WORDS = new Set(['and', 'from', 'into', 'multi', 'with', 'that', 'this', 'the', 'for', 'rorca']);

function titleTokens(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !TITLE_STOP_WORDS.has(token)))];
}

function matchCandidate(
  candidate: Omit<PackCandidate, 'score' | 'method' | 'confidence' | 'referencesMatched' | 'titleMatches'>,
  input: SourceProjectionInput,
  references: string[],
  specSearchText: string,
): PackCandidate {
  const manifestText = candidate.rawManifest.toLocaleLowerCase();
  const referencesMatched = references.filter((reference) => {
    const normalized = reference.toLocaleLowerCase();
    return manifestText.includes(normalized) || manifestText.includes(path.basename(normalized));
  });
  const packageTokens = titleTokens(candidate.manifest.packageId);
  const specTokens = titleTokens(`${input.specId} ${input.specTitle ?? ''}`);
  const titleMatches = specTokens.filter((token) => packageTokens.includes(token));
  const explicitlyBound = [
    candidate.manifest.packageId,
    candidate.manifest.contentHash,
    candidate.manifest.previewHash,
    candidate.manifest.snapshotHash,
  ].some((identity) => typeof identity === 'string' && specSearchText.includes(identity.toLocaleLowerCase()));

  if (explicitlyBound) {
    return { ...candidate, score: 10_000, method: 'explicit_binding', confidence: 1, referencesMatched, titleMatches };
  }
  if (referencesMatched.length > 0) {
    return {
      ...candidate,
      score: 1_000 + referencesMatched.length * 20 + titleMatches.length,
      method: 'referenced_source_overlap',
      confidence: Math.min(0.95, 0.7 + referencesMatched.length * 0.04),
      referencesMatched,
      titleMatches,
    };
  }
  if (titleMatches.length >= 2) {
    return {
      ...candidate,
      score: 100 + titleMatches.length,
      method: 'title_overlap',
      confidence: Math.min(0.75, 0.5 + titleMatches.length * 0.05),
      referencesMatched,
      titleMatches,
    };
  }
  return {
    ...candidate,
    score: 0,
    method: 'title_overlap',
    confidence: 0,
    referencesMatched,
    titleMatches,
  };
}

async function loadCandidates(input: SourceProjectionInput): Promise<{ candidates: PackCandidate[]; invalidCount: number }> {
  const workspaceRoot = await fsp.realpath(input.workspacePath);
  const configuredRoot = path.resolve(workspaceRoot, EXPORT_ROOT);
  let exportRoot: string;
  try {
    exportRoot = await fsp.realpath(configuredRoot);
  } catch {
    return { candidates: [], invalidCount: 0 };
  }
  if (!inside(workspaceRoot, exportRoot)) return { candidates: [], invalidCount: 1 };

  const entries = (await fsp.readdir(exportRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_PACKS + 1);
  if (entries.length > MAX_PACKS) return { candidates: [], invalidCount: entries.length };

  const references = contextReferences(input.specContent);
  let specSearchText = '';
  try {
    specSearchText = JSON.stringify(input.specContent ?? {}).slice(0, MAX_MANIFEST_BYTES).toLocaleLowerCase();
  } catch {
    specSearchText = '';
  }

  let invalidCount = 0;
  const candidates: PackCandidate[] = [];
  for (const entry of entries) {
    try {
      const directory = await fsp.realpath(path.join(exportRoot, entry.name));
      if (!inside(exportRoot, directory)) {
        invalidCount += 1;
        continue;
      }
      const manifestPath = await fsp.realpath(path.join(directory, 'manifest.json'));
      if (!inside(directory, manifestPath)) {
        invalidCount += 1;
        continue;
      }
      const stat = await fsp.stat(manifestPath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_MANIFEST_BYTES) {
        invalidCount += 1;
        continue;
      }
      const rawManifest = await fsp.readFile(manifestPath, 'utf8');
      const parsed = manifest(JSON.parse(rawManifest), entry.name);
      if (!parsed) {
        invalidCount += 1;
        continue;
      }
      if (input.workspaceId && parsed.workspaceId && parsed.workspaceId !== input.workspaceId) {
        continue;
      }
      candidates.push(matchCandidate({ directory, manifestPath, manifest: parsed, rawManifest }, input, references, specSearchText));
    } catch {
      invalidCount += 1;
    }
  }
  return { candidates, invalidCount };
}

async function loadArtifacts(workspaceRoot: string, candidate: PackCandidate): Promise<{
  artifacts: LifecycleSourceArtifact[];
  contentByName: Map<string, string>;
}> {
  const artifacts: LifecycleSourceArtifact[] = [];
  const contentByName = new Map<string, string>();
  for (const declaredName of candidate.manifest.files) {
    const normalizedName = declaredName.replaceAll('\\', '/');
    if (!normalizedName || normalizedName.startsWith('/') || normalizedName.split('/').includes('..')) continue;
    try {
      const absolute = await fsp.realpath(path.resolve(candidate.directory, normalizedName));
      if (!inside(candidate.directory, absolute)) continue;
      const stat = await fsp.stat(absolute);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) continue;
      const bytes = await fsp.readFile(absolute);
      const name = path.basename(normalizedName);
      artifacts.push({
        name,
        label: artifactLabel(name),
        role: artifactRole(name),
        relativePath: posixRelative(workspaceRoot, absolute),
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        contentHash: sha256(bytes),
      });
      if (/\.md$/i.test(name)) contentByName.set(name.toLocaleLowerCase(), bytes.toString('utf8'));
    } catch {
      // A declared artifact that no longer exists is omitted; the manifest remains inspectable.
    }
  }
  artifacts.sort((left, right) => {
    const order = ['PRD.md', 'SDD.md', 'PLAN.md', 'CONTEXT.md', 'CITATIONS.md', 'citations.json', 'manifest.json', 'index.html'];
    return order.indexOf(left.name) - order.indexOf(right.name) || left.name.localeCompare(right.name);
  });
  return { artifacts, contentByName };
}

function markdownSections(content: string): MarkdownSection[] {
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  const headings = lines.flatMap((line, index) => {
    const match = /^(#{2,4})\s+(.+?)\s*$/.exec(line);
    return match ? [{ level: match[1].length, heading: match[2].trim(), lineIndex: index }] : [];
  });
  return headings.map((heading, index) => {
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    const endIndex = next?.lineIndex ?? lines.length;
    return {
      heading: heading.heading,
      normalizedHeading: heading.heading.toLocaleLowerCase().replace(/^\d+[.)]\s*/, '').replace(/\s+/g, ' ').trim(),
      level: heading.level,
      startLine: heading.lineIndex + 1,
      bodyLines: lines.slice(heading.lineIndex + 1, endIndex),
    };
  });
}

function projectedSection(
  section: MarkdownSection,
  sourcePath: string,
  title = section.heading.replace(/^\d+[.)]\s*/, ''),
): LifecycleSourceSynthesisSection | null {
  let leading = 0;
  while (leading < section.bodyLines.length && section.bodyLines[leading]?.trim() === '') leading += 1;
  const remaining = section.bodyLines.slice(leading);
  let trailing = remaining.length;
  while (trailing > 0 && remaining[trailing - 1]?.trim() === '') trailing -= 1;
  const body = remaining.slice(0, trailing);
  if (body.length === 0) return null;

  const included: string[] = [];
  let chars = 0;
  let truncated = false;
  for (const line of body) {
    const addition = line.length + (included.length > 0 ? 1 : 0);
    if (chars + addition > MAX_SECTION_CHARS) {
      const remainingChars = Math.max(0, MAX_SECTION_CHARS - chars - 2);
      if (remainingChars > 0) included.push(`${line.slice(0, remainingChars)}…`);
      truncated = true;
      break;
    }
    included.push(line);
    chars += addition;
  }
  const startLine = section.startLine + 1 + leading;
  return {
    id: sha256(`${sourcePath}:${startLine}:${title}`).slice('sha256:'.length, 'sha256:'.length + 16),
    title,
    content: included.join('\n'),
    sourcePath,
    startLine,
    endLine: startLine + Math.max(0, included.length - 1),
    truncated,
    sourceContentHash: null,
    freshness: 'stale',
  };
}

function firstMatching(
  sections: MarkdownSection[],
  patterns: RegExp[],
  sourcePath: string,
  title?: string,
): LifecycleSourceSynthesisSection | null {
  const section = sections.find((candidate) => patterns.some((pattern) => pattern.test(candidate.normalizedHeading)));
  return section ? projectedSection(section, sourcePath, title) : null;
}

function artifactPath(artifacts: LifecycleSourceArtifact[], name: string): string | null {
  return artifacts.find((artifact) => artifact.name.toLocaleLowerCase() === name.toLocaleLowerCase())?.relativePath ?? null;
}

function bindSectionSources(
  sections: LifecycleSourceSynthesisSection[],
  artifacts: LifecycleSourceArtifact[],
): LifecycleSourceSynthesisSection[] {
  const hashes = new Map(artifacts.map((artifact) => [artifact.relativePath, artifact.contentHash]));
  return sections.map((section) => {
    const sourceContentHash = hashes.get(section.sourcePath) ?? null;
    return {
      ...section,
      sourceContentHash,
      freshness: sourceContentHash ? 'current' : 'stale',
    };
  });
}

function synthesis(

  lens: LifecycleSourceLens,
  artifacts: LifecycleSourceArtifact[],
  contentByName: Map<string, string>,
  sourcePackageHash: string,
): AvailableLifecycleSourceMaterial['synthesis'] {
  const prd = markdownSections(contentByName.get('prd.md') ?? '');
  const sdd = markdownSections(contentByName.get('sdd.md') ?? '');
  const plan = markdownSections(contentByName.get('plan.md') ?? '');
  const prdPath = artifactPath(artifacts, 'PRD.md') ?? 'PRD.md';
  const sddPath = artifactPath(artifacts, 'SDD.md') ?? 'SDD.md';
  const planPath = artifactPath(artifacts, 'PLAN.md') ?? 'PLAN.md';

  if (lens === 'planning') {
    const selected = [
      firstMatching(prd, [/^intent$/, /^package intent$/, /^what we are building$/, /^problem$/], prdPath, 'Mission and scope'),
      firstMatching(prd, [/^goals/], prdPath, 'Goals'),
      firstMatching(prd, [/^non-goals/], prdPath, 'Non-goals'),
      firstMatching(prd, [/^rorca stories$/, /^selected findings and memories$/], prdPath, 'Delivery workstreams'),
      ...prd.filter((section) => /^phase \d+\b/.test(section.normalizedHeading)).slice(0, 8)
        .map((section) => projectedSection(section, prdPath)),
      firstMatching(prd, [/^selected decisions$/], prdPath, 'Selected decisions'),
      firstMatching(prd, [/^selected assumptions$/], prdPath, 'Selected assumptions'),
      firstMatching(prd, [/^selected risks$/], prdPath, 'Selected risks'),
      firstMatching(prd, [/^selected open questions$/], prdPath, 'Open questions'),
      firstMatching(prd, [/^definition of done/], prdPath, 'Definition of done'),
      firstMatching(plan, [/^pending inputs$/], planPath, 'Pending inputs'),
      firstMatching(plan, [/^unresolved selected evidence$/], planPath, 'Unresolved evidence'),
      firstMatching(plan, [/^included evidence identifiers$/], planPath, 'Included evidence'),
      firstMatching(plan, [/^caveats$/], planPath, 'Source review caveats'),
    ].filter((section): section is LifecycleSourceSynthesisSection => section !== null);
    return {
      title: 'Planning synthesis from the exact export bundle',
      description: 'Mission, boundaries, workstreams, sequencing, and completion criteria are projected from the package PRD and plan. The export remains source material; lifecycle evidence uses only separately verified hashes and bounded references.',
      sections: bindSectionSources(selected, artifacts),
      sourcePackageHash,
    };
  }

  if (lens === 'requirements') {
    const selected = [
      firstMatching(prd, [/^intent$/, /^package intent$/, /^problem$/], prdPath, 'Problem and intent'),
      firstMatching(prd, [/^goals/], prdPath, 'Goals'),
      firstMatching(prd, [/^non-goals/], prdPath, 'Non-goals'),
      firstMatching(prd, [/^functional requirements$/, /^selected findings and memories$/], prdPath, 'Functional requirements'),
      firstMatching(prd, [/^non-functional requirements$/], prdPath, 'Non-functional requirements'),
      firstMatching(prd, [/^selected decisions$/], prdPath, 'Selected decisions'),
      firstMatching(prd, [/^selected assumptions$/], prdPath, 'Selected assumptions'),
      firstMatching(prd, [/^selected risks$/], prdPath, 'Selected risks'),
      firstMatching(prd, [/^success signals$/], prdPath, 'Success signals'),
      firstMatching(prd, [/^acceptance criteria/, /^golden smoke scenario/], prdPath, 'Acceptance criteria'),
      firstMatching(prd, [/^selected open questions$/], prdPath, 'Open questions'),
      firstMatching(prd, [/^out of scope/], prdPath, 'Out of scope'),
    ].filter((section): section is LifecycleSourceSynthesisSection => section !== null);
    return {
      title: 'Requirements synthesis from the exact export bundle',
      description: 'The requirements lens preserves source wording, stable section citations, scope boundaries, success signals, and acceptance criteria from the package PRD.',
      sections: bindSectionSources(selected, artifacts),
      sourcePackageHash,
    };
  }

  const designSelectors: Array<[RegExp[], string]> = [
    [[/^target model$/, /^canonical standalone runtime$/], 'Domain and lifecycle model'],
    [[/^lifecycle state machine$/], 'Lifecycle state machine'],
    [[/^component inventory$/, /^selected technical evidence$/], 'Component inventory'],
    [[/^selected constraints and assumptions$/], 'Design constraints and assumptions'],
    [[/^required ux states/], 'Required UX states'],
    [[/^primary flow acceptance$/], 'Primary interaction flow'],
    [[/^authorization rules$/], 'Authorization boundaries'],
    [[/^rls model$/], 'Data isolation model'],
    [[/^redaction and privacy$/], 'Privacy and redaction'],
    [[/^history transfers$/], 'API contracts'],
    [[/^migration strategy$/], 'Migration strategy'],
    [[/^verification matrix$/], 'Verification design'],
  ];
  const selected = designSelectors.flatMap(([patterns, title]) => {
    const section = firstMatching(sdd, patterns, sddPath, title);
    return section ? [section] : [];
  });
  return {
    title: 'Design synthesis from the exact export bundle',
    description: 'Architecture, data boundaries, API, UI/UX, migration, security, and verification decisions are projected with line-level citations from the package SDD.',
    sections: bindSectionSources(selected, artifacts),
    sourcePackageHash,
  };
}

function packageTitle(contentByName: Map<string, string>, packageId: string): string {
  const prd = contentByName.get('prd.md') ?? '';
  const firstHeading = prd.split(/\r?\n/).find((line) => /^#\s+/.test(line));
  return firstHeading?.replace(/^#\s+/, '').replace(/\s+[—-]\s+PRD\s*$/i, '').trim()
    || packageId.replaceAll('-', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function matchRationale(candidate: PackCandidate): string {
  if (candidate.method === 'explicit_binding') return 'The spec contains this package identity or immutable package hash.';
  if (candidate.method === 'referenced_source_overlap') {
    return `${candidate.referencesMatched.length} spec context source${candidate.referencesMatched.length === 1 ? '' : 's'} also appear in this export manifest.`;
  }
  return `The package and spec share the bounded title terms: ${candidate.titleMatches.join(', ')}.`;
}

export async function projectLifecycleSourceMaterial(input: SourceProjectionInput): Promise<LifecycleSourceMaterial> {
  const loaded = await loadCandidates(input);
  if (loaded.candidates.length === 0) {
    return {
      state: loaded.invalidCount > 0 ? 'invalid' : 'not_found',
      schemaVersion: 'rorca.lifecycle-source-material.v1',
      lens: input.lens,
      rationale: loaded.invalidCount > 0
        ? 'Genesis export packages were found, but their bounded manifests or declared artifacts were invalid.'
        : 'No Genesis export package is available in this workspace.',
    };
  }

  loaded.candidates.sort((left, right) => right.score - left.score || left.manifest.packageId.localeCompare(right.manifest.packageId));
  const selected = loaded.candidates[0];
  const tied = loaded.candidates.filter((candidate) => candidate.score === selected.score);
  if (tied.length > 1 && selected.score > 0) {
    return {
      state: 'ambiguous',
      schemaVersion: 'rorca.lifecycle-source-material.v1',
      lens: input.lens,
      rationale: `${tied.length} export packages match this spec equally. Bind one package identity before treating it as lifecycle source material.`,
    };
  }
  if (selected.score === 0) {
    return {
      state: loaded.candidates.length > 1 ? 'ambiguous' : 'not_found',
      schemaVersion: 'rorca.lifecycle-source-material.v1',
      lens: input.lens,
      rationale: loaded.candidates.length > 1
        ? 'Multiple export packages are available, but the spec has no explicit package identity, source overlap, or strong bounded title match.'
        : 'The available export package is not explicitly bound to this spec and has no source overlap or strong bounded title match.',
    };
  }

  const workspaceRoot = await fsp.realpath(input.workspacePath);
  const loadedArtifacts = await loadArtifacts(workspaceRoot, selected);
  const authority = await verifySourceAuthority({
    workspaceRoot,
    candidate: selected,
    specId: input.specId,
    loadedArtifacts: loadedArtifacts.artifacts,
    workspaceId: input.workspaceId,
    releaseSubject: input.releaseSubject,
  });
  const manifestValue = selected.manifest;
  const warnings = boundedStrings(manifestValue.warnings);
  const contradictions = boundedStrings(manifestValue.contradictions);
  const uncertainties = boundedStrings(manifestValue.uncertainties);
  return {
    state: 'available',
    schemaVersion: 'rorca.lifecycle-source-material.v1',
    lens: input.lens,
    package: {
      packageId: selected.manifest.packageId,
      title: packageTitle(loadedArtifacts.contentByName, selected.manifest.packageId),
      workspaceId: typeof manifestValue.workspaceId === 'string' ? manifestValue.workspaceId : null,
      status: boundedText(manifestValue.status, 'unknown', 64),
      publicationStatus: boundedText(manifestValue.publicationStatus, 'unknown', 64),
      authoritative: manifestValue.authoritative === true,
      scope: typeof manifestValue.scope === 'string' ? manifestValue.scope.slice(0, 256) : null,
      contentHash: selected.manifest.contentHash,
      previewHash: selected.manifest.previewHash,
      snapshotHash: selected.manifest.snapshotHash,
    },
    authority,
    match: {
      method: selected.method,
      confidence: selected.confidence,
      referencesMatched: selected.referencesMatched,
      rationale: matchRationale(selected),
    },
    inventory: {
      evidenceCount: countArray(manifestValue.evidence),
      excludedCount: countArray(manifestValue.excluded),
      warningCount: countArray(manifestValue.warnings),
      contradictionCount: countArray(manifestValue.contradictions),
      uncertaintyCount: countArray(manifestValue.uncertainties),
      warnings,
      contradictions,
      uncertainties,
    },
    artifacts: loadedArtifacts.artifacts,
    synthesis: synthesis(input.lens, loadedArtifacts.artifacts, loadedArtifacts.contentByName, selected.manifest.contentHash),
  };
}

export function lifecycleSourceLens(phaseId: string): LifecycleSourceLens | null {
  if (phaseId === 'planning') return 'planning';
  if (phaseId === 'requirements') return 'requirements';
  if (phaseId === 'design') return 'design';
  return null;
}

export interface EditorLaunch {
  command: string;
  args: string[];
  editor: string;
}

function gotoTarget(absolutePath: string, line?: number | null, column?: number | null): string {
  if (!line) return absolutePath;
  return `${absolutePath}:${line}:${column ?? 1}`;
}

export function resolveEditorLaunch(
  absolutePath: string,
  action: LifecycleSourceArtifactAction,
  line?: number | null,
  column?: number | null,
): EditorLaunch {
  if (process.platform === 'darwin' && action === 'reveal') {
    return { command: '/usr/bin/open', args: ['-R', absolutePath], editor: 'Finder' };
  }

  const configured = String(process.env.RORCA_EDITOR_BIN ?? '').trim();
  if (configured && !/[\0\r\n]/.test(configured)) {
    const executable = path.basename(configured).toLocaleLowerCase();
    const args = /^(code|cursor)(?:\.exe)?$/.test(executable)
      ? ['--goto', gotoTarget(absolutePath, line, column)]
      : [absolutePath];
    return { command: configured, args, editor: path.basename(configured) };
  }

  if (process.platform === 'darwin') {
    const cliCandidates: Array<[string, string, (target: string) => string[]]> = [
      ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', 'Visual Studio Code', (target) => ['--goto', target]],
      ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor', 'Cursor', (target) => ['--goto', target]],
      ['/Applications/Zed.app/Contents/MacOS/cli', 'Zed', (target) => [target]],
    ];
    for (const [command, editor, args] of cliCandidates) {
      if (fs.existsSync(command)) return { command, args: args(gotoTarget(absolutePath, line, column)), editor };
    }
    const appCandidates: Array<[string, string]> = [
      ['/Applications/Visual Studio Code.app', 'Visual Studio Code'],
      ['/Applications/Cursor.app', 'Cursor'],
      ['/Applications/Zed.app', 'Zed'],
      ['/Applications/WebStorm.app', 'WebStorm'],
      ['/Applications/IntelliJ IDEA.app', 'IntelliJ IDEA'],
    ];
    const detected = appCandidates.find(([application]) => fs.existsSync(application));
    if (detected) return { command: '/usr/bin/open', args: ['-a', detected[1], absolutePath], editor: detected[1] };
    return { command: '/usr/bin/open', args: [absolutePath], editor: 'default application' };
  }

  const editor = String(process.env.VISUAL ?? process.env.EDITOR ?? '').trim();
  if (editor && !/[\s\0\r\n]/.test(editor)) return { command: editor, args: [absolutePath], editor: path.basename(editor) };
  return action === 'reveal'
    ? { command: 'xdg-open', args: [path.dirname(absolutePath)], editor: 'file manager' }
    : { command: 'xdg-open', args: [absolutePath], editor: 'default application' };
}
async function realpathSource(
  candidate: string,
  resource: string,
  id: string,
  field: string,
): Promise<string> {
  try {
    return await fsp.realpath(candidate);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new NotFoundError(resource, id);
    throw new ValidationError(`The requested ${resource.toLocaleLowerCase()} cannot be resolved`, { field });
  }
}


async function resolveLifecycleSourceArtifact(input: {
  workspacePath: string;
  artifacts: LifecycleSourceArtifact[];
  relativePath: string;
}): Promise<{
  artifact: LifecycleSourceArtifact;
  absolutePath: string;
  stat: fs.Stats;
}> {
  const artifact = input.artifacts.find((candidate) => candidate.relativePath === input.relativePath);
  if (!artifact) throw new ValidationError('The requested path is not part of the projected export package', { field: 'relativePath' });
  const workspaceRoot = await realpathSource(input.workspacePath, 'Workspace directory', input.workspacePath, 'workspacePath');
  const absolutePath = await realpathSource(
    path.resolve(workspaceRoot, artifact.relativePath),
    'Lifecycle source artifact',
    artifact.relativePath,
    'relativePath',
  );
  const exportRoot = path.resolve(workspaceRoot, EXPORT_ROOT);
  if (!inside(workspaceRoot, absolutePath) || !inside(exportRoot, absolutePath)) {
    throw new ValidationError('The requested export artifact resolves outside the workspace export root', { field: 'relativePath' });
  }
  const stat = await fsp.stat(absolutePath);
  if (!stat.isFile()) throw new ValidationError('The requested export artifact is not a file', { field: 'relativePath' });
  if (stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) {
    throw new ValidationError('The requested export artifact exceeds the bounded preview size', { field: 'relativePath' });
  }
  return { artifact, absolutePath, stat };
}

export async function openLifecycleSourceArtifact(input: {
  workspacePath: string;
  artifacts: LifecycleSourceArtifact[];
  relativePath: string;
  action: LifecycleSourceArtifactAction;
  line?: number | null;
  column?: number | null;
}, launch: (request: EditorLaunch) => Promise<void> = async (request) => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(request.command, request.args, { detached: true, stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}): Promise<{
  opened: true;
  action: LifecycleSourceArtifactAction;
  relativePath: string;
  editor: string;
  line: number | null;
  column: number | null;
}> {
  const { artifact, absolutePath } = await resolveLifecycleSourceArtifact(input);
  if (!['open', 'reveal'].includes(input.action)) throw new ValidationError('action must be open or reveal', { field: 'action' });
  const line = input.line == null ? null : Number(input.line);
  const column = input.column == null ? null : Number(input.column);
  if (line !== null && (!Number.isSafeInteger(line) || line < 1 || line > 10_000_000)) {
    throw new ValidationError('line must be a positive bounded integer', { field: 'line' });
  }
  if (column !== null && (!Number.isSafeInteger(column) || column < 1 || column > 1_000_000)) {
    throw new ValidationError('column must be a positive bounded integer', { field: 'column' });
  }

  const request = resolveEditorLaunch(absolutePath, input.action, line, column);
  await launch(request);
  return {
    opened: true,
    action: input.action,
    relativePath: artifact.relativePath,
    editor: request.editor,
    line,
    column,
  };
}

function previewContentType(name: string): LifecycleSourceArtifactPreview['contentType'] {
  const extension = path.extname(name).toLocaleLowerCase();
  if (extension === '.md' || extension === '.markdown') return 'markdown';
  if (extension === '.json') return 'json';
  if (extension === '.html' || extension === '.htm') return 'html';
  return 'text';
}

export async function readLifecycleSourceArtifact(input: {
  workspacePath: string;
  artifacts: LifecycleSourceArtifact[];
  relativePath: string;
  startLine?: number | null;
  endLine?: number | null;
}): Promise<LifecycleSourceArtifactPreview> {
  const { artifact, absolutePath, stat } = await resolveLifecycleSourceArtifact(input);
  const requestedStart = input.startLine == null ? 1 : Number(input.startLine);
  const requestedEnd = input.endLine == null ? null : Number(input.endLine);
  if (!Number.isSafeInteger(requestedStart) || requestedStart < 1 || requestedStart > 10_000_000) {
    throw new ValidationError('startLine must be a positive bounded integer', { field: 'startLine' });
  }
  if (requestedEnd !== null && (!Number.isSafeInteger(requestedEnd) || requestedEnd < requestedStart || requestedEnd > 10_000_000)) {
    throw new ValidationError('endLine must be a bounded integer at or after startLine', { field: 'endLine' });
  }

  const bytes = await fsp.readFile(absolutePath);
  const actualContentHash = sha256(bytes);
  if (actualContentHash !== artifact.contentHash) {
    throw new ConflictError('Lifecycle source artifact changed after its bounded projection', {
      reasonCode: 'LIFECYCLE_SOURCE_ARTIFACT_HASH_MISMATCH',
      relativePath: artifact.relativePath,
      projectedContentHash: artifact.contentHash,
      actualContentHash,
    });
  }
  const decoded = bytes.toString('utf8').replaceAll('\r\n', '\n');
  if (decoded.includes('\0')) throw new ValidationError('Binary export artifacts cannot be previewed', { field: 'relativePath' });
  const lines = decoded.split('\n');
  const totalLines = lines.length;
  if (requestedStart > totalLines) {
    throw new ValidationError('startLine is beyond the end of the artifact', { field: 'startLine' });
  }

  const boundedEnd = Math.min(totalLines, requestedEnd ?? totalLines, requestedStart + MAX_PREVIEW_LINES - 1);
  const included: string[] = [];
  let includedBytes = 0;
  for (const line of lines.slice(requestedStart - 1, boundedEnd)) {
    const addition = Buffer.byteLength(line, 'utf8') + (included.length > 0 ? 1 : 0);
    if (includedBytes + addition > MAX_PREVIEW_BYTES) break;
    included.push(line);
    includedBytes += addition;
  }
  const endLine = requestedStart + Math.max(0, included.length - 1);
  return {
    relativePath: artifact.relativePath,
    name: artifact.name,
    role: artifact.role,
    content: included.join('\n'),
    contentType: previewContentType(artifact.name),
    startLine: requestedStart,
    endLine,
    totalLines,
    truncated: requestedStart > 1 || endLine < totalLines,
    projectedContentHash: artifact.contentHash,
    actualContentHash,
    stale: false,
    modifiedAt: stat.mtime.toISOString(),
  };
}
