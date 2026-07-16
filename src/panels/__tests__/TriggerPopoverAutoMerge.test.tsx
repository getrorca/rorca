/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TriggerPopover from '../../components/TriggerPopover';

// ─── Mock apiFetch ────────────────────────────────────────────────────────────
vi.mock('../../lib/apiFetch', () => ({
  apiFetch: vi.fn(),
  BASE_URL: 'http://localhost:3030',
  onApiFetchError: vi.fn(() => () => {}),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => null),
  getRefreshToken: vi.fn(() => null),
}));

import { apiFetch } from '../../lib/apiFetch';
const mockApiFetch = vi.mocked(apiFetch);

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockApiFetch.mockResolvedValue({} as never);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TriggerPopover — autoMerge checkbox', () => {
  it('completion action control is hidden when autoWorktree is off (default)', () => {
    const onTrigger = vi.fn();
    render(
      <TriggerPopover
        loading={false}
        onTrigger={onTrigger}
        onClose={vi.fn()}
      />,
    );

    const completionAction = screen.queryByRole('combobox', { name: /completion action/i });
    expect(completionAction).toBeNull();
  });

  it('completion action control is visible when autoWorktree is toggled on', () => {
    const onTrigger = vi.fn();
    render(
      <TriggerPopover
        loading={false}
        onTrigger={onTrigger}
        onClose={vi.fn()}
      />,
    );

    // Toggle on the worktree isolation checkbox
    const worktreeCheckbox = screen.getByRole('checkbox', { name: /isolate in worktree/i });
    fireEvent.click(worktreeCheckbox);

    const completionAction = screen.getByRole('combobox', { name: /completion action/i }) as HTMLSelectElement;
    expect(completionAction).toBeInTheDocument();
    expect(completionAction.value).toBe('direct');
  });

  it('completion action defaults to direct merge when autoWorktree is enabled', () => {
    const onTrigger = vi.fn();
    render(
      <TriggerPopover
        loading={false}
        onTrigger={onTrigger}
        onClose={vi.fn()}
      />,
    );

    // Toggle worktree isolation on
    const worktreeCheckbox = screen.getByRole('checkbox', { name: /isolate in worktree/i });
    fireEvent.click(worktreeCheckbox);

    const completionAction = screen.getByRole('combobox', { name: /completion action/i }) as HTMLSelectElement;
    expect(completionAction.value).toBe('direct');
  });

  it('payload sent to onTrigger includes autoMerge:true when worktree on and merge checked', () => {
    const onTrigger = vi.fn();
    render(
      <TriggerPopover
        loading={false}
        onTrigger={onTrigger}
        onClose={vi.fn()}
      />,
    );

    // Enable worktree isolation
    const worktreeCheckbox = screen.getByRole('checkbox', { name: /isolate in worktree/i });
    fireEvent.click(worktreeCheckbox);

    // Merge is checked by default — click Run Now
    const runBtn = screen.getByRole('button', { name: /run now/i });
    fireEvent.click(runBtn);

    expect(onTrigger).toHaveBeenCalledOnce();
    const [autoWorktree, options] = onTrigger.mock.calls[0];
    expect(autoWorktree).toBe(true);
    expect(options?.autoMerge).toBe(true);
  });

  it('requests native PTY mode and sequential execution when the interactive terminal is selected', () => {
    const onTrigger = vi.fn();
    render(
      <TriggerPopover loading={false} onTrigger={onTrigger} onClose={vi.fn()} />,
    );

    fireEvent.change(screen.getByRole('combobox', { name: /terminal stream/i }), {
      target: { value: 'native-pty' },
    });
    fireEvent.click(screen.getByRole('button', { name: /run now/i }));

    expect(onTrigger).toHaveBeenCalledOnce();
    const [, options] = onTrigger.mock.calls[0];
    expect(options).toEqual(expect.objectContaining({
      terminal_mode: 'native-pty',
      forceSequential: true,
    }));
  });

  it('completion action control is hidden again after autoWorktree is toggled back off', () => {
    const onTrigger = vi.fn();
    render(
      <TriggerPopover
        loading={false}
        onTrigger={onTrigger}
        onClose={vi.fn()}
      />,
    );

    const worktreeCheckbox = screen.getByRole('checkbox', { name: /isolate in worktree/i });
    // Toggle on
    fireEvent.click(worktreeCheckbox);
    expect(screen.getByRole('combobox', { name: /completion action/i })).toBeInTheDocument();

    // Toggle off
    fireEvent.click(worktreeCheckbox);
    expect(screen.queryByRole('combobox', { name: /completion action/i })).toBeNull();
  });
});
