/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Neutral optional adapter for the separately installed engineering canon. */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { loadRorcaConfig } from './rorca-config';
import type { Skill } from './skill-registry';

export const ENGINEERING_CANON_PACKAGE = '@rorca/engineering-canon';
const SUPPORTED_CANON_SCHEMA_VERSION = '1.0.0';
const SUPPORTED_TAXONOMY_VERSION = '1.0.0';
const SUPPORTED_RECEIPT_VERSION = '1.0.0';
const MAX_CELLS = 100;
const MAX_REASONS = 100;
const CANON_VALUES = {
  phases: ['intake', 'requirements', 'architecture', 'implementation', 'validation', 'security', 'staging', 'qa', 'merge', 'production', 'learn'],
  artifactTypes: ['prd', 'requirements', 'ux-flow', 'accessibility-review', 'sdd', 'adr', 'code', 'test', 'release', 'runbook', 'memory', 'api-contract', 'data-model', 'migration', 'infrastructure', 'data-pipeline', 'event-contract', 'model-card', 'policy', 'evidence-package'],
  riskCategories: ['security', 'privacy', 'safety', 'reliability', 'data-integrity', 'accessibility', 'compliance', 'financial', 'operational', 'performance', 'maintainability', 'product'],
  changedSurfaces: ['ui', 'api', 'authentication', 'authorization', 'data-model', 'migration', 'messaging', 'infrastructure', 'delivery-pipeline', 'model-agent', 'observability', 'documentation'],
  technologies: ['frontend-web', 'mobile', 'distributed-systems', 'databases', 'event-streaming', 'cloud-infrastructure', 'data-engineering', 'ml-agentic'],
  domains: ['healthcare', 'fintech', 'regulated-privacy'],
  obligations: ['access-control', 'auditability', 'consent', 'data-residency', 'data-retention', 'financial-controls', 'human-oversight', 'incident-reporting', 'least-privilege', 'records-management', 'safety-case'],
  operations: ['author', 'review', 'evidence'],
  evidenceClasses: ['artifact', 'decision', 'code', 'test', 'trace', 'security-analysis', 'operational-readiness', 'approval', 'runtime-observation', 'genesis-approved-package', 'exception-receipt'],
} as const;

type CanonConfig = ReturnType<typeof loadRorcaConfig>['engineeringCanon'];
type CanonStatus = 'available' | 'degraded';

export interface EngineeringCanonCoverage {
  adapterStatus: CanonStatus;
  reasonCode?: 'disabled' | 'package_unavailable' | 'package_invalid' | 'request_incomplete' | 'resolver_failed';
  message?: string;
  receipt: Record<string, unknown> | null;
  selectedLayers: Array<{ id: string; version: string; layer: string; hash: string }>;
  coveredCells: Array<{ requirementId: string; overlayId: string; operation: string; resolution: 'covered' | 'not_applicable_confirmed' }>;
  uncoveredCells: unknown[];
  omissions: unknown[];
  domainAuthority: { requestedDomains: string[]; approvedAuthorityIds: string[] };
  evidenceProvenance: { evidenceIds: string[]; genesisPackageIds: string[]; redacted: true };
  compatibility: { compatible: boolean; versionSkew: string[]; conflicts: string[] };
  version: { canon: string | null; taxonomy: string | null; receiptHash: string | null };
  nextActions: Array<{ code: string; label: string; blocking: false }>;
}

interface CanonModule {
  resolveSufficiency(input: unknown): Record<string, unknown>;
  CANON_SCHEMA_VERSION: string;
  COVERAGE_TAXONOMY_VERSION: string;
  STARTER_OVERLAY_MANIFESTS?: Array<Record<string, unknown>>;
  SufficiencyReceiptSchema: { parse(value: unknown): Record<string, unknown> };
  SufficiencyRequestSchema: { parse(value: unknown): Record<string, unknown> };
  contentHash(value: unknown): string;
  hasValidContentHash(value: unknown): boolean;
}

function uniqueKnown(raw: unknown, allowed: readonly string[], max = 30): string[] {
  if (!Array.isArray(raw)) return [];
  const set = new Set(allowed);
  return [...new Set(raw.filter((v): v is string => typeof v === 'string').map(v => v.trim().toLowerCase()).filter(v => set.has(v)))].sort().slice(0, max);
}

function records(raw: unknown, max: number): Record<string, unknown>[] {
  return Array.isArray(raw) ? raw.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)).slice(0, max) : [];
}

function hasUnknown(raw: unknown, allowed: readonly string[]): boolean {
  if (raw === undefined || raw === null) return false;
  if (!Array.isArray(raw)) return true;
  const known = new Set(allowed);
  return raw.some(value => typeof value !== 'string' || !known.has(value.trim().toLowerCase()));
}

function hasSymlinkComponent(absolutePath: string): boolean {
  const parsed = path.parse(absolutePath);
  let current = parsed.root;
  for (const segment of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

function canonicalRoot(config: CanonConfig): string | null {
  const configured = config.packageRoot || process.env.RORCA_ENGINEERING_CANON_PACKAGE_ROOT;
  if (!configured || !path.isAbsolute(configured)) return null;
  try {
    if (hasSymlinkComponent(configured)) return null;
    const root = fs.realpathSync(configured);
    const stat = fs.lstatSync(configured);
    if (stat.isSymbolicLink() || !fs.statSync(root).isDirectory()) return null;
    const manifestPath = path.join(root, 'package.json');
    if (fs.lstatSync(manifestPath).isSymbolicLink()) return null;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { name?: string; main?: string };
    return manifest.name === ENGINEERING_CANON_PACKAGE && manifest.main === './dist/index.js' ? root : null;
  } catch { return null; }
}

export function engineeringCanonSkillRoot(workspacePath: string): string | null {
  const config = loadRorcaConfig(workspacePath).engineeringCanon;
  if (!config.enabled) return null;
  const root = canonicalRoot(config);
  if (!root) return null;
  const requested = config.skillRoot ? path.resolve(root, config.skillRoot) : path.join(root, 'skills');
  try {
    if (fs.lstatSync(requested).isSymbolicLink()) return null;
    const real = fs.realpathSync(requested);
    const relative = path.relative(root, real);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) && fs.statSync(real).isDirectory() ? real : null;
  } catch { return null; }
}

async function loadCanon(workspacePath: string): Promise<{ module: CanonModule; root: string } | null> {
  const config = loadRorcaConfig(workspacePath).engineeringCanon;
  if (!config.enabled) return null;
  const configuredRoot = config.packageRoot || process.env.RORCA_ENGINEERING_CANON_PACKAGE_ROOT;
  const root = canonicalRoot(config);
  if (configuredRoot && !root) return null;
  let specifier = ENGINEERING_CANON_PACKAGE;
  try {
    if (root) {
      const entry = path.join(root, 'dist', 'index.js');
      if (fs.lstatSync(entry).isSymbolicLink()) return null;
      const realEntry = fs.realpathSync(entry);
      const relative = path.relative(root, realEntry);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(realEntry).isFile()) return null;
      specifier = pathToFileURL(realEntry).href;
    }
    // Preserve native ESM loading when this CommonJS backend is compiled.
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (value: string) => Promise<unknown>;
    const loaded = await dynamicImport(specifier) as Partial<CanonModule>;
    if (typeof loaded.resolveSufficiency !== 'function' || typeof loaded.CANON_SCHEMA_VERSION !== 'string' || typeof loaded.COVERAGE_TAXONOMY_VERSION !== 'string'
      || typeof loaded.SufficiencyReceiptSchema?.parse !== 'function' || typeof loaded.SufficiencyRequestSchema?.parse !== 'function'
      || typeof loaded.contentHash !== 'function' || typeof loaded.hasValidContentHash !== 'function'
      || loaded.CANON_SCHEMA_VERSION !== SUPPORTED_CANON_SCHEMA_VERSION
      || loaded.COVERAGE_TAXONOMY_VERSION !== SUPPORTED_TAXONOMY_VERSION) return null;
    return { module: loaded as CanonModule, root: root ?? ENGINEERING_CANON_PACKAGE };
  } catch { return null; }
}

function idFor(workspaceId: string, specId: string, storyId?: string, runId?: number): string {
  const hash = crypto.createHash('sha256').update(JSON.stringify({ workspaceId, specId, storyId: storyId ?? null, runId: runId ?? null })).digest('hex').slice(0, 24);
  return `request.rorca.${hash}`;
}

function availableSkills(skills: Skill[]): Record<string, unknown>[] {
  return skills.slice(0, 300).map(skill => ({
    id: skill.governance?.canonSkillId ?? `legacy.skill.${skill.metadata.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`,
    version: skill.governance?.version ?? '1.0.0',
    status: skill.governance
      ? skill.governance.status === 'active' && skill.governance.promotionVerified === true ? 'active' : 'candidate'
      : 'active',
    ...(skill.governance?.promotionReceiptId && skill.governance.promotionVerified === true ? { promotionReceiptId: skill.governance.promotionReceiptId } : {}),
  })).sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

export async function resolveEngineeringCanonCoverage(input: {
  workspacePath: string;
  workspaceId: string;
  specId: string;
  storyId?: string;
  runId?: number;
  metadata?: Record<string, unknown>;
  skills: Skill[];
}): Promise<EngineeringCanonCoverage> {
  const config = loadRorcaConfig(input.workspacePath).engineeringCanon;
  const loaded = await loadCanon(input.workspacePath);
  if (!loaded) return degraded(config.enabled ? 'package_unavailable' : 'disabled', config.enabled ? 'Optional engineering canon package is unavailable or invalid.' : 'Engineering canon integration is disabled.');
  const meta = input.metadata ?? {};
  // Approval-bearing inputs must come from authoritative stores. Until those
  // adapters are wired, remain honestly empty; spec-authored booleans never cross.
  const evidence: Record<string, unknown>[] = [];
  const genesisEvidence: Record<string, unknown>[] = [];
  const domainAuthorities: Record<string, unknown>[] = [];
  const notApplicableConfirmations: Record<string, unknown>[] = [];
  const rawPhases = meta.lifecyclePhases ?? meta.phases;
  const rawArtifacts = meta.artifactTypes ?? meta.artifacts;
  const rawRisks = meta.riskCategories ?? meta.risks;
  const rawSurfaces = meta.changedSurfaces;
  const rawTechnologies = meta.technologies;
  const rawDomains = meta.domains;
  const rawObligations = meta.obligations;
  const rawOperations = meta.operations;
  const phases = uniqueKnown(rawPhases, CANON_VALUES.phases, 11);
  const artifactTypes = uniqueKnown(rawArtifacts, CANON_VALUES.artifactTypes);
  const operations = uniqueKnown(rawOperations, CANON_VALUES.operations, 3);
  const unknownDeclaredScope = hasUnknown(rawPhases, CANON_VALUES.phases) || hasUnknown(rawArtifacts, CANON_VALUES.artifactTypes)
    || hasUnknown(rawRisks, CANON_VALUES.riskCategories) || hasUnknown(rawSurfaces, CANON_VALUES.changedSurfaces)
    || hasUnknown(rawTechnologies, CANON_VALUES.technologies) || hasUnknown(rawDomains, CANON_VALUES.domains)
    || hasUnknown(rawObligations, CANON_VALUES.obligations) || hasUnknown(rawOperations, CANON_VALUES.operations);
  if (unknownDeclaredScope || phases.length === 0 || artifactTypes.length === 0 || operations.length === 0) {
    return degraded('request_incomplete', 'Canonical phase, artifact type, or operation is unknown; coverage cannot be reported sufficient.');
  }
  const request = {
    artifact: 'engineering-canon.sufficiency-request', schemaVersion: loaded.module.CANON_SCHEMA_VERSION,
    id: idFor(input.workspaceId, input.specId, input.storyId, input.runId), canonVersion: loaded.module.CANON_SCHEMA_VERSION,
    taxonomyVersion: loaded.module.COVERAGE_TAXONOMY_VERSION,
    phases,
    artifactTypes,
    riskCategories: uniqueKnown(rawRisks, CANON_VALUES.riskCategories),
    changedSurfaces: uniqueKnown(rawSurfaces, CANON_VALUES.changedSurfaces),
    technologies: uniqueKnown(rawTechnologies, CANON_VALUES.technologies),
    domains: uniqueKnown(rawDomains, CANON_VALUES.domains), obligations: uniqueKnown(rawObligations, CANON_VALUES.obligations),
    operations,
    evidence, availableSkills: availableSkills(input.skills),
    domainAuthorities,
    notApplicableConfirmations,
    tokenBudget: { max: config.tokenBudget, reserved: config.reservedTokens }, host: 'rorca', redactionApplied: true,
  };
  try {
    const parsedRequest = loaded.module.SufficiencyRequestSchema.parse(request);
    const expectedRequestHash = loaded.module.contentHash(parsedRequest);
    const rawReceipt = loaded.module.resolveSufficiency(parsedRequest);
    if (Buffer.byteLength(JSON.stringify(rawReceipt), 'utf8') > 1024 * 1024) throw new Error('resolver receipt exceeds 1 MiB limit');
    const receipt = loaded.module.SufficiencyReceiptSchema.parse(rawReceipt);
    const provenance = receipt.provenance && typeof receipt.provenance === 'object' && !Array.isArray(receipt.provenance) ? receipt.provenance as Record<string, unknown> : {};
    if (receipt.requestId !== parsedRequest.id || receipt.requestHash !== expectedRequestHash
      || receipt.schemaVersion !== SUPPORTED_CANON_SCHEMA_VERSION || receipt.version !== SUPPORTED_RECEIPT_VERSION
      || !loaded.module.hasValidContentHash(receipt)
      || provenance.canonVersion !== loaded.module.CANON_SCHEMA_VERSION
      || provenance.taxonomyVersion !== loaded.module.COVERAGE_TAXONOMY_VERSION) {
      throw new Error('resolver receipt identity, hash, or provenance does not match the bounded request');
    }
    return surfaceReceipt(receipt, request.domains, genesisEvidence, request.domainAuthorities, request.operations, loaded.module.STARTER_OVERLAY_MANIFESTS ?? []);
  } catch (error) {
    return degraded('resolver_failed', `Engineering canon resolver rejected the bounded request: ${error instanceof Error ? error.message.slice(0, 240) : 'unknown error'}`);
  }
}

function degraded(reasonCode: EngineeringCanonCoverage['reasonCode'], message: string): EngineeringCanonCoverage {
  const nextAction = reasonCode === 'request_incomplete'
    ? { code: 'classify_bounded_request', label: 'Provide canonical lifecycle phase, artifact type, and operation metadata.', blocking: false as const }
    : reasonCode === 'disabled'
      ? { code: 'enable_canon_if_desired', label: 'Enable the optional engineering canon adapter to evaluate bounded coverage.', blocking: false as const }
      : { code: 'install_or_configure_canon', label: 'Install and configure a compatible engineering canon package.', blocking: false as const };
  return { adapterStatus: 'degraded', reasonCode, message, receipt: null, selectedLayers: [], coveredCells: [], uncoveredCells: [], omissions: [], domainAuthority: { requestedDomains: [], approvedAuthorityIds: [] }, evidenceProvenance: { evidenceIds: [], genesisPackageIds: [], redacted: true }, compatibility: { compatible: false, versionSkew: [], conflicts: [] }, version: { canon: null, taxonomy: null, receiptHash: null }, nextActions: [nextAction] };
}

function surfaceReceipt(receipt: Record<string, unknown>, requestedDomains: string[], genesisEvidence: Record<string, unknown>[], domainAuthorities: Record<string, unknown>[], operations: string[], overlays: Array<Record<string, unknown>>): EngineeringCanonCoverage {
  const provenance = (receipt.provenance && typeof receipt.provenance === 'object' ? receipt.provenance : {}) as Record<string, unknown>;
  const compatibility = (receipt.compatibility && typeof receipt.compatibility === 'object' ? receipt.compatibility : {}) as Record<string, unknown>;
  const cells = records(receipt.uncoveredCells, MAX_CELLS).map(item => ({
    requirementId: String(item.requirementId ?? '').slice(0, 200),
    overlayId: String(item.overlayId ?? '').slice(0, 200),
    operation: String(item.operation ?? '').slice(0, 40),
    disposition: item.disposition === 'advisory' ? 'advisory' : 'required',
    gaps: Array.isArray(item.gaps) ? item.gaps.filter(value => typeof value === 'string').map(value => value.slice(0, 40)).slice(0, 10) : [],
  }));
  const selectedLayers = records(provenance.overlayReceipts, MAX_CELLS).map(item => ({ id: String(item.id ?? '').slice(0, 200), version: String(item.version ?? '').slice(0, 40), layer: String(item.layer ?? '').slice(0, 40), hash: String(item.hash ?? '').slice(0, 80) }));
  const selectedOverlayIds = new Set(selectedLayers.map(item => item.id));
  const uncoveredIds = new Set(cells.map(item => `${String(item.overlayId)}:${String(item.requirementId)}`));
  const coveredCells = overlays.filter(overlay => selectedOverlayIds.has(String(overlay.id))).flatMap(overlay =>
    records(overlay.requirements, MAX_CELLS).filter(requirement => operations.includes(String(requirement.operation))
      && !uncoveredIds.has(`${String(overlay.id)}:${String(requirement.id)}`)).map(requirement => ({
      requirementId: String(requirement.id), overlayId: String(overlay.id), operation: String(requirement.operation),
      resolution: receipt.status === 'not_applicable_confirmed' ? 'not_applicable_confirmed' as const : 'covered' as const,
    }))).slice(0, MAX_CELLS);
  const status = String(receipt.status ?? 'insufficient_evidence');
  const gapActions = new Set(cells.flatMap(cell => Array.isArray(cell.gaps) ? cell.gaps.filter(v => typeof v === 'string') : []));
  const actions: EngineeringCanonCoverage['nextActions'] = [];
  if (gapActions.has('missing_skill')) actions.push({ code: 'review_and_promote_required_skill', label: 'Review required candidate skills and attach genuine promotion receipts.', blocking: false });
  if (gapActions.has('missing_domain_authority')) actions.push({ code: 'attach_approved_domain_authority', label: 'Attach an approved domain authority receipt.', blocking: false });
  if (gapActions.has('insufficient_evidence')) actions.push({ code: 'attach_approved_evidence', label: 'Attach approved evidence in the required classes.', blocking: false });
  if (gapActions.has('token_omission')) actions.push({ code: 'increase_bounded_token_budget', label: 'Increase the bounded canon token budget or narrow the declared scope.', blocking: false });
  if (gapActions.has('version_skew') || gapActions.has('conflict')) actions.push({ code: 'resolve_compatibility', label: 'Resolve canon version skew or binding rule conflicts.', blocking: false });
  const evidenceIds = Array.isArray(provenance.evidenceIds) ? provenance.evidenceIds.filter(v => typeof v === 'string').slice(0, 100) : [];
  const receiptProjection = {
    artifact: receipt.artifact, schemaVersion: receipt.schemaVersion, id: receipt.id, version: receipt.version,
    contentHash: receipt.contentHash, requestId: receipt.requestId, requestHash: receipt.requestHash,
    status: receipt.status, scopeClaim: receipt.scopeClaim,
    reasons: Array.isArray(receipt.reasons) ? receipt.reasons.slice(0, MAX_REASONS).map(() => 'redacted_bounded_reason_available_in_uncovered_cells') : [],
    selectedSkillIds: Array.isArray(receipt.selectedSkillIds) ? receipt.selectedSkillIds.filter(value => typeof value === 'string').slice(0, 100) : [],
    selectedBundleIds: Array.isArray(receipt.selectedBundleIds) ? receipt.selectedBundleIds.filter(value => typeof value === 'string').slice(0, 100) : [],
    tokenBudget: receipt.tokenBudget,
    compatibility: { compatible: compatibility.compatible === true, versionSkew: Array.isArray(compatibility.versionSkew) ? compatibility.versionSkew.slice(0, 100).map(() => 'version_skew_detected') : [], conflicts: Array.isArray(compatibility.conflicts) ? compatibility.conflicts.slice(0, 100).map(() => 'binding_conflict_detected') : [] },
    provenance: { taxonomyVersion: provenance.taxonomyVersion, canonVersion: provenance.canonVersion, overlayReceipts: selectedLayers, evidenceIds, deterministicOrder: provenance.deterministicOrder, redacted: true },
  };
  return {
    adapterStatus: 'available', receipt: receiptProjection,
    selectedLayers, coveredCells,
    uncoveredCells: cells, omissions: records(receipt.omissions, MAX_CELLS).map(item => ({ id: String(item.id ?? '').slice(0, 200), required: item.required === true, reason: 'bounded_token_omission' })),
    domainAuthority: { requestedDomains, approvedAuthorityIds: domainAuthorities.filter(item => item.approved === true && typeof item.id === 'string').map(item => String(item.id)).slice(0, 100) },
    evidenceProvenance: { evidenceIds, genesisPackageIds: genesisEvidence.map(item => String((item.genesis as Record<string, unknown>).packageId ?? '')).filter(Boolean).slice(0, 100), redacted: true },
    compatibility: { compatible: compatibility.compatible === true, versionSkew: Array.isArray(compatibility.versionSkew) ? compatibility.versionSkew.slice(0, 100).map(() => 'version_skew_detected') : [], conflicts: Array.isArray(compatibility.conflicts) ? compatibility.conflicts.slice(0, 100).map(() => 'binding_conflict_detected') : [] },
    version: { canon: typeof provenance.canonVersion === 'string' ? provenance.canonVersion : null, taxonomy: typeof provenance.taxonomyVersion === 'string' ? provenance.taxonomyVersion : null, receiptHash: typeof receipt.contentHash === 'string' ? receipt.contentHash : null },
    nextActions: actions.length ? actions : status === 'sufficient' || status === 'not_applicable_confirmed' ? [] : [{ code: 'inspect_uncovered_cells', label: 'Inspect bounded uncovered cells and provide missing evidence.', blocking: false }],
  };
}
