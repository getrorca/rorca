import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RorcaApiClient } from "./api.js";
import { SUPPORTED_CAPTURE_SHELLS, installManagedShellBlock, managedSourceBlock, normalizeCaptureShell, renderShellSnippet, shellStartupFile, uninstallManagedShellBlock, } from "./capture-shell.js";
import { CANONICAL_CAPTURE_POLICY_MODES, normalizeCapturePolicyMode } from "../../../../backend/src/lib/context-safety.js";
const SENTINEL = "rorca-managed: v1 | uninstall: rorca capture teardown";
const JSON_SENTINEL = { rorcaManaged: "v1", uninstall: "rorca capture teardown" };
const GIT_HOOKS = ["post-commit", "post-checkout", "post-merge", "post-rewrite", "pre-push"];
const AGENT_ADAPTER_TOOLS = ["pi", "claude-code", "codex", "opencode"];
function step(input) {
    return { ...input, nextActions: input.nextActions ?? [] };
}
function summarizeSteps(steps) {
    return {
        installed: steps.filter((item) => item.status === "installed").length,
        skipped: steps.filter((item) => item.status === "skipped").length,
        "would-install": steps.filter((item) => item.status === "would-install").length,
        degraded: steps.filter((item) => item.status === "degraded").length,
        failed: steps.filter((item) => item.status === "failed").length,
    };
}
function isWithin(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function tokenModeOk(tokenPath) {
    if (process.platform === "win32")
        return { ok: true };
    const modeNumber = statSync(tokenPath).mode & 0o777;
    return { ok: modeNumber === 0o600, mode: modeNumber.toString(8).padStart(3, "0") };
}
function readMcpToken(homeDir) {
    const tokenPath = path.join(homeDir, ".rorca", "mcp-token");
    if (!existsSync(tokenPath)) {
        return {
            step: step({
                id: "mcp-token",
                label: "MCP token",
                status: "failed",
                path: tokenPath,
                message: "Missing ~/.rorca/mcp-token.",
                nextActions: ["Start Rorca or run `rorca mcp token` to create the local public MCP token."],
            }),
        };
    }
    const mode = tokenModeOk(tokenPath);
    const token = readFileSync(tokenPath, "utf8").trim();
    if (!token) {
        return {
            step: step({
                id: "mcp-token",
                label: "MCP token",
                status: "failed",
                path: tokenPath,
                message: "MCP token file is empty.",
                nextActions: ["Run `rorca mcp rotate-token --public` or restart Rorca to regenerate the token."],
            }),
        };
    }
    if (!mode.ok) {
        return {
            token,
            step: step({
                id: "mcp-token",
                label: "MCP token",
                status: "failed",
                path: tokenPath,
                message: `MCP token file mode is ${mode.mode}, expected 600.`,
                details: { mode: mode.mode, expected: "600" },
                nextActions: ["Run `chmod 600 ~/.rorca/mcp-token` and retry `rorca capture setup --always-on`."],
            }),
        };
    }
    return {
        token,
        step: step({
            id: "mcp-token",
            label: "MCP token",
            status: "skipped",
            path: tokenPath,
            message: "MCP token exists with secure permissions.",
        }),
    };
}
async function verifyApi(client) {
    try {
        const health = await client.getHealth();
        return step({
            id: "api-reachability",
            label: "Rorca API",
            status: "skipped",
            message: `Rorca API reachable at ${client.baseUrl}.`,
            details: { version: health.version, status: health.status, mcp: health.mcp?.status },
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return step({
            id: "api-reachability",
            label: "Rorca API",
            status: "failed",
            message: `Rorca API is unreachable: ${message}`,
            nextActions: ["Start Rorca with `rorca start` and retry setup."],
        });
    }
}
async function resolveWorkspace(client, cwd, workspaceId) {
    try {
        const workspaces = await client.listWorkspaces();
        const workspace = workspaceId
            ? workspaces.find((item) => item.id === workspaceId || item.label === workspaceId)
            : workspaces.find((item) => isWithin(item.path, cwd));
        if (!workspace) {
            return {
                step: step({
                    id: "workspace-registration",
                    label: "Workspace registration",
                    status: "failed",
                    message: workspaceId
                        ? `Workspace "${workspaceId}" is not registered in Rorca.`
                        : `No registered Rorca workspace contains ${cwd}.`,
                    details: { registeredWorkspaceCount: workspaces.length },
                    nextActions: ["Register this repository in Rorca, then rerun `rorca capture setup --always-on`."],
                }),
            };
        }
        return {
            workspace,
            step: step({
                id: "workspace-registration",
                label: "Workspace registration",
                status: "skipped",
                message: `Workspace ${workspace.label || workspace.id} is registered.`,
                path: workspace.path,
                details: { workspaceId: workspace.id },
            }),
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            step: step({
                id: "workspace-registration",
                label: "Workspace registration",
                status: "failed",
                message: `Could not list Rorca workspaces: ${message}`,
                nextActions: ["Confirm the Rorca API is reachable and retry setup."],
            }),
        };
    }
}
function verifyRepoPath(workspace) {
    if (!existsSync(workspace.path)) {
        return step({
            id: "repo-path",
            label: "Repository path",
            status: "failed",
            path: workspace.path,
            message: "Registered workspace path does not exist on disk.",
            nextActions: ["Update the workspace path in Rorca or restore the repository directory."],
        });
    }
    const gitPath = path.join(workspace.path, ".git");
    if (!existsSync(gitPath)) {
        return step({
            id: "repo-path",
            label: "Repository path",
            status: "degraded",
            path: workspace.path,
            message: "Workspace path exists but no .git directory was found; git hooks cannot be installed.",
            nextActions: ["Run setup from a git repository or initialize git before enabling hook capture."],
        });
    }
    return step({
        id: "repo-path",
        label: "Repository path",
        status: "skipped",
        path: workspace.path,
        message: "Workspace path and git metadata are present.",
    });
}
function readExisting(filePath) {
    if (!existsSync(filePath))
        return null;
    return readFileSync(filePath, "utf8");
}
function installManagedFile(file, dryRun) {
    const current = readExisting(file.path);
    const exists = current != null;
    const managed = exists && (current.includes(SENTINEL) || current.includes('"rorcaManaged": "v1"'));
    if (exists && current === file.content) {
        return step({
            id: file.id,
            label: file.label,
            status: "skipped",
            path: file.path,
            message: "Managed file already installed.",
        });
    }
    if (exists && !managed) {
        return step({
            id: file.id,
            label: file.label,
            status: "degraded",
            path: file.path,
            message: "Existing non-Rorca-managed file was left untouched.",
            nextActions: [`Manually merge this integration or remove ${file.path}, then rerun setup.`],
        });
    }
    if (dryRun) {
        return step({
            id: file.id,
            label: file.label,
            status: "would-install",
            path: file.path,
            message: exists ? "Managed file would be updated." : "Managed file would be installed.",
        });
    }
    mkdirSync(path.dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, "utf8");
    if (file.executable)
        chmodSync(file.path, 0o755);
    return step({
        id: file.id,
        label: file.label,
        status: "installed",
        path: file.path,
        message: exists ? "Managed file updated." : "Managed file installed.",
    });
}
function installDirectory(id, label, dirPath, dryRun) {
    if (existsSync(dirPath)) {
        return step({ id, label, status: "skipped", path: dirPath, message: "Directory already exists." });
    }
    if (dryRun) {
        return step({ id, label, status: "would-install", path: dirPath, message: "Directory would be created." });
    }
    mkdirSync(dirPath, { recursive: true });
    return step({ id, label, status: "installed", path: dirPath, message: "Directory created." });
}
function jsonFileContent(payload) {
    return `${JSON.stringify({ ...JSON_SENTINEL, ...payload }, null, 2)}\n`;
}
function shQuote(value) {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function captureIgnoreContent() {
    return `# ${SENTINEL}\n# Paths below are ignored by always-on context capture.\nnode_modules/\ndist/\nbuild/\n.env\n.env.*\n*.pem\n*.key\n.rorca/capture/queue/\n`;
}
function redactionConfigContent() {
    return jsonFileContent({
        policyVersion: "2026-07-ucc-007",
        rawContentDefault: "metadata+hash",
        hashAlgorithm: "sha256",
        redactions: [
            { name: "environment assignments", pattern: "^[A-Z0-9_]+=." },
            { name: "private keys", pattern: "-----BEGIN .*PRIVATE KEY-----" },
            { name: "bearer tokens", pattern: "Bearer\\s+[A-Za-z0-9._~+/-]+=*" },
        ],
    });
}
function sidecarConfigContent(workspace, queuePath, policyMode) {
    return jsonFileContent({
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        queuePath,
        apiOnly: true,
        endpoint: "/api/context-capture/events",
        healthEndpoint: "/api/health",
        alwaysOn: true,
        policyMode,
        paused: false,
        serviceLifecycle: "rorca-capture service <install|start|stop|restart|status|uninstall>",
        resources: {
            scanIntervalMs: 60000,
            maxCommitsPerScan: 20,
            maxConcurrency: 4,
            queueWarnSize: 100,
            queueMaxSize: 1000,
            watchers: { mode: "polling", recursive: false, count: 0 },
        },
        sources: ["repoDaemon", "gitHook", "shellIntegration", "vscodeExtension", "mcpSlashCommand", "agentAdapters"],
        sourceMetadata: {
            repoDaemon: { source_system: "daemon", tool_name: "rorca-capture-daemon", session_id: "daemon" },
            gitHook: { source_system: "git", tool_name: "git-hook", session_id: "git" },
            shellIntegration: { source_system: "shell", tool_name: "shell", session_id: "${RORCA_CAPTURE_SESSION_ID:-shell}" },
            vscodeExtension: { source_system: "ide", tool_name: "vscode-extension", session_id: "${VSCODE_SESSION_ID:-manual}" },
        },
    });
}
function gitHookContent(hookName, workspace, queuePath, policyMode) {
    return `#!/bin/sh\n# ${SENTINEL}\n# Best-effort API-only context capture hook. Does not block git operations.\nRORCA_WORKSPACE_ID=${JSON.stringify(workspace.id)}\nRORCA_QUEUE_PATH=${JSON.stringify(queuePath)}\nRORCA_CAPTURE_POLICY=${JSON.stringify(policyMode)}\nRORCA_HOOK=${JSON.stringify(hookName)}\nmkdir -p "$RORCA_QUEUE_PATH" 2>/dev/null || true\nif [ "$RORCA_CAPTURE_POLICY" = "off" ]; then exit 0; fi\nprintf '{"source":"gitHook","workspaceId":"%s","hook":"%s","policyMode":"%s","occurredAt":"%s"}\\n' "$RORCA_WORKSPACE_ID" "$RORCA_HOOK" "$RORCA_CAPTURE_POLICY" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$RORCA_QUEUE_PATH/git-hook.ndjson" 2>/dev/null || true\nexit 0\n`;
}
function daemonServiceContent(workspace) {
    return `# ${SENTINEL}\n# Portable reference service. Use \`rorca-capture service install --workspace-id ${workspace.id} --cwd ${workspace.path}\` to render and register the native launchd/systemd file.\n[Unit]\nDescription=Rorca always-on context capture for ${workspace.id}\n\n[Service]\nType=simple\nWorkingDirectory=${workspace.path}\nExecStart=rorca-capture daemon --workspace-id ${workspace.id} --cwd ${workspace.path} --scan-interval-ms 60000 --max-commits-per-scan 20 --max-concurrency 4 --queue-warn-size 100 --queue-max-size 1000\nRestart=on-failure\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n`;
}
function shellSnippetFile(captureDir, shell) {
    const extension = shell === "fish" ? "fish" : shell === "powershell" ? "ps1" : "sh";
    return path.join(captureDir, "shell", `rorca-capture.${shell}.${extension}`);
}
function ideAdapterContent(workspace) {
    return jsonFileContent({
        workspaceId: workspace.id,
        adapter: "vscode-compatible",
        apiOnly: true,
        metadata: { source_system: "ide", tool_name: "vscode-extension", session_id: "${VSCODE_SESSION_ID:-manual}" },
        capture: { files: "explicit-or-save-events", diagnostics: true, chatPanels: "explicit-export-only" },
    });
}
function mcpSlashConfigContent(workspace) {
    return jsonFileContent({
        workspaceId: workspace.id,
        mcpServer: "http://127.0.0.1:3030/mcp",
        commands: ["/rorca-save-memory", "/rorca-capture-context", "/rorca-remember"],
        tokenFile: "~/.rorca/mcp-token",
        tokenPolicy: "read token at runtime only; never embed bearer values in command/config artifacts",
    });
}
function adapterSourceSystem(tool) {
    if (tool === "claude-code")
        return "claude_code";
    return tool;
}
function adapterSessionExpression(tool) {
    if (tool === "claude-code")
        return "${CLAUDE_SESSION_ID:-manual}";
    if (tool === "codex")
        return "${CODEX_SESSION_ID:-manual}";
    if (tool === "opencode")
        return "${OPENCODE_SESSION_ID:-manual}";
    return "${PI_SESSION_ID:-manual}";
}
function rememberCommand(tool, workspace, message = "<summary-or-decision>") {
    return `rorca-capture remember --workspace-id ${shQuote(workspace.id)} --source-system ${shQuote(adapterSourceSystem(tool))} --tool-name ${shQuote(tool)} --session-id ${shQuote(adapterSessionExpression(tool))} --message ${shQuote(message)}`;
}
export function renderAgentAdapterConfig(tool, workspace, apiBaseUrl = "http://127.0.0.1:3030") {
    const sourceSystem = adapterSourceSystem(tool);
    const base = {
        workspaceId: workspace.id,
        apiBaseUrl,
        endpoint: "/api/context-capture/events",
        tokenFile: "~/.rorca/mcp-token",
        tokenPolicy: "token path only; bearer/API key values must never be written to this artifact",
        metadata: { source_system: sourceSystem, tool_name: tool, session_id: adapterSessionExpression(tool) },
        rememberCommand: rememberCommand(tool, workspace),
    };
    if (tool === "claude-code") {
        return jsonFileContent({
            adapter: "claude-code",
            ...base,
            mcp: { serverUrl: `${apiBaseUrl.replace(/\/$/, "")}/mcp`, auth: { type: "bearer-token-file", tokenFile: "~/.rorca/mcp-token" } },
            slashCommands: [
                { name: "/rorca-remember", description: "Send an explicit summary or decision to Rorca capture.", command: rememberCommand(tool, workspace, "$ARGUMENTS") },
                { name: "/rorca-capture-context", description: "Submit a context-event summary without embedding credentials.", command: rememberCommand(tool, workspace, "$ARGUMENTS") },
            ],
        });
    }
    if (tool === "pi") {
        return jsonFileContent({
            adapter: "pi",
            ...base,
            pi: {
                commandAlias: "/rorca-remember",
                skillAlias: "/skill:rorca-capture",
                route: "rorca-capture remember or public /api/context-capture/events",
                replacesLegacyDirectDbWrites: true,
            },
        });
    }
    return jsonFileContent({
        adapter: tool,
        ...base,
        wrapper: `./rorca-${tool}-wrapper.sh`,
        fallback: "If the native tool binary is missing or has no hook API, use shell capture plus the explicit rememberCommand above.",
        behavior: "passes arguments through unchanged and exits with the native tool exit code",
    });
}
export function renderAgentWrapperScript(tool, workspace, captureCommand = "rorca-capture") {
    const binary = tool;
    const envName = tool === "codex" ? "RORCA_CODEX_BIN" : "RORCA_OPENCODE_BIN";
    const sourceSystem = adapterSourceSystem(tool);
    const commandPreview = tool === "codex" ? "codex exec --dangerously-bypass-approvals-and-sandbox -m <model>" : "opencode run";
    return `#!/bin/sh\n# ${SENTINEL}\n# Thin Rorca ${tool} adapter. It does not read provider credentials or mutate provider config.\nset +e\nTOOL_BIN=\"${`$`}{${envName}:-}\"\nif [ -z \"$TOOL_BIN\" ]; then\n  TOOL_BIN=\"$(command -v ${binary} 2>/dev/null)\"\nfi\nif [ -z \"$TOOL_BIN\" ] || [ ! -x \"$TOOL_BIN\" ]; then\n  echo \"Rorca ${tool} adapter: ${binary} binary not found; fallback to shell capture and explicit remember: ${rememberCommand(tool, workspace)}\" >&2\n  exit 127\nfi\nSESSION_ID=\"${`$`}{${tool === "codex" ? "CODEX_SESSION_ID" : "OPENCODE_SESSION_ID"}:-manual}\"\n${captureCommand} emit shell --phase start --workspace-id ${shQuote(workspace.id)} --cwd \"$PWD\" --command ${shQuote(`${commandPreview} $*`)} --policy command-summary >/dev/null 2>&1 || true\n\"$TOOL_BIN\" \"$@\"\nCODE=$?\n${captureCommand} emit shell --phase end --workspace-id ${shQuote(workspace.id)} --cwd \"$PWD\" --command ${shQuote(`${commandPreview} $*`)} --exit-code \"$CODE\" --duration-ms 0 --policy command-summary >/dev/null 2>&1 || true\n${captureCommand} remember --workspace-id ${shQuote(workspace.id)} --source-system ${shQuote(sourceSystem)} --tool-name ${shQuote(tool)} --session-id \"$SESSION_ID\" --message \"${tool} session ended with exit code $CODE\" >/dev/null 2>&1 || true\nexit \"$CODE\"\n`;
}
function agentAdapterFiles(workspace, captureDir, apiBaseUrl) {
    return [
        { id: "agent-adapter:pi", label: "Pi capture command alias", path: path.join(workspace.path, ".pi", "extensions", "rorca", "capture-command.json"), content: renderAgentAdapterConfig("pi", workspace, apiBaseUrl) },
        { id: "agent-adapter:claude-code", label: "Claude Code slash/MCP adapter", path: path.join(captureDir, "adapters", "claude-code", "slash-commands.json"), content: renderAgentAdapterConfig("claude-code", workspace, apiBaseUrl) },
        { id: "agent-adapter:codex-config", label: "Codex capture adapter config", path: path.join(captureDir, "adapters", "codex", "adapter.json"), content: renderAgentAdapterConfig("codex", workspace, apiBaseUrl) },
        { id: "agent-adapter:codex-wrapper", label: "Codex pass-through wrapper", path: path.join(captureDir, "adapters", "codex", "rorca-codex-wrapper.sh"), content: renderAgentWrapperScript("codex", workspace), executable: true },
        { id: "agent-adapter:opencode-config", label: "OpenCode capture adapter config", path: path.join(captureDir, "adapters", "opencode", "adapter.json"), content: renderAgentAdapterConfig("opencode", workspace, apiBaseUrl) },
        { id: "agent-adapter:opencode-wrapper", label: "OpenCode pass-through wrapper", path: path.join(captureDir, "adapters", "opencode", "rorca-opencode-wrapper.sh"), content: renderAgentWrapperScript("opencode", workspace), executable: true },
    ];
}
function installAgentAdapters(workspace, captureDir, apiBaseUrl, env, dryRun) {
    const steps = agentAdapterFiles(workspace, captureDir, apiBaseUrl).map((file) => installManagedFile(file, dryRun));
    for (const tool of ["codex", "opencode"]) {
        const envName = tool === "codex" ? "RORCA_CODEX_BIN" : "RORCA_OPENCODE_BIN";
        const configured = env[envName];
        const available = configured ? existsSync(configured) : spawnSync(process.platform === "win32" ? "where" : "which", [tool], { stdio: "ignore", env }).status === 0;
        if (!available) {
            steps.push(step({
                id: `agent-adapter:${tool}:fallback`,
                label: `${tool} adapter fallback`,
                status: "degraded",
                message: `${tool} binary was not found; generated wrapper will exit 127 and setup falls back to shell capture plus explicit remember commands.`,
                details: { tool, fallbackCommand: rememberCommand(tool, workspace), source_system: adapterSourceSystem(tool), tool_name: tool, session_id: adapterSessionExpression(tool) },
                nextActions: [`Install ${tool} or set ${envName} to the native binary path before using the wrapper.`],
            }));
        }
    }
    return steps;
}
function uninstallMetadataContent(workspace, artifactPaths) {
    return jsonFileContent({
        workspaceId: workspace.id,
        command: "rorca capture teardown",
        removes: artifactPaths,
        note: "Only files carrying the rorca-managed sentinel should be removed automatically.",
    });
}
function installGitHooks(workspace, queuePath, dryRun, policyMode) {
    const hooksDir = path.join(workspace.path, ".git", "hooks");
    if (!existsSync(path.join(workspace.path, ".git"))) {
        return [step({
                id: "git-hooks",
                label: "Git hooks",
                status: "degraded",
                path: hooksDir,
                message: "Git metadata unavailable; hooks were not installed.",
                nextActions: ["Initialize git or run setup from a git-backed workspace."],
            })];
    }
    return GIT_HOOKS.map((hookName) => installManagedFile({
        id: `git-hook:${hookName}`,
        label: `Git hook ${hookName}`,
        path: path.join(hooksDir, hookName),
        content: gitHookContent(hookName, workspace, queuePath, policyMode),
        executable: true,
    }, dryRun));
}
function installShellSnippets(workspace, captureDir, homeDir, env, dryRun, apiBaseUrl, policyMode) {
    const detectedShell = normalizeCaptureShell(env.SHELL || env.ComSpec || env.PSModulePath);
    const steps = [];
    for (const shell of SUPPORTED_CAPTURE_SHELLS) {
        const snippetPath = shellSnippetFile(captureDir, shell);
        steps.push(installManagedFile({
            id: `shell-snippet:${shell}`,
            label: `Shell snippet (${shell})`,
            path: snippetPath,
            content: renderShellSnippet(shell, { workspace, apiBaseUrl, policyMode: policyMode }),
        }, dryRun));
    }
    if (!detectedShell) {
        steps.push(step({
            id: "shell-startup-block",
            label: "Shell startup block",
            status: "degraded",
            message: "Could not detect a supported interactive shell; snippet files were generated without editing shell startup files.",
            details: { supportedShells: SUPPORTED_CAPTURE_SHELLS },
            nextActions: ["Manually source the generated snippet for zsh, bash, fish, or PowerShell if desired."],
        }));
        return steps;
    }
    const snippetPath = shellSnippetFile(captureDir, detectedShell);
    const startupFile = shellStartupFile(detectedShell, homeDir);
    const status = installManagedShellBlock(startupFile, managedSourceBlock(detectedShell, snippetPath), dryRun);
    steps.push(step({
        id: `shell-startup-block:${detectedShell}`,
        label: `Shell startup block (${detectedShell})`,
        status: status === "installed" ? "installed" : status === "would-install" ? "would-install" : "skipped",
        path: startupFile,
        message: status === "skipped" ? "Managed shell startup block already installed." : status === "would-install" ? "Managed shell startup block would be installed." : "Managed shell startup block installed with clear sentinels.",
        details: { shell: detectedShell, snippetPath, sentinels: ["# >>> rorca-capture always-on (managed) >>>", "# <<< rorca-capture always-on (managed) <<<"] },
        nextActions: ["Restart your shell or source the updated shell startup file to enable command metadata capture.", "Run `rorca-capture setup --uninstall` to remove only the managed sentinel blocks."],
    }));
    return steps;
}
function detectIde(workspace) {
    if (existsSync(path.join(workspace.path, ".vscode")))
        return { available: true };
    const codeCheck = spawnSync(process.platform === "win32" ? "where" : "which", ["code"], { stdio: "ignore" });
    if (codeCheck.status === 0)
        return { available: true };
    return { available: false, reason: "vscode_extension_host_unavailable" };
}
function installIdeAdapter(workspace, dryRun) {
    const ide = detectIde(workspace);
    if (!ide.available) {
        return step({
            id: "ide-adapter",
            label: "IDE adapter",
            status: "degraded",
            path: path.join(workspace.path, ".vscode", "rorca-capture-adapter.json"),
            message: "No VS Code-compatible extension host was detected; shell/git/daemon capture can still run.",
            details: { reason: ide.reason, fallbackSources: ["repoDaemon", "gitHook", "shellIntegration", "mcpSlashCommand"] },
            nextActions: ["Install a VS Code-compatible Rorca adapter later, or rely on git/shell/daemon capture."],
        });
    }
    return installManagedFile({
        id: "ide-adapter",
        label: "IDE adapter",
        path: path.join(workspace.path, ".vscode", "rorca-capture-adapter.json"),
        content: ideAdapterContent(workspace),
    }, dryRun);
}
async function backendVerify(client, workspace, paths, policyMode) {
    if (!client.verifyCaptureBootstrap) {
        return step({
            id: "backend-assisted-onboarding",
            label: "Backend-assisted onboarding",
            status: "degraded",
            message: "API client does not expose bootstrap verification; local checks were used.",
            nextActions: ["Upgrade Rorca and rerun setup to enable backend-assisted verification."],
        });
    }
    try {
        await client.verifyCaptureBootstrap({
            workspaceId: workspace.id,
            workspacePath: workspace.path,
            queuePath: paths.queuePath,
            redactionConfigPath: paths.redactionConfigPath,
            captureIgnorePath: paths.captureIgnorePath,
            policyMode,
        });
        return step({
            id: "backend-assisted-onboarding",
            label: "Backend-assisted onboarding",
            status: "skipped",
            message: "Backend verified workspace registration and capture bootstrap paths.",
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return step({
            id: "backend-assisted-onboarding",
            label: "Backend-assisted onboarding",
            status: "failed",
            message: `Backend bootstrap verification failed: ${message}`,
            nextActions: ["Fix the backend-reported issue, then rerun setup."],
        });
    }
}
export async function runCaptureBootstrap(options) {
    const dryRun = Boolean(options.dryRun);
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const homeDir = options.homeDir ?? os.homedir();
    const env = options.env ?? process.env;
    const token = readMcpToken(homeDir);
    const client = options.apiClient ?? new RorcaApiClient(options.apiBaseUrl, token.token ? { headers: { Authorization: `Bearer ${token.token}` } } : undefined);
    const steps = [token.step];
    if (!options.alwaysOn) {
        steps.push(step({
            id: "always-on-flag",
            label: "Always-on flag",
            status: "failed",
            message: "Setup requires --always-on to avoid surprise capture configuration.",
            nextActions: ["Rerun as `rorca capture setup --always-on --policy <off|metadata-only|repo-and-command|ide-assisted|full>` after reviewing what will be installed."],
        }));
        return buildReport({ dryRun, alwaysOn: false, apiBaseUrl: client.baseUrl, steps });
    }
    if (!options.policyMode || !CANONICAL_CAPTURE_POLICY_MODES.includes(String(options.policyMode))) {
        steps.push(step({
            id: "capture-policy-choice",
            label: "Capture policy choice",
            status: "failed",
            message: "Setup requires an explicit --policy choice: off, metadata-only, repo-and-command, ide-assisted, or full. No transcript capture is enabled by default.",
            nextActions: ["Rerun setup with `--policy metadata-only` (safest useful default) or another explicit policy."],
        }));
        return buildReport({ dryRun, alwaysOn: true, apiBaseUrl: client.baseUrl, steps });
    }
    const policyMode = normalizeCapturePolicyMode(options.policyMode, 'off');
    steps.push(step({
        id: "capture-policy-choice",
        label: "Capture policy choice",
        status: "skipped",
        message: `Explicit capture policy selected: ${policyMode}.`,
        details: { availablePolicies: CANONICAL_CAPTURE_POLICY_MODES },
    }));
    steps.push(await verifyApi(client));
    const resolved = await resolveWorkspace(client, cwd, options.workspaceId);
    steps.push(resolved.step);
    if (!resolved.workspace) {
        return buildReport({ dryRun, alwaysOn: true, apiBaseUrl: client.baseUrl, steps });
    }
    const workspace = resolved.workspace;
    steps.push(verifyRepoPath(workspace));
    const captureDir = path.join(workspace.path, ".rorca", "capture");
    const queuePath = path.join(captureDir, "queue");
    const redactionConfigPath = path.join(captureDir, "redaction.json");
    const captureIgnorePath = path.join(workspace.path, ".rorca-captureignore");
    const sidecarConfigPath = path.join(captureDir, "sidecar.json");
    const daemonPath = path.join(captureDir, "daemon", "rorca-capture.service");
    const mcpSlashPath = path.join(captureDir, "mcp", "slash-commands.json");
    const uninstallPath = path.join(captureDir, "uninstall.json");
    steps.push(await backendVerify(client, workspace, { queuePath, redactionConfigPath, captureIgnorePath }, policyMode));
    const blockingFailure = steps.some((item) => item.status === "failed" && ["mcp-token", "api-reachability", "workspace-registration", "backend-assisted-onboarding"].includes(item.id));
    if (blockingFailure) {
        return buildReport({ dryRun, alwaysOn: true, apiBaseUrl: client.baseUrl, workspace, steps });
    }
    steps.push(installDirectory("queue-path", "Capture queue", queuePath, dryRun));
    steps.push(installManagedFile({ id: "redaction-config", label: "Redaction config", path: redactionConfigPath, content: redactionConfigContent() }, dryRun));
    steps.push(installManagedFile({ id: "capture-ignore", label: ".rorca-captureignore", path: captureIgnorePath, content: captureIgnoreContent() }, dryRun));
    if (client.configureCapturePolicy && !dryRun) {
        try {
            await client.configureCapturePolicy({
                workspaceId: workspace.id,
                policyMode,
                ignoredPaths: captureIgnoreContent().split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')),
                activeIntegrations: { repoDaemon: true, gitHook: true, shellIntegration: true, vscodeExtension: true, agentAdapters: true, mcpSlashCommand: true },
            });
            steps.push(step({ id: "capture-policy-persisted", label: "Capture policy", status: "installed", message: "Explicit capture policy persisted to local operator settings." }));
        }
        catch (error) {
            steps.push(step({ id: "capture-policy-persisted", label: "Capture policy", status: "failed", message: `Could not persist capture policy: ${error instanceof Error ? error.message : String(error)}` }));
        }
    }
    else if (dryRun) {
        steps.push(step({ id: "capture-policy-persisted", label: "Capture policy", status: "would-install", message: "Explicit capture policy would be persisted to local operator settings." }));
    }
    steps.push(installManagedFile({ id: "sidecar-config", label: "Sidecar config", path: sidecarConfigPath, content: sidecarConfigContent(workspace, queuePath, policyMode) }, dryRun));
    steps.push(...installGitHooks(workspace, queuePath, dryRun, policyMode));
    steps.push(installManagedFile({ id: "daemon-service", label: "Daemon/service file", path: daemonPath, content: daemonServiceContent(workspace) }, dryRun));
    steps.push(...installShellSnippets(workspace, captureDir, homeDir, env, dryRun, client.baseUrl, policyMode));
    steps.push(installIdeAdapter(workspace, dryRun));
    steps.push(installManagedFile({ id: "mcp-slash-config", label: "MCP/slash-command config", path: mcpSlashPath, content: mcpSlashConfigContent(workspace) }, dryRun));
    steps.push(...installAgentAdapters(workspace, captureDir, client.baseUrl, env, dryRun));
    const artifactPaths = [
        queuePath,
        redactionConfigPath,
        captureIgnorePath,
        sidecarConfigPath,
        path.join(captureDir, "service.pid"),
        path.join(captureDir, "state.json"),
        path.join(captureDir, "status.json"),
        path.join(captureDir, "service.log"),
        ...GIT_HOOKS.map((hook) => path.join(workspace.path, ".git", "hooks", hook)),
        daemonPath,
        ...SUPPORTED_CAPTURE_SHELLS.map((shell) => shellSnippetFile(captureDir, shell)),
        path.join(workspace.path, ".vscode", "rorca-capture-adapter.json"),
        mcpSlashPath,
        ...agentAdapterFiles(workspace, captureDir, client.baseUrl).map((file) => file.path),
        uninstallPath,
    ];
    steps.push(installManagedFile({ id: "uninstall-metadata", label: "Uninstall metadata", path: uninstallPath, content: uninstallMetadataContent(workspace, artifactPaths) }, dryRun));
    return buildReport({ dryRun, alwaysOn: true, apiBaseUrl: client.baseUrl, workspace, steps });
}
function findTeardownWorkspaceRoot(cwd) {
    let current = path.resolve(cwd);
    for (;;) {
        if (existsSync(path.join(current, ".rorca", "capture", "uninstall.json")))
            return current;
        if (existsSync(path.join(current, ".rorca-captureignore")) && existsSync(path.join(current, ".rorca", "capture")))
            return current;
        const parent = path.dirname(current);
        if (parent === current)
            return path.resolve(cwd);
        current = parent;
    }
}
function readUninstallArtifactPaths(workspaceRoot) {
    const uninstallPath = path.join(workspaceRoot, ".rorca", "capture", "uninstall.json");
    if (!existsSync(uninstallPath)) {
        return {
            uninstallPath,
            artifactPaths: [],
            step: step({
                id: "uninstall-metadata",
                label: "Uninstall metadata",
                status: "degraded",
                path: uninstallPath,
                message: "No uninstall metadata found; teardown will only remove managed shell startup blocks.",
                nextActions: ["Run `rorca capture setup --always-on` first, or remove older capture artifacts manually after checking sentinels."],
            }),
        };
    }
    try {
        const parsed = JSON.parse(readFileSync(uninstallPath, "utf8"));
        if (parsed.rorcaManaged !== "v1" || !Array.isArray(parsed.removes)) {
            throw new Error("uninstall metadata is not a Rorca-managed v1 removes list");
        }
        const artifactPaths = parsed.removes.filter((item) => typeof item === "string" && item.trim().length > 0);
        return { uninstallPath, artifactPaths };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            uninstallPath,
            artifactPaths: [],
            step: step({
                id: "uninstall-metadata",
                label: "Uninstall metadata",
                status: "failed",
                path: uninstallPath,
                message: `Could not parse uninstall metadata: ${message}`,
                nextActions: ["Inspect .rorca/capture/uninstall.json before removing capture artifacts manually."],
            }),
        };
    }
}
function contentHasManagedSentinel(filePath) {
    const content = readFileSync(filePath, "utf8");
    return content.includes(SENTINEL) || content.includes('"rorcaManaged": "v1"');
}
function isCaptureRuntimeArtifact(workspaceRoot, filePath) {
    const captureDir = path.join(workspaceRoot, ".rorca", "capture");
    const relative = path.relative(captureDir, filePath);
    return !relative.startsWith("..") && !path.isAbsolute(relative) && ["service.pid", "state.json", "status.json", "service.log"].includes(relative);
}
function teardownManagedArtifact(workspaceRoot, artifactPath, uninstallPath, dryRun, removeAll = false) {
    const resolvedPath = path.resolve(artifactPath);
    if (!isWithin(workspaceRoot, resolvedPath)) {
        return step({
            id: "managed-artifact",
            label: "Managed artifact",
            status: "degraded",
            path: resolvedPath,
            message: "Artifact path is outside the workspace and was left untouched.",
            nextActions: ["Inspect uninstall metadata for unexpected paths before removing anything manually."],
        });
    }
    if (!existsSync(resolvedPath)) {
        return step({ id: "managed-artifact", label: "Managed artifact", status: "skipped", path: resolvedPath, message: "Artifact already absent." });
    }
    const stat = statSync(resolvedPath);
    if (stat.isDirectory()) {
        try {
            const names = readdirSync(resolvedPath);
            if (names.length > 0 && !removeAll) {
                return step({
                    id: "managed-artifact",
                    label: "Managed artifact directory",
                    status: "degraded",
                    path: resolvedPath,
                    message: "Managed directory is not empty and was left in place to avoid deleting queued capture data.",
                    nextActions: [`Review ${resolvedPath} and remove it manually if no queued events are needed, or rerun with uninstall --all.`],
                });
            }
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return step({ id: "managed-artifact", label: "Managed artifact directory", status: "failed", path: resolvedPath, message: `Could not inspect directory: ${message}` });
        }
        if (dryRun)
            return step({ id: "managed-artifact", label: "Managed artifact directory", status: "would-install", path: resolvedPath, message: removeAll ? "Managed directory and queued events would be removed." : "Empty managed directory would be removed." });
        rmSync(resolvedPath, { recursive: true, force: true });
        return step({ id: "managed-artifact", label: "Managed artifact directory", status: "installed", path: resolvedPath, message: "Empty managed directory removed." });
    }
    if (!contentHasManagedSentinel(resolvedPath)) {
        if (!removeAll || !isCaptureRuntimeArtifact(workspaceRoot, resolvedPath)) {
            return step({
                id: "managed-artifact",
                label: "Managed artifact",
                status: "degraded",
                path: resolvedPath,
                message: "File does not carry a Rorca-managed sentinel and was left untouched.",
                nextActions: [`Manually inspect ${resolvedPath} before removing it.`],
            });
        }
        if (dryRun)
            return step({ id: "managed-artifact", label: "Managed runtime artifact", status: "would-install", path: resolvedPath, message: "Runtime capture state would be removed by uninstall --all." });
        rmSync(resolvedPath, { force: true });
        return step({ id: "managed-artifact", label: "Managed runtime artifact", status: "installed", path: resolvedPath, message: "Runtime capture state removed by uninstall --all." });
    }
    if (dryRun)
        return step({ id: "managed-artifact", label: "Managed artifact", status: "would-install", path: resolvedPath, message: resolvedPath === uninstallPath ? "Uninstall metadata would be removed last." : "Managed artifact would be removed." });
    rmSync(resolvedPath, { force: true });
    return step({ id: "managed-artifact", label: "Managed artifact", status: "installed", path: resolvedPath, message: resolvedPath === uninstallPath ? "Uninstall metadata removed last." : "Managed artifact removed." });
}
export function runCaptureTeardown(options = {}) {
    const dryRun = Boolean(options.dryRun);
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const workspaceRoot = findTeardownWorkspaceRoot(cwd);
    const homeDir = options.homeDir ?? os.homedir();
    const env = options.env ?? process.env;
    const detected = normalizeCaptureShell(env.SHELL || env.ComSpec || env.PSModulePath);
    const shells = options.shells ?? (detected ? [detected] : SUPPORTED_CAPTURE_SHELLS);
    const steps = [];
    for (const shell of shells) {
        const startupFile = shellStartupFile(shell, homeDir);
        const status = uninstallManagedShellBlock(startupFile, dryRun);
        steps.push(step({
            id: `shell-startup-block:${shell}`,
            label: `Shell startup block (${shell})`,
            status: status === "removed" ? "installed" : status === "would-remove" ? "would-install" : "skipped",
            path: startupFile,
            message: status === "skipped" ? "No managed shell startup block found." : status === "would-remove" ? "Managed shell startup block would be removed." : "Managed shell startup block removed.",
        }));
    }
    const metadata = readUninstallArtifactPaths(workspaceRoot);
    if (metadata.step)
        steps.push(metadata.step);
    const runtimeArtifactPaths = options.all
        ? ["service.pid", "state.json", "status.json", "service.log"].map((fileName) => path.join(workspaceRoot, ".rorca", "capture", fileName))
        : [];
    const orderedArtifactPaths = Array.from(new Set([...metadata.artifactPaths, ...runtimeArtifactPaths]))
        .map((item) => path.resolve(item))
        .filter((item) => item !== workspaceRoot)
        .sort((left, right) => {
        if (left === metadata.uninstallPath)
            return 1;
        if (right === metadata.uninstallPath)
            return -1;
        return right.length - left.length;
    });
    for (const artifactPath of orderedArtifactPaths) {
        steps.push(teardownManagedArtifact(workspaceRoot, artifactPath, metadata.uninstallPath, dryRun, Boolean(options.all)));
    }
    return { ok: steps.every((item) => item.status !== "failed"), dryRun, steps };
}
function buildReport(input) {
    const summary = summarizeSteps(input.steps);
    const failed = input.steps.filter((item) => item.status === "failed");
    const degraded = input.steps.filter((item) => item.status === "degraded");
    const installed = input.steps.filter((item) => item.status === "installed");
    const skipped = input.steps.filter((item) => item.status === "skipped");
    const wouldInstall = input.steps.filter((item) => item.status === "would-install");
    const status = failed.length > 0
        ? "failed"
        : input.dryRun
            ? "dry-run"
            : degraded.length > 0
                ? "degraded"
                : "ok";
    const nextActions = Array.from(new Set(input.steps.flatMap((item) => item.nextActions)));
    if (input.dryRun && failed.length === 0) {
        nextActions.push("Rerun without --dry-run to install the reversible always-on capture components.");
    }
    if (!input.dryRun && failed.length === 0) {
        nextActions.push("Review generated files, then enable the daemon/service manually if desired.");
        nextActions.push("Run `rorca capture teardown` to remove managed capture artifacts.");
    }
    return {
        ok: failed.length === 0,
        dryRun: input.dryRun,
        alwaysOn: input.alwaysOn,
        status,
        generatedAt: new Date().toISOString(),
        workspace: input.workspace,
        apiBaseUrl: input.apiBaseUrl,
        summary,
        installed,
        skipped,
        wouldInstall,
        degraded,
        failed,
        steps: input.steps,
        nextActions,
    };
}
export function formatCaptureBootstrapHumanReport(report) {
    const lines = [];
    lines.push(`Rorca always-on capture setup: ${report.status}`);
    if (report.workspace) {
        lines.push(`Workspace: ${report.workspace.label || report.workspace.id} (${report.workspace.path})`);
    }
    lines.push(`API: ${report.apiBaseUrl}`);
    lines.push(`Summary: installed=${report.summary.installed}, skipped=${report.summary.skipped}, would-install=${report.summary["would-install"]}, degraded=${report.summary.degraded}, failed=${report.summary.failed}`);
    lines.push("");
    for (const item of report.steps) {
        const pathPart = item.path ? ` [${item.path}]` : "";
        lines.push(`- ${item.status.toUpperCase()} ${item.label}${pathPart}: ${item.message}`);
    }
    if (report.nextActions.length > 0) {
        lines.push("");
        lines.push("Next actions:");
        for (const action of report.nextActions)
            lines.push(`- ${action}`);
    }
    return lines.join("\n");
}
