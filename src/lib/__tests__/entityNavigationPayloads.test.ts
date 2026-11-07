/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { describe, expect, it } from 'vitest';
import { MISSION_CONTRACT_VERSIONS, type EntityRefV1 } from '../../../shared/contracts/mission';
import { searchResultEntity } from '../../components/CommandPalette';
import { entityRoute, resolveEntityNavigation } from '../entityRoutes';

const exactSpec: EntityRefV1 = {
  schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
  workspaceId: 'ws-1',
  kind: 'spec',
  id: 'payments',
  label: 'Payments',
  revision: { kind: 'spec_version', value: '17' },
};

const fallbackSpec: EntityRefV1 = {
  ...exactSpec,
  revision: undefined,
};

describe('search and notification identity', () => {
  it('keeps the exact server-projected search identity including revision', () => {
    expect(searchResultEntity(exactSpec, fallbackSpec, 'ws-1')).toEqual(exactSpec);
    expect(searchResultEntity({ ...exactSpec, workspaceId: 'ws-2' }, fallbackSpec, 'ws-1')).toEqual(fallbackSpec);
  });

  it('opens notification EntityRef payloads without guessing from display strings', () => {
    expect(resolveEntityNavigation(exactSpec, '/specs/payments', 'ws-1')).toEqual(exactSpec);
    expect(resolveEntityNavigation({ ...exactSpec, workspaceId: 'ws-2' }, '/specs/payments', 'ws-1')).toBeNull();
  });

  it('accepts a canonical notification href as an exact typed payload fallback', () => {
    expect(resolveEntityNavigation(null, entityRoute(exactSpec), 'ws-1')).toEqual(exactSpec);
  });
});
