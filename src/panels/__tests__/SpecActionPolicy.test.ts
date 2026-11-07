/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from 'vitest';
import { classifyBoardDrop } from '../SpecsPanel';
import { canExecuteReviewedSpec } from '../SpecReviewPanel';

describe('spec action trust policy', () => {
  it('never allows a pending spec to execute, even when readiness advertises run', () => {
    expect(canExecuteReviewedSpec('pending', { availableActions: ['run'] }, null)).toBe(false);
  });

  it('requires both approval and canonical readiness', () => {
    expect(canExecuteReviewedSpec('approved', null, null)).toBe(false);
    expect(canExecuteReviewedSpec('approved', { availableActions: ['run'] }, null)).toBe(true);
  });

  it('treats system-column drag as governed status instead of a mutation', () => {
    expect(classifyBoardDrop('draft', 'in-progress')).toBe('governed-status');
    expect(classifyBoardDrop('in-progress', 'done')).toBe('governed-status');
    expect(classifyBoardDrop('draft', 'draft')).toBe('reorder');
    expect(classifyBoardDrop('draft', 'custom-17')).toBe('view-group');
  });
});
