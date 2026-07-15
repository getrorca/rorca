/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SlideOver from '../SlideOver';

const responsive = vi.hoisted(() => ({ breakpoint: 'desktop' as 'mobile' | 'tablet' | 'desktop' }));
vi.mock('../../hooks/useBreakpoint', () => ({ useBreakpoint: () => responsive.breakpoint }));

describe('SlideOver focus and responsive behavior', () => {
  beforeEach(() => { responsive.breakpoint = 'desktop'; });

  it('traps focus, closes with Escape, and restores to the requested selected cell', async () => {
    const user = userEvent.setup();
    const restoreFocusRef: { current: HTMLElement | null } = { current: null };
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <button ref={(node) => { restoreFocusRef.current = node; }}>Selected lifecycle cell</button>
        <SlideOver isOpen onClose={onClose} title="Phase details" restoreFocusRef={restoreFocusRef}>
          <button>Last drawer action</button>
        </SlideOver>
      </>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'Close panel' })).toHaveFocus());
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(screen.getByRole('button', { name: 'Last drawer action' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();

    rerender(
      <>
        <button ref={(node) => { restoreFocusRef.current = node; }}>Selected lifecycle cell</button>
        <SlideOver isOpen={false} onClose={onClose} title="Phase details" restoreFocusRef={restoreFocusRef}>
          <button>Last drawer action</button>
        </SlideOver>
      </>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Selected lifecycle cell' })).toHaveFocus());
  });

  it('keeps the desktop board pointer-accessible and uses the 520px wireframe bound', () => {
    render(
      <SlideOver isOpen onClose={() => undefined} title="Phase details" desktopMaxWidth={520} allowBackgroundInteraction>
        <p>Detail</p>
      </SlideOver>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Phase details' });
    expect(dialog).not.toHaveAttribute('aria-modal');
    expect(dialog).toHaveClass('pointer-events-none');
    const panel = screen.getByText('Detail').closest('[data-slide-content]')?.parentElement;
    expect(panel).toHaveStyle({ maxWidth: '520px' });
    expect(panel).toHaveClass('animate-slideInRight');
  });

  it('becomes a full-screen sheet on tablet when requested', () => {
    responsive.breakpoint = 'tablet';
    render(
      <SlideOver isOpen onClose={() => undefined} title="Phase details" desktopMaxWidth={520} fullScreenBelowDesktop>
        <p>Tablet detail</p>
      </SlideOver>,
    );
    const content = screen.getByText('Tablet detail').closest('[data-slide-content]');
    expect(content?.parentElement).toHaveClass('h-full', 'w-full', 'animate-slide-up-full');
    expect(content?.parentElement).not.toHaveStyle({ maxWidth: '520px' });
  });
});
