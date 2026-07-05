import * as vscode from "vscode";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { RorcaCaptureClient, queuePathForWorkspace } from "./client.js";
import { normalizeRorcaCaptureConfig, type RorcaCaptureConfig } from "./config.js";
import { RORCA_COMMANDS, registerRorcaCommands, submitRememberSelection } from "./commands.js";

const PAUSED_KEY = "rorcaCapture.paused";

type RuntimeState = {
  config: RorcaCaptureConfig;
  workspaceId: string;
  workspacePath: string;
  client: RorcaCaptureClient;
  statusBar: vscode.StatusBarItem;
};

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  context.subscriptions.push(statusBar);

  const buildState = (): RuntimeState | null => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      updateStatusBar(statusBar, "degraded", "Open a workspace folder to enable Rorca Capture.");
      return null;
    }
    const config = normalizeRorcaCaptureConfig(vscode.workspace.getConfiguration("rorcaCapture"));
    const workspacePath = folder.uri.fsPath;
    const workspaceId = config.workspaceId ?? folder.name;
    return {
      config,
      workspaceId,
      workspacePath,
      client: new RorcaCaptureClient({ apiBaseUrl: config.apiBaseUrl, queuePath: queuePathForWorkspace(workspacePath), queueMaxSize: config.queueMaxSize }),
      statusBar,
    };
  };

  const canCapture = (state: RuntimeState | null): state is RuntimeState => {
    if (!state) return false;
    if (!vscode.workspace.isTrusted) {
      updateStatusBar(statusBar, "untrusted", "Workspace is not trusted; Rorca Capture is disabled.");
      return false;
    }
    if (!state.config.enabled || state.config.policyMode === "off") {
      updateStatusBar(statusBar, "paused", "Rorca Capture is disabled by configuration.");
      return false;
    }
    if (context.globalState.get<boolean>(PAUSED_KEY, false)) {
      updateStatusBar(statusBar, "paused", "Rorca Capture is paused.");
      return false;
    }
    updateStatusBar(statusBar, "active", "Rorca Capture is active.");
    return true;
  };

  const submit = async (eventType: Parameters<RorcaCaptureClient["submit"]>[0]["eventType"], payload: Record<string, unknown>) => {
    const state = buildState();
    if (!canCapture(state)) return;
    const git = readGitContext(state.workspacePath);
    const result = await state.client.submit({
      workspaceId: state.workspaceId,
      workspacePath: state.workspacePath,
      eventType,
      policyMode: state.config.policyMode,
      payload: {
        ...payload,
        hostApi: "vscode-stable-extension-api",
        git,
      },
    });
    updateStatusBar(statusBar, result.queued ? "queued" : "active", result.queued ? "Rorca Capture is queued offline." : "Rorca Capture is active.");
  };

  context.subscriptions.push(...registerRorcaCommands({
    registry: vscode.commands,
    handlers: {
      [RORCA_COMMANDS.captureSessionSummary]: async () => {
        await submit("session_summary", buildSessionSummary());
        await vscode.window.showInformationMessage("Rorca session summary captured.");
      },
      [RORCA_COMMANDS.rememberSelection]: async () => {
        const state = buildState();
        if (!canCapture(state)) return;
        const editor = vscode.window.activeTextEditor;
        const selectionText = editor?.document.getText(editor.selection) ?? "";
        if (!selectionText.trim()) {
          await vscode.window.showWarningMessage("Select text before running Rorca: Remember Selection.");
          return;
        }
        const result = await submitRememberSelection({
          client: state.client,
          config: state.config,
          workspaceId: state.workspaceId,
          workspacePath: state.workspacePath,
          selectionText,
          filePath: editor?.document.uri.fsPath,
          languageId: editor?.document.languageId,
        });
        updateStatusBar(statusBar, result.queued ? "queued" : "active", `Rorca memory candidate submitted (${result.governance.submittedCandidates}/${result.governance.maxCandidates}).`);
        await vscode.window.showInformationMessage(result.queued ? "Rorca memory candidate queued for review." : "Rorca memory candidate submitted for review.");
      },
      [RORCA_COMMANDS.pauseCapture]: async () => {
        const paused = !context.globalState.get<boolean>(PAUSED_KEY, false);
        await context.globalState.update(PAUSED_KEY, paused);
        updateStatusBar(statusBar, paused ? "paused" : "active", paused ? "Rorca Capture is paused." : "Rorca Capture resumed.");
        await vscode.window.showInformationMessage(paused ? "Rorca Capture paused." : "Rorca Capture resumed.");
      },
      [RORCA_COMMANDS.showCaptureStatus]: async () => {
        const state = buildState();
        const status = statusSnapshot(state, vscode.workspace.isTrusted, context.globalState.get<boolean>(PAUSED_KEY, false) ?? false);
        await vscode.window.showInformationMessage(status);
      },
      [RORCA_COMMANDS.reviewCandidates]: async () => {
        const state = buildState();
        const url = `${state?.config.apiBaseUrl ?? "http://127.0.0.1:3030"}/#/memory?workspaceId=${encodeURIComponent(state?.workspaceId ?? "")}&review=candidates`;
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.parse(url));
      },
    },
  }));

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      void submit("file_saved", documentMetadata(document));
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) void submit("editor_active", documentMetadata(editor.document));
    }),
    vscode.window.onDidOpenTerminal((terminal) => {
      void submit("terminal_opened", { terminalName: terminal.name, processIdAvailable: Boolean(terminal.processId) });
    }),
    vscode.tasks.onDidStartTask((event) => {
      void submit("task_started", { taskName: event.execution.task.name, taskSource: event.execution.task.source, taskDefinition: event.execution.task.definition ?? null });
    }),
    vscode.tasks.onDidEndTaskProcess((event) => {
      void submit("task_ended", { taskName: event.execution.task.name, taskSource: event.execution.task.source, exitCode: event.exitCode ?? null });
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { canCapture(buildState()); }),
  );

  canCapture(buildState());
  void submit("activation", { capability: "stable-vscode-extension-api", proprietaryAiChat: "unsupported-without-explicit-adapter-api" });
  statusBar.show();
}

export function deactivate(): void {
  // No long-running resources are held; queued events are persisted synchronously per submit.
}

function updateStatusBar(statusBar: vscode.StatusBarItem, state: "active" | "queued" | "paused" | "degraded" | "untrusted", tooltip: string): void {
  const label = state === "active" ? "$(radio-tower) Rorca" : state === "queued" ? "$(cloud-upload) Rorca" : state === "paused" ? "$(debug-pause) Rorca" : "$(warning) Rorca";
  statusBar.text = `${label} ${state}`;
  statusBar.tooltip = tooltip;
  statusBar.command = RORCA_COMMANDS.showCaptureStatus;
  statusBar.show();
}

function buildSessionSummary(): Record<string, unknown> {
  const editor = vscode.window.activeTextEditor;
  return {
    activeEditor: editor ? documentMetadata(editor.document) : null,
    workspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => ({ name: folder.name, uriScheme: folder.uri.scheme, path: folder.uri.fsPath })) ?? [],
    proprietaryAiChat: "unsupported-without-explicit-adapter-api",
  };
}

function documentMetadata(document: vscode.TextDocument): Record<string, unknown> {
  return {
    uriScheme: document.uri.scheme,
    filePath: document.uri.fsPath,
    languageId: document.languageId,
    isUntitled: document.isUntitled,
  };
}

function readGitContext(workspacePath: string): { branch: string | null; sha: string | null } {
  const run = (args: string[]): string | null => {
    const result = spawnSync("git", args, { cwd: workspacePath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 });
    return result.status === 0 ? String(result.stdout || "").trim() || null : null;
  };
  return { branch: run(["rev-parse", "--abbrev-ref", "HEAD"]), sha: run(["rev-parse", "HEAD"]) };
}

function statusSnapshot(state: RuntimeState | null, trusted: boolean, paused: boolean): string {
  if (!trusted) return "Rorca Capture: degraded (workspace is untrusted).";
  if (!state) return "Rorca Capture: degraded (no workspace folder).";
  if (!state.config.enabled || state.config.policyMode === "off") return "Rorca Capture: disabled by configuration.";
  if (paused) return `Rorca Capture: paused for workspace ${state.workspaceId}.`;
  return `Rorca Capture: active for workspace ${state.workspaceId}; API ${state.config.apiBaseUrl}; queue ${path.join(state.workspacePath, ".rorca", "capture", "queue")}.`;
}
