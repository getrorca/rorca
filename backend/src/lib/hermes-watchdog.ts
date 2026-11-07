/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Hermes watchdog v2 (AAV-020).
 *
 * This module is an event consumer at the Hermes supervision boundary. It is
 * deliberately not a worker, poller, scheduler, or execution engine. Canonical
 * run mutation remains behind `invokeGovernedRorcaAction`, which returns the
 * durable Rorca receipt that is copied into the Hermes audit event.
 */
import { requireHermesAction, type HermesAuthorityDeclaration } from './hermes-authority';
import type { RunAgentType } from './run-metadata';

export interface WatchdogRegistration {
  workspaceId: string;
  specPath: string;
  specSlug: string;
  maxAttempts: number;
  attempt: number;
  lastRunId: number | null;
  lastHealing: string | null;
  startedAt: string;
  authority: HermesAuthorityDeclaration;
}

export type WatchdogFailureClass =
  | 'provider_usage_limit'
  | 'connection_error'
  | 'engine_exit'
  | 'authority_conflict'
  | 'worktree_stale'
  | 'unknown';

export type WatchdogHealingActionKind =
  | 'restart'
  | 'alternate_model'
  | 'worktree_refresh'
  | 'authority_reprovision';

export interface WatchdogRunLineage {
  workspaceId: string;
  specPath: string;
  runId: number;
  rootRunId: number;
  attemptId: string;
  /** Effective execution identity, not the Hermes audit actor. */
  executionIdentity: string;
  executor: RunAgentType;
  model: string;
  worktreeId: string;
}

export interface WatchdogCanonicalEvent {
  eventId: string;
  eventType: 'run' | 'gate' | 'evidence';
  runStatus: string;
  healingAttempt: number;
  maxHealingAttempts: number;
  lineage: Readonly<WatchdogRunLineage>;
  evidence: readonly string[];
}

export interface WatchdogDiagnosis {
  failureClass: WatchdogFailureClass;
  source: 'deterministic' | 'bounded_llm';
  reason: string;
  evidence: readonly string[];
}

export interface WatchdogHealingAction {
  kind: WatchdogHealingActionKind;
  reason: string;
  lineage: Readonly<WatchdogRunLineage>;
  /** Exact model Rorca must use. Different only for alternate_model. */
  requestedModel: string;
}

export interface WatchdogActionReceipt {
  receiptId: string;
  action: WatchdogHealingActionKind;
  accepted: boolean;
  outcome: string;
  sourceRunId: number;
  rootRunId: number;
  attemptId: string;
  executionIdentity: string;
  model: string;
  worktreeId: string;
}

export type WatchdogOutcome = 'held_in_flight' | 'held_non_failure' | 'exhausted' | 'applied' | 'refused' | 'failed';

export interface HermesWatchdogEvent {
  schemaVersion: 'hermes.watchdog.v2';
  hermesAuditIdentity: string;
  sourceEventId: string;
  sourceEventType: WatchdogCanonicalEvent['eventType'];
  lineage: Readonly<WatchdogRunLineage>;
  diagnosis: WatchdogDiagnosis | null;
  action: WatchdogHealingAction | null;
  receipt: WatchdogActionReceipt | null;
  outcome: WatchdogOutcome;
  reason: string;
}

export interface NovelFailureSynthesis {
  failureClass: string;
  action: WatchdogHealingActionKind;
  reason: string;
}

export interface HermesWatchdogDependencies {
  /** The sole mutation path. Implementations call Rorca's governed action API. */
  invokeGovernedRorcaAction(action: WatchdogHealingAction): Promise<WatchdogActionReceipt>;
  /** Must durably bind the complete envelope to the Hermes event stream. */
  emitDurableHermesEvent(event: HermesWatchdogEvent): Promise<void>;
  /** Optional and called at most once, only for an unknown deterministic class. */
  synthesizeNovelFailure?(input: {
    evidence: readonly string[];
    allowedActions: readonly WatchdogHealingActionKind[];
  }): Promise<NovelFailureSynthesis>;
  novelSynthesisTimeoutMs?: number;
}

export interface HermesWatchdogResult {
  outcome: WatchdogOutcome;
  diagnosis: WatchdogDiagnosis | null;
  action: WatchdogHealingAction | null;
  receipt: WatchdogActionReceipt | null;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_SYNTHESIS_TIMEOUT_MS = 2_000;
const MAX_EVIDENCE_ITEMS = 8;
const MAX_EVIDENCE_CHARS = 500;
const IN_FLIGHT_STATUSES = new Set(['queued', 'running', 'starting', 'paused', 'pi_native']);
const HEALABLE_STATUSES = new Set(['failed', 'cancelled', 'partial_failure', 'manual_review_required', 'refused']);
const ALLOWED_ACTIONS: readonly WatchdogHealingActionKind[] = [
  'restart',
  'alternate_model',
  'worktree_refresh',
  'authority_reprovision',
];

/** Named alternates are explicit policy, never an LLM-selected model. */
const MODEL_ALTERNATES: Readonly<Record<string, string>> = Object.freeze({
  'openai-codex/gpt-5.6-sol': 'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-flash': 'openai-codex/gpt-5.6-sol',
});

const registrations = new Map<string, WatchdogRegistration>();

export function registerWatchdogWatch(input: {
  workspaceId: string;
  specPath: string;
  specSlug: string;
  maxAttempts?: number;
  authority: HermesAuthorityDeclaration;
}): WatchdogRegistration {
  requireHermesAction(input.authority, 'watchdog', 'operator-dispatch');
  const key = `${input.workspaceId}::${input.specSlug}`;
  const existing = registrations.get(key);
  if (existing) return existing;
  const registration: WatchdogRegistration = {
    workspaceId: input.workspaceId,
    specPath: input.specPath,
    specSlug: input.specSlug,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    attempt: 0,
    lastRunId: null,
    lastHealing: null,
    startedAt: new Date().toISOString(),
    authority: input.authority,
  };
  registrations.set(key, registration);
  return registration;
}

export function watchdogState(authority: HermesAuthorityDeclaration): Array<WatchdogRegistration> {
  requireHermesAction(authority, 'subscription', 'service-audit');
  return [...registrations.values()];
}

export function stopWatchdogWatch(
  workspaceId: string,
  specSlug: string,
  authority: HermesAuthorityDeclaration,
): boolean {
  requireHermesAction(authority, 'watchdog', 'operator-dispatch');
  return registrations.delete(`${workspaceId}::${specSlug}`);
}

function boundedEvidence(evidence: readonly string[]): string[] {
  return evidence.slice(0, MAX_EVIDENCE_ITEMS).map((item) => String(item).slice(0, MAX_EVIDENCE_CHARS));
}

/** Pure, ordered classification for every known field failure class. */
export function classifyKnownWatchdogFailure(evidence: readonly string[]): WatchdogFailureClass {
  const text = boundedEvidence(evidence).join('\n').toLowerCase();
  if (/(usage limit|rate limit|quota|insufficient[_ ]credits)/.test(text)) return 'provider_usage_limit';
  if (/(connection error|network error|econnrefused|etimedout|socket hang up)/.test(text)) return 'connection_error';
  if (/(terminalized run authority|authority snapshot|lease fence|authority denied)/.test(text)) return 'authority_conflict';
  if (/(already registered worktree|worktree.*missing|worktree add|stale worktree)/.test(text)) return 'worktree_stale';
  if (/(engine_exit|engine_interrupted|executor exited|process exit)/.test(text)) return 'engine_exit';
  return 'unknown';
}

function deterministicAction(
  failureClass: Exclude<WatchdogFailureClass, 'unknown'>,
  model: string,
): Pick<WatchdogHealingAction, 'kind' | 'requestedModel' | 'reason'> {
  if (failureClass === 'provider_usage_limit') {
    const alternate = MODEL_ALTERNATES[model];
    if (alternate) return { kind: 'alternate_model', requestedModel: alternate, reason: `named alternate for provider limit on ${model}` };
    return { kind: 'restart', requestedModel: model, reason: `no named alternate for provider limit on ${model}; preserve model` };
  }
  if (failureClass === 'worktree_stale') return { kind: 'worktree_refresh', requestedModel: model, reason: 'refresh stale worktree through Rorca authority' };
  if (failureClass === 'authority_conflict') return { kind: 'authority_reprovision', requestedModel: model, reason: 're-provision authority through Rorca authority' };
  return { kind: 'restart', requestedModel: model, reason: `restart after ${failureClass}` };
}

async function boundedNovelDiagnosis(
  dependencies: HermesWatchdogDependencies,
  evidence: readonly string[],
): Promise<NovelFailureSynthesis | null> {
  if (!dependencies.synthesizeNovelFailure) return null;
  const timeoutMs = Math.max(1, Math.min(dependencies.novelSynthesisTimeoutMs ?? DEFAULT_SYNTHESIS_TIMEOUT_MS, 10_000));
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      dependencies.synthesizeNovelFailure({ evidence, allowedActions: ALLOWED_ACTIONS }),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } catch {
    // Novel assistance is advisory. Provider failure cannot bypass the governed
    // fallback or prevent the diagnosis/outcome envelope from being persisted.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function receiptPreservesLineage(receipt: WatchdogActionReceipt, action: WatchdogHealingAction): boolean {
  return receipt.action === action.kind
    && receipt.sourceRunId === action.lineage.runId
    && receipt.rootRunId === action.lineage.rootRunId
    && receipt.attemptId === action.lineage.attemptId
    && receipt.executionIdentity === action.lineage.executionIdentity
    && receipt.model === action.requestedModel
    && receipt.worktreeId === action.lineage.worktreeId;
}

export function createHermesWatchdogV2(dependencies: HermesWatchdogDependencies): {
  consume(event: WatchdogCanonicalEvent, authority: HermesAuthorityDeclaration): Promise<HermesWatchdogResult>;
} {
  async function emit(
    event: WatchdogCanonicalEvent,
    authority: HermesAuthorityDeclaration,
    diagnosis: WatchdogDiagnosis | null,
    action: WatchdogHealingAction | null,
    receipt: WatchdogActionReceipt | null,
    outcome: WatchdogOutcome,
    reason: string,
  ): Promise<HermesWatchdogResult> {
    await dependencies.emitDurableHermesEvent({
      schemaVersion: 'hermes.watchdog.v2',
      hermesAuditIdentity: authority.auditIdentity,
      sourceEventId: event.eventId,
      sourceEventType: event.eventType,
      lineage: event.lineage,
      diagnosis,
      action,
      receipt,
      outcome,
      reason,
    });
    return { outcome, diagnosis, action, receipt };
  }

  return {
    async consume(event, authority) {
      requireHermesAction(authority, 'watchdog', 'operator-dispatch');

      // The canonical controller owns these states. Observing them can only
      // produce an audit hold; it can never dispatch or restart work in flight.
      if (IN_FLIGHT_STATUSES.has(event.runStatus.toLowerCase())) {
        return emit(event, authority, null, null, null, 'held_in_flight', `canonical run is ${event.runStatus}`);
      }
      if (!HEALABLE_STATUSES.has(event.runStatus.toLowerCase())) {
        return emit(event, authority, null, null, null, 'held_non_failure', `canonical run is not healable: ${event.runStatus}`);
      }
      if (event.healingAttempt >= event.maxHealingAttempts) {
        return emit(event, authority, null, null, null, 'exhausted', 'healing attempt budget exhausted');
      }

      const evidence = boundedEvidence(event.evidence);
      const knownClass = classifyKnownWatchdogFailure(evidence);
      let diagnosis: WatchdogDiagnosis;
      let selected: Pick<WatchdogHealingAction, 'kind' | 'requestedModel' | 'reason'>;

      if (knownClass !== 'unknown') {
        diagnosis = { failureClass: knownClass, source: 'deterministic', reason: `matched ${knownClass}`, evidence };
        selected = deterministicAction(knownClass, event.lineage.model);
      } else {
        const synthesized = await boundedNovelDiagnosis(dependencies, evidence);
        const validAction = synthesized && ALLOWED_ACTIONS.includes(synthesized.action);
        diagnosis = {
          failureClass: 'unknown',
          source: 'bounded_llm',
          reason: synthesized?.reason?.slice(0, 500) || 'novel synthesis unavailable or timed out',
          evidence,
        };
        if (validAction && synthesized.action === 'alternate_model') {
          const alternate = MODEL_ALTERNATES[event.lineage.model];
          selected = alternate
            ? { kind: 'alternate_model', requestedModel: alternate, reason: diagnosis.reason }
            : { kind: 'restart', requestedModel: event.lineage.model, reason: 'novel alternate unavailable; preserve model and restart' };
        } else {
          selected = validAction
            ? { kind: synthesized.action, requestedModel: event.lineage.model, reason: diagnosis.reason }
            : { kind: 'restart', requestedModel: event.lineage.model, reason: 'bounded novel fallback restart' };
        }
      }

      const action: WatchdogHealingAction = { ...selected, lineage: event.lineage };
      try {
        const receipt = await dependencies.invokeGovernedRorcaAction(action);
        if (!receipt.accepted || !receiptPreservesLineage(receipt, action)) {
          return emit(event, authority, diagnosis, action, receipt, 'refused',
            receipt.accepted ? 'canonical receipt did not preserve exact lineage' : receipt.outcome);
        }
        return emit(event, authority, diagnosis, action, receipt, 'applied', receipt.outcome);
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 500) : 'canonical action failed';
        return emit(event, authority, diagnosis, action, null, 'failed', reason);
      }
    },
  };
}
