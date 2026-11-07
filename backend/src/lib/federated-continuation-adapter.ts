/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */
import {
  PiManagedContinuationController, type ManagedContinuationCheckpointInput, type ManagedContinuationOutcome,
} from './pi-managed-continuation-controller';
import { ManagedAdmissionError } from './rorca-managed-executor';
import type { FederatedAuthenticatedRuntime } from './federated-runtime-service';

export interface ContinuationTransportAdapter {
  readonly schemaVersion: 'rorca.continuation-transport-adapter.v1';
  readonly kind: 'local_process' | 'authenticated_https';
  readonly exactlyOnceDispatchCas: true;
  readonly sameSessionCursorAdvance: true;
  readonly callerProjectionAuthority: 'none';
}

export interface ContinuationTrustAdapter {
  readonly schemaVersion: 'rorca.continuation-trust-adapter.v1';
  readonly runtimeClaims: 'runtime_asserted';
  readonly hostObservations: 'host_observed';
  readonly canonicalCloseoutOnly: true;
  readonly terminalLifecycleAuthority: 'none';
  readonly activityLifecycleAuthority: 'none';
  readonly candidateLifecycleAuthority: 'none';
}

export interface NormativeContinuationLane {
  readonly laneId: 'managed' | 'federated';
  readonly transport: ContinuationTransportAdapter;
  readonly trust: ContinuationTrustAdapter;
  continue(input: ManagedContinuationCheckpointInput): Promise<ManagedContinuationOutcome>;
  reconcile(input: ManagedContinuationCheckpointInput): Promise<ManagedContinuationOutcome>;
}

const TRUST: ContinuationTrustAdapter = Object.freeze({ schemaVersion: 'rorca.continuation-trust-adapter.v1',
  runtimeClaims: 'runtime_asserted', hostObservations: 'host_observed', canonicalCloseoutOnly: true,
  terminalLifecycleAuthority: 'none', activityLifecycleAuthority: 'none', candidateLifecycleAuthority: 'none' });

export class ManagedNormativeContinuationAdapter implements NormativeContinuationLane {
  readonly laneId = 'managed' as const;
  readonly transport: ContinuationTransportAdapter = Object.freeze({ schemaVersion: 'rorca.continuation-transport-adapter.v1',
    kind: 'local_process', exactlyOnceDispatchCas: true, sameSessionCursorAdvance: true, callerProjectionAuthority: 'none' });
  readonly trust = TRUST;
  constructor(private readonly controller: PiManagedContinuationController) {}
  continue(input: ManagedContinuationCheckpointInput): Promise<ManagedContinuationOutcome> { return this.controller.continue(input); }
  reconcile(input: ManagedContinuationCheckpointInput): Promise<ManagedContinuationOutcome> { return this.controller.reconcile(input); }
}

export class FederatedNormativeContinuationAdapter implements NormativeContinuationLane {
  readonly laneId = 'federated' as const;
  readonly transport: ContinuationTransportAdapter = Object.freeze({ schemaVersion: 'rorca.continuation-transport-adapter.v1',
    kind: 'authenticated_https', exactlyOnceDispatchCas: true, sameSessionCursorAdvance: true, callerProjectionAuthority: 'none' });
  readonly trust = TRUST;
  constructor(private readonly controller: PiManagedContinuationController, private readonly runtime: FederatedAuthenticatedRuntime) {}

  private assertScope(input: ManagedContinuationCheckpointInput): void {
    if (input.scope.workspaceId !== this.runtime.workspaceId || input.scope.runtimeId !== this.runtime.runtimeId) {
      throw new ManagedAdmissionError('scope_mismatch', 'Federated continuation scope differs from the authenticated runtime');
    }
  }

  async continue(input: ManagedContinuationCheckpointInput): Promise<ManagedContinuationOutcome> {
    this.assertScope(input);
    return this.controller.continue(input);
  }

  async reconcile(input: ManagedContinuationCheckpointInput): Promise<ManagedContinuationOutcome> {
    this.assertScope(input);
    return this.controller.reconcile(input);
  }
}
