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
