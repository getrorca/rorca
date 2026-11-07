/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { OrderedOutputDrain } from '../ordered-output-drain';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('OrderedOutputDrain', () => {
  it('serializes output writes and waits for every write before closeout', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const started: string[] = [];
    const drain = new OrderedOutputDrain(async (data) => {
      const text = data.toString('utf8');
      started.push(text);
      return text === 'first' ? first.promise : second.promise;
    });

    drain.append(Buffer.from('first'));
    drain.append(Buffer.from('second'));
    const closeout = drain.drain();
    let settled = false;
    void closeout.then(() => { settled = true; });

    await nextTurn();
    expect(started).toEqual(['first']);
    expect(settled).toBe(false);

    first.resolve();
    await nextTurn();
    expect(started).toEqual(['first', 'second']);
    expect(settled).toBe(false);

    second.resolve();
    await expect(closeout).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });

  it('continues draining later stream data but fails closeout with the first persistence error', async () => {
    const failure = new Error('output persistence failed');
    const written: string[] = [];
    const drain = new OrderedOutputDrain(async (data) => {
      const text = data.toString('utf8');
      if (text === 'fatal') throw failure;
      written.push(text);
    });

    drain.append(Buffer.from('fatal'));
    drain.append(Buffer.from('later stderr'));

    await expect(drain.drain()).rejects.toBe(failure);
    expect(written).toEqual(['later stderr']);
  });

  it('owns deferred stream data instead of observing a caller-mutated buffer', async () => {
    const gate = deferred<void>();
    const written: Buffer[] = [];
    const drain = new OrderedOutputDrain(async (data) => {
      written.push(data);
      await gate.promise;
    });
    const source = Buffer.from('fatal engine error');

    drain.append(source);
    source.fill(0x78);
    gate.resolve();

    await drain.drain();
    expect(written[0].toString('utf8')).toBe('fatal engine error');
  });
});
