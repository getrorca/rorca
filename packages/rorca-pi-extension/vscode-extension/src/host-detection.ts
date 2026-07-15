import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";

export type VsCodeHostKind = "vscode-stable" | "vscode-insiders" | "vscodium" | "cursor" | "windsurf";

export type VsCodeCompatibleHost = {
  kind: VsCodeHostKind;
  displayName: string;
  cliNames: string[];
  compatibility: "validated" | "expected";
  proprietaryAiChatAccess: "unsupported-without-adapter";
};

export type HostDetectionResult = VsCodeCompatibleHost & {
  status: "installed" | "missing" | "unsupported";
  cliName?: string;
  version?: string;
  reason?: string;
};

export type HostInstallResult = HostDetectionResult & {
  installAttempted: boolean;
  installStatus: "installed" | "skipped" | "failed" | "vsix-required";
  command?: string;
  stderr?: string;
};

export type HostCommandRunner = (command: string, args: string[]) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr" | "error">;

export const VSCODE_COMPATIBLE_HOSTS: VsCodeCompatibleHost[] = [
  { kind: "vscode-stable", displayName: "Visual Studio Code", cliNames: ["code"], compatibility: "validated", proprietaryAiChatAccess: "unsupported-without-adapter" },
  { kind: "vscode-insiders", displayName: "Visual Studio Code Insiders", cliNames: ["code-insiders"], compatibility: "validated", proprietaryAiChatAccess: "unsupported-without-adapter" },
  { kind: "vscodium", displayName: "VSCodium", cliNames: ["codium", "vscodium"], compatibility: "expected", proprietaryAiChatAccess: "unsupported-without-adapter" },
  { kind: "cursor", displayName: "Cursor", cliNames: ["cursor", "cursor-insiders"], compatibility: "expected", proprietaryAiChatAccess: "unsupported-without-adapter" },
  { kind: "windsurf", displayName: "Windsurf", cliNames: ["windsurf", "code-windsurf"], compatibility: "expected", proprietaryAiChatAccess: "unsupported-without-adapter" },
];

export function detectVsCodeHosts(runner: HostCommandRunner = defaultRunner): HostDetectionResult[] {
  return VSCODE_COMPATIBLE_HOSTS.map((host) => detectHost(host, runner));
}

export function detectHost(host: VsCodeCompatibleHost, runner: HostCommandRunner = defaultRunner): HostDetectionResult {
  for (const cliName of host.cliNames) {
    const result = runner(cliName, ["--version"]);
    if (result.status === 0) {
      return {
        ...host,
        status: "installed",
        cliName,
        version: firstLine(result.stdout),
      };
    }
  }
  return {
    ...host,
    status: "missing",
    reason: `No compatible CLI found. Tried: ${host.cliNames.join(", ")}`,
  };
}

export function installExtensionOnDetectedHosts(input: { extensionId?: string; vsixPath?: string; runner?: HostCommandRunner } = {}): HostInstallResult[] {
  const runner = input.runner ?? defaultRunner;
  return detectVsCodeHosts(runner).map((host) => installExtensionOnHost(host, input, runner));
}

export function installExtensionOnHost(host: HostDetectionResult, input: { extensionId?: string; vsixPath?: string }, runner: HostCommandRunner = defaultRunner): HostInstallResult {
  if (host.status !== "installed" || !host.cliName) {
    return { ...host, installAttempted: false, installStatus: "skipped" };
  }

  const target = input.vsixPath || input.extensionId;
  if (!target) {
    return {
      ...host,
      installAttempted: false,
      installStatus: "vsix-required",
      reason: "Provide --vsix <path> for local fork installation or publish an extension id for marketplace-capable hosts.",
    };
  }

  const args = ["--install-extension", target];
  const result = runner(host.cliName, args);
  return {
    ...host,
    installAttempted: true,
    installStatus: result.status === 0 ? "installed" : "failed",
    command: `${host.cliName} ${args.join(" ")}`,
    stderr: result.stderr ? String(result.stderr) : undefined,
  };
}

function defaultRunner(command: string, args: string[]): Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr" | "error"> {
  return spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 });
}

function firstLine(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return text.split(/\r?\n/).find((line) => line.trim())?.trim();
}
