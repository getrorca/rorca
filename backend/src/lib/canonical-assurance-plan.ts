/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Deterministic bridge from an ordinary persisted Rorca spec to the canonical
 * SSDLC assurance catalog. This is the normal Forge compilation path; the
 * Hermes mission-draft bridge remains an alternate producer of the same
 * AssuranceProfileV1 contract.
 */
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  discoverSoftwareQualificationChecks,
  type SoftwareQualificationCategory,
  type SoftwareQualificationCheck,
} from './mechanism-discovery';
import { compileAssuranceProfile, type AssuranceMechanism, type AssuranceProfile, type ControlInstance, type RiskProfile } from '../ssdlc/assurance-profile';
import { resolveActiveControls, PRODUCT_PROFILES, type ApplicabilityProfile, type ProductProfile, type SpecTaskOverride } from '../ssdlc/applicability/resolver';
import { compileGates, type GateCompilation } from '../ssdlc/gates/gate-compiler';
import controlsArtifact from '../ssdlc/catalog/controls.json';
import { parseControl, type ControlRecord } from '../ssdlc/schema/control-schema';
import { MISSION_CONTRACT_VERSIONS } from './mission-contracts';
import { UnprocessableError } from './errors';
import { DecisionReferenceSchema } from './ssdlc-contracts';

const COMPATIBLE_MECHANISM_CATEGORIES: Partial<Record<string, readonly SoftwareQualificationCategory[]>> = {
  'CTRL-DEVELOPMENT-TRACE-UNIT': ['unit'],
  'CTRL-TESTING-REQ-REGRESSION': ['unit', 'integration', 'e2e'],
  'CTRL-TESTING-QUALITY-ATTRIBUTES': ['performance'],
  'CTRL-TESTING-THREAT-AUTHZ-SECRETS': ['security'],
  'CTRL-TESTING-SUPPLY-CHAIN': ['security', 'package'],
  'CTRL-DEPLOYMENT-READINESS-PARITY': ['build', 'package', 'smoke'],
  'CTRL-DEPLOYMENT-RELEASE-EVIDENCE': ['build', 'package'],
  'CTRL-TESTING-ACCEPTANCE': ['integration', 'e2e', 'smoke'],
};
const SHA256_PREFIX = 'sha256:';
const MAX_REPOSITORY_ARTIFACT_BYTES = 256 * 1024;

type JsonRecord = Record<string, unknown>;
const AssuranceInputSchema = z.object({
  productProfile: z.string().optional(),
  domainRegulatory: z.array(z.string()).optional(),
  workspaceConventions: z.array(z.string()).optional(),
  specTaskOverrides: z.array(z.object({
    controlId: z.string(),
    action: z.enum(['include', 'exclude']).optional(),
    evidenceDepthOverride: z.enum(['self-attestation', 'artifact', 'independent-verification']).optional(),
    requirementId: z.string().optional(),
    exception: z.object({
      approvalReference: DecisionReferenceSchema.optional(),
      justification: z.string().trim().min(1).optional(),
      expiresAt: z.string().datetime({ offset: true }).optional(),
    }).strict().optional(),
  }).passthrough()).optional(),
}).passthrough();
const CanonicalSpecInputSchema = z.object({
  title: z.string().optional(),
  riskLevel: z.string().optional(),
  risk: z.string().optional(),
  productProfile: z.string().optional(),
  tags: z.array(z.string()).optional(),
  assurance: AssuranceInputSchema.optional(),
  lifecycle: z.object({ assurance: AssuranceInputSchema.optional() }).passthrough().optional(),
}).passthrough();
type CanonicalSpecInput = z.infer<typeof CanonicalSpecInputSchema>;
type AssuranceInput = z.infer<typeof AssuranceInputSchema>;
export interface InspectedRepositoryArtifact {
  path: string;
  state: 'hashed' | 'missing' | 'unreadable';
  contentHash?: `sha256:${string}`;
  byteLength?: number;
}


export interface CanonicalAssuranceCompilation {
  profile: AssuranceProfile;
  gates: GateCompilation;
  repositoryContext: {
    hash: `sha256:${string}`;
    mechanisms: AssuranceMechanism[];
    inspectedPaths: string[];
    inspectedArtifacts: InspectedRepositoryArtifact[];
    availableCategories: SoftwareQualificationCategory[];
    unavailableCategories: SoftwareQualificationCategory[];
    discoveryAvailable: boolean;
    discoveryReason: string | null;
  };
}

function normalizedAssuranceInput(content: CanonicalSpecInput): AssuranceInput {
  const direct = content.assurance;
  return direct && Object.keys(direct).length > 0 ? direct : content.lifecycle?.assurance ?? {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map(text).filter(Boolean))].sort((left, right) => left.localeCompare(right))
    : [];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as JsonRecord;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function digest(value: unknown): `sha256:${string}` {
  return `${SHA256_PREFIX}${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
function unprocessable(message: string, details: JsonRecord = {}): never {
  throw new UnprocessableError(message, 'PLAN_COMPILATION_FAILED', details);
}

function workspaceRelativeArtifactPath(workspacePath: string, candidate: string): string {
  const normalized = candidate.replaceAll('\\', '/');
  if (!normalized || path.posix.isAbsolute(normalized) || path.posix.normalize(normalized) !== normalized
    || normalized === '..' || normalized.startsWith('../')) {
    return unprocessable('Canonical spec path must be a normalized workspace-relative path', { canonicalSpecPath: candidate });
  }
  const root = path.resolve(workspacePath);
  const absolute = path.resolve(root, ...normalized.split('/'));
  const relative = path.relative(root, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return unprocessable('Canonical spec path must remain inside the workspace', { canonicalSpecPath: candidate });
  }
  return normalized;
}

async function inspectedRepositoryArtifacts(
  workspacePath: string,
  inspectedPaths: readonly string[],
): Promise<InspectedRepositoryArtifact[]> {
  const root = await fs.realpath(workspacePath);
  const artifacts: InspectedRepositoryArtifact[] = [];
  for (const inspectedPath of [...new Set(inspectedPaths)].sort()) {
    const normalized = inspectedPath.replaceAll('\\', '/');
    if (!normalized || path.posix.isAbsolute(normalized) || path.posix.normalize(normalized) !== normalized
      || normalized === '..' || normalized.startsWith('../')) {
      artifacts.push({ path: inspectedPath, state: 'unreadable' });
      continue;
    }
    const candidate = path.resolve(root, ...normalized.split('/'));
    const relative = path.relative(root, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      artifacts.push({ path: normalized, state: 'unreadable' });
      continue;
    }
    try {
      const linkStat = await fs.lstat(candidate);
      if (!linkStat.isFile() || linkStat.isSymbolicLink() || linkStat.size > MAX_REPOSITORY_ARTIFACT_BYTES) {
        artifacts.push({ path: normalized, state: 'unreadable' });
        continue;
      }
      const canonical = await fs.realpath(candidate);
      const canonicalRelative = path.relative(root, canonical);
      if (canonicalRelative === '..' || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
        artifacts.push({ path: normalized, state: 'unreadable' });
        continue;
      }
      const handle = await fs.open(canonical, 'r');
      try {
        const fileStat = await handle.stat();
        if (!fileStat.isFile() || fileStat.size > MAX_REPOSITORY_ARTIFACT_BYTES) {
          artifacts.push({ path: normalized, state: 'unreadable' });
          continue;
        }
        const bytes = Buffer.allocUnsafe(fileStat.size);
        let byteLength = 0;
        while (byteLength < bytes.length) {
          const read = await handle.read(bytes, byteLength, bytes.length - byteLength, byteLength);
          if (read.bytesRead === 0) break;
          byteLength += read.bytesRead;
        }
        const contentHash = `${SHA256_PREFIX}${crypto.createHash('sha256').update(bytes.subarray(0, byteLength)).digest('hex')}` as const;
        artifacts.push({ path: normalized, state: 'hashed', contentHash, byteLength });
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      artifacts.push({ path: normalized, state: code === 'ENOENT' ? 'missing' : 'unreadable' });
    }
  }
  return artifacts;
}

function validateSpecTaskExclusions(
  assurance: AssuranceInput,
  controls: readonly ControlRecord[],
  now: Date,
): void {
  const controlsById = new Map(controls.map((control) => [control.controlId, control]));
  for (const [index, override] of (assurance.specTaskOverrides ?? []).entries()) {
    if ((override.action ?? 'include') !== 'exclude') continue;
    const controlId = override.controlId.trim();
    const control = controlsById.get(controlId);
    if (!control) {
      unprocessable(`Assurance exclusion references unknown control ${controlId || '(empty)'}`, {
        path: `assurance.specTaskOverrides.${index}.controlId`,
      });
    }
    const policy = control.exceptionPolicy;
    if (!policy.allowed) {
      unprocessable(`Control ${controlId} cannot be excluded by catalog policy`, {
        controlId,
        path: `assurance.specTaskOverrides.${index}`,
      });
    }
    const exception = override.exception;
    if (policy.approvalRequired && !exception?.approvalReference) {
      unprocessable(`Control ${controlId} exclusion requires a governed approval reference`, {
        controlId,
        path: `assurance.specTaskOverrides.${index}.exception.approvalReference`,
      });
    }
    if (policy.justificationRequired && !exception?.justification) {
      unprocessable(`Control ${controlId} exclusion requires a justification`, {
        controlId,
        path: `assurance.specTaskOverrides.${index}.exception.justification`,
      });
    }
    if (policy.maxDurationDays !== undefined) {
      if (!exception?.expiresAt) {
        unprocessable(`Control ${controlId} exclusion requires an expiry`, {
          controlId,
          path: `assurance.specTaskOverrides.${index}.exception.expiresAt`,
        });
      }
      const expiry = new Date(exception.expiresAt);
      const maximumExpiry = now.getTime() + policy.maxDurationDays * 24 * 60 * 60 * 1_000;
      if (expiry.getTime() <= now.getTime() || expiry.getTime() > maximumExpiry) {
        unprocessable(`Control ${controlId} exclusion expiry must be in the future and within ${policy.maxDurationDays} days`, {
          controlId,
          path: `assurance.specTaskOverrides.${index}.exception.expiresAt`,
          maxDurationDays: policy.maxDurationDays,
        });
      }
    }
    unprocessable(`Control ${controlId} exclusion requires a verified governed decision receipt; a spec-authored decision reference is not authority`, {
      controlId,
      approvalReference: exception?.approvalReference,
      path: `assurance.specTaskOverrides.${index}.exception.approvalReference`,
    });
  }
}


function productProfile(content: CanonicalSpecInput, assurance: AssuranceInput): ProductProfile | null {
  const candidate = text(assurance.productProfile || content.productProfile);
  return PRODUCT_PROFILES.includes(candidate as ProductProfile) ? candidate as ProductProfile : null;
}

function riskProfile(content: CanonicalSpecInput, tags: readonly string[]): RiskProfile {
  const candidate = text(content.riskLevel || content.risk);
  const level = candidate === 'low' || candidate === 'medium' || candidate === 'high' || candidate === 'critical'
    ? candidate
    : 'none';
  return {
    level,
    tags: [...new Set(tags)].sort((left, right) => left.localeCompare(right)),
    rationale: level === 'none'
      ? 'No explicit risk classification is present on the canonical spec; universal controls remain applicable.'
      : `Canonical spec declares ${level} risk.`,
  };
}

function applicabilityProfile(content: CanonicalSpecInput, assurance: AssuranceInput, tags: readonly string[], risk: RiskProfile): ApplicabilityProfile {
  const overrides: SpecTaskOverride[] = (assurance.specTaskOverrides ?? []).map((item) => ({
    controlId: item.controlId.trim(),
    action: item.action ?? 'include',
    ...(item.evidenceDepthOverride ? { evidenceDepthOverride: item.evidenceDepthOverride } : {}),
    requirementId: item.requirementId?.trim() || `spec-override:${item.controlId.trim()}`,
  })).filter((item) => item.controlId.length > 0);
  return {
    productProfile: productProfile(content, assurance),
    riskProfile: [...new Set([...risk.tags, ...(risk.level === 'none' ? [] : [risk.level])])],
    domainRegulatory: [...new Set([...strings(assurance.domainRegulatory), ...tags])],
    workspaceConventions: strings(assurance.workspaceConventions),
    specTaskOverrides: overrides,
  };
}

function commandMechanism(root: string, check: SoftwareQualificationCheck): AssuranceMechanism {
  const locator = canonicalJson({
    category: check.category,
    executable: check.executable,
    args: check.args,
    cwd: path.relative(root, check.cwd) || '.',
  });
  return {
    mechanismId: `command:${check.category}:${digest(locator).slice(SHA256_PREFIX.length, SHA256_PREFIX.length + 16)}`,
    kind: 'command',
    locator,
  };
}

function projectedEvidence(gates: GateCompilation, controlId: string) {
  return gates.phaseGroups.flatMap((group) => group.evidenceRequirements
    .filter((requirement) => requirement.controlId === controlId)
    .map(({ controlId: _controlId, sourceReferences: _sourceReferences, ...requirement }) => requirement));
}

function controlInstance(input: {
  control: ControlRecord;
  gates: GateCompilation;
  review: AssuranceMechanism;
  repositoryArtifact: AssuranceMechanism;
  verificationCommand: AssuranceMechanism | null;
}): ControlInstance {
  const governedDecision = input.control.requiredEvidence.some((requirement) => (
    requirement.classification === 'review'
    || requirement.classification === 'approval'
    || requirement.classification === 'attestation'
    || requirement.allowedSourceTypes.includes('governed:human-review')
    || requirement.allowedSourceTypes.includes('governed:approval')
  ));
  const commandBound = input.verificationCommand !== null;
  const mechanism = governedDecision ? input.review : commandBound ? input.verificationCommand! : input.repositoryArtifact;
  const evaluator = governedDecision ? 'human-decision' as const : commandBound ? 'exit-code' as const : 'artifact-match' as const;
  const expected = governedDecision ? 'approved' : commandBound ? '0' : 'exact current spec revision';
  return {
    controlId: input.control.controlId,
    mechanismBindings: [mechanism],
    criteria: [{
      criterionId: `${input.control.controlId.toLowerCase()}-criterion`,
      description: input.control.objective,
      evaluator,
      expected,
    }],
    evidenceRequirements: projectedEvidence(input.gates, input.control.controlId),
    enforcement: 'required',
  };
}

/** Compile an immutable exact-revision assurance profile for the normal spec path. */
export async function compileCanonicalAssurancePlan(input: {
  workspaceId: string;
  workspacePath: string;
  specSlug: string;
  specHash: `sha256:${string}`;
  canonicalSpecPath: string;
  content: JsonRecord;
  tags: readonly string[];
}): Promise<CanonicalAssuranceCompilation> {
  const content = CanonicalSpecInputSchema.parse(input.content);
  const assuranceInput = normalizedAssuranceInput(content);
  const canonicalSpecPath = workspaceRelativeArtifactPath(input.workspacePath, input.canonicalSpecPath);
  const controls = controlsArtifact.map((control) => parseControl(control));
  const risk = riskProfile(content, input.tags);
  validateSpecTaskExclusions(assuranceInput, controls, new Date());
  const applicability = resolveActiveControls(applicabilityProfile(content, assuranceInput, input.tags, risk), controls);
  const gates = compileGates(controls, applicability);
  const discovery = await discoverSoftwareQualificationChecks(input.workspacePath);
  const commands = discovery.checks.map((check) => ({
    check,
    mechanism: commandMechanism(input.workspacePath, check),
  }));
  const review: AssuranceMechanism = {
    mechanismId: 'review:rorca-governed-decision',
    kind: 'review',
    locator: 'Rorca append-only governed lifecycle decision',
  };
  const repositoryArtifact: AssuranceMechanism = {
    mechanismId: `repository-path:canonical-spec:${input.specSlug}`,
    kind: 'repository-path',
    locator: canonicalSpecPath,
  };
  const mechanisms = [...commands.map(({ mechanism }) => mechanism), repositoryArtifact, review]
    .sort((left, right) => left.mechanismId.localeCompare(right.mechanismId));
  const inspectedArtifacts = await inspectedRepositoryArtifacts(input.workspacePath, discovery.inspectedPaths);
  const repositoryContextHash = digest({
    mechanisms,
    inspectedPaths: discovery.inspectedPaths,
    inspectedArtifacts,
    availableCategories: discovery.availableCategories,
    unavailableCategories: discovery.unavailableCategories,
  });
  const active = new Set(applicability.activeControlIds);
  const controlInstances = controls.filter((control) => active.has(control.controlId)).map((control) => {
    const compatibleCategories = COMPATIBLE_MECHANISM_CATEGORIES[control.controlId] ?? [];
    const verificationCommand = commands.find(({ check }) => compatibleCategories.includes(check.category))?.mechanism ?? null;
    return controlInstance({
      control,
      gates,
      review,
      repositoryArtifact,
      verificationCommand,
    });
  });
  const specRevision = { kind: 'artifact_digest' as const, value: input.specHash };
  const profile = compileAssuranceProfile({
    profileId: `assurance:${input.specSlug}:${input.specHash.slice(SHA256_PREFIX.length, SHA256_PREFIX.length + 16)}`,
    specRef: {
      schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
      workspaceId: input.workspaceId,
      kind: 'spec',
      id: input.specSlug,
      revision: specRevision,
      label: input.specSlug,
    },
    specRevision,
    repositoryContextHash,
    riskProfile: risk,
    selectionContext: {
      applicabilityControlIds: [...applicability.activeControlIds],
      phaseGroups: gates.phaseGroups.map(({ phase, controlIds }) => ({ phase, controlIds: [...controlIds] })),
      stageProjection: gates.readiness.map(({ stage, phases, controlIds }) => ({ stage, phases: [...phases], controlIds: [...controlIds] })),
    },
    controlInstances,
  });
  return {
    profile: profile as AssuranceProfile,
    gates,
    repositoryContext: {
      hash: repositoryContextHash,
      mechanisms,
      inspectedPaths: discovery.inspectedPaths,
      inspectedArtifacts,
      availableCategories: discovery.availableCategories,
      unavailableCategories: discovery.unavailableCategories,
      discoveryAvailable: discovery.checks.length > 0,
      discoveryReason: discovery.checks.length > 0 ? null : 'no-supported-verification-mechanism',
    },
  };
}
