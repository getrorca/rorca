/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bountyApprovalTargetHash, type BountyApprovalReceipt } from '../bounty-approvals';
import {
  BOUNTY_REPORT_OPERATION_INVENTORY,
  BOUNTY_REPORT_POLICY_HASH,
  BOUNTY_REPORT_PUBLIC_TOOL_INVENTORY,
  assertBountyReportCapabilityInventory,
  bountyReportReleaseStatus,
  bountyReportReleaseTarget,
  generateLocalBountyReportDraft,
  releaseExactBountyReportDraft,
  type AdmittedReportFinding,
  type BountyReportContent,
  type EvidenceBoundReportClaim,
  type ReportEvidenceCitation,
  type ReportRedaction,
} from '../bounty-report-release';

const hash = (character: string): string => `sha256:${character.repeat(64)}`;
const finding: AdmittedReportFinding = {
  findingId: 'finding-1', workspaceId: 'workspace-1', programId: 'program-1', missionId: 'mission-1',
  admissionDecisionHash: hash('a'), admissionDisposition: 'admitted', stopFenceCommitted: true,
};
const citations: ReportEvidenceCitation[] = [
  { evidenceId: 'evidence-public', disposition: 'admitted', originalHash: hash('b'), redactedHash: null, rawProofRef: 'vault://evidence/public', sensitivity: 'public', severityCeiling: 'high' },
  { evidenceId: 'evidence-sensitive', disposition: 'admitted', originalHash: hash('c'), redactedHash: hash('d'), rawProofRef: 'vault://evidence/sensitive', sensitivity: 'program-confidential', severityCeiling: 'high' },
];
const redactions: ReportRedaction[] = [
  { redactionId: 'redaction-1', evidenceId: 'evidence-sensitive', locator: 'response.headers.authorization', reason: 'Credential material is not reportable', replacement: '[REDACTED]' },
];
const claim = (text: string, sensitive = false, status: EvidenceBoundReportClaim['uncertainty']['status'] = 'qualified'): EvidenceBoundReportClaim => ({
  text,
  evidenceIds: sensitive ? ['evidence-sensitive'] : ['evidence-public'],
  uncertainty: { status, detail: status === 'none' ? 'No unresolved qualification in the cited observation.' : 'The conclusion is limited to the reproduced requests and tested principals.' },
  redactionIds: sensitive ? ['redaction-1'] : [],
});
const report = (): BountyReportContent => ({
  title: 'Cross-account invoice disclosure',
  rootCause: claim('The object lookup does not enforce the authenticated account boundary.'),
  attacker: claim('An authenticated low-privilege account can make the reproduced request.'),
  preconditions: [claim('The attacker knows an invoice identifier from its own account.')],
  asset: claim('Invoice records belonging to a different account are affected.'),
  realizedImpact: claim('A second account invoice body was returned to the test attacker.', true),
  rawProofReferences: ['evidence-public', 'evidence-sensitive'],
  remediation: [claim('Enforce account ownership in the object lookup and add a cross-account denial test.')],
  deduplication: { result: 'unique', duplicateOf: null, claim: claim('No admitted finding has the same root cause and affected asset.') },
  severity: { level: 'high', rationale: claim('The observed cross-account disclosure supports high severity.', true) },
});

function draft() {
  return generateLocalBountyReportDraft({ finding, revision: 1, report: report(), citations, redactions });
}

function approval(exactDraft = draft()): BountyApprovalReceipt {
  const target = bountyReportReleaseTarget(exactDraft, 'requester-1', {
    nonce: '00000000-0000-4000-8000-000000000001',
    issuedAt: '2026-08-03T00:00:00.000Z', expiresAt: '2026-08-03T00:05:00.000Z',
  });
  const targetHash = bountyApprovalTargetHash(target);
  return {
    receiptId: 'receipt-1', target, targetHash,
    providerEvent: {
      eventId: '00000000-0000-4000-8000-000000000002', targetHash, decision: 'approve',
      actor: { id: 'provider-human-1', role: 'program_manager', kind: 'provider_human' },
      signedAt: '2026-08-03T00:01:00.000Z', signature: 'exact-provider-signature',
    },
  };
}

test('local generation needs an admitted finding but never approval of nonexistent draft bytes', () => {
  const generated = draft();
  assert.equal(generated.releaseStatus, 'draft-unreleased');
  assert.match(generated.markdown, /## Root cause/);
  assert.match(generated.markdown, /vault:\/\/evidence\/sensitive/);
  assert.match(generated.markdown, /Uncertainty \(qualified\)/);
  assert.match(generated.markdown, /\[REDACTED\]/);
  assert.ok(generated.canonicalJson.length > 0);
  assert.throws(() => generateLocalBountyReportDraft({ finding: { ...finding, stopFenceCommitted: false as true }, revision: 1, report: report(), citations, redactions }), /admitted finding/);
  assert.equal('approval' in generated, false);
});

test('validator requires complete evidence-bound claims, raw proof, redaction, dedup, and conservative severity', () => {
  const omitCitation = report();
  omitCitation.rootCause = { ...omitCitation.rootCause, evidenceIds: [] };
  assert.throws(() => generateLocalBountyReportDraft({ finding, revision: 1, report: omitCitation, citations, redactions }), /must cite/);

  const noPreconditions = { ...report(), preconditions: [] };
  assert.throws(() => generateLocalBountyReportDraft({ finding, revision: 1, report: noPreconditions, citations, redactions }), /precondition/);
  const noRemediation = { ...report(), remediation: [] };
  assert.throws(() => generateLocalBountyReportDraft({ finding, revision: 1, report: noRemediation, citations, redactions }), /remediation/);
  const noRawProof = { ...report(), rawProofReferences: ['evidence-public'] };
  assert.throws(() => generateLocalBountyReportDraft({ finding, revision: 1, report: noRawProof, citations, redactions }), /raw proof/i);

  const leakedRedaction = report();
  leakedRedaction.realizedImpact = { ...leakedRedaction.realizedImpact, redactionIds: [] };
  assert.throws(() => generateLocalBountyReportDraft({ finding, revision: 1, report: leakedRedaction, citations, redactions }), /redaction/);
  const uncertainImpact = report();
  uncertainImpact.realizedImpact = claim('Impact may exist.', true, 'unknown');
  assert.throws(() => generateLocalBountyReportDraft({ finding, revision: 1, report: uncertainImpact, citations, redactions }), /Realized impact/);

  const duplicateMismatch = report();
  duplicateMismatch.deduplication = { ...duplicateMismatch.deduplication, result: 'duplicate' };
  assert.throws(() => generateLocalBountyReportDraft({ finding, revision: 1, report: duplicateMismatch, citations, redactions }), /Deduplication/);
  const inflatedSeverity = report();
  inflatedSeverity.severity = { ...inflatedSeverity.severity, level: 'critical' };
  assert.throws(() => generateLocalBountyReportDraft({ finding, revision: 1, report: inflatedSeverity, citations, redactions }), /Severity exceeds/);
  assert.throws(() => generateLocalBountyReportDraft({ finding, revision: 1, report: report(), citations: citations.map((entry) => ({ ...entry, disposition: 'rejected' as 'admitted' })), redactions }), /admitted evidence/);
});

test('provider-human readiness binds exact draft, citation and redaction manifests after generation', () => {
  const generated = draft();
  const receipt = approval(generated);
  assert.equal(receipt.target.subjectHash, generated.bundleHash);
  assert.equal(receipt.target.policyHash, BOUNTY_REPORT_POLICY_HASH);
  const released = releaseExactBountyReportDraft(generated, receipt, new Date('2026-08-03T00:02:00.000Z'));
  assert.equal(released.releaseStatus, 'submission-ready');
  assert.equal(released.releasedBundleHash, generated.bundleHash);
  assert.equal(bountyReportReleaseStatus(released), 'submission-ready');

  const otherDraft = generateLocalBountyReportDraft({ finding, revision: 2, report: { ...report(), title: 'Edited title' }, citations, redactions });
  assert.throws(() => releaseExactBountyReportDraft(otherDraft, receipt, new Date('2026-08-03T00:02:00.000Z')), /exact draft/);
  assert.throws(() => releaseExactBountyReportDraft(generated, { ...receipt, consumedAt: '2026-08-03T00:01:30.000Z' }, new Date('2026-08-03T00:02:00.000Z')), /consumed/);
});

test('any byte or manifest edit invalidates release status and requires a new exact approval', () => {
  const generated = draft();
  const released = releaseExactBountyReportDraft(generated, approval(generated), new Date('2026-08-03T00:02:00.000Z'));
  assert.equal(bountyReportReleaseStatus({ ...released, markdown: `${released.markdown}\nedit` }), 'invalidated');
  assert.equal(bountyReportReleaseStatus({ ...released, canonicalJson: `${released.canonicalJson} ` }), 'invalidated');
  assert.equal(bountyReportReleaseStatus({ ...released, report: { ...released.report, title: 'Changed without rerendering' } }), 'invalidated');
  assert.equal(bountyReportReleaseStatus({ ...released, citationManifest: [{ ...released.citationManifest[0]!, rawProofRef: 'vault://changed' }, ...released.citationManifest.slice(1)] }), 'invalidated');
  assert.equal(bountyReportReleaseStatus({ ...released, redactionManifest: [{ ...released.redactionManifest[0]!, reason: 'changed' }] }), 'invalidated');
});

test('operation closure and public-tool inventory prove there is no submission or reporter egress capability', () => {
  assert.doesNotThrow(assertBountyReportCapabilityInventory);
  assert.deepEqual(BOUNTY_REPORT_PUBLIC_TOOL_INVENTORY, []);
  const encoded = JSON.stringify(BOUNTY_REPORT_OPERATION_INVENTORY);
  for (const capability of ['network','broker','browser','credential','clipboard','email','chat','platform','subprocess','submit']) assert.doesNotMatch(encoded, new RegExp(capability, 'i'));
  const root = process.cwd().endsWith(`${path.sep}backend`) ? process.cwd() : path.join(process.cwd(), 'backend');
  const source = fs.readFileSync(path.join(root, 'src/lib/bounty-report-release.ts'), 'utf8');
  assert.doesNotMatch(source, /from ['"](?:\.\.\/db|node:child_process|https?|nodemailer|resend|playwright|@modelcontextprotocol)/);
  assert.doesNotMatch(source, /\b(?:fetch|spawn|exec|sendMail|clipboard|submitTo)\s*\(/);
  const routes = fs.readdirSync(path.join(root, 'src/routes')).filter((name) => name.endsWith('.ts'));
  const routeSource = routes.map((name) => fs.readFileSync(path.join(root, 'src/routes', name), 'utf8')).join('\n');
  assert.doesNotMatch(routeSource, /bounty[^\n]*(?:report|draft)[^\n]*(?:submit|send|publish)/i);
});

test('persistence keeps exact drafts and readiness facts append-only without a delivery surface', () => {
  const root = process.cwd().endsWith(`${path.sep}backend`) ? process.cwd() : path.join(process.cwd(), 'backend');
  const migration = fs.readFileSync(path.join(root, 'src/db/pg-migrations/20260803180000_bounty_report_release.sql'), 'utf8');
  const store = fs.readFileSync(path.join(root, 'src/lib/bounty-report-store.ts'), 'utf8');
  for (const field of ['markdown_bytes','json_bytes','markdown_hash','json_hash','citation_manifest_hash','redaction_manifest_hash','bundle_hash']) assert.match(migration, new RegExp(field));
  assert.match(migration, /release_status[^\n]+draft-unreleased/);
  assert.match(migration, /readiness_status[^\n]+submission-ready/);
  assert.match(migration, /markdown_hash TEXT NOT NULL CHECK \(markdown_hash ~ '\^sha256:/);
  assert.doesNotMatch(migration, /digest\(/);
  assert.match(migration, /bounty_report_draft_revision_sequence/);
  assert.match(migration, /bounty_report_drafts_immutable/);
  assert.match(migration, /bounty_report_releases_immutable/);
  assert.match(migration, /bounty_draft_release_approval_guard/);
  assert.match(store, /JOIN bounty_finding_admissions/);
  assert.match(store, /payload\?\.disposition !== 'admitted'/);
  assert.match(store, /UPDATE bounty_draft_release_approval_receipts SET consumed_at/);
  assert.doesNotMatch(migration, /(?:outbox|destination|delivery|platform_account|webhook_url)\s+(?:TEXT|JSONB|UUID)/i);
  assert.doesNotMatch(store, /\b(?:fetch|spawn|exec|sendMail|submitTo)\s*\(/);
});
