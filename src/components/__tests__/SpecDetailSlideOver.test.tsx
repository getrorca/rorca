/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, it, expect } from 'vitest';
import { getGenerationLogPresentation } from '../SpecDetailSlideOver';

describe('getGenerationLogPresentation', () => {
  it('renders persisted explicit drafts as successful persistence, not failure', () => {
    expect(getGenerationLogPresentation({ status: 'persisted', enriched: false })).toMatchObject({
      tone: 'success',
      title: 'Draft Persisted',
      badgeLabel: 'Persisted',
    });
  });

  it('renders pending_enrichment as persisted with pending enrichment messaging', () => {
    expect(getGenerationLogPresentation({ status: 'pending_enrichment', enriched: false })).toMatchObject({
      tone: 'success',
      title: 'Draft Persisted · Enrichment Pending',
      badgeLabel: 'Persisted',
    });
  });

  it('keeps completed generation as success', () => {
    expect(getGenerationLogPresentation({ status: 'completed', enriched: false })).toMatchObject({
      tone: 'success',
      title: 'Generation Succeeded',
      badgeLabel: 'Generated',
    });
  });

  it('keeps failed enrichment as an error state', () => {
    expect(getGenerationLogPresentation({ status: 'failed', enriched: true })).toMatchObject({
      tone: 'error',
      title: 'Enrichment Failed',
      badgeLabel: 'Enriched',
    });
  });
});
