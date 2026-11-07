/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { ExtensionState } from "./types.js";

export const STATE_ENTRY_TYPE = "rorca-extension-state";

export function restoreState(entries: Array<{ type: string; customType?: string; data?: unknown }>): ExtensionState {
  const latest = entries
    .filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE)
    .pop() as { data?: ExtensionState } | undefined;

  return latest?.data || {};
}

export function mergeState(current: ExtensionState, patch: Partial<ExtensionState>): ExtensionState {
  return {
    ...current,
    ...patch,
  };
}
