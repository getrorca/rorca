/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Shared CLI protocol conventions used by story execution and merge resolution. */

/** OpenCode requires a normalized provider/model identifier. */
export function normalizeOpenCodeModel(model: string): string {
  let normalized = model.replace(/(claude-[a-z]+-\d+)-(\d+)(?:-\d{8})?/, '$1.$2');
  const knownPrefixes = ['openrouter/', 'openai/', 'google/', 'ollama/', 'github/', 'bedrock/', 'vertex/', 'opencode/'];
  if (knownPrefixes.some(prefix => normalized.startsWith(prefix))) return normalized;
  if (/^claude-/.test(normalized)) return `openrouter/anthropic/${normalized}`;
  if (normalized.includes('/')) return `openrouter/${normalized}`;
  return normalized;
}

/** Pi may emit turn_end for intermediate turns; only agent_end completes a story. */
export function shouldResolvePiRpcStory(eventType: string): boolean {
  return eventType === 'agent_end';
}
