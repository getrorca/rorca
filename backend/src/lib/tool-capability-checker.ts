/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * tool-capability-checker.ts — Pre-flight tool compatibility check for stories vs engines.
 *
 * OC-031: Before routing a story to an execution engine, check whether the story's
 * requirements are compatible with that engine's tool set. Codex lacks webfetch,
 * websearch, native glob, and grep. Stories requiring these tools should warn in the
 * trigger modal and optionally auto-reroute to a capable engine.
 */

import type { AgentType } from './config';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ToolName =
  | 'bash' | 'edit' | 'read' | 'write'
  | 'glob' | 'grep' | 'webfetch' | 'websearch'
  | 'task' | 'todowrite';

export interface CapabilityCheckResult {
  compatible: boolean;
  missingTools: ToolName[];
  warnings: string[];
}

export interface StoryCapabilityReport {
  storyId: string;
  storyTitle: string;
  engine: AgentType;
  result: CapabilityCheckResult;
}

export interface SpecCapabilityReport {
  compatible: boolean;
  stories: StoryCapabilityReport[];
}

export type CapabilityMismatchMode = 'warn' | 'reroute' | 'block';

export interface CapabilityStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  agent?: AgentType;
}

// ─── Tool Capability Matrix ──────────────────────────────────────────────────

export const TOOL_CAPABILITY_MATRIX: Record<AgentType | 'ollama', Set<ToolName>> = {
  claude: new Set(['bash', 'edit', 'read', 'write', 'glob', 'grep', 'webfetch', 'websearch', 'task', 'todowrite']),
  opencode: new Set(['bash', 'edit', 'read', 'write', 'glob', 'grep', 'webfetch', 'websearch']),
  codex: new Set(['bash', 'edit', 'read', 'write']),
  pi: new Set(['bash', 'edit', 'read', 'write', 'glob', 'grep']),
  ollama: new Set(['bash', 'edit', 'read', 'write']),
};

// ─── Keyword → Required Tool Mapping ─────────────────────────────────────────

interface KeywordRule {
  patterns: RegExp[];
  tool: ToolName;
}

const KEYWORD_RULES: KeywordRule[] = [
  {
    patterns: [
      /\bwebfetch\b/i,
      /\bfetch\s+url\b/i,
      /\bdocumentation\s+lookup\b/i,
      /\bfetch\s+documentation\b/i,
      /\bdownload\s+from\s+url\b/i,
      /\bhttp\s+request\b/i,
      /\bweb\s+request\b/i,
      /\bfetch\s+(?:the\s+)?(?:api|endpoint|page|resource)\b/i,
      /\bscrape\b/i,
    ],
    tool: 'webfetch',
  },
  {
    patterns: [
      /\bwebsearch\b/i,
      /\bweb\s+search\b/i,
      /\bsearch\s+(?:the\s+)?(?:web|internet|online)\b/i,
      /\bgoogle\b/i,
      /\blook\s+up\s+(?:online|documentation)\b/i,
    ],
    tool: 'websearch',
  },
  {
    patterns: [
      /\bfind\s+files?\b/i,
      /\bglob\b/i,
      /\bfile\s+pattern\b/i,
      /\bsearch\s+(?:for\s+)?files?\b/i,
      /\blist\s+(?:all\s+)?files?\b/i,
      /\bdiscover\s+files?\b/i,
    ],
    tool: 'glob',
  },
  {
    patterns: [
      /\bsearch\s+codebase\b/i,
      /\bgrep\b/i,
      /\bsearch\s+(?:for\s+)?(?:pattern|string|text|code)\b/i,
      /\bfind\s+(?:all\s+)?(?:occurrences|references|usages|instances)\b/i,
      /\bcode\s+search\b/i,
      /\bripgrep\b/i,
    ],
    tool: 'grep',
  },
  {
    patterns: [
      /\bsubagent\b/i,
      /\bsub-agent\b/i,
      /\bparallel\s+(?:research|exploration|investigation)\b/i,
      /\btask\s+tool\b/i,
      /\bspawn\s+(?:a\s+)?(?:sub)?agent\b/i,
    ],
    tool: 'task',
  },
];

// ─── Core Check Function ─────────────────────────────────────────────────────

/**
 * Detect which tools a story requires based on keyword analysis of its
 * description and acceptance criteria.
 */
export function detectRequiredTools(story: CapabilityStory): Set<ToolName> {
  const required = new Set<ToolName>();
  const text = [
    story.description ?? '',
    ...(story.acceptanceCriteria ?? []),
  ].join('\n');

  for (const rule of KEYWORD_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(text)) {
        required.add(rule.tool);
        break; // One match per rule is enough
      }
    }
  }

  return required;
}

/**
 * Check whether a story is compatible with a given engine.
 */
export function check(story: CapabilityStory, engine: AgentType | 'ollama'): CapabilityCheckResult {
  const engineTools = TOOL_CAPABILITY_MATRIX[engine];
  if (!engineTools) {
    return { compatible: false, missingTools: [], warnings: [`Unknown engine: ${engine}`] };
  }

  const required = detectRequiredTools(story);
  const missingTools: ToolName[] = [];
  const warnings: string[] = [];

  for (const tool of required) {
    if (!engineTools.has(tool)) {
      missingTools.push(tool);
    }
  }

  if (missingTools.length > 0) {
    const toolList = missingTools.join(', ');
    warnings.push(`${story.id} uses ${toolList} — not supported by ${engine}`);
  }

  return {
    compatible: missingTools.length === 0,
    missingTools,
    warnings,
  };
}

/**
 * Check all stories in a spec against their assigned engine.
 */
export function checkSpec(
  stories: CapabilityStory[],
  runAgent: AgentType,
): SpecCapabilityReport {
  const storyReports: StoryCapabilityReport[] = [];
  let allCompatible = true;

  for (const story of stories) {
    const engine = story.agent ?? runAgent;
    const result = check(story, engine);
    if (!result.compatible) {
      allCompatible = false;
      storyReports.push({
        storyId: story.id,
        storyTitle: story.title,
        engine,
        result,
      });
    }
  }

  return { compatible: allCompatible, stories: storyReports };
}

// ─── Engine Escalation Order ─────────────────────────────────────────────────

/**
 * Escalation order for capability rerouting: Codex/Ollama → OpenCode → Claude.
 * Returns the nearest capable engine, or null if none can handle it.
 */
const ESCALATION_ORDER: (AgentType | 'ollama')[] = ['ollama', 'codex', 'opencode', 'claude'];

export function findCapableEngine(
  requiredTools: Set<ToolName>,
  currentEngine: AgentType | 'ollama',
): AgentType | null {
  const currentIdx = ESCALATION_ORDER.indexOf(currentEngine);

  // Walk up the escalation chain from current engine's position
  for (let i = currentIdx + 1; i < ESCALATION_ORDER.length; i++) {
    const candidate = ESCALATION_ORDER[i];
    const candidateTools = TOOL_CAPABILITY_MATRIX[candidate];
    let allCovered = true;
    for (const tool of requiredTools) {
      if (!candidateTools.has(tool)) {
        allCovered = false;
        break;
      }
    }
    if (allCovered) {
      return candidate as AgentType;
    }
  }

  return null;
}
