import * as vscode from 'vscode';
import * as http from 'http';

// ─── Types ────────────────────────────────────────────────────────────────────

interface McpToolDef {
  name: string;
  description: string;
  category: string;
  inputSchema: Record<string, { type: string; description: string }>;
  requiredParams: string[];
}

interface McpToolsResponse {
  tools: McpToolDef[];
  total: number;
  categories: Array<{ name: string; count: number }>;
}

/** Categories with their default collapse state */
const CATEGORY_COLLAPSED_BY_DEFAULT = new Set(['Memory', 'Direction Stack']);

// ─── Tree item types ───────────────────────────────────────────────────────────

type RorcaTreeItem = CategoryTreeItem | ToolTreeItem | OfflineTreeItem | EmptyTreeItem;

class CategoryTreeItem extends vscode.TreeItem {
  readonly kind = 'category' as const;
  constructor(
    public readonly categoryName: string,
    public readonly toolCount: number,
  ) {
    super(
      categoryName,
      CATEGORY_COLLAPSED_BY_DEFAULT.has(categoryName)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded,
    );
    this.description = `${toolCount} tool${toolCount === 1 ? '' : 's'}`;
    this.iconPath = new vscode.ThemeIcon('folder');
    this.tooltip = `${categoryName} — ${toolCount} tool${toolCount === 1 ? '' : 's'}`;
    this.accessibilityInformation = {
      label: `${categoryName} category, ${toolCount} tools`,
      role: 'treeitem',
    };
  }
}

class ToolTreeItem extends vscode.TreeItem {
  readonly kind = 'tool' as const;
  constructor(public readonly tool: McpToolDef) {
    super(tool.name, vscode.TreeItemCollapsibleState.None);
    const requiredCount = tool.requiredParams.length;
    this.description = `· ${requiredCount} required param${requiredCount === 1 ? '' : 's'}`;
    this.iconPath = new vscode.ThemeIcon('symbol-function');
    this.contextValue = 'rorcaMcpTool';
    this.accessibilityInformation = {
      label: `${tool.name} ${tool.category}`,
      role: 'treeitem',
    };
    // Double-click triggers insert — handled via command binding
    this.command = {
      command: 'rorca._selectTool',
      title: 'Select Tool',
      arguments: [tool],
    };
  }
}

class OfflineTreeItem extends vscode.TreeItem {
  readonly kind = 'offline' as const;
  constructor() {
    super('⚠ Rorca server offline', vscode.TreeItemCollapsibleState.None);
    this.description = 'click to start';
    this.contextValue = 'rorcaOffline';
    this.iconPath = new vscode.ThemeIcon('warning');
    this.command = {
      command: 'rorca.startServer',
      title: 'Start Rorca Server',
    };
  }
}

class EmptyTreeItem extends vscode.TreeItem {
  readonly kind = 'empty' as const;
  constructor() {
    super('No MCP tools found. Is the Rorca server running?', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

class CachedToolTreeItem extends vscode.TreeItem {
  readonly kind = 'tool' as const;
  constructor(public readonly tool: McpToolDef) {
    super(tool.name, vscode.TreeItemCollapsibleState.None);
    const requiredCount = tool.requiredParams.length;
    this.description = `· ${requiredCount} required param${requiredCount === 1 ? '' : 's'} (cached)`;
    this.iconPath = new vscode.ThemeIcon('symbol-function');
    this.contextValue = 'rorcaMcpTool';
    this.accessibilityInformation = {
      label: `${tool.name} ${tool.category} (cached)`,
      role: 'treeitem',
    };
    this.command = {
      command: 'rorca._selectTool',
      title: 'Select Tool',
      arguments: [tool],
    };
  }
}

// ─── TreeDataProvider ─────────────────────────────────────────────────────────

class RorcaMcpToolsProvider implements vscode.TreeDataProvider<RorcaTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RorcaTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private tools: McpToolDef[] = [];
  private cachedTools: McpToolDef[] = [];
  private isOnline = false;
  private lastFetch = 0;

  private readonly RORCA_API = 'http://localhost:3030';

  // Track last single click time for double-click detection
  private lastClickTime = 0;
  private lastClickedTool: McpToolDef | null = null;

  getTreeItem(element: RorcaTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: RorcaTreeItem): RorcaTreeItem[] {
    if (!element) {
      // Root level
      if (!this.isOnline && this.cachedTools.length === 0) {
        return [new OfflineTreeItem()];
      }

      const toolList = this.isOnline ? this.tools : this.cachedTools;

      if (!this.isOnline && this.cachedTools.length > 0) {
        // Show offline item + cached categories
        const offlineItem = new OfflineTreeItem();
        const categories = this.buildCategoryItems(toolList, true);
        return [offlineItem, ...categories];
      }

      if (toolList.length === 0) {
        return [new EmptyTreeItem()];
      }

      return this.buildCategoryItems(toolList, false);
    }

    if (element.kind === 'category') {
      const toolList = this.isOnline ? this.tools : this.cachedTools;
      const categoryTools = toolList.filter(t => t.category === element.categoryName);
      return categoryTools.map(t =>
        this.isOnline ? new ToolTreeItem(t) : new CachedToolTreeItem(t),
      );
    }

    return [];
  }

  private buildCategoryItems(toolList: McpToolDef[], _cached: boolean): CategoryTreeItem[] {
    const categoryMap = new Map<string, number>();
    for (const t of toolList) {
      categoryMap.set(t.category, (categoryMap.get(t.category) ?? 0) + 1);
    }
    return Array.from(categoryMap.entries()).map(([name, count]) => new CategoryTreeItem(name, count));
  }

  resolveTreeItem(item: vscode.TreeItem, element: RorcaTreeItem): vscode.ProviderResult<vscode.TreeItem> {
    if (element.kind !== 'tool') return item;
    const tool = element.tool;
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`**${tool.name}**\n\n`);
    md.appendMarkdown(`${tool.description}\n\n`);
    if (tool.requiredParams.length > 0) {
      md.appendMarkdown(`**Required parameters:**\n`);
      for (const p of tool.requiredParams) {
        const schema = tool.inputSchema[p];
        md.appendMarkdown(`- \`${p}\`: ${schema?.description ?? ''}\n`);
      }
      md.appendMarkdown('\n');
    }
    md.appendMarkdown(`**Example call:**\n`);
    md.appendCodeblock(
      JSON.stringify({ tool: tool.name, params: Object.fromEntries(tool.requiredParams.map(p => [p, ''])) }, null, 2),
      'json',
    );
    item.tooltip = md;
    return item;
  }

  async fetchTools(): Promise<void> {
    try {
      const data = await this.httpGet<McpToolsResponse>('/api/mcp/tools');
      this.tools = data.tools;
      if (data.tools.length > 0) {
        this.cachedTools = data.tools;
      }
      this.setOnline(true);
      this.lastFetch = Date.now();
      vscode.commands.executeCommand('setContext', 'rorca.toolsLoaded', true);
    } catch {
      this.setOnline(false);
      this.tools = [];
    }
    this._onDidChangeTreeData.fire(undefined);
  }

  setOnline(online: boolean): void {
    const changed = this.isOnline !== online;
    this.isOnline = online;
    if (changed) {
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }

  handleToolClick(tool: McpToolDef): void {
    const now = Date.now();
    const isDoubleClick = now - this.lastClickTime < 500 && this.lastClickedTool?.name === tool.name;
    this.lastClickTime = now;
    this.lastClickedTool = tool;

    if (isDoubleClick) {
      // Double-click → insert at cursor
      insertAtCursor(tool.name);
    }
    // Single click → no-op (just selection)
  }

  private httpGet<T>(path: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = http.get(`${this.RORCA_API}${path}`, (res) => {
        if (res.statusCode === 401) {
          reject(new Error('UNAUTHORIZED'));
          return;
        }
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()) as T);
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }

  getIsOnline(): boolean { return this.isOnline; }
  getApi(): string { return this.RORCA_API; }

  httpGetPublic<T>(path: string): Promise<T> { return this.httpGet<T>(path); }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function insertAtCursor(text: string): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Open a file to insert the tool name');
    return;
  }
  editor.edit(editBuilder => {
    editBuilder.insert(editor.selection.active, text);
  });
}

// ─── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // Set initial context flags
  vscode.commands.executeCommand('setContext', 'rorca.extensionActive', true);
  vscode.commands.executeCommand('setContext', 'rorca.serverOnline', false);
  vscode.commands.executeCommand('setContext', 'rorca.toolsLoaded', false);

  const provider = new RorcaMcpToolsProvider();

  // Register tree data provider
  const treeDisposable = vscode.window.registerTreeDataProvider('rorcaMcpTools', provider);
  context.subscriptions.push(treeDisposable);

  // ─── Status bar ───────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBar.command = 'rorca.openToolsPanel';
  statusBar.text = '○ Rorca';
  statusBar.color = new vscode.ThemeColor('charts.yellow');
  statusBar.tooltip = 'Rorca — server offline. Click to open MCP Tools panel.';
  statusBar.show();
  context.subscriptions.push(statusBar);

  function updateStatusBar(online: boolean): void {
    if (online) {
      statusBar.text = '● Rorca';
      statusBar.color = new vscode.ThemeColor('charts.green');
      statusBar.tooltip = 'Rorca — server online. Click to open MCP Tools panel.';
    } else {
      statusBar.text = '○ Rorca';
      statusBar.color = new vscode.ThemeColor('charts.yellow');
      statusBar.tooltip = 'Rorca — server offline. Click to open MCP Tools panel.';
    }
    vscode.commands.executeCommand('setContext', 'rorca.serverOnline', online);
  }

  // ─── Health poll ──────────────────────────────────────────────────────────
  let previousOnline: boolean | null = null;

  async function pollHealth(): Promise<void> {
    try {
      await provider.httpGetPublic<{ status: string }>('/api/health');
      const isOnline = true;
      if (isOnline !== previousOnline) {
        previousOnline = isOnline;
        updateStatusBar(true);
        provider.setOnline(true);
        // Server came back online — refresh tools
        await provider.fetchTools();
      }
    } catch (err: unknown) {
      const isUnauth = err instanceof Error && err.message === 'UNAUTHORIZED';
      const isOnline = false;
      if (isOnline !== previousOnline) {
        previousOnline = isOnline;
        updateStatusBar(false);
        provider.setOnline(false);
        provider.refresh();
      }
      if (isUnauth) {
        // 401 — show auth warning in tree
        showAuthWarning();
      }
    }
  }

  function showAuthWarning(): void {
    // Auth tree item rendered via offline state + contextValue handling
    // The tree will show offline item which guides user
  }

  // Initial poll + fetch
  void pollHealth().then(() => {
    if (provider.getIsOnline()) {
      return provider.fetchTools();
    }
  });

  const healthInterval = setInterval(() => void pollHealth(), 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(healthInterval) });

  // Auto-refresh tools every 60 seconds if online
  const autoRefreshInterval = setInterval(() => {
    if (provider.getIsOnline()) {
      void provider.fetchTools();
    }
  }, 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(autoRefreshInterval) });

  // ─── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('rorca.refreshMcpTools', async () => {
      if (!provider.getIsOnline()) {
        vscode.window.showWarningMessage('Rorca server is offline. Start the server first.');
        return;
      }
      await provider.fetchTools();
      const toolCount = provider.getIsOnline() ? 0 : 0; // count from provider internal
      vscode.window.showInformationMessage('Rorca: MCP tools refreshed');
    }),

    vscode.commands.registerCommand('rorca.startServer', () => {
      // Open a terminal and guide user to start the server
      const terminal = vscode.window.createTerminal('Rorca Server');
      terminal.sendText('# Start the Rorca backend server:');
      terminal.sendText('# cd /path/to/rorca && npm run dev');
      terminal.show();
    }),

    vscode.commands.registerCommand('rorca.openToolsPanel', () => {
      vscode.commands.executeCommand('rorcaMcpTools.focus');
    }),

    vscode.commands.registerCommand('rorca.copyToolName', async (item: ToolTreeItem | CachedToolTreeItem) => {
      if (!item?.tool) return;
      await vscode.env.clipboard.writeText(item.tool.name);
      vscode.window.showInformationMessage(`Copied ${item.tool.name} to clipboard`);
    }),

    vscode.commands.registerCommand('rorca.insertAtCursor', (item: ToolTreeItem | CachedToolTreeItem) => {
      if (!item?.tool) return;
      insertAtCursor(item.tool.name);
    }),

    vscode.commands.registerCommand('rorca.copyAsMcpCall', async (item: ToolTreeItem | CachedToolTreeItem) => {
      if (!item?.tool) return;
      const { tool } = item;
      const mcpCall = JSON.stringify(
        {
          tool: tool.name,
          params: Object.fromEntries(tool.requiredParams.map(p => [p, ''])),
        },
        null,
        2,
      );
      await vscode.env.clipboard.writeText(mcpCall);
      vscode.window.showInformationMessage(`Copied MCP call for ${tool.name} to clipboard`);
    }),

    vscode.commands.registerCommand('rorca.viewDocumentation', (item: ToolTreeItem | CachedToolTreeItem) => {
      if (!item?.tool) return;
      const category = encodeURIComponent(item.tool.category);
      const docsUrl = `${provider.getApi()}/api/docs#tag/${category}`;
      void vscode.env.openExternal(vscode.Uri.parse(docsUrl));
    }),

    // Internal: handle single/double click on tool items
    vscode.commands.registerCommand('rorca._selectTool', (tool: McpToolDef) => {
      provider.handleToolClick(tool);
    }),
  );

  context.subscriptions.push({ dispose: () => provider.dispose() });
}

export function deactivate(): void {
  // All disposables are registered via context.subscriptions and cleaned up automatically.
  // Intervals and event emitters are disposed via their context.subscriptions entries.
  vscode.commands.executeCommand('setContext', 'rorca.extensionActive', false);
}
