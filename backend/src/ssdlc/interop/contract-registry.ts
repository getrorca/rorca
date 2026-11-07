/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import type { AnySchema } from 'ajv';
import { z } from 'zod';
import {
  ActionEnvelopeV1Schema, EntityRefV1Schema, RevisionRefV1Schema,
} from '../../lib/mission-contracts';
import { IntentEnvelopeV1Schema, SourceBundleV1Schema } from '../../lib/source-contracts';
import {
  createCanonicalEvidence, parseHermesEvidenceEnvelope,
  type CanonicalLifecycleEvidence, type CreateEvidenceInput,
} from '../../lib/ssdlc-evidence';
import { GatewayEventV1Schema, gatewayWalEventType } from '../../lib/gateway-events';
import { OrchestrationEventV1Schema, orchestrationWalEventType } from '../../lib/omp-orchestration-events';
import { toRunEventDispatch } from '../../lib/run-event-subscription';
import type { WalEvent } from '../../lib/sse-hub';
import { AssuranceProfileV1Schema } from '../assurance-profile';
import { StructuredFindingSchema } from '../skills/findings';
import { consumeProductionOutcome, type LearnCandidate, type ProductionOutcome } from '../learn/learn-loop';
import { parseControl } from '../schema/control-schema';
import {
  assuranceProfileFixture, controlFixture, controlsCatalogFixture, findingFixture, gatewayFixture,
  hermesEvidenceFixture, intentEnvelopeFixture, learnOutcomeFixture, lifecycleEvidenceFixture,
  orchestrationFixture, revisionFixture, sourceBundleFixture, specRefFixture, stageProjectionFixture,
} from './__fixtures__/consumer-fixtures';

export interface ContractProvider {
  owner: string;
  artifactPath: string;
  load(): Promise<{ validate(value: unknown): unknown }>;
}

export interface ConsumerExpectation {
  consumer: string;
  fixture: unknown | (() => Promise<unknown>);
  assert(artifact: unknown): void | Promise<void>;
}

export interface ContractRegistration {
  contract: string;
  version: string;
  provider: ContractProvider;
  consumers: readonly ConsumerExpectation[];
}

export interface RegistryReceipt {
  schemaVersion: 'rorca.ssdlc-contract-registry-receipt.v1';
  registryVersion: '1';
  contractCount: number;
  assertionCount: number;
  contracts: Array<{ contract: string; version: string; provider: string; artifactPath: string; consumers: string[] }>;
  digest: `sha256:${string}`;
}

export class ContractRegistryError extends TypeError {
  constructor(
    readonly code: 'DUPLICATE_OWNER' | 'UNKNOWN_VERSION' | 'MISSING_CONSUMER_ASSERTION' | 'INVALID_PROVIDER_ARTIFACT' | 'CONSUMER_ASSERTION_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'ContractRegistryError';
  }
}

const json = async (relativePath: string): Promise<unknown> => JSON.parse(await readFile(path.resolve(__dirname, relativePath), 'utf8')) as unknown;
const zodProvider = (owner: string, artifactPath: string, schema: z.ZodType): ContractProvider => ({
  owner, artifactPath, async load() { return { validate: (value) => schema.parse(value) }; },
});
const functionProvider = (
  owner: string, artifactPath: string, validate: (value: unknown) => unknown,
): ContractProvider => ({ owner, artifactPath, async load() { return { validate }; } });
const expectation = (
  consumer: string, fixture: ConsumerExpectation['fixture'], assert: ConsumerExpectation['assert'] = () => {},
): ConsumerExpectation => ({ consumer, fixture, assert });
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('artifact must be an object');
  return value as Record<string, unknown>;
};

function validateStageProjection(value: unknown): unknown {
  const artifact = record(value);
  if (!Array.isArray(artifact.phaseGroups) || !Array.isArray(artifact.readiness)) throw new TypeError('US-004 projection requires phaseGroups and readiness');
  const stages = artifact.readiness.map((item) => record(item).stage);
  if (stages.join(',') !== 'planning,requirements,design,development,testing,deployment,maintenance') throw new TypeError('US-004 projection must contain the seven canonical stages in order');
  return artifact;
}

function validateCanonicalEvidence(value: unknown): CanonicalLifecycleEvidence {
  const evidence = record(value) as unknown as CanonicalLifecycleEvidence;
  if (evidence.schemaVersion !== 'rorca.lifecycle-evidence.v1') throw new TypeError('unknown lifecycle evidence version');
  const recreated = createCanonicalEvidence({
    sourceType: evidence.source.type, sourceSystem: evidence.source.system, sourceEventId: evidence.source.eventId,
    observedAt: evidence.observedAt, scope: evidence.scope, subject: evidence.subject, phaseSubject: evidence.phaseSubject,
    releaseIdentity: evidence.releaseIdentity, classification: evidence.classification, status: evidence.status,
    trustLevel: evidence.trustLevel, confidence: evidence.confidence, excerpt: evidence.excerpt, rawReference: evidence.rawReference,
    provenanceChain: evidence.provenanceChain, actor: evidence.actor, rationale: evidence.rationale, details: evidence.details,
    ...(evidence.sourcePayloadHash ? { upstreamPayloadHash: evidence.sourcePayloadHash } : {}),
  } satisfies CreateEvidenceInput);
  if (recreated.payloadHash !== evidence.payloadHash) throw new TypeError('lifecycle evidence payloadHash does not match its canonical shape');
  return recreated;
}

function validateLearnCandidate(value: unknown): LearnCandidate {
  const candidate = consumeProductionOutcome(record(value) as unknown as ProductionOutcome);
  if (!candidate || candidate.status !== 'pending-review' || candidate.signalCount < 1) throw new TypeError('US-007 fixture did not produce a pending-review candidate');
  return candidate;
}

function transportAssertion(family: 'orchestration' | 'gateway') {
  return (artifact: unknown): void => {
    const payload = record(artifact);
    const eventType = family === 'orchestration'
      ? orchestrationWalEventType(payload as never)
      : gatewayWalEventType(payload as never);
    const event: WalEvent = {
      id: 1, ts: '2026-03-16T00:06:34.000Z', event_type: eventType, workspace_id: 'workspace-cdc',
      spec_id: 'interop-spec', story_id: family === 'orchestration' ? 'AAV-007' : 'HMG-010', actor: 'cdc-suite', payload: JSON.stringify(payload),
    };
    const dispatch = toRunEventDispatch(event);
    if (dispatch?.family !== family || dispatch.payloadSchemaVersion !== payload.schemaVersion) {
      throw new TypeError(`${family} payload did not survive the canonical WAL/SSE envelope`);
    }
    if (ActionEnvelopeV1Schema.safeParse(payload).success) throw new TypeError(`${family} payload misuses ActionEnvelopeV1`);
  };
}

const controlSchemaProvider: ContractProvider = {
  owner: 'US-001', artifactPath: 'backend/src/ssdlc/schema/control-schema.json',
  async load() {
    const schema = await json('../schema/control-schema.json');
    const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema as AnySchema);
    return { validate(value: unknown) {
      if (!validateSchema(value)) throw new TypeError(`ControlRecord JSON Schema rejected artifact: ${JSON.stringify(validateSchema.errors)}`);
      return parseControl(value);
    } };
  },
};
const catalogProvider: ContractProvider = {
  owner: 'US-008', artifactPath: 'backend/src/ssdlc/catalog/controls.json',
  async load() {
    const catalog = await json('../catalog/controls.json');
    if (!Array.isArray(catalog)) throw new TypeError('controls.json must be an array');
    const parsed = catalog.map(parseControl);
    return { validate(value: unknown) {
      if (!Array.isArray(value)) throw new TypeError('catalog consumer fixture must be an array');
      const requested = value.map((item) => String(item));
      const available = new Set(parsed.map(({ controlId }) => controlId));
      const unknown = requested.filter((controlId) => !available.has(controlId));
      if (unknown.length) throw new TypeError(`unknown US-008 control IDs: ${unknown.join(', ')}`);
      return parsed.filter(({ controlId }) => requested.includes(controlId));
    } };
  },
};

export const SSDLC_CONTRACT_REGISTRY: readonly ContractRegistration[] = Object.freeze([
  { contract: 'SourceBundleV1', version: 'rorca.source-bundle.v1', provider: zodProvider('HMG-001', 'backend/src/lib/source-contracts.ts#SourceBundleV1Schema', SourceBundleV1Schema), consumers: [
    expectation('HMG adapters/compiler', sourceBundleFixture), expectation('spec persistence', sourceBundleFixture), expectation('AAV assurance compiler', sourceBundleFixture),
  ] },
  { contract: 'IntentEnvelopeV1', version: 'rorca.intent-envelope.v1', provider: zodProvider('HMG-001', 'backend/src/lib/source-contracts.ts#IntentEnvelopeV1Schema', IntentEnvelopeV1Schema), consumers: [
    expectation('Hermes intake', intentEnvelopeFixture), expectation('mission draft bridge', intentEnvelopeFixture),
  ] },
  { contract: 'EntityRefV1', version: 'rorca.entity-ref.v1', provider: zodProvider('Mission contracts', 'backend/src/lib/mission-contracts.ts#EntityRefV1Schema', EntityRefV1Schema), consumers: [
    expectation('all SSDLC participants', specRefFixture),
  ] },
  { contract: 'RevisionRefV1', version: 'rorca.revision-ref.v1', provider: zodProvider('Mission contracts', 'backend/src/lib/mission-contracts.ts#RevisionRefV1Schema', RevisionRefV1Schema), consumers: [
    expectation('all SSDLC participants', revisionFixture),
  ] },
  { contract: 'ControlRecord', version: 'rorca.ssdlc-control-record.v1', provider: controlSchemaProvider, consumers: [
    expectation('US-003 resolver', controlFixture), expectation('US-004 gate compiler', controlFixture), expectation('AAV compiler/kernel', controlFixture),
  ] },
  { contract: 'controls.json', version: '1', provider: catalogProvider, consumers: [
    expectation('AAV control lookup', () => json('../catalog/__fixtures__/aav-consumer.json').then((value) => record(value).controlIds)),
    expectation('assurance profile compiler', controlsCatalogFixture.map(({ controlId }) => controlId)),
  ] },
  { contract: 'StageProjection', version: 'rorca.stage-projection.v1', provider: functionProvider('US-004', 'backend/src/ssdlc/gates/gate-compiler.ts#compileGates', validateStageProjection), consumers: [
    expectation('US-005 evaluator', stageProjectionFixture), expectation('AAV execution', stageProjectionFixture), expectation('lifecycle projections', stageProjectionFixture),
  ] },
  { contract: 'AssuranceProfile', version: 'rorca.assurance-profile.v1', provider: zodProvider('AAV-001/004/005', 'backend/src/ssdlc/assurance-profile.ts#AssuranceProfileV1Schema', AssuranceProfileV1Schema), consumers: [
    expectation('AAV-002/006', assuranceProfileFixture), expectation('lifecycle execution', assuranceProfileFixture),
  ] },
  { contract: 'LifecycleEvidence', version: 'rorca.lifecycle-evidence.v1', provider: functionProvider('AAV-006 lifecycle adapter', 'backend/src/lib/ssdlc-evidence.ts#createCanonicalEvidence', validateCanonicalEvidence), consumers: [
    expectation('AAV assurance kernel/evidence adapter', lifecycleEvidenceFixture), expectation('US-005 evaluator', lifecycleEvidenceFixture),
  ] },
  { contract: 'HermesEvidence', version: 'hermes.evidence.v1', provider: functionProvider('Hermes evidence ingress', 'backend/src/lib/ssdlc-evidence.ts#parseHermesEvidenceEnvelope', parseHermesEvidenceEnvelope), consumers: [
    expectation('AAV evidence adapter', hermesEvidenceFixture), expectation('US-005 evaluator', hermesEvidenceFixture),
  ] },
  { contract: 'OrchestrationEvent', version: 'rorca.orchestration-event.v1', provider: zodProvider('AAV-007', 'backend/src/lib/omp-orchestration-events.ts#OrchestrationEventV1Schema', OrchestrationEventV1Schema), consumers: [
    expectation('AAV Run View', orchestrationFixture, transportAssertion('orchestration')), expectation('AAV-011 subscription', orchestrationFixture, transportAssertion('orchestration')),
  ] },
  { contract: 'GatewayEvent', version: 'rorca.gateway-event.v1', provider: zodProvider('HMG-010', 'backend/src/lib/gateway-events.ts#GatewayEventV1Schema', GatewayEventV1Schema), consumers: [
    expectation('Hermes supervisor', gatewayFixture, transportAssertion('gateway')), expectation('AAV-011 subscription', gatewayFixture, transportAssertion('gateway')),
  ] },
  { contract: 'StructuredFinding', version: 'rorca.structured-finding.v1', provider: zodProvider('US-006', 'backend/src/ssdlc/skills/findings.ts#StructuredFindingSchema', StructuredFindingSchema), consumers: [
    expectation('AAV phase-review agents', findingFixture),
  ] },
  { contract: 'LearnCandidate', version: 'rorca.learn-candidate.v1', provider: functionProvider('US-007', 'backend/src/ssdlc/learn/learn-loop.ts#consumeProductionOutcome', validateLearnCandidate), consumers: [
    expectation('AAV-022 adapter', learnOutcomeFixture, (artifact) => { if (record(artifact).status !== 'pending-review') throw new TypeError('AAV-022 expects pending review'); }),
  ] },
]);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`).join(',')}}`;
}

export function resolveContract(contract: string, version: string, registry = SSDLC_CONTRACT_REGISTRY): ContractRegistration {
  const found = registry.find((entry) => entry.contract === contract && entry.version === version);
  if (!found) throw new ContractRegistryError('UNKNOWN_VERSION', `No provider owns ${contract}@${version}`);
  return found;
}

export async function verifyContractRegistry(registry: readonly ContractRegistration[] = SSDLC_CONTRACT_REGISTRY): Promise<RegistryReceipt> {
  const ownership = new Set<string>();
  let assertionCount = 0;
  for (const entry of registry) {
    const key = `${entry.contract}@${entry.version}`;
    if (ownership.has(key)) throw new ContractRegistryError('DUPLICATE_OWNER', `Multiple providers own ${key}`);
    ownership.add(key);
    if (!entry.consumers.length || entry.consumers.some((consumer) => !consumer.consumer.trim() || typeof consumer.assert !== 'function')) {
      throw new ContractRegistryError('MISSING_CONSUMER_ASSERTION', `${key} has an unnamed consumer or no executable assertion`);
    }
    let provider: Awaited<ReturnType<ContractProvider['load']>>;
    try { provider = await entry.provider.load(); } catch (error) {
      throw new ContractRegistryError('INVALID_PROVIDER_ARTIFACT', `${key} provider artifact failed to load: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const consumer of entry.consumers) {
      try {
        const fixture = typeof consumer.fixture === 'function' ? await consumer.fixture() : structuredClone(consumer.fixture);
        const artifact = provider.validate(fixture);
        await consumer.assert(artifact);
        assertionCount += 1;
      } catch (error) {
        throw new ContractRegistryError('CONSUMER_ASSERTION_FAILED', `${key} -> ${consumer.consumer} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const contracts = registry.map((entry) => ({
    contract: entry.contract, version: entry.version, provider: entry.provider.owner, artifactPath: entry.provider.artifactPath,
    consumers: entry.consumers.map(({ consumer }) => consumer),
  }));
  const body = { schemaVersion: 'rorca.ssdlc-contract-registry-receipt.v1' as const, registryVersion: '1' as const,
    contractCount: contracts.length, assertionCount, contracts };
  return { ...body, digest: `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}` };
}
