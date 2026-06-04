/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../test/helpers';
import type { BillingProfile } from '../../../api/types';

// ─── Mock the typed analytics API client ──────────────────────────────────────

vi.mock('../../../api/analytics', async () => {
  const actual = await vi.importActual<typeof import('../../../api/analytics')>(
    '../../../api/analytics',
  );
  return {
    ...actual,
    listBillingProfiles: vi.fn(),
    createBillingProfile: vi.fn(),
    updateBillingProfile: vi.fn(),
    deleteBillingProfile: vi.fn(),
  };
});

// Pin the workspace so the tab loads with a stable scope.
vi.mock('../../../contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({ workspaceId: 'ws-1' }),
  WorkspaceProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import {
  listBillingProfiles,
  createBillingProfile,
  updateBillingProfile,
  deleteBillingProfile,
} from '../../../api/analytics';
import { FinOpsSettingsTab } from '../FinOpsSettingsTab';

const mockList = vi.mocked(listBillingProfiles);
const mockCreate = vi.mocked(createBillingProfile);
const mockUpdate = vi.mocked(updateBillingProfile);
const mockDelete = vi.mocked(deleteBillingProfile);

function makeProfile(overrides: Partial<BillingProfile> = {}): BillingProfile {
  return {
    id: 1,
    workspaceId: 'ws-1',
    provider: 'anthropic',
    modelPattern: null,
    billingMode: 'subscription',
    monthlyCostUsd: 200,
    allocationBasis: 'even',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    notes: null,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockList.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockDelete.mockReset();
});

describe('FinOpsSettingsTab — listing', () => {
  it('shows an empty state when there are no profiles', async () => {
    mockList.mockResolvedValue({ profiles: [] });
    renderWithProviders(<FinOpsSettingsTab />);
    expect(await screen.findByText(/no billing profiles yet/i)).toBeInTheDocument();
  });

  it('renders existing profiles and a blended indicator', async () => {
    mockList.mockResolvedValue({
      profiles: [makeProfile(), makeProfile({ id: 2, provider: 'openai', billingMode: 'metered_api', monthlyCostUsd: null, allocationBasis: 'none' })],
    });
    renderWithProviders(<FinOpsSettingsTab />);
    const anthropic = await screen.findByText('anthropic');
    expect(anthropic).toBeInTheDocument();
    expect(screen.getByText('openai')).toBeInTheDocument();
    // Anthropic subscription with even allocation shows a blended badge on its row;
    // the metered openai row does not.
    const anthropicRow = anthropic.closest('div.bg-panel') as HTMLElement;
    expect(within(anthropicRow).getByText('Blended')).toBeInTheDocument();
  });

  it('explains the marginal vs allocated distinction in the header', async () => {
    mockList.mockResolvedValue({ profiles: [] });
    renderWithProviders(<FinOpsSettingsTab />);
    await screen.findByText(/no billing profiles yet/i);
    expect(screen.getByText(/marginal/i)).toBeInTheDocument();
    expect(screen.getByText(/allocated/i)).toBeInTheDocument();
  });

  it('surfaces a load error with a retry control', async () => {
    mockList.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<FinOpsSettingsTab />);
    expect(await screen.findByText(/failed to load billing profiles/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});

describe('FinOpsSettingsTab — create flow', () => {
  it('blocks save and shows validation when provider is empty', async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({ profiles: [] });
    renderWithProviders(<FinOpsSettingsTab />);
    await screen.findByText(/no billing profiles yet/i);

    await user.click(screen.getByRole('button', { name: /new profile/i }));
    const dialog = await screen.findByText('New Billing Profile');
    expect(dialog).toBeInTheDocument();

    // Provider blank + cost blank → submit should not call the API.
    await user.click(screen.getByRole('button', { name: /create profile/i }));

    expect(await screen.findByText(/provider is required/i)).toBeInTheDocument();
    expect(screen.getByText(/subscription mode requires a monthly cost/i)).toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('creates a profile and reloads on a valid submit', async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({ profiles: [] });
    mockCreate.mockResolvedValue({ profile: makeProfile() });
    renderWithProviders(<FinOpsSettingsTab />);
    await screen.findByText(/no billing profiles yet/i);

    await user.click(screen.getByRole('button', { name: /new profile/i }));
    await screen.findByText('New Billing Profile');

    await user.type(screen.getByLabelText('Provider'), 'anthropic');
    await user.type(screen.getByLabelText(/subscription monthly cost/i), '200');

    await user.click(screen.getByRole('button', { name: /create profile/i }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    const [body] = mockCreate.mock.calls[0];
    expect(body).toMatchObject({
      workspace_id: 'ws-1',
      provider: 'anthropic',
      billing_mode: 'subscription',
      monthly_cost_usd: 200,
      allocation_basis: 'even',
      enabled: true,
    });
    // Re-fetches the list after a successful save (initial load + reload).
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it('hides the monthly cost field for non-subscription modes', async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({ profiles: [] });
    renderWithProviders(<FinOpsSettingsTab />);
    await screen.findByText(/no billing profiles yet/i);

    await user.click(screen.getByRole('button', { name: /new profile/i }));
    await screen.findByText('New Billing Profile');

    expect(screen.getByLabelText(/subscription monthly cost/i)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/billing mode/i), 'metered_api');
    expect(screen.queryByLabelText(/subscription monthly cost/i)).not.toBeInTheDocument();
  });
});

describe('FinOpsSettingsTab — edit flow', () => {
  it('hydrates the form from an existing profile and updates it', async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({ profiles: [makeProfile()] });
    mockUpdate.mockResolvedValue({ profile: makeProfile({ monthlyCostUsd: 300 }) });
    renderWithProviders(<FinOpsSettingsTab />);
    await screen.findByText('anthropic');

    await user.click(screen.getByRole('button', { name: /edit anthropic profile/i }));
    await screen.findByText('Edit Billing Profile');

    const costInput = screen.getByLabelText(/subscription monthly cost/i) as HTMLInputElement;
    expect(costInput.value).toBe('200');
    await user.clear(costInput);
    await user.type(costInput, '300');

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    const [id, body] = mockUpdate.mock.calls[0];
    expect(id).toBe(1);
    expect(body).toMatchObject({ monthly_cost_usd: 300 });
  });
});

describe('FinOpsSettingsTab — delete flow', () => {
  it('confirms then deletes a profile', async () => {
    const user = userEvent.setup();
    mockList.mockResolvedValue({ profiles: [makeProfile()] });
    mockDelete.mockResolvedValue({ deleted: 1 });
    renderWithProviders(<FinOpsSettingsTab />);
    await screen.findByText('anthropic');

    await user.click(screen.getByRole('button', { name: /delete anthropic profile/i }));

    const dialog = await screen.findByRole('dialog', { name: /confirm delete billing profile/i });
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith(1));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });
});
