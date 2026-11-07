/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
/** Controller-only durable store for local report bytes and exact readiness facts. */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { transaction } from '../db';
import { bountyApprovalTargetHash, type BountyApprovalReceipt } from './bounty-approvals';
import { hashBountyContract } from './bounty-contracts';
import { ForbiddenError } from './errors';
import {
  generateLocalBountyReportDraft,
  releaseExactBountyReportDraft,
  type AdmittedReportFinding,
  type BountyReportContent,
  type BountyReportDraft,
  type ReleasedBountyReportDraft,
  type ReportEvidenceCitation,
  type ReportRedaction,
} from './bounty-report-release';

interface PersistedReportFindingRow {
  mission_id: string;
  program_id: string;
  decision_hash: string;
  disposition: AdmittedReportFinding['admissionDisposition'];
}
interface PersistedEvidenceRow { id: string; digest: string; payload: Record<string, unknown> }

async function verifyPersistedReportAuthority(client: PoolClient, input: {
  workspaceId: string; findingId: string; citations: readonly ReportEvidenceCitation[];
}): Promise<AdmittedReportFinding> {
  const finding = await client.query<PersistedReportFindingRow>(
    `SELECT f.mission_id,m.program_id,a.decision_hash,a.disposition
       FROM bounty_findings f
       JOIN bounty_missions m ON m.workspace_id=f.workspace_id AND m.id=f.mission_id
       JOIN bounty_finding_admissions a ON a.workspace_id=f.workspace_id AND a.finding_id=f.id
      WHERE f.workspace_id=$1 AND f.id=$2 FOR SHARE OF f,m,a`, [input.workspaceId, input.findingId],
  );
  const authority = finding.rows[0];
  if (!authority) throw new ForbiddenError('Report generation requires a durably admitted finding');
  const evidenceIds = input.citations.map((citation) => citation.evidenceId);
  const evidence = await client.query<PersistedEvidenceRow>(
    `SELECT id,digest,payload FROM bounty_evidence
      WHERE workspace_id=$1 AND mission_id=$2 AND id=ANY($3::uuid[]) FOR SHARE`,
    [input.workspaceId, authority.mission_id, evidenceIds],
  );
  const evidenceById = new Map(evidence.rows.map((row) => [row.id, row]));
  for (const citation of input.citations) {
    const row = evidenceById.get(citation.evidenceId);
    const payload = row?.payload;
    const binding = payload?.binding && typeof payload.binding === 'object' ? payload.binding as Record<string, unknown> : undefined;
    if (!row || payload?.disposition !== 'admitted' || row.digest !== citation.originalHash
        || payload.originalHash !== citation.originalHash || (payload.redactedHash ?? null) !== citation.redactedHash
        || binding?.sensitivity !== citation.sensitivity) {
      throw new ForbiddenError('Report citation does not match durably admitted evidence and its redaction manifest');
    }
  }
  return {
    findingId: input.findingId, workspaceId: input.workspaceId, programId: authority.program_id, missionId: authority.mission_id,
    admissionDecisionHash: authority.decision_hash, admissionDisposition: authority.disposition, stopFenceCommitted: true,
  };
}

/**
 * Resolve finding/evidence admission under one transaction, then generate and persist exact local
 * bytes. Approval is intentionally absent because the bytes and manifests do not exist yet.
 */
export async function generatePersistedLocalBountyReportDraft(input: {
  workspaceId: string;
  findingId: string;
  revision: number;
  report: BountyReportContent;
  citations: readonly ReportEvidenceCitation[];
  redactions: readonly ReportRedaction[];
}): Promise<{ draftId: string; draft: Readonly<BountyReportDraft>; replayed: boolean }> {
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bounty-report-draft:${input.workspaceId}:${input.findingId}`]);
    const finding = await verifyPersistedReportAuthority(client, input);
    const draft = generateLocalBountyReportDraft({ finding, revision: input.revision, report: input.report, citations: input.citations, redactions: input.redactions });
    const existing = await client.query<{ id: string; bundle_hash: string }>(
      'SELECT id,bundle_hash FROM bounty_report_drafts WHERE workspace_id=$1 AND finding_id=$2 AND revision=$3',
      [draft.workspaceId, draft.findingId, draft.revision],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].bundle_hash !== draft.bundleHash) throw new ForbiddenError('Draft revision already exists with different exact bytes');
      return { draftId: existing.rows[0].id, draft, replayed: true };
    }
    const draftId = randomUUID();
    await client.query(
      `INSERT INTO bounty_report_drafts
       (id,workspace_id,program_id,mission_id,finding_id,admission_decision_hash,revision,policy_version,
        markdown_bytes,json_bytes,markdown_hash,json_hash,citation_manifest,citation_manifest_hash,
        redaction_manifest,redaction_manifest_hash,bundle_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [draftId,draft.workspaceId,draft.programId,draft.missionId,draft.findingId,draft.admissionDecisionHash,draft.revision,draft.policyVersion,
        Buffer.from(draft.markdown,'utf8'),Buffer.from(draft.canonicalJson,'utf8'),draft.markdownHash,draft.jsonHash,draft.citationManifest,
        draft.citationManifestHash,draft.redactionManifest,draft.redactionManifestHash,draft.bundleHash],
    );
    return { draftId, draft, replayed: false };
  });
}

/** Persist an already provider-verified event for one exact readiness consumption. */
export async function persistBountyDraftReleaseApprovalReceipt(receipt: BountyApprovalReceipt): Promise<void> {
  const targetHash = bountyApprovalTargetHash(receipt.target);
  if (receipt.target.action !== 'draft.release' || !receipt.target.missionId || receipt.consumedAt || receipt.revokedAt
      || receipt.targetHash !== targetHash || receipt.providerEvent.targetHash !== targetHash) {
    throw new ForbiddenError('Only a fresh exact draft.release provider-human receipt can be persisted');
  }
  await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bounty-report-approval:${receipt.target.workspaceId}:${receipt.receiptId}`]);
    const existing = await client.query<{ target_hash: string; exact_target: unknown; provider_event: unknown }>(
      'SELECT target_hash,exact_target,provider_event FROM bounty_draft_release_approval_receipts WHERE workspace_id=$1 AND id=$2',
      [receipt.target.workspaceId, receipt.receiptId],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.target_hash !== targetHash
          || hashBountyContract('approval-target', row.exact_target) !== hashBountyContract('approval-target', receipt.target)
          || hashBountyContract('provider-human-event', row.provider_event) !== hashBountyContract('provider-human-event', receipt.providerEvent)) {
        throw new ForbiddenError('Draft release approval replay changed exact authority');
      }
      return;
    }
    await client.query(
      `INSERT INTO bounty_draft_release_approval_receipts
       (id,workspace_id,program_id,mission_id,target_hash,exact_target,provider_event,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [receipt.receiptId,receipt.target.workspaceId,receipt.target.programId,receipt.target.missionId,targetHash,receipt.target,receipt.providerEvent,receipt.target.expiresAt],
    );
  });
}

/** Atomically consume exact readiness authority and append an immutable readiness fact. */
export async function commitBountyReportRelease(input: {
  draftId: string; draft: BountyReportDraft; approval: BountyApprovalReceipt; now?: Date;
}): Promise<Readonly<ReleasedBountyReportDraft>> {
  const released = releaseExactBountyReportDraft(input.draft, input.approval, input.now);
  return transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`bounty-report-release:${released.workspaceId}:${input.draftId}`]);
    const persisted = await client.query<{ bundle_hash: string; markdown_hash: string; json_hash: string; citation_manifest_hash: string; redaction_manifest_hash: string }>(
      `SELECT bundle_hash,markdown_hash,json_hash,citation_manifest_hash,redaction_manifest_hash
         FROM bounty_report_drafts WHERE workspace_id=$1 AND id=$2 FOR SHARE`, [released.workspaceId, input.draftId],
    );
    const row = persisted.rows[0];
    if (!row || row.bundle_hash !== released.bundleHash || row.markdown_hash !== released.markdownHash || row.json_hash !== released.jsonHash
        || row.citation_manifest_hash !== released.citationManifestHash || row.redaction_manifest_hash !== released.redactionManifestHash) {
      throw new ForbiddenError('Persisted draft bytes and manifests do not match exact release authority');
    }
    const replay = await client.query<{ approval_receipt_id: string; bundle_hash: string }>(
      'SELECT approval_receipt_id,bundle_hash FROM bounty_report_releases WHERE workspace_id=$1 AND draft_id=$2',
      [released.workspaceId, input.draftId],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].approval_receipt_id !== input.approval.receiptId || replay.rows[0].bundle_hash !== released.bundleHash) throw new ForbiddenError('Draft already has different exact release authority');
      return released;
    }
    const consumed = await client.query<{ id: string }>(
      `UPDATE bounty_draft_release_approval_receipts SET consumed_at=$3
        WHERE workspace_id=$1 AND id=$2 AND target_hash=$4 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>$3
        RETURNING id`,
      [released.workspaceId,input.approval.receiptId,released.releasedAt,released.releaseTargetHash],
    );
    if (!consumed.rows[0]) throw new ForbiddenError('Exact draft release approval is expired, revoked, changed, or already consumed');
    await client.query(
      `INSERT INTO bounty_report_releases
       (id,workspace_id,draft_id,approval_receipt_id,bundle_hash,markdown_hash,json_hash,citation_manifest_hash,redaction_manifest_hash,released_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [randomUUID(),released.workspaceId,input.draftId,input.approval.receiptId,released.bundleHash,released.markdownHash,released.jsonHash,
        released.citationManifestHash,released.redactionManifestHash,released.releasedAt],
    );
    return released;
  });
}
