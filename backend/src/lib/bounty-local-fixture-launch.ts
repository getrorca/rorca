/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { hashBountyContract } from './bounty-contracts';
import { ForbiddenError, ServiceUnavailableError, ValidationError } from './errors';

const Hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Id = z.string().trim().min(1).max(128);
export const LOCAL_FIXTURE_LAUNCH_VERSION = 'bounty.local-fixture-launch.v1' as const;

export const LocalFixtureLaunchTargetSchema = z.object({
  version: z.literal(LOCAL_FIXTURE_LAUNCH_VERSION), workspaceId: Id, programId: z.string().uuid(), missionId: z.string().uuid(),
  previewReceiptId: z.string().uuid(), previewRequestHash: Hash, contractHash: Hash, policyContractHash: Hash,
  deployedSourceSha: z.string().regex(/^[a-f0-9]{40}$/), deployedQualificationReceiptHash: Hash, workerImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expectedProgramRevision: z.number().int().positive(), requesterId: Id, nonce: z.string().uuid(),
  issuedAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }), action: z.literal('mission.launch.local-fixture'),
}).strict();
export type LocalFixtureLaunchTarget = z.infer<typeof LocalFixtureLaunchTargetSchema>;
export const LocalFixtureDeploymentIdentitySchema = z.object({
  deployedSourceSha: z.string().regex(/^[a-f0-9]{40}$/),
  deployedQualificationReceiptHash: Hash,
  workerImageDigest: Hash,
}).strict();
export const LocalFixtureProviderEventSchema = z.object({
  eventId: z.string().uuid(), targetHash: Hash, decision: z.literal('approve'),
  actor: z.object({ id: Id, role: z.enum(['provider_owner','provider_admin','program_manager']), kind: z.literal('provider_human') }).strict(),
  signedAt: z.string().datetime({ offset: true }), publicKeyPem: z.string().min(64).max(8192), signature: z.string().min(16).max(8192),
}).strict();
export type LocalFixtureProviderEvent = z.infer<typeof LocalFixtureProviderEventSchema>;

export function localFixtureLaunchTargetHash(target: LocalFixtureLaunchTarget): string { return hashBountyContract('local-fixture-launch-target', LocalFixtureLaunchTargetSchema.parse(target)); }
export function assertLocalFixtureDeploymentBinding(targetValue: unknown, deploymentValue: unknown): void {
  const target = LocalFixtureLaunchTargetSchema.parse(targetValue);
  const deployment = LocalFixtureDeploymentIdentitySchema.parse(deploymentValue);
  if (target.deployedSourceSha !== deployment.deployedSourceSha
      || target.deployedQualificationReceiptHash !== deployment.deployedQualificationReceiptHash
      || target.workerImageDigest !== deployment.workerImageDigest) {
    throw new ForbiddenError('Local-fixture launch approval does not match the active promoted deployment');
  }
}
export function localFixtureProviderKeyHash(pem: string): string { return hashBountyContract('local-fixture-provider-key', createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64')); }
function trustedKeys(): Set<string> { return new Set((process.env.RORCA_BOUNTY_PROVIDER_KEY_HASHES ?? '').split(',').map(v => v.trim()).filter(Boolean)); }
export function verifyLocalFixtureProviderApproval(targetValue: unknown, eventValue: unknown, now = new Date()): { target: LocalFixtureLaunchTarget; event: LocalFixtureProviderEvent; targetHash: string } {
  const target = LocalFixtureLaunchTargetSchema.parse(targetValue); const event = LocalFixtureProviderEventSchema.parse(eventValue); const targetHash = localFixtureLaunchTargetHash(target);
  if (Date.parse(target.expiresAt) <= now.getTime() || Date.parse(target.issuedAt) > now.getTime() || Date.parse(event.signedAt) > now.getTime()) throw new ForbiddenError('Local-fixture launch approval is not temporally valid');
  if (event.targetHash !== targetHash || event.actor.id === target.requesterId) throw new ForbiddenError('Provider-human approval targets different authority or is not distinct');
  const trust = trustedKeys(); if (!trust.size) throw new ServiceUnavailableError('Provider-human launch trust roots are not configured');
  let fingerprint: string; try { fingerprint = localFixtureProviderKeyHash(event.publicKeyPem); } catch { throw new ValidationError('Provider-human public key is invalid'); }
  if (!trust.has(fingerprint)) throw new ForbiddenError('Provider-human signing key is not trusted');
  const bytes = Buffer.from(JSON.stringify({ eventId: event.eventId, targetHash: event.targetHash, decision: event.decision, actor: event.actor, signedAt: event.signedAt }));
  if (!verify(null, bytes, event.publicKeyPem, Buffer.from(event.signature, 'base64'))) throw new ForbiddenError('Provider-human launch signature is invalid');
  return { target, event, targetHash };
}
