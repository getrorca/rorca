/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { ValidationError } from './errors';

export const RUN_OUTPUT_CONTRACT_VERSION = 2 as const;
export const RUN_OUTPUT_PTY_SOURCE = 'run_pty_output_chunks' as const;
export const RUN_OUTPUT_ANSI_SOURCE = 'run_output_chunks' as const;
export type RunOutputSource = typeof RUN_OUTPUT_PTY_SOURCE | typeof RUN_OUTPUT_ANSI_SOURCE;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_GENERATION = 'legacy';

export interface RunOutputCursor {
  version: 0 | 1;
  source: RunOutputSource | null;
  generationId: string | null;
  sequence: number;
}

export function isRunOutputSource(value: unknown): value is RunOutputSource {
  return value === RUN_OUTPUT_PTY_SOURCE || value === RUN_OUTPUT_ANSI_SOURCE;
}

/** New event IDs always carry the durable store and generation sequence space. */
export function encodeRunOutputCursor(source: RunOutputSource, generationId: string | null, sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new ValidationError('Output cursor sequence is invalid');
  if (generationId !== null && !UUID_PATTERN.test(generationId)) throw new ValidationError('Output cursor generation is invalid');
  return `v1|${source}|${generationId ?? LEGACY_GENERATION}|${sequence}`;
}

/** Numeric IDs remain accepted for old EventSource clients, but are unscoped. */
export function decodeRunOutputCursor(value: string, label = 'Last-Event-ID'): RunOutputCursor {
  if (/^(0|[1-9]\d*)$/.test(value)) {
    const sequence = Number(value);
    if (!Number.isSafeInteger(sequence)) throw new ValidationError(`${label} must contain a safe output sequence`);
    return { version: 0, source: null, generationId: null, sequence };
  }

  const parts = value.split('|');
  if (parts.length !== 4 || parts[0] !== 'v1' || !isRunOutputSource(parts[1])) {
    throw new ValidationError(`${label} is not a valid scoped output cursor`);
  }
  const generationId = parts[2] === LEGACY_GENERATION ? null : parts[2];
  if (generationId !== null && !UUID_PATTERN.test(generationId)) {
    throw new ValidationError(`${label} has an invalid generation identity`);
  }
  if (!/^(0|[1-9]\d*)$/.test(parts[3])) {
    throw new ValidationError(`${label} has an invalid output sequence`);
  }
  const sequence = Number(parts[3]);
  if (!Number.isSafeInteger(sequence)) throw new ValidationError(`${label} must contain a safe output sequence`);
  return { version: 1, source: parts[1], generationId, sequence };
}

export function outputCursorMatches(
  cursor: RunOutputCursor,
  source: RunOutputSource,
  generationId: string | null,
): boolean {
  // Old numeric EventSource IDs intentionally preserve legacy resume behavior.
  return cursor.version === 0 || (cursor.source === source && cursor.generationId === generationId);
}
