import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseForgeCommand, parseRetryCommand, parseRunCommand, resolveBriefInput, tokenizeArgs } from "../args.js";

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
    expect(parseRunCommand("oauth-login --story US-003 --workspace ws-2 --queue")).toEqual({
      specSlug: "oauth-login",
      storyId: "US-003",
      workspaceId: "ws-2",
      queue: true,
      autoWatch: true,
    });
  });

  it("parses retry with fallback run id", () => {
    expect(parseRetryCommand("US-001 US-002 --no-watch", 42)).toEqual({
      runId: 42,
      storyIds: ["US-001", "US-002"],
      autoWatch: false,
    });
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
