/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TriggerPopover from '../../components/TriggerPopover';

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

afterAll(() => vi.restoreAllMocks());
beforeEach(() => {
  vi.clearAllMocks();
  mockApiFetch.mockResolvedValue({} as never);
});

describe('TriggerPopover — safe local execution defaults', () => {
  it('keeps isolated worktree execution visibly required', () => {
    render(<TriggerPopover loading={false} onTrigger={vi.fn()} onClose={vi.fn()} />);

    const worktree = screen.getByRole('checkbox', { name: /isolate in worktree/i }) as HTMLInputElement;
    expect(worktree.checked).toBe(true);
    expect(worktree.disabled).toBe(true);
    expect(screen.getByText('required')).toBeInTheDocument();
  });

  it('offers only the local branch completion action', () => {
    render(<TriggerPopover loading={false} onTrigger={vi.fn()} onClose={vi.fn()} />);

    const action = screen.getByRole('combobox', { name: /completion action/i }) as HTMLSelectElement;
    expect(action.value).toBe('branch-only');
    expect(Array.from(action.options).map(option => option.value)).toEqual(['branch-only']);
    expect(screen.getByText(/no push, merge, PR, or deployment/i)).toBeInTheDocument();
  });

  it('submits the complete local-only sequential profile by default', () => {
    const onTrigger = vi.fn();
    render(<TriggerPopover loading={false} onTrigger={onTrigger} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /run now/i }));

    expect(onTrigger).toHaveBeenCalledOnce();
    const [autoWorktree, options] = onTrigger.mock.calls[0];
    expect(autoWorktree).toBe(true);
    expect(options).toEqual(expect.objectContaining({
      autoMerge: false,
      mergeStrategy: 'branch-only',
      terminal_mode: 'ansi-html',
      forceSequential: true,
      orchestrationMode: 'sequential',
      parallelism: 1,
    }));
  });

  it('labels reliable autonomous output as the default terminal', () => {
    render(<TriggerPopover loading={false} onTrigger={vi.fn()} onClose={vi.fn()} />);
    const terminal = screen.getByRole('combobox', { name: /terminal stream/i }) as HTMLSelectElement;
    expect(terminal.value).toBe('ansi-html');
    expect(screen.getByRole('option', { name: /reliable autonomous/i })).toBeInTheDocument();
  });

  it('uses native PTY only after explicit interactive selection', () => {
    const onTrigger = vi.fn();
    render(<TriggerPopover loading={false} onTrigger={onTrigger} onClose={vi.fn()} />);

    fireEvent.change(screen.getByRole('combobox', { name: /terminal stream/i }), {
      target: { value: 'native-pty' },
    });
    fireEvent.click(screen.getByRole('button', { name: /run now/i }));

    const [, options] = onTrigger.mock.calls[0];
    expect(options).toEqual(expect.objectContaining({ terminal_mode: 'native-pty', forceSequential: true }));
  });
});
