import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RorcaApiClient } from "./api.js";
const SENTINEL = "rorca-managed: v1 | uninstall: rorca capture teardown";
const JSON_SENTINEL = { rorcaManaged: "v1", uninstall: "rorca capture teardown" };
const GIT_HOOKS = ["post-commit", "post-checkout", "post-merge", "post-rewrite", "pre-push"];
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
function captureIgnoreContent() {
    return `# ${SENTINEL}\n# Paths below are ignored by always-on context capture.\nnode_modules/\ndist/\nbuild/\n.env\n.env.*\n*.pem\n*.key\n.rorca/capture/queue/\n`;
}
function redactionConfigContent() {
    return jsonFileContent({
        policyVersion: "2026-07-ucc-002",
        rawContentDefault: "off",
        hashAlgorithm: "sha256",
        redactions: [
            { name: "environment assignments", pattern: "^[A-Z0-9_]+=." },
            { name: "private keys", pattern: "-----BEGIN .*PRIVATE KEY-----" },
            { name: "bearer tokens", pattern: "Bearer\\s+[A-Za-z0-9._~+/-]+=*" },
        ],
    });
}
function sidecarConfigContent(workspace, queuePath) {
    return jsonFileContent({
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        queuePath,
        apiOnly: true,
        endpoint: "/api/context-capture/events",
        alwaysOn: true,
        sources: ["repoDaemon", "gitHook", "shellIntegration", "vscodeExtension", "mcpSlashCommand"],
    });
}
function gitHookContent(hookName, workspace, queuePath) {
    return `#!/bin/sh\n# ${SENTINEL}\n# Best-effort API-only context capture hook. Does not block git operations.\nRORCA_WORKSPACE_ID=${JSON.stringify(workspace.id)}\nRORCA_QUEUE_PATH=${JSON.stringify(queuePath)}\nRORCA_HOOK=${JSON.stringify(hookName)}\nmkdir -p "$RORCA_QUEUE_PATH" 2>/dev/null || true\nprintf '{"source":"gitHook","workspaceId":"%s","hook":"%s","occurredAt":"%s"}\\n' "$RORCA_WORKSPACE_ID" "$RORCA_HOOK" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$RORCA_QUEUE_PATH/git-hook.ndjson" 2>/dev/null || true\nexit 0\n`;
}
function daemonServiceContent(workspace) {
    return `# ${SENTINEL}\n# Install manually after review. This file is intentionally not loaded by package postinstall.\n[Unit]\nDescription=Rorca always-on context capture for ${workspace.id}\n\n[Service]\nType=simple\nWorkingDirectory=${workspace.path}\nExecStart=rorca-capture daemon --workspace-id ${workspace.id}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`;
}
function shellSnippetContent(workspace) {
    return `# ${SENTINEL}\n# Source this file from your shell only if you want command metadata capture.\nexport RORCA_CAPTURE_WORKSPACE_ID=${JSON.stringify(workspace.id)}\nexport RORCA_CAPTURE_WORKSPACE_PATH=${JSON.stringify(workspace.path)}\nrorca_capture_command_finished() {\n  local exit_code="$?"\n  command rorca-capture emit shell --workspace-id "$RORCA_CAPTURE_WORKSPACE_ID" --cwd "$PWD" --exit-code "$exit_code" >/dev/null 2>&1 || true\n  return "$exit_code"\n}\n`;
}
function ideAdapterContent(workspace) {
    return jsonFileContent({
        workspaceId: workspace.id,
        adapter: "vscode-compatible",
        apiOnly: true,
        capture: { files: "explicit-or-save-events", diagnostics: true, chatPanels: "explicit-export-only" },
    });
}
function mcpSlashConfigContent(workspace) {
    return jsonFileContent({
        workspaceId: workspace.id,
        mcpServer: "http://127.0.0.1:3030/mcp",
        commands: ["/rorca-save-memory", "/rorca-capture-context"],
        tokenFile: "~/.rorca/mcp-token",
    });
}
function uninstallMetadataContent(workspace, artifactPaths) {
    return jsonFileContent({
        workspaceId: workspace.id,
        command: "rorca capture teardown",
        removes: artifactPaths,
        note: "Only files carrying the rorca-managed sentinel should be removed automatically.",
    });
}
function installGitHooks(workspace, queuePath, dryRun) {
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
        content: gitHookContent(hookName, workspace, queuePath),
        executable: true,
    }, dryRun));
}
function installShellSnippet(workspace, captureDir, env, dryRun) {
    const shell = env.SHELL ? path.basename(env.SHELL) : "unknown";
    const snippetPath = path.join(captureDir, "shell", "rorca-capture.sh");
    const installed = installManagedFile({
        id: "shell-snippet",
        label: "Shell snippet",
        path: snippetPath,
        content: shellSnippetContent(workspace),
    }, dryRun);
    return {
        ...installed,
        details: { shell },
        nextActions: shell === "unknown"
            ? ["Set SHELL or manually source the generated snippet from your preferred shell config."]
            : [`Review the snippet, then source ${snippetPath} from your ${shell} config if desired.`],
    };
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
async function backendVerify(client, workspace, paths) {
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
            nextActions: ["Rerun as `rorca capture setup --always-on` after reviewing what will be installed."],
        }));
        return buildReport({ dryRun, alwaysOn: false, apiBaseUrl: client.baseUrl, steps });
    }
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
    steps.push(await backendVerify(client, workspace, { queuePath, redactionConfigPath, captureIgnorePath }));
    const blockingFailure = steps.some((item) => item.status === "failed" && ["mcp-token", "api-reachability", "workspace-registration", "backend-assisted-onboarding"].includes(item.id));
    if (blockingFailure) {
        return buildReport({ dryRun, alwaysOn: true, apiBaseUrl: client.baseUrl, workspace, steps });
    }
    steps.push(installDirectory("queue-path", "Capture queue", queuePath, dryRun));
    steps.push(installManagedFile({ id: "redaction-config", label: "Redaction config", path: redactionConfigPath, content: redactionConfigContent() }, dryRun));
    steps.push(installManagedFile({ id: "capture-ignore", label: ".rorca-captureignore", path: captureIgnorePath, content: captureIgnoreContent() }, dryRun));
    steps.push(installManagedFile({ id: "sidecar-config", label: "Sidecar config", path: sidecarConfigPath, content: sidecarConfigContent(workspace, queuePath) }, dryRun));
    steps.push(...installGitHooks(workspace, queuePath, dryRun));
    steps.push(installManagedFile({ id: "daemon-service", label: "Daemon/service file", path: daemonPath, content: daemonServiceContent(workspace) }, dryRun));
    steps.push(installShellSnippet(workspace, captureDir, env, dryRun));
    steps.push(installIdeAdapter(workspace, dryRun));
    steps.push(installManagedFile({ id: "mcp-slash-config", label: "MCP/slash-command config", path: mcpSlashPath, content: mcpSlashConfigContent(workspace) }, dryRun));
    const artifactPaths = [
        queuePath,
        redactionConfigPath,
        captureIgnorePath,
        sidecarConfigPath,
        ...GIT_HOOKS.map((hook) => path.join(workspace.path, ".git", "hooks", hook)),
        daemonPath,
        path.join(captureDir, "shell"),
        path.join(workspace.path, ".vscode", "rorca-capture-adapter.json"),
        mcpSlashPath,
        uninstallPath,
    ];
    steps.push(installManagedFile({ id: "uninstall-metadata", label: "Uninstall metadata", path: uninstallPath, content: uninstallMetadataContent(workspace, artifactPaths) }, dryRun));
    return buildReport({ dryRun, alwaysOn: true, apiBaseUrl: client.baseUrl, workspace, steps });
}
function buildReport(input) {
    const summary = summarizeSteps(input.steps);
    const failed = input.steps.filter((item) => item.status === "failed");
    const degraded = input.steps.filter((item) => item.status === "degraded");
    const installed = input.steps.filter((item) => item.status === "installed");
    const skipped = input.steps.filter((item) => item.status === "skipped" || item.status === "would-install");
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
