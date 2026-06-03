/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * LEGACY STDIO MCP SERVER — offline fallback.
 *
 * This server intentionally mirrors the HTTP MCP surface by registering tools
 * from the same OpenAPI tier-filtered source of truth.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { applySelectedDbModeEnvironment } from '../lib/db-strategy';
import { createMcpHttpServer, getMcpToolDefinitions } from '../lib/mcp-http';
import { logger } from '../lib/logger';
import { swaggerSpec } from '../lib/swagger';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });
const mcpDbModeBootstrap = applySelectedDbModeEnvironment();
if (mcpDbModeBootstrap.changed) {
  console.info(`[db-mode] Using ${mcpDbModeBootstrap.mode} database ${mcpDbModeBootstrap.databaseUrl}`);
}

export const server: McpServer = createMcpHttpServer(swaggerSpec as any);

export async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const toolCount = getMcpToolDefinitions(swaggerSpec as any).length;
  logger.info(`[MCP-STDIO] Registered ${toolCount} OpenAPI-derived tools (public + auth tiers only)`);
}

const entrypoint = process.argv[1] ? path.normalize(process.argv[1]) : '';
if (entrypoint.endsWith(`${path.sep}backend${path.sep}src${path.sep}mcp${path.sep}server.ts`) || entrypoint.endsWith(`${path.sep}backend${path.sep}dist${path.sep}mcp${path.sep}server.js`)) {
  main().catch((error) => {
    logger.error({ err: error }, '[MCP-STDIO] Failed to start');
    process.exit(1);
  });
}
