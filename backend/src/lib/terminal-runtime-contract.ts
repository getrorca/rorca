/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Exact CLIs and geometry shipped by the Release-1 image and RB-02 capture lane. */
export const RELEASE_TERMINAL_RUNTIME = {
  pi: {
    version: '0.80.6',
    displayVersion: 'pi 0.80.6',
  },
  opencode: {
    version: '1.17.10',
    displayVersion: 'opencode 1.17.10',
  },
  terminal: {
    cols: 80,
    rows: 24,
  },
} as const;

export type ReleaseTerminalEngine = 'pi' | 'opencode';
