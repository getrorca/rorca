/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { requiresValidatedAuthoringForApproval } from '../spec-approval-authority';

describe('spec approval authoring authority', () => {
  it('does not conflate direct local review approval with lifecycle authoring validation', () => {
    expect(requiresValidatedAuthoringForApproval({
      hasAuthoringMetadata: true,
      authoringState: 'needs_authoring_preflight',
      localHumanApprovalPrincipal: true,
    })).toBe(false);
  });

  it('keeps relayed and service approval provenance-gated', () => {
    expect(requiresValidatedAuthoringForApproval({
      hasAuthoringMetadata: true,
      authoringState: 'needs_authoring_preflight',
      localHumanApprovalPrincipal: false,
    })).toBe(true);
  });

  it('allows validated authoring and legacy drafts without authoring metadata', () => {
    expect(requiresValidatedAuthoringForApproval({
      hasAuthoringMetadata: true,
      authoringState: 'validated',
      localHumanApprovalPrincipal: false,
    })).toBe(false);
    expect(requiresValidatedAuthoringForApproval({
      hasAuthoringMetadata: false,
      authoringState: undefined,
      localHumanApprovalPrincipal: false,
    })).toBe(false);
  });
});
