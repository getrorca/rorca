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

vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1' }),
}));

vi.mock('../../lib/renderMarkdown', () => ({
  renderMarkdown: (input: string) => input,
}));

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

describe('MarketplacePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
