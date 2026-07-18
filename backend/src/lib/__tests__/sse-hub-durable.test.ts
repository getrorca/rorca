/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { broadcastAllDurably, subscribeDurable, type WalEvent } from '../sse-hub';

function event(id: number): WalEvent {
  return {
    id, ts: new Date().toISOString(), event_type: 'run_finished', workspace_id: 'ws-a',
    spec_id: 'spec-a', story_id: null, actor: 'rorca-host', payload: '{}',
  };
}

test('concurrent duplicate delivery awaits one shared durable acceptance promise', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const durable = jest.fn(async () => { await gate; });
  const unsubscribe = subscribeDurable(durable);
  try {
    let firstDone = false;
    let duplicateDone = false;
    const first = broadcastAllDurably(event(987_001)).then(() => { firstDone = true; });
    const duplicate = broadcastAllDurably(event(987_001)).then(() => { duplicateDone = true; });
    await Promise.resolve();
    expect(durable).toHaveBeenCalledTimes(1);
    expect(firstDone).toBe(false);
    expect(duplicateDone).toBe(false);
    release();
    await Promise.all([first, duplicate]);
    expect(firstDone).toBe(true);
    expect(duplicateDone).toBe(true);
  } finally { unsubscribe(); }
});

test('failed durable acceptance is retryable and is never remembered as acknowledged', async () => {
  const durable = jest.fn()
    .mockRejectedValueOnce(new Error('crash before ledger commit'))
    .mockResolvedValueOnce(undefined);
  const unsubscribe = subscribeDurable(durable);
  try {
    await expect(broadcastAllDurably(event(987_002))).rejects.toThrow('crash before ledger commit');
    await expect(broadcastAllDurably(event(987_002))).resolves.toBeUndefined();
    expect(durable).toHaveBeenCalledTimes(2);
  } finally { unsubscribe(); }
});
