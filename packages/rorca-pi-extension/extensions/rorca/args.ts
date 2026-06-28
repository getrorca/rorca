import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CaptureOptions, ForgeOptions, RetryOptions, RunOptions, StatusOptions } from "./types.js";

export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function parseFlagValue(tokens: string[], index: number, flag: string): { value: string; nextIndex: number } {
  const value = tokens[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return { value, nextIndex: index + 2 };
}

export function parseForgeCommand(input: string, usageCommand = "/rorca-create-spec"): { brief: string; options: ForgeOptions } {
  const tokens = tokenizeArgs(input);
  const briefParts: string[] = [];
  const options: ForgeOptions = {
    approve: false,
    run: false,
    queue: false,
    autoWatch: true,
  };

  for (let i = 0; i < tokens.length;) {
    const token = tokens[i];
    switch (token) {
      case "--workspace": {
        const parsed = parseFlagValue(tokens, i, token);
        options.workspaceId = parsed.value;
        i = parsed.nextIndex;
        break;
      }
      case "--model": {
        const parsed = parseFlagValue(tokens, i, token);
        options.model = parsed.value;
        i = parsed.nextIndex;
        break;
      }
      case "--approve":
        options.approve = true;
        i += 1;
        break;
      case "--run":
        options.run = true;
        i += 1;
        break;
      case "--queue":
        options.queue = true;
        i += 1;
        break;
      case "--no-watch":
        options.autoWatch = false;
        i += 1;
        break;
      default:
        briefParts.push(token);
        i += 1;
        break;
    }
  }

  const brief = briefParts.join(" ").trim();
  if (!brief) {
    throw new Error(`Usage: ${usageCommand} <brief|@file> [--workspace <id>] [--approve] [--run] [--queue] [--model <model>] [--no-watch]`);
  }

  return { brief, options };
}

export function parseRunCommand(input: string): RunOptions {
  const tokens = tokenizeArgs(input);
  if (tokens.length === 0) {
    throw new Error("Usage: /rorca-run <spec-slug> [--workspace <id>] [--story <id>] [--queue] [--model <model>] [--sequential] [--no-watch]");
  }

  const options: RunOptions = {
    specSlug: tokens[0],
    queue: false,
    autoWatch: true,
  };

  for (let i = 1; i < tokens.length;) {
    const token = tokens[i];
    switch (token) {
      case "--workspace": {
        const parsed = parseFlagValue(tokens, i, token);
        options.workspaceId = parsed.value;
        i = parsed.nextIndex;
        break;
      }
      case "--story": {
        const parsed = parseFlagValue(tokens, i, token);
        options.storyId = parsed.value;
        i = parsed.nextIndex;
        break;
      }
      case "--model": {
        const parsed = parseFlagValue(tokens, i, token);
        options.model = parsed.value;
        i = parsed.nextIndex;
        break;
      }
      case "--queue":
        options.queue = true;
        i += 1;
        break;
      case "--sequential":
        options.forceSequential = true;
        i += 1;
        break;
      case "--no-watch":
        options.autoWatch = false;
        i += 1;
        break;
      default:
        throw new Error(`Unknown flag: ${token}`);
    }
  }

  return options;
}

export function parseRetryCommand(input: string, fallbackRunId?: number): RetryOptions {
  const tokens = tokenizeArgs(input);
  const maybeRunId = tokens[0] && /^\d+$/.test(tokens[0]) ? Number(tokens[0]) : fallbackRunId;
  if (!maybeRunId) {
    throw new Error("Usage: /rorca-retry <runId> [storyId...] [--sequential] [--no-watch]");
  }

  const options: RetryOptions = {
    runId: maybeRunId,
    storyIds: [],
    autoWatch: true,
  };

  const startIndex = tokens[0] && /^\d+$/.test(tokens[0]) ? 1 : 0;
  for (let i = startIndex; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--no-watch") {
      options.autoWatch = false;
    } else if (token === "--sequential") {
      options.forceSequential = true;
    } else if (!token.startsWith("--")) {
      options.storyIds.push(token);
    } else {
      throw new Error(`Unknown flag: ${token}`);
    }
  }

  return options;
}

export function parseStatusCommand(input: string, fallbackRunId?: number, fallbackWorkspaceId?: string): StatusOptions {
  const tokens = tokenizeArgs(input);
  const options: StatusOptions = {};

  if (tokens[0] && /^\d+$/.test(tokens[0])) {
    options.runId = Number(tokens[0]);
  } else if (tokens[0] && !tokens[0].startsWith("--")) {
    options.workspaceId = tokens[0];
  }

  for (let i = options.runId || options.workspaceId ? 1 : 0; i < tokens.length;) {
    const token = tokens[i];
    if (token === "--workspace") {
      const parsed = parseFlagValue(tokens, i, token);
      options.workspaceId = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    throw new Error(`Unknown flag: ${token}`);
  }

  if (!options.runId && !options.workspaceId && fallbackRunId) {
    options.runId = fallbackRunId;
  }
  if (!options.runId && !options.workspaceId && fallbackWorkspaceId) {
    options.workspaceId = fallbackWorkspaceId;
  }

  return options;
}

export function parseApproveCommand(input: string, fallbackSpecSlug?: string): { specSlug: string; workspaceId?: string } {
  const tokens = tokenizeArgs(input);
  const options: { specSlug: string; workspaceId?: string } = {
    specSlug: tokens[0] && !tokens[0].startsWith("--") ? tokens[0] : fallbackSpecSlug || "",
  };

  if (!options.specSlug) {
    throw new Error("Usage: /rorca-approve <spec-slug> [--workspace <id>]");
  }

  for (let i = tokens[0] && !tokens[0].startsWith("--") ? 1 : 0; i < tokens.length;) {
    const token = tokens[i];
    if (token === "--workspace") {
      const parsed = parseFlagValue(tokens, i, token);
      options.workspaceId = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    throw new Error(`Unknown flag: ${token}`);
  }

  return options;
}

export function parseEnrichCommand(input: string, fallbackSpecSlug?: string): { specSlug: string; workspaceId?: string } {
  const tokens = tokenizeArgs(input);
  const options: { specSlug: string; workspaceId?: string } = {
    specSlug: tokens[0] && !tokens[0].startsWith("--") ? tokens[0] : fallbackSpecSlug || "",
  };

  if (!options.specSlug) {
    throw new Error("Usage: /rorca-enrich <spec-slug> [--workspace <id>]");
  }

  for (let i = tokens[0] && !tokens[0].startsWith("--") ? 1 : 0; i < tokens.length;) {
    const token = tokens[i];
    if (token === "--workspace") {
      const parsed = parseFlagValue(tokens, i, token);
      options.workspaceId = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    throw new Error(`Unknown flag: ${token}`);
  }

  return options;
}

/** Valid memory categories shared with the backend memory-ledger. */
export const VALID_MEMORY_CATEGORIES = [
  'Architecture',
  'Convention',
  'Bug Fix',
  'Decision',
  'Pattern',
  'Gotcha',
  'Run Synthesis',
] as const;

const VALID_CONFIDENCE = ['high', 'medium', 'low'] as const;
const VALID_TRUST = ['authoritative', 'trusted', 'community', 'unverified'] as const;

/**
 * Generate a deterministic idempotency key from source ref + workspace + content.
 * When source_ref is supplied, the key is fully deterministic — resubmitting the
 * same capture with the same source will hit the idempotency gate.
 */
export function generateCaptureIdempotencyKey(
  workspaceId: string,
  sourceRef: string | undefined,
  title: string,
  rule: string,
): string {
  const seed = sourceRef
    ? `pi-capture:${workspaceId}:ref:${sourceRef}`
    : `pi-capture:${workspaceId}:content:${title}:${rule}`;
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
}

export function parseCaptureCommand(input: string): CaptureOptions {
  const tokens = tokenizeArgs(input);
  if (tokens.length === 0) {
    throw new Error(
      "Usage: /rorca-capture <text> --title <title> --category <category> [--files <path>...] [--source <ref>] [--confidence high|medium|low] [--trust tier] [--workspace <id>] [--approve]",
    );
  }

  const bodyParts: string[] = [];
  const fileParts: string[] = [];
  const options: {
    title?: string;
    category?: string;
    files?: string[];
    source?: string;
    confidence?: 'high' | 'medium' | 'low';
    trust?: 'authoritative' | 'trusted' | 'community' | 'unverified';
    workspaceId?: string;
    approve?: boolean;
  } = {};

  for (let i = 0; i < tokens.length;) {
    const token = tokens[i];
    switch (token) {
      case '--title': {
        const parsed = parseFlagValue(tokens, i, token);
        options.title = parsed.value;
        i = parsed.nextIndex;
        break;
      }
      case '--category': {
        const parsed = parseFlagValue(tokens, i, token);
        const category = parsed.value;
        if (!(VALID_MEMORY_CATEGORIES as readonly string[]).includes(category)) {
          throw new Error(
            `Invalid category: ${category}. Valid categories: ${VALID_MEMORY_CATEGORIES.join(', ')}`,
          );
        }
        options.category = category;
        i = parsed.nextIndex;
        break;
      }
      case '--files': {
        // Collect all non-flag tokens until the next flag
        const parsed = parseFlagValue(tokens, i, token);
        fileParts.push(parsed.value);
        let nextI = parsed.nextIndex;
        // Support space-separated file paths: collect tokens until next --flag or end
        while (nextI < tokens.length && !tokens[nextI].startsWith('--')) {
          fileParts.push(tokens[nextI]);
          nextI += 1;
        }
        i = nextI;
        break;
      }
      case '--source': {
        const parsed = parseFlagValue(tokens, i, token);
        options.source = parsed.value;
        i = parsed.nextIndex;
        break;
      }
      case '--confidence': {
        const parsed = parseFlagValue(tokens, i, token);
        const confidence = parsed.value;
        if (!(VALID_CONFIDENCE as readonly string[]).includes(confidence)) {
          throw new Error(
            `Invalid confidence: ${confidence}. Must be: ${VALID_CONFIDENCE.join(' | ')}`,
          );
        }
        options.confidence = confidence as 'high' | 'medium' | 'low';
        i = parsed.nextIndex;
        break;
      }
      case '--trust': {
        const parsed = parseFlagValue(tokens, i, token);
        const trust = parsed.value;
        if (!(VALID_TRUST as readonly string[]).includes(trust)) {
          throw new Error(
            `Invalid trust tier: ${trust}. Must be: ${VALID_TRUST.join(' | ')}`,
          );
        }
        options.trust = trust as 'authoritative' | 'trusted' | 'community' | 'unverified';
        i = parsed.nextIndex;
        break;
      }
      case '--workspace': {
        const parsed = parseFlagValue(tokens, i, token);
        options.workspaceId = parsed.value;
        i = parsed.nextIndex;
        break;
      }
      case '--approve':
        options.approve = true;
        i += 1;
        break;
      default:
        // First non-flag token is the body text; subsequent ones appended
        bodyParts.push(token);
        i += 1;
        break;
    }
  }

  const text = bodyParts.join(' ').trim();
  if (!text) {
    throw new Error(
      "Usage: /rorca-capture <text> --title <title> --category <category> [--files <path>...] [--source <ref>] [--confidence high|medium|low] [--trust tier] [--workspace <id>] [--approve]",
    );
  }

  if (!options.title) {
    throw new Error('Missing required flag: --title');
  }

  if (!options.category) {
    throw new Error('Missing required flag: --category');
  }

  return {
    text,
    title: options.title,
    category: options.category,
    files: fileParts,
    source: options.source,
    confidence: options.confidence ?? 'medium',
    trust: options.trust ?? 'unverified',
    workspaceId: options.workspaceId,
    approve: options.approve ?? false,
  };
}

export function resolveBriefInput(rawBrief: string, cwd: string = process.cwd()): { brief: string; sourceLabel: string } {
  const trimmed = rawBrief.trim();
  if (!trimmed.startsWith("@")) {
    return { brief: trimmed, sourceLabel: "inline" };
  }

  const relativePath = trimmed.slice(1);
  const filePath = path.resolve(cwd, relativePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Brief file not found: ${relativePath}`);
  }

  return {
    brief: fs.readFileSync(filePath, "utf8").trim(),
    sourceLabel: relativePath,
  };
}
