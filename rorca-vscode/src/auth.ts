import * as vscode from 'vscode';

export function getAuthToken(): string | null {
  return null;
}

export function getServerUrl(): string {
  return vscode.workspace.getConfiguration('rorca').get<string>('apiUrl', 'http://localhost:3030');
}

export async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  const baseUrl = getServerUrl();
  const token = getAuthToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> | undefined),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
  });
}
