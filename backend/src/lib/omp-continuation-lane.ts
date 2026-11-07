/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// ─── omp continuation lane (W5-008) ─────────────────────────────────────────
// Production wiring for PiManagedContinuationController + NormativeContinuationLane
// with an omp transport adapter. The controller (Wave 3A design surface) is now
// constructed from production paths (worker construction site + dispatch
// handling) — no test-only wiring remains. The checkpoint/retry/context stores
// are DB-backed over the existing wave-2 continuation tables through the
// canonical-writer machinery in governed-mission-service; only the transport
// (`PiRpcManagedAdapter`) and the events sink are omp/projection-specific.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { canonicalTransaction } from '../db';
import { logger } from './logger';
import { governedHash } from './governed-contracts';
import {
  ContextBundleV1Schema,
  ContextCheckpointV1Schema,
  ContextPolicyActivationV1Schema,
  ContinuationDispatchV1Schema,
  RetrievalReceiptV1Schema,
  type ContinuationScope,
} from './governed-contracts';
import {
  PiManagedContinuationController,
  type AggregateRetryBudget,
  type CanonicalContextClient,
  type CanonicalRetrievalOutput,
  type ContinuationAuthorizer,
  type ManagedCheckpointStore,
  type ManagedContinuationFence,
  type ManagedClock,
  type ManagedContinuationCheckpointInput,
  type ManagedContinuationDispatchMaterial,
  type ManagedContinuationEventSink,
  type ManagedContinuationOutcome,
  type ManagedLeaseVerifier,
  type PiRpcManagedAdapter,
  type PolicyActivationVerifier,
} from './pi-managed-continuation-controller';
import { prepareAutonomousModelSandboxLaunch } from './autonomous-sandbox';
import {
  ManagedAdmissionError,
  type ManagedExecutorStore,
} from './rorca-managed-executor';
import { OmpManagedExecutor, OmpManagedProcessBridge, OMP_MANAGED_PROFILE, buildOmpChildEnv, processIdentityAlive } from './omp-managed-executor';
import { requireOmp, type OmpStatus } from './omp-detector';
import type { Wave3AImplementationGate } from './wave3a-managed-executor-gate';
import type { NormativeContinuationLane } from './federated-continuation-adapter';
import {
  authorizeContinuationDispatch,
  authorizeWave2Transaction,
  claimContinuationRetry,
  consumeContinuationDispatch,
  settleContinuationRetry,
  type GovernedMutationContext,
} from './governed-mission-service';
import { shouldResolvePiRpcStory } from './agent-completion-protocol';

// Re-export the controller through this production module so production paths
// (worker/service/routes) and the controller test suite import one surface.
export { PiManagedContinuationController };
export type {
  AggregateRetryBudget,
  CanonicalContextClient,
  CanonicalRetrievalOutput,
  ContinuationAuthorizer,
  ManagedCheckpointStore,
  ManagedContinuationFence,
  ManagedClock,
  ManagedContinuationCheckpointInput,
  ManagedContinuationDispatchMaterial,
  ManagedContinuationEventSink,
  ManagedContinuationOutcome,
  ManagedLeaseVerifier,
  PiRpcManagedAdapter,
  PolicyActivationVerifier,
} from './pi-managed-continuation-controller';
export type { NormativeContinuationLane } from './federated-continuation-adapter';

const OMP_LANE_CONTEXT: GovernedMutationContext = {
  principalId: 'omp-managed-controller',
  authoritySource: 'runtime_lease',
  idempotencyKey: 'omp-lane',
  correlationId: 'omp-lane',
};

function stableHash(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function artifactHeader(schemaVersion: string, artifactId: string, contentHash: string, createdAt: string): {
  schemaVersion: string; contractId: string; contractVersion: '1.0.0'; artifactId: string; contentHash: string;
  createdAt: string; createdBy: string;
} {
  return { schemaVersion, contractId: schemaVersion, contractVersion: '1.0.0', artifactId, contentHash, createdAt, createdBy: 'omp-managed-controller' };
}

// ─── omp RPC transport (PiRpcManagedAdapter) ────────────────────────────────

interface OmpRpcPending { resolve: (r: unknown) => void; reject: (e: Error) => void }

interface ActiveOmpRpcSession {
  process: ChildProcess;
  requestId: number;
  pending: Map<string, OmpRpcPending>;
  eventListeners: Array<(event: unknown) => void>;
  stderr: string;
  detachedProcessGroup: boolean;
  /** Actual persisted omp rpc session id returned by new_session. */
  rpcSessionId: string | null;
  /** Provider-emitted initial cursor from get_state (null when absent). */
  initialCursor: number | null;
  /** Count of observed turn_end events — observed provider output. */
  observedTurns: number;
  /** Hash of observed provider output (message deltas). */
  observedOutputHash: crypto.Hash;
  /** Observed OS-process death (close/exit). */
  closed: boolean;
  /** Durable death receipt once OS death is observed. */
  deathReceiptHash: string | null;
  exitCode: number | null;
  settledObservation: { settled: true; turnId: string; generation: number; entryId: string; entryHash: string; cursor: number } | null;
}

/** Narrowed read of a string field from an unknown provider event/state object. */
function readStringField(container: unknown, key: string): string | null {
  if (container !== null && typeof container === 'object' && key in container) {
    // `key in container` proved the member exists; the value is validated below.
    const record = container as Record<string, unknown>;
    const candidate = record[key];
    return typeof candidate === 'string' ? candidate : null;
  }
  return null;
}

/** Narrowed read of a finite number field from an unknown provider event/state object. */
function readNumberField(container: unknown, key: string): number | null {
  if (container !== null && typeof container === 'object' && key in container) {
    // `key in container` proved the member exists; the value is validated below.
    const record = container as Record<string, unknown>;
    const candidate = record[key];
    return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
  }
  return null;
}


/**
 * omp-backed same-session transport for the managed continuation controller.
 * Spawns `omp --mode rpc --profile rorca`, bootstraps a fresh session, sends
 * the rendered payload as the RPC prompt, and waits for the canonical
 * `agent_settled` authority before reporting the send receipt.
 */
export class OmpContinuationRpcAdapter implements PiRpcManagedAdapter {
  private active: ActiveOmpRpcSession | null = null;
  private lastSettled: { settled: true; turnId: string; generation: number; entryId: string; entryHash: string; cursor: number } | null = null;
  private lastDeathReceiptHash: string | null = null;
  private readonly thinkingLevel: string;

  constructor(
    private readonly options: { bin: string; ompVersion: string | null; trustedEnvironment: Readonly<NodeJS.ProcessEnv>; thinkingLevel?: string; cwd?: string },
  ) {
    this.thinkingLevel = options.thinkingLevel ?? 'high';
  }

  async sendSameSession(input: Readonly<{ sessionId: string; renderedPayload: string; dispatchId: string; continuationKey: string }>): Promise<{ sendReceiptHash: string }> {
    const session = await this.spawnSession(input.sessionId);
    try {
      // Bind the ACTUAL persisted omp rpc session: the provider-issued session
      // id from new_session, never a fabricated value from the request.
      const newSession = await this.command(session, { type: 'new_session' });
      const newSessionData = newSession !== null && typeof newSession === 'object' && 'data' in newSession ? newSession.data : null;
      const rpcSessionId = readStringField(newSessionData, 'sessionId');
      if (!rpcSessionId) {
        throw new Error('omp continuation new_session did not return a persisted rpc session id');
      }
      session.rpcSessionId = rpcSessionId;
      const state = await this.command(session, { type: 'get_state' });
      const stateData = state !== null && typeof state === 'object' && 'data' in state ? state.data : null;
      const stateObj = stateData !== null && typeof stateData === 'object' && 'state' in stateData ? stateData.state : stateData;
      const rawInitialCursor = readNumberField(stateObj, 'cursor')
        ?? (stateObj !== null && typeof stateObj === 'object' && 'turn' in stateObj ? readNumberField(stateObj.turn, 'cursor') : null)
        ?? readNumberField(stateData, 'cursor');
      session.initialCursor = rawInitialCursor;
      const promptFile = this.writePrompt(input.sessionId, input.renderedPayload);
      try {
        const promptText = fs.readFileSync(promptFile.path, 'utf8');
        const settledPromise = new Promise<{ turnId: string; generation: number; entryId: string; entryHash: string; cursor: number }>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('omp continuation prompt settle timeout')), 300_000);
          timeout.unref();
          const listener = (event: unknown): void => {
            const data = typeof event === 'object' && event !== null ? event as Record<string, unknown> : null;
            if (!data) return;
            const eventType = typeof data.type === 'string' ? data.type : '';
            if (eventType === 'message_update') {
              const delta = readStringField(data, 'delta') ?? readStringField(data.assistantMessageEvent, 'delta');
              if (delta) session.observedOutputHash.update(delta);
              return;
            }
            if (eventType === 'turn_end') {
              session.observedTurns += 1;
              return;
            }
            if (shouldResolvePiRpcStory(eventType)) {
              clearTimeout(timeout);
              session.eventListeners.splice(session.eventListeners.indexOf(listener), 1);
              // Evidence is derived ONLY from observed provider output and the
              // persisted rpc session — never from dispatch/request values.
              const providerTurnId = readStringField(data, 'turnId') ?? readStringField(data.turn, 'id') ?? rpcSessionId;
              const providerGeneration = readNumberField(data, 'generation') ?? readNumberField(data.turn, 'generation') ?? session.observedTurns;
              const providerCursor = readNumberField(data, 'cursor') ?? (session.initialCursor ?? 0) + session.observedTurns;
              const entryId = readStringField(data, 'entryId') ?? readStringField(data.entry, 'id') ?? `omp:entry:${rpcSessionId}:${session.observedTurns}`;
              const entryHash = stableHash(`settled:${rpcSessionId}:${session.observedTurns}:${session.observedOutputHash.copy().digest('hex')}`);
              resolve({ turnId: providerTurnId, generation: providerGeneration, entryId, entryHash, cursor: providerCursor });
            }
            if (eventType === 'error') {
              clearTimeout(timeout);
              session.eventListeners.splice(session.eventListeners.indexOf(listener), 1);
              reject(new Error(typeof data.message === 'string' ? data.message : 'omp continuation prompt failed'));
            }
          };
          session.eventListeners.push(listener);
        });
        await this.command(session, { type: 'prompt', message: promptText });
        const settled = await settledPromise;
        const observation = Object.freeze({ settled: true as const, turnId: settled.turnId, generation: settled.generation, entryId: settled.entryId, entryHash: settled.entryHash, cursor: settled.cursor });
        session.settledObservation = observation;
        this.lastSettled = observation;
      } finally {
        promptFile.cleanup();
      }
      return { sendReceiptHash: governedHash('rorca.omp-continuation-send-receipt.v1', {
        dispatchId: input.dispatchId, continuationKey: input.continuationKey,
        sessionId: input.sessionId, renderedPayloadHash: stableHash(input.renderedPayload),
      } as never) };
    } finally {
      await this.abortCurrent('continuation_prompt_complete');
    }
  }

  async observeSettled(input: Readonly<{ sessionId: string; turnId: string; generation: number; afterCursor: number }>): Promise<Readonly<{
    settled: boolean; turnId: string; generation: number; entryId: string | null; entryHash: string | null; cursor: number;
  }>> {
    const observation = this.lastSettled;
    if (!observation || observation.turnId !== input.turnId || observation.generation !== input.generation) {
      return { settled: false, turnId: input.turnId, generation: input.generation, entryId: null, entryHash: null, cursor: input.afterCursor };
    }
    // Never synthesize a cursor advance from the caller's checkpoint cursor.
    // The stored cursor comes only from observed provider output; a stale
    // cursor stays stale so the controller fails closed on scope_mismatch.
    return observation;
  }

  async abortProcessGroup(scope: ContinuationScope, reasonCode: string): Promise<{ dead: boolean; deathReceiptHash: string }> {
    const dead = await this.abortCurrent(reasonCode);
    const deathReceiptHash = dead && this.lastDeathReceiptHash
      ? this.lastDeathReceiptHash
      : governedHash('rorca.omp-process-group-death.v1', {
          sessionId: scope.sessionId, attemptId: scope.attemptId, reasonCode, dead,
        } as never);
    return { dead, deathReceiptHash };
  }

  private async abortCurrent(reasonCode: string): Promise<boolean> {
    const session = this.active;
    if (!session) {
      // No process exists to probe — quiescence is UNPROVEN, never assumed.
      return false;
    }
    this.active = null;
    session.eventListeners.length = 0;
    const pid = session.process.pid;
    if (pid === undefined) return session.closed;
    if (!session.closed) {
      try {
        if (session.detachedProcessGroup) process.kill(-pid, 'SIGTERM');
        else session.process.kill('SIGTERM');
      } catch { /* already gone */ }
      const terminated = await this.waitForDeath(session, 1_000);
      if (!terminated && !session.closed) {
        try {
          if (session.detachedProcessGroup) process.kill(-pid, 'SIGKILL');
          else session.process.kill('SIGKILL');
        } catch { /* already gone */ }
        const killed = await this.waitForDeath(session, 1_000);
        if (!killed && !session.closed) {
          void reasonCode;
          return false;
        }
      }
    }
    if (session.closed && session.deathReceiptHash) this.lastDeathReceiptHash = session.deathReceiptHash;
    return session.closed;
  }

  /**
   * OS-process death proof: observed close/exit or an authoritative
   * process-identity probe (ESRCH). Protocol settlement is never death.
   */
  private waitForDeath(session: ActiveOmpRpcSession, timeoutMs: number): Promise<boolean> {
    if (session.closed) return Promise.resolve(true);
    const pid = session.process.pid;
    if (pid === undefined) return Promise.resolve(session.closed);
    const { promise, resolve } = Promise.withResolvers<boolean>();
    let finished = false;
    const finish = (dead: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      session.process.off('close', onClose);
      resolve(dead);
    };
    const onClose = (): void => finish(true);
    const timer = setTimeout(() => finish(!processIdentityAlive(pid)), timeoutMs);
    timer.unref();
    session.process.once('close', onClose);
    return promise;
  }



  private writePrompt(sessionId: string, renderedPayload: string): { path: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `rorca-omp-continuation-${sessionId}-`));
    const file = path.join(root, 'prompt.md');
    fs.writeFileSync(file, renderedPayload, { mode: 0o600 });
    return { path: file, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } } };
  }

  private async spawnSession(_sessionId: string): Promise<ActiveOmpRpcSession> {
    if (this.active) await this.abortCurrent('superseded_session');
    // Explicit minimal allowlist environment — the lane child never inherits
    // worker secrets or ambient provider state.
    const env = buildOmpChildEnv(this.options.trustedEnvironment);
    // The continuation child executes model prompts with agent tools — it
    // crosses the same central model-egress sandbox as the executor lane, so
    // a prompt-injected model can never reach host files or the open network.
    const launch = await prepareAutonomousModelSandboxLaunch({
      command: this.options.bin,
      args: [
        '--mode', 'rpc',
        '--profile', OMP_MANAGED_PROFILE,
        '--no-extensions',
        '--thinking', this.thinkingLevel,
        '--no-pty',
      ],
      cwd: this.options.cwd ?? process.cwd(),
      env,
    });
    const detachedProcessGroup = process.platform !== 'win32';
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: detachedProcessGroup,
    });
    const session: ActiveOmpRpcSession = {
      process: child, requestId: 0, pending: new Map(), eventListeners: [], stderr: '',
      detachedProcessGroup, rpcSessionId: null, initialCursor: null, observedTurns: 0,
      observedOutputHash: crypto.createHash('sha256'), closed: false, deathReceiptHash: null,
      exitCode: null, settledObservation: null,
    };
    this.active = session;
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    const handleChunk = (chunk: Buffer | string): void => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        this.handleLine(session, line);
        newline = buffer.indexOf('\n');
      }
    };
    child.stdout?.on('data', handleChunk);
    child.stderr?.on('data', (chunk: Buffer | string) => {
      session.stderr += chunk.toString().slice(0, 2000);
    });
    child.once('error', (error) => {
      session.stderr += `\n[omp-continuation] spawn error: ${error.message}`;
      void launch.closeModelEgress();
      for (const [id, pending] of session.pending.entries()) {
        pending.reject(new Error(`omp continuation session error: ${error.message}`));
        session.pending.delete(id);
      }
    });
    child.once('close', (code) => {
      session.closed = true;
      session.exitCode = code;
      void launch.closeModelEgress();
      session.deathReceiptHash = governedHash('rorca.omp-process-group-death.v1', {
        sessionId: session.rpcSessionId,
        pid: child.pid ?? null,
        exitCode: code,
        exitSignal: null,
      } as never);
      for (const [id, pending] of session.pending.entries()) {
        pending.reject(new Error('omp continuation session closed'));
        session.pending.delete(id);
      }
    });
    return session;
  }

  private handleLine(session: ActiveOmpRpcSession, line: string): void {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1).trim() : line.trim();
    if (!trimmed) return;
    let data: unknown;
    try { data = JSON.parse(trimmed); } catch { return; }
    if (typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'response'
        && typeof (data as { id?: unknown }).id === 'string') {
      const response = data as { id: string; success?: unknown; error?: unknown };
      const pending = session.pending.get(response.id);
      if (pending) {
        session.pending.delete(response.id);
        if (response.success === false) {
          pending.reject(new Error(typeof response.error === 'string' ? response.error : 'omp continuation command failed'));
        } else {
          pending.resolve(data);
        }
      }
      return;
    }
    for (const listener of [...session.eventListeners]) {
      try { listener(data); } catch { /* listener errors are non-fatal */ }
    }
  }

  private command(session: ActiveOmpRpcSession, command: object): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = `req_${++session.requestId}`;
      const timeout = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`omp continuation command timed out (id=${id}). stderr:\n${session.stderr.slice(-2048)}`));
      }, 30_000);
      session.pending.set(id, {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      try {
        session.process.stdin?.write(JSON.stringify({ ...command, id }) + '\n');
      } catch (error) {
        session.pending.delete(id);
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}

// ─── DB-backed controller stores (production) ───────────────────────────────

const DISPATCH_STATE_MAP: Record<string, 'proposed' | 'authorized' | 'dispatch_consumed' | 'dispatched' | 'settled' | 'expired' | 'failed' | 'quarantined'> = {
  proposed: 'proposed',
  lease_verified: 'authorized',
  authorized: 'authorized',
  dispatched: 'dispatched',
  settled: 'settled',
  expired: 'expired',
  failed: 'failed',
  quarantined: 'quarantined',
};

/**
 * Production ManagedCheckpointStore over the wave-2 continuation tables.
 * Reads flow through the canonical transaction; consumption uses the exact
 * fenced consume function (consumeContinuationDispatch); settlement/fencing
 * transition the dispatch row under the canonical writer capability.
 */
export class PostgresContinuationCheckpointStore implements ManagedCheckpointStore {
  constructor(private readonly workspaceId: string) {}

  async persistBeforeTrigger(checkpoint: unknown): Promise<{ duplicate: boolean }> {
    const parsed = ContextCheckpointV1Schema.parse(checkpoint);
    const result = await canonicalTransaction(async (client) => {
      const existing = await client.query('SELECT 1 FROM context_checkpoints WHERE workspace_id=$1 AND checkpoint_id=$2', [this.workspaceId, parsed.checkpointId]);
      if (existing.rows.length > 0) return { duplicate: true };
      await client.query(
        `INSERT INTO context_checkpoints(workspace_id,checkpoint_id,scope_key,checkpoint_hash,state,reason_code,payload_json)
         VALUES($1,$2,$3,$4,'current',$5,$6::jsonb)`,
        [this.workspaceId, parsed.checkpointId, governedHash('rorca.continuation-scope.v1', parsed.scope),
          parsed.contentHash, parsed.reasonCode, JSON.stringify(parsed)],
      );
      return { duplicate: false };
    });
    return result;
  }

  async loadDispatch(continuationKey: string): Promise<Readonly<{
    state: 'proposed' | 'authorized' | 'dispatch_consumed' | 'dispatched' | 'settled' | 'expired' | 'failed' | 'quarantined';
    dispatch: unknown;
    sendReceiptHash: string | null;
  }> | null> {
    return canonicalTransaction(async (client) => {
      const row = await client.query<{ state: string; payload_json: unknown; transport_receipt_hash: string | null }>(
        `SELECT d.state, d.payload_json, o.transport_receipt_hash
           FROM continuation_dispatches d
           LEFT JOIN continuation_dispatch_outbox o ON o.workspace_id=d.workspace_id AND o.dispatch_id=d.dispatch_id
          WHERE d.workspace_id=$1 AND d.continuation_key=$2`,
        [this.workspaceId, continuationKey],
      );
      const dispatch = row.rows[0];
      if (!dispatch) return null;
      return Object.freeze({
        state: DISPATCH_STATE_MAP[dispatch.state] ?? 'dispatched',
        dispatch: dispatch.payload_json,
        sendReceiptHash: dispatch.transport_receipt_hash ?? null,
      });
    });
  }

  async consumeDispatchCas(dispatch: unknown): Promise<Readonly<{ consumed: boolean; duplicate: boolean; authorizationExpiresAt: string }>> {
    const parsed = ContinuationDispatchV1Schema.parse(dispatch);
    const consumed = await consumeContinuationDispatch({
      workspaceId: this.workspaceId,
      dispatchId: parsed.dispatchId,
      continuationKey: parsed.continuationKey,
      leaseId: parsed.scope.leaseId,
      fencingToken: parsed.scope.fencingToken,
      runtimeId: parsed.scope.runtimeId,
    }, OMP_LANE_CONTEXT);
    const expiry = await canonicalTransaction(async (client) => {
      const row = await client.query<{ authorization_expires_at: Date }>(
        'SELECT authorization_expires_at FROM continuation_dispatches WHERE workspace_id=$1 AND dispatch_id=$2',
        [this.workspaceId, parsed.dispatchId],
      );
      return row.rows[0]?.authorization_expires_at ?? new Date(0);
    });
    return { consumed: consumed.consumed, duplicate: consumed.duplicate, authorizationExpiresAt: expiry.toISOString() };
  }

  async markDispatched(dispatchId: string, sendReceiptHash: string): Promise<void> {
    await canonicalTransaction(async (client) => {
      await authorizeWave2Transaction(client, this.workspaceId, { operation: 'continuation-outbox.settle', request: { dispatchId, sendReceiptHash } });
      await client.query(
        `UPDATE continuation_dispatch_outbox SET state='sent', transport_receipt_hash=$3, state_version=state_version+1, updated_at=clock_timestamp()
          WHERE workspace_id=$1 AND dispatch_id=$2 AND state='pending'`,
        [this.workspaceId, dispatchId, sendReceiptHash],
      );
      await client.query(
        `UPDATE continuation_dispatches SET state='dispatched', state_version=state_version+1
          WHERE workspace_id=$1 AND dispatch_id=$2 AND state='authorized'`,
        [this.workspaceId, dispatchId],
      );
    });
  }

  async settle(dispatchId: string, entryId: string, cursor: number, entryHash: string): Promise<{ duplicate: boolean }> {
    return canonicalTransaction(async (client) => {
      await authorizeWave2Transaction(client, this.workspaceId, { operation: 'continuation-outbox.settle', request: { dispatchId, entryId, cursor, entryHash } });
      const dispatch = await client.query<{ state: string; claim_fence: string; continuation_key: string }>(
        `SELECT d.state, COALESCE(o.claim_fence, 0) AS claim_fence, d.continuation_key
           FROM continuation_dispatches d
           LEFT JOIN continuation_dispatch_outbox o ON o.workspace_id=d.workspace_id AND o.dispatch_id=d.dispatch_id
          WHERE d.workspace_id=$1 AND d.dispatch_id=$2 FOR UPDATE`,
        [this.workspaceId, dispatchId],
      );
      const row = dispatch.rows[0];
      if (!row) return { duplicate: false };
      if (row.state === 'settled') return { duplicate: true };
      await client.query(
        `UPDATE continuation_dispatches SET state='settled', reason_code='assistant_cursor_advanced', state_version=state_version+1
          WHERE workspace_id=$1 AND dispatch_id=$2 AND state IN ('dispatched','authorized')`,
        [this.workspaceId, dispatchId],
      );
      await client.query(
        `INSERT INTO continuation_dispatch_outcomes
          (workspace_id,dispatch_id,outcome_sequence,claim_fence,outcome_hash,outcome_state,transport_accepted,transport_receipt_hash,reason_code)
         VALUES($1,$2,1,$3,$4,'settled',TRUE,$5,'assistant_cursor_advanced')`,
        [this.workspaceId, dispatchId, row.claim_fence, entryHash, entryHash],
      );
      void entryId; void cursor; void row.continuation_key;
      return { duplicate: false };
    });
  }

  async fence(dispatchId: string, fence: ManagedContinuationFence): Promise<void> {
    const durableReasonCode = fence.reasonCode === 'settled_timeout_writer_dead'
      ? `${fence.reasonCode}:${fence.evidenceHash}`
      : fence.reasonCode;
    await canonicalTransaction(async (client) => {
      await authorizeWave2Transaction(client, this.workspaceId, {
        operation: 'continuation-outbox.settle',
        request: { dispatchId, reasonCode: durableReasonCode },
      });
      await client.query(
        `UPDATE continuation_dispatches SET state='failed', reason_code=$3, state_version=state_version+1
          WHERE workspace_id=$1 AND dispatch_id=$2 AND state NOT IN ('settled','quarantined')`,
        [this.workspaceId, dispatchId, durableReasonCode],
      );
    });
  }
}

/** Production retry budget over claimContinuationRetry/settleContinuationRetry. */
export class PostgresContinuationRetryBudget implements AggregateRetryBudget {
  constructor(private readonly workspaceId: string, private readonly runtimeId: string) {}

  async claim(input: Readonly<{ continuationKey: string; actor: 'controller'; phase: 'retrieval' | 'transport' }>): Promise<Readonly<{ claimed: boolean; fence: number; state: 'open' | 'in_flight' | 'backoff' | 'exhausted' | 'quarantined' }>> {
    const claimed = await claimContinuationRetry({
      workspaceId: this.workspaceId,
      continuationKey: input.continuationKey,
      actorAttemptId: input.continuationKey,
      runtimeId: this.runtimeId,
      owner: 'omp-managed-controller',
      phase: input.phase,
    });
    return { claimed: claimed.claimed, fence: claimed.retryFence, state: claimed.state as 'open' | 'in_flight' | 'backoff' | 'exhausted' | 'quarantined' };
  }

  async settle(input: Readonly<{ continuationKey: string; fence: number; phase: 'retrieval' | 'transport'; outcome: 'succeeded' | 'retryable_failed' | 'permanent_conflict'; reasonCode: string }>): Promise<Readonly<{ state: string; retryable: boolean }>> {
    const settled = await settleContinuationRetry({
      workspaceId: this.workspaceId,
      continuationKey: input.continuationKey,
      runtimeId: this.runtimeId,
      owner: 'omp-managed-controller',
      retryFence: input.fence,
      phase: input.phase,
      outcome: input.outcome,
      reasonCode: input.reasonCode,
    });
    return { state: settled.state, retryable: settled.retryable };
  }
}

/** Production policy activation + lease verification over the canonical tables. */
export class PostgresContinuationAuthority implements PolicyActivationVerifier, ManagedLeaseVerifier, ContinuationAuthorizer {
  constructor(private readonly workspaceId: string) {}

  async verifyActive(activation: unknown, scope: ContinuationScope, now: string): Promise<void> {
    const parsed = ContextPolicyActivationV1Schema.parse(activation);
    const ok = await canonicalTransaction(async (client) => {
      const row = await client.query<{ effective_state: string; expires_at: Date | null }>(
        `SELECT effective_state, expires_at FROM context_policy_activation_heads WHERE workspace_id=$1 AND current_hash=$2`,
        [this.workspaceId, parsed.activationHash],
      );
      const active = row.rows[0];
      return Boolean(active && active.effective_state === 'active' && (!active.expires_at || active.expires_at.getTime() > Date.parse(now)));
    });
    if (!ok) throw new ManagedAdmissionError('scope_mismatch', 'policy activation is not active for the continuation scope');
    void scope;
  }

  async verifyExact(scope: ContinuationScope, phase: 'checkpoint' | 'retrieval' | 'pre_send' | 'settle' | 'restart'): Promise<void> {
    const ok = await canonicalTransaction(async (client) => {
      const row = await client.query<{ state: string; expires_at: Date; fencing_token: string; attempt_id: string }>(
        `SELECT state, expires_at, fencing_token, attempt_id FROM execution_leases WHERE workspace_id=$1 AND lease_id=$2`,
        [this.workspaceId, scope.leaseId],
      );
      const lease = row.rows[0];
      return Boolean(lease && lease.state === 'active' && lease.expires_at.getTime() > Date.now()
        && Number(lease.fencing_token) === scope.fencingToken && lease.attempt_id === scope.attemptId);
    });
    if (!ok) throw new ManagedAdmissionError('fence_lost', `managed lease failed ${phase} verification`);
  }

  async authorize(dispatch: unknown): Promise<void> {
    await authorizeContinuationDispatch(dispatch, OMP_LANE_CONTEXT);
  }
}

/**
 * Production context client over the canonical retrieval/bundle tables. Reads
 * are exact-scope selects; dispatch creation goes through the fenced
 * authorizeContinuationDispatch writer so the row is created exactly once.
 */
export class PostgresContinuationContextClient implements CanonicalContextClient {
  constructor(private readonly workspaceId: string) {}

  async retrieve(input: Readonly<{ scope: ContinuationScope; checkpoint: unknown; activation: unknown; forceFullBundle: boolean }>): Promise<CanonicalRetrievalOutput> {
    const checkpoint = ContextCheckpointV1Schema.parse(input.checkpoint);
    return canonicalTransaction(async (client) => {
      const rows = await client.query<{ receipt_payload: unknown; bundle_hash: string; bundle_expires_at: Date; bundle_payload: unknown }>(
        `SELECT r.payload_json AS receipt_payload, b.bundle_hash, b.expires_at AS bundle_expires_at, b.payload_json AS bundle_payload
           FROM context_checkpoints c
           JOIN context_retrieval_receipts r ON r.workspace_id=c.workspace_id AND r.checkpoint_id=c.checkpoint_id
           JOIN context_bundles b ON b.workspace_id=c.workspace_id AND b.checkpoint_id=c.checkpoint_id AND b.receipt_id=r.receipt_id
          WHERE c.workspace_id=$1 AND c.checkpoint_id=$2 ORDER BY b.created_at DESC LIMIT 1`,
        [this.workspaceId, checkpoint.checkpointId],
      );
      const row = rows.rows[0];
      if (!row) throw new ManagedAdmissionError('scope_mismatch', 'canonical context is unavailable for the continuation checkpoint');
      const receipt = RetrievalReceiptV1Schema.parse(row.receipt_payload);
      const bundle = ContextBundleV1Schema.parse(row.bundle_payload);
      void input;
      return Object.freeze({
        receipt,
        bundle,
        renderedPayloadRef: Object.freeze({
          referenceId: `reference:context:${bundle.bundleId}`,
          kind: 'context',
          hash: bundle.bundleHash,
          sensitivity: 'internal',
          retentionClass: 'retention:standard',
          accessTier: 'auth',
          rawPayloadIncluded: false,
        }),
        renderedPayloadHash: bundle.bundleHash,
      });
    });
  }

  async createDispatch(input: Readonly<{
    scope: ContinuationScope; checkpoint: unknown; activation: unknown; receipt: unknown; bundle: unknown;
    renderedPayloadRef: CanonicalRetrievalOutput['renderedPayloadRef']; renderedPayloadHash: string;
  }>): Promise<ManagedContinuationDispatchMaterial> {
    const checkpoint = ContextCheckpointV1Schema.parse(input.checkpoint);
    const receipt = RetrievalReceiptV1Schema.parse(input.receipt);
    const bundle = ContextBundleV1Schema.parse(input.bundle);
    const now = new Date().toISOString();
    const continuationKey = governedHash('rorca.managed-continuation-key.v1', {
      scope: input.scope, checkpointId: checkpoint.checkpointId, checkpointHash: checkpoint.contentHash,
      trigger: checkpoint.trigger, retryCycleId: checkpoint.retry.retryCycleId, retryPhase: checkpoint.retry.phase,
    } as never);
    const dispatch = ContinuationDispatchV1Schema.parse({
      ...artifactHeader('rorca.continuation-dispatch.v1', `dispatch:omp:${input.scope.attemptId}:${checkpoint.checkpointId}`, stableHash(`dispatch:${continuationKey}`), now),
      scope: input.scope,
      dispatchId: `dispatch:omp:${input.scope.attemptId}:${checkpoint.checkpointId}`,
      continuationKey,
      trigger: checkpoint.trigger,
      checkpointId: checkpoint.checkpointId,
      checkpointHash: checkpoint.contentHash,
      receiptId: receipt.receiptId,
      receiptHash: receipt.contentHash,
      bundleId: bundle.bundleId,
      bundleHash: bundle.bundleHash,
      definitionHash: receipt.definitionHash,
      activationHash: receipt.activationHash,
      targetSessionId: input.scope.sessionId,
      targetCursor: input.scope.cursor,
      priorEntryId: input.scope.priorEntryId,
      expectedCursorAdvance: 1,
      renderedPayloadHash: input.renderedPayloadHash,
      renderedPayloadRef: input.renderedPayloadRef,
      firstLeaseVerificationHash: stableHash(`first:${continuationKey}`),
      casLeaseVerificationHash: stableHash(`cas:${continuationKey}`),
      authorizationExpiresAt: bundle.expiresAt,
      controllerId: 'omp-managed-controller',
      adapterVersion: 'omp-rpc-v1',
      attempt: checkpoint.retry.attempt + 1,
      retryBudgetId: receipt.retryBudgetId,
      state: 'lease_verified',
      reasonCode: 'initial:dispatch',
    });
    await authorizeContinuationDispatch(dispatch, OMP_LANE_CONTEXT);
    void input.activation;
    return Object.freeze({ dispatch, renderedPayload: `# Managed continuation\n\nCheckpoint: ${checkpoint.checkpointId}\nBundle: ${bundle.bundleId}\n\n${JSON.stringify({ checkpointId: checkpoint.checkpointId, bundleId: bundle.bundleId }, null, 2)}` });
  }
}

/** Observability sink: structured log with the evidence hash; never throws. */
export class LoggingContinuationEventSink implements ManagedContinuationEventSink {
  async emit(event: Readonly<{ type: string; scopeHash: string; dispatchId?: string; reasonCode: string; evidenceHash: string }>): Promise<void> {
    logger.info({ type: event.type, scopeHash: event.scopeHash, dispatchId: event.dispatchId ?? null, reasonCode: event.reasonCode, evidenceHash: event.evidenceHash }, '[omp-continuation] managed continuation event');
  }
}

/** Production wall clock for the controller. */
export class SystemManagedClock implements ManagedClock {
  now(): string { return new Date().toISOString(); }
  async sleep(milliseconds: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, milliseconds)); }
}

export interface OmpManagedContinuationStack {
  readonly lane: NormativeContinuationLane;
  readonly controller: PiManagedContinuationController;
  readonly transport: OmpContinuationRpcAdapter;
  readonly executor: OmpManagedExecutor;
  readonly bridge: OmpManagedProcessBridge;
  readonly probe: OmpStatus;
}

export interface OmpManagedContinuationStackOptions {
  readonly workspaceId: string;
  readonly runtimeId: string;
  readonly store: ManagedExecutorStore;
  readonly implementationGate: Wave3AImplementationGate;
  readonly trustedEnvironment?: Readonly<NodeJS.ProcessEnv>;
  readonly ompBin?: string;
  readonly ompVersion?: string | null;
  readonly thinkingLevel?: string;
  /** Worktree the omp lane processes run in (spawn cwd). */
  readonly worktreePath?: string;
}

/**
 * Fail-closed production construction: probe omp (missing/below v17 throws),
 * then assemble the managed executor + continuation controller + omp lane.
 */
export async function createOmpManagedContinuationStack(options: OmpManagedContinuationStackOptions): Promise<OmpManagedContinuationStack> {
  const probe = options.ompBin ? { ompInstalled: true, ompVersion: options.ompVersion ?? null, ompBinPath: options.ompBin } : requireOmp();
  const trustedEnvironment = options.trustedEnvironment ?? process.env;
  const bridge = new OmpManagedProcessBridge({
    bin: probe.ompBinPath!,
    ompVersion: probe.ompVersion,
    trustedEnvironment,
    thinkingLevel: options.thinkingLevel,
  });
  const executor = new OmpManagedExecutor(options.store, bridge, options.implementationGate, probe);
  const transport = new OmpContinuationRpcAdapter({
    bin: probe.ompBinPath!,
    ompVersion: probe.ompVersion,
    trustedEnvironment,
    thinkingLevel: options.thinkingLevel,
    cwd: options.worktreePath,
  });
  const checkpoints = new PostgresContinuationCheckpointStore(options.workspaceId);
  const authority = new PostgresContinuationAuthority(options.workspaceId);
  const controller = new PiManagedContinuationController(
    checkpoints,
    new PostgresContinuationContextClient(options.workspaceId),
    authority,
    authority,
    authority,
    transport,
    new LoggingContinuationEventSink(),
    new PostgresContinuationRetryBudget(options.workspaceId, options.runtimeId),
    new SystemManagedClock(),
  );
  const lane: NormativeContinuationLane = new OmpNormativeContinuationAdapter(controller);
  return { lane, controller, transport, executor, bridge, probe };
}

/** omp lane adapter: same local-process transport shape as the managed lane. */
export class OmpNormativeContinuationAdapter implements NormativeContinuationLane {
  readonly laneId = 'managed' as const;
  readonly transport: NormativeContinuationLane['transport'] = Object.freeze({ schemaVersion: 'rorca.continuation-transport-adapter.v1',
    kind: 'local_process', exactlyOnceDispatchCas: true, sameSessionCursorAdvance: true, callerProjectionAuthority: 'none' });
  readonly trust: NormativeContinuationLane['trust'] = Object.freeze({ schemaVersion: 'rorca.continuation-trust-adapter.v1',
    runtimeClaims: 'runtime_asserted', hostObservations: 'host_observed', canonicalCloseoutOnly: true,
    terminalLifecycleAuthority: 'none', activityLifecycleAuthority: 'none', candidateLifecycleAuthority: 'none' });
  constructor(private readonly controller: PiManagedContinuationController) {}
  continue(input: ManagedContinuationCheckpointInput): Promise<ManagedContinuationOutcome> { return this.controller.continue(input); }
  reconcile(input: ManagedContinuationCheckpointInput): Promise<ManagedContinuationOutcome> { return this.controller.reconcile(input); }
}

// ─── Production dispatch handling (worker construction site + dispatch) ─────

interface PendingDispatchRow {
  dispatch_id: string;
  continuation_key: string;
  state: string;
  lease_id: string;
  fencing_token: number;
  checkpoint_id: string;
}

function selectPendingDispatchesSql(runScoped: boolean): string {
  return `
    SELECT d.dispatch_id, d.continuation_key, d.state, d.lease_id, d.fencing_token, d.checkpoint_id
      FROM continuation_dispatches d
      JOIN execution_leases l ON l.workspace_id = d.workspace_id AND l.lease_id = d.lease_id
      ${runScoped ? 'JOIN governed_execution_attempts a ON a.workspace_id = l.workspace_id AND a.attempt_id = l.attempt_id' : ''}
     WHERE d.workspace_id = $1
       AND d.state IN ('authorized','dispatched')
       ${runScoped ? 'AND a.run_id = $2' : ''}
  `;
}
/** Reconstruct the activation artifact from the canonical activation row. */
function reconstructActivation(
  workspaceId: string,
  definitionHash: string,
  row: { activation_id: string; activation_revision: number; activation_hash: string;
    policy_definition_id: string; policy_definition_version: string; scope_json: unknown;
    effective_values_hash: string; authority_receipt_id: string; state: string;
    activated_at: Date; expires_at: Date | null },
): ReturnType<typeof ContextPolicyActivationV1Schema.parse> {
  return ContextPolicyActivationV1Schema.parse({
    schemaVersion: 'rorca.context-continuation-policy-activation.v1',
    contractId: 'rorca.context-continuation-policy-activation.v1',
    contractVersion: '1.0.0',
    artifactId: `activation:${row.activation_id}`,
    contentHash: row.activation_hash,
    createdAt: row.activated_at.toISOString(),
    createdBy: 'mission-control',
    workspaceId,
    activationId: row.activation_id,
    activationRevision: row.activation_revision,
    activationHash: row.activation_hash,
    definitionId: row.policy_definition_id,
    definitionVersion: row.policy_definition_version,
    definitionHash,
    scope: row.scope_json,
    effectiveValuesHash: row.effective_values_hash,
    authorityReceiptId: row.authority_receipt_id,
    activatedAt: row.activated_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    state: row.state,
  });
}


/**
 * Reconstruct a ManagedContinuationCheckpointInput for a pending dispatch from
 * the canonical checkpoint payload (which stores the full artifact) and the
 * activation row. Used by production dispatch handling — the worker reconcile
 * path and the mission-control checkpoint hook — never by tests.
 */
export async function reconstructContinuationCheckpointInput(
  workspaceId: string,
  dispatch: Readonly<{ dispatchId: string; continuationKey: string; leaseId: string; fencingToken: number }>,
): Promise<ManagedContinuationCheckpointInput> {
  return canonicalTransaction(async (client) => {
    const dispatchRow = await client.query<{ checkpoint_id: string; state: string; reason_code: string | null }>(
      'SELECT checkpoint_id, state, reason_code FROM continuation_dispatches WHERE workspace_id=$1 AND dispatch_id=$2',
      [workspaceId, dispatch.dispatchId],
    );
    const dispatchStateRow = dispatchRow.rows[0];
    const checkpointId = dispatchStateRow?.checkpoint_id;
    if (!checkpointId) throw new ManagedAdmissionError('scope_mismatch', 'continuation dispatch has no canonical checkpoint');
    // Durable host evidence only: the fenced-timeout path writes state='failed'
    // with reason_code='settled_timeout_writer_dead:<receipt>' after
    // abortProcessGroup PROVED OS-process death. No other state can claim the
    // prior process group is dead — the fence must stay unproven.
    const reasonCode = dispatchStateRow.reason_code ?? '';
    const priorProcessGroupDead = dispatchStateRow.state === 'failed'
      && reasonCode.startsWith('settled_timeout_writer_dead');
    // The durable receipt that PROVED the prior writer's death travels with
    // the fence ('settled_timeout_writer_dead:<receipt>') so a restarted
    // worker can restart the runtime without re-probing an unknown process.
    const priorWriterDeathReceiptHash = priorProcessGroupDead
      ? reasonCode.slice('settled_timeout_writer_dead:'.length) || null
      : null;
    const checkpointRow = await client.query<{ payload_json: unknown; activation_hash: string }>(
      'SELECT payload_json, activation_hash FROM context_checkpoints WHERE workspace_id=$1 AND checkpoint_id=$2',
      [workspaceId, checkpointId],
    );
    const checkpoint = ContextCheckpointV1Schema.parse(checkpointRow.rows[0]?.payload_json);
    const activationHash = checkpointRow.rows[0]?.activation_hash;
    if (!activationHash) throw new ManagedAdmissionError('scope_mismatch', 'continuation checkpoint has no activation');
    const activationRow = await client.query<{
      activation_id: string; activation_revision: number; activation_hash: string;
      policy_definition_id: string; policy_definition_version: string; scope_json: unknown;
      effective_values_hash: string; authority_receipt_id: string; state: string; activated_at: Date; expires_at: Date | null;
      policy_definition_hash: string;
    }>(
      `SELECT a.activation_id, a.activation_revision, a.activation_hash, a.policy_definition_id, a.policy_definition_version, a.scope_json,
              a.effective_values_hash, a.authority_receipt_id, a.state, a.activated_at, a.expires_at, d.policy_definition_hash
         FROM context_policy_activations a
         JOIN context_policy_definitions d
           ON d.workspace_id = a.workspace_id AND d.policy_definition_id = a.policy_definition_id
          AND d.policy_definition_version = a.policy_definition_version
        WHERE a.workspace_id=$1 AND a.activation_hash=$2
        ORDER BY a.activation_revision DESC LIMIT 1`,
      [workspaceId, activationHash],
    );
    if (!activationRow.rows[0]) throw new ManagedAdmissionError('scope_mismatch', 'continuation activation is missing from the canonical store');
    const { policy_definition_hash, ...activationRowFields } = activationRow.rows[0];
    const activation = reconstructActivation(workspaceId, policy_definition_hash, activationRowFields);
    if (activation.workspaceId !== checkpoint.scope.workspaceId) {
      throw new ManagedAdmissionError('scope_mismatch', 'activation workspace differs from checkpoint scope');
    }
    return Object.freeze({
      scope: checkpoint.scope,
      checkpoint,
      policyActivation: activation,
      retryCycleId: checkpoint.retry.retryCycleId,
      retryPhase: checkpoint.retry.phase,
      completionCandidateState: 'none' as const,
      priorProcessGroupDead,
      priorWriterDeathReceiptHash,
    });
  });
}

/**
 * Worker dispatch handling: reconcile every authorized/dispatched continuation
 * for a workspace (optionally scoped to one run) through the omp lane. This is
 * the production crash-recovery path — a worker that died after sending a
 * same-session prompt settles or fences the dispatch exactly once.
 */
export async function reconcileOmpManagedDispatches(
  lane: NormativeContinuationLane,
  workspaceId: string,
  runId?: number,
): Promise<readonly Readonly<{ dispatchId: string; outcome: ManagedContinuationOutcome['kind'] }>[]> {
  const rows = await canonicalTransaction(async (client) => {
    const result = runId === undefined
      ? await client.query<PendingDispatchRow>(selectPendingDispatchesSql(false), [workspaceId])
      : await client.query<PendingDispatchRow>(selectPendingDispatchesSql(true), [workspaceId, runId]);
    return result.rows;
  });
  const reconciled: Array<Readonly<{ dispatchId: string; outcome: ManagedContinuationOutcome['kind'] }>> = [];
  for (const row of rows) {
    try {
      const input = await reconstructContinuationCheckpointInput(workspaceId, {
        dispatchId: row.dispatch_id,
        continuationKey: row.continuation_key,
        leaseId: row.lease_id,
        fencingToken: Number(row.fencing_token),
      });
      const outcome = await lane.reconcile(input);
      reconciled.push({ dispatchId: row.dispatch_id, outcome: outcome.kind });
      logger.info({ workspaceId, dispatchId: row.dispatch_id, outcome: outcome.kind }, '[omp-continuation] managed dispatch reconciled');
    } catch (error) {
      // A fence that cannot be proven must abort the engine launch, never be
      // swallowed: reconciliation cannot silently continue past an unproven
      // prior process group.
      if (error instanceof ManagedAdmissionError && error.reason === 'fence_lost') throw error;
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, workspaceId, dispatchId: row.dispatch_id }, `[omp-continuation] managed dispatch reconciliation failed closed: ${message}`);
    }
  }
  return Object.freeze(reconciled);
}
