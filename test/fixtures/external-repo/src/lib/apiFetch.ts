export interface ApiFetchOptions extends RequestInit {
  token?: string;
}

export async function apiFetch<T = unknown>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) throw new Error(`apiFetch failed: ${response.status}`);
  return response.json() as Promise<T>;
}
