/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'crypto';
import { ValidationError } from './errors';

export const CONTEXT_EVENT_TYPES = [
  'manual_cli_note',
  'manual_note',
  'git_commit',
  'git_range',
  'daemon_scan',
  'pr_merge',
  'incident',
  'duckbrain_import',
  'duckbrain_memory',
  'hermes_event',
  'hermes_session',
] as const;

export type ContextEventType = typeof CONTEXT_EVENT_TYPES[number];

export const CONTEXT_TRUST_TIERS = [
  'agent_observation',
  'working_note',
  'engineering_decision',
  'approved_policy',
  'verified_fact',
] as const;

export type ContextTrustTier = typeof CONTEXT_TRUST_TIERS[number];

export const MEMORY_CANDIDATE_CATEGORIES = [
  'Architecture',
  'Convention',
  'Bug Fix',
  'Decision',
  'Pattern',
  'Gotcha',
] as const;

export type MemoryCandidateCategory = typeof MEMORY_CANDIDATE_CATEGORIES[number];

export const MEMORY_CANDIDATE_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type MemoryCandidateConfidence = typeof MEMORY_CANDIDATE_CONFIDENCES[number];

export const MEMORY_CANDIDATE_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'superseded',
  'duplicate',
  'deferred',
] as const;

export type MemoryCandidateStatus = typeof MEMORY_CANDIDATE_STATUSES[number];

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeJsonObject(value: unknown, fieldName: string): JsonObject {
  if (value == null) return {};
  if (!isJsonObject(value)) {
    throw new ValidationError(`${fieldName} must be an object`);
  }
  return value;
}

export function normalizeRelatedFiles(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new ValidationError('relatedFiles must be an array of non-empty strings');
  }

  return [...new Set(value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0))];
}

export function parsePositiveId(value: unknown, fieldName: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

export function parseOptionalDate(value: unknown, fieldName: string): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName} must be an ISO timestamp string`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`${fieldName} must be a valid ISO timestamp`);
  }
  return date.toISOString();
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (isJsonObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

export function sha256Hex(value: unknown): string {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

export function buildContextEventIdempotencyKey(input: {
  workspaceId: string;
  sourceSystem: string;
  contentHash?: string | null;
  eventType: string;
  sourceRef: string;
  summary: string;
  payload: JsonObject;
  relatedFiles: string[];
}): { idempotencyKey: string; contentHash: string } {
  const contentHash = input.contentHash?.trim() || sha256Hex({
    eventType: input.eventType,
    sourceRef: input.sourceRef,
    summary: input.summary,
    payload: input.payload,
    relatedFiles: input.relatedFiles,
  });

  return {
    contentHash,
    idempotencyKey: `context-event:${input.workspaceId}:${input.sourceSystem}:${contentHash}`,
  };
}

export function buildMemoryCandidateIdempotencyKey(input: {
  workspaceId: string;
  contextEventId?: string | number | null;
  sourceSystem?: string | null;
  sourceRef?: string | null;
  title: string;
  rule: string;
  context: string;
  suggestedCategory: string;
  relatedFiles: string[];
}): { idempotencyKey: string; contentHash: string } {
  const contentHash = sha256Hex({
    title: input.title,
    rule: input.rule,
    context: input.context,
    suggestedCategory: input.suggestedCategory,
    relatedFiles: input.relatedFiles,
  });
  if (input.contextEventId) {
    return {
      contentHash,
      idempotencyKey: `memory-candidate:${input.workspaceId}:event:${input.contextEventId}:${contentHash}`,
    };
  }

  const sourceRef = input.sourceRef?.trim();
  if (sourceRef) {
    const sourceHash = sha256Hex({ sourceSystem: input.sourceSystem ?? 'unknown', sourceRef });
    return {
      contentHash,
      idempotencyKey: `memory-candidate:${input.workspaceId}:source:${sourceHash}`,
    };
  }

  return {
    contentHash,
    idempotencyKey: `memory-candidate:${input.workspaceId}:content:${contentHash}`,
  };
}
