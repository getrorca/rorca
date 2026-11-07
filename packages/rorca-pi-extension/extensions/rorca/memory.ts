/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RorcaApiClient } from "./api.js";

const MEMORY_CATEGORIES = ["Architecture", "Convention", "Bug Fix", "Decision", "Pattern", "Gotcha"] as const;
type MemoryCategory = typeof MEMORY_CATEGORIES[number];

type RegisterCommand = (name: string, description: string, handler: (args: string, ctx: ExtensionContext) => Promise<void>) => void;

type MemoryCandidate = {
  category: MemoryCategory;
  title: string;
  rule: string;
  context?: string;
  confidence: number;
  relatedFiles?: string[];
  conflictsWithMemoryIds?: number[];
  conflictReason?: string;
};

type MemoryItem = {
  id: number;
  category: string;
  content: string;
  relatedFiles?: string[];
  createdAt?: string;
};

type MemoryItemsResponse = {
  items: MemoryItem[];
  total?: number;
};

type MemoryMode = "direct" | "dry-run";

type MemoryCaptureOptions = {
  enabled: boolean;
  threshold: number;
  mode: MemoryMode;
  useScribe: boolean;
  maxCandidatesPerFlush: number;
};

type TurnSnapshot = {
  turnIndex: number;
  assistantText: string;
  toolSummary: string;
  relatedFiles: string[];
  timestamp: string;
};

const truthy = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test(value ?? "");
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

function parseThreshold(): number {
  const raw = Number(process.env.RORCA_PI_MEMORY_CONFIDENCE ?? "0.85");
  return Number.isFinite(raw) ? clamp(raw, 0, 1) : 0.85;
}

function initialOptions(): MemoryCaptureOptions {
  const requestedMode = process.env.RORCA_PI_MEMORY_MODE;
  return {
    enabled: truthy(process.env.RORCA_PI_MEMORY_AUTO),
    threshold: parseThreshold(),
    mode: requestedMode === "dry-run" ? "dry-run" : "direct",
    useScribe: truthy(process.env.RORCA_PI_MEMORY_SCRIBE),
    maxCandidatesPerFlush: clamp(Number(process.env.RORCA_PI_MEMORY_MAX_CANDIDATES ?? "5") || 5, 1, 20),
  };
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.content === "string") return obj.content;
    if (Array.isArray(obj.content)) return toText(obj.content);
    if (typeof obj.text === "string") return obj.text;
  }
  return "";
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const obj = message as Record<string, unknown>;
  return toText(obj.content ?? obj.text ?? obj.message);
}

function fileFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const obj = args as Record<string, unknown>;
  const raw = obj.path ?? obj.file_path ?? obj.filePath;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function sanitizeFile(file: string, cwd: string): string {
  const absolute = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  const relative = path.relative(cwd, absolute);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative;
  return file;
}

function normalizeCategory(value: unknown): MemoryCategory | null {
  if (typeof value !== "string") return null;
  return MEMORY_CATEGORIES.find((category) => category.toLowerCase() === value.toLowerCase()) ?? null;
}

function normalizeCandidate(value: unknown, relatedFiles: string[]): MemoryCandidate | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const category = normalizeCategory(obj.category);
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  const rule = typeof obj.rule === "string" ? obj.rule.trim() : "";
  const confidence = typeof obj.confidence === "number" ? obj.confidence : Number(obj.confidence);
  if (!category || !title || !rule || !Number.isFinite(confidence)) return null;

  const candidateFiles = Array.isArray(obj.relatedFiles) ? obj.relatedFiles.filter((item): item is string => typeof item === "string") : [];
  const conflictsWithMemoryIds = Array.isArray(obj.conflictsWithMemoryIds)
    ? obj.conflictsWithMemoryIds.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];

  return {
    category,
    title: title.slice(0, 160),
    rule: rule.slice(0, 1200),
    context: typeof obj.context === "string" ? obj.context.slice(0, 2000) : undefined,
    confidence: clamp(confidence, 0, 1),
    relatedFiles: unique([...candidateFiles, ...relatedFiles]).slice(0, 20),
    conflictsWithMemoryIds,
    conflictReason: typeof obj.conflictReason === "string" ? obj.conflictReason.slice(0, 500) : undefined,
  };
}

function parseJsonCandidates(text: string, relatedFiles: string[]): MemoryCandidate[] {
  const blocks = [text];
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1] ?? "");
  blocks.unshift(...fenced);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const jsonStart = Math.min(...[trimmed.indexOf("{"), trimmed.indexOf("[")].filter((idx) => idx >= 0));
    if (!Number.isFinite(jsonStart)) continue;
    const candidateText = trimmed.slice(jsonStart);
    try {
      const parsed = JSON.parse(candidateText) as unknown;
      const rawItems = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { memories?: unknown }).memories)
          ? (parsed as { memories: unknown[] }).memories
          : [];
      const normalized = rawItems.map((item) => normalizeCandidate(item, relatedFiles)).filter((item): item is MemoryCandidate => Boolean(item));
      if (normalized.length > 0) return normalized;
    } catch {
      // Try next block.
    }
  }
  return [];
}

function heuristicCandidates(turns: TurnSnapshot[], relatedFiles: string[]): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  const recentText = turns.map((turn) => turn.assistantText).join("\n");

  const explicitLines = recentText.split("\n").filter((line) => /^(memory|remember|decision|convention|gotcha|pattern|bug fix)\s*:/i.test(line.trim()));
  for (const line of explicitLines) {
    const cleaned = line.replace(/^(memory|remember)\s*:/i, "").trim();
    const category = /gotcha/i.test(line) ? "Gotcha"
      : /bug fix/i.test(line) ? "Bug Fix"
        : /decision/i.test(line) ? "Decision"
          : /pattern/i.test(line) ? "Pattern"
            : /convention/i.test(line) ? "Convention"
              : "Decision";
    const title = cleaned.split(/[.—:-]/)[0]?.trim() || cleaned.slice(0, 80);
    if (cleaned.length > 12) {
      candidates.push({
        category,
        title: title.slice(0, 120),
        rule: cleaned.slice(0, 800),
        context: "Auto-extracted from an explicit memory/remember line in the Pi session.",
        confidence: 0.78,
        relatedFiles,
      });
    }
  }

  return candidates;
}

function contentTokens(text: string): Set<string> {
  const stop = new Set(["the", "and", "for", "with", "from", "that", "this", "into", "must", "should", "always", "never", "not", "use", "uses", "using"]);
  return new Set(text.toLowerCase().match(/[a-z0-9_.\/-]{3,}/g)?.filter((token) => !stop.has(token)).slice(0, 80) ?? []);
}

function hasNegation(text: string): boolean {
  return /\b(no|not|never|avoid|forbid|forbidden|mustn't|must not|don't|do not|instead of)\b/i.test(text);
}

function overlapScore(a: string, b: string): number {
  const left = contentTokens(a);
  const right = contentTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap++;
  return overlap / Math.min(left.size, right.size);
}

function detectHeuristicConflict(candidate: MemoryCandidate, existing: MemoryItem[]): { id: number; reason: string }[] {
  const candidateText = `${candidate.title} ${candidate.rule}`;
  const candidateNegated = hasNegation(candidateText);
  return existing.flatMap((memory) => {
    const existingNegated = hasNegation(memory.content);
    const sameTopic = overlapScore(candidateText, memory.content) >= 0.34;
    if (sameTopic && candidateNegated !== existingNegated) {
      return [{ id: memory.id, reason: "Similar topic with opposite negation polarity; please review the conflict." }];
    }
    return [];
  }).slice(0, 3);
}

function dedupeCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const seen = new Set<string>();
  const result: MemoryCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.category}:${candidate.title.toLowerCase()}:${candidate.rule.toLowerCase().slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

async function getRecentMemories(api: RorcaApiClient, workspaceId: string): Promise<MemoryItem[]> {
  const response = await api.fetchJson<MemoryItemsResponse>(`/api/memory/items?workspaceId=${encodeURIComponent(workspaceId)}&limit=100`);
  return Array.isArray(response.items) ? response.items : [];
}

async function postMemory(api: RorcaApiClient, workspaceId: string, sessionId: string, candidate: MemoryCandidate): Promise<void> {
  await api.fetchJson<{ entry: unknown; total: number }>("/api/memory", {
    method: "POST",
    body: JSON.stringify({
      workspaceId,
      category: candidate.category,
      title: candidate.title,
      rule: candidate.rule,
      context: candidate.context ?? "Auto-extracted by Pi memory capture.",
      source: `pi-session:${sessionId}`,
      sourceType: "auto-extracted",
      relatedFiles: candidate.relatedFiles ?? [],
    }),
  });
}

async function findPostedMemoryId(api: RorcaApiClient, workspaceId: string, candidate: MemoryCandidate): Promise<number | null> {
  const query = encodeURIComponent(candidate.title.slice(0, 80));
  const response = await api.fetchJson<MemoryItemsResponse>(`/api/memory/items?workspaceId=${encodeURIComponent(workspaceId)}&search=${query}&limit=10`);
  const match = response.items?.find((item) => item.content.includes(candidate.title) || item.content.includes(candidate.rule.slice(0, 80)));
  return match?.id ?? null;
}

async function postConflictRelations(
  api: RorcaApiClient,
  workspaceId: string,
  sourceMemoryId: number,
  conflicts: { id: number; reason: string }[],
): Promise<number> {
  let count = 0;
  for (const conflict of conflicts) {
    if (conflict.id === sourceMemoryId) continue;
    try {
      await api.fetchJson("/api/memory/relations", {
        method: "POST",
        body: JSON.stringify({
          workspaceId,
          sourceMemoryId,
          targetMemoryId: conflict.id,
          relationType: "CONFLICTS_WITH",
          note: conflict.reason,
        }),
      });
      count++;
    } catch {
      // Ignore duplicate/conflicting relation errors; memory persistence should not fail because relation already exists.
    }
  }
  return count;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && !currentScript.startsWith("/$bunfs/root/") && currentScript.endsWith(".js")) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
  return { command: "pi", args };
}

function scribeSystemPrompt(threshold: number): string {
  return `You are a strict memory scribe for Rorca. Extract only durable project memories from a Pi coding session.\n\nReturn ONLY JSON with this shape:\n{\"memories\":[{\"category\":\"Architecture|Convention|Bug Fix|Decision|Pattern|Gotcha\",\"title\":\"short title\",\"rule\":\"durable rule or insight\",\"context\":\"evidence from session\",\"confidence\":0.0,\"relatedFiles\":[\"path\"],\"conflictsWithMemoryIds\":[123],\"conflictReason\":\"why\"}]}\n\nRules:\n- Only include memories with confidence >= ${threshold}.\n- Prefer explicit decisions, conventions, gotchas, architecture, reusable patterns, and real bug fixes.\n- Do not include TODOs, transient plans, guesses, secrets, credentials, private user data, or one-off observations.\n- If a candidate contradicts an existing memory listed in the prompt, include that existing memory id in conflictsWithMemoryIds.\n- Keep rules concise and actionable.`;
}

async function runScribeSubagent(input: string, cwd: string, threshold: number): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rorca-memory-scribe-"));
  const promptPath = path.join(tmpDir, "system.md");
  await fs.writeFile(promptPath, scribeSystemPrompt(threshold), "utf8");

  const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", promptPath, input];
  const invocation = getPiInvocation(args);

  try {
    return await new Promise<string>((resolve) => {
      const proc = spawn(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let finalAssistant = "";
      const timeout = setTimeout(() => proc.kill("SIGTERM"), 90_000);

      proc.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        const lines = stdout.split("\n");
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.type === "message_end") {
              const text = messageText(event.message);
              if (text) finalAssistant = text;
            }
          } catch {
            // Ignore non-JSON output.
          }
        }
      });
      proc.on("close", () => {
        clearTimeout(timeout);
        resolve(finalAssistant || stdout);
      });
      proc.on("error", () => {
        clearTimeout(timeout);
        resolve("");
      });
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function buildScribeInput(turns: TurnSnapshot[], existing: MemoryItem[], relatedFiles: string[]): string {
  const recentExisting = existing.slice(0, 40).map((memory) => `#${memory.id} [${memory.category}] ${memory.content}`).join("\n");
  const session = turns.slice(-20).map((turn) => [
    `TURN ${turn.turnIndex} @ ${turn.timestamp}`,
    turn.relatedFiles.length ? `FILES: ${turn.relatedFiles.join(", ")}` : "FILES: none",
    turn.toolSummary ? `TOOLS: ${turn.toolSummary}` : "TOOLS: none",
    `ASSISTANT: ${turn.assistantText.slice(0, 4000)}`,
  ].join("\n")).join("\n\n---\n\n");

  return `Existing Rorca memories for conflict detection:\n${recentExisting || "(none)"}\n\nSession related files:\n${relatedFiles.join("\n") || "(none)"}\n\nPi session transcript:\n${session}`;
}

function contextCwd(ctx: ExtensionContext): string {
  const maybeCwd = (ctx as ExtensionContext & { cwd?: unknown }).cwd;
  return typeof maybeCwd === "string" && maybeCwd ? maybeCwd : process.cwd();
}

function contextSessionId(ctx: ExtensionContext): string {
  const manager = ctx.sessionManager as typeof ctx.sessionManager & { getSessionId?: () => string };
  return typeof manager.getSessionId === "function" ? manager.getSessionId() : `pid-${process.pid}`;
}

function parseFlushArgs(args: string): { force: boolean; useScribe: boolean | undefined } {
  const tokens = args.split(/\s+/).filter(Boolean);
  return {
    force: tokens.includes("--force"),
    useScribe: tokens.includes("--scribe") ? true : tokens.includes("--no-scribe") ? false : undefined,
  };
}

export function registerRorcaMemoryCapture(
  pi: ExtensionAPI,
  api: RorcaApiClient,
  registerCommand: RegisterCommand,
): void {
  let options = initialOptions();
  let workspaceId: string | undefined;
  let sessionId = "unknown";
  const turns: TurnSnapshot[] = [];
  let currentTurnFiles: string[] = [];
  const sessionFiles = new Set<string>();

  const setStatus = (ctx: ExtensionContext) => {
    ctx.ui.setStatus("rorca-memory", `Rorca memory: ${options.enabled ? "on" : "off"} (${options.mode}, >=${options.threshold})`);
  };

  const resolveWorkspaceId = async (ctx: ExtensionContext): Promise<string> => {
    if (workspaceId) return workspaceId;
    const workspace = await api.resolveWorkspace(process.env.RORCA_PI_WORKSPACE_ID);
    workspaceId = workspace.id;
    ctx.ui.setStatus("rorca-workspace", `Rorca: ${workspace.label}`);
    return workspace.id;
  };

  const flush = async (ctx: ExtensionContext, args = ""): Promise<void> => {
    const parsedArgs = parseFlushArgs(args);
    const shouldUseScribe = parsedArgs.useScribe ?? options.useScribe;
    if (!parsedArgs.force && turns.length === 0) {
      ctx.ui.notify("Rorca memory: nothing to flush.", "info");
      return;
    }

    const resolvedWorkspaceId = await resolveWorkspaceId(ctx);
    const relatedFiles = unique([...sessionFiles, ...currentTurnFiles]).slice(0, 50);
    const existing = await getRecentMemories(api, resolvedWorkspaceId);

    let candidates: MemoryCandidate[] = [];
    if (shouldUseScribe) {
      const scribeOutput = await runScribeSubagent(buildScribeInput(turns, existing, relatedFiles), contextCwd(ctx), options.threshold);
      candidates = parseJsonCandidates(scribeOutput, relatedFiles);
    }
    if (candidates.length === 0) candidates = heuristicCandidates(turns, relatedFiles);

    candidates = dedupeCandidates(candidates)
      .filter((candidate) => candidate.confidence >= options.threshold)
      .slice(0, options.maxCandidatesPerFlush);

    if (candidates.length === 0) {
      ctx.ui.notify(`Rorca memory: no candidates met confidence threshold ${options.threshold}.`, "info");
      return;
    }

    let saved = 0;
    let relations = 0;
    for (const candidate of candidates) {
      const declaredConflicts = (candidate.conflictsWithMemoryIds ?? []).map((id) => ({
        id,
        reason: candidate.conflictReason ?? "Memory-scribe detected a contradiction with this existing memory.",
      }));
      const heuristicConflicts = detectHeuristicConflict(candidate, existing);
      const conflicts = [...declaredConflicts, ...heuristicConflicts].filter((conflict, index, all) => (
        all.findIndex((item) => item.id === conflict.id) === index
      ));

      if (options.mode === "dry-run") {
        ctx.ui.notify(`Rorca memory dry-run: ${candidate.category} / ${candidate.title} (${candidate.confidence})`, "info");
        continue;
      }

      await postMemory(api, resolvedWorkspaceId, sessionId, candidate);
      saved++;
      if (conflicts.length > 0) {
        const postedId = await findPostedMemoryId(api, resolvedWorkspaceId, candidate);
        if (postedId) relations += await postConflictRelations(api, resolvedWorkspaceId, postedId, conflicts);
      }
    }

    turns.length = 0;
    currentTurnFiles = [];
    sessionFiles.clear();
    ctx.ui.notify(`Rorca memory: saved ${saved} ${saved === 1 ? "memory" : "memories"}${relations ? ` and ${relations} conflict relation(s)` : ""}.`, "success");
  };

  registerCommand("memory-on", "Enable automatic Rorca memory capture for this Pi session", async (_args, ctx) => {
    options = { ...options, enabled: true };
    setStatus(ctx);
    ctx.ui.notify("Rorca memory capture enabled.", "success");
  });

  registerCommand("memory-off", "Disable automatic Rorca memory capture for this Pi session", async (_args, ctx) => {
    options = { ...options, enabled: false };
    setStatus(ctx);
    ctx.ui.notify("Rorca memory capture disabled.", "info");
  });

  registerCommand("memory-flush", "Extract and post high-confidence Rorca memories now. Flags: --scribe, --no-scribe, --force", async (args, ctx) => {
    await flush(ctx, args);
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionId = contextSessionId(ctx);
    setStatus(ctx);
    if (options.enabled) {
      try {
        await resolveWorkspaceId(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Rorca memory capture could not resolve workspace: ${message}`, "warning");
      }
    }
  });

  pi.on("turn_start", async () => {
    currentTurnFiles = [];
  });

  const rememberToolFile = (toolName: string, args: unknown, ctx: ExtensionContext) => {
    if (!["read", "edit", "write"].includes(toolName)) return;
    const file = fileFromArgs(args);
    if (!file) return;
    const clean = sanitizeFile(file, contextCwd(ctx));
    currentTurnFiles.push(clean);
    sessionFiles.add(clean);
  };

  pi.on("tool_execution_start", async (event, ctx) => {
    // Pi includes tool args reliably at start; some end events omit them.
    rememberToolFile(event.toolName, event.args, ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    // Best-effort fallback for runtimes that also include args on end events.
    rememberToolFile(event.toolName, (event as { args?: unknown }).args, ctx);
  });

  pi.on("turn_end", async (event) => {
    if (!options.enabled) return;
    const assistantText = messageText(event.message).trim();
    if (!assistantText) return;
    const toolSummary = (event.toolResults ?? []).map((result: unknown) => messageText(result)).filter(Boolean).join("\n").slice(0, 2000);
    turns.push({
      turnIndex: event.turnIndex,
      assistantText: assistantText.slice(0, 6000),
      toolSummary,
      relatedFiles: unique(currentTurnFiles),
      timestamp: new Date().toISOString(),
    });
    while (turns.length > 30) turns.shift();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!options.enabled || turns.length === 0) return;
    try {
      await flush(ctx);
    } catch {
      // Shutdown must stay best-effort; use /memory-flush during the session for visible errors.
    }
  });
}
