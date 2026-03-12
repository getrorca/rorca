import * as vscode from 'vscode';
import { apiFetch, getServerUrl } from './auth';

type SpecStatus = 'pending' | 'approved' | 'running';

interface RorcaSpec {
  id: string;
  specName?: string;
  title?: string;
  status?: string;
  userStories?: Array<{ passes?: boolean }>;
}

export class SpecTreeItem extends vscode.TreeItem {
  public readonly specId: string;
  public readonly specStatus: SpecStatus;
  public readonly storyCount: number;
  public readonly readinessPercent: number;
  public readonly isGroup: boolean;

  constructor(opts: {
    label: string;
    description?: string;
    collapsibleState: vscode.TreeItemCollapsibleState;
    contextValue: string;
    iconPath?: vscode.ThemeIcon;
    command?: vscode.Command;
    specId?: string;
    specStatus?: SpecStatus;
    storyCount?: number;
    readinessPercent?: number;
    isGroup?: boolean;
  }) {
    super(opts.label, opts.collapsibleState);
    this.description = opts.description;
    this.contextValue = opts.contextValue;
    if (opts.iconPath) {
      this.iconPath = opts.iconPath;
    }
    if (opts.command) {
      this.command = opts.command;
    }
    this.specId = opts.specId ?? '';
    this.specStatus = opts.specStatus ?? 'pending';
    this.storyCount = opts.storyCount ?? 0;
    this.readinessPercent = opts.readinessPercent ?? 0;
    this.isGroup = opts.isGroup ?? false;
  }
}

export class SpecTreeDataProvider implements vscode.TreeDataProvider<SpecTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SpecTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private autoRefreshTimer: NodeJS.Timeout | undefined;

  constructor() {
    this.startAutoRefresh();

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('rorca.autoRefreshInterval')) {
        this.startAutoRefresh();
      }
    });
  }

  private startAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }
    const interval = vscode.workspace.getConfiguration('rorca').get<number>('autoRefreshInterval', 60);
    if (interval > 0) {
      this.autoRefreshTimer = setInterval(() => this.refresh(), interval * 1000);
    }
  }

  dispose(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
    }
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: SpecTreeItem): SpecTreeItem {
    return element;
  }

  async getChildren(element?: SpecTreeItem): Promise<SpecTreeItem[]> {
    if (!element) {
      return this.getRootGroups();
    }
    if (element.isGroup) {
      return this.getGroupChildren(element.specStatus);
    }
    return [];
  }

  private async fetchSpecs(): Promise<RorcaSpec[]> {
    try {
      const res = await apiFetch('/api/specs?status=all');
      if (res.status !== 200) {
        return [];
      }
      const data = await res.json() as unknown;
      if (Array.isArray(data)) {
        return data as RorcaSpec[];
      }
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj['items'])) {
        return obj['items'] as RorcaSpec[];
      }
      return [];
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isOffline = message.includes('ECONNREFUSED') || message.includes('Timeout') || message.includes('connect');
      if (isOffline) {
        return [];
      }
      return [];
    }
  }

  private classifyStatus(spec: RorcaSpec): SpecStatus {
    const s = (spec.status ?? '').toLowerCase();
    if (s === 'running' || s === 'in_progress' || s === 'active') {
      return 'running';
    }
    if (s === 'approved') {
      return 'approved';
    }
    return 'pending';
  }

  private buildSpecItem(spec: RorcaSpec, status: SpecStatus): SpecTreeItem {
    const label = spec.specName ?? spec.title ?? spec.id;
    const stories = spec.userStories ?? [];
    const storyCount = stories.length;
    const passed = stories.filter((s) => s.passes === true).length;
    const readinessPercent = storyCount > 0 ? Math.round((passed / storyCount) * 100) : 0;

    const iconMap: Record<SpecStatus, vscode.ThemeIcon> = {
      pending: new vscode.ThemeIcon('clock'),
      approved: new vscode.ThemeIcon('check'),
      running: new vscode.ThemeIcon('sync~spin'),
    };

    return new SpecTreeItem({
      label,
      description: `${storyCount} stories · ${readinessPercent}% ready`,
      collapsibleState: vscode.TreeItemCollapsibleState.None,
      contextValue: 'rorcaSpec',
      iconPath: iconMap[status],
      specId: spec.id,
      specStatus: status,
      storyCount,
      readinessPercent,
      isGroup: false,
    });
  }

  private async getRootGroups(): Promise<SpecTreeItem[]> {
    let specs: RorcaSpec[];
    let offline = false;

    try {
      const res = await apiFetch('/api/specs?status=all');
      if (res.status !== 200) {
        specs = [];
      } else {
        const data = await res.json() as unknown;
        if (Array.isArray(data)) {
          specs = data as RorcaSpec[];
        } else {
          const obj = data as Record<string, unknown>;
          specs = (Array.isArray(obj['items']) ? obj['items'] : []) as RorcaSpec[];
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      offline = message.includes('ECONNREFUSED') || message.includes('Timeout') || message.includes('connect');
      specs = [];
    }

    if (offline) {
      return [
        new SpecTreeItem({
          label: '⚠ Server offline',
          description: 'Click to start server',
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          contextValue: 'rorcaOffline',
          iconPath: new vscode.ThemeIcon('warning'),
          command: { command: 'rorca.startServer', title: 'Start Server' },
          specId: '',
          specStatus: 'pending',
        }),
      ];
    }

    if (specs.length === 0) {
      return [
        new SpecTreeItem({
          label: 'No specs found',
          description: 'Generate one with rorca forge',
          collapsibleState: vscode.TreeItemCollapsibleState.None,
          contextValue: 'rorcaEmpty',
          iconPath: new vscode.ThemeIcon('info'),
          specId: '',
          specStatus: 'pending',
        }),
      ];
    }

    const groups: Record<SpecStatus, RorcaSpec[]> = { pending: [], approved: [], running: [] };
    for (const spec of specs) {
      groups[this.classifyStatus(spec)].push(spec);
    }

    const groupOrder: SpecStatus[] = ['running', 'approved', 'pending'];
    const groupLabels: Record<SpecStatus, string> = { running: 'Running', approved: 'Approved', pending: 'Pending' };
    const groupIcons: Record<SpecStatus, vscode.ThemeIcon> = {
      running: new vscode.ThemeIcon('sync~spin'),
      approved: new vscode.ThemeIcon('folder'),
      pending: new vscode.ThemeIcon('folder'),
    };

    const result: SpecTreeItem[] = [];
    for (const status of groupOrder) {
      const children = groups[status];
      if (children.length === 0) {
        continue;
      }
      result.push(
        new SpecTreeItem({
          label: groupLabels[status],
          description: `(${children.length})`,
          collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
          contextValue: 'rorcaSpecGroup',
          iconPath: groupIcons[status],
          specId: '',
          specStatus: status,
          isGroup: true,
        }),
      );
    }

    return result;
  }

  private async getGroupChildren(status: SpecStatus): Promise<SpecTreeItem[]> {
    const allSpecs = await this.fetchSpecs();
    return allSpecs
      .filter((spec) => this.classifyStatus(spec) === status)
      .map((spec) => this.buildSpecItem(spec, status));
  }

  // Expose for command handlers to get workspace info
  static getDefaultWorkspaceId(): string {
    return vscode.workspace.getConfiguration('rorca').get<string>('defaultWorkspacePath', '');
  }

  static getServerUrl(): string {
    return getServerUrl();
  }
}
