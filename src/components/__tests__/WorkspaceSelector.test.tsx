/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WorkspaceSelector from '../WorkspaceSelector';

const workspaceState = vi.hoisted(() => ({
  workspaceId: null as string | null,
  workspaces: [] as Array<{ id: string; name: string; git_path: string }>,
  setWorkspaceId: vi.fn(),
  addWorkspace: vi.fn(),
}));

vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => workspaceState,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ signOut: vi.fn() }),
}));

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
}));

vi.mock('../AddWorkspaceModal', () => ({
  default: ({ onSuccess }: {
    onSuccess: (workspace: { id: string; name: string; git_path: string; needsBootstrap?: boolean }) => void;
  }) => (
    <button
      type="button"
      onClick={() => onSuccess({
        id: 'ws-new',
        name: 'New workspace',
        git_path: '/tmp/new',
        needsBootstrap: true,
      })}
    >
      Create mocked workspace
    </button>
  ),
}));

import { apiFetch } from '../../lib/apiFetch';

const mockApiFetch = vi.mocked(apiFetch);

// jsdom does not implement scrollIntoView; the selector reveals the active
// workspace when the dropdown opens, so every test needs a stub.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="location">{location.pathname}</output>;
}

describe('WorkspaceSelector setup navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceState.workspaceId = null;
    workspaceState.workspaces = [];
    mockApiFetch.mockResolvedValue({});
  });

  it('persists the new workspace setup state and navigates to onboarding', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/specs']}>
        <WorkspaceSelector />
        <LocationProbe />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Select workspace' }));
    await user.click(screen.getByRole('button', { name: 'Add workspace' }));
    await user.click(screen.getByRole('button', { name: 'Create mocked workspace' }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/onboarding', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          currentStep: 2,
          workspaceId: 'ws-new',
          directionDone: false,
          completed: false,
        }),
      }));
      expect(screen.getByLabelText('location')).toHaveTextContent('/onboarding');
    });
    expect(workspaceState.addWorkspace).toHaveBeenCalledWith(expect.objectContaining({ id: 'ws-new' }));
  });

  it('clears incompatible canonical object identity before switching workspace', async () => {
    workspaceState.workspaceId = 'ws-old';
    workspaceState.workspaces = [
      { id: 'ws-old', name: 'Old workspace', git_path: '/tmp/old' },
      { id: 'ws-new', name: 'New workspace', git_path: '/tmp/new' },
    ];
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/workspaces/ws-old/runs/42?label=Run+%2342']}>
        <WorkspaceSelector />
        <LocationProbe />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Select workspace' }));
    await user.click(screen.getByRole('button', { name: /New workspace/ }));

    expect(workspaceState.setWorkspaceId).toHaveBeenCalledWith('ws-new');
    expect(screen.getByLabelText('location')).toHaveTextContent('/specs');
  });
});

describe('WorkspaceSelector long-list scrolling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceState.workspaceId = 'ws-01';
    workspaceState.workspaces = Array.from({ length: 30 }, (_, i) => ({
      id: `ws-${String(i + 1).padStart(2, '0')}`,
      name: `Workspace ${String(i + 1).padStart(2, '0')}`,
      git_path: `/tmp/ws-${i + 1}`,
    }));
    mockApiFetch.mockResolvedValue({});
  });

  it('caps the workspace list and makes it scrollable, keeping footer actions outside the scroll area', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/specs']}>
        <WorkspaceSelector />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Select workspace' }));

    const list = screen.getByRole('button', { name: /Workspace 30/ }).closest('div');
    expect(list).not.toBeNull();
    expect(list!.className).toContain('max-h-[');
    expect(list!.className).toContain('overflow-y-auto');
    // All 30 rows render, but the list itself is height-capped and scrolls
    expect([...list!.querySelectorAll('button')].filter((b) => /Workspace \d{2}/.test(b.textContent ?? ''))).toHaveLength(30);
    // Footer actions live in a sibling container, not inside the scrollable list
    const addButton = screen.getByRole('button', { name: /Add workspace/ });
    expect(list!.contains(addButton)).toBe(false);
  });

  it('reveals the active workspace when the list opens', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    workspaceState.workspaceId = 'ws-25';
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/specs']}>
        <WorkspaceSelector />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: 'Select workspace' }));

    const active = screen.getByRole('button', { name: /Workspace 25/ });
    expect(active).toHaveClass('bg-accent/8');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });
});
