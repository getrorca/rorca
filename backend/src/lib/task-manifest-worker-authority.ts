/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export interface TaskManifestWorkerPayloadAuthority {
  manifestId?: string;
  commandDenylist?: string[];
  safetyOptions: {
    deploy: boolean;
    externalSend: boolean;
    policyLocked: boolean;
  };
  mergeStrategy: string;
  autoMerge: boolean;
}

export interface TaskManifestWorkerLineageAuthority {
  manifestId: string;
  commandDenylist: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Bind the transport payload to the immutable manifest lineage and frozen run
 * options before any workspace, policy, filesystem, or process side effect.
 */
export function assertTaskManifestWorkerPayloadAuthority(input: {
  payload: TaskManifestWorkerPayloadAuthority;
  lineage: TaskManifestWorkerLineageAuthority;
  effectiveOptions: unknown;
}): void {
  const effective = record(input.effectiveOptions);
  const frozenSafety = record(effective?.safety);
  const frozenMerge = record(effective?.merge);
  const payloadDenylist = input.payload.commandDenylist ?? [];

  if (input.payload.manifestId !== input.lineage.manifestId
    || JSON.stringify(payloadDenylist) !== JSON.stringify(input.lineage.commandDenylist)
    || input.payload.safetyOptions.deploy !== false
    || frozenSafety?.deploy !== input.payload.safetyOptions.deploy
    || frozenSafety?.externalSend !== input.payload.safetyOptions.externalSend
    || frozenSafety?.policyLocked !== input.payload.safetyOptions.policyLocked
    || frozenMerge?.strategy !== input.payload.mergeStrategy
    || frozenMerge?.autoMerge !== input.payload.autoMerge) {
    throw new Error('TaskManifest run payload differs from immutable lineage/safety authority');
  }
}

/** The only worker-to-engine carrier for the host-frozen command restrictions. */
export function taskManifestCommandGuardEnv(commandDenylist?: string[]): Record<string, string> {
  return commandDenylist && commandDenylist.length > 0
    ? { RORCA_TASK_MANIFEST_COMMAND_DENYLIST_JSON: JSON.stringify(commandDenylist) }
    : {};
}
