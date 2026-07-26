/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// ─── OpenCode Spec Generation ────────────────────────────────────────────────
// OC-008: Use `opencode run` for spec generation when RORCA_AGENT=opencode.
//
// OpenCode autonomously reads CLAUDE.md, existing specs, and package.json before
// writing the spec JSON — it has full tool access (read, glob, grep, bash, etc.)
// which produces dramatically more context-aware specs than a blind SDK API call.
//
// Spawns: `opencode run --format json --model <model>`
// Prompt via stdin instructs OpenCode to explore the codebase then emit a spec.
// Output is parsed from the JSON event stream to extract the final spec JSON.

import { spawn } from 'child_process';
import { detectOpenCode } from './opencode-detector';
import { prepareAutonomousModelSandboxLaunch } from './autonomous-sandbox';
import { OpenCodeStreamParser, type ParsedEvent } from './opencode-parser';
import type { TokenUsage } from './llm-client';

// ─── Constants ───────────────────────────────────────────────────────────────

const OPENCODE_SPEC_TIMEOUT_MS = 120_000; // 120s — longer than SDK path due to codebase exploration

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OpenCodeSpecResult {
  stories: Array<{
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    dependsOn: string[];
    complexity?: number;
  }>;
  diagrams?: Record<string, unknown>;
  mermaidDiagram?: string;
  usage: TokenUsage;
}

export interface OpenCodeSpecError {
  error: string;
  stderr?: string;
  timedOut?: boolean;
}

// ─── Prompt Builder ──────────────────────────────────────────────────────────

/**
 * Build the prompt that instructs OpenCode to explore the codebase and generate
 * a spec JSON. OpenCode has full tool access — it will read CLAUDE.md, glob
 * existing specs, read package.json, and use that context to produce a
 * context-aware spec.
 */
function buildSpecGenPrompt(opts: {
  title: string;
  brief: string;
  storyCount: number;
  storyPrefix: string;
  directionContext: string;
  templateContext?: string;
  diagramTypes?: string[];
}): string {
  const { title, brief, storyCount, storyPrefix, directionContext, templateContext, diagramTypes } = opts;

  const wantDiagrams = Array.isArray(diagramTypes) && diagramTypes.some(t => t !== 'storyDeps');
  const diagramInstruction = wantDiagrams
    ? `\nAlso include a "diagrams" key with Mermaid diagrams for: ${diagramTypes!.filter(t => t !== 'storyDeps').join(', ')}.`
    : '';

  return [
    'You are a spec writer for a software project. Your task:',
    '',
    '1. FIRST, explore the codebase to understand the project:',
    '   - Read CLAUDE.md (if it exists) for architecture and conventions',
    '   - Glob existing specs in forge/specs/ to understand naming patterns and existing work',
    '   - Read package.json for dependencies and project structure',
    '   - Grep for relevant patterns related to the spec brief',
    '',
    '2. THEN, generate a software specification JSON based on your codebase exploration.',
    '',
    '=== DIRECTION STACK CONTEXT ===',
    directionContext,
    '=== END DIRECTION STACK ===',
    '',
    ...(templateContext ? ['=== REFERENCE TEMPLATE ===', templateContext, '=== END TEMPLATE ===', ''] : []),
    `Spec title: ${title}`,
    `Spec brief: ${brief}`,
    storyCount === 0
      ? `Generate an appropriate number of user stories (typically 3-20) based on the scope and complexity of the brief. Use fewer stories for focused features and more for large system changes. Number stories sequentially starting from ${storyPrefix}-001.`
      : `Generate exactly ${storyCount} user stories, numbered ${storyPrefix}-001 through ${storyPrefix}-${String(storyCount).padStart(3, '0')}.`,
    '',
    'OUTPUT REQUIREMENT:',
    'After exploring the codebase, your FINAL message must contain ONLY a raw JSON object.',
    'No markdown fences. No explanation before or after. Start with { and end with }.',
    '',
    'JSON schema:',
    `{"stories":[{"id":"${storyPrefix}-001","title":"string","description":"string","acceptanceCriteria":["string"],"dependsOn":["${storyPrefix}-001"],"complexity":3}],"mermaidDiagram":"graph TD\\n  ${storyPrefix}-001[\\"Story title\\"]\\n  ${storyPrefix}-002[\\"Story title\\"]\\n  ${storyPrefix}-001 --> ${storyPrefix}-002"}`,
    diagramInstruction,
    '',
    'Rules:',
    storyCount === 0
      ? `- Number stories sequentially starting from ${storyPrefix}-001`
      : `- Generate exactly ${storyCount} stories`,
    '- Acceptance criteria should fully and unambiguously specify the story; use as many as needed for completeness, with no fixed target count.',
    '- dependsOn lists story IDs this story requires first (empty array if none)',
    '- Analyze story CONTENT to determine dependencies — shared state, APIs, UI components, DB schemas',
    '- Each story must have a "complexity" field: integer 1-5',
    '- Include a "mermaidDiagram" field: a valid Mermaid flowchart (graph TD) showing story dependencies',
    '- Your FINAL output must be valid JSON parseable by JSON.parse()',
  ].join('\n');
}

// ─── JSON Extraction ─────────────────────────────────────────────────────────

/**
 * Extract spec JSON from the OpenCode event stream output.
 *
 * Strategy: scan all assistant-type events and tool_result events for the
 * largest valid JSON object containing a "stories" array. The final assistant
 * message typically contains the full spec JSON.
 */
function extractSpecJson(events: ParsedEvent[]): { stories: unknown[]; diagrams?: Record<string, unknown>; mermaidDiagram?: string } | null {
  // Collect all text content from assistant events (reverse order — last is most likely the spec)
  const candidates: string[] = [];

  for (const event of events) {
    const raw = event.raw;
    if (raw.type === 'assistant' || raw.type === 'completion') {
      const content = (raw.content ?? raw.message ?? raw.result ?? '') as string;
      if (content.length > 50) {
        candidates.push(content);
      }
    }
    // Also check tool_result — OpenCode might write the spec via a tool
    if (raw.type === 'tool_result') {
      const content = (raw.content ?? raw.result ?? '') as string;
      if (content.length > 50) {
        candidates.push(content);
      }
    }
  }

  // Try candidates in reverse order (last output most likely to be the final spec)
  for (let i = candidates.length - 1; i >= 0; i--) {
    const parsed = tryParseSpecJson(candidates[i]);
    if (parsed) return parsed;
  }

  // Fallback: concatenate all stdout and try to find JSON anywhere
  const allText = events
    .map(e => {
      const raw = e.raw;
      return (raw.content ?? raw.message ?? raw.result ?? '') as string;
    })
    .join('\n');

  return tryParseSpecJson(allText);
}

/**
 * Try to parse a string as spec JSON. Handles markdown fences and leading text.
 */
function tryParseSpecJson(text: string): { stories: unknown[]; diagrams?: Record<string, unknown>; mermaidDiagram?: string } | null {
  if (!text) return null;

  // Strip markdown fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : text.trim();

  // Find the JSON object start
  const jsonStart = jsonStr.indexOf('{');
  if (jsonStart === -1) return null;

  // Find matching closing brace (handle nested objects)
  const substr = jsonStr.slice(jsonStart);
  let depth = 0;
  let jsonEnd = -1;
  for (let i = 0; i < substr.length; i++) {
    if (substr[i] === '{') depth++;
    else if (substr[i] === '}') {
      depth--;
      if (depth === 0) {
        jsonEnd = i + 1;
        break;
      }
    }
  }

  if (jsonEnd === -1) return null;

  try {
    const parsed = JSON.parse(substr.slice(0, jsonEnd));
    if (Array.isArray(parsed.stories)) {
      return parsed;
    }
  } catch { /* not valid JSON */ }

  return null;
}

// ─── Spec Quality Validation ─────────────────────────────────────────────────

/**
 * Validate that a generated spec meets quality requirements:
 * - Must have title (inferred from slug)
 * - Must have userStories/stories array
 * - Each story must have id, title, description, acceptanceCriteria, dependsOn
 */
export function validateSpecQuality(
  stories: unknown[],
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!Array.isArray(stories) || stories.length === 0) {
    return { valid: false, errors: ['stories array is empty or missing'] };
  }

  for (let i = 0; i < stories.length; i++) {
    const s = stories[i] as Record<string, unknown>;
    const idx = `story[${i}]`;

    if (typeof s.id !== 'string' || !s.id) {
      errors.push(`${idx}: missing id`);
    }
    if (typeof s.title !== 'string' || !s.title) {
      errors.push(`${idx}: missing title`);
    }
    if (typeof s.description !== 'string' || !s.description) {
      errors.push(`${idx}: missing description`);
    }
    if (!Array.isArray(s.acceptanceCriteria) || s.acceptanceCriteria.length === 0) {
      errors.push(`${idx}: missing or empty acceptanceCriteria`);
    }
    if (!Array.isArray(s.dependsOn)) {
      errors.push(`${idx}: missing dependsOn array`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Main: Generate Spec via OpenCode ────────────────────────────────────────

/**
 * Generate a spec by spawning `opencode run --format json --model <model>`.
 * The prompt instructs OpenCode to explore the codebase first, then output JSON.
 *
 * Returns the parsed spec on success, or an error object on failure.
 * Callers should fall back to the SDK path (llm-client.ts) on failure.
 */
export async function generateSpecViaOpenCode(opts: {
  workspacePath: string;
  title: string;
  brief: string;
  storyCount: number;
  storyPrefix: string;
  directionContext: string;
  templateContext?: string;
  diagramTypes?: string[];
  model?: string;
}): Promise<OpenCodeSpecResult | OpenCodeSpecError> {
  // Resolve binary
  const status = detectOpenCode();
  if (!status.opencodeBinPath) {
    return { error: 'OpenCode binary not found. Set OPENCODE_BIN or install opencode.' };
  }

  const model = opts.model ?? process.env.RORCA_MODEL ?? null;
  const prompt = buildSpecGenPrompt(opts);

  const args: string[] = ['run', '--format', 'json'];
  if (model) {
    args.push('--model', model);
  }

  const launch = await prepareAutonomousModelSandboxLaunch({
    command: status.opencodeBinPath,
    args,
    cwd: opts.workspacePath,
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  });

  return new Promise((resolve) => {
    const parser = new OpenCodeStreamParser();
    const allEvents: ParsedEvent[] = [];
    let stdoutData = '';
    let stderrData = '';

    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Write prompt to stdin
    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    // Parse stdout as JSON event stream
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdoutData += text;
      const events = parser.push(text);
      allEvents.push(...events);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrData += chunk.toString('utf8');
      // Cap stderr at 8KB
      if (stderrData.length > 8192) {
        stderrData = stderrData.slice(-8192);
      }
    });

    // Timeout
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
        }, 10_000);
      } catch { /* already dead */ }
    }, OPENCODE_SPEC_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ error: `Failed to spawn opencode: ${err.message}`, stderr: stderrData });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);

      // Flush parser
      const remaining = parser.flush();
      allEvents.push(...remaining);

      // Check for timeout (SIGTERM → null exit code)
      if (code === null) {
        resolve({ error: 'OpenCode spec generation timed out (120s)', timedOut: true, stderr: stderrData });
        return;
      }

      // Non-zero exit
      if (code !== 0) {
        resolve({ error: `OpenCode exited with code ${code}`, stderr: stderrData });
        return;
      }

      // Extract spec JSON from events
      const specJson = extractSpecJson(allEvents);
      if (!specJson) {
        // Fallback: try parsing raw stdout directly
        const directParse = tryParseSpecJson(stdoutData);
        if (!directParse) {
          resolve({ error: 'Could not extract spec JSON from OpenCode output', stderr: stderrData });
          return;
        }
        Object.assign(specJson ?? {}, directParse);
        // If specJson was null, use directParse
        return resolveWithSpec(directParse);
      }

      resolveWithSpec(specJson);
    });

    function resolveWithSpec(specJson: { stories: unknown[]; diagrams?: Record<string, unknown>; mermaidDiagram?: string }) {
      // Validate quality
      const validation = validateSpecQuality(specJson.stories);
      if (!validation.valid) {
        resolve({ error: `Spec quality validation failed: ${validation.errors.join('; ')}`, stderr: stderrData });
        return;
      }

      resolve({
        stories: specJson.stories as OpenCodeSpecResult['stories'],
        diagrams: specJson.diagrams,
        mermaidDiagram: specJson.mermaidDiagram,
        usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }, // OpenCode doesn't report token usage via JSON stream
      });
    }
  });
}

/**
 * Type guard: is this an error result?
 */
export function isSpecError(result: OpenCodeSpecResult | OpenCodeSpecError): result is OpenCodeSpecError {
  return 'error' in result;
}
