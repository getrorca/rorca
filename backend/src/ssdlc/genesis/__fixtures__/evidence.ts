/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

export const genesisEvidenceFixtures = [
  {
    evidence: {
      genesisEvidenceId: 'GEN-001',
      sourceTitle: 'Authorization Baseline',
      exactCitation: 'Genesis Authorization Standard, section 4.1',
      evidenceStrength: 'primary',
      supersededBy: 'GEN-002',
      contradictionGroup: 'authz-conflict',
    },
    bridgeProvenance: { source: 'genesis-bridge', reviewStatus: 'approved', access: 'allowed' },
  },
  {
    evidence: {
      genesisEvidenceId: 'GEN-002',
      sourceTitle: 'Authorization Baseline Revision 2',
      exactCitation: 'Genesis Authorization Standard, section 4.2',
      evidenceStrength: 'primary',
      supersedes: ['GEN-001'],
      contradictionGroup: 'authz-conflict',
    },
    bridgeProvenance: { source: 'genesis-bridge', reviewStatus: 'trusted', access: 'allowed' },
  },
  {
    evidence: {
      genesisEvidenceId: 'GEN-003',
      sourceTitle: 'Restricted Authorization Commentary',
      exactCitation: 'Genesis commentary R-3',
      evidenceStrength: 'secondary',
    },
    bridgeProvenance: { source: 'genesis-bridge', reviewStatus: 'pending', access: 'denied' },
  },
  {
    evidence: {
      genesisEvidenceId: 'GEN-004',
      sourceTitle: 'Pending Authorization Commentary',
      exactCitation: 'Genesis commentary P-4',
      evidenceStrength: 'secondary',
    },
    bridgeProvenance: { source: 'genesis-bridge', reviewStatus: 'pending', access: 'allowed' },
  },
] as const;
