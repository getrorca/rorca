/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { AssembledLifecycleCompileInput } from '../../ssdlc-plan-compiler';
import type { CompilerProfile } from '../../ssdlc-contracts';

export const CONTRACT_TIME = '2026-07-15T12:00:00.000Z';
export const CONTRACT_SPEC_HASH = `sha256:${'1'.repeat(64)}` as const;

export interface CompilerProfileFixture {
  name: string;
  tags: string[];
  fileHints: string[];
  description: string;
  expectedProfiles: CompilerProfile[];
  expectedImplementationClassification: 'documentation' | 'code_change' | 'data_storage' | 'release_operation';
}

/** Every fixed compiler profile is represented by authoritative canonical signals. */
export const COMPILER_PROFILE_FIXTURES: CompilerProfileFixture[] = [
  {
    name: 'docs-only',
    tags: ['docs-only'],
    fileHints: ['docs/lifecycle.md'],
    description: 'Document the lifecycle contract without changing runtime behavior.',
    expectedProfiles: ['docs-only'],
    expectedImplementationClassification: 'documentation',
  },
  {
    name: 'code',
    tags: ['backend'],
    fileHints: ['backend/src/lib/lifecycle.ts'],
    description: 'Implement the lifecycle contract.',
    expectedProfiles: ['code-change'],
    expectedImplementationClassification: 'code_change',
  },
  {
    name: 'data',
    tags: ['database'],
    fileHints: ['backend/src/db/migrations/063_lifecycle.sql'],
    description: 'Add a PostgreSQL schema migration with rollback and recovery.',
    expectedProfiles: ['code-change', 'data-storage'],
    expectedImplementationClassification: 'data_storage',
  },
  {
    name: 'security',
    tags: ['security'],
    fileHints: ['backend/src/lib/auth-policy.ts'],
    description: 'Enforce authorization boundaries and secret redaction.',
    expectedProfiles: ['code-change', 'security-sensitive'],
    expectedImplementationClassification: 'code_change',
  },
  {
    name: 'ChatOps integration',
    tags: ['chatops'],
    fileHints: ['backend/src/lib/slack-adapter.ts'],
    description: 'Consume a bounded Slack webhook through the external adapter.',
    expectedProfiles: ['code-change', 'integration'],
    expectedImplementationClassification: 'code_change',
  },
  {
    name: 'release operations',
    tags: ['release'],
    fileHints: ['deploy/helm/values.yaml'],
    description: 'Deploy an immutable artifact to production with rollback checks.',
    expectedProfiles: ['code-change', 'release-operations'],
    expectedImplementationClassification: 'release_operation',
  },
];

export function compilerInput(fixture: CompilerProfileFixture = COMPILER_PROFILE_FIXTURES[1]): AssembledLifecycleCompileInput {
  return {
    schemaVersion: 1,
    workspaceId: 'workspace-contract',
    canonicalSpec: {
      specId: 'lifecycle-contract',
      version: '17',
      contentHash: CONTRACT_SPEC_HASH,
      json: {
        tags: fixture.tags,
        fileHints: fixture.fileHints,
        userStories: [{
          id: 'LFC-022',
          title: fixture.name,
          description: fixture.description,
          acceptanceCriteria: ['The current immutable revision has matching evidence.'],
          tags: fixture.tags,
          fileHints: fixture.fileHints,
        }],
      },
    },
    workspaceTags: [],
    riskAssignments: [],
    ownerAssignments: [],
    policyAnnotations: [],
    compilerAnnotations: [],
    compilerVersion: 'ssdlc-plan-compiler-1',
    policyVersion: 'lifecycle-policy-1',
    compiledAt: CONTRACT_TIME,
  };
}
