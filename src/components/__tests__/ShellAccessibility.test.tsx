/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LiteModeBanner } from '../Shell';

const mocks = vi.hoisted(() => ({
  recheckAge: vi.fn(),
}));

vi.mock('../../contexts/CapabilitiesContext', () => ({
  useCapabilities: () => ({
    capabilities: { age: false },
    mode: 'native',
    databaseCapability: { graphMode: 'lite', warnings: [] },
    recheckAge: mocks.recheckAge,
  }),
}));

describe('Lite Mode dialog accessibility', () => {
  beforeEach(() => {
    sessionStorage.clear();
    mocks.recheckAge.mockReset();
  });

  it('moves focus inside, traps Tab, closes on Escape, and restores the Enable trigger', async () => {
    const user = userEvent.setup();
    render(<LiteModeBanner />);
    const enable = screen.getByRole('button', { name: 'Enable →' });

    await user.click(enable);
    const dialog = screen.getByRole('dialog', { name: 'Enable Apache AGE for graph memory features?' });
    const close = screen.getByRole('button', { name: 'Close AGE enable modal' });
    await waitFor(() => expect(close).toHaveFocus());

    const lastAction = screen.getByRole('button', { name: 'Dismiss for session' });
    lastAction.focus();
    await user.tab();
    expect(close).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(enable).toHaveFocus());
  });
});
