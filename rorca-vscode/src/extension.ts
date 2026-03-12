import * as vscode from 'vscode';
import { SpecTreeDataProvider, SpecTreeItem } from './specProvider';
import { McpToolsProvider } from './mcpToolsProvider';
import {
  apiFetch,
  getServerUrl,
  initConfigWatcher,
  startHealthCheck,
  stopHealthCheck,
  RorcaApiError,
} from './auth';

export function activate(context: vscode.ExtensionContext): void {
  const specProvider = new SpecTreeDataProvider();
  const mcpProvider = new McpToolsProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('rorcaSpecs', specProvider),
    vscode.window.registerTreeDataProvider('rorcaMcpTools', mcpProvider),
  );

  // Status bar item — created early so startHealthCheck can reference it
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(circle-outline) Rorca: Disconnected';
  statusBarItem.tooltip = 'Rorca: Disconnected';
  statusBarItem.command = { command: 'workbench.action.openSettings', arguments: ['rorca'], title: 'Rorca Settings' };
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Wire up config watchers and start the health polling loop
  initConfigWatcher(context);
  startHealthCheck(statusBarItem);

  // --- rorca.refreshSpecs ---
  const refreshSpecs = vscode.commands.registerCommand('rorca.refreshSpecs', () => {
    specProvider.refresh();
  });

  // --- rorca.refreshMcpTools ---
  const refreshMcpTools = vscode.commands.registerCommand('rorca.refreshMcpTools', () => {
    mcpProvider.refresh();
  });

  // --- rorca.approveSpec ---
  const approveSpec = vscode.commands.registerCommand('rorca.approveSpec', async (item: SpecTreeItem) => {
    if (!item?.specId) {
      vscode.window.showErrorMessage('No spec selected');
      return;
    }
    try {
      await apiFetch(`/api/specs/${item.specId}/approve`, { method: 'POST' });
      vscode.window.showInformationMessage(`Spec approved: ${String(item.label)}`);
      specProvider.refresh();
    } catch (err: unknown) {
      if (err instanceof RorcaApiError && err.status === 409) {
        vscode.window.showWarningMessage('Spec is already approved');
      } else {
        vscode.window.showErrorMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  // --- rorca.triggerRun ---
  const triggerRun = vscode.commands.registerCommand('rorca.triggerRun', async (item: SpecTreeItem) => {
    if (!item?.specId) {
      vscode.window.showErrorMessage('No spec selected');
      return;
    }
    const workspaceId = vscode.workspace.getConfiguration('rorca').get<string>('defaultWorkspacePath', '');
    const trigger = async (queue?: boolean): Promise<void> => {
      const body: Record<string, unknown> = {
        specPath: `forge/specs/approved/${item.specId}.json`,
      };
      if (workspaceId) {
        body['workspaceId'] = workspaceId;
      }
      if (queue) {
        body['queue'] = true;
      }
      try {
        const data = await apiFetch('/api/pipeline/trigger', {
          method: 'POST',
          body: JSON.stringify(body),
        }) as Record<string, unknown>;
        if (data['conflict'] === true) {
          const choice = await vscode.window.showWarningMessage(
            'A run is already active',
            { modal: true },
            'Queue Next',
          );
          if (choice === 'Queue Next') {
            await trigger(true);
          }
        } else {
          vscode.window.showInformationMessage(`Pipeline started: run #${data['runId'] ?? data['id'] ?? '?'}`);
          specProvider.refresh();
        }
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await trigger();
  });

  // --- rorca.openInBrowser ---
  const openInBrowser = vscode.commands.registerCommand('rorca.openInBrowser', async (item: SpecTreeItem) => {
    if (!item?.specId) {
      vscode.window.showErrorMessage('No spec selected');
      return;
    }
    const serverUrl = getServerUrl().replace(/\/$/, '');
    const uri = vscode.Uri.parse(`${serverUrl}/specs/${item.specId}/review`);
    await vscode.env.openExternal(uri);
  });

  // --- rorca.copySpecJson ---
  const copySpecJson = vscode.commands.registerCommand('rorca.copySpecJson', async (item: SpecTreeItem) => {
    if (!item?.specId) {
      vscode.window.showErrorMessage('No spec selected');
      return;
    }
    try {
      const data = await apiFetch(`/api/specs/${item.specId}`);
      await vscode.env.clipboard.writeText(JSON.stringify(data, null, 2));
      vscode.window.showInformationMessage('Spec JSON copied to clipboard');
    } catch (err: unknown) {
      vscode.window.showErrorMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // --- rorca.testConnection ---
  const testConnection = vscode.commands.registerCommand('rorca.testConnection', async () => {
    try {
      await apiFetch('/api/health');
      const choice = await vscode.window.showInformationMessage(
        'Rorca server is online at ' + getServerUrl(),
        'Change Server URL',
      );
      if (choice === 'Change Server URL') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'rorca.apiUrl');
      }
    } catch (err: unknown) {
      const choice = await vscode.window.showErrorMessage(
        `Cannot connect to Rorca at ${getServerUrl()}`,
        'Open Settings',
      );
      if (choice === 'Open Settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'rorca.apiUrl');
      }
      void err; // suppress unused warning
    }
  });

  // --- rorca.startServer ---
  const startServer = vscode.commands.registerCommand('rorca.startServer', () => {
    vscode.window.showInformationMessage(
      'Start the Rorca backend with: cd /path/to/rorca && npm run dev',
      'Copy Command',
    ).then((choice) => {
      if (choice === 'Copy Command') {
        vscode.env.clipboard.writeText('npm run dev');
      }
    });
  });

  // --- rorca.forgeFromSelection ---
  const forgeFromSelection = vscode.commands.registerCommand('rorca.forgeFromSelection', async () => {
    const brief = await vscode.window.showInputBox({
      prompt: 'Describe what to build',
      placeHolder: 'Add Stripe payment integration...',
    });
    if (!brief) {
      return;
    }
    const workspaceId = vscode.workspace.getConfiguration('rorca').get<string>('defaultWorkspacePath', '');
    const body: Record<string, unknown> = { brief };
    if (workspaceId) {
      body['workspaceId'] = workspaceId;
    }
    try {
      const data = await apiFetch('/api/specs/generate', {
        method: 'POST',
        body: JSON.stringify(body),
      }) as Record<string, unknown>;
      const specId = data['id'] ?? data['specId'] ?? 'new spec';
      vscode.window.showInformationMessage(`Spec generated: ${String(specId)}`);
      specProvider.refresh();
    } catch (err: unknown) {
      vscode.window.showErrorMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  context.subscriptions.push(
    refreshSpecs,
    refreshMcpTools,
    approveSpec,
    triggerRun,
    openInBrowser,
    copySpecJson,
    testConnection,
    startServer,
    forgeFromSelection,
  );
}

export function deactivate(): void {
  stopHealthCheck();
}
