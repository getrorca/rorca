/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { transaction } from '../db';
import { ConflictError, ValidationError } from './errors';
import { verifyBountyReleasePromotion, type BountyReleasePromotionEnvelope } from './bounty-release-promotion';
import type { BountyQualificationReceipt } from './bounty-qualification';

const root = resolve(__dirname, '../../..');

/** Recompute bindings through the same pinned generator used by qualification. Refuses tracked or untracked source drift. */
export function recomputeDeployedBountyQualification(): BountyQualificationReceipt {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
  const relevant = status.split('\n').filter(Boolean).filter((line) => !line.slice(3).startsWith('tmp/'));
  if (relevant.length) throw new ConflictError('Bounty promotion requires an exact clean deployed checkout');
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const output = resolve(root, 'tmp', `.bounty-promotion-${randomUUID()}.json`);
  try {
    execFileSync(process.execPath, [resolve(root, 'scripts/generate-bounty-qualification-receipt.mjs'), output], {
      cwd: root, env: { ...process.env, RORCA_BOUNTY_SOURCE_SHA: sourceSha }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    return JSON.parse(readFileSync(output, 'utf8')) as BountyQualificationReceipt;
  } finally { rmSync(output, { force: true }); }
}

export async function admitBountyReleasePromotion(input: {
  envelope: BountyReleasePromotionEnvelope; qualificationReceipt: unknown; actor: string;
}): Promise<{ promotionId: string; qualificationReceiptHash: string; bindingsHash: string; signerKeyHash: string }> {
  if (!input.actor.trim()) throw new ValidationError('Promotion admitting actor is required');
  const current = recomputeDeployedBountyQualification();
  const expectedWorkerImageDigest = String(process.env.RORCA_BOUNTY_WORKER_IMAGE_DIGEST ?? '').trim();
  const verified = verifyBountyReleasePromotion({ envelope: input.envelope, qualificationReceipt: input.qualificationReceipt, currentBindings: current.bindings, expectedWorkerImageDigest });
  if (verified.payload.qualificationReceiptHash !== current.receiptHash) throw new ConflictError('Promotion qualification receipt is not the exact deployed receipt');
  return transaction(async (client) => {
    const prior = await client.query<{ qualification_receipt_hash: string; bindings_hash: string; signer_key_hash: string }>('SELECT qualification_receipt_hash,bindings_hash,signer_key_hash FROM bounty_release_promotions WHERE id=$1', [verified.payload.promotionId]);
    if (prior.rows[0]) {
      if (prior.rows[0].qualification_receipt_hash !== current.receiptHash || prior.rows[0].bindings_hash !== verified.bindingsHash || prior.rows[0].signer_key_hash !== verified.signerKeyHash) throw new ConflictError('Promotion identity already binds different authority');
    } else {
      await client.query(`INSERT INTO bounty_release_promotions(id,qualification_receipt_hash,source_sha,bindings,bindings_hash,signer_key_hash,signed_payload,signature,issued_at,expires_at,admitted_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [verified.payload.promotionId,current.receiptHash,current.bindings.sourceSha,current.bindings,verified.bindingsHash,verified.signerKeyHash,verified.payload,input.envelope.signatureBase64,verified.payload.issuedAt,verified.payload.expiresAt,input.actor]);
    }
    return { promotionId: verified.payload.promotionId, qualificationReceiptHash: current.receiptHash, bindingsHash: verified.bindingsHash, signerKeyHash: verified.signerKeyHash };
  });
}
