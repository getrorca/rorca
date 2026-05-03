import http from 'node:http';

const API_BASE = process.env.RORCA_API_URL?.trim() || 'http://localhost:3030';

export class TuiApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TuiApiError';
  }
}

function getAuthToken(): string | null {
  return process.env.RORCA_API_TOKEN?.trim() || process.env.RORCA_AUTH_TOKEN?.trim() || null;
}

function resolveUrl(pathOrUrl: string): URL {
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    return new URL(pathOrUrl);
  }

  return new URL(pathOrUrl, API_BASE);
}

function parseError(status: number, body: string): TuiApiError {
  try {
    const parsed = JSON.parse(body) as { error?: string; code?: string };
    return new TuiApiError(
      status,
      parsed.code || `HTTP_${status}`,
      parsed.error || body || `HTTP ${status}`,
    );
  } catch {
    return new TuiApiError(status, `HTTP_${status}`, body || `HTTP ${status}`);
  }
}

export async function apiJson<T>(
  pathOrUrl: string,
  init?: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const target = resolveUrl(pathOrUrl);
    const body = init?.body != null ? JSON.stringify(init.body) : null;
    const authToken = getAuthToken();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body).toString();
    }

    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }

    const req = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');

          if ((res.statusCode ?? 500) >= 400) {
            reject(parseError(res.statusCode ?? 500, raw));
            return;
          }

          try {
            resolve((raw ? JSON.parse(raw) : {}) as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.on('error', reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
}
