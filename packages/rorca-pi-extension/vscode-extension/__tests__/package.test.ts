import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("Rorca Capture VS Code extension manifest", () => {
  test("declares activation events, command contributions, status/config prerequisites, and stable engine", () => {
    const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "packages/rorca-pi-extension/vscode-extension/package.json"), "utf8")) as {
      engines: { vscode: string };
      activationEvents: string[];
      contributes: { commands: Array<{ command: string; title: string }>; configuration: { properties: Record<string, unknown> } };
    };

    expect(manifest.engines.vscode).toMatch(/^\^1\./);
    expect(manifest.activationEvents).toContain("onStartupFinished");
    expect(manifest.contributes.commands.map((command) => command.command)).toEqual([
      "rorca.captureSessionSummary",
      "rorca.rememberSelection",
      "rorca.pauseCapture",
      "rorca.showCaptureStatus",
      "rorca.reviewCandidates",
    ]);
    expect(manifest.contributes.configuration.properties).toHaveProperty("rorcaCapture.enabled");
    expect(manifest.contributes.configuration.properties).toHaveProperty("rorcaCapture.memoryCandidateTokenCap");
  });
});
