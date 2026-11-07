/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserAuthenticationRequest } from '../../api/browser-session-broker';
import BrowserAuthenticationTakeover from '../BrowserAuthenticationTakeover';

function request(overrides: Partial<BrowserAuthenticationRequest> = {}): BrowserAuthenticationRequest {
  return {
    requestId: '66666666-6666-4666-8666-666666666666',
    leaseId: '44444444-4444-4444-8444-444444444444',
    bindingId: '22222222-2222-4222-8222-222222222222',
    workspaceId: 'workspace-browser-tests',
    externalProvider: 'claude',
    runId: '20260316000241',
    storyId: 'BSB-003',
    purpose: 'provider-mcp-conformance',
    profileGeneration: 1,
    step: 'mfa',
    evidence: {
      schemaVersion: 'rorca.browser-authentication-observation.v1',
      observedAt: '2026-08-24T12:00:00.000Z',
      currentOrigin: 'https://claude.ai',
      signal: 'mfa_prompt',
      providerStateDigest: `sha256:${'1'.repeat(64)}`,
      accessibilityDigest: `sha256:${'2'.repeat(64)}`,
      screenshotDigest: `sha256:${'3'.repeat(64)}`,
      automationPolicy: 'human_only',
      redaction: 'required',
    },
    state: 'WAITING_FOR_AUTHENTICATION',
    disposition: null,
    outcomeCode: null,
    detectedAt: '2026-08-24T12:00:00.000Z',
    authenticationExpiresAt: '2026-08-24T12:10:00.000Z',
    resolvedAt: null,
    resumedAt: null,
    resumeCount: 0,
    operatorTakeover: {
      surface: 'dedicated-browser-window',
      modelControl: 'suspended',
      automationControl: 'suspended',
      completionVerification: 'trusted-provider-state-required',
      allowedActions: ['complete', 'cancel'],
    },
    ...overrides,
  };
}

describe('BrowserAuthenticationTakeover', () => {
  it('shows exact provider scope and only operator complete/cancel controls while model input is suspended', () => {
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    render(
      <BrowserAuthenticationTakeover
        request={request()}
        resolving={null}
        error={null}
        onComplete={onComplete}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Multi-factor authentication' })).toBeInTheDocument();
    expect(screen.getByText(/Model input and browser automation are suspended/i)).toBeInTheDocument();
    expect(screen.getByText('provider-mcp-conformance')).toBeInTheDocument();
    expect(screen.getByText('https://claude.ai')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Revalidate and resume once/i }));
    fireEvent.click(screen.getByRole('button', { name: /Cancel and revoke/i }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('disables completion for provider anti-automation policy while preserving cancellation', () => {
    render(
      <BrowserAuthenticationTakeover
        request={request({
          step: 'anti_automation',
          evidence: {
            ...request().evidence,
            signal: 'anti_automation_notice',
            automationPolicy: 'prohibited',
          },
        })}
        resolving={null}
        error={null}
        onComplete={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText(/Provider policy prohibits automation/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Revalidate and resume once/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Cancel and revoke/i })).toBeEnabled();
  });
});
