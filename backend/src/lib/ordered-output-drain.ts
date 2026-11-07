/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Serializes process-output persistence and exposes one completion barrier.
 *
 * ChildProcess `close` means streams have ended, not that asynchronous output
 * persistence started by their `data` handlers has finished. The worker must
 * cross this barrier before it derives terminal lifecycle state or closeout.
 */
export class OrderedOutputDrain {
  private tail: Promise<void> = Promise.resolve();
  private firstError: unknown | undefined;

  constructor(private readonly write: (data: Buffer) => Promise<void>) {}

  append(data: Buffer): void {
    // Stream buffers are normally immutable for the duration of the callback,
    // but persistence is deferred behind prior writes. Retain an owned copy.
    const payload = Buffer.from(data);
    this.tail = this.tail
      .then(() => this.write(payload))
      .catch((error: unknown) => {
        this.firstError ??= error;
      });
  }

  async drain(): Promise<void> {
    await this.tail;
    if (this.firstError !== undefined) throw this.firstError;
  }
}
