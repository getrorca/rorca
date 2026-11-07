/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GenesisPublicationAuthoritySchema } from '../../lib/source-adapters/genesis';
import type {
  GenesisAuthorityBridge,
  GenesisPublicationAuthority,
} from '../../lib/source-adapters/genesis';
import { EvidenceRecordSchema, type EvidenceRecord } from './source-authority';

const genesisSourceId = z.string().trim().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a canonical Genesis id');
const reviewStatus = z.enum(['approved', 'trusted', 'pending', 'unreviewed']);
const sensitivity = z.enum(['public', 'internal', 'confidential', 'restricted']);
const sensitivityRank: Record<z.infer<typeof sensitivity>, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};
const canonicalStore = z.enum([
  'pglite+genesis-vault',
  'pglite+pgvector+genesis-vault',
  'pglite+vault',
  'genesis-pglite-and-local-vault',
]);

export type GenesisSensitivity = z.infer<typeof sensitivity>;
export type GenesisReviewStatus = z.infer<typeof reviewStatus>;
export type GenesisCanonicalStore = z.infer<typeof canonicalStore>;

/** One evidence chunk of a Genesis package. Content lives in the bridge vault. */
export interface GenesisPackageChunkInput {
  /** Stable bridge chunk id, referenced by evidenceChunkIds and citations. */
  readonly chunkId: string;
  readonly evidence: EvidenceRecord;
  readonly sensitivity: GenesisSensitivity;
  /** Vault content — emitted only when the requesting principal is cleared for it. */
  readonly content: string;
}

/**
 * Production bridge package definition. Review state, sensitivity, and access
 * are bridge-owned: the adapter never grants or overrides them locally.
 */
export interface GenesisPackageDefinitionInput {
  readonly id: string;
  readonly title: string;
  readonly sourceVersion: string;
  readonly reviewStatus: GenesisReviewStatus;
  readonly sensitivity: GenesisSensitivity;
  readonly canonicalStore: GenesisCanonicalStore;
  readonly citationSummary: string;
  readonly warningCount: number;
  readonly skippedEvidenceCount: number;
  readonly freshnessTs: string;
  readonly bridgeVersion: string;
  readonly chunks: readonly GenesisPackageChunkInput[];
  readonly publicationAuthority?: GenesisPublicationAuthority;
}

export interface GenesisAuthorityBridgeOptions {
  readonly packages?: readonly GenesisPackageDefinitionInput[];
  /** Highest sensitivity a principal may read; undefined denies every chunk. */
  readonly principalClearance?: (principalId: string) => GenesisSensitivity | undefined;
}
export interface GenesisPackageRegistrationOptions {
  /**
   * Bridge-owned access policy for this registered package. Request payloads
   * may name a principal, but cannot supply the resulting clearance.
   */
  readonly principalClearance?: (principalId: string) => GenesisSensitivity | undefined;
}

/** Immutable validated package stored by the bridge authority. */
export interface FrozenGenesisPackage {
  readonly id: string;
  readonly title: string;
  readonly sourceVersion: string;
  readonly reviewStatus: GenesisReviewStatus;
  readonly sensitivity: GenesisSensitivity;
  readonly canonicalStore: GenesisCanonicalStore;
  readonly citationSummary: string;
  readonly warningCount: number;
  readonly skippedEvidenceCount: number;
  readonly freshnessTs: string;
  readonly bridgeVersion: string;
  readonly chunks: readonly FrozenGenesisPackageChunk[];
  readonly packageHash: `sha256:${string}`;
  readonly contentHash: `sha256:${string}`;
  readonly publicationAuthority?: GenesisPublicationAuthority;
}

export interface FrozenGenesisPackageChunk {
  readonly chunkId: string;
  readonly evidence: EvidenceRecord;
  readonly sensitivity: GenesisSensitivity;
  readonly content: string;
}

const chunkSchema = z.object({
  chunkId: z.string().trim().min(1).max(500),
  evidence: EvidenceRecordSchema,
  sensitivity,
  content: z.string().min(1).max(1_000_000),
}).strict();

const definitionSchema = z.object({
  id: genesisSourceId,
  title: z.string().min(1).max(500),
  sourceVersion: z.string().min(1).max(256),
  reviewStatus,
  sensitivity,
  canonicalStore,
  citationSummary: z.string().min(1).max(512),
  warningCount: z.number().int().nonnegative(),
  skippedEvidenceCount: z.number().int().nonnegative(),
  freshnessTs: z.string().datetime({ offset: true }),
  bridgeVersion: z.string().min(1).max(64),
  chunks: z.array(chunkSchema).min(1).max(500),
  publicationAuthority: GenesisPublicationAuthoritySchema.optional(),
}).strict();

function digest(content: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
}

function freezePackage(pkg: z.output<typeof definitionSchema>): FrozenGenesisPackage {
  const contentHash = digest(pkg.chunks.map((chunk) => chunk.content).join('\n\n'));
  const packageHash = digest(JSON.stringify({
    packageId: pkg.id,
    title: pkg.title,
    sourceVersion: pkg.sourceVersion,
    chunkIds: pkg.chunks.map((chunk) => chunk.chunkId),
    contentHash,
  }));
  return deepFreeze({ ...pkg, packageHash, contentHash });
}

function parsePackages(definitions: readonly GenesisPackageDefinitionInput[]): FrozenGenesisPackage[] {
  const parsed = definitions.map((definition) => definitionSchema.parse(definition));
  if (new Set(parsed.map((pkg) => pkg.id)).size !== parsed.length) {
    throw new Error('Genesis package definitions must have unique ids');
  }
  for (const pkg of parsed) {
    if (new Set(pkg.chunks.map((chunk) => chunk.chunkId)).size !== pkg.chunks.length) {
      throw new Error(`Genesis package '${pkg.id}' has duplicate chunk ids`);
    }
    for (const chunk of pkg.chunks) {
      if (sensitivityRank[chunk.sensitivity] > sensitivityRank[pkg.sensitivity]) {
        throw new Error(`Genesis package '${pkg.id}' understates chunk '${chunk.chunkId}' sensitivity`);
      }
    }
  }
  return parsed.map(freezePackage);
}

interface RegisteredGenesisPackage {
  readonly pkg: FrozenGenesisPackage;
  readonly principalClearance: GenesisPackageRegistrationOptions['principalClearance'] | undefined;
}

const productionPackages = new Map<string, RegisteredGenesisPackage>();

/**
 * Register a package with the production bridge authority. This is the only
 * production registration seam: the bridge never accepts review/access state
 * from resolvers, and unregistered packages are not resolvable.
 */
export function registerGenesisPackage(
  definition: GenesisPackageDefinitionInput,
  options: GenesisPackageRegistrationOptions = {},
): () => void {
  const [pkg] = parsePackages([definition]);
  if (productionPackages.has(pkg.id)) {
    throw new Error(`Genesis package '${pkg.id}' is already registered`);
  }
  productionPackages.set(pkg.id, { pkg, principalClearance: options.principalClearance });
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    productionPackages.delete(pkg.id);
  };
}

/**
 * Production GenesisAuthorityBridge: resolves a principal-aware immutable
 * `genesis_package` projection from registered bridge packages. Chunk content
 * is emitted only for principals cleared for the chunk's sensitivity;
 * everything else leaves the bridge as an access-denied projection with no
 * content, so restricted text can never reach the adapter or its consumers.
 */
export function createGenesisAuthorityBridge(
  options: GenesisAuthorityBridgeOptions = {},
): GenesisAuthorityBridge {
  const provided = parsePackages(options.packages ?? []).map((pkg) => ({
    pkg,
    principalClearance: options.principalClearance,
  }));
  const packages = new Map(provided.map((registered) => [registered.pkg.id, registered]));
  for (const id of packages.keys()) {
    if (productionPackages.has(id)) {
      throw new Error('Genesis package definitions must have unique ids');
    }
  }

  const resolveSource: GenesisAuthorityBridge['resolveSource'] = async ({ kind, id, principalId, selectedChunkIds }) => {
    // The production bridge resolves canonical packages only; a bare evidence
    // request is not a resolvable source here.
    if (kind !== 'genesis_package') return undefined;
    // Routes retain this bridge across registration and revocation. Resolve the
    // authority's current entry rather than caching access to revoked content.
    const providedPackage = packages.get(id);
    const productionPackage = productionPackages.get(id);
    if (providedPackage && productionPackage) {
      throw new Error(`Genesis package '${id}' has conflicting authority definitions`);
    }
    const registered = productionPackage ?? providedPackage;
    if (!registered) return undefined;
    const { pkg } = registered;
    const clearance = (registered.principalClearance ?? options.principalClearance)?.(principalId);
    const clearanceRank = clearance === undefined ? -1 : sensitivityRank[clearance];
    const selected = selectedChunkIds ? new Set(selectedChunkIds) : null;
    const chunks = pkg.chunks.filter((chunk) => !selected || selected.has(chunk.chunkId)).map((chunk) => {
      const denied = sensitivityRank[chunk.sensitivity] > clearanceRank;
      return Object.freeze({
        chunkId: chunk.chunkId,
        evidence: chunk.evidence,
        bridgeProvenance: Object.freeze({
          source: 'genesis-bridge',
          reviewStatus: pkg.reviewStatus,
          access: denied ? 'denied' : 'allowed',
        }),
        sensitivity: chunk.sensitivity,
        content: denied ? null : chunk.content,
      });
    });
    return Object.freeze({
      kind: 'genesis_package',
      id: pkg.id,
      title: pkg.title,
      sourceVersion: pkg.sourceVersion,
      reviewStatus: pkg.reviewStatus,
      sensitivity: pkg.sensitivity,
      chunks: Object.freeze(chunks),
      provenance: Object.freeze({
        packageId: pkg.id,
        packageHash: pkg.packageHash,
        contentHash: pkg.contentHash,
        canonicalStore: pkg.canonicalStore,
        citationSummary: pkg.citationSummary,
        warningCount: pkg.warningCount,
        skippedEvidenceCount: pkg.skippedEvidenceCount,
        freshnessTs: pkg.freshnessTs,
        bridgeVersion: pkg.bridgeVersion,
        ...(pkg.publicationAuthority ? { publicationAuthority: pkg.publicationAuthority } : {}),
      }),
    });
  };

  return Object.freeze({ resolveSource });
}
