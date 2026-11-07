/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MarketplacePanel from '../MarketplacePanel';

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
  onApiFetchError: vi.fn(() => () => {}),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => null),
}));

vi.mock('../../contexts/ToastContext', () => ({
  useGlobalToast: () => ({ show: vi.fn() }),
}));

const workspaceState = vi.hoisted(() => ({ workspaceId: 'ws-1' as string | null }));

vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => workspaceState,
}));

vi.mock('../../lib/renderMarkdown', () => ({
  renderMarkdown: (input: string) => input,
}));

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

describe('MarketplacePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceState.workspaceId = 'ws-1';
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/skills?')) return { skills: [] } as any;
      if (path === '/api/skills/top') return { results: [], total: 0 } as any;
      return {} as any;
    });
  });

  it('does not search skills.sh for 1-character queries', async () => {
    render(<MarketplacePanel onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/skills?workspaceId=ws-1');
      expect(mockApiFetch).toHaveBeenCalledWith('/api/skills/top', { silent: true });
    });

    mockApiFetch.mockClear();

    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'g' } });

    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(screen.getByText('Type at least 2 characters to search skills.sh')).toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalledWith(
      '/api/skills/search',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('dedupes duplicate skills.sh search results by name', async () => {
    render(<MarketplacePanel onNavigate={vi.fn()} />);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/skills/top', { silent: true });
    });

    mockApiFetch.mockClear();
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/skills?')) return { skills: [] } as any;
      if (path === '/api/skills/search') {
        return {
          results: [
            { name: 'gtm-strategy', description: 'One', author: 'a', url: 'https://skills.sh/gtm-strategy' },
            { name: 'gtm-strategy', description: 'Duplicate', author: 'b', url: 'https://skills.sh/gtm-strategy-duplicate' },
            { name: 'gtm-positioning', description: 'Two', author: 'c', url: 'https://skills.sh/gtm-positioning' },
          ],
          total: 3,
          query: 'gtm',
        } as any;
      }
      return { results: [], total: 0 } as any;
    });

    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'gtm' } });

    await new Promise((resolve) => setTimeout(resolve, 350));

    await waitFor(() => {
      expect(screen.getAllByText('gtm-strategy')).toHaveLength(1);
      expect(screen.getAllByText('gtm-positioning')).toHaveLength(1);
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/skills/search', expect.objectContaining({
      method: 'POST',
      silent: true,
    }));
  });
  it('scopes skills.sh installs to the selected workspace', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/skills?')) return { skills: [] };
      if (path === '/api/skills/top') {
        return {
          results: [{ name: 'secure-review', description: 'Review code', author: 'rorca', url: 'https://skills.sh/secure-review' }],
          total: 1,
          query: '',
        };
      }
      return {};
    });

    render(<MarketplacePanel onNavigate={vi.fn()} />);
    const install = await screen.findByRole('button', { name: 'Install' });
    fireEvent.click(install);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/skills/install-from-sh', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'secure-review', workspaceId: 'ws-1' }),
      }));
    });
  });

  it('scopes GitHub and custom installs to the selected workspace', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/skills?')) return { skills: [] };
      if (path === '/api/skills/top') return { results: [], total: 0, query: '' };
      if (path === '/api/skills/browse-github') {
        return {
          repo: 'owner/repo',
          branch: 'main',
          skills: [{ name: 'github-skill', description: 'From GitHub', path: 'skills/github-skill/SKILL.md', installed: false }],
        };
      }
      return {};
    });

    render(<MarketplacePanel onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'GitHub Repos' }));
    fireEvent.change(screen.getByPlaceholderText(/github\.com\/owner\/repo/i), { target: { value: 'owner/repo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Browse' }));
    const githubInstall = await screen.findByRole('button', { name: 'Install' });
    fireEvent.click(githubInstall);

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/skills/install-from-github', expect.objectContaining({
        body: JSON.stringify({
          repoUrl: 'owner/repo',
          skillPath: 'skills/github-skill/SKILL.md',
          workspaceId: 'ws-1',
        }),
      }));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByPlaceholderText('my-skill'), { target: { value: 'custom-skill' } });
    fireEvent.change(screen.getByPlaceholderText('Paste your SKILL.md content here...'), { target: { value: '# Custom skill' } });
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/skills/install', expect.objectContaining({
        body: JSON.stringify({
          name: 'custom-skill',
          content: '# Custom skill',
          source: 'user',
          workspaceId: 'ws-1',
        }),
      }));
    });
  });

  it('disables installation when no workspace is selected', async () => {
    workspaceState.workspaceId = null;
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/skills/top') {
        return {
          results: [{ name: 'secure-review', description: 'Review code', author: 'rorca', url: 'https://skills.sh/secure-review' }],
          total: 1,
          query: '',
        };
      }
      return {};
    });

    render(<MarketplacePanel onNavigate={vi.fn()} />);

    expect(await screen.findByText('Select or add a workspace before installing skills.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled();
    expect(mockApiFetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/skills/install'), expect.anything());
  });

});
