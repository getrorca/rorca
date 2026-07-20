/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { z } from 'zod';

export const TERMINAL_MODE_VALUES = ['ansi-html', 'pty', 'native-pty'] as const;

export type TerminalMode = (typeof TERMINAL_MODE_VALUES)[number];

export const DEFAULT_TERMINAL_MODE: TerminalMode = 'ansi-html';

export const TerminalModeSchema = z.enum(TERMINAL_MODE_VALUES);

export function isTerminalMode(value: unknown): value is TerminalMode {
  return value === 'ansi-html' || value === 'pty' || value === 'native-pty';
}

export function isPtyTerminalMode(value: unknown): value is Extract<TerminalMode, 'pty' | 'native-pty'> {
  return value === 'pty' || value === 'native-pty';
}

export function normalizeTerminalMode(value: string | null | undefined): TerminalMode {
  return isTerminalMode(value) ? value : DEFAULT_TERMINAL_MODE;
}

/** Explicit operator keyboard input always selects the reviewed native PTY profile. */
export function resolveOperatorInputTerminalMode(
  value: string | null | undefined,
  operatorKeyboardInput: boolean,
): TerminalMode {
  return operatorKeyboardInput ? 'native-pty' : normalizeTerminalMode(value);
}

export function invalidTerminalModeMessage(value: string): string {
  return `Invalid terminal_mode: ${value}. Expected one of: ${TERMINAL_MODE_VALUES.join(', ')}`;
}
