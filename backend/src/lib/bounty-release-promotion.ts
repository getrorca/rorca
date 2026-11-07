/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { ValidationError, ForbiddenError } from './errors';
import {
  BOUNTY_RECEIPT_BINDING_KEYS,
  verifyBountyQualificationReceipt,
  type BountyQualificationReceipt,
} from './bounty-qualification';

export const BOUNTY_PROMOTION_TRUST_ROOTS_ENV = 'RORCA_BOUNTY_PROMOTION_KEY_HASHES' as const;
const Hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Bindings = z.object(Object.fromEntries(BOUNTY_RECEIPT_BINDING_KEYS.map((key) => [key, z.string()])) as Record<(typeof BOUNTY_RECEIPT_BINDING_KEYS)[number], z.ZodString>).strict();
export const BountyReleasePromotionPayloadSchema = z.object({
  schemaVersion: z.literal('bounty.release-promotion.v1'),
  promotionId: z.string().uuid(),
  candidateId: z.string().min(1).max(256),
  qualificationReceiptHash: Hash,
  workerImageDigest: Hash,
  bindings: Bindings,
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  nonce: z.string().min(16).max(256),
  action: z.literal('enable-bounty-release'),
}).strict();
export const BountyReleasePromotionEnvelopeSchema = z.object({
  payload: BountyReleasePromotionPayloadSchema,
  signerSpkiDerBase64: z.string().min(32).max(4096),
  signatureBase64: z.string().min(32).max(4096),
}).strict();
export type BountyReleasePromotionEnvelope = z.infer<typeof BountyReleasePromotionEnvelopeSchema>;
export type BountyReleasePromotionPayload = z.infer<typeof BountyReleasePromotionPayloadSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const bountyPromotionHash = (value: unknown): string => `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
export const bountyPromotionSignerKeyHash = (spkiDer: Buffer): string => `sha256:${createHash('sha256').update(spkiDer).digest('hex')}`;

export function verifyBountyReleasePromotion(input: {
  envelope: unknown;
  qualificationReceipt: unknown;
  currentBindings: BountyQualificationReceipt['bindings'];
  expectedWorkerImageDigest: string;
  trustedKeyHashes?: readonly string[];
  now?: Date;
}): Readonly<{ payload: BountyReleasePromotionPayload; signerKeyHash: string; bindingsHash: string }> {
  const parsed = BountyReleasePromotionEnvelopeSchema.safeParse(input.envelope);
  if (!parsed.success) throw new ValidationError('Invalid bounty release promotion envelope', { issues: parsed.error.issues });
  const qualification = verifyBountyQualificationReceipt(input.qualificationReceipt, input.currentBindings);
  const { payload } = parsed.data;
  if (payload.candidateId !== qualification.candidateId || payload.qualificationReceiptHash !== qualification.receiptHash) {
    throw new ForbiddenError('Promotion does not bind the exact qualification receipt');
  }
  if (canonical(payload.bindings) !== canonical(input.currentBindings)) throw new ForbiddenError('Promotion bindings are stale');
  if (!Hash.safeParse(input.expectedWorkerImageDigest).success || payload.workerImageDigest !== input.expectedWorkerImageDigest) throw new ForbiddenError('Promotion does not bind the exact deployed worker image');
  const now = (input.now ?? new Date()).getTime();
  if (Date.parse(payload.issuedAt) > now || Date.parse(payload.expiresAt) <= now || Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt)) {
    throw new ForbiddenError('Promotion is not temporally valid');
  }
  let spki: Buffer;
  let signature: Buffer;
  try {
    spki = Buffer.from(parsed.data.signerSpkiDerBase64, 'base64');
    signature = Buffer.from(parsed.data.signatureBase64, 'base64');
  } catch { throw new ValidationError('Promotion signature encoding is invalid'); }
  const signerKeyHash = bountyPromotionSignerKeyHash(spki);
  const trusted = input.trustedKeyHashes ?? String(process.env[BOUNTY_PROMOTION_TRUST_ROOTS_ENV] ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (!trusted.includes(signerKeyHash)) throw new ForbiddenError('Promotion signer is not a configured trust root');
  let valid = false;
  try { valid = verify(null, Buffer.from(canonical(payload)), createPublicKey({ key: spki, format: 'der', type: 'spki' }), signature); } catch { valid = false; }
  if (!valid) throw new ForbiddenError('Promotion signature is invalid');
  return Object.freeze({ payload: Object.freeze(payload), signerKeyHash, bindingsHash: bountyPromotionHash(payload.bindings) });
}
