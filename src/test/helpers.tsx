/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import React, { type ReactElement } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { WorkspaceProvider } from '../contexts/WorkspaceContext';
import { AuthProvider } from '../contexts/AuthContext';
import { ThemeProvider } from '../contexts/ThemeContext';
import { ToastProvider } from '../contexts/ToastContext';
import { HelpTipsProvider } from '../contexts/HelpTipsContext';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MockWorkspace {
  id: string;
  label: string;
  path: string;
  domains: string[];
}

export interface MockSpec {
  id: string;
  specName: string;
  storyCount: number;
  status: 'pending' | 'approved';
  generatedAt: string;
  workspaceId: string;
}

export interface MockRun {
  id: number;
  spec_path: string;
  workspace_id: string;
  status: 'running' | 'paused' | 'done' | 'failed' | 'partial_failure' | 'cancelled';
  pid: number | null;
  started_at: string;
  finished_at: string | null;
  agent_type?: string;
  agent_model?: string | null;
  terminal_mode?: 'ansi-html' | 'pty' | 'native-pty';
}

// ─── Providers wrapper ────────────────────────────────────────────────────────

/**
 * Wraps a component in all required Rorca providers:
 * WorkspaceContext, AuthContext, ThemeContext, ToastContext.
 *
 * Usage:
 * ```tsx
 * const { getByText } = renderWithProviders(<MyPanel onNavigate={vi.fn()} />);
 * ```
 */
export function renderWithProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
): RenderResult {
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <HelpTipsProvider>
              <MemoryRouter><WorkspaceProvider>{children}</WorkspaceProvider></MemoryRouter>
            </HelpTipsProvider>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...options });
}

// ─── API mock helper ──────────────────────────────────────────────────────────

/**
 * Mocks the global fetch for a specific URL pattern.
 * Call this before renderWithProviders to intercept API calls.
 *
 * Usage:
 * ```tsx
 * mockApiResponse('/api/workspaces', { workspaces: [createMockWorkspace()] });
 * renderWithProviders(<SpecsPanel onNavigate={vi.fn()} />);
 * ```
 */
export function mockApiResponse(urlPattern: string | RegExp, data: unknown, status = 200): void {
  (vi.mocked(window.fetch)).mockImplementation((input: RequestInfo | URL) => {
    const url = input.toString();
    const matches =
      typeof urlPattern === 'string' ? url.includes(urlPattern) : urlPattern.test(url);
    if (matches) {
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(data),
        text: () => Promise.resolve(JSON.stringify(data)),
      } as Response);
    }
    // Default: return empty 200 for unmatched routes
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('{}'),
    } as Response);
  });
}

/**
 * Mocks multiple API routes in one call.
 *
 * Usage:
 * ```tsx
 * mockApiResponses({
 *   '/api/workspaces': { workspaces: [createMockWorkspace()] },
 *   '/api/pipeline/runs': { runs: [] },
 * });
 * ```
 */
export function mockApiResponses(routes: Record<string, unknown>): void {
  (vi.mocked(window.fetch)).mockImplementation((input: RequestInfo | URL) => {
    const url = input.toString();
    for (const [pattern, data] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(data),
          text: () => Promise.resolve(JSON.stringify(data)),
        } as Response);
      }
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve('{}'),
    } as Response);
  });
}

// ─── Factory functions ────────────────────────────────────────────────────────

/**
 * Creates a mock workspace with sensible defaults.
 *
 * Usage:
 * ```tsx
 * const ws = createMockWorkspace({ label: 'My Project' });
 * ```
 */
export function createMockWorkspace(overrides: Partial<MockWorkspace> = {}): MockWorkspace {
  return {
    id: 'ws-test-1',
    label: 'Test Workspace',
    path: '/tmp/test-workspace',
    domains: [],
    ...overrides,
  };
}

/**
 * Creates a mock spec in pending state with sensible defaults.
 *
 * Usage:
 * ```tsx
 * const spec = createMockSpec({ status: 'approved', storyCount: 5 });
 * ```
 */
export function createMockSpec(overrides: Partial<MockSpec> = {}): MockSpec {
  return {
    id: 'test-spec-slug',
    specName: 'Test Spec',
    storyCount: 3,
    status: 'pending',
    generatedAt: new Date().toISOString(),
    workspaceId: 'ws-test-1',
    ...overrides,
  };
}

/**
 * Creates a mock pipeline run with sensible defaults.
 *
 * Usage:
 * ```tsx
 * const run = createMockRun({ status: 'running', id: 42 });
 * ```
 */
export function createMockRun(overrides: Partial<MockRun> = {}): MockRun {
  return {
    id: 1,
    spec_path: 'forge/specs/approved/test-spec-slug.json',
    workspace_id: 'ws-test-1',
    status: 'done',
    pid: null,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    finished_at: new Date().toISOString(),
    agent_type: 'claude',
    agent_model: null,
    terminal_mode: 'ansi-html',
    ...overrides,
  };
}

// ─── Navigation mock ──────────────────────────────────────────────────────────

/**
 * Returns a mock router object for testing panel navigation callbacks.
 *
 * Usage:
 * ```tsx
 * const router = mockRouter();
 * renderWithProviders(<SpecsPanel onNavigate={router.onNavigate} />);
 * await userEvent.click(getByText('Settings'));
 * expect(router.onNavigate).toHaveBeenCalledWith('settings');
 * ```
 */
export function mockRouter() {
  return {
    onNavigate: vi.fn(),
    onNavigateToRun: vi.fn(),
    onNavigateToSpecReview: vi.fn(),
  };
}
