/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { z } from 'zod';
import { GENERAL_SDLC_7_STAGES } from '../profiles/general-sdlc-7';

export const PHASES = [
  'planning',
  'requirements',
  'design',
  'development',
  'testing',
  'deployment',
  'maintenance',
] as const;

export type Phase = (typeof PHASES)[number];
export type MissionStage = (typeof GENERAL_SDLC_7_STAGES)[number]['id'];

/**
 * Canonical phase -> stage projection, derived from the general-sdlc-7 profile
 * so the profile remains the single source of the stage mapping.
 */
export const MISSION_STAGE_BY_PHASE: Readonly<Record<Phase, MissionStage>> = Object.freeze(
  GENERAL_SDLC_7_STAGES.reduce((mapping, stage) => {
    for (const phase of stage.phaseIds) {
      mapping[phase as Phase] = stage.id;
    }
    return mapping;
  }, {} as Record<Phase, MissionStage>),
);

export const SOURCE_STRENGTHS = ['primary', 'secondary', 'derived'] as const;
export const FAILURE_SEVERITIES = ['advisory', 'blocking', 'critical'] as const;
export const EVIDENCE_DEPTHS = ['declaration', 'demonstrated', 'independent-verification'] as const;

const EVIDENCE_CLASSIFICATIONS = ['artifact', 'attestation', 'measurement', 'review', 'approval'] as const;
const TRUST_LEVELS = ['self-attested', 'tool-verified', 'independently-verified'] as const;

export interface SourceReference {
  genesisEvidenceId: string;
  citation: string;
}

export interface Applicability {
  universal: boolean;
  productProfiles: string[];
  riskProfiles: string[];
  domainRegulatory: string[];
}

export interface EvidenceRequirement {
  classification: (typeof EVIDENCE_CLASSIFICATIONS)[number];
  allowedSourceTypes: string[];
  requiredBindings: {
    subject: boolean;
    release: boolean;
  };
  minimumTrust: (typeof TRUST_LEVELS)[number];
  evidenceDepth: (typeof EVIDENCE_DEPTHS)[number];
  freshness: {
    maxAgeSeconds: number;
  };
}

export interface ExceptionPolicy {
  allowed: boolean;
  approvalRequired: boolean;
  justificationRequired: boolean;
  maxDurationDays?: number;
}

export interface ControlRecord {
  schemaVersion: 'rorca.ssdlc-control-record.v1';
  version: string;
  controlId: string;
  phase: Phase;
  objective: string;
  applicability: Applicability;
  sourceReferences: SourceReference[];
  sourceStrength: (typeof SOURCE_STRENGTHS)[number];
  requiredEvidence: EvidenceRequirement[];
  failureSeverity: (typeof FAILURE_SEVERITIES)[number];
  exceptionPolicy: ExceptionPolicy;
  skillRefs: string[];
  /** Optional phase-merged classification hint (e.g. security controls that
   *  collapsed into the testing phase still emit security_finding evidence). */
  evidenceClassification?: 'code_change' | 'documentation' | 'test_result' | 'security_finding' | 'data_storage' | 'release_operation' | 'approval' | 'runtime_observation';
}

export interface ValidationError {
  path: string;
  message: string;
}

const nonEmptyString = z.string().trim().min(1);
const strictSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export const EvidenceRequirementSchema: z.ZodType<EvidenceRequirement> = z.object({
  classification: z.enum(EVIDENCE_CLASSIFICATIONS),
  allowedSourceTypes: z.array(nonEmptyString).min(1),
  requiredBindings: z.object({
    subject: z.boolean(),
    release: z.boolean(),
  }).strict().refine((bindings) => bindings.subject || bindings.release, {
    message: 'at least one subject or release binding is required',
  }),
  minimumTrust: z.enum(TRUST_LEVELS),
  evidenceDepth: z.enum(EVIDENCE_DEPTHS),
  freshness: z.object({
    maxAgeSeconds: z.number().int().positive(),
  }).strict(),
}).strict();

const controlSchema: z.ZodType<ControlRecord> = z.object({
  schemaVersion: z.literal('rorca.ssdlc-control-record.v1'),
  version: z.string().regex(strictSemver, 'version must be strict semantic versioning (SemVer 2.0.0)'),
  controlId: nonEmptyString,
  phase: z.enum(PHASES),
  objective: nonEmptyString,
  applicability: z.object({
    universal: z.boolean(),
    productProfiles: z.array(nonEmptyString),
    riskProfiles: z.array(nonEmptyString),
    domainRegulatory: z.array(nonEmptyString),
  }).strict(),
  sourceReferences: z.array(z.object({
    genesisEvidenceId: nonEmptyString,
    citation: nonEmptyString,
  }).strict()).min(1),
  sourceStrength: z.enum(SOURCE_STRENGTHS),
  requiredEvidence: z.array(EvidenceRequirementSchema).min(1),
  failureSeverity: z.enum(FAILURE_SEVERITIES),
  exceptionPolicy: z.object({
    allowed: z.boolean(),
    approvalRequired: z.boolean(),
    justificationRequired: z.boolean(),
    maxDurationDays: z.number().int().positive().optional(),
  }).strict().superRefine((policy, context) => {
    if (!policy.allowed && policy.maxDurationDays !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['maxDurationDays'],
        message: 'maxDurationDays is only valid when exceptions are allowed',
      });
    }
  }),
  skillRefs: z.array(nonEmptyString),
  evidenceClassification: z.enum([
    'code_change', 'documentation', 'test_result', 'security_finding', 'data_storage',
    'release_operation', 'approval', 'runtime_observation',
  ]).optional(),
}).strict();

/** Parse a canonical control record, throwing a ZodError when it is invalid. */
export function parseControl(input: unknown): ControlRecord {
  return controlSchema.parse(input);
}

/** Return stable, consumer-friendly validation errors without throwing. */
export function validateControl(input: unknown): ValidationError[] {
  const result = controlSchema.safeParse(input);
  if (result.success) return [];

  return result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}
