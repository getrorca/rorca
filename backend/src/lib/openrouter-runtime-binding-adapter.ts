/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { z } from 'zod';
import { ConflictError } from './errors';

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const RuntimeSecretBindingReferenceSchema = z.object({
  adapterId: z.string().trim().min(1).max(120),
  bindingId: z.string().trim().min(1).max(255),
  workspaceId: z.string().trim().min(1).max(255),
  environmentId: z.string().trim().min(1).max(255),
  generation: z.number().int().positive(),
}).strict();
export type RuntimeSecretBindingReference = z.infer<typeof RuntimeSecretBindingReferenceSchema>;
export const RuntimeSecretReferenceSchema = z.object({
  secretId: z.string().uuid(),
  fingerprint: Sha256Schema,
}).strict();
export type RuntimeSecretReference = z.infer<typeof RuntimeSecretReferenceSchema>;


export const RuntimeSecretBindingStageResultSchema = z.object({
  bindingGeneration: z.number().int().positive(),
  requiresDeployment: z.boolean(),
}).strict();
export type RuntimeSecretBindingStageResult = z.infer<typeof RuntimeSecretBindingStageResultSchema>;

export const RuntimeTargetRevisionSchema = z.object({
  bindingGeneration: z.number().int().positive(),
  deployedRevision: z.string().trim().min(1).max(255),
}).strict();
export type RuntimeTargetRevision = z.infer<typeof RuntimeTargetRevisionSchema>;

export const RuntimeProviderCompletionEvidenceSchema = z.object({
  kind: z.literal('provider-completion'),
  providerId: z.literal('openrouter'),
  endpoint: z.literal('chat-completions'),
  contractId: z.string().trim().min(1).max(255),
  contractVersion: z.number().int().positive(),
  requestDigest: Sha256Schema,
  responseAssertionDigest: Sha256Schema,
  modelId: z.string().trim().min(1).max(255),
  targetBindingGeneration: z.number().int().positive(),
  deployedRevision: z.string().trim().min(1).max(255),
  providerResponseDigest: Sha256Schema,
  completedAt: z.string().datetime(),
}).strict();
export type RuntimeProviderCompletionEvidence = z.infer<typeof RuntimeProviderCompletionEvidenceSchema>;

export const RuntimeProviderRejectionEvidenceSchema = z.object({
  kind: z.literal('provider-completion-rejection'),
  providerId: z.literal('openrouter'),
  endpoint: z.literal('chat-completions'),
  keyFingerprint: Sha256Schema,
  rejectionStatus: z.union([z.literal(401), z.literal(403)]),
  providerResponseDigest: Sha256Schema,
  verifiedAt: z.string().datetime(),
}).strict();
export type RuntimeProviderRejectionEvidence = z.infer<typeof RuntimeProviderRejectionEvidenceSchema>;

interface RuntimeAdapterOperation {
  intentDigest: string;
  fencingToken: number;
  binding: RuntimeSecretBindingReference;
  deadlineAt: string;
  signal: AbortSignal;
}

export interface StageRuntimeSecretInput extends RuntimeAdapterOperation {
  replacement: RuntimeSecretReference;
}

export interface DeployRuntimeSecretInput extends RuntimeAdapterOperation {
  bindingGeneration: number;
  requiresDeployment: boolean;
}

export interface RunRuntimeCompletionCanaryInput extends RuntimeAdapterOperation {
  bindingGeneration: number;
  deployedRevision: string;
  canary: Readonly<{
    contractId: string;
    contractVersion: number;
    requestDigest: string;
    responseAssertionDigest: string;
    modelId: string;
    maxTokens: number;
  }>;
}

export interface ActivateRuntimeSecretInput extends RuntimeAdapterOperation {
  bindingGeneration: number;
  deployedRevision: string;
}

export interface VerifyRuntimeCredentialRejectedInput extends RuntimeAdapterOperation {
  bindingGeneration: number;
  deployedRevision: string;
  rejectedCredential: RuntimeSecretReference;
}

export interface RestoreRuntimeSecretBindingInput extends RuntimeAdapterOperation {
  priorBindingGeneration: number;
  failedBindingGeneration: number | null;
  failedDeployedRevision: string | null;
}

/**
 * Trusted target boundary for runtime-key staging, rollback, and provider-backed verification.
 * Mutations are idempotent for the exact intent digest and fencing token. Restoration must
 * settle the prior generation before provider replacement cleanup may begin.
 * Implementations resolve SecretStore references internally and never return key values.
 */
export interface RuntimeSecretBindingAdapter {
  readonly adapterId: string;
  stageReplacement(input: StageRuntimeSecretInput): Promise<RuntimeSecretBindingStageResult>;
  deployOrRefresh(input: DeployRuntimeSecretInput): Promise<RuntimeTargetRevision>;
  runProviderCompletionCanary(input: RunRuntimeCompletionCanaryInput): Promise<RuntimeProviderCompletionEvidence>;
  activateStagedBinding(input: ActivateRuntimeSecretInput): Promise<RuntimeTargetRevision>;
  restorePriorBinding(input: RestoreRuntimeSecretBindingInput): Promise<RuntimeTargetRevision>;
  verifyProviderCredentialRejected(
    input: VerifyRuntimeCredentialRejectedInput,
  ): Promise<RuntimeProviderRejectionEvidence>;
}

export interface RuntimeSecretBindingAdapterResolver {
  resolve(adapterId: string): RuntimeSecretBindingAdapter | null;
}

export class RuntimeSecretBindingAdapterRegistry implements RuntimeSecretBindingAdapterResolver {
  private readonly adapters = new Map<string, RuntimeSecretBindingAdapter>();

  register(adapter: RuntimeSecretBindingAdapter): () => void {
    const adapterId = z.string().trim().min(1).max(120).parse(adapter.adapterId);
    if (this.adapters.has(adapterId)) {
      throw new ConflictError(`Runtime secret binding adapter ${adapterId} is already registered`);
    }
    this.adapters.set(adapterId, adapter);
    return () => {
      if (this.adapters.get(adapterId) === adapter) this.adapters.delete(adapterId);
    };
  }

  resolve(adapterId: string): RuntimeSecretBindingAdapter | null {
    return this.adapters.get(adapterId) ?? null;
  }
}

export const runtimeSecretBindingAdapters = new RuntimeSecretBindingAdapterRegistry();
