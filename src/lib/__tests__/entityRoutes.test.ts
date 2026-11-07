/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from 'vitest';
import {
  ENTITY_KINDS,
  MISSION_CONTRACT_VERSIONS,
  type EntityRefV1,
} from '../../../shared/contracts/mission';
import {
  canonicalEntityPath,
  entityForWorkspace,
  parseEntityRoute,
} from '../entityRoutes';

function entity(kind: EntityRefV1['kind'], id = `${kind}-1`): EntityRefV1 {
  return {
    schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
    workspaceId: 'ws-a',
    kind,
    id,
    label: `${kind} label`,
    revision: { kind: kind === 'spec' ? 'spec_version' : 'snapshot', value: `${kind}-revision/1` },
    ...((kind === 'phase' || kind === 'evidence') ? {
      parent: {
        workspaceId: 'ws-a',
        kind: 'spec' as const,
        id: 'spec/a',
        label: 'Parent spec',
        revision: { kind: 'spec_version' as const, value: '7' },
      },
    } : {}),
  };
}

describe('canonical entity routes', () => {
  it.each(ENTITY_KINDS)('round-trips the exact %s EntityRefV1', (kind) => {
    const ref = entity(kind);
    const path = canonicalEntityPath(ref);
    expect(parseEntityRoute(path, ref.workspaceId)).toEqual(ref);
  });

  it('uses the existing exact spec, run, phase, and evidence surfaces', () => {
    expect(canonicalEntityPath(entity('spec', 'spec one'))).toMatch(/^\/workspaces\/ws-a\/specs\/spec%20one\/review\?/);
    expect(canonicalEntityPath(entity('run', '42'))).toMatch(/^\/workspaces\/ws-a\/runs\/42\?/);
    expect(canonicalEntityPath(entity('phase', 'testing'))).toMatch(/^\/workspaces\/ws-a\/specs\/spec%2Fa\/lifecycle\/phases\/testing\?/);
    expect(canonicalEntityPath(entity('evidence', 'check/7'))).toMatch(/^\/workspaces\/ws-a\/specs\/spec%2Fa\/lifecycle\/evidence\/check%2F7\?/);
  });

  it('sends unsupported object kinds to one honest resolver surface', () => {
    for (const kind of ['mission', 'story', 'gate', 'decision', 'commit', 'bundle', 'knowledge', 'insight'] as const) {
      expect(canonicalEntityPath(entity(kind))).toContain(`/objects/${kind}/`);
    }
  });

  it('rejects malformed, external, and workspace-mismatched routes', () => {
    const path = canonicalEntityPath(entity('run'));
    expect(parseEntityRoute(`https://evil.example${path}`)).toBeNull();
    expect(parseEntityRoute(path.replace('revisionKind=', 'revisionKind=unknown-'), 'ws-a')).toBeNull();
    expect(parseEntityRoute(path, 'other-workspace')).toBeNull();
  });

  it('clears incompatible identity when the workspace changes', () => {
    const ref = entity('spec');
    expect(entityForWorkspace(ref, 'ws-a')).toEqual(ref);
    expect(entityForWorkspace(ref, 'ws-b')).toBeNull();
    expect(entityForWorkspace(ref, null)).toBeNull();
  });
});
