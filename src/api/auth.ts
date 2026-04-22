import { apiFetch } from '../lib/apiFetch';
import type { ApiOptions, AuthUser } from './types';

export function getMe(opts?: ApiOptions): Promise<{ user: AuthUser }> {
  return apiFetch('/api/auth/me', { signal: opts?.signal });
}

export function getGitHubAuthUrl(opts?: ApiOptions): Promise<{ authUrl: string }> {
  return apiFetch('/api/auth/github', { signal: opts?.signal });
}
