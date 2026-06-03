import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseEnrichCommand, parseForgeCommand, parseRetryCommand, parseRunCommand, resolveBriefInput, tokenizeArgs } from "../args.js";

describe("rorca pi extension args", () => {
  it("tokenizes quoted values", () => {
    expect(tokenizeArgs('alpha --model "openai/gpt-5" --story US-1')).toEqual([
      "alpha",
      "--model",
      "openai/gpt-5",
      "--story",
      "US-1",
    ]);
  });

  it("parses forge flags", () => {
    expect(parseForgeCommand("@docs/prd.md --approve --run --queue --workspace ws-1 --model openai/gpt-5 --no-watch")).toEqual({
      brief: "@docs/prd.md",
      options: {
        approve: true,
        run: true,
        queue: true,
        workspaceId: "ws-1",
        model: "openai/gpt-5",
        autoWatch: false,
      },
    });
  });

  it("parses run flags", () => {
    expect(parseRunCommand("oauth-login --story US-003 --workspace ws-2 --queue --sequential")).toEqual({
      specSlug: "oauth-login",
      storyId: "US-003",
      workspaceId: "ws-2",
      queue: true,
      forceSequential: true,
      autoWatch: true,
    });
  });

  it("parses retry with fallback run id", () => {
    expect(parseRetryCommand("US-001 US-002 --sequential --no-watch", 42)).toEqual({
      runId: 42,
      storyIds: ["US-001", "US-002"],
      forceSequential: true,
      autoWatch: false,
    });
  });

  it("parses enrich with explicit slug and workspace", () => {
    expect(parseEnrichCommand("oauth-login --workspace ws-3")).toEqual({
      specSlug: "oauth-login",
      workspaceId: "ws-3",
    });
  });

  it("falls back to the last spec slug for enrich when none is provided", () => {
    expect(parseEnrichCommand("--workspace ws-3", "billing-flow")).toEqual({
      specSlug: "billing-flow",
      workspaceId: "ws-3",
    });
  });

  it("throws when enrich has no slug and no fallback", () => {
    expect(() => parseEnrichCommand("")).toThrow(/Usage: \/rorca-enrich/);
  });

  it("loads brief contents from @file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rorca-pi-ext-"));
    const filePath = path.join(tempDir, "brief.md");
    fs.writeFileSync(filePath, "Build OAuth login\n", "utf8");

    expect(resolveBriefInput(`@${filePath}`)).toEqual({
      brief: "Build OAuth login",
      sourceLabel: filePath,
    });
  });
});
