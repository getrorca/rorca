/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
/**
 * Local-only report validation, rendering, and exact-draft release authority.
 * `submission-ready` is a human readiness decision, never a submission effect.
 */
import { createHash } from 'node:crypto';
import type { BountyApprovalReceipt, BountyApprovalTarget } from './bounty-approvals';
import { bountyApprovalTargetHash } from './bounty-approvals';
import { canonicalizeBountyValue, hashBountyContract } from './bounty-contracts';
import { ForbiddenError, ValidationError } from './errors';

export const BOUNTY_REPORT_POLICY_VERSION = 'bounty.report.v1' as const;
export type ReportSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ReportUncertainty = 'none' | 'qualified' | 'unknown';

export interface AdmittedReportFinding {
  findingId: string;
  workspaceId: string;
  programId: string;
  missionId: string;
  admissionDecisionHash: string;
  admissionDisposition: 'admitted' | 'human-required';
  stopFenceCommitted: true;
}

export interface ReportEvidenceCitation {
  evidenceId: string;
  disposition: 'admitted';
  originalHash: string;
  redactedHash: string | null;
  rawProofRef: string;
  sensitivity: 'public' | 'program-confidential' | 'secret' | 'regulated';
  severityCeiling: ReportSeverity;
}

export interface ReportRedaction {
  redactionId: string;
  evidenceId: string;
  locator: string;
  reason: string;
  replacement: '[REDACTED]';
}

export interface EvidenceBoundReportClaim {
  text: string;
  evidenceIds: readonly string[];
  uncertainty: { status: ReportUncertainty; detail: string };
  redactionIds: readonly string[];
}

export interface BountyReportContent {
  title: string;
  rootCause: EvidenceBoundReportClaim;
  attacker: EvidenceBoundReportClaim;
  preconditions: readonly EvidenceBoundReportClaim[];
  asset: EvidenceBoundReportClaim;
  realizedImpact: EvidenceBoundReportClaim;
  rawProofReferences: readonly string[];
  remediation: readonly EvidenceBoundReportClaim[];
  deduplication: {
    result: 'unique' | 'duplicate' | 'unknown';
    duplicateOf: string | null;
    claim: EvidenceBoundReportClaim;
  };
  severity: { level: ReportSeverity; rationale: EvidenceBoundReportClaim };
}

export interface BountyReportDraft {
  policyVersion: typeof BOUNTY_REPORT_POLICY_VERSION;
  workspaceId: string;
  programId: string;
  missionId: string;
  findingId: string;
  admissionDecisionHash: string;
  revision: number;
  report: BountyReportContent;
  citationManifest: readonly ReportEvidenceCitation[];
  redactionManifest: readonly ReportRedaction[];
  markdown: string;
  canonicalJson: string;
  markdownHash: string;
  jsonHash: string;
  citationManifestHash: string;
  redactionManifestHash: string;
  bundleHash: string;
  releaseStatus: 'draft-unreleased';
}

export interface ReleasedBountyReportDraft extends Omit<BountyReportDraft, 'releaseStatus'> {
  releaseStatus: 'submission-ready';
  releaseReceiptId: string;
  releaseTargetHash: string;
  releasedBundleHash: string;
  releasedAt: string;
}

const HASH = /^sha256:[a-f0-9]{64}$/;
const MAX_DRAFT_BYTES = 1_000_000;
const severityRank: Readonly<Record<ReportSeverity, number>> = { low: 1, medium: 2, high: 3, critical: 4 };
const deepFreeze = <T>(value: T): Readonly<T> => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
const required = (value: string, label: string, max = 16_384): void => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ValidationError(`${label} is required and must be at most ${max} characters`);
};
const exactHash = (value: string, label: string): void => {
  if (!HASH.test(value)) throw new ValidationError(`${label} must be a SHA-256 digest`);
};
const bytesHash = (value: string): string => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

function claimList(report: BountyReportContent): Array<{ path: string; claim: EvidenceBoundReportClaim }> {
  return [
    { path: 'rootCause', claim: report.rootCause },
    { path: 'attacker', claim: report.attacker },
    ...report.preconditions.map((claim, index) => ({ path: `preconditions[${index}]`, claim })),
    { path: 'asset', claim: report.asset },
    { path: 'realizedImpact', claim: report.realizedImpact },
    ...report.remediation.map((claim, index) => ({ path: `remediation[${index}]`, claim })),
    { path: 'deduplication.claim', claim: report.deduplication.claim },
    { path: 'severity.rationale', claim: report.severity.rationale },
  ];
}

/** Enforce the complete report contract against admitted, raw-proof-addressable evidence only. */
export function validateBountyReport(input: {
  finding: AdmittedReportFinding;
  report: BountyReportContent;
  citations: readonly ReportEvidenceCitation[];
  redactions: readonly ReportRedaction[];
}): void {
  const { finding, report, citations, redactions } = input;
  for (const [value, label] of [[finding.findingId, 'findingId'], [finding.workspaceId, 'workspaceId'], [finding.programId, 'programId'], [finding.missionId, 'missionId']] as const) required(value, label, 256);
  exactHash(finding.admissionDecisionHash, 'admissionDecisionHash');
  if (!finding.stopFenceCommitted || !['admitted', 'human-required'].includes(finding.admissionDisposition)) throw new ForbiddenError('Report generation requires one admitted finding');
  required(report.title, 'title', 512);
  if (!report.rootCause || Array.isArray(report.rootCause)) throw new ValidationError('Exactly one root cause is required');
  if (!report.preconditions.length) throw new ValidationError('At least one precondition is required');
  if (!report.remediation.length) throw new ValidationError('At least one remediation is required');
  if (!['unique', 'duplicate', 'unknown'].includes(report.deduplication.result)) throw new ValidationError('Deduplication result is invalid');
  if (report.deduplication.result === 'duplicate' ? !report.deduplication.duplicateOf : report.deduplication.duplicateOf !== null) throw new ValidationError('Deduplication result and duplicate reference disagree');
  if (!Object.hasOwn(severityRank, report.severity.level)) throw new ValidationError('Severity is invalid');

  const citationById = new Map<string, ReportEvidenceCitation>();
  for (const citation of citations) {
    required(citation.evidenceId, 'citation evidenceId', 256);
    if (citationById.has(citation.evidenceId)) throw new ValidationError('Citation evidence IDs must be unique');
    if (citation.disposition !== 'admitted') throw new ForbiddenError('Every report citation must be admitted evidence');
    exactHash(citation.originalHash, 'citation originalHash');
    if (citation.redactedHash !== null) exactHash(citation.redactedHash, 'citation redactedHash');
    required(citation.rawProofRef, 'rawProofRef', 2048);
    if (!['public', 'program-confidential', 'secret', 'regulated'].includes(citation.sensitivity) || !Object.hasOwn(severityRank, citation.severityCeiling)) throw new ValidationError('Citation sensitivity or severity ceiling is invalid');
    if (citation.sensitivity !== 'public' && citation.redactedHash === null) throw new ForbiddenError('Sensitive evidence requires an admitted redacted representation');
    citationById.set(citation.evidenceId, citation);
  }
  if (!citationById.size) throw new ValidationError('At least one admitted evidence citation is required');

  const redactionById = new Map<string, ReportRedaction>();
  for (const redaction of redactions) {
    required(redaction.redactionId, 'redactionId', 256); required(redaction.locator, 'redaction locator', 2048); required(redaction.reason, 'redaction reason', 2048);
    if (redaction.replacement !== '[REDACTED]' || redactionById.has(redaction.redactionId)) throw new ValidationError('Redaction manifest entries must be unique and use the exact replacement token');
    if (!citationById.has(redaction.evidenceId)) throw new ValidationError('Redaction references evidence outside the citation manifest');
    redactionById.set(redaction.redactionId, redaction);
  }

  const rawRefs = new Set(report.rawProofReferences);
  if (!report.rawProofReferences.length || rawRefs.size !== report.rawProofReferences.length || report.rawProofReferences.some((id) => !citationById.has(id))) throw new ValidationError('Raw proof references must be unique admitted citation IDs');
  if (citations.some((citation) => !rawRefs.has(citation.evidenceId))) throw new ValidationError('Every cited evidence item must retain its raw proof reference');

  for (const { path, claim } of claimList(report)) {
    required(claim.text, `${path}.text`);
    required(claim.uncertainty.detail, `${path}.uncertainty.detail`, 4096);
    if (!['none', 'qualified', 'unknown'].includes(claim.uncertainty.status)) throw new ValidationError(`${path} has invalid uncertainty`);
    if (!claim.evidenceIds.length || new Set(claim.evidenceIds).size !== claim.evidenceIds.length || claim.evidenceIds.some((id) => !citationById.has(id))) throw new ValidationError(`${path} must cite unique admitted evidence`);
    if (new Set(claim.redactionIds).size !== claim.redactionIds.length) throw new ValidationError(`${path} repeats a redaction reference`);
    for (const redactionId of claim.redactionIds) {
      const redaction = redactionById.get(redactionId);
      if (!redaction || !claim.evidenceIds.includes(redaction.evidenceId)) throw new ValidationError(`${path} has an unbound redaction reference`);
    }
    const requiredRedactions = claim.evidenceIds.filter((id) => citationById.get(id)!.sensitivity !== 'public');
    if (requiredRedactions.some((id) => !claim.redactionIds.some((redactionId) => redactionById.get(redactionId)?.evidenceId === id))) throw new ForbiddenError(`${path} omits a sensitive-evidence redaction`);
  }
  if (report.realizedImpact.uncertainty.status === 'unknown') throw new ValidationError('Realized impact must be observed or explicitly qualified, not unknown');
  const severityEvidence = report.severity.rationale.evidenceIds.map((id) => citationById.get(id)!);
  const evidenceCeiling = Math.min(...severityEvidence.map((citation) => severityRank[citation.severityCeiling]));
  if (severityRank[report.severity.level] > evidenceCeiling) throw new ForbiddenError('Severity exceeds the ceiling supported by every cited evidence item');
}

function renderClaim(claim: EvidenceBoundReportClaim): string {
  const citations = claim.evidenceIds.map((id) => `[${id}]`).join(' ');
  const redactions = claim.redactionIds.length ? claim.redactionIds.join(', ') : 'none';
  return `${claim.text} ${citations}\n\n_Uncertainty (${claim.uncertainty.status}): ${claim.uncertainty.detail}; redactions: ${redactions}._`;
}

function renderMarkdown(report: BountyReportContent, citations: readonly ReportEvidenceCitation[], redactions: readonly ReportRedaction[]): string {
  const proof = report.rawProofReferences.map((id) => {
    const citation = citations.find((entry) => entry.evidenceId === id)!;
    return `- [${id}] ${citation.rawProofRef} (${citation.originalHash}; redacted: ${citation.redactedHash ?? 'none'})`;
  }).join('\n');
  const redactionLines = redactions.length ? redactions.map((entry) => `- ${entry.redactionId}: [${entry.evidenceId}] ${entry.locator} — ${entry.reason} → ${entry.replacement}`).join('\n') : '- none';
  return `# ${report.title}\n\n## Root cause\n${renderClaim(report.rootCause)}\n\n## Attacker\n${renderClaim(report.attacker)}\n\n## Preconditions\n${report.preconditions.map((claim, index) => `${index + 1}. ${renderClaim(claim)}`).join('\n')}\n\n## Affected asset\n${renderClaim(report.asset)}\n\n## Realized impact\n${renderClaim(report.realizedImpact)}\n\n## Raw proof references\n${proof}\n\n## Remediation\n${report.remediation.map((claim, index) => `${index + 1}. ${renderClaim(claim)}`).join('\n')}\n\n## Deduplication\nResult: **${report.deduplication.result}**${report.deduplication.duplicateOf ? ` (${report.deduplication.duplicateOf})` : ''}\n\n${renderClaim(report.deduplication.claim)}\n\n## Severity\n**${report.severity.level}**\n\n${renderClaim(report.severity.rationale)}\n\n## Redaction manifest\n${redactionLines}\n`;
}

function bundleHashInput(draft: Pick<BountyReportDraft, 'policyVersion' | 'workspaceId' | 'programId' | 'missionId' | 'findingId' | 'admissionDecisionHash' | 'revision' | 'markdownHash' | 'jsonHash' | 'citationManifestHash' | 'redactionManifestHash'>): unknown {
  return {
    policyVersion: draft.policyVersion, workspaceId: draft.workspaceId, programId: draft.programId, missionId: draft.missionId,
    findingId: draft.findingId, admissionDecisionHash: draft.admissionDecisionHash, revision: draft.revision,
    markdownHash: draft.markdownHash, jsonHash: draft.jsonHash, citationManifestHash: draft.citationManifestHash,
    redactionManifestHash: draft.redactionManifestHash,
  };
}

/** Deterministically generate non-releasable Markdown/JSON bytes without asking approval for bytes that do not yet exist. */
export function generateLocalBountyReportDraft(input: {
  finding: AdmittedReportFinding;
  revision: number;
  report: BountyReportContent;
  citations: readonly ReportEvidenceCitation[];
  redactions: readonly ReportRedaction[];
}): Readonly<BountyReportDraft> {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new ValidationError('Draft revision must be a positive integer');
  validateBountyReport(input);
  const citationManifest = structuredClone(input.citations);
  const redactionManifest = structuredClone(input.redactions);
  const report = structuredClone(input.report);
  const canonicalJson = canonicalizeBountyValue({ policyVersion: BOUNTY_REPORT_POLICY_VERSION, report, citationManifest, redactionManifest });
  const markdown = renderMarkdown(report, citationManifest, redactionManifest);
  if (Buffer.byteLength(markdown, 'utf8') > MAX_DRAFT_BYTES || Buffer.byteLength(canonicalJson, 'utf8') > MAX_DRAFT_BYTES) throw new ValidationError('Rendered report exceeds the 1 MB local draft limit');
  const hashes = {
    markdownHash: bytesHash(markdown), jsonHash: bytesHash(canonicalJson),
    citationManifestHash: hashBountyContract('report-citation-manifest', citationManifest),
    redactionManifestHash: hashBountyContract('report-redaction-manifest', redactionManifest),
  };
  const draft: BountyReportDraft = {
    policyVersion: BOUNTY_REPORT_POLICY_VERSION, workspaceId: input.finding.workspaceId, programId: input.finding.programId,
    missionId: input.finding.missionId, findingId: input.finding.findingId, admissionDecisionHash: input.finding.admissionDecisionHash,
    revision: input.revision, report, citationManifest, redactionManifest, markdown, canonicalJson, ...hashes,
    bundleHash: '', releaseStatus: 'draft-unreleased',
  };
  draft.bundleHash = hashBountyContract('report-draft-bundle', bundleHashInput(draft));
  return deepFreeze(draft);
}

export const BOUNTY_REPORT_POLICY_HASH = hashBountyContract('report-policy', {
  version: BOUNTY_REPORT_POLICY_VERSION,
  required: ['one-root-cause', 'attacker', 'preconditions', 'asset', 'realized-impact', 'raw-proof', 'remediation', 'deduplication', 'evidence-bound-severity', 'uncertainty', 'redaction'],
});

/** Build the exact approval target only after immutable draft bytes and manifests exist. */
export function bountyReportReleaseTarget(draft: BountyReportDraft, requesterId: string, target: Pick<BountyApprovalTarget, 'nonce' | 'issuedAt' | 'expiresAt'>): BountyApprovalTarget {
  required(requesterId, 'requesterId', 128);
  assertExactBountyReportDraft(draft);
  return {
    version: 'bounty.approval.v1', workspaceId: draft.workspaceId, programId: draft.programId, missionId: draft.missionId,
    action: 'draft.release', subjectHash: draft.bundleHash, policyHash: BOUNTY_REPORT_POLICY_HASH,
    expectedRevision: draft.revision, requesterId, ...target,
  };
}

/** Recompute every exact-byte/manfiest binding; this is also the edit-invalidation check. */
export function assertExactBountyReportDraft(draft: BountyReportDraft | ReleasedBountyReportDraft): void {
  validateBountyReport({ finding: {
    findingId: draft.findingId, workspaceId: draft.workspaceId, programId: draft.programId, missionId: draft.missionId,
    admissionDecisionHash: draft.admissionDecisionHash, admissionDisposition: 'admitted', stopFenceCommitted: true,
  }, report: draft.report, citations: draft.citationManifest, redactions: draft.redactionManifest });
  const expectedJson = canonicalizeBountyValue({ policyVersion: BOUNTY_REPORT_POLICY_VERSION, report: draft.report, citationManifest: draft.citationManifest, redactionManifest: draft.redactionManifest });
  const expectedMarkdown = renderMarkdown(draft.report, draft.citationManifest, draft.redactionManifest);
  if (draft.canonicalJson !== expectedJson || draft.markdown !== expectedMarkdown) throw new ForbiddenError('Draft bytes no longer render from the exact report and manifests');
  const expected = {
    markdownHash: bytesHash(draft.markdown), jsonHash: bytesHash(draft.canonicalJson),
    citationManifestHash: hashBountyContract('report-citation-manifest', draft.citationManifest),
    redactionManifestHash: hashBountyContract('report-redaction-manifest', draft.redactionManifest),
  };
  if (draft.policyVersion !== BOUNTY_REPORT_POLICY_VERSION || Object.entries(expected).some(([key, value]) => draft[key as keyof typeof expected] !== value)) throw new ForbiddenError('Draft bytes or manifests changed after generation');
  if (hashBountyContract('report-draft-bundle', bundleHashInput(draft)) !== draft.bundleHash) throw new ForbiddenError('Draft exact bundle binding is invalid');
}

/** Convert an exact draft to submission-ready after a verified provider-human receipt; no submission occurs. */
export function releaseExactBountyReportDraft(draft: BountyReportDraft, receipt: BountyApprovalReceipt, now = new Date()): Readonly<ReleasedBountyReportDraft> {
  assertExactBountyReportDraft(draft);
  const target = receipt.target;
  const targetHash = bountyApprovalTargetHash(target);
  if (receipt.revokedAt || receipt.consumedAt || Date.parse(target.expiresAt) <= now.getTime()) throw new ForbiddenError('Draft release approval is unavailable, consumed, revoked, or expired');
  if (target.action !== 'draft.release' || target.workspaceId !== draft.workspaceId || target.programId !== draft.programId || target.missionId !== draft.missionId
      || target.subjectHash !== draft.bundleHash || target.policyHash !== BOUNTY_REPORT_POLICY_HASH || target.expectedRevision !== draft.revision
      || receipt.targetHash !== targetHash || receipt.providerEvent.targetHash !== targetHash || receipt.providerEvent.actor.kind !== 'provider_human') {
    throw new ForbiddenError('Provider-human readiness decision does not bind the exact draft, citations, redactions, and revision');
  }
  return deepFreeze({ ...draft, releaseStatus: 'submission-ready', releaseReceiptId: receipt.receiptId, releaseTargetHash: targetHash, releasedBundleHash: draft.bundleHash, releasedAt: now.toISOString() });
}

/** A released projection is valid only while all exact bytes and hashes still match its approval. */
export function bountyReportReleaseStatus(draft: BountyReportDraft | ReleasedBountyReportDraft): 'draft-unreleased' | 'submission-ready' | 'invalidated' {
  if (draft.releaseStatus !== 'submission-ready') return 'draft-unreleased';
  try {
    assertExactBountyReportDraft(draft);
    return draft.releasedBundleHash === draft.bundleHash ? 'submission-ready' : 'invalidated';
  } catch { return 'invalidated'; }
}

export const BOUNTY_REPORTER_FORBIDDEN_CAPABILITIES = Object.freeze([
  'network', 'broker', 'browser', 'credential', 'clipboard', 'email', 'chat', 'platform', 'subprocess', 'unrestricted-subprocess', 'external-submit',
] as const);
export const BOUNTY_REPORT_OPERATION_INVENTORY = Object.freeze([
  { id: 'report.validate', runtime: 'reporter', capabilities: ['local-compute'], calls: [] },
  { id: 'report.render-markdown-json', runtime: 'reporter', capabilities: ['local-compute'], calls: ['report.validate'] },
  { id: 'report.persist-immutable', runtime: 'controller', capabilities: ['local-db:write'], calls: ['report.render-markdown-json'] },
  { id: 'report.mark-submission-ready', runtime: 'controller', capabilities: ['local-db:read', 'local-db:write'], calls: ['report.persist-immutable'] },
] as const);
/** No bounty report operation is exposed as a public/MCP tool. External submission is manual. */
export const BOUNTY_REPORT_PUBLIC_TOOL_INVENTORY = Object.freeze([] as readonly never[]);

/** Fail closed if a future direct or transitive operation introduces a submission/egress capability. */
export function assertBountyReportCapabilityInventory(): void {
  const operations = new Map<string, typeof BOUNTY_REPORT_OPERATION_INVENTORY[number]>(BOUNTY_REPORT_OPERATION_INVENTORY.map((operation) => [operation.id, operation]));
  const visit = (id: string, seen = new Set<string>()): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const operation = operations.get(id);
    if (!operation || /submit|send|publish|platform/i.test(operation.id)) throw new ForbiddenError(`Uninventoried or submission-capable report operation: ${id}`);
    for (const capability of operation.capabilities) {
      if (BOUNTY_REPORTER_FORBIDDEN_CAPABILITIES.some((denied) => capability.includes(denied))) throw new ForbiddenError(`Forbidden report capability: ${capability}`);
    }
    for (const called of operation.calls) visit(called, seen);
  };
  for (const operation of BOUNTY_REPORT_OPERATION_INVENTORY) visit(operation.id);
  if (BOUNTY_REPORT_PUBLIC_TOOL_INVENTORY.length !== 0) throw new ForbiddenError('Bounty report public tools must remain empty');
}

assertBountyReportCapabilityInventory();
