import * as vscode from 'vscode';
import { apiFetch, getServerUrl } from './auth';

// ─── Data shapes ────────────────────────────────────────────────────────────

interface ApiSpec {
  id: string;
  specName?: string;
  title?: string;
  status: string;
  userStories?: Array<{ passes?: boolean }>;
}

interface ApiWorkspace {
  id: string;
  path?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseApiWorkspaces(value: unknown): ApiWorkspace[] {
  const candidates = Array.isArray(value)
    ? value
    : (isRecord(value) && Array.isArray(value['items']) ? value['items'] : []);
  return candidates.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate['id'] !== 'string') return [];
    return [{
      id: candidate['id'],
      ...(typeof candidate['path'] === 'string' ? { path: candidate['path'] } : {}),
    }];
  });
}

// ─── Tree item types ─────────────────────────────────────────────────────────

export type SpecItemKind = 'group' | 'spec' | 'empty' | 'offline';

export class SpecTreeItem extends vscode.TreeItem {
  public readonly kind: SpecItemKind;
  public readonly specId: string;
  public readonly specStatus: 'pending' | 'approved' | 'running' | '';
  public readonly storyCount: number;
  public readonly readinessPercent: number;

  constructor(opts: {
    kind: SpecItemKind;
    label: string;
    description?: string;
    iconPath?: vscode.ThemeIcon;
    collapsibleState?: vscode.TreeItemCollapsibleState;
    contextValue?: string;
    command?: vscode.Command;
    specId?: string;
    specStatus?: 'pending' | 'approved' | 'running' | '';
    storyCount?: number;
    readinessPercent?: number;
  }) {
    super(opts.label, opts.collapsibleState ?? vscode.TreeItemCollapsibleState.None);
    this.kind = opts.kind;
    this.description = opts.description;
    this.iconPath = opts.iconPath;
    this.contextValue = opts.contextValue;
    this.command = opts.command;
    this.specId = opts.specId ?? '';
    this.specStatus = opts.specStatus ?? '';
    this.storyCount = opts.storyCount ?? 0;
    this.readinessPercent = opts.readinessPercent ?? 0;
  }
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class SpecTreeDataProvider implements vscode.TreeDataProvider<SpecTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SpecTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _autoRefreshTimer: ReturnType<typeof setInterval> | undefined;
  private _configListener: vscode.Disposable | undefined;

  constructor() {
    this._startAutoRefresh();
    this._configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('rorca.autoRefreshInterval')) {
        this._startAutoRefresh();
      }
    });
  }

  dispose(): void {
    this._stopAutoRefresh();
    this._configListener?.dispose();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  // ── TreeDataProvider ──────────────────────────────────────────────────────

  getTreeItem(element: SpecTreeItem): SpecTreeItem {
    return element;
  }

  async getChildren(element?: SpecTreeItem): Promise<SpecTreeItem[]> {
    if (!element) {
      // Root level: fetch specs and return group nodes
      return this._fetchGroups();
    }

    if (element.kind === 'group' && element.specStatus !== '') {
      // Group level: return child spec items for this status
      return this._getGroupChildren(element.specStatus);
    }

    return [];
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async _fetchGroups(): Promise<SpecTreeItem[]> {
    let specs: ApiSpec[];
    try {
      const res = await apiFetch('/api/specs?status=all');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data: unknown = await res.json();
      specs = Array.isArray(data) ? (data as ApiSpec[]) : ((data as { items?: ApiSpec[] }).items ?? []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isOffline =
        msg.includes('ECONNREFUSED') ||
        msg.includes('fetch failed') ||
        msg.includes('Failed to fetch') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('network');

      if (isOffline) {
        return [
          new SpecTreeItem({
            kind: 'offline',
            label: '⚠ Server offline',
            description: 'Click to start server',
            iconPath: new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground')),
            contextValue: 'rorcaOffline',
            command: { command: 'rorca.startServer', title: 'Start Server' },
          }),
        ];
      }
      return [
        new SpecTreeItem({
          kind: 'empty',
          label: 'Failed to load specs',
          description: msg,
          iconPath: new vscode.ThemeIcon('error'),
        }),
      ];
    }

    // Partition by status
    const pending = specs.filter((s) => s.status === 'pending');
    const approved = specs.filter((s) => s.status === 'approved');
    const running = specs.filter((s) => s.status === 'running');

    // Build group nodes, filtering empty groups
    const groups: SpecTreeItem[] = [];

    if (running.length > 0) {
      groups.push(this._makeGroupNode('running', running.length));
    }
    if (approved.length > 0) {
      groups.push(this._makeGroupNode('approved', approved.length));
    }
    if (pending.length > 0) {
      groups.push(this._makeGroupNode('pending', pending.length));
    }

    if (groups.length === 0) {
      return [
        new SpecTreeItem({
          kind: 'empty',
          label: 'No specs found',
          description: 'Generate one with rorca forge',
          iconPath: new vscode.ThemeIcon('info'),
        }),
      ];
    }

    // Cache specs for group child lookups
    this._specsCache = specs;
    return groups;
  }

  private _specsCache: ApiSpec[] = [];

  private _makeGroupNode(status: 'pending' | 'approved' | 'running', count: number): SpecTreeItem {
    const labels: Record<string, string> = {
      pending: 'Pending',
      approved: 'Approved',
      running: 'Running',
    };
    return new SpecTreeItem({
      kind: 'group',
      label: labels[status],
      description: `(${count})`,
      iconPath: new vscode.ThemeIcon('folder'),
      collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
      contextValue: 'rorcaSpecGroup',
      specStatus: status,
    });
  }

  private _getGroupChildren(status: 'pending' | 'approved' | 'running' | ''): SpecTreeItem[] {
    const filtered = this._specsCache.filter((s) => s.status === status);
    return filtered.map((s) => this._makeSpecItem(s));
  }

  private _makeSpecItem(spec: ApiSpec): SpecTreeItem {
    const label = spec.specName ?? spec.title ?? spec.id;
    const stories = spec.userStories ?? [];
    const storyCount = stories.length;
    const passed = stories.filter((st) => st.passes === true).length;
    const readinessPercent = storyCount > 0 ? Math.round((passed / storyCount) * 100) : 0;

    const iconMap: Record<string, vscode.ThemeIcon> = {
      pending: new vscode.ThemeIcon('clock'),
      approved: new vscode.ThemeIcon('check'),
      running: new vscode.ThemeIcon('sync~spin'),
    };

    return new SpecTreeItem({
      kind: 'spec',
      label,
      description: `${storyCount} stories · ${readinessPercent}% ready`,
      iconPath: iconMap[spec.status] ?? new vscode.ThemeIcon('circle-outline'),
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      contextValue: 'rorcaSpec',
      specId: spec.id,
      specStatus: (spec.status as 'pending' | 'approved' | 'running') ?? '',
      storyCount,
      readinessPercent,
    });
  }

  private _startAutoRefresh(): void {
    this._stopAutoRefresh();
    const interval = vscode.workspace
      .getConfiguration('rorca')
      .get<number>('autoRefreshInterval', 60);
    if (interval > 0) {
      this._autoRefreshTimer = setInterval(() => this.refresh(), interval * 1000);
    }
  }

  private _stopAutoRefresh(): void {
    if (this._autoRefreshTimer !== undefined) {
      clearInterval(this._autoRefreshTimer);
      this._autoRefreshTimer = undefined;
    }
  }
}

// ─── Command handlers ─────────────────────────────────────────────────────────
// These are exported so extension.ts can register them with proper typing.

export async function cmdApproveSpec(
  item: SpecTreeItem,
  provider: SpecTreeDataProvider
): Promise<void> {
  if (!item?.specId) {
    await vscode.window.showErrorMessage('No spec selected.');
    return;
  }
  try {
    const res = await apiFetch(`/api/specs/${item.specId}/approve`, { method: 'POST' });
    if (res.status === 200) {
      await vscode.window.showInformationMessage(`Spec approved: ${String(item.label)}`);
      provider.refresh();
    } else if (res.status === 409) {
      await vscode.window.showWarningMessage('Spec is already approved');
    } else {
      const body = await res.text();
      await vscode.window.showErrorMessage(`Failed to approve spec: ${body}`);
    }
  } catch (err: unknown) {
    await vscode.window.showErrorMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function cmdTriggerRun(
  item: SpecTreeItem,
  provider: SpecTreeDataProvider,
  queue = false
): Promise<void> {
  if (!item?.specId) {
    await vscode.window.showErrorMessage('No spec selected.');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('rorca');
  const workspacePath = cfg.get<string>('defaultWorkspacePath', '');
  const specPath = `forge/specs/approved/${item.specId}.json`;

  try {
    const workspaceRes = await apiFetch('/api/workspaces?limit=250');
    if (!workspaceRes.ok) {
      throw new Error(`Unable to resolve workspace authority (HTTP ${workspaceRes.status})`);
    }
    const workspaceData: unknown = await workspaceRes.json();
    const workspaces = parseApiWorkspaces(workspaceData);
    const workspace = workspacePath
      ? workspaces.find((candidate) => candidate.path === workspacePath)
      : (workspaces.length === 1 ? workspaces[0] : undefined);
    if (!workspace) {
      throw new Error('Select an exact Rorca workspace before triggering a run');
    }

    const preflightBody = {
      specPath,
      workspaceId: workspace.id,
      ...(queue ? { queue: true } : {}),
    };
    const preflightRes = await apiFetch('/api/pipeline/preflight', {
      method: 'POST',
      body: JSON.stringify(preflightBody),
    });
    const preflightData: unknown = await preflightRes.json().catch(() => ({}));
    if (!preflightRes.ok) {
      const preflightError = isRecord(preflightData) && typeof preflightData['error'] === 'string'
        ? preflightData['error']
        : preflightRes.statusText;
      throw new Error(preflightError);
    }
    const previewValue = isRecord(preflightData) ? preflightData['preview'] : undefined;
    const previewHash = isRecord(previewValue) && typeof previewValue['previewHash'] === 'string'
      ? previewValue['previewHash']
      : undefined;
    const previewExpiresAt = isRecord(previewValue) && typeof previewValue['expiresAt'] === 'string'
      ? previewValue['expiresAt']
      : undefined;
    if (!previewHash || !previewExpiresAt) {
      throw new Error('Pipeline preflight returned an invalid execution preview');
    }
    const idempotencyKey = `rorca-vscode:${workspace.id}:${previewHash.slice('sha256:'.length)}`;
    const res = await apiFetch('/api/pipeline/trigger', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({
        ...preflightBody,
        idempotencyKey,
        previewHash,
        previewExpiresAt,
      }),
    });

    const data: unknown = await res.json().catch(() => ({}));
    const payload = data as Record<string, unknown>;

    if (res.ok && !payload['conflict']) {
      const runId = payload['runId'] ?? payload['id'] ?? '?';
      await vscode.window.showInformationMessage(`Pipeline started: run #${String(runId)}`);
      provider.refresh();
    } else if (payload['conflict']) {
      const choice = await vscode.window.showWarningMessage(
        'A run is already active',
        { modal: true },
        'Queue Next'
      );
      if (choice === 'Queue Next') {
        await cmdTriggerRun(item, provider, true);
      }
    } else {
      const errMsg = payload['error'] ?? res.statusText;
      await vscode.window.showErrorMessage(`Failed to trigger run: ${String(errMsg)}`);
    }
  } catch (err: unknown) {
    await vscode.window.showErrorMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function cmdOpenInBrowser(item: SpecTreeItem): Promise<void> {
  if (!item?.specId) {
    await vscode.window.showErrorMessage('No spec selected.');
    return;
  }
  const url = `${getServerUrl()}/specs/${item.specId}/review`;
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

export async function cmdCopySpecJson(item: SpecTreeItem): Promise<void> {
  if (!item?.specId) {
    await vscode.window.showErrorMessage('No spec selected.');
    return;
  }
  try {
    const res = await apiFetch(`/api/specs/${item.specId}`);
    if (!res.ok) {
      await vscode.window.showErrorMessage(`Failed to fetch spec: HTTP ${res.status}`);
      return;
    }
    const data: unknown = await res.json();
    const json = JSON.stringify(data, null, 2);
    await vscode.env.clipboard.writeText(json);
    await vscode.window.showInformationMessage('Spec JSON copied to clipboard');
  } catch (err: unknown) {
    await vscode.window.showErrorMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function cmdForgeFromSelection(
  provider: SpecTreeDataProvider
): Promise<void> {
  const brief = await vscode.window.showInputBox({
    prompt: 'Describe what to build',
    placeHolder: 'Add Stripe payment integration...',
  });
  if (!brief) {
    return;
  }

  const cfg = vscode.workspace.getConfiguration('rorca');
  const workspacePath = cfg.get<string>('defaultWorkspacePath', '');

  try {
    const res = await apiFetch('/api/specs/generate', {
      method: 'POST',
      body: JSON.stringify({ brief, workspacePath }),
    });
    if (res.ok) {
      const data: unknown = await res.json().catch(() => ({}));
      const specId = (data as Record<string, unknown>)['id'] ?? 'new';
      await vscode.window.showInformationMessage(`Spec generated: ${String(specId)}`);
      provider.refresh();
    } else {
      const body = await res.text();
      await vscode.window.showErrorMessage(`Failed to generate spec: ${body}`);
    }
  } catch (err: unknown) {
    await vscode.window.showErrorMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
