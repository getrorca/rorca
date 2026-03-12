import * as vscode from 'vscode';
import { SpecTreeDataProvider } from './specProvider';
import { McpToolsProvider } from './mcpToolsProvider';

export function activate(context: vscode.ExtensionContext): void {
  const specProvider = new SpecTreeDataProvider();
  const mcpProvider = new McpToolsProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('rorcaSpecs', specProvider),
    vscode.window.registerTreeDataProvider('rorcaMcpTools', mcpProvider),
  );

  const commands: vscode.Disposable[] = [
    vscode.commands.registerCommand('rorca.refreshSpecs', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }),
    vscode.commands.registerCommand('rorca.refreshMcpTools', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }),
    vscode.commands.registerCommand('rorca.approveSpec', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }),
    vscode.commands.registerCommand('rorca.triggerRun', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }),
    vscode.commands.registerCommand('rorca.openInBrowser', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }),
    vscode.commands.registerCommand('rorca.copySpecJson', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }),
    vscode.commands.registerCommand('rorca.testConnection', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }),
    vscode.commands.registerCommand('rorca.startServer', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }),
    vscode.commands.registerCommand('rorca.forgeFromSelection', () => {
      vscode.window.showInformationMessage('Not yet implemented');
    }),
  ];

  context.subscriptions.push(...commands);

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(circle-outline) Rorca';
  statusBarItem.tooltip = 'Rorca: Disconnected';
  statusBarItem.command = 'rorca.testConnection';
  statusBarItem.show();

  context.subscriptions.push(statusBarItem);
}

export function deactivate(): void {
  // Cleanup is handled via context.subscriptions disposal
}
