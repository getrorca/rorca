/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// ─── Claude CLI Token Parser ────────────────────────────────────────────────
//
// Extracts token usage from Claude CLI output.
//
// Claude CLI with `--output-format stream-json` emits JSON lines.
// Token usage appears in:
//   1. `result` events with a `usage` field (stream-json format)
//   2. Stderr summary lines like "Total tokens: 12345 input, 6789 output"
//   3. Log file content (combined stdout+stderr from the agent subprocess)
//
// This parser handles all three sources.

export interface ClaudeTokenUsage {
  inputTokens: number;
  outputTokens: number;
  model?: string;
}

/**
 * Parse token usage from a Claude CLI stream-json log file.
 * Reads the file content and extracts usage from JSON result events.
 * Returns the last (most complete) usage report found.
 */
export function parseClaudeLogTokens(logContent: string): ClaudeTokenUsage {
  let totalInput = 0;
  let totalOutput = 0;
  let model: string | undefined;

  for (const line of logContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try JSON parsing for stream-json events
    try {
      const event = JSON.parse(trimmed);

      // Claude stream-json `result` event with usage
      if (event.type === 'result' && event.usage) {
        const u = event.usage;
        totalInput = (u.input_tokens ?? u.inputTokens ?? 0) as number;
        totalOutput = (u.output_tokens ?? u.outputTokens ?? 0) as number;
        if (event.model) model = event.model as string;
        continue;
      }

      // Anthropic API message_delta with usage
      if (event.type === 'message_delta' && event.usage) {
        totalOutput += (event.usage.output_tokens ?? 0) as number;
        continue;
      }

      // message_start with initial usage
      if (event.type === 'message_start' && event.message?.usage) {
        const u = event.message.usage;
        totalInput += (u.input_tokens ?? 0) as number;
        totalOutput += (u.output_tokens ?? 0) as number;
        if (event.message.model) model = event.message.model as string;
        continue;
      }

      // Generic usage field on any event type
      if (event.usage && (event.usage.input_tokens || event.usage.output_tokens)) {
        totalInput = Math.max(totalInput, (event.usage.input_tokens ?? 0) as number);
        totalOutput = Math.max(totalOutput, (event.usage.output_tokens ?? 0) as number);
        if (event.model) model = event.model as string;
      }
    } catch {
      // Not JSON — try regex patterns on plain text
    }
  }

  // Fallback: parse stderr-style summary lines
  if (totalInput === 0 && totalOutput === 0) {
    const stderrUsage = parseClaudeStderrTokens(logContent);
    totalInput = stderrUsage.inputTokens;
    totalOutput = stderrUsage.outputTokens;
    if (stderrUsage.model) model = stderrUsage.model;
  }

  return { inputTokens: totalInput, outputTokens: totalOutput, model };
}

/**
 * Parse token usage from Claude CLI stderr output.
 * Claude CLI prints usage summaries in various formats:
 *   - "Total input tokens: 12345"
 *   - "Total output tokens: 6789"
 *   - "input_tokens: 12345, output_tokens: 6789"
 *   - "Tokens: 12345 in / 6789 out"
 *   - "Total cost: $0.12 (12345 input, 6789 output tokens)"
 */
export function parseClaudeStderrTokens(stderr: string): ClaudeTokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let model: string | undefined;

  // Pattern: "input_tokens: 12345" or "Total input tokens: 12345"
  const inputMatch = stderr.match(/(?:total\s+)?input[_ ]tokens[:\s]+(\d[\d,]*)/i);
  if (inputMatch) {
    inputTokens = parseInt(inputMatch[1].replace(/,/g, ''), 10);
  }

  // Pattern: "output_tokens: 6789" or "Total output tokens: 6789"
  const outputMatch = stderr.match(/(?:total\s+)?output[_ ]tokens[:\s]+(\d[\d,]*)/i);
  if (outputMatch) {
    outputTokens = parseInt(outputMatch[1].replace(/,/g, ''), 10);
  }

  // Pattern: "12345 input, 6789 output" (parenthetical in cost summary)
  if (inputTokens === 0 && outputTokens === 0) {
    const pairMatch = stderr.match(/(\d[\d,]*)\s*input[,\s]+(\d[\d,]*)\s*output/i);
    if (pairMatch) {
      inputTokens = parseInt(pairMatch[1].replace(/,/g, ''), 10);
      outputTokens = parseInt(pairMatch[2].replace(/,/g, ''), 10);
    }
  }

  // Pattern: "Tokens: 12345 in / 6789 out"
  if (inputTokens === 0 && outputTokens === 0) {
    const slashMatch = stderr.match(/tokens[:\s]+(\d[\d,]*)\s*in\s*\/\s*(\d[\d,]*)\s*out/i);
    if (slashMatch) {
      inputTokens = parseInt(slashMatch[1].replace(/,/g, ''), 10);
      outputTokens = parseInt(slashMatch[2].replace(/,/g, ''), 10);
    }
  }

  // Try to extract model name
  const modelMatch = stderr.match(/model[:\s]+(claude-[\w.-]+)/i);
  if (modelMatch) {
    model = modelMatch[1];
  }

  return { inputTokens, outputTokens, model };
}
