/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { z } from 'zod';
import type { ControlRecord, ValidationError } from '../schema/control-schema';

const nonEmpty = z.string().trim().min(1);
const genesisId = nonEmpty.regex(/^GEN-[A-Za-z0-9][A-Za-z0-9._-]*$/, 'must be a Genesis evidence id');

export const EvidenceRecordSchema = z.object({
  genesisEvidenceId: genesisId,
  sourceTitle: nonEmpty,
  exactCitation: nonEmpty,
  evidenceStrength: z.enum(['primary', 'secondary', 'derived']),
  supersedes: z.array(genesisId).min(1).optional(),
  supersededBy: genesisId.optional(),
  contradictionGroup: nonEmpty.optional(),
}).strict();

export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const BridgeProvenanceSchema = z.object({
  source: z.literal('genesis-bridge'),
  reviewStatus: z.enum(['approved', 'trusted', 'pending', 'unreviewed', 'external']),
  access: z.enum(['allowed', 'denied']),
}).strict();

export type BridgeProvenance = z.infer<typeof BridgeProvenanceSchema>;
type GenesisBridgeFixture = {
  evidence: EvidenceRecord;
  bridgeProvenance: BridgeProvenance;
};
type ProjectedEvidence = EvidenceRecord & { bridgeProvenance: BridgeProvenance };
type Contradiction = {
  contradictionGroup: string;
  genesisEvidenceIds: string[];
};

const GenesisBridgeFixtureSchema: z.ZodType<GenesisBridgeFixture> = z.object({
  evidence: EvidenceRecordSchema,
  bridgeProvenance: BridgeProvenanceSchema,
}).strict();

const evidenceById = new Map<string, ProjectedEvidence>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
}

function accessibleEvidence(genesisEvidenceId: string): ProjectedEvidence | undefined {
  const evidence = evidenceById.get(genesisEvidenceId);
  return evidence?.bridgeProvenance.access === 'allowed' ? evidence : undefined;
}

/** Return the immutable local projection when the Genesis bridge grants access. */
export function getEvidence(genesisEvidenceId: string): ProjectedEvidence | undefined {
  return accessibleEvidence(genesisEvidenceId);
}

/** Follow Genesis-declared supersession links to the currently authoritative record. */
export function resolveAuthority(genesisEvidenceId: string): ProjectedEvidence | undefined {
  let current = accessibleEvidence(genesisEvidenceId);
  const visited = new Set<string>();

  while (current?.supersededBy) {
    if (visited.has(current.genesisEvidenceId)) return undefined;
    visited.add(current.genesisEvidenceId);
    current = accessibleEvidence(current.supersededBy);
  }
  return current;
}

/** Group explicit Genesis contradiction markers; singleton markers are not conflicts. */
export function detectContradictions(): Contradiction[] {
  const groups = new Map<string, string[]>();
  for (const evidence of evidenceById.values()) {
    if (evidence.bridgeProvenance.access !== 'allowed' || !evidence.contradictionGroup) continue;
    const ids = groups.get(evidence.contradictionGroup) ?? [];
    ids.push(evidence.genesisEvidenceId);
    groups.set(evidence.contradictionGroup, ids);
  }

  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([contradictionGroup, ids]) => deepFreeze({
      contradictionGroup,
      genesisEvidenceIds: ids.sort(),
    }));
}

/** Validate that every US-001 source reference resolves through the Genesis bridge. */
export function validateControlAgainstGenesis(
  control: Pick<ControlRecord, 'sourceReferences'> | { sourceReferences?: unknown },
): ValidationError[] {
  if (!Array.isArray(control.sourceReferences)) {
    return [{ path: 'sourceReferences', message: 'sourceReferences must be an array of Genesis citations' }];
  }

  const errors: ValidationError[] = [];
  control.sourceReferences.forEach((reference, index) => {
    if (!reference || typeof reference !== 'object') {
      errors.push({ path: `sourceReferences.${index}`, message: 'source reference must identify Genesis evidence' });
      return;
    }
    const id = (reference as Record<string, unknown>).genesisEvidenceId;
    if (typeof id !== 'string' || !id.trim()) {
      errors.push({
        path: `sourceReferences.${index}.genesisEvidenceId`,
        message: 'raw-prose-only references are rejected; genesisEvidenceId is required',
      });
      return;
    }
    if (!accessibleEvidence(id)) {
      errors.push({
        path: `sourceReferences.${index}.genesisEvidenceId`,
        message: `Genesis evidence '${id}' is not registered by the Genesis bridge`,
      });
    }
  });
  return errors;
}

/**
 * Replace bridge state with validated fixtures. This is the only registration seam and
 * deliberately accepts review/access state only inside immutable bridge provenance.
 */
export function registerGenesisEvidenceFixtures(fixtures: readonly unknown[]): () => void {
  const parsed = fixtures.map((fixture) => GenesisBridgeFixtureSchema.parse(fixture));
  const previous = new Map(evidenceById);
  const next = new Map<string, ProjectedEvidence>();

  for (const fixture of parsed) {
    const { evidence, bridgeProvenance } = fixture;
    if (next.has(evidence.genesisEvidenceId)) throw new Error(`Duplicate Genesis evidence '${evidence.genesisEvidenceId}'`);
    next.set(evidence.genesisEvidenceId, deepFreeze({ ...evidence, bridgeProvenance }));
  }

  for (const evidence of [...next.values()]) {
    for (const supersededId of evidence.supersedes ?? []) {
      const superseded = next.get(supersededId);
      if (!superseded) throw new Error(`Genesis evidence '${evidence.genesisEvidenceId}' supersedes unknown evidence '${supersededId}'`);
      if (superseded.supersededBy && superseded.supersededBy !== evidence.genesisEvidenceId) {
        throw new Error(`Genesis evidence '${supersededId}' has conflicting supersession provenance`);
      }
      next.set(supersededId, deepFreeze({ ...superseded, supersededBy: evidence.genesisEvidenceId }));
    }
  }

  for (const evidence of next.values()) {
    if (evidence.supersededBy && !next.has(evidence.supersededBy)) {
      throw new Error(`Genesis evidence '${evidence.genesisEvidenceId}' is superseded by unknown evidence '${evidence.supersededBy}'`);
    }

    const existing = previous.get(evidence.genesisEvidenceId);
    if (existing && (
      existing.bridgeProvenance.reviewStatus !== evidence.bridgeProvenance.reviewStatus
      || existing.bridgeProvenance.access !== evidence.bridgeProvenance.access
    )) {
      throw new Error(
        `Test fixtures cannot change Genesis review or access provenance for '${evidence.genesisEvidenceId}'`,
      );
    }
  }

  evidenceById.clear();
  next.forEach((evidence, id) => evidenceById.set(id, evidence));

  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    evidenceById.clear();
    previous.forEach((evidence, id) => evidenceById.set(id, evidence));
  };
}
