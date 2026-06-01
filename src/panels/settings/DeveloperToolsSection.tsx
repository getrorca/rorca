/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { ExternalLink, Code2, FileJson, Terminal } from 'lucide-react';

export default function DeveloperToolsSection() {
  const apiDocsUrl = 'http://localhost:3030/api/docs';
  const openApiUrl = 'http://localhost:3030/api/docs/openapi.json';
  const mcpEndpoint = 'http://localhost:3030/mcp';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--text)]">Developer Tools</h2>
        <p className="text-sm text-muted mt-1">API documentation, MCP endpoints, and debug utilities.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* OpenAPI Docs */}
        <a
          href={apiDocsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="border border-border rounded-lg p-4 bg-bg hover:bg-surface-100 hover:border-accent/30 transition-colors group"
        >
          <div className="flex items-center gap-2 mb-2">
            <FileJson size={18} className="text-accent" />
            <span className="text-sm font-medium text-[var(--text)]">Swagger UI</span>
            <ExternalLink size={12} className="text-muted/50 group-hover:text-accent ml-auto" />
          </div>
          <p className="text-xs text-muted">
            Interactive API documentation with try-it-out capability.
          </p>
        </a>

        {/* OpenAPI JSON */}
        <a
          href={openApiUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="border border-border rounded-lg p-4 bg-bg hover:bg-surface-100 hover:border-accent/30 transition-colors group"
        >
          <div className="flex items-center gap-2 mb-2">
            <Code2 size={18} className="text-accent" />
            <span className="text-sm font-medium text-[var(--text)]">OpenAPI Spec</span>
            <ExternalLink size={12} className="text-muted/50 group-hover:text-accent ml-auto" />
          </div>
          <p className="text-xs text-muted">
            Raw OpenAPI JSON for code generation and MCP tools.
          </p>
        </a>
      </div>

      {/* MCP Configuration */}
      <div className="border border-border rounded-lg p-4 bg-bg">
        <div className="flex items-center gap-2 mb-3">
          <Terminal size={18} className="text-accent" />
          <span className="text-sm font-medium text-[var(--text)]">MCP Configuration</span>
        </div>
        <p className="text-xs text-muted mb-3">
          Connect AI tools (Claude Code, VS Code, etc.) to Rorca via the Model Context Protocol.
        </p>

        <div className="space-y-3">
          <div>
            <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">HTTP Endpoint (Streamable)</label>
            <code className="block px-3 py-2 text-xs font-mono bg-surface-100 border border-border rounded text-[var(--text)]">
              {mcpEndpoint}
            </code>
          </div>

          <div>
            <label className="block text-[10px] text-muted uppercase tracking-wider mb-1">Stdio (Legacy)</label>
            <code className="block px-3 py-2 text-xs font-mono bg-surface-100 border border-border rounded text-[var(--text)] break-all">
              claude mcp add rorca -- npx tsx /path/to/rorca/backend/src/mcp/server.ts
            </code>
          </div>
        </div>
      </div>

      {/* Health Check */}
      <div className="border border-border rounded-lg p-4 bg-bg">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm font-medium text-[var(--text)]">Backend Health</span>
        </div>
        <p className="text-xs text-muted mb-2">
          Check agent detection, database status, and installed versions.
        </p>
        <a
          href="http://localhost:3030/api/health"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-accent hover:text-accent/80 transition-colors"
        >
          GET /api/health
          <ExternalLink size={10} />
        </a>
      </div>
    </div>
  );
}
