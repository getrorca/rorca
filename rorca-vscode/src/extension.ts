import * as vscode from 'vscode';
import { McpToolsProvider } from './mcpToolsProvider';
import {
  SpecTreeDataProvider,
  SpecTreeItem,
  cmdApproveSpec,
  cmdCopySpecJson,
  cmdForgeFromSelection,
  cmdOpenInBrowser,
  cmdTriggerRun,
} from './specProvider';

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  // ── Providers ──────────────────────────────────────────────────────────────
  const specProvider = new SpecTreeDataProvider();
  const mcpProvider = new McpToolsProvider();

  vscode.window.registerTreeDataProvider('rorcaSpecs', specProvider);
  vscode.window.registerTreeDataProvider('rorcaMcpTools', mcpProvider);

  // ── Commands ───────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('rorca.refreshSpecs', () => {
      specProvider.refresh();
    }),

    vscode.commands.registerCommand('rorca.refreshMcpTools', () => {
      mcpProvider.refresh();
    }),

    vscode.commands.registerCommand('rorca.approveSpec', (item: SpecTreeItem) => {
      void cmdApproveSpec(item, specProvider);
    }),

    vscode.commands.registerCommand('rorca.triggerRun', (item: SpecTreeItem) => {
      void cmdTriggerRun(item, specProvider);
    }),

    vscode.commands.registerCommand('rorca.openInBrowser', (item: SpecTreeItem) => {
      void cmdOpenInBrowser(item);
    }),

    vscode.commands.registerCommand('rorca.copySpecJson', (item: SpecTreeItem) => {
      void cmdCopySpecJson(item);
    }),

    vscode.commands.registerCommand('rorca.forgeFromSelection', () => {
      void cmdForgeFromSelection(specProvider);
    }),

    vscode.commands.registerCommand('rorca.testConnection', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }),

    vscode.commands.registerCommand('rorca.startServer', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    })
  );

  // ── Status bar ─────────────────────────────────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(circle-outline) Rorca';
  statusBarItem.tooltip = 'Rorca: Disconnected';
  statusBarItem.command = 'rorca.testConnection';
  context.subscriptions.push(statusBarItem);
  statusBarItem.show();

  // Dispose provider on deactivate
  context.subscriptions.push({ dispose: () => specProvider.dispose() });
}

export function deactivate(): void {
  // Cleanup handled by context.subscriptions disposal
}
