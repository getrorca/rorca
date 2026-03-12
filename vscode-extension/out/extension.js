"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getServerUrl = getServerUrl;
exports.isServerOnline = isServerOnline;
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const http = __importStar(require("http"));
const https = __importStar(require("https"));
/** Categories with their default collapse state */
const CATEGORY_COLLAPSED_BY_DEFAULT = new Set(['Memory', 'Direction Stack']);
// ─── Settings helpers ─────────────────────────────────────────────────────────
function getConfig() {
    return vscode.workspace.getConfiguration('rorca');
}
function getApiUrl() {
    return getConfig().get('apiUrl', 'http://localhost:3030');
}
function getAutoRefreshInterval() {
    return getConfig().get('autoRefreshInterval', 60);
}
function getShowStatusBarItem() {
    return getConfig().get('showStatusBarItem', true);
}
function getInsertSyntax() {
    return getConfig().get('insertSyntax', 'name-only');
}
function isValidUrl(url) {
    return url.startsWith('http://') || url.startsWith('https://');
}
class CategoryTreeItem extends vscode.TreeItem {
    constructor(categoryName, toolCount) {
        super(categoryName, CATEGORY_COLLAPSED_BY_DEFAULT.has(categoryName)
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.Expanded);
        this.categoryName = categoryName;
        this.toolCount = toolCount;
        this.kind = 'category';
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
    constructor(tool) {
        super(tool.name, vscode.TreeItemCollapsibleState.None);
        this.tool = tool;
        this.kind = 'tool';
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
    constructor() {
        super('⚠ Rorca server offline', vscode.TreeItemCollapsibleState.None);
        this.kind = 'offline';
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
    constructor() {
        super('No MCP tools found. Is the Rorca server running?', vscode.TreeItemCollapsibleState.None);
        this.kind = 'empty';
        this.iconPath = new vscode.ThemeIcon('info');
    }
}
class CachedToolTreeItem extends vscode.TreeItem {
    constructor(tool) {
        super(tool.name, vscode.TreeItemCollapsibleState.None);
        this.tool = tool;
        this.kind = 'tool';
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
class RorcaMcpToolsProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.tools = [];
        this.cachedTools = [];
        this.isOnline = false;
        this.lastFetch = 0;
        // Track last single click time for double-click detection
        this.lastClickTime = 0;
        this.lastClickedTool = null;
    }
    getTreeItem(element) {
        return element;
    }
    getChildren(element) {
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
            return categoryTools.map(t => this.isOnline ? new ToolTreeItem(t) : new CachedToolTreeItem(t));
        }
        return [];
    }
    buildCategoryItems(toolList, _cached) {
        const categoryMap = new Map();
        for (const t of toolList) {
            categoryMap.set(t.category, (categoryMap.get(t.category) ?? 0) + 1);
        }
        return Array.from(categoryMap.entries()).map(([name, count]) => new CategoryTreeItem(name, count));
    }
    resolveTreeItem(item, element) {
        if (element.kind !== 'tool')
            return item;
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
        md.appendCodeblock(JSON.stringify({ tool: tool.name, params: Object.fromEntries(tool.requiredParams.map(p => [p, ''])) }, null, 2), 'json');
        item.tooltip = md;
        return item;
    }
    async fetchTools() {
        try {
            const data = await this.httpGet('/api/mcp/tools');
            this.tools = data.tools;
            if (data.tools.length > 0) {
                this.cachedTools = data.tools;
            }
            this.setOnline(true);
            this.lastFetch = Date.now();
            vscode.commands.executeCommand('setContext', 'rorca.toolsLoaded', true);
        }
        catch {
            this.setOnline(false);
            this.tools = [];
        }
        this._onDidChangeTreeData.fire(undefined);
    }
    setOnline(online) {
        const changed = this.isOnline !== online;
        this.isOnline = online;
        if (changed) {
            this._onDidChangeTreeData.fire(undefined);
        }
    }
    refresh() {
        this._onDidChangeTreeData.fire(undefined);
    }
    dispose() {
        this._onDidChangeTreeData.dispose();
    }
    handleToolClick(tool) {
        const now = Date.now();
        const isDoubleClick = now - this.lastClickTime < 500 && this.lastClickedTool?.name === tool.name;
        this.lastClickTime = now;
        this.lastClickedTool = tool;
        if (isDoubleClick) {
            // Double-click → insert at cursor using configured syntax
            insertAtCursorWithSyntax(tool);
        }
        // Single click → no-op (just selection)
    }
    httpGet(path) {
        const apiUrl = getApiUrl();
        const fullUrl = `${apiUrl}${path}`;
        const isHttps = fullUrl.startsWith('https://');
        const lib = isHttps ? https : http;
        return new Promise((resolve, reject) => {
            const req = lib.get(fullUrl, (res) => {
                if (res.statusCode === 401) {
                    reject(new Error('UNAUTHORIZED'));
                    return;
                }
                if (!res.statusCode || res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}`));
                    return;
                }
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString()));
                    }
                    catch (e) {
                        reject(e);
                    }
                });
            });
            req.on('error', reject);
            req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
        });
    }
    getIsOnline() { return this.isOnline; }
    getApi() { return getApiUrl(); }
}
// ─── Helpers ──────────────────────────────────────────────────────────────────
function buildInsertText(tool) {
    const syntax = getInsertSyntax();
    if (syntax === 'json-call') {
        return JSON.stringify({ tool: tool.name, params: Object.fromEntries(tool.requiredParams.map(p => [p, ''])) }, null, 2);
    }
    if (syntax === 'slash-command') {
        const args = tool.requiredParams.map(p => p).join(' ');
        return `/mcp__rorca__${tool.name}${args ? ' ' + args : ''}`;
    }
    // default: name-only
    return tool.name;
}
function insertAtCursorWithSyntax(tool) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Open a file to insert the tool name');
        return;
    }
    const text = buildInsertText(tool);
    editor.edit(editBuilder => {
        editBuilder.insert(editor.selection.active, text);
    });
}
function insertAtCursor(text) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Open a file to insert the tool name');
        return;
    }
    editor.edit(editBuilder => {
        editBuilder.insert(editor.selection.active, text);
    });
}
// ─── Public API ───────────────────────────────────────────────────────────────
let _serverOnline = false;
function getServerUrl() {
    return getApiUrl();
}
function isServerOnline() {
    return _serverOnline;
}
// ─── Activation ───────────────────────────────────────────────────────────────
function activate(context) {
    // Validate settings on activation
    const initialApiUrl = getApiUrl();
    if (!isValidUrl(initialApiUrl)) {
        vscode.window.showWarningMessage(`Rorca: rorca.apiUrl must start with http:// or https://. Current value: "${initialApiUrl}"`);
    }
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
    // Show/hide based on setting
    if (getShowStatusBarItem()) {
        statusBar.show();
    }
    else {
        statusBar.hide();
    }
    context.subscriptions.push(statusBar);
    function updateStatusBar(online) {
        if (online) {
            statusBar.text = '● Rorca';
            statusBar.color = new vscode.ThemeColor('charts.green');
            statusBar.tooltip = 'Rorca — server online. Click to open MCP Tools panel.';
        }
        else {
            statusBar.text = '○ Rorca';
            statusBar.color = new vscode.ThemeColor('charts.yellow');
            statusBar.tooltip = 'Rorca — server offline. Click to open MCP Tools panel.';
        }
        _serverOnline = online;
        vscode.commands.executeCommand('setContext', 'rorca.serverOnline', online);
    }
    // ─── Configuration change listener ────────────────────────────────────────
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration('rorca.apiUrl')) {
            const newUrl = getApiUrl();
            if (!isValidUrl(newUrl)) {
                vscode.window.showWarningMessage(`Rorca: rorca.apiUrl must start with http:// or https://. Current value: "${newUrl}"`);
            }
            else {
                // Re-fetch tools with new URL
                await provider.fetchTools();
            }
        }
        if (e.affectsConfiguration('rorca.autoRefreshInterval')) {
            const interval = getAutoRefreshInterval();
            if (interval > 3600) {
                vscode.window.showWarningMessage('Rorca: autoRefreshInterval must be between 0 and 3600 seconds');
            }
            // Restart auto-refresh with new interval
            restartAutoRefresh();
        }
        if (e.affectsConfiguration('rorca.showStatusBarItem')) {
            if (getShowStatusBarItem()) {
                statusBar.show();
            }
            else {
                statusBar.hide();
            }
        }
    }));
    // ─── Health poll ──────────────────────────────────────────────────────────
    let previousOnline = null;
    async function pollHealth() {
        try {
            await provider.httpGet('/api/health');
            const isOnline = true;
            if (isOnline !== previousOnline) {
                previousOnline = isOnline;
                updateStatusBar(true);
                provider.setOnline(true);
                // Server came back online — refresh tools
                await provider.fetchTools();
            }
        }
        catch (err) {
            const isUnauth = err instanceof Error && err.message === 'UNAUTHORIZED';
            const isOnline = false;
            if (isOnline !== previousOnline) {
                previousOnline = isOnline;
                updateStatusBar(false);
                provider.setOnline(false);
                provider.refresh();
            }
            if (isUnauth) {
                // Auth tree item rendered via offline state + contextValue handling
                void isUnauth; // handled via tree display
            }
        }
    }
    // Initial poll + fetch
    void pollHealth().then(() => {
        if (provider.getIsOnline()) {
            return provider.fetchTools();
        }
    });
    const healthInterval = setInterval(() => void pollHealth(), 30000);
    context.subscriptions.push({ dispose: () => clearInterval(healthInterval) });
    // ─── Auto-refresh (restartable when interval changes) ────────────────────
    let autoRefreshTimer = null;
    function restartAutoRefresh() {
        if (autoRefreshTimer !== null) {
            clearInterval(autoRefreshTimer);
            autoRefreshTimer = null;
        }
        const intervalSec = getAutoRefreshInterval();
        if (intervalSec > 0) {
            autoRefreshTimer = setInterval(() => {
                if (provider.getIsOnline()) {
                    void provider.fetchTools();
                }
            }, intervalSec * 1000);
        }
    }
    restartAutoRefresh();
    context.subscriptions.push({ dispose: () => { if (autoRefreshTimer !== null)
            clearInterval(autoRefreshTimer); } });
    // ─── Commands ──────────────────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('rorca.refreshMcpTools', async () => {
        if (!provider.getIsOnline()) {
            vscode.window.showWarningMessage('Rorca server is offline. Start the server first.');
            return;
        }
        await provider.fetchTools();
        vscode.window.showInformationMessage('Rorca: MCP tools refreshed');
    }), vscode.commands.registerCommand('rorca.startServer', () => {
        // Open a terminal and guide user to start the server
        const terminal = vscode.window.createTerminal('Rorca Server');
        terminal.sendText('# Start the Rorca backend server:');
        terminal.sendText('# cd /path/to/rorca && npm run dev');
        terminal.show();
    }), vscode.commands.registerCommand('rorca.openToolsPanel', () => {
        vscode.commands.executeCommand('rorcaMcpTools.focus');
    }), vscode.commands.registerCommand('rorca.copyToolName', async (item) => {
        if (!item?.tool)
            return;
        await vscode.env.clipboard.writeText(item.tool.name);
        vscode.window.showInformationMessage(`Copied ${item.tool.name} to clipboard`);
    }), vscode.commands.registerCommand('rorca.insertAtCursor', (item) => {
        if (!item?.tool)
            return;
        insertAtCursorWithSyntax(item.tool);
    }), vscode.commands.registerCommand('rorca.copyAsMcpCall', async (item) => {
        if (!item?.tool)
            return;
        const { tool } = item;
        const mcpCall = JSON.stringify({
            tool: tool.name,
            params: Object.fromEntries(tool.requiredParams.map(p => [p, ''])),
        }, null, 2);
        await vscode.env.clipboard.writeText(mcpCall);
        vscode.window.showInformationMessage(`Copied MCP call for ${tool.name} to clipboard`);
    }), vscode.commands.registerCommand('rorca.viewDocumentation', (item) => {
        if (!item?.tool)
            return;
        const category = encodeURIComponent(item.tool.category);
        const docsUrl = `${provider.getApi()}/api/docs#tag/${category}`;
        void vscode.env.openExternal(vscode.Uri.parse(docsUrl));
    }), 
    // Internal: handle single/double click on tool items
    vscode.commands.registerCommand('rorca._selectTool', (tool) => {
        provider.handleToolClick(tool);
    }), 
    // Test connection command
    vscode.commands.registerCommand('rorca.testConnection', async () => {
        const apiUrl = getApiUrl();
        if (!isValidUrl(apiUrl)) {
            vscode.window.showErrorMessage(`Cannot connect to Rorca at ${apiUrl}. Check rorca.apiUrl in settings.`);
            return;
        }
        try {
            const health = await provider.httpGet('/api/health');
            const version = health.version ?? '1.x.x';
            const choice = await vscode.window.showInformationMessage(`Rorca server is online (v${version})`, 'Change Server URL');
            if (choice === 'Change Server URL') {
                await vscode.commands.executeCommand('workbench.action.openSettings', 'rorca.apiUrl');
            }
        }
        catch {
            vscode.window.showErrorMessage(`Cannot connect to Rorca at ${apiUrl}. Check rorca.apiUrl in settings.`);
        }
    }), 
    // Forge from selection command
    vscode.commands.registerCommand('rorca.forgeFromSelection', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor');
            return;
        }
        const selection = editor.document.getText(editor.selection);
        if (!selection) {
            vscode.window.showWarningMessage('No text selected');
            return;
        }
        const defaultWorkspacePath = getConfig().get('defaultWorkspacePath', '');
        const workspaceArg = defaultWorkspacePath ? ` --workspace "${defaultWorkspacePath}"` : '';
        const terminal = vscode.window.createTerminal('Rorca Forge');
        terminal.sendText(`rorca forge "${selection.replace(/"/g, '\\"')}"${workspaceArg}`);
        terminal.show();
    }), 
    // Run spec from explorer context menu
    vscode.commands.registerCommand('rorca.runSpec', (uri) => {
        if (!uri)
            return;
        const specPath = uri.fsPath;
        const defaultWorkspacePath = getConfig().get('defaultWorkspacePath', '');
        const workspaceArg = defaultWorkspacePath ? ` --workspace "${defaultWorkspacePath}"` : '';
        const terminal = vscode.window.createTerminal('Rorca Run');
        terminal.sendText(`rorca run --spec "${specPath}"${workspaceArg}`);
        terminal.show();
    }));
    context.subscriptions.push({ dispose: () => provider.dispose() });
    // Export public API
    return { getServerUrl, isServerOnline };
}
function deactivate() {
    // All disposables are registered via context.subscriptions and cleaned up automatically.
    // Intervals and event emitters are disposed via their context.subscriptions entries.
    vscode.commands.executeCommand('setContext', 'rorca.extensionActive', false);
    _serverOnline = false;
}
//# sourceMappingURL=extension.js.map