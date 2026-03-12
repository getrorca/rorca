import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';

// ─── Types ────────────────────────────────────────────────────────────────────

interface McpToolDef {
  name: string;
  description: string;
  category: string;
  inputSchema: Record<string, unknown>;
  requiredParams: string[];
}

type TreeItemKind = 'category' | 'tool' | 'offline';

interface RorcaTreeItem extends vscode.TreeItem {
  kind: TreeItemKind;
  tool?: McpToolDef;
  category?: string;
  children?: RorcaTreeItem[];
}

type InsertSyntax = 'name-only' | 'json-call' | 'slash-command';

// ─── Public API ───────────────────────────────────────────────────────────────

export interface RorcaPublicApi {
  getServerUrl(): string;
  isServerOnline(): boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const HEALTH_POLL_INTERVAL_MS = 30_000;

/** Categories expanded by default in the tree */
const EXPANDED_BY_DEFAULT = new Set(['Specs & Pipeline']);

/** Map category name → /api/docs tag anchor for "View Documentation" */
const CATEGORY_DOC_TAG: Record<string, string> = {
  'Specs & Pipeline': 'MCP',
  'Story Editing': 'MCP',
  'Direction Stack': 'MCP',
  'Workspaces': 'MCP',
  'Memory': 'MCP',
};

// ─── Config helpers ───────────────────────────────────────────────────────────

function getConfig() {
  return vscode.workspace.getConfiguration('rorca');
}

function getApiUrl(): string {
  return getConfig().get<string>('apiUrl', 'http://localhost:3030');
}

function getAutoRefreshInterval(): number {
  return getConfig().get<number>('autoRefreshInterval', 60);
}

function getShowStatusBarItem(): boolean {
  return getConfig().get<boolean>('showStatusBarItem', true);
}

function getInsertSyntax(): InsertSyntax {
  return getConfig().get<InsertSyntax>('insertSyntax', 'name-only');
}

function isValidUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

// ─── Insert-at-cursor text builder ────────────────────────────────────────────

function buildInsertText(tool: McpToolDef, syntax: InsertSyntax): string {
  switch (syntax) {
    case 'name-only':
      return tool.name;
    case 'json-call': {
      const call = {
        tool: tool.name,
        params: Object.fromEntries(tool.requiredParams.map(p => [p, ''])),
      };
      return JSON.stringify(call, null, 2);
    }
    case 'slash-command': {
      const args = tool.requiredParams.join(' ');
      return args ? `/mcp__rorca__${tool.name} ${args}` : `/mcp__rorca__${tool.name}`;
    }
  }
}

// ─── RorcaMcpToolsProvider ────────────────────────────────────────────────────

export class RorcaMcpToolsProvider implements vscode.TreeDataProvider<RorcaTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RorcaTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private tools: McpToolDef[] = [];
  private cachedTools: McpToolDef[] = []; // Kept across offline periods
  private serverOnline = false;
  private toolsRefreshTimer: NodeJS.Timeout | undefined;

  constructor() {
    // Initial fetch is triggered from activate() after status bar is ready
  }

  // ─── TreeDataProvider ────────────────────────────────────────────────────

  getTreeItem(element: RorcaTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: RorcaTreeItem): RorcaTreeItem[] {
    if (!element) {
      // Root level: offline sentinel OR category nodes
      if (!this.serverOnline && this.tools.length === 0) {
        if (this.cachedTools.length > 0) {
          // Server offline but we have cached data — show cached + offline warning
          return [this.buildOfflineItem(), ...this.buildCategoryNodes(this.cachedTools, true)];
        }
        return [this.buildOfflineItem()];
      }

      const toolsToShow = this.tools.length > 0 ? this.tools : this.cachedTools;
      if (toolsToShow.length === 0) {
        return [this.buildEmptyItem()];
      }

      const nodes = this.buildCategoryNodes(toolsToShow, !this.serverOnline);
      if (!this.serverOnline) {
        nodes.unshift(this.buildOfflineItem());
      }
      return nodes;
    }

    if (element.kind === 'category') {
      return element.children ?? [];
    }

    return [];
  }

  resolveTreeItem(item: RorcaTreeItem, _element: RorcaTreeItem): RorcaTreeItem {
    if (item.kind !== 'tool' || !item.tool) {
      return item;
    }
    const tool = item.tool;
    const paramLines = tool.requiredParams.length > 0
      ? tool.requiredParams.map(p => `- \`${p}\` *(required)*`).join('\n')
      : '*(no required params)*';

    const exampleCall = JSON.stringify(
      { tool: tool.name, params: Object.fromEntries(tool.requiredParams.map(p => [p, ''])) },
      null,
      2,
    );

    const md = new vscode.MarkdownString(
      `**${tool.name}**\n\n${tool.description}\n\n**Required parameters:**\n${paramLines}\n\n**Example:**\n\`\`\`json\n${exampleCall}\n\`\`\``,
      true,
    );
    md.isTrusted = true;
    item.tooltip = md;
    return item;
  }

  // ─── Data fetching ────────────────────────────────────────────────────────

  async fetchTools(): Promise<void> {
    try {
      const data = await apiGet<{ tools: McpToolDef[] }>('/api/mcp/tools');
      this.tools = data.tools ?? [];
      if (this.tools.length > 0) {
        this.cachedTools = [...this.tools];
      }
    } catch {
      // Keep previously cached tools; mark as offline (serverOnline managed by health poll)
      this.tools = [];
    }
    this._onDidChangeTreeData.fire();
  }

  setServerOnline(online: boolean): void {
    if (this.serverOnline === online) {
      return;
    }
    this.serverOnline = online;
    if (online) {
      // Server came back — re-fetch tools immediately
      void this.fetchTools();
    } else {
      // Server went offline — clear live list but keep cache
      this.tools = [];
      this._onDidChangeTreeData.fire();
    }
  }

  refresh(): void {
    void this.fetchTools();
  }

  startAutoRefresh(intervalSeconds?: number): void {
    this.stopAutoRefresh();
    const secs = intervalSeconds ?? getAutoRefreshInterval();
    if (secs <= 0) {
      return; // 0 = disabled
    }
    this.toolsRefreshTimer = setInterval(() => {
      if (this.serverOnline) {
        void this.fetchTools();
      }
    }, secs * 1000);
  }

  stopAutoRefresh(): void {
    if (this.toolsRefreshTimer) {
      clearInterval(this.toolsRefreshTimer);
      this.toolsRefreshTimer = undefined;
    }
  }

  dispose(): void {
    this.stopAutoRefresh();
    this._onDidChangeTreeData.dispose();
  }

  // ─── Builder helpers ──────────────────────────────────────────────────────

  private buildCategoryNodes(tools: McpToolDef[], cached: boolean): RorcaTreeItem[] {
    const byCategory = new Map<string, McpToolDef[]>();
    for (const tool of tools) {
      const list = byCategory.get(tool.category) ?? [];
      list.push(tool);
      byCategory.set(tool.category, list);
    }

    return [...byCategory.entries()].map(([cat, catTools]) => {
      const children = catTools.map(t => this.buildToolNode(t, cached));
      const node: RorcaTreeItem = {
        kind: 'category',
        category: cat,
        label: cat,
        description: `${catTools.length} tool${catTools.length !== 1 ? 's' : ''}`,
        collapsibleState: EXPANDED_BY_DEFAULT.has(cat)
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
        iconPath: new vscode.ThemeIcon('folder'),
        tooltip: `${cat} — ${catTools.length} tool${catTools.length !== 1 ? 's' : ''}`,
        accessibilityInformation: {
          label: `${cat} category, ${catTools.length} tools`,
        },
        children,
      };
      return node;
    });
  }

  private buildToolNode(tool: McpToolDef, cached: boolean): RorcaTreeItem {
    const reqCount = tool.requiredParams.length;
    const suffix = reqCount > 0 ? ` · ${reqCount} required param${reqCount !== 1 ? 's' : ''}` : '';
    const node: RorcaTreeItem = {
      kind: 'tool',
      tool,
      label: tool.name,
      description: cached
        ? `${tool.description.slice(0, 60)}${tool.description.length > 60 ? '…' : ''} (cached)${suffix}`
        : `${tool.description.slice(0, 60)}${tool.description.length > 60 ? '…' : ''}${suffix}`,
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      iconPath: new vscode.ThemeIcon('symbol-function'),
      contextValue: 'rorcaMcpTool',
      // tooltip is populated lazily via resolveTreeItem
      accessibilityInformation: {
        label: `${tool.name}, ${tool.category}`,
      },
      command: {
        // Double-click fires insertAtCursor; single-click just selects
        command: 'rorca.insertAtCursor',
        title: 'Insert at Cursor',
        arguments: [{ kind: 'tool', tool } as RorcaTreeItem],
      },
    };
    return node;
  }

  private buildOfflineItem(): RorcaTreeItem {
    const apiUrl = getApiUrl();
    return {
      kind: 'offline',
      label: '⚠ Rorca server offline',
      description: 'click to start',
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      iconPath: new vscode.ThemeIcon('warning'),
      contextValue: 'rorcaOffline',
      tooltip: `The Rorca backend is not reachable at ${apiUrl}`,
      command: {
        command: 'rorca.startServer',
        title: 'Start Rorca Server',
        arguments: [],
      },
    };
  }

  private buildEmptyItem(): RorcaTreeItem {
    return {
      kind: 'offline',
      label: 'No MCP tools found. Is the Rorca server running?',
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      iconPath: new vscode.ThemeIcon('info'),
      contextValue: '',
    };
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function apiGet<T>(path: string, baseUrl?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const base = baseUrl ?? getApiUrl();
    const url = new URL(path, base);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const port = Number(url.port) || (isHttps ? 443 : 3030);
    const req = transport.get(
      { hostname: url.hostname, port, path: url.pathname + url.search, timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode === 401) {
            reject(new Error('AUTH_REQUIRED'));
            return;
          }
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch {
            reject(new Error('Invalid JSON from server'));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('ECONNREFUSED')); });
  });
}

interface HealthResponse {
  version?: string;
  status?: string;
}

async function checkHealth(apiUrl?: string): Promise<boolean> {
  try {
    await apiGet<unknown>('/api/health', apiUrl);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return !msg.includes('ECONNREFUSED') && !msg.includes('ENOTFOUND') && !msg.includes('ECONNRESET');
  }
}

// ─── Extension entry points ───────────────────────────────────────────────────

// Module-level state for public API
let _currentApiUrl = 'http://localhost:3030';
let _serverOnline = false;

export async function activate(context: vscode.ExtensionContext): Promise<RorcaPublicApi> {
  void vscode.commands.executeCommand('setContext', 'rorca.extensionActive', true);
  void vscode.commands.executeCommand('setContext', 'rorca.serverOnline', false);

  _currentApiUrl = getApiUrl();

  // ── Validate initial settings ─────────────────────────────────────────────
  if (!isValidUrl(_currentApiUrl)) {
    void vscode.window.showWarningMessage(
      `Rorca: rorca.apiUrl '${_currentApiUrl}' is invalid. Must start with http:// or https://. Using http://localhost:3030.`,
    );
    _currentApiUrl = 'http://localhost:3030';
  }

  const initialRefreshInterval = getAutoRefreshInterval();
  if (initialRefreshInterval > 3600) {
    void vscode.window.showWarningMessage('Rorca: autoRefreshInterval must be between 0 and 3600 seconds');
  }

  // ── Status bar item ──────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = '○ Rorca';
  statusBar.color = new vscode.ThemeColor('statusBarItem.warningForeground');
  statusBar.tooltip = 'Rorca — server offline. Click to open MCP Tools.';
  statusBar.command = 'rorca.openMcpPanel';

  if (getShowStatusBarItem()) {
    statusBar.show();
  }
  context.subscriptions.push(statusBar);

  // ── Tree view provider ───────────────────────────────────────────────────
  const provider = new RorcaMcpToolsProvider();
  const treeView = vscode.window.registerTreeDataProvider('rorcaMcpTools', provider);
  context.subscriptions.push(treeView);

  // ── Health polling ───────────────────────────────────────────────────────
  let previousOnline = false;

  async function pollHealth(): Promise<void> {
    const online = await checkHealth(_currentApiUrl);
    _serverOnline = online;
    if (online !== previousOnline) {
      previousOnline = online;
      provider.setServerOnline(online);
      void vscode.commands.executeCommand('setContext', 'rorca.serverOnline', online);
      if (online) {
        statusBar.text = '● Rorca';
        statusBar.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
        statusBar.tooltip = 'Rorca — server online. Click to open MCP Tools.';
      } else {
        statusBar.text = '○ Rorca';
        statusBar.color = new vscode.ThemeColor('statusBarItem.warningForeground');
        statusBar.tooltip = 'Rorca — server offline. Click to open MCP Tools.';
      }
    }
  }

  // First health check within 5s of activation
  void pollHealth();
  const healthTimer = setInterval(() => { void pollHealth(); }, HEALTH_POLL_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(healthTimer) });

  // Auto-refresh tools
  provider.startAutoRefresh(getAutoRefreshInterval());
  context.subscriptions.push({ dispose: () => provider.stopAutoRefresh() });
  context.subscriptions.push({ dispose: () => provider.dispose() });

  // ── Configuration change listener ─────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('rorca.apiUrl')) {
        const newUrl = getApiUrl();
        if (!isValidUrl(newUrl)) {
          void vscode.window.showWarningMessage(
            `Rorca: rorca.apiUrl '${newUrl}' is invalid. Must start with http:// or https://.`,
          );
          return;
        }
        _currentApiUrl = newUrl;
        // Re-fetch tools with new URL
        provider.refresh();
        void pollHealth();
      }

      if (e.affectsConfiguration('rorca.autoRefreshInterval')) {
        const secs = getAutoRefreshInterval();
        if (secs > 3600) {
          void vscode.window.showWarningMessage('Rorca: autoRefreshInterval must be between 0 and 3600 seconds');
          return;
        }
        provider.startAutoRefresh(secs);
      }

      if (e.affectsConfiguration('rorca.showStatusBarItem')) {
        if (getShowStatusBarItem()) {
          statusBar.show();
        } else {
          statusBar.hide();
        }
      }
    }),
  );

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('rorca.openMcpPanel', () => {
      void vscode.commands.executeCommand('rorcaMcpTools.focus');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('rorca.refreshMcpTools', async () => {
      provider.refresh();
      // Wait for fetch to complete then show message
      await new Promise(r => setTimeout(r, 800));
      const count = (provider as unknown as { tools: McpToolDef[] }).tools?.length ?? 0;
      void vscode.window.showInformationMessage(`Rorca: MCP tools refreshed (${count} tools)`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('rorca.copyToolName', (item?: RorcaTreeItem) => {
      const toolName = item?.tool?.name;
      if (!toolName) {
        return;
      }
      void vscode.env.clipboard.writeText(toolName).then(() => {
        void vscode.window.showInformationMessage(`Copied ${toolName} to clipboard`);
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('rorca.insertAtCursor', (item?: RorcaTreeItem) => {
      const tool = item?.tool;
      if (!tool) {
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('Open a file to insert the tool name');
        return;
      }
      const text = buildInsertText(tool, getInsertSyntax());
      void editor.edit(eb => eb.insert(editor.selection.active, text));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('rorca.copyAsMcpCall', (item?: RorcaTreeItem) => {
      const tool = item?.tool;
      if (!tool) {
        return;
      }
      const call = JSON.stringify(
        {
          tool: tool.name,
          params: Object.fromEntries(tool.requiredParams.map(p => [p, ''])),
        },
        null,
        2,
      );
      void vscode.env.clipboard.writeText(call).then(() => {
        void vscode.window.showInformationMessage(`Copied MCP call for ${tool.name} to clipboard`);
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('rorca.viewDocumentation', (item?: RorcaTreeItem) => {
      const category = item?.tool?.category ?? '';
      const tag = CATEGORY_DOC_TAG[category] ?? 'MCP';
      const docUrl = `${_currentApiUrl}/api/docs#tag/${tag}`;
      void vscode.env.openExternal(vscode.Uri.parse(docUrl));
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('rorca.startServer', () => {
      // Open a terminal and run the start command — user must have rorca installed
      const terminal = vscode.window.createTerminal('Rorca');
      terminal.show();
      terminal.sendText('npm run dev', false);
      void vscode.window.showInformationMessage('Rorca: starting server in terminal (npm run dev)');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('rorca.testConnection', async () => {
      const url = _currentApiUrl;
      try {
        const result = await apiGet<HealthResponse>('/api/health', url);
        const version = result?.version ?? '1.x.x';
        const action = await vscode.window.showInformationMessage(
          `Rorca server is online (v${version})`,
          'Change Server URL',
        );
        if (action === 'Change Server URL') {
          void vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'rorca.apiUrl',
          );
        }
      } catch {
        void vscode.window.showErrorMessage(
          `Cannot connect to Rorca at ${url}. Check rorca.apiUrl in settings.`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('rorca.forgeFromSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showWarningMessage('Rorca: Open a file and select text to forge from selection');
        return;
      }
      const selection = editor.document.getText(editor.selection);
      if (!selection.trim()) {
        void vscode.window.showWarningMessage('Rorca: Select some text first to use as the spec brief');
        return;
      }
      const terminal = vscode.window.createTerminal('Rorca Forge');
      terminal.show();
      // Escape single quotes in the selection for shell safety
      const escaped = selection.replace(/'/g, "'\\''");
      const workspacePath = getConfig().get<string>('defaultWorkspacePath', '');
      const workspaceArg = workspacePath ? ` --workspace '${workspacePath}'` : '';
      terminal.sendText(`rorca forge --brief '${escaped}'${workspaceArg}`, false);
    }),
  );

  // ── Public API ────────────────────────────────────────────────────────────

  const publicApi: RorcaPublicApi = {
    getServerUrl: () => _currentApiUrl,
    isServerOnline: () => _serverOnline,
  };

  return publicApi;
}

export function deactivate(): void {
  // All disposables are registered in context.subscriptions — VS Code cleans them up.
  // Explicit disposal not needed here; nothing leaks.
}
