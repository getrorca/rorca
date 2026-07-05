#!/usr/bin/env node
import { installExtensionOnDetectedHosts } from "./host-detection.js";

function parseArgs(argv: string[]): { extensionId?: string; vsixPath?: string; json: boolean } {
  const result: { extensionId?: string; vsixPath?: string; json: boolean } = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--extension-id") result.extensionId = argv[++i];
    else if (arg === "--vsix") result.vsixPath = argv[++i];
    else if (arg === "--json") result.json = true;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const results = installExtensionOnDetectedHosts({ extensionId: args.extensionId, vsixPath: args.vsixPath });
if (args.json) {
  console.log(JSON.stringify({ hosts: results }, null, 2));
} else {
  for (const result of results) {
    const label = `${result.displayName} (${result.cliName ?? result.cliNames.join("/")})`;
    if (result.installStatus === "installed") console.log(`installed: ${label}`);
    else if (result.installStatus === "vsix-required") console.log(`fallback required: ${label} — ${result.reason}`);
    else if (result.installStatus === "skipped") console.log(`skipped: ${label} — ${result.reason ?? "CLI unavailable"}`);
    else console.log(`failed: ${label} — ${result.stderr ?? "extension CLI returned a non-zero status"}`);
  }
}
