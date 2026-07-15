/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createRef, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SlideOver from '../SlideOver';

const mocks = vi.hoisted(() => ({ breakpoint: 'desktop' as 'desktop' | 'tablet' | 'mobile' }));

vi.mock('../../hooks/useBreakpoint', () => ({
  useBreakpoint: () => mocks.breakpoint,
}));

function ResponsiveHarness() {
  const [open, setOpen] = useState(false);
  const opener = createRef<HTMLButtonElement>();
  return (
    <>
      <button ref={opener} type="button" onClick={() => setOpen(true)}>Open validation phase</button>
      <div data-testid="board-background">Scrollable 11-phase matrix remains available</div>
      <SlideOver
        isOpen={open}
        onClose={() => setOpen(false)}
        title="Billing anomaly alerts — Validation"
        desktopMaxWidth={520}
        fullScreenBelowDesktop
        allowBackgroundInteraction
        restoreFocusRef={opener}
      >
        <button type="button">Inspect evidence</button>
        <button type="button">Retry story US-006</button>
      </SlideOver>
    </>
  );
}

beforeEach(() => { mocks.breakpoint = 'desktop'; });

describe('Lifecycle responsive phase drawer', () => {
  it('matches the 1440px wireframe with a bounded drawer and retained matrix', async () => {
    const user = userEvent.setup();
    render(<ResponsiveHarness />);
    await user.click(screen.getByRole('button', { name: 'Open validation phase' }));

    const dialog = screen.getByRole('dialog', { name: 'Billing anomaly alerts — Validation' });
    expect(dialog).not.toHaveAttribute('aria-modal');
    expect(dialog).toHaveClass('pointer-events-none');
    expect(dialog.querySelector<HTMLElement>('[data-slide-content]')?.parentElement).toHaveStyle({ maxWidth: '520px' });
    expect(screen.getByTestId('board-background')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inspect evidence' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry story US-006' })).toBeVisible();
  });

  it.each(['tablet', 'mobile'] as const)('uses a full-screen %s dialog without hiding required actions', async (breakpoint) => {
    mocks.breakpoint = breakpoint;
    const user = userEvent.setup();
    render(<ResponsiveHarness />);
    await user.click(screen.getByRole('button', { name: 'Open validation phase' }));

    const dialog = screen.getByRole('dialog', { name: 'Billing anomaly alerts — Validation' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveClass('fixed', 'inset-0');
    expect(screen.getByRole('button', { name: 'Close panel' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Inspect evidence' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry story US-006' })).toBeVisible();
  });

  it('traps keyboard focus, closes with Escape, and restores the matrix opener', async () => {
    const user = userEvent.setup();
    render(<ResponsiveHarness />);
    const opener = screen.getByRole('button', { name: 'Open validation phase' });
    await user.click(opener);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close panel' })).toHaveFocus());

    const lastAction = screen.getByRole('button', { name: 'Retry story US-006' });
    lastAction.focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close panel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
