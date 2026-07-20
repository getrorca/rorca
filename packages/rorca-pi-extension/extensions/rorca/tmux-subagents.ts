/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Type } from "typebox";
import type { RorcaApiClient } from "./api.js";

const execFile = promisify(execFileCb);
const DEFAULT_SESSION_PREFIX = "rorca-pi-agents";
const CAPTURE_LINES = 300;

type RegisterCommand = (name: string, description: string, handler: (args: string, ctx: ExtensionContext) => Promise<void>) => void;

type MemoryMode = "inherit" | "on" | "off";

interface AgentTask {
  name: string;
  task: string;
}

interface RunOptions {
  sessionName: string;
  cwd: string;
  memory: MemoryMode;
  popup: boolean;
  dashboard: boolean;
  model?: string;
  provider?: string;
  workspaceId?: string;
  interactive: boolean;
  tasks: AgentTask[];
}

interface AgentPane {
  index: number;
  paneId: string;
  title: string;
  command: string;
  dead: boolean;
  deadStatus?: string;
  pid: string;
}

interface ActiveAgentSession {
  name: string;
  cwd: string;
  startedAt: number;
  tasks: AgentTask[];
  memory: MemoryMode;
  workspaceId?: string;
}

interface TmuxCommandResult {
  stdout: string;
  stderr: string;
}

class TmuxSubagentManager {
  private activeSession: ActiveAgentSession | null = null;

  constructor(private api: RorcaApiClient) {}

  currentSession(): ActiveAgentSession | null {
    return this.activeSession;
  }

  async launch(options: RunOptions): Promise<ActiveAgentSession> {
    await this.requireTmux();
    const exists = await this.hasSession(options.sessionName);
    if (exists) {
      throw new Error(`tmux session ${options.sessionName} already exists. Use --session with a new name or /agents-kill ${options.sessionName}.`);
    }

    const scriptsDir = await mkdtemp(path.join(tmpdir(), `${options.sessionName}-`));
    const extensionPath = resolveExtensionEntryPath();

    for (let index = 0; index < options.tasks.length; index++) {
      const task = options.tasks[index]!;
      const scriptPath = path.join(scriptsDir, `${sanitizeName(task.name)}.sh`);
      writeFileSync(scriptPath, buildAgentScript({
        cwd: options.cwd,
        extensionPath,
        task,
        memory: options.memory,
        model: options.model,
        provider: options.provider,
        workspaceId: options.workspaceId,
        interactive: options.interactive,
      }));
      await chmod(scriptPath, 0o700);

      let paneId = '';
      if (index === 0) {
        await tmux(["new-session", "-d", "-x", "240", "-y", "80", "-s", options.sessionName, "-n", "agents", shellQuote(scriptPath)]);
        await tmux(["set-window-option", "-t", `${options.sessionName}:0`, "remain-on-exit", "on"]).catch(() => undefined);
        paneId = (await tmux(["display-message", "-p", "-t", `${options.sessionName}:0.0`, "#{pane_id}"])).stdout.trim();
      } else {
        try {
          const result = await tmux(["split-window", "-P", "-F", "#{pane_id}", "-t", `${options.sessionName}:0`, shellQuote(scriptPath)]);
          paneId = result.stdout.trim();
          await tmux(["select-layout", "-t", `${options.sessionName}:0`, "tiled"]).catch(() => undefined);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/no space for new pane/i.test(message)) throw error;
          const result = await tmux(["new-window", "-P", "-F", "#{pane_id}", "-t", options.sessionName, "-n", `agent-${index + 1}`, shellQuote(scriptPath)]);
          paneId = result.stdout.trim();
          await tmux(["set-window-option", "-t", paneId, "remain-on-exit", "on"]).catch(() => undefined);
        }
      }
      if (paneId) {
        await tmux(["select-pane", "-t", paneId, "-T", task.name]).catch(() => undefined);
      }
    }

    await tmux(["select-layout", "-t", `${options.sessionName}:0`, "tiled"]).catch(() => undefined);

    const session: ActiveAgentSession = {
      name: options.sessionName,
      cwd: options.cwd,
      startedAt: Date.now(),
      tasks: options.tasks,
      memory: options.memory,
      workspaceId: options.workspaceId,
    };
    this.activeSession = session;
    return session;
  }

  async listPanes(sessionName: string): Promise<AgentPane[]> {
    const result = await tmux([
      "list-panes",
      "-s",
      "-t",
      sessionName,
      "-F",
      "#{window_index}.#{pane_index}\t#{pane_id}\t#{pane_title}\t#{pane_current_command}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_pid}",
    ]);
    return result.stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const [index, paneId, title, command, dead, deadStatus, pid] = line.split("\t");
        const paneIndex = Number((index ?? '0').split('.').pop() ?? 0);
        return {
          index: Number.isFinite(paneIndex) ? paneIndex : 0,
          paneId: paneId ?? "",
          title: title || `agent-${index}`,
          command: command ?? "",
          dead: dead === "1",
          deadStatus: deadStatus || undefined,
          pid: pid ?? "",
        };
      });
  }

  async capturePane(paneId: string, lines: number = CAPTURE_LINES): Promise<string[]> {
    const result = await tmux(["capture-pane", "-t", paneId, "-p", "-S", String(-Math.abs(lines))]);
    return result.stdout.replace(/\s+$/g, "").split("\n");
  }

  async killPane(paneId: string): Promise<void> {
    await tmux(["kill-pane", "-t", paneId]);
  }

  async killSession(sessionName?: string): Promise<void> {
    const target = sessionName || this.activeSession?.name;
    if (!target) throw new Error("No active tmux subagent session.");
    await tmux(["kill-session", "-t", target]);
    if (this.activeSession?.name === target) this.activeSession = null;
  }

  async hasSession(sessionName: string): Promise<boolean> {
    try {
      await tmux(["has-session", "-t", sessionName]);
      return true;
    } catch {
      return false;
    }
  }

  async openPopup(sessionName?: string): Promise<void> {
    const target = sessionName || this.activeSession?.name;
    if (!target) throw new Error("No active tmux subagent session.");
    await this.requireTmux();

    if (!process.env.TMUX) {
      throw new Error("tmux popup requires Pi to be running inside tmux. Use /agents-dashboard or attach manually: tmux attach -t " + target);
    }

    await tmux(["display-popup", "-E", "-w", "95%", "-h", "85%", "tmux attach-session -t " + shellQuote(target)]);
  }

  async formatList(sessionName?: string): Promise<string[]> {
    const target = sessionName || this.activeSession?.name;
    if (!target) return ["No active tmux subagent session."];
    const panes = await this.listPanes(target);
    if (panes.length === 0) return [`${target}: no panes`];
    return panes.map((pane) => `${target}:${pane.index} ${plainPaneStatusLabel(pane)} ${displayPaneTitle(pane.title)} pid=${pane.pid}`);
  }

  async resolveWorkspaceId(explicit: string | undefined, ctx: ExtensionContext): Promise<string | undefined> {
    if (explicit) return explicit;
    if (process.env.RORCA_PI_WORKSPACE_ID) return process.env.RORCA_PI_WORKSPACE_ID;
    try {
      const workspace = await this.api.resolveWorkspace(undefined, async (workspaces) => {
        const options = workspaces.map((workspace) => `${workspace.id} — ${workspace.label}`);
        const selected = await ctx.ui.select("Workspace for subagent memory", options);
        return selected?.split(" — ")[0];
      });
      return workspace.id;
    } catch {
      return undefined;
    }
  }

  private async requireTmux(): Promise<void> {
    try {
      await tmux(["-V"]);
    } catch {
      throw new Error("tmux is required for /agents-run. Install tmux and try again.");
    }
  }
}

export function registerTmuxSubagents(pi: ExtensionAPI, api: RorcaApiClient, registerCommand: RegisterCommand): void {
  const manager = new TmuxSubagentManager(api);

  registerSubagentTool(pi, manager);

  const launch = async (args: string, ctx: ExtensionContext) => {
    const options = parseRunArgs(args, contextCwd(ctx));
    options.workspaceId = await manager.resolveWorkspaceId(options.workspaceId, ctx);

    const session = await manager.launch(options);
    ctx.ui.notify(`Launched ${session.tasks.length} Pi subagent${session.tasks.length === 1 ? "" : "s"} in tmux session ${session.name}.`, "success");
    ctx.ui.setStatus("rorca-agents", `Agents: ${session.tasks.length} in ${session.name}`);

    if (options.popup) {
      try {
        await manager.openPopup(session.name);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "warning");
      }
    }

    if (options.dashboard) {
      await showDashboard(ctx, manager, session.name);
    }
  };

  registerCommand("agents-run", "Launch tmux-backed Pi subagents. Usage: /agents-run [--interactive] [--memory on|off|inherit] name: task || reviewer: task", launch);
  registerCommand("subagents-run", "Alias for /agents-run", launch);
  registerCommand("subagents", "Alias for /agents-run", launch);

  registerCommand("agents-dashboard", "Open the native Pi overlay dashboard for tmux subagents", async (args, ctx) => {
    const sessionName = args.trim() || manager.currentSession()?.name;
    if (!sessionName) throw new Error("No active subagent session. Run /agents-run first or pass a tmux session name.");
    await showDashboard(ctx, manager, sessionName);
  });
  registerCommand("subagents-dashboard", "Alias for /agents-dashboard", async (args, ctx) => {
    const sessionName = args.trim() || manager.currentSession()?.name;
    if (!sessionName) throw new Error("No active subagent session. Run /agents-run first or pass a tmux session name.");
    await showDashboard(ctx, manager, sessionName);
  });

  registerCommand("agents-popup", "Open a tmux popup attached to the subagent session", async (args, ctx) => {
    const sessionName = args.trim() || manager.currentSession()?.name;
    await manager.openPopup(sessionName);
    ctx.ui.notify(`Opened tmux popup for ${sessionName || manager.currentSession()?.name}.`, "success");
  });
  registerCommand("subagents-popup", "Alias for /agents-popup", async (args, ctx) => {
    const sessionName = args.trim() || manager.currentSession()?.name;
    await manager.openPopup(sessionName);
    ctx.ui.notify(`Opened tmux popup for ${sessionName || manager.currentSession()?.name}.`, "success");
  });

  registerCommand("agents-list", "List panes in the active tmux subagent session", async (args, ctx) => {
    const lines = await manager.formatList(args.trim() || undefined);
    ctx.ui.notify(lines.join("\n"), "info");
  });

  registerCommand("agents-kill", "Kill the active tmux subagent session or the named session", async (args, ctx) => {
    const target = args.trim() || undefined;
    await manager.killSession(target);
    ctx.ui.setStatus("rorca-agents", undefined);
    ctx.ui.notify(`Killed tmux subagent session ${target || "active"}.`, "success");
  });

  pi.on("session_shutdown", async () => {
    // Do not kill tmux sessions automatically: users may intentionally keep panes
    // open after closing Pi. /agents-kill performs explicit cleanup.
  });
}

function registerSubagentTool(pi: ExtensionAPI, manager: TmuxSubagentManager): void {
  pi.registerTool({
    name: "rorca_tmux_subagents",
    label: "Rorca Tmux Subagents",
    description: [
      "Launch one or more isolated Pi subprocesses in tmux panes with optional Rorca memory capture.",
      "Use this when the user asks to spin up subagents, subprocesses, parallel workers, tmux panes, or an agent dashboard.",
      "Infer the tasks array from the user's natural-language request. Each tasks[] item becomes exactly one subprocess/pane.",
      "If the work has ordering dependencies, prefer one sequential task instead of parallel tasks.",
      "After launch, use the dashboard/popup/session name returned to monitor or kill the agents.",
    ].join(" "),
    parameters: Type.Object({
      tasks: Type.Array(Type.Object({
        name: Type.String({ description: "Short pane-safe name, e.g. packaging or hermes-ui." }),
        task: Type.String({ description: "Full autonomous task prompt for this subprocess." }),
      }), { minItems: 1, description: "Subagents to launch. Each item creates one tmux pane." }),
      memory: Type.Optional(Type.Union([Type.Literal("on"), Type.Literal("off"), Type.Literal("inherit")], { default: "on" })),
      workspaceId: Type.Optional(Type.String({ description: "Rorca workspace id for memory capture, e.g. rorca." })),
      cwd: Type.Optional(Type.String({ description: "Working directory for child Pi processes. Defaults to current session cwd." })),
      sessionName: Type.Optional(Type.String({ description: "Optional tmux session name. A timestamped name is generated by default." })),
      interactive: Type.Optional(Type.Boolean({ description: "Run child Pi TUIs interactively inside tmux panes. Default true for this tool." })),
      dashboard: Type.Optional(Type.Boolean({ description: "Open the Pi-native dashboard overlay after launch. Default true." })),
      popup: Type.Optional(Type.Boolean({ description: "Attempt tmux display-popup after launch. Only works when parent Pi is inside tmux. Default false." })),
      model: Type.Optional(Type.String({ description: "Optional Pi model override for children." })),
      provider: Type.Optional(Type.String({ description: "Optional Pi provider override for children." })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) {
      const rawTasks = Array.isArray(params.tasks) ? params.tasks : [];
      const tasks = rawTasks.map((item, index): AgentTask => {
        const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
        return parseTask(`${String(record.name || `agent-${index + 1}`)}: ${String(record.task || "")}`, index);
      }).filter((task) => task.task.trim().length > 0);

      if (tasks.length === 0) {
        return { content: [{ type: "text", text: "No valid subagent tasks were provided." }] };
      }

      const memory = parseMemory(typeof params.memory === "string" ? params.memory : "on");
      const sessionName = sanitizeName(typeof params.sessionName === "string" && params.sessionName.trim()
        ? params.sessionName
        : `${DEFAULT_SESSION_PREFIX}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`);
      const cwd = typeof params.cwd === "string" && params.cwd.trim() ? path.resolve(params.cwd) : contextCwd(ctx);
      const workspaceId = await manager.resolveWorkspaceId(typeof params.workspaceId === "string" ? params.workspaceId : undefined, ctx);
      const interactive = typeof params.interactive === "boolean" ? params.interactive : true;
      const dashboard = typeof params.dashboard === "boolean" ? params.dashboard : true;
      const popup = typeof params.popup === "boolean" ? params.popup : false;

      const session = await manager.launch({
        sessionName,
        cwd,
        memory,
        popup,
        dashboard,
        model: typeof params.model === "string" ? params.model : undefined,
        provider: typeof params.provider === "string" ? params.provider : undefined,
        workspaceId,
        interactive,
        tasks,
      });

      ctx.ui.notify(`Launched ${session.tasks.length} tmux Pi subagent${session.tasks.length === 1 ? "" : "s"} in ${session.name}.`, "success");
      ctx.ui.setStatus("rorca-agents", `Agents: ${session.tasks.length} in ${session.name}`);

      if (popup) {
        try {
          await manager.openPopup(session.name);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(message, "warning");
        }
      }
      if (dashboard) {
        await showDashboard(ctx, manager, session.name);
      }

      return {
        content: [{
          type: "text",
          text: [
            `Launched ${session.tasks.length} tmux-backed Pi subagent${session.tasks.length === 1 ? "" : "s"}.`,
            `Session: ${session.name}`,
            `CWD: ${session.cwd}`,
            `Memory: ${session.memory}${session.workspaceId ? ` workspace=${session.workspaceId}` : ""}`,
            "Monitor: /agents-dashboard " + session.name,
            "Attach manually: tmux attach -t " + session.name,
            "Stop: /agents-kill " + session.name,
          ].join("\n"),
        }],
        details: session,
      };
    },
  });
}

async function showDashboard(ctx: ExtensionContext, manager: TmuxSubagentManager, sessionName: string): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new SubagentDashboard(tui, theme, manager, sessionName, done), {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "94%",
      maxHeight: "88%",
      margin: 1,
      visible: (termWidth: number, termHeight: number) => termWidth >= 80 && termHeight >= 20,
    },
  });
}

class SubagentDashboard implements Component {
  private panes: AgentPane[] = [];
  private output: string[] = [];
  private selected = 0;
  private scroll = 0;
  private follow = true;
  private lastError = "";
  private interval: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private manager: TmuxSubagentManager,
    private sessionName: string,
    private done: () => void,
  ) {
    void this.refresh();
    this.interval = setInterval(() => void this.refresh(), 1000);
  }

  invalidate(): void {}

  dispose(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  async refresh(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      this.panes = await this.manager.listPanes(this.sessionName);
      if (this.selected >= this.panes.length) this.selected = Math.max(0, this.panes.length - 1);
      const pane = this.panes[this.selected];
      this.output = pane ? await this.manager.capturePane(pane.paneId) : [];
      this.lastError = "";
      if (this.follow) this.scroll = 0;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.polling = false;
      this.tui.requestRender();
    }
  }

  handleInput(data: string): void {
    if (data === "\u001b" || data === "q" || data === "\u0003") {
      this.dispose();
      this.done();
      return;
    }

    if (data === "\t") {
      this.selected = this.panes.length > 0 ? (this.selected + 1) % this.panes.length : 0;
      this.follow = true;
      void this.refresh();
      return;
    }

    if (data === "\u001b[Z") {
      this.selected = this.panes.length > 0 ? (this.selected - 1 + this.panes.length) % this.panes.length : 0;
      this.follow = true;
      void this.refresh();
      return;
    }

    if (data === "j" || data === "\u001b[B") {
      this.follow = false;
      this.scroll = Math.max(0, this.scroll - 1);
      this.tui.requestRender();
      return;
    }

    if (data === "k" || data === "\u001b[A") {
      this.follow = false;
      this.scroll = this.scroll + 1;
      this.tui.requestRender();
      return;
    }

    if (data === "f") {
      this.follow = !this.follow;
      if (this.follow) this.scroll = 0;
      this.tui.requestRender();
      return;
    }

    if (data === "r") {
      void this.refresh();
      return;
    }

    if (data === "p") {
      void this.manager.openPopup(this.sessionName).catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.tui.requestRender();
      });
      return;
    }

    if (data === "x") {
      const pane = this.panes[this.selected];
      if (pane) {
        void this.manager.killPane(pane.paneId).then(() => this.refresh()).catch((error) => {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.tui.requestRender();
        });
      }
    }
  }

  render(width: number): string[] {
    const innerW = Math.max(20, width - 2);
    const border = (s: string) => color(this.theme, "border", s);
    const accent = (s: string) => color(this.theme, "accent", s);
    const dim = (s: string) => color(this.theme, "dim", s);
    const success = (s: string) => color(this.theme, "success", s);
    const warning = (s: string) => color(this.theme, "warning", s);
    const error = (s: string) => color(this.theme, "error", s);
    const lines: string[] = [];

    const pushBox = (content: string) => lines.push(border("│") + padAnsi(content, innerW) + border("│"));
    lines.push(border(`╭${"─".repeat(innerW)}╮`));
    const aggregateStatus = this.panes.length > 0 ? formatAggregateStatus(this.panes) : "";
    pushBox(alignRight(
      ` ${accent("Rorca Pi Subagents")} ${dim(this.sessionName)} ${this.follow ? success("follow") : warning(`scroll:${this.scroll}`)}`,
      aggregateStatus ? colorStatus(aggregateStatus, success, warning, error) : "",
      innerW,
    ));
    pushBox(dim(" Tab switch | ↑/k older | ↓/j newer | f follow | r refresh | p tmux popup | x kill pane | q/Esc close"));
    lines.push(border(`├${"─".repeat(innerW)}┤`));

    if (this.lastError) {
      pushBox(error(` ${this.lastError}`));
    }

    if (this.panes.length === 0) {
      pushBox(warning(" No panes found."));
    } else {
      const paneSummary = this.panes.map((pane, i) => {
        const active = i === this.selected;
        const status = formatPaneStatus(pane);
        const statusText = status.kind === "success" ? success(status.label) : status.kind === "error" ? error(status.label) : warning(status.label);
        const label = `${active ? "▶" : " "}${pane.index}:${displayPaneTitle(pane.title)} ${statusText}`;
        return active ? accent(label) : label;
      }).join("  ");
      pushBox(` ${paneSummary}`);
    }

    lines.push(border(`├${"─".repeat(innerW)}┤`));
    const selectedPane = this.panes[this.selected];
    if (selectedPane) {
      const status = formatPaneStatus(selectedPane);
      const pill = status.kind === "success" ? success(status.pill) : status.kind === "error" ? error(status.pill) : warning(status.pill);
      pushBox(alignRight(
        ` ${accent(displayPaneTitle(selectedPane.title))} ${dim(selectedPane.paneId)} pid=${selectedPane.pid} cmd=${selectedPane.command}`,
        pill,
        innerW,
      ));
    } else {
      pushBox(" No selected pane");
    }
    lines.push(border(`├${"─".repeat(innerW)}┤`));

    const bodyHeight = 22;
    const visible = sliceFromBottom(this.output, bodyHeight, this.scroll);
    for (let i = 0; i < bodyHeight; i++) {
      const raw = visible[i] ?? "";
      pushBox(" " + truncateAnsi(raw, Math.max(1, innerW - 1)));
    }

    lines.push(border(`╰${"─".repeat(innerW)}╯`));
    return lines;
  }
}

function parseRunArgs(args: string, defaultCwd: string): RunOptions {
  const tokens = tokenizeArgs(args);
  let memory: MemoryMode = "on";
  let popup = false;
  let dashboard = true;
  let sessionName = `${DEFAULT_SESSION_PREFIX}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  let cwd = defaultCwd;
  let model: string | undefined;
  let provider: string | undefined;
  let workspaceId: string | undefined;
  let interactive = false;
  const rest: string[] = [];
  const explicitTasks: AgentTask[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const next = () => tokens[++i];
    if (token === "--popup") popup = true;
    else if (token === "--no-dashboard") dashboard = false;
    else if (token === "--dashboard") dashboard = true;
    else if (token === "--interactive") interactive = true;
    else if (token === "--print") interactive = false;
    else if (token === "--memory") memory = parseMemory(next());
    else if (token.startsWith("--memory=")) memory = parseMemory(token.slice("--memory=".length));
    else if (token === "--session") sessionName = sanitizeName(next() || sessionName);
    else if (token.startsWith("--session=")) sessionName = sanitizeName(token.slice("--session=".length));
    else if (token === "--cwd") cwd = path.resolve(next() || cwd);
    else if (token.startsWith("--cwd=")) cwd = path.resolve(token.slice("--cwd=".length));
    else if (token === "--model") model = next();
    else if (token.startsWith("--model=")) model = token.slice("--model=".length);
    else if (token === "--provider") provider = next();
    else if (token.startsWith("--provider=")) provider = token.slice("--provider=".length);
    else if (token === "--workspace") workspaceId = next();
    else if (token.startsWith("--workspace=")) workspaceId = token.slice("--workspace=".length);
    else if (token === "--task") explicitTasks.push(parseTask(next() || "", explicitTasks.length));
    else if (token.startsWith("--task=")) explicitTasks.push(parseTask(token.slice("--task=".length), explicitTasks.length));
    else rest.push(token);
  }

  const remaining = rest.join(" ").trim();
  if (!remaining && explicitTasks.length === 0) {
    throw new Error("Usage: /agents-run [--interactive] [--memory on|off|inherit] --task \"backend: task\" --task \"reviewer: task\"");
  }

  const separatorTasks = remaining
    ? remaining
      // Only literal || starts another subagent. Newlines may be introduced by
      // paste/wrapping and must stay inside the same task description.
      .split(/\s*\|\|\s*/g)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part, index) => parseTask(part, index + explicitTasks.length))
    : [];
  const tasks = [...explicitTasks, ...separatorTasks];

  if (tasks.length === 0) throw new Error("No subagent tasks provided.");

  return { sessionName, cwd, memory, popup, dashboard, model, provider, workspaceId, interactive, tasks };
}

function parseTask(part: string, index: number): AgentTask {
  const match = part.match(/^([a-zA-Z0-9_.-]{1,48})\s*:\s+([\s\S]+)$/);
  if (match) return { name: sanitizeName(match[1]!), task: match[2]!.trim() };
  return { name: `agent-${index + 1}`, task: part };
}

function parseMemory(value: string | undefined): MemoryMode {
  if (value === "on" || value === "off" || value === "inherit") return value;
  throw new Error("--memory must be one of: on, off, inherit");
}

function tokenizeArgs(input: string): string[] {
  const matches = input.match(/"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|\S+/g) || [];
  return matches.map((token) => {
    if ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function buildAgentScript(input: {
  cwd: string;
  extensionPath: string;
  task: AgentTask;
  memory: MemoryMode;
  model?: string;
  provider?: string;
  workspaceId?: string;
  interactive: boolean;
}): string {
  const piArgs = ["--no-session", "--no-context-files", "-e", input.extensionPath];
  if (input.provider) piArgs.push("--provider", input.provider);
  if (input.model) piArgs.push("--model", input.model);
  if (!input.interactive) piArgs.push("-p");
  piArgs.push(input.task.task);

  const exports: string[] = [];
  if (input.memory !== "inherit") exports.push(`export RORCA_PI_MEMORY_AUTO=${shellQuote(input.memory === "on" ? "1" : "0")}`);
  if (input.workspaceId) exports.push(`export RORCA_PI_WORKSPACE_ID=${shellQuote(input.workspaceId)}`);
  exports.push(`export RORCA_PI_MEMORY_MODE=${shellQuote(process.env.RORCA_PI_MEMORY_MODE || "direct")}`);
  exports.push(`export RORCA_PI_MEMORY_CONFIDENCE=${shellQuote(process.env.RORCA_PI_MEMORY_CONFIDENCE || "0.85")}`);
  if (process.env.RORCA_PI_API_URL) exports.push(`export RORCA_PI_API_URL=${shellQuote(process.env.RORCA_PI_API_URL)}`);
  if (process.env.RORCA_PI_MEMORY_SCRIBE) exports.push(`export RORCA_PI_MEMORY_SCRIBE=${shellQuote(process.env.RORCA_PI_MEMORY_SCRIBE)}`);

  return `#!/usr/bin/env bash
set -uo pipefail
cd ${shellQuote(input.cwd)}
${exports.join("\n")}
clear
printf '%s\n' ${shellQuote(`### Rorca Pi subagent: ${input.task.name}`)}
printf '%s\n' ${shellQuote(`### Memory: ${input.memory}${input.workspaceId ? ` workspace=${input.workspaceId}` : ""}`)}
printf '%s\n' ${shellQuote(`### Mode: ${input.interactive ? "interactive Pi TUI" : "print-and-exit"}`)}
printf '%s\n' ${shellQuote(`### CWD: ${input.cwd}`)}
printf '%s\n\n' ${shellQuote("### Task starts below")}
pi ${piArgs.map(shellQuote).join(" ")}
status=$?
if [ -n "\${TMUX_PANE:-}" ]; then
  if [ "$status" -eq 0 ]; then
    tmux select-pane -t "$TMUX_PANE" -T ${shellQuote(`${input.task.name} ✓`)} >/dev/null 2>&1 || true
  else
    tmux select-pane -t "$TMUX_PANE" -T ${shellQuote(`${input.task.name} ✗`)} >/dev/null 2>&1 || true
  fi
fi
printf '\n%s\n' "### Subagent ${input.task.name} exited with status $status"
printf '%s\n' "### Pane remains open for inspection. Kill it with the dashboard x key or tmux kill-pane."
exit $status
`;
}

function resolveExtensionEntryPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const candidates = [
    path.join(currentDir, "index.ts"),
    path.join(currentDir, "index.js"),
    currentFile.replace(/tmux-subagents\.(ts|js)$/, "index.$1"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || path.join(currentDir, "index.ts");
}

async function tmux(args: string[]): Promise<TmuxCommandResult> {
  const result = await execFile("tmux", args, { maxBuffer: 5 * 1024 * 1024 });
  return { stdout: result.stdout, stderr: result.stderr };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "agent";
}

function contextCwd(ctx: ExtensionContext): string {
  const maybe = ctx as ExtensionContext & { cwd?: unknown };
  return typeof maybe.cwd === "string" && maybe.cwd.trim() ? maybe.cwd : process.cwd();
}

function displayPaneTitle(title: string): string {
  return title.replace(/[ \t]+[✓✗]$/, "");
}

function formatPaneStatus(pane: AgentPane): { label: string; pill: string; kind: "success" | "warning" | "error" } {
  if (!pane.dead) return { label: "● run", pill: "[● RUNNING]", kind: "warning" };

  const rawStatus = pane.deadStatus?.trim();
  const code = rawStatus ? Number(rawStatus) : 0;
  if (Number.isFinite(code) && code !== 0) {
    return { label: `✕ fail:${code}`, pill: `[✕ FAILED ${code}]`, kind: "error" };
  }

  return { label: "✓ done", pill: "[✓ DONE]", kind: "success" };
}

function plainPaneStatusLabel(pane: AgentPane): string {
  const status = formatPaneStatus(pane);
  if (status.kind === "success") return "done";
  if (status.kind === "error") return status.label.replace("✕ ", "");
  return "running";
}

function formatAggregateStatus(panes: AgentPane[]): string {
  const total = panes.length;
  const running = panes.filter((pane) => !pane.dead).length;
  const failed = panes.filter((pane) => formatPaneStatus(pane).kind === "error").length;
  const done = total - running - failed;

  if (failed > 0) {
    const suffix = running > 0 ? ` · ${running} running` : "";
    return `✕ ${failed} failed · ${done}/${total} done${suffix}`;
  }
  if (running > 0) return `● ${running} running · ${done}/${total} done`;
  return `✓ all ${total} done`;
}

function colorStatus(
  value: string,
  success: (s: string) => string,
  warning: (s: string) => string,
  error: (s: string) => string,
): string {
  if (value.startsWith("✕")) return error(value);
  if (value.startsWith("●")) return warning(value);
  return success(value);
}

function alignRight(left: string, right: string, width: number): string {
  if (!right) return left;
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap >= 1) return left + " ".repeat(gap) + right;

  if (visibleWidth(right) >= width) return truncateAnsi(right, width);
  const leftWidth = Math.max(1, width - visibleWidth(right) - 1);
  return truncateAnsi(left, leftWidth) + " " + right;
}

function color(theme: Theme, kind: string, value: string): string {
  try {
    return theme.fg(kind, value);
  } catch {
    return value;
  }
}

function truncateAnsi(value: string, width: number): string {
  return truncateToWidth(value, width, "…", true);
}

function padAnsi(value: string, width: number): string {
  const truncated = truncateAnsi(value, width);
  const pad = Math.max(0, width - visibleWidth(truncated));
  return truncated + " ".repeat(pad);
}

function sliceFromBottom(lines: string[], count: number, scroll: number): string[] {
  const end = Math.max(0, lines.length - scroll);
  const start = Math.max(0, end - count);
  return lines.slice(start, end);
}
