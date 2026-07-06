import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readCaptureServiceStatus,
  renderLaunchdPlist,
  renderSystemdUserService,
  renderWindowsFallbackScript,
  resolveCaptureServicePaths,
  runCaptureServiceLifecycle,
  runManagedCaptureDaemon,
  type CaptureServicePaths,
} from "../capture-service.js";
import type { Workspace } from "../types.js";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rorca-capture-service-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): Workspace {
  const root = tempDir();
  mkdirSync(path.join(root, ".git"), { recursive: true });
  return { id: "demo", label: "Demo", path: root };
}

function fixedPaths(root: string): CaptureServicePaths {
  return {
    captureDir: `${root}/.rorca/capture`,
    queuePath: `${root}/.rorca/capture/queue`,
    serviceDir: `${root}/services`,
    serviceFile: `${root}/services/rorca.service`,
    pidFile: `${root}/.rorca/capture/service.pid`,
    stateFile: `${root}/.rorca/capture/state.json`,
    statusFile: `${root}/.rorca/capture/status.json`,
    logFile: `${root}/.rorca/capture/service.log`,
  };
}

function gitLog(commits: string[]): typeof spawnSync {
  return (() => ({ status: 0, stdout: commits.join("\n"), stderr: "" })) as unknown as typeof spawnSync;
}

describe("capture service rendering", () => {
  it("renders exact launchd, systemd, and Windows fallback files with escaped inputs", () => {
    const ws = { id: "demo", label: "Demo", path: "/tmp/Rorca Demo" };
    const paths = fixedPaths("/tmp/Rorca Demo");
    const config = { scanIntervalMs: 5000, maxCommitsPerScan: 7, maxConcurrency: 2, queueWarnSize: 3, queueMaxSize: 9, apiBaseUrl: "http://127.0.0.1:3030" };

    expect(renderLaunchdPlist({ workspace: ws, command: "/usr/local/bin/rorca-capture", paths, config })).toMatchInlineSnapshot(`
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
      <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
      <plist version=\"1.0\">
      <dict>
        <key>Label</key>
        <string>com.rorca.capture.demo</string>
        <key>ProgramArguments</key>
        <array>
          <string>/usr/local/bin/rorca-capture</string>
          <string>daemon</string>
          <string>--workspace-id</string>
          <string>demo</string>
          <string>--cwd</string>
          <string>/tmp/Rorca Demo</string>
          <string>--scan-interval-ms</string>
          <string>5000</string>
          <string>--max-commits-per-scan</string>
          <string>7</string>
          <string>--max-concurrency</string>
          <string>2</string>
          <string>--queue-warn-size</string>
          <string>3</string>
          <string>--queue-max-size</string>
          <string>9</string>
        </array>
        <key>WorkingDirectory</key>
        <string>/tmp/Rorca Demo</string>
        <key>RunAtLoad</key>
        <true/>
        <key>KeepAlive</key>
        <dict><key>Crashed</key><true/></dict>
        <key>StandardOutPath</key>
        <string>/tmp/Rorca Demo/.rorca/capture/service.log</string>
        <key>StandardErrorPath</key>
        <string>/tmp/Rorca Demo/.rorca/capture/service.log</string>
      </dict>
      </plist>
      "
    `);

    expect(renderSystemdUserService({ workspace: ws, command: "/usr/local/bin/rorca-capture", paths, config })).toMatchInlineSnapshot(`
      "# rorca-managed: v1 | uninstall: rorca-capture service uninstall
      [Unit]
      Description=Rorca always-on context capture for demo
      After=default.target

      [Service]
      Type=simple
      WorkingDirectory=/tmp/Rorca Demo
      ExecStart=/usr/local/bin/rorca-capture daemon --workspace-id demo --cwd '/tmp/Rorca Demo' --scan-interval-ms 5000 --max-commits-per-scan 7 --max-concurrency 2 --queue-warn-size 3 --queue-max-size 9
      Restart=on-failure
      RestartSec=10
      Environment=RORCA_CAPTURE_API_URL=http://127.0.0.1:3030
      StandardOutput=append:/tmp/Rorca Demo/.rorca/capture/service.log
      StandardError=append:/tmp/Rorca Demo/.rorca/capture/service.log

      [Install]
      WantedBy=default.target
      "
    `);

    expect(renderWindowsFallbackScript({ workspace: ws, command: "C:/Rorca/rorca-capture.cmd", config })).toContain("Task Scheduler at logon");
    expect(renderWindowsFallbackScript({ workspace: ws, command: "C:/Rorca/rorca-capture.cmd", config })).toContain("--queue-max-size 9");
  });
});

describe("capture service lifecycle", () => {
  it("does not spawn the Windows fallback daemon during dry-run start", () => {
    const ws = workspace();
    const result = runCaptureServiceLifecycle({ action: "start", workspace: ws, platform: "win32", dryRun: true, command: "/bin/rorca-capture" });

    expect(result.ok).toBe(true);
    expect(result.commands).toEqual([]);
    expect(existsSync(path.join(ws.path, ".rorca", "capture", "service.pid"))).toBe(false);
  });

  it("constructs install/start/stop/restart/uninstall commands without executing in dry-run", () => {
    const ws = workspace();
    const calls: string[] = [];
    const runner = (command: string, args: string[]) => {
      calls.push([command, ...args].join(" "));
      return { status: 0 };
    };

    const install = runCaptureServiceLifecycle({ action: "install", workspace: ws, platform: "linux", dryRun: true, runner, command: "/bin/rorca-capture" });
    const start = runCaptureServiceLifecycle({ action: "start", workspace: ws, platform: "linux", dryRun: true, runner, command: "/bin/rorca-capture" });
    const restart = runCaptureServiceLifecycle({ action: "restart", workspace: ws, platform: "linux", dryRun: true, runner, command: "/bin/rorca-capture" });
    const uninstall = runCaptureServiceLifecycle({ action: "uninstall", workspace: ws, platform: "linux", dryRun: true, runner, command: "/bin/rorca-capture" });

    expect(install.commands).toEqual(["systemctl --user daemon-reload", "systemctl --user enable rorca-capture-demo.service"]);
    expect(start.commands).toEqual(["systemctl --user start rorca-capture-demo.service"]);
    expect(restart.commands).toEqual(["systemctl --user restart rorca-capture-demo.service"]);
    expect(uninstall.commands).toEqual(["systemctl --user stop rorca-capture-demo.service", "systemctl --user disable rorca-capture-demo.service", "systemctl --user daemon-reload"]);
    expect(calls).toEqual([]);
  });
});

describe("managed capture daemon", () => {
  it("preserves the durable cursor across restart and does not resubmit duplicate commits", async () => {
    const ws = workspace();
    const commits = ["bbb222\t1700000060\tsecond", "aaa111\t1700000000\tfirst"];
    const posted: unknown[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return new Response("{}", { status: 200 });
      posted.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };

    await runManagedCaptureDaemon({ workspace: ws, once: true, fetchImpl, spawnSyncImpl: gitLog(commits), now: () => new Date("2026-07-05T00:00:00.000Z") });
    await runManagedCaptureDaemon({ workspace: ws, once: true, fetchImpl, spawnSyncImpl: gitLog(commits), now: () => new Date("2026-07-05T00:01:00.000Z") });

    expect(posted).toHaveLength(2);
    expect(posted.map((event) => (event as { id: string }).id)).toEqual(["commit:aaa111", "commit:bbb222"]);
    expect((posted[0] as { payload: { eventType: string; payload_schema_version: string; idempotency_key: string; provenance: { capture_source: string } } }).payload).toMatchObject({ eventType: "git_commit", payload_schema_version: "2026-07-ucc-007.v1", provenance: { capture_source: "repoDaemon" } });
    expect((posted[0] as { payload: { idempotency_key: string } }).payload.idempotency_key).toMatch(/^sha256:/);
    const state = JSON.parse(readFileSync(path.join(ws.path, ".rorca", "capture", "state.json"), "utf8"));
    expect(state.cursor.lastCommit).toBe("bbb222");
    expect(state.cursor.pendingEventIds).toEqual([]);
  });

  it("queues redacted payloads while offline and flushes only after health succeeds", async () => {
    const ws = workspace();
    const commits = ["aaa111\t1700000000\tTOKEN=super-secret"];
    const posted: Array<{ payload: unknown }> = [];
    let online = false;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return new Response("{}", { status: online ? 200 : 503 });
      posted.push(JSON.parse(String(init?.body)) as { payload: unknown });
      return new Response("{}", { status: 200 });
    };

    await runManagedCaptureDaemon({ workspace: ws, once: true, fetchImpl, spawnSyncImpl: gitLog(commits) });
    expect(posted).toHaveLength(0);
    const queued = readFileSync(path.join(ws.path, ".rorca", "capture", "queue", "offline.ndjson"), "utf8");
    expect(queued).toContain("[REDACTED_ENV]");
    expect(queued).toContain('"contextSafetyModule":"backend/src/lib/context-safety.ts"');

    online = true;
    await runManagedCaptureDaemon({ workspace: ws, once: true, fetchImpl, spawnSyncImpl: gitLog(commits) });
    expect(posted).toHaveLength(1);
    expect(JSON.stringify(posted[0].payload)).not.toContain("super-secret");
  });

  it("reports status with health, scan, flush, queue, backoff, capabilities, policy, and bounds", async () => {
    const ws = workspace();
    const fetchImpl = async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: 503 });
    await runManagedCaptureDaemon({ workspace: ws, once: true, fetchImpl, spawnSyncImpl: gitLog(["aaa111\t1700000000\tfirst"]) });

    const status = readCaptureServiceStatus(ws, { config: { scanIntervalMs: 1234, maxCommitsPerScan: 5, maxConcurrency: 2, queueWarnSize: 4, queueMaxSize: 8 } });
    expect(status.processHealth).toMatchObject({ manager: process.platform === "darwin" ? "launchd" : process.platform === "linux" ? "systemd" : "windows-fallback" });
    expect(status.last_seen).toBeTruthy();
    expect(status.lastScan).toBeTruthy();
    expect(status.lastFlush).toBeNull();
    expect(status.queueDepth).toBe(1);
    expect(status.backoffMs).toBeGreaterThan(0);
    expect(status.sourceCapabilities.repoDaemon.status).toBe("active");
    expect(status.capturePolicy.version).toBe("2026-07-ucc-007");
    expect(status.resourceBounds.watchers).toEqual({ mode: "polling", count: 0, recursive: false, boundedBy: "maxConcurrency" });
    expect(resolveCaptureServicePaths(ws).queuePath).toContain(path.join(".rorca", "capture", "queue"));
  });
});
