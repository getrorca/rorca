/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import { createHash, randomUUID } from 'node:crypto';
import { ForbiddenError, ValidationError } from './errors';

export const CAIDO_PIN = Object.freeze({
  version: '0.57.1',
  distributionSha256: 'sha256:ab54a8dc9eb13ab672059672f6c7e30c5f02eee30c46f1a2df58aa532e4cb462',
  configurationSchema: 'caido.config.v1',
  apiContract: 'caido.proxy.v1',
});

export interface CaidoRuntimeIdentity { version: string; distributionSha256: string; configurationSchema: string; apiContract: string }
export interface CaidoProjectPolicy { programId: string; missionId: string; projectId: string; storageNamespace: string; retentionDays: number; deleteAt: string; export: 'encrypted'; backup: 'encrypted' | 'disabled' }
export interface CaidoCorrelation { operationId: string; missionId: string; generationId: string; packageId: string; attemptId: string }
export interface CaidoDecision { allowed: boolean; decisionId: string; canonicalDestination: string; action: 'request' | 'redirect' | 'replay' | 'websocket'; credentialRole: string; credentialHandle?: string; method?: string; epoch: number; expiresAt: string }
export interface CaidoBroker { authorize(input: Omit<CaidoDecision, 'allowed' | 'decisionId' | 'expiresAt'> & CaidoCorrelation & { costCents: number }): Promise<CaidoDecision> }
export interface CaidoTransport { forward(input: { decision: CaidoDecision; correlation: CaidoCorrelation; body?: Uint8Array }): Promise<{ transactionId: string; bytes: Uint8Array; websocketTransactionId?: string }> }
export interface EvidenceGateway { admit(input: { transactionId: string; websocketTransactionId?: string; correlation: CaidoCorrelation; bytes: Uint8Array }): Promise<{ evidenceId: string }> }

export function verifyCaidoRuntime(actual: CaidoRuntimeIdentity): void {
  for (const key of Object.keys(CAIDO_PIN) as (keyof CaidoRuntimeIdentity)[]) if (actual[key] !== CAIDO_PIN[key]) throw new ValidationError(`Caido ${key} drift`);
}

/** Deterministic, non-overlapping project identity; raw program/mission identifiers never become paths. */
export function createCaidoProjectPolicy(programId: string, missionId: string, retentionDays: number, now = new Date()): CaidoProjectPolicy {
  if (!programId || !missionId || !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new ValidationError('Invalid Caido project policy');
  const key = createHash('sha256').update(`${programId}\0${missionId}`).digest('hex');
  return { programId, missionId, projectId: `rorca-${key.slice(0, 24)}`, storageNamespace: `caido/${key}`, retentionDays, deleteAt: new Date(now.getTime() + retentionDays * 86_400_000).toISOString(), export: 'encrypted', backup: 'encrypted' };
}

export class GovernedCaidoAdapter {
  constructor(
    private readonly broker: CaidoBroker,
    private readonly transport: CaidoTransport,
    private readonly evidence: EvidenceGateway,
    private readonly currentEpoch: () => number,
    private readonly trafficAllowed: () => boolean,
    private readonly quarantineStaleResponse: (input: { correlation: CaidoCorrelation; transactionId: string; authorityEpoch: number }) => Promise<void> = async () => undefined,
  ) {}

  /** Called independently for initial sends, redirects, replays, and WebSocket handshakes: decisions are never cached. */
  async send(input: CaidoCorrelation & { canonicalDestination: string; action: CaidoDecision['action']; credentialRole: string; credentialHandle?: string; method?: string; costCents: number; body?: Uint8Array }): Promise<{ evidenceId: string; transactionId: string }> {
    if (!this.trafficAllowed()) throw new ForbiddenError('Caido traffic paused or stopped');
    const epoch = this.currentEpoch();
    const decision = await this.broker.authorize({ ...input, epoch });
    if (!decision.allowed || decision.epoch !== epoch || decision.action !== input.action || decision.canonicalDestination !== input.canonicalDestination || decision.credentialRole !== input.credentialRole || Date.parse(decision.expiresAt) <= Date.now()) throw new ForbiddenError('Stale or mismatched Caido broker decision');
    // The broker authorization is the durable send fence; recheck its epoch at the last in-process instruction before transport.
    if (!this.trafficAllowed() || this.currentEpoch() !== epoch) throw new ForbiddenError('Caido traffic lost the Controller send fence');
    const captured = await this.transport.forward({ decision, correlation: input, body: input.body });
    if (!this.trafficAllowed() || this.currentEpoch() !== epoch) {
      await this.quarantineStaleResponse({ correlation: input, transactionId: captured.transactionId, authorityEpoch: epoch });
      throw new ForbiddenError('Old-epoch Caido response was quarantined');
    }
    const admitted = await this.evidence.admit({ ...captured, correlation: input });
    return { evidenceId: admitted.evidenceId, transactionId: captured.transactionId };
  }
}

const safeToken = /^[A-Za-z0-9_./:=+-]+$/;
export interface LocalAnalyzerManifest { name: string; executable: string; binarySha256: string; librarySha256: readonly string[]; argumentSchema: readonly string[]; inputSha256: readonly string[]; maxOutputBytes: number; timeoutMs: number; memoryMb: number; missionId: string; grantId: string; network: false }
export function validateLocalAnalyzerManifest(value: LocalAnalyzerManifest, trustedExecutables: Readonly<Record<string, string>>): void {
  const digest = /^sha256:[a-f0-9]{64}$/;
  if (trustedExecutables[value.executable] !== value.binarySha256 || !digest.test(value.binarySha256) || value.librarySha256.some((x) => !digest.test(x)) || value.inputSha256.length < 1 || value.inputSha256.some((x) => !digest.test(x))) throw new ForbiddenError('Unpinned analyzer or input');
  if (value.network !== false || !value.missionId || !value.grantId || value.maxOutputBytes < 1 || value.maxOutputBytes > 100_000_000 || value.timeoutMs < 1 || value.timeoutMs > 300_000 || value.memoryMb < 16 || value.memoryMb > 4096) throw new ForbiddenError('Unsafe analyzer limits or grant');
  if (!value.argumentSchema.length || value.argumentSchema.some((arg) => !safeToken.test(arg) || arg.includes('..') || arg.startsWith('/') || /(?:^|\/)(?:sh|bash|npm|npx|curl|wget)$/.test(arg))) throw new ForbiddenError('Unsafe analyzer arguments');
}

export function newCaidoDecisionId(): string { return randomUUID(); }
