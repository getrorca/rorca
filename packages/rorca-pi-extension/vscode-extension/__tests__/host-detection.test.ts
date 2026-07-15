/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, test } from "vitest";
import { detectVsCodeHosts, installExtensionOnDetectedHosts, type HostCommandRunner } from "../src/host-detection.js";

describe("VS Code-compatible host detection", () => {
  test("reports installed and missing hosts without throwing", () => {
    const runner: HostCommandRunner = (command) => command === "code"
      ? { status: 0, stdout: "1.99.0\nabc", stderr: "" }
      : { status: 127, stdout: "", stderr: "not found" };

    const hosts = detectVsCodeHosts(runner);

    expect(hosts.find((host) => host.kind === "vscode-stable")).toMatchObject({ status: "installed", cliName: "code", version: "1.99.0" });
    expect(hosts.find((host) => host.kind === "cursor")).toMatchObject({ status: "missing" });
    expect(hosts.every((host) => host.proprietaryAiChatAccess === "unsupported-without-adapter")).toBe(true);
  });

  test("attempts extension CLI install and reports VSIX fallback when no target is provided", () => {
    const calls: string[] = [];
    const runner: HostCommandRunner = (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (args[0] === "--version" && command === "codium") return { status: 0, stdout: "1.98.0", stderr: "" };
      if (args[0] === "--install-extension") return { status: 0, stdout: "installed", stderr: "" };
      return { status: 127, stdout: "", stderr: "missing" };
    };

    expect(installExtensionOnDetectedHosts({ runner }).find((host) => host.kind === "vscodium")).toMatchObject({ installStatus: "vsix-required" });
    expect(installExtensionOnDetectedHosts({ runner, vsixPath: "./rorca.vsix" }).find((host) => host.kind === "vscodium")).toMatchObject({ installAttempted: true, installStatus: "installed", command: "codium --install-extension ./rorca.vsix" });
    expect(calls).toContain("codium --version");
  });
});
