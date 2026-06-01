/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { z } from 'zod';

export const TERMINAL_MODE_VALUES = ['ansi-html', 'pty'] as const;

export type TerminalMode = (typeof TERMINAL_MODE_VALUES)[number];

export const DEFAULT_TERMINAL_MODE: TerminalMode = 'ansi-html';

export const TerminalModeSchema = z.enum(TERMINAL_MODE_VALUES);

export function isTerminalMode(value: unknown): value is TerminalMode {
  return value === 'ansi-html' || value === 'pty';
}

export function normalizeTerminalMode(value: string | null | undefined): TerminalMode {
  return value === 'pty' ? 'pty' : DEFAULT_TERMINAL_MODE;
}

export function invalidTerminalModeMessage(value: string): string {
  return `Invalid terminal_mode: ${value}. Expected one of: ${TERMINAL_MODE_VALUES.join(', ')}`;
}
