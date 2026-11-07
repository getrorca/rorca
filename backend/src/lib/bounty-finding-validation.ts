/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import { hashBountyContract } from './bounty-contracts';
import { DENIED_EFFECT_ACTIONS } from './bounty-effect-policy';
import { ForbiddenError, ValidationError } from './errors';

export const BOUNTY_VALIDATION_POLICY_VERSION = 'bounty.validation.v1' as const;
export const INITIAL_EVIDENCE_CONFIDENCE_THRESHOLD = 0.85 as const;
export const RELEASE_ROUTABLE_FINDING_CLASSES = [
  'reflected-xss',
  'stored-xss',
  'idor',
  'server-side-callback',
  'exposed-private-key',
  'known-vulnerability',
  'source-code-control-edge',
] as const;
export type ReleaseRoutableFindingClass = typeof RELEASE_ROUTABLE_FINDING_CLASSES[number];
export type ValidationDisposition = 'auto' | 'human';

export interface FindingClassPolicy {
  oracle: string;
  negativeControl: string;
  minimumIndependentRuns: number;
  disposition: ValidationDisposition;
}

/** Every class that can reach release is closed over this versioned policy map. */
export const INITIAL_FINDING_CLASS_POLICY: Readonly<Record<ReleaseRoutableFindingClass, Readonly<FindingClassPolicy>>> = Object.freeze({
  'reflected-xss': Object.freeze({ oracle: 'cross-principal-script-execution', negativeControl: 'encoded-inert-payload', minimumIndependentRuns: 2, disposition: 'auto' }),
  'stored-xss': Object.freeze({ oracle: 'fresh-principal-stored-script-execution', negativeControl: 'unprivileged-clean-record', minimumIndependentRuns: 2, disposition: 'human' }),
  idor: Object.freeze({ oracle: 'cross-account-object-access', negativeControl: 'control-account-denied', minimumIndependentRuns: 2, disposition: 'auto' }),
  'server-side-callback': Object.freeze({ oracle: 'broker-server-callback-receipt', negativeControl: 'browser-origin-callback-absent', minimumIndependentRuns: 2, disposition: 'human' }),
  'exposed-private-key': Object.freeze({ oracle: 'private-key-material-verified', negativeControl: 'public-material-rejected', minimumIndependentRuns: 2, disposition: 'human' }),
  'known-vulnerability': Object.freeze({ oracle: 'version-specific-safe-exploit-oracle', negativeControl: 'banner-only-match-rejected', minimumIndependentRuns: 2, disposition: 'human' }),
  'source-code-control-edge': Object.freeze({ oracle: 'runtime-reachability-observed', negativeControl: 'inferred-edge-rejected', minimumIndependentRuns: 2, disposition: 'human' }),
});

export interface ValidationActorIdentity {
  workerId: string;
  processId: string;
  contextNonce: string;
  credentialLineage: readonly string[];
  operationLineage: readonly string[];
}

export interface BountyCandidate {
  candidateId: string;
  workspaceId: string;
  programId: string;
  missionId: string;
  affectedTargetId: string;
  findingClass: string;
  claimHash: string;
  evidenceRefs: readonly string[];
  sensitivity: 'public' | 'program-confidential' | 'secret' | 'regulated';
  harmCeiling: number;
  producer: ValidationActorIdentity;
  /** Producer-only fields are accepted solely so packet construction can prove they are removed. */
  hunterReasoning?: string;
  proposedSeverity?: string;
}

export interface ValidatorBrokerGrant {
  brokerId: string;
  grantId: string;
  targets: readonly string[];
  actions: readonly string[];
  credentialLineage: readonly string[];
  maxHarm: number;
  maxOperations: number;
}

export interface BlindValidationPacket {
  policyVersion: typeof BOUNTY_VALIDATION_POLICY_VERSION;
  confidenceThreshold: typeof INITIAL_EVIDENCE_CONFIDENCE_THRESHOLD;
  candidateId: string;
  workspaceId: string;
  programId: string;
  missionId: string;
  affectedTargetId: string;
  findingClass: string;
  claimHash: string;
  evidenceRefs: readonly string[];
  sensitivity: BountyCandidate['sensitivity'];
  harmCeiling: number;
  producerIdentityHash: string;
  validator: ValidationActorIdentity;
  validationNonce: string;
  brokerGrant: ValidatorBrokerGrant;
}

function nonEmptyDistinct(values: readonly string[]): boolean {
  return values.length > 0 && values.every((value) => typeof value === 'string' && value.length > 0) && new Set(values).size === values.length;
}

function disjoint(left: readonly string[], right: readonly string[]): boolean {
  const seen = new Set(left);
  return right.every((value) => !seen.has(value));
}

function validIdentity(identity: ValidationActorIdentity): boolean {
  return [identity.workerId, identity.processId, identity.contextNonce].every((value) => typeof value === 'string' && value.length > 0)
    && nonEmptyDistinct(identity.credentialLineage) && nonEmptyDistinct(identity.operationLineage);
}

function independentlyAssigned(producer: ValidationActorIdentity, validator: ValidationActorIdentity): boolean {
  return validIdentity(producer) && validIdentity(validator)
    && producer.workerId !== validator.workerId
    && producer.processId !== validator.processId
    && producer.contextNonce !== validator.contextNonce
    && disjoint(producer.credentialLineage, validator.credentialLineage)
    && disjoint(producer.operationLineage, validator.operationLineage);
}

function frozenIdentity(identity: ValidationActorIdentity): ValidationActorIdentity {
  return Object.freeze({ ...identity, credentialLineage: Object.freeze([...identity.credentialLineage]), operationLineage: Object.freeze([...identity.operationLineage]) });
}

function frozenGrant(grant: ValidatorBrokerGrant): ValidatorBrokerGrant {
  return Object.freeze({ ...grant, targets: Object.freeze([...grant.targets]), actions: Object.freeze([...grant.actions]), credentialLineage: Object.freeze([...grant.credentialLineage]) });
}

/** Build a blind packet: neither hunter reasoning nor hunter-proposed severity crosses this boundary. */
export function createBlindValidationPacket(input: {
  candidate: BountyCandidate;
  validator: ValidationActorIdentity;
  validationNonce: string;
  brokerGrant: ValidatorBrokerGrant;
}): Readonly<BlindValidationPacket> {
  const { candidate, validator, brokerGrant } = input;
  if (!independentlyAssigned(candidate.producer, validator)) throw new ValidationError('Validator process, context, credential, and operation lineage must be independent');
  if (!input.validationNonce || !candidate.evidenceRefs.length || !Number.isFinite(candidate.harmCeiling) || candidate.harmCeiling < 0) throw new ValidationError('Candidate validation binding is incomplete');
  if (!brokerGrant.brokerId || !brokerGrant.grantId || !nonEmptyDistinct(brokerGrant.credentialLineage)
      || !disjoint(candidate.producer.credentialLineage, brokerGrant.credentialLineage)
      || !brokerGrant.credentialLineage.every((entry) => validator.credentialLineage.includes(entry))) {
    throw new ValidationError('Validator broker grant is not bound to independent validator credentials');
  }
  return Object.freeze({
    policyVersion: BOUNTY_VALIDATION_POLICY_VERSION,
    confidenceThreshold: INITIAL_EVIDENCE_CONFIDENCE_THRESHOLD,
    candidateId: candidate.candidateId,
    workspaceId: candidate.workspaceId,
    programId: candidate.programId,
    missionId: candidate.missionId,
    affectedTargetId: candidate.affectedTargetId,
    findingClass: candidate.findingClass,
    claimHash: candidate.claimHash,
    evidenceRefs: Object.freeze([...candidate.evidenceRefs]),
    sensitivity: candidate.sensitivity,
    harmCeiling: candidate.harmCeiling,
    producerIdentityHash: hashBountyContract('validation-producer-identity', candidate.producer),
    validator: frozenIdentity(validator),
    validationNonce: input.validationNonce,
    brokerGrant: frozenGrant(brokerGrant),
  });
}

export interface ReproductionRun {
  operationId: string;
  evidenceDigest: string;
  freshEnvironment: boolean;
}

export interface VerifiedEvidenceCounts {
  expected: number;
  integrityVerified: number;
  lineageVerified: number;
}

export interface ClassOracleFacts {
  crossPrincipalImpact?: boolean;
  freshPrincipalImpact?: boolean;
  controlAccountDenied?: boolean;
  objectOwnersDiffer?: boolean;
  callbackReceiptSource?: 'broker-server' | 'browser';
  materialKind?: 'private-key' | 'public-key' | 'unknown';
  safeExploitObserved?: boolean;
  bannerOnly?: boolean;
  runtimeReachabilityObserved?: boolean;
  inferredOnly?: boolean;
}

export interface IndependentValidationReport {
  candidateId: string;
  policyVersion: string;
  validationNonce: string;
  validator: ValidationActorIdentity;
  findingClass: string;
  oracleSatisfied: boolean;
  negativeControlPassed: boolean;
  baselineOracleTriggered: boolean;
  alternativesFalsified: boolean;
  reproductions: readonly ReproductionRun[];
  evidence: VerifiedEvidenceCounts;
  observedHarm: number;
  prohibitedProofUsed: boolean;
  facts: ClassOracleFacts;
  /** Deliberately ignored: confidence is computed only from verified evidence counts. */
  modelSelfRating?: number;
}

export type ValidationReasonCode =
  | 'UNSUPPORTED_CLASS' | 'POLICY_MISMATCH' | 'STALE_NONCE' | 'VALIDATOR_IDENTITY_MISMATCH'
  | 'ORACLE_FAILED' | 'NEGATIVE_CONTROL_FAILED' | 'BASELINE_TRIGGERED' | 'ALTERNATIVES_NOT_FALSIFIED'
  | 'REPRODUCIBILITY_FAILED' | 'CONFIDENCE_BELOW_THRESHOLD' | 'HARM_CEILING_EXCEEDED'
  | 'PROHIBITED_PROOF' | 'CLASS_ORACLE_FAILED' | 'SENSITIVE_HUMAN_REVIEW';

export interface ValidationDecision {
  disposition: 'admitted' | 'inconclusive' | 'human-required' | 'rejected';
  policyVersion: typeof BOUNTY_VALIDATION_POLICY_VERSION;
  evidenceConfidence: number;
  reasonCodes: readonly ValidationReasonCode[];
  humanAdmissionRequired: boolean;
}

function evidenceConfidence(evidence: VerifiedEvidenceCounts): number {
  if (!Number.isSafeInteger(evidence.expected) || evidence.expected < 1
      || !Number.isSafeInteger(evidence.integrityVerified) || !Number.isSafeInteger(evidence.lineageVerified)
      || evidence.integrityVerified < 0 || evidence.lineageVerified < 0) return 0;
  const verified = Math.min(evidence.integrityVerified, evidence.expected) + Math.min(evidence.lineageVerified, evidence.expected);
  return verified / (2 * evidence.expected);
}

function classOracleSatisfied(findingClass: ReleaseRoutableFindingClass, facts: ClassOracleFacts): boolean {
  switch (findingClass) {
    case 'reflected-xss': return facts.crossPrincipalImpact === true;
    case 'stored-xss': return facts.crossPrincipalImpact === true && facts.freshPrincipalImpact === true;
    case 'idor': return facts.controlAccountDenied === true && facts.objectOwnersDiffer === true;
    case 'server-side-callback': return facts.callbackReceiptSource === 'broker-server';
    case 'exposed-private-key': return facts.materialKind === 'private-key';
    case 'known-vulnerability': return facts.safeExploitObserved === true && facts.bannerOnly !== true;
    case 'source-code-control-edge': return facts.runtimeReachabilityObserved === true && facts.inferredOnly !== true;
  }
}

function sameIdentity(left: ValidationActorIdentity, right: ValidationActorIdentity): boolean {
  return left.workerId === right.workerId && left.processId === right.processId && left.contextNonce === right.contextNonce
    && JSON.stringify(left.credentialLineage) === JSON.stringify(right.credentialLineage)
    && JSON.stringify(left.operationLineage) === JSON.stringify(right.operationLineage);
}

/** Evaluate only machine-verifiable evidence. Unsupported classes can never auto-admit. */
export function evaluateIndependentValidation(packet: BlindValidationPacket, report: IndependentValidationReport): Readonly<ValidationDecision> {
  const reasons: ValidationReasonCode[] = [];
  const policy = INITIAL_FINDING_CLASS_POLICY[packet.findingClass as ReleaseRoutableFindingClass];
  const confidence = evidenceConfidence(report.evidence);
  if (!policy) reasons.push('UNSUPPORTED_CLASS');
  if (report.policyVersion !== packet.policyVersion) reasons.push('POLICY_MISMATCH');
  if (report.validationNonce !== packet.validationNonce) reasons.push('STALE_NONCE');
  if (!sameIdentity(report.validator, packet.validator)) reasons.push('VALIDATOR_IDENTITY_MISMATCH');
  if (report.candidateId !== packet.candidateId || report.findingClass !== packet.findingClass) reasons.push('POLICY_MISMATCH');
  if (!report.oracleSatisfied) reasons.push('ORACLE_FAILED');
  if (!report.negativeControlPassed) reasons.push('NEGATIVE_CONTROL_FAILED');
  if (report.baselineOracleTriggered) reasons.push('BASELINE_TRIGGERED');
  if (!report.alternativesFalsified) reasons.push('ALTERNATIVES_NOT_FALSIFIED');
  const operationIds = report.reproductions.map((run) => run.operationId);
  if (!policy || report.reproductions.length < policy.minimumIndependentRuns
      || new Set(operationIds).size !== operationIds.length
      || report.reproductions.some((run) => !run.freshEnvironment || !run.operationId || !run.evidenceDigest)) reasons.push('REPRODUCIBILITY_FAILED');
  if (confidence < packet.confidenceThreshold) reasons.push('CONFIDENCE_BELOW_THRESHOLD');
  if (!Number.isFinite(report.observedHarm) || report.observedHarm < 0 || report.observedHarm > packet.harmCeiling) reasons.push('HARM_CEILING_EXCEEDED');
  if (report.prohibitedProofUsed) reasons.push('PROHIBITED_PROOF');
  if (policy && !classOracleSatisfied(packet.findingClass as ReleaseRoutableFindingClass, report.facts)) reasons.push('CLASS_ORACLE_FAILED');

  const hardReject = reasons.some((reason) => ['POLICY_MISMATCH', 'STALE_NONCE', 'VALIDATOR_IDENTITY_MISMATCH', 'HARM_CEILING_EXCEEDED', 'PROHIBITED_PROOF'].includes(reason));
  const humanAdmissionRequired = !policy || policy.disposition === 'human' || packet.sensitivity !== 'public';
  if (humanAdmissionRequired && reasons.length === 0) reasons.push('SENSITIVE_HUMAN_REVIEW');
  const disposition = hardReject ? 'rejected' : reasons.length === 0 ? 'admitted'
    : reasons.length === 1 && reasons[0] === 'SENSITIVE_HUMAN_REVIEW' ? 'human-required'
      : !policy && reasons.every((reason) => ['UNSUPPORTED_CLASS', 'REPRODUCIBILITY_FAILED'].includes(reason)) ? 'human-required' : 'inconclusive';
  return Object.freeze({ disposition, policyVersion: BOUNTY_VALIDATION_POLICY_VERSION, evidenceConfidence: confidence, reasonCodes: Object.freeze([...new Set(reasons)]), humanAdmissionRequired });
}

export interface ActiveFalsificationRequest {
  target: string;
  action: string;
  requestHash: string;
  harm: number;
  operationLineage: readonly string[];
}
export interface PriorBrokerEffect { requestHash: string; state: 'prepared' | 'sent' | 'observed' | 'failed-before-send' | 'unknown' }
export interface FalsificationBroker {
  brokerId: string;
  authorize(grantId: string, request: ActiveFalsificationRequest): Promise<{ operationId: string; state: 'prepared' }>;
}

/** Active checks must return through the producer's broker under a strictly no-wider validator grant. */
export async function authorizeActiveFalsification(input: {
  producerGrant: ValidatorBrokerGrant;
  producerOperationLineage: readonly string[];
  validatorGrant: ValidatorBrokerGrant;
  request: ActiveFalsificationRequest;
  priorEffects: readonly PriorBrokerEffect[];
  broker: FalsificationBroker;
}): Promise<{ operationId: string; state: 'prepared' }> {
  const { producerGrant, validatorGrant, request, broker } = input;
  const strictlyNarrower = validatorGrant.targets.length < producerGrant.targets.length
    || validatorGrant.actions.length < producerGrant.actions.length
    || validatorGrant.maxHarm < producerGrant.maxHarm
    || validatorGrant.maxOperations < producerGrant.maxOperations;
  const narrower = validatorGrant.brokerId === producerGrant.brokerId && broker.brokerId === producerGrant.brokerId
    && validatorGrant.targets.every((target) => producerGrant.targets.includes(target))
    && validatorGrant.actions.every((action) => producerGrant.actions.includes(action))
    && validatorGrant.maxHarm <= producerGrant.maxHarm
    && validatorGrant.maxOperations <= producerGrant.maxOperations
    && strictlyNarrower
    && nonEmptyDistinct(producerGrant.credentialLineage) && nonEmptyDistinct(validatorGrant.credentialLineage)
    && disjoint(producerGrant.credentialLineage, validatorGrant.credentialLineage);
  if (!narrower) throw new ForbiddenError('Active falsification must use the same broker with a strictly narrower independent grant');
  if (!validatorGrant.targets.includes(request.target) || !validatorGrant.actions.includes(request.action)
      || (DENIED_EFFECT_ACTIONS as readonly string[]).includes(request.action)
      || !Number.isFinite(request.harm) || request.harm < 0 || request.harm > validatorGrant.maxHarm
      || !nonEmptyDistinct(request.operationLineage) || !disjoint(input.producerOperationLineage, request.operationLineage)) {
    throw new ForbiddenError('Active falsification exceeds its exact scope, lineage, or harm ceiling');
  }
  if (input.priorEffects.some((effect) => effect.state === 'unknown' && effect.requestHash === request.requestHash)) {
    throw new ForbiddenError('Unknown target effects are never replayable');
  }
  const authorized = await broker.authorize(validatorGrant.grantId, request);
  if (!authorized.operationId || authorized.state !== 'prepared') throw new ForbiddenError('Broker did not prepare a fresh falsification operation');
  return authorized;
}
