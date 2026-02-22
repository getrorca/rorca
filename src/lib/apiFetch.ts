export async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const base = import.meta.env.VITE_API_URL || 'http://localhost:3030';
  const res = await fetch(`${base}${path}`, opts);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}
