import type { RorcaCaptureClient, MemoryCandidate } from "./client.js";
import { applyMemoryCandidateGovernance } from "./client.js";
import type { RorcaCaptureConfig } from "./config.js";

export const RORCA_COMMANDS = {
  captureSessionSummary: "rorca.captureSessionSummary",
  rememberSelection: "rorca.rememberSelection",
  pauseCapture: "rorca.pauseCapture",
  showCaptureStatus: "rorca.showCaptureStatus",
  reviewCandidates: "rorca.reviewCandidates",
} as const;

export type RorcaCommandId = typeof RORCA_COMMANDS[keyof typeof RORCA_COMMANDS];

export const RORCA_COMMAND_TITLES: Record<RorcaCommandId, string> = {
  [RORCA_COMMANDS.captureSessionSummary]: "Rorca: Capture Session Summary",
  [RORCA_COMMANDS.rememberSelection]: "Rorca: Remember Selection",
  [RORCA_COMMANDS.pauseCapture]: "Rorca: Pause Capture",
  [RORCA_COMMANDS.showCaptureStatus]: "Rorca: Show Capture Status",
  [RORCA_COMMANDS.reviewCandidates]: "Rorca: Review Candidates",
};

export type CommandRegistry = { registerCommand(command: string, callback: (...args: unknown[]) => unknown): { dispose(): unknown } };

export type RegisterCommandsInput = {
  registry: CommandRegistry;
  handlers: Record<RorcaCommandId, (...args: unknown[]) => unknown>;
};

export function registerRorcaCommands(input: RegisterCommandsInput): Array<{ dispose(): unknown }> {
  return (Object.keys(RORCA_COMMAND_TITLES) as RorcaCommandId[]).map((command) => input.registry.registerCommand(command, input.handlers[command]));
}

export async function submitRememberSelection(input: {
  client: RorcaCaptureClient;
  config: RorcaCaptureConfig;
  workspaceId: string;
  workspacePath: string;
  selectionText: string;
  filePath?: string;
  languageId?: string;
}): Promise<{ queued: boolean; governance: ReturnType<typeof applyMemoryCandidateGovernance>["governance"] }> {
  const candidate: MemoryCandidate = {
    category: "Decision",
    title: `Remember selection from ${input.filePath ? input.filePath.split(/[\\/]/).pop() : "editor"}`,
    rule: input.selectionText,
    context: input.filePath ? `Explicit Remember Selection command from ${input.filePath}${input.languageId ? ` (${input.languageId})` : ""}.` : "Explicit Remember Selection command from VS Code-compatible editor.",
    source: "vscode-extension:remember-selection",
    relatedFiles: input.filePath ? [input.filePath] : [],
  };
  const governed = applyMemoryCandidateGovernance([candidate], input.config);
  const firstCandidate = governed.candidates[0];
  const result = await input.client.submit({
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    eventType: "explicit_memory",
    policyMode: input.config.policyMode,
    payload: {
      memory_summary: firstCandidate?.rule ?? "Memory candidate omitted because it exceeded Rorca governance caps.",
      category: firstCandidate?.category ?? candidate.category,
      requested_by: "human",
      candidates: governed.candidates,
      governance: governed.governance,
      reviewRequired: true,
      related_files: (firstCandidate?.relatedFiles ?? candidate.relatedFiles)?.map((filePath) => ({ path: filePath, role: "mentioned" as const })) ?? [],
    },
  });
  return { queued: result.queued, governance: governed.governance };
}
