/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ResizableSidebar from '../ResizableSidebar';
import SplitPane from '../SplitPane';

vi.mock('../../hooks/useBreakpoint', () => ({
  useBreakpoint: () => 'desktop',
}));

vi.mock('../../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

describe('keyboard-operable resizable panels', () => {
  beforeEach(() => localStorage.clear());

  it('resizes, collapses, and expands the desktop navigation separator from the keyboard', () => {
    render(<ResizableSidebar><nav>Main navigation</nav></ResizableSidebar>);
    const separator = screen.getByRole('separator', { name: 'Resize main navigation' });
    expect(separator).toHaveAttribute('tabindex', '0');
    expect(separator).toHaveAttribute('aria-valuenow', '240');

    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator).toHaveAttribute('aria-valuenow', '256');
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(separator).toHaveAttribute('aria-valuetext', 'Collapsed');
    fireEvent.keyDown(separator, { key: 'Enter' });
    expect(separator).toHaveAttribute('aria-valuenow', '256');
    fireEvent.keyDown(separator, { key: 'End' });
    expect(separator).toHaveAttribute('aria-valuenow', '400');
  });

  it('adjusts the split-pane ratio with Arrow, Home, and End keys', () => {
    render(<SplitPane left={<div>Run output</div>} right={<div>Story details</div>} />);
    const separator = screen.getByRole('separator', { name: 'Resize run detail panels' });
    Object.defineProperty(separator.parentElement!, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ width: 1000, height: 600, left: 0, right: 1000, top: 0, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }),
    });

    expect(separator).toHaveAttribute('aria-valuenow', '60');
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator).toHaveAttribute('aria-valuenow', '65');
    expect(separator).toHaveAttribute('aria-valuemin', '20');
    expect(separator).toHaveAttribute('aria-valuemax', '80');
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(separator).toHaveAttribute('aria-valuenow', '20');
    fireEvent.keyDown(separator, { key: 'End' });
    expect(separator).toHaveAttribute('aria-valuenow', '80');
  });
});
