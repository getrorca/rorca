/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from 'vitest';
import { classifyBreakpoint } from '../useBreakpoint';

describe('Lifecycle responsive breakpoint contract', () => {
  it.each([
    [390, 'mobile'],
    [639, 'mobile'],
    [640, 'tablet'],
    [1024, 'tablet'],
    [1025, 'desktop'],
    [1440, 'desktop'],
  ] as const)('classifies %dpx as %s', (width, expected) => {
    expect(classifyBreakpoint(width)).toBe(expected);
  });
});
