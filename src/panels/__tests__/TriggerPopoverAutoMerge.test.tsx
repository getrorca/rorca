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
  it('autoMerge checkbox is hidden when autoWorktree is off (default)', () => {
    const onTrigger = vi.fn();
    render(
      <TriggerPopover
        loading={false}
        onTrigger={onTrigger}
        onClose={vi.fn()}
      />,
    );

    // autoWorktree is off by default — merge checkbox must not be in the DOM
    const mergeCheckbox = screen.queryByRole('checkbox', { name: /merge to main/i });
    expect(mergeCheckbox).toBeNull();
  });

  it('autoMerge checkbox is visible when autoWorktree is toggled on', () => {
    const onTrigger = vi.fn();
    render(
      <TriggerPopover
        loading={false}
        onTrigger={onTrigger}
        onClose={vi.fn()}
      />,
    );

    // Toggle on the "Use worktrees" checkbox
    const worktreeCheckbox = screen.getByRole('checkbox', { name: /use worktrees/i });
    fireEvent.click(worktreeCheckbox);

    // Merge checkbox should now appear
    const mergeCheckbox = screen.getByRole('checkbox', { name: /merge to main/i });
    expect(mergeCheckbox).toBeInTheDocument();
  });

  it('autoMerge checkbox is checked by default when autoWorktree is enabled', () => {
    const onTrigger = vi.fn();
    render(
      <TriggerPopover
        loading={false}
        onTrigger={onTrigger}
        onClose={vi.fn()}
      />,
    );

    // Toggle worktrees on
    const worktreeCheckbox = screen.getByRole('checkbox', { name: /use worktrees/i });
    fireEvent.click(worktreeCheckbox);

    const mergeCheckbox = screen.getByRole('checkbox', { name: /merge to main/i }) as HTMLInputElement;
    expect(mergeCheckbox.checked).toBe(true);
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

    // Enable worktree
    const worktreeCheckbox = screen.getByRole('checkbox', { name: /use worktrees/i });
    fireEvent.click(worktreeCheckbox);

    // Merge is checked by default — click Run Now
    const runBtn = screen.getByRole('button', { name: /run now/i });
    fireEvent.click(runBtn);

    expect(onTrigger).toHaveBeenCalledOnce();
    const [autoWorktree, options] = onTrigger.mock.calls[0];
    expect(autoWorktree).toBe(true);
    expect(options?.autoMerge).toBe(true);
  });

  it('autoMerge checkbox hidden again after autoWorktree is toggled back off', () => {
    const onTrigger = vi.fn();
    render(
      <TriggerPopover
        loading={false}
        onTrigger={onTrigger}
        onClose={vi.fn()}
      />,
    );

    const worktreeCheckbox = screen.getByRole('checkbox', { name: /use worktrees/i });
    // Toggle on
    fireEvent.click(worktreeCheckbox);
    expect(screen.getByRole('checkbox', { name: /merge to main/i })).toBeInTheDocument();

    // Toggle off
    fireEvent.click(worktreeCheckbox);
    expect(screen.queryByRole('checkbox', { name: /merge to main/i })).toBeNull();
  });
});
