import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { DEFAULT_CAPTURE_POLICY, hashCaptureContent, sanitizeCapturePayload } from "../../../../backend/src/lib/context-safety.js";
export function defaultCaptureServiceConfig(input = {}) {
    return {
        scanIntervalMs: input.scanIntervalMs ?? 60_000,
        maxCommitsPerScan: input.maxCommitsPerScan ?? 20,
        maxConcurrency: input.maxConcurrency ?? 4,
        queueWarnSize: input.queueWarnSize ?? 100,
        queueMaxSize: input.queueMaxSize ?? 1_000,
        maxBackoffMs: input.maxBackoffMs ?? 300_000,
        apiBaseUrl: (input.apiBaseUrl ?? process.env.RORCA_CAPTURE_API_URL ?? "http://127.0.0.1:3030").replace(/\/$/, ""),
    };
}
export function resolveCaptureServicePaths(workspace, platform = process.platform) {
    const captureDir = path.join(workspace.path, ".rorca", "capture");
    const queuePath = path.join(captureDir, "queue");
    const serviceDir = platform === "darwin"
        ? path.join(os.homedir(), "Library", "LaunchAgents")
        : platform === "linux"
            ? path.join(os.homedir(), ".config", "systemd", "user")
            : path.join(captureDir, "service");
    const serviceFile = path.join(serviceDir, platform === "darwin" ? `com.rorca.capture.${workspace.id}.plist` : platform === "linux" ? `rorca-capture-${workspace.id}.service` : `rorca-capture-${workspace.id}.ps1`);
    return {
        captureDir,
        queuePath,
        serviceDir,
        serviceFile,
        pidFile: path.join(captureDir, "service.pid"),
        stateFile: path.join(captureDir, "state.json"),
        statusFile: path.join(captureDir, "status.json"),
        logFile: path.join(captureDir, "service.log"),
    };
}
export function renderLaunchdPlist(input) {
    const config = defaultCaptureServiceConfig(input.config);
    const paths = input.paths ?? resolveCaptureServicePaths(input.workspace, "darwin");
    const label = `com.rorca.capture.${input.workspace.id}`;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${escapeXml(label)}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${escapeXml(input.command)}</string>\n    <string>daemon</string>\n    <string>--workspace-id</string>\n    <string>${escapeXml(input.workspace.id)}</string>\n    <string>--cwd</string>\n    <string>${escapeXml(input.workspace.path)}</string>\n    <string>--scan-interval-ms</string>\n    <string>${config.scanIntervalMs}</string>\n    <string>--max-commits-per-scan</string>\n    <string>${config.maxCommitsPerScan}</string>\n    <string>--max-concurrency</string>\n    <string>${config.maxConcurrency}</string>\n    <string>--queue-warn-size</string>\n    <string>${config.queueWarnSize}</string>\n    <string>--queue-max-size</string>\n    <string>${config.queueMaxSize}</string>\n  </array>\n  <key>WorkingDirectory</key>\n  <string>${escapeXml(input.workspace.path)}</string>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <dict><key>Crashed</key><true/></dict>\n  <key>StandardOutPath</key>\n  <string>${escapeXml(paths.logFile)}</string>\n  <key>StandardErrorPath</key>\n  <string>${escapeXml(paths.logFile)}</string>\n</dict>\n</plist>\n`;
}
export function renderSystemdUserService(input) {
    const config = defaultCaptureServiceConfig(input.config);
    const paths = input.paths ?? resolveCaptureServicePaths(input.workspace, "linux");
    const execArgs = [
        input.command,
        "daemon",
        "--workspace-id", input.workspace.id,
        "--cwd", input.workspace.path,
        "--scan-interval-ms", String(config.scanIntervalMs),
        "--max-commits-per-scan", String(config.maxCommitsPerScan),
        "--max-concurrency", String(config.maxConcurrency),
        "--queue-warn-size", String(config.queueWarnSize),
        "--queue-max-size", String(config.queueMaxSize),
    ].map(systemdQuote).join(" ");
    return `# rorca-managed: v1 | uninstall: rorca-capture service uninstall\n[Unit]\nDescription=Rorca always-on context capture for ${input.workspace.id}\nAfter=default.target\n\n[Service]\nType=simple\nWorkingDirectory=${input.workspace.path}\nExecStart=${execArgs}\nRestart=on-failure\nRestartSec=10\nEnvironment=RORCA_CAPTURE_API_URL=${config.apiBaseUrl}\nStandardOutput=append:${paths.logFile}\nStandardError=append:${paths.logFile}\n\n[Install]\nWantedBy=default.target\n`;
}
export function renderWindowsFallbackScript(input) {
    const config = defaultCaptureServiceConfig(input.config);
    return `# rorca-managed: v1 | uninstall: rorca-capture service uninstall\n# Windows fallback: run this script from a user Startup shortcut or Task Scheduler at logon.\nSet-Location -LiteralPath ${powershellQuote(input.workspace.path)}\n& ${powershellQuote(input.command)} daemon --workspace-id ${powershellQuote(input.workspace.id)} --cwd ${powershellQuote(input.workspace.path)} --scan-interval-ms ${config.scanIntervalMs} --max-commits-per-scan ${config.maxCommitsPerScan} --max-concurrency ${config.maxConcurrency} --queue-warn-size ${config.queueWarnSize} --queue-max-size ${config.queueMaxSize}\n`;
}
export function renderServiceFile(platform, input) {
    if (platform === "darwin")
        return renderLaunchdPlist(input);
    if (platform === "linux")
        return renderSystemdUserService(input);
    return renderWindowsFallbackScript(input);
}
export function runCaptureServiceLifecycle(input) {
    const platform = input.platform ?? process.platform;
    const paths = resolveCaptureServicePaths(input.workspace, platform);
    const runner = input.runner ?? ((cmd, args, options) => spawnSync(cmd, args, options));
    const command = input.command ?? process.argv[1] ?? "rorca-capture";
    const serviceName = platform === "linux" ? `rorca-capture-${input.workspace.id}.service` : `com.rorca.capture.${input.workspace.id}`;
    const commands = [];
    if (!input.dryRun && input.action !== "status")
        mkdirSync(paths.captureDir, { recursive: true });
    const run = (cmd, args) => {
        commands.push([cmd, ...args].join(" "));
        if (!input.dryRun) {
            const result = runner(cmd, args, { cwd: input.workspace.path, stdio: "pipe" });
            if (result.error || result.status !== 0)
                throw new Error(`${cmd} ${args.join(" ")} failed`);
        }
    };
    if (input.action === "status") {
        return { ok: true, action: input.action, platform, serviceFile: paths.serviceFile, commands, message: "Status loaded.", status: readCaptureServiceStatus(input.workspace, { platform, config: input.config }) };
    }
    if (input.action === "install") {
        if (!input.dryRun) {
            mkdirSync(paths.serviceDir, { recursive: true });
            writeFileSync(paths.serviceFile, renderServiceFile(platform, { workspace: input.workspace, command, paths, config: input.config }), "utf8");
        }
        if (platform === "darwin")
            run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, paths.serviceFile]);
        else if (platform === "linux") {
            run("systemctl", ["--user", "daemon-reload"]);
            run("systemctl", ["--user", "enable", serviceName]);
        }
        return { ok: true, action: input.action, platform, serviceFile: paths.serviceFile, commands, message: input.dryRun ? "Managed capture service would be installed." : platform === "win32" ? "Windows fallback script installed; register it with Task Scheduler or Startup." : "Managed capture service installed." };
    }
    if (input.action === "start") {
        if (platform === "darwin")
            run("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${serviceName}`]);
        else if (platform === "linux")
            run("systemctl", ["--user", "start", serviceName]);
        else if (!input.dryRun)
            startFallbackProcess(input.workspace, command, input.config);
        return { ok: true, action: input.action, platform, serviceFile: paths.serviceFile, commands, message: "Managed capture service started." };
    }
    if (input.action === "stop") {
        if (platform === "darwin")
            run("launchctl", ["kill", "TERM", `gui/${process.getuid?.() ?? 501}/${serviceName}`]);
        else if (platform === "linux")
            run("systemctl", ["--user", "stop", serviceName]);
        else if (!input.dryRun)
            stopFallbackProcess(paths.pidFile);
        return { ok: true, action: input.action, platform, serviceFile: paths.serviceFile, commands, message: "Managed capture service stopped." };
    }
    if (input.action === "restart") {
        if (platform === "darwin")
            run("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${serviceName}`]);
        else if (platform === "linux")
            run("systemctl", ["--user", "restart", serviceName]);
        else if (!input.dryRun) {
            stopFallbackProcess(paths.pidFile);
            startFallbackProcess(input.workspace, command, input.config);
        }
        return { ok: true, action: input.action, platform, serviceFile: paths.serviceFile, commands, message: "Managed capture service restarted. Restart after Rorca updates so stale daemon schemas are replaced." };
    }
    if (input.action === "uninstall") {
        if (platform === "darwin")
            run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, paths.serviceFile]);
        else if (platform === "linux") {
            run("systemctl", ["--user", "stop", serviceName]);
            run("systemctl", ["--user", "disable", serviceName]);
            run("systemctl", ["--user", "daemon-reload"]);
        }
        else if (!input.dryRun)
            stopFallbackProcess(paths.pidFile);
        if (!input.dryRun && existsSync(paths.serviceFile))
            rmSync(paths.serviceFile, { force: true });
        return { ok: true, action: input.action, platform, serviceFile: paths.serviceFile, commands, message: input.dryRun ? "Managed capture service would be uninstalled." : "Managed capture service uninstalled." };
    }
    return { ok: false, action: input.action, platform, serviceFile: paths.serviceFile, commands, message: `Unsupported action ${input.action}` };
}
export function readCaptureServiceStatus(workspace, input = {}) {
    const platform = input.platform ?? process.platform;
    const paths = resolveCaptureServicePaths(workspace, platform);
    const config = defaultCaptureServiceConfig(input.config);
    const state = readState(paths.stateFile);
    const pid = readPid(paths.pidFile);
    const queueDepth = countQueue(paths.queuePath);
    const manager = platform === "darwin" ? "launchd" : platform === "linux" ? "systemd" : "windows-fallback";
    return {
        workspaceId: workspace.id,
        processHealth: { manager, running: pid ? isPidRunning(pid) : false, ...(pid ? { pid } : {}) },
        last_seen: state.last_seen,
        lastScan: state.lastScan,
        lastFlush: state.lastFlush,
        queueDepth,
        backoffMs: state.backoffMs,
        sourceCapabilities: {
            repoDaemon: { status: "active" },
            gitHook: { status: "active" },
            shellIntegration: { status: "active" },
            vscodeExtension: { status: "degraded", reason: "extension_host_optional", fallbackSources: ["repoDaemon", "gitHook", "shellIntegration"] },
        },
        capturePolicy: { ...defaultCapturePolicy(), ...readLocalCapturePolicy(paths.captureDir) },
        resourceBounds: {
            scanIntervalMs: config.scanIntervalMs,
            maxCommitsPerScan: config.maxCommitsPerScan,
            maxConcurrency: config.maxConcurrency,
            queueWarnSize: config.queueWarnSize,
            queueMaxSize: config.queueMaxSize,
            maxBackoffMs: config.maxBackoffMs,
            watchers: { mode: "polling", count: 0, recursive: false, boundedBy: "maxConcurrency" },
        },
        cursor: state.cursor,
    };
}
export async function runManagedCaptureDaemon(input) {
    const config = defaultCaptureServiceConfig(input.config);
    const paths = resolveCaptureServicePaths(input.workspace);
    const fetchImpl = input.fetchImpl ?? fetch;
    const spawnSyncImpl = input.spawnSyncImpl ?? spawnSync;
    const now = input.now ?? (() => new Date());
    mkdirSync(paths.queuePath, { recursive: true });
    writeFileSync(paths.pidFile, `${process.pid}\n`, "utf8");
    const tick = async () => {
        const state = readState(paths.stateFile);
        state.last_seen = now().toISOString();
        const localPolicy = readLocalCapturePolicy(paths.captureDir);
        if (!localPolicy.paused && localPolicy.policyMode !== 'off') {
            await scanRepository(input.workspace, paths, config, state, spawnSyncImpl, now);
            await flushQueue(input.workspace, paths, config, state, fetchImpl, now);
        }
        writeState(paths.stateFile, state);
        writeFileSync(paths.statusFile, `${JSON.stringify(readCaptureServiceStatus(input.workspace, { config }), null, 2)}\n`, "utf8");
    };
    await tick();
    if (input.once)
        return;
    setInterval(() => { void tick().catch((error) => appendLog(paths.logFile, `daemon tick failed: ${error instanceof Error ? error.message : String(error)}\n`)); }, config.scanIntervalMs).unref?.();
    await new Promise(() => undefined);
}
async function scanRepository(workspace, paths, config, state, spawnSyncImpl, now) {
    const args = ["log", `--max-count=${config.maxCommitsPerScan}`, "--format=%H%x09%ct%x09%s"];
    const result = spawnSyncImpl("git", args, { cwd: workspace.path, encoding: "utf8" });
    if (result.status !== 0 || typeof result.stdout !== "string") {
        state.lastScan = now().toISOString();
        return;
    }
    const existing = new Set(readQueue(paths.queuePath).map((event) => event.id));
    const commits = result.stdout.trim().split("\n").filter(Boolean).map((line) => {
        const [hash, timestamp, ...subject] = line.split("\t");
        return { hash, timestamp, subject: subject.join("\t") };
    }).reverse();
    const startIndex = state.cursor.lastCommit ? commits.findIndex((commit) => commit.hash === state.cursor.lastCommit) + 1 : 0;
    const newCommits = startIndex > 0 ? commits.slice(startIndex) : commits;
    for (const commit of newCommits) {
        if (!commit.hash || commit.hash === state.cursor.lastCommit || existing.has(`commit:${commit.hash}`))
            continue;
        const event = redactedEvent(workspace.id, workspace.path, `commit:${commit.hash}`, now().toISOString(), {
            commit: commit.hash,
            subject: commit.subject,
            committedAt: new Date(Number(commit.timestamp) * 1000).toISOString(),
            workspacePath: workspace.path,
        });
        enqueue(paths.queuePath, event, config);
        existing.add(event.id);
        state.cursor.lastCommit = commit.hash;
    }
    state.cursor.pendingEventIds = Array.from(new Set([...state.cursor.pendingEventIds, ...existing]));
    state.lastScan = now().toISOString();
}
async function flushQueue(workspace, paths, config, state, fetchImpl, now) {
    let healthy = false;
    try {
        const health = await fetchImpl(`${config.apiBaseUrl}/api/health`);
        healthy = health.ok;
    }
    catch {
        healthy = false;
    }
    if (!healthy) {
        state.backoffMs = nextBackoff(state.backoffMs, config.maxBackoffMs);
        return;
    }
    const events = readQueue(paths.queuePath);
    const remaining = [];
    for (const event of events) {
        try {
            const response = await fetchImpl(`${config.apiBaseUrl}/api/context-capture/events`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(event),
            });
            if (!response.ok)
                remaining.push(event);
        }
        catch {
            remaining.push(event);
        }
    }
    rewriteQueue(paths.queuePath, remaining);
    state.cursor.pendingEventIds = remaining.map((event) => event.id);
    state.backoffMs = remaining.length === 0 ? 0 : nextBackoff(state.backoffMs, config.maxBackoffMs);
    state.lastFlush = now().toISOString();
    if (remaining.length === 0)
        appendLog(paths.logFile, `flushed capture queue for ${workspace.id} at ${state.lastFlush}\n`);
}
function enqueue(queuePath, event, config) {
    const events = readQueue(queuePath);
    if (events.some((item) => item.id === event.id))
        return;
    const next = [...events, event];
    if (next.length >= config.queueWarnSize)
        event.payload = { ...event.payload, queueWarning: true };
    rewriteQueue(queuePath, next.slice(Math.max(0, next.length - config.queueMaxSize)));
}
function readQueue(queuePath) {
    const file = path.join(queuePath, "offline.ndjson");
    if (!existsSync(file))
        return [];
    return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
        try {
            return [JSON.parse(line)];
        }
        catch {
            return [];
        }
    });
}
function rewriteQueue(queuePath, events) {
    mkdirSync(queuePath, { recursive: true });
    const file = path.join(queuePath, "offline.ndjson");
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""), "utf8");
    renameSync(tmp, file);
}
function countQueue(queuePath) {
    return readQueue(queuePath).length;
}
function readState(filePath) {
    if (existsSync(filePath)) {
        try {
            const parsed = JSON.parse(readFileSync(filePath, "utf8"));
            return {
                cursor: { lastCommit: parsed.cursor?.lastCommit ?? null, pendingEventIds: parsed.cursor?.pendingEventIds ?? [] },
                backoffMs: parsed.backoffMs ?? 0,
                last_seen: parsed.last_seen ?? null,
                lastScan: parsed.lastScan ?? null,
                lastFlush: parsed.lastFlush ?? null,
            };
        }
        catch { /* fall through */ }
    }
    return { cursor: { lastCommit: null, pendingEventIds: [] }, backoffMs: 0, last_seen: null, lastScan: null, lastFlush: null };
}
function writeState(filePath, state) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
function redactedEvent(workspaceId, workspacePath, id, occurredAt, payload) {
    const redacted = sanitizeCapturePayload(payload, { ...DEFAULT_CAPTURE_POLICY, rawContentDefault: "explicit" });
    const safePayload = redacted.payload;
    const commit = String(safePayload.commit ?? "");
    const subject = typeof safePayload.subject === "string" ? safePayload.subject : null;
    const committedAt = typeof safePayload.committedAt === "string" ? safePayload.committedAt : null;
    const repoPathHash = `sha256:${sha256(path.resolve(workspacePath))}`;
    const idempotencyKey = `sha256:${sha256(JSON.stringify(["git_commit", "repo_daemon", workspaceId, commit]))}`;
    const eventPayload = {
        eventType: "git_commit",
        payload_schema_version: "2026-07-ucc-007.v1",
        source_system: "repo_daemon",
        tool_name: "rorca-capture-daemon",
        host_application: null,
        session_id: null,
        workspace_id: workspaceId,
        repo_path_hash: repoPathHash,
        source_identity: {
            source_system: "repo_daemon",
            tool_name: "rorca-capture-daemon",
            host_application: null,
            session_id: null,
            workspace_id: workspaceId,
            repo_path_hash: repoPathHash,
        },
        git_branch: null,
        git_sha: commit,
        related_files: [],
        capture_policy: { policy_version: "2026-07-ucc-007", mode: "metadata-only", raw_content: "metadata" },
        trust_tier: "local",
        idempotency_key: idempotencyKey,
        provenance: { capture_source: "repoDaemon", source_event_id: id, adapter_version: null, emitted_at: occurredAt, received_at: null, local_only: true },
        commit_subject: subject,
        committed_at: committedAt,
        author_hash: null,
        changed_files: [],
    };
    return {
        id,
        workspaceId,
        source: "repoDaemon",
        occurredAt,
        payload: eventPayload,
        safety: {
            contextSafetyModule: "backend/src/lib/context-safety.ts",
            policyVersion: redacted.safety.policyVersion,
            redactionCount: redacted.safety.redactionCount,
            ignoredPathCount: 0,
            truncated: redacted.safety.truncated,
            hashAlgorithm: "sha256",
            contentHash: hashCaptureContent(eventPayload),
        },
    };
}
function sha256(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}
function nextBackoff(current, max) {
    return Math.min(max, current > 0 ? current * 2 : 1_000);
}
function defaultCapturePolicy() {
    return { version: "2026-07-ucc-007", rawContentDefault: "metadata+hash", hashAlgorithm: "sha256", boundedWatchers: true };
}
function readLocalCapturePolicy(captureDir) {
    const policyPath = path.join(captureDir, "policy.json");
    const sidecarPath = path.join(captureDir, "sidecar.json");
    for (const filePath of [policyPath, sidecarPath]) {
        if (!existsSync(filePath))
            continue;
        try {
            const parsed = JSON.parse(readFileSync(filePath, "utf8"));
            return { policyMode: parsed.policyMode, mode: parsed.policyMode, paused: Boolean(parsed.paused) };
        }
        catch { /* ignore malformed local policy */ }
    }
    return { policyMode: "metadata-only", mode: "metadata-only", paused: false };
}
function startFallbackProcess(workspace, command, config) {
    const paths = resolveCaptureServicePaths(workspace, "win32");
    const cfg = defaultCaptureServiceConfig(config);
    const child = spawn(command, ["daemon", "--workspace-id", workspace.id, "--cwd", workspace.path, "--scan-interval-ms", String(cfg.scanIntervalMs), "--max-commits-per-scan", String(cfg.maxCommitsPerScan), "--max-concurrency", String(cfg.maxConcurrency), "--queue-warn-size", String(cfg.queueWarnSize), "--queue-max-size", String(cfg.queueMaxSize)], { cwd: workspace.path, detached: true, stdio: "ignore" });
    child.unref();
    writeFileSync(paths.pidFile, `${child.pid}\n`, "utf8");
    return child;
}
function stopFallbackProcess(pidFile) {
    const pid = readPid(pidFile);
    if (pid) {
        try {
            process.kill(pid);
        }
        catch { /* already stopped */ }
    }
    rmSync(pidFile, { force: true });
}
function readPid(pidFile) {
    if (!existsSync(pidFile))
        return undefined;
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}
function isPidRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function appendLog(filePath, text) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, text, { encoding: "utf8", flag: "a" });
}
function escapeXml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}
function systemdQuote(value) {
    return /[\s'"\\]/.test(value) ? `'${value.replace(/'/g, "'\\''")}'` : value;
}
function powershellQuote(value) {
    return `'${value.replace(/'/g, "''")}'`;
}
