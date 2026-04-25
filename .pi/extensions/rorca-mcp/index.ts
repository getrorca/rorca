import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type JsonSchema = {
  type?: string;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
const defaultServerPath = path.join(repoRoot, "backend", "src", "mcp", "server.ts");
const defaultBackendCwd = path.join(repoRoot, "backend");

function getServerCommandConfig() {
  const command = process.env.RORCA_MCP_COMMAND?.trim() || "npx";
  const serverPath = process.env.RORCA_MCP_SERVER?.trim() || defaultServerPath;
  const cwd = process.env.RORCA_MCP_CWD?.trim() || defaultBackendCwd;
  const extraArgs = process.env.RORCA_MCP_ARGS?.trim();

  const args = extraArgs
    ? extraArgs.split(" ").filter(Boolean)
    : ["tsx", serverPath];

  return { command, args, cwd, serverPath };
}

function enumType(values: unknown[], schema: JsonSchema) {
  const description = schema.description;
  const literals = values
    .filter((value) => ["string", "number", "boolean"].includes(typeof value))
    .map((value) => Type.Literal(value as string | number | boolean));

  if (literals.length === 0) {
    return Type.Any({ description });
  }

  if (literals.length === 1) {
    return literals[0];
  }

  return Type.Union(literals, { description });
}

function jsonSchemaToTypeBox(schema?: JsonSchema) {
  if (!schema) {
    return Type.Any();
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return enumType(schema.enum, schema);
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return Type.Any({ description: schema.description });
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return Type.Any({ description: schema.description });
  }

  const common = {
    description: schema.description,
    default: schema.default,
  } as Record<string, unknown>;

  switch (schema.type) {
    case "string":
      return Type.String(common);
    case "number":
      return Type.Number({ ...common, minimum: schema.minimum, maximum: schema.maximum });
    case "integer":
      return Type.Integer({ ...common, minimum: schema.minimum, maximum: schema.maximum });
    case "boolean":
      return Type.Boolean(common);
    case "array":
      return Type.Array(jsonSchemaToTypeBox(schema.items), {
        ...common,
        minItems: schema.minItems,
        maxItems: schema.maxItems,
      });
    case "object": {
      const required = new Set(schema.required ?? []);
      const properties = Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([key, value]) => {
          const prop = jsonSchemaToTypeBox(value);
          return [key, required.has(key) ? prop : Type.Optional(prop)];
        }),
      );
      return Type.Object(properties, {
        ...common,
        additionalProperties: schema.additionalProperties ?? false,
      });
    }
    default:
      return Type.Any(common);
  }
}

function normalizeContent(result: any) {
  const items = Array.isArray(result?.content) ? result.content : [];
  const normalized = items.flatMap((item: any) => {
    if (item?.type === "text" && typeof item.text === "string") {
      return [{ type: "text" as const, text: item.text }];
    }

    if (item?.type === "image" && item.data && item.mimeType) {
      return [{
        type: "text" as const,
        text: `[image omitted: ${item.mimeType}]`,
      }];
    }

    return [];
  });

  if (normalized.length > 0) {
    return normalized;
  }

  if (result?.structuredContent) {
    return [{ type: "text" as const, text: JSON.stringify(result.structuredContent, null, 2) }];
  }

  if (result?.isError) {
    return [{ type: "text" as const, text: "MCP tool returned an error with no content." }];
  }

  return [{ type: "text" as const, text: "MCP tool returned no content." }];
}

export default function rorcaMcpExtension(pi: ExtensionAPI) {
  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;
  let connectPromise: Promise<Client> | null = null;
  let toolNames = new Set<string>();
  let lastToolCount = 0;

  async function closeClient() {
    try {
      await transport?.close();
    } catch {
      // ignore shutdown failures
    } finally {
      client = null;
      transport = null;
      connectPromise = null;
    }
  }

  async function ensureConnected() {
    if (client) {
      return client;
    }

    if (connectPromise) {
      return connectPromise;
    }

    connectPromise = (async () => {
      const { command, args, cwd, serverPath } = getServerCommandConfig();

      if (!fs.existsSync(cwd)) {
        throw new Error(`Rorca MCP cwd not found: ${cwd}`);
      }
      if (args.length >= 2 && args[0] === "tsx" && !fs.existsSync(serverPath)) {
        throw new Error(`Rorca MCP server not found: ${serverPath}`);
      }

      const nextClient = new Client({ name: "pi-rorca-mcp", version: "1.0.0" });
      const nextTransport = new StdioClientTransport({ command, args, cwd });

      try {
        await nextClient.connect(nextTransport);
      } catch (error) {
        try {
          await nextTransport.close();
        } catch {
          // ignore
        }
        throw error;
      }

      client = nextClient;
      transport = nextTransport;
      return nextClient;
    })();

    try {
      return await connectPromise;
    } finally {
      if (!client) {
        connectPromise = null;
      }
    }
  }

  function registerPiTool(tool: McpToolInfo) {
    if (toolNames.has(tool.name)) {
      return;
    }

    toolNames.add(tool.name);

    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description || `Call Rorca MCP tool ${tool.name}`,
      promptSnippet: tool.description || `Call Rorca MCP tool ${tool.name}`,
      promptGuidelines: [
        "Use this tool when the user is asking about Rorca workspaces, specs, stories, direction stack, runs, or memory.",
        `Pass arguments exactly as required by ${tool.name}'s schema.`,
      ],
      parameters: jsonSchemaToTypeBox(tool.inputSchema),
      async execute(_toolCallId, params, _signal, onUpdate) {
        onUpdate?.({
          content: [{ type: "text", text: `Calling ${tool.name}...` }],
          details: {},
        });

        const mcp = await ensureConnected();
        const result = await mcp.callTool({
          name: tool.name,
          arguments: params as Record<string, unknown>,
        });

        return {
          content: normalizeContent(result),
          details: {
            mcpTool: tool.name,
            isError: !!result.isError,
            structuredContent: result.structuredContent,
          },
        };
      },
    });
  }

  async function refreshTools(ctx?: { ui: { notify: (msg: string, level: "info" | "warning" | "error" | "success") => void } }) {
    try {
      const mcp = await ensureConnected();
      const result = await mcp.listTools();
      const rorcaTools = result.tools.filter((tool) => tool.name.startsWith("rorca_"));

      for (const tool of rorcaTools) {
        registerPiTool(tool);
      }

      lastToolCount = rorcaTools.length;
      ctx?.ui.notify(`Rorca MCP connected (${lastToolCount} tools)`, "success");
    } catch (error: any) {
      await closeClient();
      ctx?.ui.notify(`Rorca MCP unavailable: ${error?.message || String(error)}`, "warning");
      throw error;
    }
  }

  pi.registerCommand("rorca-mcp-refresh", {
    description: "Reconnect to Rorca MCP and refresh the available Rorca tools",
    handler: async (_args, ctx) => {
      await closeClient();
      toolNames = new Set();
      await refreshTools(ctx);
    },
  });

  pi.registerCommand("rorca-mcp-status", {
    description: "Show Rorca MCP bridge status",
    handler: async (_args, ctx) => {
      const { command, args, cwd } = getServerCommandConfig();
      const connected = !!client;
      ctx.ui.notify(
        [
          `connected=${connected}`,
          `tools=${lastToolCount}`,
          `command=${command}`,
          `args=${args.join(" ")}`,
          `cwd=${cwd}`,
        ].join("\n"),
        connected ? "info" : "warning",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      await refreshTools(ctx);
    } catch {
      // non-fatal: pi should still start even if Rorca MCP is unavailable
    }
  });

  pi.on("agent_end", async () => {
    // Keep the subprocess warm across turns, but if something broke, release it.
    if (transport && client) {
      return;
    }
    await closeClient();
  });
}
