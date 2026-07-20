/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { ValidationError } from '../errors';
import {
  RUN_OUTPUT_ANSI_SOURCE,
  RUN_OUTPUT_PTY_SOURCE,
  decodeRunOutputCursor,
  encodeRunOutputCursor,
  outputCursorMatches,
} from '../run-output-contract';

const GENERATION = '123e4567-e89b-42d3-a456-426614174000';
const NEXT_GENERATION = '223e4567-e89b-42d3-a456-426614174000';

describe('generation-scoped output cursors', () => {
  it('round-trips source, generation, and sequence', () => {
    const encoded = encodeRunOutputCursor(RUN_OUTPUT_PTY_SOURCE, GENERATION, 42);
    expect(encoded).toBe(`v1|${RUN_OUTPUT_PTY_SOURCE}|${GENERATION}|42`);
    expect(decodeRunOutputCursor(encoded)).toEqual({
      version: 1,
      source: RUN_OUTPUT_PTY_SOURCE,
      generationId: GENERATION,
      sequence: 42,
    });
  });

  it('detects source and active-generation rollover without suppressing current bytes', () => {
    const cursor = decodeRunOutputCursor(encodeRunOutputCursor(RUN_OUTPUT_PTY_SOURCE, GENERATION, 99));
    expect(outputCursorMatches(cursor, RUN_OUTPUT_PTY_SOURCE, GENERATION)).toBe(true);
    expect(outputCursorMatches(cursor, RUN_OUTPUT_PTY_SOURCE, NEXT_GENERATION)).toBe(false);
    expect(outputCursorMatches(cursor, RUN_OUTPUT_ANSI_SOURCE, null)).toBe(false);
  });

  it('retains numeric Last-Event-ID compatibility and rejects malformed scoped IDs', () => {
    expect(decodeRunOutputCursor('17')).toEqual({ version: 0, source: null, generationId: null, sequence: 17 });
    expect(outputCursorMatches(decodeRunOutputCursor('17'), RUN_OUTPUT_PTY_SOURCE, GENERATION)).toBe(true);
    expect(() => decodeRunOutputCursor('v1|run_pty_output_chunks|not-a-uuid|3')).toThrow(ValidationError);
  });
});
