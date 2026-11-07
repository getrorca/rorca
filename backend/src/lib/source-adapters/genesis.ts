/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ValidationError } from '../errors';
import { BridgeProvenanceSchema, EvidenceRecordSchema } from '../../ssdlc/genesis/source-authority';
import {
  SOURCE_CONTRACT_VERSIONS,
  SourceCitationV1Schema,
  SourceRefV1Schema,
  type SourceCitationV1,
  type SourceRefV1,
} from '../source-contracts';

const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/, 'must be a sha256 hash');
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

export const GenesisPublicationAuthoritySchema = z.object({
  workspaceId: z.string().trim().min(1).max(256),
  specSlug: z.string().trim().min(1).max(256),
  releaseSubjectHash: sha256,
  packageId: genesisSourceId,
  packagePath: z.string().regex(/^genesis\/artifacts\/export-packs\/[A-Za-z0-9][A-Za-z0-9._-]*$/),
  receiptId: z.string().regex(/^package-event:sha256:[a-f0-9]{64}$/),
  receiptHash: sha256,
  eventHash: sha256,
  manifestHash: sha256,
  packageHash: sha256,
  previewHash: sha256,
  snapshotHash: sha256,
}).strict().refine(
  (value) => value.receiptId === `package-event:${value.eventHash}`,
  { message: 'receiptId must bind the exact publication event hash' },
);
export type GenesisPublicationAuthority = z.infer<typeof GenesisPublicationAuthoritySchema>;

/** Shared shape persisted by explicit-draft context and emitted by this adapter. */
export const GenesisProvenanceSchema = z.object({
  packageId: z.string().min(1).max(128),
  packageHash: sha256,
  contentHash: sha256,
  canonicalStore,
  citationSummary: z.string().min(1).max(512),
  warningCount: z.number().int().nonnegative(),
  skippedEvidenceCount: z.number().int().nonnegative(),
  freshnessTs: z.string().datetime({ offset: true }),
  bridgeVersion: z.string().min(1).max(64),
  publicationAuthority: GenesisPublicationAuthoritySchema.optional(),
}).passthrough();
export type GenesisProvenance = z.infer<typeof GenesisProvenanceSchema>;

const GenesisEvidenceProvenanceSchema = EvidenceRecordSchema.extend({
  bridgeProvenance: BridgeProvenanceSchema,
}).strict();
const ResolvedGenesisProvenanceSchema = GenesisProvenanceSchema.extend({
  reviewStatus,
  sensitivity,
  evidenceChunkIds: z.array(z.string().min(1).max(500)).max(500),
  citations: z.array(z.object({
    chunkId: z.string().min(1).max(500),
    citation: z.string().min(1),
  }).strict()).max(500),
  evidenceProvenance: z.array(GenesisEvidenceProvenanceSchema).max(500),
}).passthrough();
type ResolvedGenesisProvenance = z.infer<typeof ResolvedGenesisProvenanceSchema>;

const allowedChunk = z.object({
  chunkId: z.string().min(1).max(500),
  evidence: EvidenceRecordSchema,
  bridgeProvenance: BridgeProvenanceSchema.extend({ access: z.literal('allowed') }).strict(),
  sensitivity,
  content: z.string().min(1).max(1_000_000),
}).strict();
const redactedChunk = z.object({
  chunkId: z.string().min(1).max(500),
  evidence: EvidenceRecordSchema,
  bridgeProvenance: BridgeProvenanceSchema.extend({ access: z.literal('denied') }).strict(),
  sensitivity,
  content: z.null(),
}).strict();
const GenesisBridgeChunkSchema = z.union([allowedChunk, redactedChunk]);

/**
 * Immutable authority projection returned by the Genesis bridge for a principal.
 * Review state, sensitivity, and access are deliberately bridge-owned fields.
 */
export const GenesisBridgeProjectionSchema = z.object({
  kind: z.enum(['genesis_package', 'genesis_evidence']),
  id: genesisSourceId,
  title: z.string().min(1).max(500),
  sourceVersion: z.string().min(1).max(256),
  reviewStatus,
  sensitivity,
  chunks: z.array(GenesisBridgeChunkSchema).min(1).max(500),
  provenance: GenesisProvenanceSchema,
}).strict();
export type GenesisBridgeProjection = z.infer<typeof GenesisBridgeProjectionSchema>;

export interface GenesisAuthorityBridge {
  /** Read-only principal-aware projection. The adapter has no mutation/approval API. */
  resolveSource(input: Readonly<{
    kind: 'genesis_package' | 'genesis_evidence';
    id: string;
    principalId: string;
    selectedChunkIds?: readonly string[];
  }>): Promise<unknown>;
}

const GenesisSourceRequestSchema = z.object({
  kind: z.enum(['genesis_package', 'genesis_evidence']),
  id: genesisSourceId,
  principalId: z.string().trim().min(1).max(256),
  selectedChunkIds: z.array(z.string().min(1).max(500)).max(500).optional(),
}).strict();
export type GenesisSourceRequest = z.input<typeof GenesisSourceRequestSchema>;

export interface GenesisSourceSection {
  readonly chunkId: string;
  readonly citation: string;
  readonly content: string;
  readonly redacted: boolean;
  readonly citationRef: SourceCitationV1;
}

export interface ResolvedGenesisSource {
  readonly sourceRef: SourceRefV1;
  readonly sections: readonly GenesisSourceSection[];
  readonly citations: readonly SourceCitationV1[];
  readonly compiledText: string;
  readonly genesis: ResolvedGenesisProvenance;
}

export const GENESIS_REDACTION_MARKER = '[REDACTED: Genesis sensitivity authority required]';

function digest(content: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function validationFailure(message: string, error?: z.ZodError): ValidationError {
  return new ValidationError(message, error ? {
    issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
  } : undefined);
}

function parseRequest(input: GenesisSourceRequest): z.output<typeof GenesisSourceRequestSchema> {
  const parsed = GenesisSourceRequestSchema.safeParse(input);
  if (!parsed.success) throw validationFailure('Invalid Genesis source request', parsed.error);
  if (parsed.data.selectedChunkIds && new Set(parsed.data.selectedChunkIds).size !== parsed.data.selectedChunkIds.length) {
    throw validationFailure('selectedChunkIds must be unique');
  }
  return parsed.data;
}

/**
 * Resolve canonical Genesis context without granting any local review or sensitivity authority.
 * Restricted text is never accepted from the bridge when access is redacted, so it cannot leak
 * into the returned sections or compiled bundle.
 */
export async function resolveGenesisSource(
  input: GenesisSourceRequest,
  bridge: GenesisAuthorityBridge,
): Promise<ResolvedGenesisSource> {
  const request = parseRequest(input);
  const rawProjection = await bridge.resolveSource({
    kind: request.kind,
    id: request.id,
    principalId: request.principalId,
    ...(request.selectedChunkIds ? { selectedChunkIds: request.selectedChunkIds } : {}),
  });
  if (rawProjection === undefined || rawProjection === null) {
    throw new ValidationError(`Genesis ${request.kind === 'genesis_package' ? 'package' : 'evidence'} '${request.id}' was not found`);
  }

  const parsedProjection = GenesisBridgeProjectionSchema.safeParse(rawProjection);
  if (!parsedProjection.success) throw validationFailure('Genesis bridge returned an invalid authority projection', parsedProjection.error);
  const projection = parsedProjection.data;
  if (projection.kind !== request.kind || projection.id !== request.id) {
    throw validationFailure('Genesis bridge projection identity does not match the requested source');
  }
  if (projection.provenance.packageId !== projection.id && projection.kind === 'genesis_package') {
    throw validationFailure('Genesis package provenance identity does not match the requested package');
  }
  if (projection.chunks.some((chunk) => sensitivityRank[chunk.sensitivity] > sensitivityRank[projection.sensitivity])) {
    throw validationFailure('Genesis bridge projection sensitivity understates its evidence sensitivity');
  }
  if ((projection.reviewStatus === 'approved' || projection.reviewStatus === 'trusted')
      && projection.chunks.some(({ bridgeProvenance }) => (
        bridgeProvenance.reviewStatus === 'pending'
        || bridgeProvenance.reviewStatus === 'unreviewed'
        || bridgeProvenance.reviewStatus === 'external'
      ))) {
    throw validationFailure('Genesis bridge cannot project pending or unreviewed evidence as approved context');
  }

  const byId = new Map(projection.chunks.map((chunk) => [chunk.chunkId, chunk]));
  if (byId.size !== projection.chunks.length) throw validationFailure('Genesis bridge returned duplicate evidence chunk ids');
  const selectedIds = request.selectedChunkIds ?? projection.chunks.map((chunk) => chunk.chunkId);
  const selected = selectedIds.map((chunkId) => {
    const chunk = byId.get(chunkId);
    if (!chunk) throw validationFailure(`Genesis evidence chunk '${chunkId}' was not found in the bridge projection`);
    return chunk;
  });

  const sourceId = `genesis-${projection.kind === 'genesis_package' ? 'package' : 'evidence'}-${projection.id}`;
  const sections = selected.map((chunk, index): GenesisSourceSection => {
    const redacted = chunk.bridgeProvenance.access === 'denied';
    const content = redacted ? `${GENESIS_REDACTION_MARKER} (${chunk.chunkId})` : chunk.content;
    if (content === null) throw validationFailure('Genesis bridge allowed a chunk without evidence content');
    const citationRef = SourceCitationV1Schema.parse({
      schemaVersion: SOURCE_CONTRACT_VERSIONS.sourceCitation,
      citationId: `${sourceId}-citation-${index + 1}`,
      sourceId,
      section: chunk.chunkId,
      excerptHash: digest(content),
      rationale: `${redacted ? 'Redacted ' : ''}Genesis evidence ${chunk.evidence.genesisEvidenceId}: ${chunk.evidence.exactCitation}`,
    });
    return Object.freeze({ chunkId: chunk.chunkId, citation: chunk.evidence.exactCitation, content, redacted, citationRef });
  });
  const compiledText = sections.map((section) => section.content).join('\n\n');
  const contentHash = digest(compiledText);

  // For a complete, unredacted package the bridge's canonical content hash must match
  // exact compiled bytes. Redacted/subset projections retain bridge hashes as provenance.
  if (request.selectedChunkIds === undefined
      && selected.length === projection.chunks.length
      && sections.every((section) => !section.redacted)
      && projection.provenance.contentHash !== contentHash) {
    throw validationFailure('Genesis bridge content hash does not match canonical evidence bytes');
  }

  if (projection.kind === 'genesis_evidence' && selected.some(
    (chunk) => chunk.bridgeProvenance.reviewStatus !== projection.reviewStatus,
  )) {
    throw validationFailure('Genesis evidence review status does not match its bridge provenance');
  }

  const sourceRef = SourceRefV1Schema.parse({
    schemaVersion: SOURCE_CONTRACT_VERSIONS.sourceRef,
    sourceId,
    kind: projection.kind,
    locator: `genesis/${projection.kind === 'genesis_package' ? 'packages' : 'evidence'}/${projection.id}`,
    title: projection.title,
    contentHash,
    sourceVersion: projection.sourceVersion,
    reviewStatus: projection.reviewStatus,
    sensitivity: projection.sensitivity,
    authority: projection.reviewStatus === 'approved' || projection.reviewStatus === 'trusted'
      ? 'approved_context'
      : 'supporting_evidence',
    selectedSections: selectedIds,
  });
  const genesis = ResolvedGenesisProvenanceSchema.parse({
    ...projection.provenance,
    reviewStatus: projection.reviewStatus,
    sensitivity: projection.sensitivity,
    evidenceChunkIds: selectedIds,
    citations: sections.map((section) => ({ chunkId: section.chunkId, citation: section.citation })),
    evidenceProvenance: selected.map((chunk) => ({
      ...chunk.evidence,
      bridgeProvenance: chunk.bridgeProvenance,
    })),
  });

  return Object.freeze({
    sourceRef,
    sections: Object.freeze(sections),
    citations: Object.freeze(sections.map((section) => section.citationRef)),
    compiledText,
    genesis: Object.freeze(genesis),
  });
}
