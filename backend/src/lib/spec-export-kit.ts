/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { ConflictError, NotFoundError, UnprocessableError } from './errors';

const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const NonEmptyStrings = z.array(z.string().trim().min(1)).default([]);

export const SpecExportKitInputSchema = z.object({
  schemaVersion: z.literal('rorca.export-kit-input.v1'),
  product: z.object({
    problem: z.string().trim().min(1),
    targetUsers: NonEmptyStrings,
    outcomes: NonEmptyStrings,
  }).strict(),
  scope: z.object({
    inScope: NonEmptyStrings,
    outOfScope: NonEmptyStrings,
  }).strict(),
  requirements: z.object({
    functional: z.array(z.object({
      id: z.string().trim().min(1),
      statement: z.string().trim().min(1),
      acceptanceCriteria: NonEmptyStrings.optional(),
    }).strict()).default([]),
    successMetrics: NonEmptyStrings,
    nonGoals: NonEmptyStrings,
  }).strict(),
  design: z.object({
    architecture: z.string().trim().min(1),
    components: z.array(z.object({
      name: z.string().trim().min(1),
      responsibility: z.string().trim().min(1),
      boundaries: NonEmptyStrings,
    }).strict()).default([]),
    dataChanges: NonEmptyStrings,
    apiChanges: NonEmptyStrings,
    securityAndPrivacy: NonEmptyStrings,
    migrations: NonEmptyStrings,
    operationalConcerns: NonEmptyStrings,
  }).strict(),
  delivery: z.object({
    storyOrder: NonEmptyStrings,
    dependencies: z.array(z.object({
      from: z.string().trim().min(1),
      to: z.string().trim().min(1),
    }).strict()).default([]),
    verification: NonEmptyStrings,
    rollout: NonEmptyStrings,
    rollback: NonEmptyStrings,
  }).strict(),
  sources: z.array(z.object({
    kind: z.enum(['genesis-package', 'workspace-file', 'direction', 'other']),
    reference: z.string().trim().min(1),
    contentHash: HashSchema.optional(),
    role: z.string().trim().min(1).optional(),
    citationRefs: NonEmptyStrings.optional(),
  }).strict()).default([]),
}).strict();

export type SpecExportKitInput = z.infer<typeof SpecExportKitInputSchema>;
export type SpecExportKitArtifactRole = 'spec' | 'requirements' | 'design' | 'delivery';
const ARTIFACT_PATHS: Record<SpecExportKitArtifactRole, string> = {
  spec: 'spec.json',
  requirements: 'PRD.md',
  design: 'SDD.md',
  delivery: 'PLAN.md',
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const ArtifactIdentitySchema = z.object({
  path: z.string().trim().min(1),
  contentHash: HashSchema,
}).strict();

const SpecExportKitIdentitySchema = z.object({
  schemaVersion: z.literal('rorca.export-kit-binding.v1'),
  specMaterialHash: HashSchema,
  manifestHash: HashSchema,
  kitPath: z.string().regex(/^forge\/export-kits\/[A-Za-z0-9._-]+\/[0-9a-f]{64}$/),
  artifacts: z.object({
    spec: ArtifactIdentitySchema,
    requirements: ArtifactIdentitySchema,
    design: ArtifactIdentitySchema,
    delivery: ArtifactIdentitySchema,
  }).strict(),
}).strict();

const ManifestArtifactSchema = z.object({
  role: z.enum(['spec', 'requirements', 'design', 'delivery']),
  path: z.enum(['spec.json', 'PRD.md', 'SDD.md', 'PLAN.md']),
  contentHash: HashSchema,
  byteLength: z.number().int().nonnegative(),
}).strict();

const SpecExportKitManifestSchema = z.object({
  schemaVersion: z.literal('rorca.export-kit-manifest.v1'),
  compilerVersion: z.literal('rorca-export-kit-compiler-1'),
  specId: z.string().trim().min(1),
  specMaterialHash: HashSchema,
  inputSchemaVersion: z.enum(['rorca.export-kit-input.v1', 'canonical-spec-projection.v1']),
  artifacts: z.array(ManifestArtifactSchema).length(4),
  sources: SpecExportKitInputSchema.shape.sources,
  manifestHash: HashSchema,
}).strict();
const SpecExportKitSealSchema = z.object({
  schemaVersion: z.literal('rorca.export-kit-seal.v1'),
  specMaterialHash: HashSchema,
  manifestHash: HashSchema,
  actorId: z.string().trim().min(1),
  approvalReceiptId: z.string().trim().min(1).nullable(),
  sealHash: HashSchema,
}).strict();

export interface SpecExportKitIdentity {
  schemaVersion: 'rorca.export-kit-binding.v1';
  specMaterialHash: `sha256:${string}`;
  manifestHash: `sha256:${string}`;
  kitPath: string;
  artifacts: Record<SpecExportKitArtifactRole, { path: string; contentHash: `sha256:${string}` }>;
}

export interface SpecExportKitManifest {
  schemaVersion: 'rorca.export-kit-manifest.v1';
  compilerVersion: 'rorca-export-kit-compiler-1';
  specId: string;
  specMaterialHash: `sha256:${string}`;
  inputSchemaVersion: 'rorca.export-kit-input.v1' | 'canonical-spec-projection.v1';
  artifacts: Array<{ role: SpecExportKitArtifactRole; path: string; contentHash: `sha256:${string}`; byteLength: number }>;
  sources: SpecExportKitInput['sources'];
  manifestHash: `sha256:${string}`;
}

export interface SpecExportKitInspection {
  status: 'current' | 'missing' | 'stale' | 'tampered';
  identity: SpecExportKitIdentity | null;
  reason: string | null;
}

type JsonRecord = Record<string, unknown>;
const JsonRecordSchema = z.record(z.string(), z.unknown());

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  const objectValue = value as JsonRecord;
  return Object.fromEntries(
    Object.keys(objectValue)
      .filter((key) => objectValue[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(objectValue[key])]),
  );
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function hashBytes(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\r\n?/g, '\n') : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function storiesFromSpec(spec: JsonRecord): JsonRecord[] {
  const stories = Array.isArray(spec.userStories) ? spec.userStories : Array.isArray(spec.stories) ? spec.stories : [];
  return z.array(JsonRecordSchema).parse(stories);
}

/** Material that may change the PRD/SDD/PLAN. Runtime state, timestamps, approvals, and pass flags are excluded. */
export function canonicalSpecExportMaterial(spec: JsonRecord): JsonRecord {
  const stories = storiesFromSpec(spec).map((story) => ({
    id: text(story.id),
    title: text(story.title),
    description: text(story.description),
    acceptanceCriteria: stringArray(story.acceptanceCriteria),
    dependsOn: stringArray(story.dependsOn ?? story.dependencies),
    ...(story.complexity != null ? { complexity: story.complexity } : {}),
    ...(story.priority != null ? { priority: story.priority } : {}),
    ...(story.timeoutMinutes != null ? { timeoutMinutes: story.timeoutMinutes } : {}),
    ...(Array.isArray(story.suggestedSkills) ? { suggestedSkills: canonicalize(story.suggestedSkills) } : {}),
    ...(text(story.suggestedPersona) ? { suggestedPersona: text(story.suggestedPersona) } : {}),
    ...(Array.isArray(story.suggestedReviewers) ? { suggestedReviewers: stringArray(story.suggestedReviewers) } : {}),
  }));
  return canonicalize({
    id: text(spec.id ?? spec.slug),
    slug: text(spec.slug ?? spec.id),
    title: text(spec.title ?? spec.specName),
    source: text(spec.source),
    userStories: stories,
    ...(text(spec.mermaidDiagram) ? { mermaidDiagram: text(spec.mermaidDiagram) } : {}),
    ...(spec.exportKit !== undefined ? { exportKit: SpecExportKitInputSchema.parse(spec.exportKit) } : {}),
  }) as JsonRecord;
}

export function computeSpecExportMaterialHash(spec: JsonRecord): `sha256:${string}` {
  return hashBytes(canonicalJson(canonicalSpecExportMaterial(spec)));
}

function bulletList(values: string[], empty: string): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join('\n') : `- ${empty}`;
}

function acceptance(story: JsonRecord): string[] {
  return stringArray(story.acceptanceCriteria);
}

function derivedInput(spec: JsonRecord): SpecExportKitInput {
  const stories = storiesFromSpec(spec);
  const title = text(spec.title ?? spec.specName) || text(spec.slug ?? spec.id);
  const orderedIds = stories.map((story) => text(story.id)).filter(Boolean);
  const dependencies = stories.flatMap((story) => {
    const to = text(story.id);
    return stringArray(story.dependsOn ?? story.dependencies).map((from) => ({ from, to }));
  });
  const criteria = stories.flatMap((story) => acceptance(story).map((criterion) => `${text(story.id)}: ${criterion}`));
  return SpecExportKitInputSchema.parse({
    schemaVersion: 'rorca.export-kit-input.v1',
    product: {
      problem: text(spec.brief) || `Deliver the behavior defined by the canonical ${title} specification.`,
      targetUsers: [],
      outcomes: stories.map((story) => `${text(story.id)} — ${text(story.title)}`).filter((value) => !value.endsWith(' — ')),
    },
    scope: {
      inScope: stories.map((story) => text(story.description)).filter(Boolean),
      outOfScope: [],
    },
    requirements: {
      functional: stories.map((story) => ({
        id: text(story.id),
        statement: text(story.description) || text(story.title),
        acceptanceCriteria: acceptance(story),
      })).filter((requirement) => requirement.id && requirement.statement),
      successMetrics: criteria,
      nonGoals: [],
    },
    design: {
      architecture: text(spec.mermaidDiagram)
        ? 'The canonical dependency diagram below defines the declared delivery topology.'
        : 'The canonical story dependency graph defines the declared delivery topology.',
      components: stories.map((story) => ({
        name: `${text(story.id)} — ${text(story.title)}`,
        responsibility: text(story.description) || text(story.title),
        boundaries: stringArray(story.dependsOn ?? story.dependencies).map((dependency) => `Depends on ${dependency}`),
      })).filter((component) => component.name && component.responsibility),
      dataChanges: [],
      apiChanges: [],
      securityAndPrivacy: [],
      migrations: [],
      operationalConcerns: [],
    },
    delivery: {
      storyOrder: orderedIds,
      dependencies,
      verification: criteria,
      rollout: [],
      rollback: [],
    },
    sources: [],
  });
}

function kitInput(spec: JsonRecord): SpecExportKitInput {
  return isRecord(spec.exportKit) ? SpecExportKitInputSchema.parse(spec.exportKit) : derivedInput(spec);
}

function renderSources(input: SpecExportKitInput): string {
  return input.sources.length > 0
    ? input.sources.map((source) => {
      const details = [
        source.contentHash,
        ...(source.citationRefs ?? []),
        source.role,
      ].filter(Boolean).join(' · ');
      return `- **${source.kind}**: ${source.reference}${details ? ` — ${details}` : ''}`;
    }).join('\n')
    : '- No external research package informed this canonical spec.';
}

function renderPrd(spec: JsonRecord, input: SpecExportKitInput): string {
  const title = text(spec.title ?? spec.specName);
  const requirements = input.requirements.functional.map((requirement) => [
    `### ${requirement.id}`,
    requirement.statement,
    '',
    '**Acceptance criteria**',
    bulletList(requirement.acceptanceCriteria ?? [], 'No separate acceptance criteria were declared.'),
  ].join('\n')).join('\n\n');
  return [
    `# ${title} — Product Requirements`,
    '',
    '## Problem', input.product.problem,
    '',
    '## Target users', bulletList(input.product.targetUsers, 'No target-user segment was declared in the canonical spec.'),
    '',
    '## Desired outcomes', bulletList(input.product.outcomes, 'Outcomes are expressed by the functional requirements below.'),
    '',
    '## In scope', bulletList(input.scope.inScope, 'Scope is defined by the functional requirements below.'),
    '',
    '## Out of scope', bulletList(input.scope.outOfScope, 'No explicit exclusions were declared.'),
    '',
    '## Functional requirements', requirements || 'No functional requirements were declared.',
    '',
    '## Success metrics', bulletList(input.requirements.successMetrics, 'Acceptance criteria are the governing success checks.'),
    '',
    '## Non-goals', bulletList(input.requirements.nonGoals, 'No explicit non-goals were declared.'),
    '',
    '## Research provenance', renderSources(input),
    '',
    '',
  ].join('\n');
}

function renderSdd(spec: JsonRecord, input: SpecExportKitInput): string {
  const title = text(spec.title ?? spec.specName);
  const components = input.design.components.map((component) => [
    `### ${component.name}`,
    component.responsibility,
    '',
    '**Boundaries**', bulletList(component.boundaries, 'No explicit component boundary was declared.'),
  ].join('\n')).join('\n\n');
  const diagram = text(spec.mermaidDiagram);
  return [
    `# ${title} — Software Design`,
    '',
    '## Architecture', input.design.architecture,
    ...(diagram ? ['', '```mermaid', diagram, '```'] : []),
    '',
    '## Components', components || 'No component decomposition was declared.',
    '',
    '## Data changes', bulletList(input.design.dataChanges, 'No data changes were declared.'),
    '',
    '## API changes', bulletList(input.design.apiChanges, 'No API changes were declared.'),
    '',
    '## Security and privacy', bulletList(input.design.securityAndPrivacy, 'No additional security or privacy constraints were declared.'),
    '',
    '## Migrations', bulletList(input.design.migrations, 'No migrations were declared.'),
    '',
    '## Operational concerns', bulletList(input.design.operationalConcerns, 'No additional operational concerns were declared.'),
    '',
  ].join('\n');
}

function renderPlan(spec: JsonRecord, input: SpecExportKitInput): string {
  const title = text(spec.title ?? spec.specName);
  const storyById = new Map(storiesFromSpec(spec).map((story) => [text(story.id), story]));
  const ordered = input.delivery.storyOrder.map((id, index) => {
    const story = storyById.get(id);
    return `${index + 1}. **${id}${story ? ` — ${text(story.title)}` : ''}**`;
  });
  return [
    `# ${title} — Delivery Plan`,
    '',
    '## Story order', ordered.length > 0 ? ordered.join('\n') : 'No stories were declared.',
    '',
    '## Dependencies', input.delivery.dependencies.length > 0
      ? input.delivery.dependencies.map((dependency) => `- ${dependency.from} → ${dependency.to}`).join('\n')
      : '- No inter-story dependencies were declared.',
    '',
    '## Verification', bulletList(input.delivery.verification, 'Each canonical story acceptance criterion must pass.'),
    '',
    '## Rollout', bulletList(input.delivery.rollout, 'No separate rollout procedure was declared.'),
    '',
    '## Rollback', bulletList(input.delivery.rollback, 'No separate rollback procedure was declared.'),
    '',
  ].join('\n');
}

export function compileSpecExportKit(spec: JsonRecord): {
  identity: SpecExportKitIdentity;
  manifest: SpecExportKitManifest;
  files: Record<string, string>;
} {
  const material = canonicalSpecExportMaterial(spec);
  const specId = text(material.id ?? material.slug);
  if (!specId) throw new UnprocessableError('Canonical spec is missing an id', 'EXPORT_KIT_SPEC_INVALID');
  const input = kitInput(spec);
  const specMaterialHash = hashBytes(canonicalJson(material));
  const files: Record<string, string> = {
    'spec.json': canonicalJson(material),
    'PRD.md': renderPrd(spec, input),
    'SDD.md': renderSdd(spec, input),
    'PLAN.md': renderPlan(spec, input),
  };
  const artifacts = (Object.entries(ARTIFACT_PATHS) as Array<[SpecExportKitArtifactRole, string]>).map(([role, artifactPath]) => ({
    role,
    path: artifactPath,
    contentHash: hashBytes(files[artifactPath]),
    byteLength: Buffer.byteLength(files[artifactPath], 'utf8'),
  }));
  const manifestPayload = {
    schemaVersion: 'rorca.export-kit-manifest.v1' as const,
    compilerVersion: 'rorca-export-kit-compiler-1' as const,
    specId,
    specMaterialHash,
    inputSchemaVersion: spec.exportKit !== undefined ? 'rorca.export-kit-input.v1' as const : 'canonical-spec-projection.v1' as const,
    artifacts,
    sources: input.sources,
  };
  const manifestHash = hashBytes(canonicalJson(manifestPayload));
  const generation = manifestHash.slice('sha256:'.length);
  const kitPath = `forge/export-kits/${specId}/${generation}`;
  const manifest: SpecExportKitManifest = { ...manifestPayload, manifestHash };
  files['manifest.json'] = canonicalJson(manifest);
  const artifactIdentity = Object.fromEntries(artifacts.map((artifact) => [artifact.role, {
    path: `${kitPath}/${artifact.path}`,
    contentHash: artifact.contentHash,
  }])) as SpecExportKitIdentity['artifacts'];
  return {
    identity: {
      schemaVersion: 'rorca.export-kit-binding.v1',
      specMaterialHash,
      manifestHash,
      kitPath,
      artifacts: artifactIdentity,
    },
    manifest,
    files,
  };
}

function durableWrite(targetPath: string, content: string): void {
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  const descriptor = fs.openSync(temporaryPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, targetPath);
}

function exportKitFailpoint(stage: 'before_generation_publication' | 'after_generation_publication'): void {
  if (process.env.RORCA_EXPORT_KIT_FAILPOINT === stage) {
    throw new ConflictError(`Export-kit publication interrupted at ${stage}`);
  }
}

function assertInsideWorkspace(workspacePath: string, relativePath: string): string {
  const root = path.resolve(workspacePath);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new UnprocessableError('Export-kit path escapes the workspace', 'EXPORT_KIT_PATH_INVALID');
  }
  return target;
}

export function publishSpecExportKit(workspacePath: string, spec: JsonRecord): SpecExportKitIdentity {
  const compiled = compileSpecExportKit(spec);
  const target = assertInsideWorkspace(workspacePath, compiled.identity.kitPath);
  if (fs.existsSync(target)) {
    const inspection = inspectSpecExportKit(workspacePath, { ...spec, exportKitIdentity: compiled.identity });
    if (inspection.status !== 'current') {
      throw new ConflictError(`Existing export kit is ${inspection.status}: ${inspection.reason ?? 'verification failed'}`);
    }
  } else {
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true });
    const staging = path.join(parent, `.staging-${path.basename(target)}-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
    fs.mkdirSync(staging, { recursive: false });
    try {
      for (const [relativePath, content] of Object.entries(compiled.files)) durableWrite(path.join(staging, relativePath), content);
      exportKitFailpoint('before_generation_publication');
      fs.renameSync(staging, target);
      exportKitFailpoint('after_generation_publication');
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  const currentPath = path.join(path.dirname(target), 'current.json');
  durableWrite(currentPath, canonicalJson(compiled.identity));
  return compiled.identity;
}

export function inspectSpecExportKit(workspacePath: string, spec: JsonRecord): SpecExportKitInspection {
  const parsedBinding = SpecExportKitIdentitySchema.safeParse(spec.exportKitIdentity);
  if (!parsedBinding.success) {
    return {
      status: spec.exportKitIdentity === undefined ? 'missing' : 'stale',
      identity: null,
      reason: spec.exportKitIdentity === undefined
        ? 'Canonical spec has no exportKitIdentity binding'
        : 'Canonical spec has an invalid exportKitIdentity binding',
    };
  }
  const binding = parsedBinding.data as SpecExportKitIdentity;
  const expected = compileSpecExportKit(spec);
  if (binding.specMaterialHash !== expected.identity.specMaterialHash
    || binding.manifestHash !== expected.identity.manifestHash
    || binding.kitPath !== expected.identity.kitPath) {
    return { status: 'stale', identity: binding, reason: 'Export-kit binding does not match current spec material' };
  }
  const kitDirectory = assertInsideWorkspace(workspacePath, binding.kitPath);
  const manifestPath = path.join(kitDirectory, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { status: 'missing', identity: binding, reason: 'Export-kit manifest is missing' };
  let manifest: SpecExportKitManifest;
  try {
    manifest = SpecExportKitManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))) as SpecExportKitManifest;
  } catch {
    return { status: 'tampered', identity: binding, reason: 'Export-kit manifest is not valid canonical manifest JSON' };
  }
  const { manifestHash: observedManifestHash, ...manifestPayload } = manifest;
  if (observedManifestHash !== binding.manifestHash || hashBytes(canonicalJson(manifestPayload)) !== binding.manifestHash) {
    return { status: 'tampered', identity: binding, reason: 'Export-kit manifest hash mismatch' };
  }
  for (const artifact of manifest.artifacts ?? []) {
    const artifactPath = path.join(kitDirectory, artifact.path);
    if (!fs.existsSync(artifactPath)) return { status: 'tampered', identity: binding, reason: `Export-kit artifact is missing: ${artifact.path}` };
    const bytes = fs.readFileSync(artifactPath);
    if (hashBytes(bytes) !== artifact.contentHash || bytes.byteLength !== artifact.byteLength) {
      return { status: 'tampered', identity: binding, reason: `Export-kit artifact hash mismatch: ${artifact.path}` };
    }
  }
  return { status: 'current', identity: binding, reason: null };
}

export function assertCurrentSpecExportKit(workspacePath: string, spec: JsonRecord): SpecExportKitIdentity {
  const inspection = inspectSpecExportKit(workspacePath, spec);
  if (inspection.status !== 'current' || !inspection.identity) {
    throw new UnprocessableError(
      `Canonical Rorca export kit is ${inspection.status}: ${inspection.reason ?? 'verification failed'}`,
      `EXPORT_KIT_${inspection.status.toUpperCase()}`,
      { exportKit: inspection, action: 'Rebuild the current draft export kit before approval or execution.' },
    );
  }
  return inspection.identity;
}

export function rebuildSpecExportKit(workspacePath: string, spec: JsonRecord): SpecExportKitIdentity {
  const compiled = compileSpecExportKit(spec);
  const rebound = { ...spec, exportKitIdentity: compiled.identity };
  const existing = inspectSpecExportKit(workspacePath, rebound);
  if (existing.status === 'tampered') {
    throw new ConflictError(`Refusing to overwrite a tampered immutable export-kit generation: ${existing.reason}`);
  }
  return publishSpecExportKit(workspacePath, spec);
}

export function readSpecExportKitArtifact(
  workspacePath: string,
  spec: JsonRecord,
  role: SpecExportKitArtifactRole,
): { identity: SpecExportKitIdentity; role: SpecExportKitArtifactRole; content: string; contentHash: string } {
  const identity = assertCurrentSpecExportKit(workspacePath, spec);
  const artifact = identity.artifacts[role];
  if (!artifact) throw new NotFoundError('Export-kit artifact', role);
  const artifactPath = assertInsideWorkspace(workspacePath, artifact.path);
  return { identity, role, content: fs.readFileSync(artifactPath, 'utf8'), contentHash: artifact.contentHash };
}

export function sealSpecExportKit(
  workspacePath: string,
  spec: JsonRecord,
  approval: { actorId: string; approvalReceiptId?: string | null },
): { identity: SpecExportKitIdentity; sealPath: string; sealHash: `sha256:${string}` } {
  const identity = assertCurrentSpecExportKit(workspacePath, spec);
  const seal = {
    schemaVersion: 'rorca.export-kit-seal.v1',
    specMaterialHash: identity.specMaterialHash,
    manifestHash: identity.manifestHash,
    actorId: approval.actorId,
    approvalReceiptId: approval.approvalReceiptId ?? null,
  };
  const sealHash = hashBytes(canonicalJson(seal));
  const relativeSealPath = `${identity.kitPath}/approval-receipt.json`;
  const sealPath = assertInsideWorkspace(workspacePath, relativeSealPath);
  const bytes = canonicalJson({ ...seal, sealHash });
  if (fs.existsSync(sealPath)) {
    if (fs.readFileSync(sealPath, 'utf8') !== bytes) throw new ConflictError('Export-kit generation is already sealed to different approval authority');
  } else {
    durableWrite(sealPath, bytes);
  }
  return { identity, sealPath: relativeSealPath, sealHash };
}
export function assertSealedSpecExportKit(
  workspacePath: string,
  spec: JsonRecord,
): SpecExportKitIdentity {
  const identity = assertCurrentSpecExportKit(workspacePath, spec);
  const sealPath = assertInsideWorkspace(workspacePath, `${identity.kitPath}/approval-receipt.json`);
  if (!fs.existsSync(sealPath)) {
    throw new UnprocessableError(
      'Canonical Rorca export kit is current but not sealed by spec approval',
      'EXPORT_KIT_UNSEALED',
      { manifestHash: identity.manifestHash },
    );
  }
  let seal: z.infer<typeof SpecExportKitSealSchema>;
  try {
    seal = SpecExportKitSealSchema.parse(JSON.parse(fs.readFileSync(sealPath, 'utf8')));
  } catch {
    throw new UnprocessableError('Export-kit approval receipt is invalid', 'EXPORT_KIT_SEAL_TAMPERED');
  }
  const { sealHash, ...sealPayload } = seal;
  if (seal.specMaterialHash !== identity.specMaterialHash
    || seal.manifestHash !== identity.manifestHash
    || hashBytes(canonicalJson(sealPayload)) !== sealHash) {
    throw new UnprocessableError('Export-kit approval receipt does not match the current kit', 'EXPORT_KIT_SEAL_TAMPERED');
  }
  return identity;
}

export function buildSpecExportKitPromptSection(workspacePath: string, spec: JsonRecord): string {
  const identity = assertSealedSpecExportKit(workspacePath, spec);
  const sections = (['requirements', 'design', 'delivery'] as const).map((role) => {
    const artifact = readSpecExportKitArtifact(workspacePath, spec, role);
    return `=== ${role.toUpperCase()} (${artifact.contentHash}) ===\n${artifact.content.trim()}`;
  });
  return [
    '## Bound Rorca Export Kit',
    `Manifest: ${identity.manifestHash}`,
    `Spec material: ${identity.specMaterialHash}`,
    'This is the exact deterministic kit sealed to the canonical spec. Treat it as execution input; do not replace it with ambient or inferred requirements.',
    ...sections,
  ].join('\n\n');
}

