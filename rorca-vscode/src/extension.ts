import * as vscode from 'vscode';
import { SpecTreeDataProvider, SpecTreeItem } from './specProvider';
import { McpToolsProvider } from './mcpToolsProvider';
import { apiFetch, getServerUrl } from './auth';

export function activate(context: vscode.ExtensionContext): void {
  const specProvider = new SpecTreeDataProvider();
  const mcpProvider = new McpToolsProvider();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('rorcaSpecs', specProvider),
    vscode.window.registerTreeDataProvider('rorcaMcpTools', mcpProvider),
  );

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
      const res = await apiFetch(`/api/specs/${item.specId}/approve`, { method: 'POST' });
      if (res.status === 200) {
        vscode.window.showInformationMessage(`Spec approved: ${String(item.label)}`);
        specProvider.refresh();
      } else if (res.status === 409) {
        vscode.window.showWarningMessage('Spec is already approved');
      } else {
        const body = await res.json();
        vscode.window.showErrorMessage(`Failed to approve spec: ${JSON.stringify(body)}`);
      }
    } catch (err: unknown) {
      vscode.window.showErrorMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
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
        const res = await apiFetch('/api/pipeline/trigger', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        const data = await res.json() as Record<string, unknown>;
        if (res.status === 200 || res.status === 201) {
          vscode.window.showInformationMessage(`Pipeline started: run #${data['runId'] ?? data['id'] ?? '?'}`);
          specProvider.refresh();
        } else if (data['conflict'] === true) {
          const choice = await vscode.window.showWarningMessage(
            'A run is already active',
            { modal: true },
            'Queue Next',
          );
          if (choice === 'Queue Next') {
            await trigger(true);
          }
        } else {
          vscode.window.showErrorMessage(`Failed to trigger run: ${JSON.stringify(data)}`);
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
      const res = await apiFetch(`/api/specs/${item.specId}`);
      if (res.status !== 200) {
        vscode.window.showErrorMessage(`Failed to fetch spec: HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      await vscode.env.clipboard.writeText(JSON.stringify(data, null, 2));
      vscode.window.showInformationMessage('Spec JSON copied to clipboard');
    } catch (err: unknown) {
      vscode.window.showErrorMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // --- rorca.testConnection ---
  const testConnection = vscode.commands.registerCommand('rorca.testConnection', async () => {
    try {
      const res = await apiFetch('/api/health');
      if (res.status === 200) {
        vscode.window.showInformationMessage(`Connected to Rorca backend at ${getServerUrl()}`);
        statusBarItem.text = '$(circle-filled) Rorca';
        statusBarItem.tooltip = `Rorca: Connected (${getServerUrl()})`;
      } else {
        vscode.window.showWarningMessage(`Backend responded with HTTP ${res.status}`);
        statusBarItem.text = '$(warning) Rorca';
        statusBarItem.tooltip = `Rorca: Degraded (HTTP ${res.status})`;
      }
    } catch (_err) {
      vscode.window.showErrorMessage(`Cannot reach Rorca backend at ${getServerUrl()}`);
      statusBarItem.text = '$(circle-outline) Rorca';
      statusBarItem.tooltip = 'Rorca: Disconnected';
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
      const res = await apiFetch('/api/specs/generate', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (res.status === 200 || res.status === 201) {
        const data = await res.json() as Record<string, unknown>;
        const specId = data['id'] ?? data['specId'] ?? 'new spec';
        vscode.window.showInformationMessage(`Spec generated: ${String(specId)}`);
        specProvider.refresh();
      } else {
        const data = await res.json();
        vscode.window.showErrorMessage(`Failed to generate spec: ${JSON.stringify(data)}`);
      }
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
