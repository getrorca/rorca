/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { StringDecoder } from 'node:string_decoder';
import { redactSecrets } from './context-safety';

export const PTY_SECRET_REDACTION_MARKER = '[REDACTED SECRET]';

/**
 * Scrub a bounded PTY persistence batch before it reaches durable storage.
 * Terminal capture is UTF-8 by contract; ANSI control bytes survive unchanged.
 * This surface is diagnostic only, so secret safety takes precedence over
 * byte-for-byte fidelity when a credential-shaped value is present.
 */
export function redactPtyOutputForPersistence(output: Buffer): Buffer {
  if (output.length === 0) return output;
  const text = output.toString('utf8');
  const result = redactSecrets(text, { placeholder: PTY_SECRET_REDACTION_MARKER });
  return result.redactionCount === 0 ? output : Buffer.from(result.redacted, 'utf8');
}

const MAX_PENDING_REDACTION_BYTES = 64 * 1024;
const REDACTION_CARRY_CHARS = 4 * 1024;

/** Stateful scrubber so a credential split across node-pty data callbacks is
 * still removed before either half can be persisted. Complete CR/LF terminal
 * records flow immediately; hostile no-delimiter output remains bounded. */
export class PtyOutputPersistenceRedactor {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';

  accept(output: Buffer): Buffer[] {
    this.pending += this.decoder.write(output);
    return this.release(false);
  }

  finish(): Buffer[] {
    this.pending += this.decoder.end();
    return this.release(true);
  }

  private release(flushAll: boolean): Buffer[] {
    let releaseLength = flushAll ? this.pending.length : Math.max(this.pending.lastIndexOf('\n'), this.pending.lastIndexOf('\r')) + 1;
    if (!flushAll && releaseLength === 0 && Buffer.byteLength(this.pending, 'utf8') > MAX_PENDING_REDACTION_BYTES) {
      releaseLength = Math.max(0, this.pending.length - REDACTION_CARRY_CHARS);
    }
    if (releaseLength === 0) return [];
    const released = this.pending.slice(0, releaseLength);
    this.pending = this.pending.slice(releaseLength);
    return [redactPtyOutputForPersistence(Buffer.from(released, 'utf8'))];
  }
}
