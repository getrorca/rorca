import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';

export function getAuthToken(): string | null {
  return null;
}

export function getServerUrl(): string {
  return vscode.workspace.getConfiguration('rorca').get<string>('apiUrl', 'http://localhost:3030');
}

export function apiFetch(path: string, options?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<{ status: number; json(): Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const baseUrl = getServerUrl();
    const url = `${baseUrl}${path}`;
    const isHttps = url.startsWith('https://');
    const lib = isHttps ? https : http;

    const token = getAuthToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const urlObj = new URL(url);
    const reqOptions: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options?.method ?? 'GET',
      headers,
    };

    const req = lib.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({
          status: res.statusCode ?? 0,
          json: () => Promise.resolve(JSON.parse(body) as unknown),
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });

    if (options?.body) {
      req.write(options.body);
    }
    req.end();
  });
}
