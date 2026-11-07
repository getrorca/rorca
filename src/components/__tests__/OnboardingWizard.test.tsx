/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OnboardingWizard from '../OnboardingWizard';

const workspaceState = vi.hoisted(() => ({
  workspaceId: 'ws-selected' as string | null,
  workspaces: [
    { id: 'ws-selected', name: 'Selected', git_path: '/tmp/selected' },
    { id: 'ws-persisted', name: 'Persisted', git_path: '/tmp/persisted' },
  ],
  addWorkspace: vi.fn(),
  setWorkspaceId: vi.fn(),
}));

vi.mock('../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => workspaceState,
}));

vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../../lib/apiFetch';

const mockApiFetch = vi.mocked(apiFetch);

describe('OnboardingWizard routing state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceState.workspaceId = 'ws-selected';
  });

  it('resumes the persisted backend step and workspace after a refresh', async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/onboarding') {
        return {
          currentStep: 3,
          workspaceId: 'ws-persisted',
          directionDone: true,
          completed: false,
        };
      }
      if (path === '/api/health') return {};
      return {};
    });

    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingWizard />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Generate Your First Spec' })).toBeInTheDocument();
    expect(workspaceState.setWorkspaceId).toHaveBeenCalledWith('ws-persisted');
    expect(mockApiFetch).toHaveBeenCalledWith('/api/onboarding');
  });

  it('starts setup for the selected workspace when prior onboarding is complete', async () => {
    mockApiFetch.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/onboarding' && options?.method !== 'PUT') {
        return {
          currentStep: 3,
          workspaceId: 'ws-persisted',
          directionDone: true,
          completed: true,
        };
      }
      if (path === '/api/health') return {};
      return {};
    });

    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <OnboardingWizard />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Configure Direction' })).toBeInTheDocument();
    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/onboarding', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          currentStep: 2,
          workspaceId: 'ws-selected',
          directionDone: false,
          completed: false,
        }),
      }));
    });
  });
});
