/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  assertTaskManifestWorkerPayloadAuthority,
  taskManifestCommandGuardEnv,
} from '../task-manifest-worker-authority';

function authority() {
  const commandDenylist = ['git commit', 'node --eval forbidden-side-effect'];
  return {
    payload: {
      manifestId: 'manifest-1',
      commandDenylist,
      safetyOptions: { deploy: false, externalSend: true, policyLocked: true },
      mergeStrategy: 'draft-pr',
      autoMerge: false,
    },
    lineage: { manifestId: 'manifest-1', commandDenylist },
    effectiveOptions: {
      safety: { deploy: false, externalSend: true, policyLocked: true },
      merge: { strategy: 'draft-pr', autoMerge: false },
    },
  };
}

describe('TaskManifest worker authority', () => {
  test('accepts only the exact lineage, safety, merge, and command restriction packet', () => {
    expect(() => assertTaskManifestWorkerPayloadAuthority(authority())).not.toThrow();
  });

  test.each([
    ['manifest identity', (value: ReturnType<typeof authority>) => { value.payload.manifestId = 'manifest-2'; }],
    ['command content', (value: ReturnType<typeof authority>) => { value.payload.commandDenylist = ['git commit']; }],
    ['command order', (value: ReturnType<typeof authority>) => { value.payload.commandDenylist = [...value.payload.commandDenylist!].reverse(); }],
    ['deploy safety', (value: ReturnType<typeof authority>) => { value.payload.safetyOptions.deploy = true; }],
    ['external-send safety', (value: ReturnType<typeof authority>) => { value.payload.safetyOptions.externalSend = false; }],
    ['policy lock', (value: ReturnType<typeof authority>) => { value.payload.safetyOptions.policyLocked = false; }],
    ['merge strategy', (value: ReturnType<typeof authority>) => { value.payload.mergeStrategy = 'pr'; }],
    ['auto-merge', (value: ReturnType<typeof authority>) => { value.payload.autoMerge = true; }],
  ])('rejects %s drift before engine launch', (_name, mutate) => {
    const value = authority();
    mutate(value);
    expect(() => assertTaskManifestWorkerPayloadAuthority(value)).toThrow(/immutable lineage\/safety authority/);
  });

  test('serializes the exact frozen denylist into the worker-to-engine environment', () => {
    const value = authority();
    expect(taskManifestCommandGuardEnv(value.payload.commandDenylist)).toEqual({
      RORCA_TASK_MANIFEST_COMMAND_DENYLIST_JSON: JSON.stringify(value.payload.commandDenylist),
    });
    expect(taskManifestCommandGuardEnv()).toEqual({});
  });
});
