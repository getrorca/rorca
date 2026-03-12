import * as vscode from 'vscode';
import { SpecTreeDataProvider } from './specProvider';
import { McpToolsProvider } from './mcpToolsProvider';

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  const specProvider = new SpecTreeDataProvider();
  const mcpProvider = new McpToolsProvider();

  vscode.window.registerTreeDataProvider('rorcaSpecs', specProvider);
  vscode.window.registerTreeDataProvider('rorcaMcpTools', mcpProvider);

  const commands: [string, () => void][] = [
    ['rorca.refreshSpecs', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }],
    ['rorca.refreshMcpTools', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }],
    ['rorca.approveSpec', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }],
    ['rorca.triggerRun', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }],
    ['rorca.openInBrowser', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }],
    ['rorca.copySpecJson', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }],
    ['rorca.testConnection', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }],
    ['rorca.startServer', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }],
    ['rorca.forgeFromSelection', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }],
  ];

  for (const [command, handler] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  }

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(circle-outline) Rorca';
  statusBarItem.tooltip = 'Rorca: Disconnected';
  statusBarItem.command = 'rorca.testConnection';
  context.subscriptions.push(statusBarItem);
  statusBarItem.show();
}

export function deactivate(): void {
  // Cleanup handled by context.subscriptions disposal
}
