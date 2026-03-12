import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// RorcaApiError
// ---------------------------------------------------------------------------

export class RorcaApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
  ) {
    super(`Rorca API error: ${status} ${statusText}`);
    this.name = 'RorcaApiError';
  }
}

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

let _cachedToken: string | null = null;
let _lastTokenRead = 0;
const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function getAuthToken(): string | null {
  const now = Date.now();
  if (_cachedToken !== null && now - _lastTokenRead < TOKEN_TTL_MS) {
    return _cachedToken;
  }
  return _readTokenFromDisk();
}

function _readTokenFromDisk(): string | null {
  try {
    const credPath = path.join(os.homedir(), '.rorca', 'credentials');
    const raw = fs.readFileSync(credPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const token = parsed['token'];
    _cachedToken = (typeof token === 'string' && token) ? token : null;
    _lastTokenRead = Date.now();
    return _cachedToken;
  } catch {
    // ENOENT, invalid JSON, or missing field — all safe to ignore
    _cachedToken = null;
    _lastTokenRead = Date.now();
    return null;
  }
}

function _invalidateTokenCache(): void {
  _cachedToken = null;
  _lastTokenRead = 0;
}

// ---------------------------------------------------------------------------
// Server URL cache
// ---------------------------------------------------------------------------

let _cachedServerUrl: string | null = null;

export function getServerUrl(): string {
  if (_cachedServerUrl !== null) {
    return _cachedServerUrl;
  }
  _cachedServerUrl = _resolveServerUrl();
  return _cachedServerUrl;
}

function _resolveServerUrl(): string {
  // 1. Explicit setting
  const configured = vscode.workspace.getConfiguration('rorca').get<string>('apiUrl');
  if (configured && configured !== 'http://localhost:3030') {
    return configured;
  }

  // 2. CLAUDE.md in first workspace folder
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    try {
      const claudeMd = fs.readFileSync(
        path.join(folders[0].uri.fsPath, 'CLAUDE.md'),
        'utf-8',
      );
      const match = claudeMd.match(/localhost:(\d+)/);
      if (match) {
        return `http://localhost:${match[1]}`;
      }
    } catch {
      // CLAUDE.md not found — fall through
    }
  }

  // 3. Default
  return configured ?? 'http://localhost:3030';
}

function _invalidateServerUrlCache(): void {
  _cachedServerUrl = null;
}

/** Register config/workspace listeners. Must be called from activate(). */
export function initConfigWatcher(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('rorca.apiUrl')) {
        _invalidateServerUrlCache();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      _invalidateServerUrlCache();
    }),
  );
}

// ---------------------------------------------------------------------------
// apiFetch
// ---------------------------------------------------------------------------

export async function apiFetch(path: string, options?: RequestInit): Promise<unknown> {
  const url = `${getServerUrl()}${path}`;

  const token = getAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> | undefined ?? {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new RorcaApiError(0, 'Timeout', 'Request timed out after 30 seconds');
    }
    throw new RorcaApiError(0, 'Network Error', (err instanceof Error) ? err.message : String(err));
  }
  clearTimeout(timeoutId);

  if (response.status === 401) {
    // Invalidate and retry once
    _invalidateTokenCache();
    const freshToken = _readTokenFromDisk();
    const retryHeaders: Record<string, string> = { ...headers };
    if (freshToken) {
      retryHeaders['Authorization'] = `Bearer ${freshToken}`;
    } else {
      delete retryHeaders['Authorization'];
    }

    let retryResponse: Response;
    try {
      retryResponse = await globalThis.fetch(url, {
        ...options,
        headers: retryHeaders,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new RorcaApiError(0, 'Timeout', 'Request timed out after 30 seconds');
      }
      throw new RorcaApiError(0, 'Network Error', (err instanceof Error) ? err.message : String(err));
    }

    if (retryResponse.status === 401) {
      void vscode.window.showErrorMessage(
        'Rorca: Authentication failed',
        'Open Settings',
        'Login in Browser',
      ).then((choice) => {
        if (choice === 'Open Settings') {
          void vscode.commands.executeCommand('workbench.action.openSettings', 'rorca.apiUrl');
        } else if (choice === 'Login in Browser') {
          void vscode.env.openExternal(vscode.Uri.parse(`${getServerUrl()}/login`));
        }
      });
      const body = await retryResponse.text();
      throw new RorcaApiError(401, retryResponse.statusText, body);
    }

    if (!retryResponse.ok) {
      const body = await retryResponse.text();
      throw new RorcaApiError(retryResponse.status, retryResponse.statusText, body);
    }
    return retryResponse.json() as Promise<unknown>;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new RorcaApiError(response.status, response.statusText, body);
  }

  return response.json() as Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Health check / server online state
// ---------------------------------------------------------------------------

let _serverOnline = false;
let _healthCheckInterval: ReturnType<typeof setInterval> | null = null;

export function isServerOnline(): boolean {
  return _serverOnline;
}

export function startHealthCheck(statusBarItem: vscode.StatusBarItem): void {
  const check = async (): Promise<void> => {
    try {
      await apiFetch('/api/health');
      _serverOnline = true;
      statusBarItem.text = '$(circle-filled) Rorca: Connected';
      statusBarItem.tooltip = 'Rorca: Connected to ' + getServerUrl();
      statusBarItem.backgroundColor = undefined;
      void vscode.commands.executeCommand('setContext', 'rorca.serverOnline', true);
    } catch {
      _serverOnline = false;
      statusBarItem.text = '$(circle-outline) Rorca: Disconnected';
      statusBarItem.tooltip = 'Rorca: Cannot connect to ' + getServerUrl();
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      void vscode.commands.executeCommand('setContext', 'rorca.serverOnline', false);
    }
  };

  // Fire immediately, then every 30s
  void check();
  _healthCheckInterval = setInterval(() => { void check(); }, 30_000);
}

export function stopHealthCheck(): void {
  if (_healthCheckInterval !== null) {
    clearInterval(_healthCheckInterval);
    _healthCheckInterval = null;
  }
}
