/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  ENTITY_KINDS,
  EntityRefV1Schema,
  MISSION_CONTRACT_VERSIONS,
  type EntityRefV1,
  type ParentEntityRefV1,
  type RevisionRefV1,
} from '../../shared/contracts/mission';

export const CANONICAL_OBJECT_RESOLVER_ROOT = '/objects';

export type EntityKind = EntityRefV1['kind'];

type RouteBuilder = (entity: EntityRefV1) => string;

const enc = encodeURIComponent;

function workspaceRoot(entity: EntityRefV1): string {
  return `/workspaces/${enc(entity.workspaceId)}`;
}

function resolverPath(entity: EntityRefV1): string {
  return `${workspaceRoot(entity)}${CANONICAL_OBJECT_RESOLVER_ROOT}/${enc(entity.kind)}/${enc(entity.id)}`;
}

function parentIs(entity: EntityRefV1, kind: EntityKind): entity is EntityRefV1 & { parent: ParentEntityRefV1 } {
  return entity.parent?.kind === kind;
}

/**
 * One exhaustive registry for EntityRefV1. Kinds without a dedicated existing
 * object surface deliberately share the object resolver instead of guessing a
 * panel root.
 */
export const ENTITY_ROUTE_REGISTRY = {
  workspace: (entity) => workspaceRoot(entity),
  mission: resolverPath,
  spec: (entity) => `${workspaceRoot(entity)}/specs/${enc(entity.id)}/review`,
  story: resolverPath,
  run: (entity) => `${workspaceRoot(entity)}/runs/${enc(entity.id)}`,
  attempt: resolverPath,
  process: resolverPath,
  phase: (entity) => parentIs(entity, 'spec')
    ? `${workspaceRoot(entity)}/specs/${enc(entity.parent.id)}/lifecycle/phases/${enc(entity.id)}`
    : resolverPath(entity),
  gate: resolverPath,
  evidence: (entity) => parentIs(entity, 'spec')
    ? `${workspaceRoot(entity)}/specs/${enc(entity.parent.id)}/lifecycle/evidence/${enc(entity.id)}`
    : resolverPath(entity),
  decision: resolverPath,
  commit: resolverPath,
  bundle: resolverPath,
  knowledge: resolverPath,
  insight: resolverPath,
} satisfies Record<EntityKind, RouteBuilder>;

const IDENTITY_QUERY_KEYS = [
  'entityId',
  'label',
  'revisionKind',
  'revision',
  'parentKind',
  'parentId',
  'parentLabel',
  'parentRevisionKind',
  'parentRevision',
] as const;

function appendRevision(params: URLSearchParams, prefix: '' | 'parent', revision: RevisionRefV1 | undefined): void {
  if (!revision) return;
  const kindKey = prefix ? 'parentRevisionKind' : 'revisionKind';
  const valueKey = prefix ? 'parentRevision' : 'revision';
  params.set(kindKey, revision.kind);
  params.set(valueKey, revision.value);
}

function identitySearch(entity: EntityRefV1): string {
  const params = new URLSearchParams();
  if (entity.kind === 'workspace' && entity.id !== entity.workspaceId) params.set('entityId', entity.id);
  params.set('label', entity.label);
  appendRevision(params, '', entity.revision);
  if (entity.parent) {
    params.set('parentKind', entity.parent.kind);
    params.set('parentId', entity.parent.id);
    params.set('parentLabel', entity.parent.label);
    appendRevision(params, 'parent', entity.parent.revision);
  }
  const value = params.toString();
  return value ? `?${value}` : '';
}

/** Returns the workspace-qualified canonical URL for an exact entity identity. */
export function entityRoute(entity: EntityRefV1): string {
  const exact = EntityRefV1Schema.parse(entity);
  return `${ENTITY_ROUTE_REGISTRY[exact.kind](exact)}${identitySearch(exact)}`;
}

export const canonicalEntityPath = entityRoute;

interface ParsedRouteIdentity {
  workspaceId: string;
  kind: EntityKind;
  id: string;
  impliedParent?: { kind: EntityKind; id: string };
}

function decodePart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parsePath(pathname: string): ParsedRouteIdentity | null {
  const workspace = pathname.match(/^\/workspaces\/([^/]+)$/);
  if (workspace) {
    const workspaceId = decodePart(workspace[1]);
    return workspaceId ? { workspaceId, kind: 'workspace', id: workspaceId } : null;
  }

  const spec = pathname.match(/^\/workspaces\/([^/]+)\/specs\/([^/]+)\/review$/);
  if (spec) {
    const workspaceId = decodePart(spec[1]);
    const id = decodePart(spec[2]);
    return workspaceId && id ? { workspaceId, kind: 'spec', id } : null;
  }

  const run = pathname.match(/^\/workspaces\/([^/]+)\/runs\/([^/]+)$/);
  if (run) {
    const workspaceId = decodePart(run[1]);
    const id = decodePart(run[2]);
    return workspaceId && id ? { workspaceId, kind: 'run', id } : null;
  }

  const lifecycle = pathname.match(/^\/workspaces\/([^/]+)\/specs\/([^/]+)\/lifecycle\/(phases|evidence)\/([^/]+)$/);
  if (lifecycle) {
    const workspaceId = decodePart(lifecycle[1]);
    const parentId = decodePart(lifecycle[2]);
    const id = decodePart(lifecycle[4]);
    if (!workspaceId || !parentId || !id) return null;
    return {
      workspaceId,
      kind: lifecycle[3] === 'phases' ? 'phase' : 'evidence',
      id,
      impliedParent: { kind: 'spec', id: parentId },
    };
  }

  const resolver = pathname.match(/^\/workspaces\/([^/]+)\/objects\/([^/]+)\/([^/]+)$/);
  if (resolver) {
    const workspaceId = decodePart(resolver[1]);
    const rawKind = decodePart(resolver[2]);
    const id = decodePart(resolver[3]);
    if (!workspaceId || !rawKind || !id || !(ENTITY_KINDS as readonly string[]).includes(rawKind)) return null;
    return { workspaceId, kind: rawKind as EntityKind, id };
  }
  return null;
}

function revisionFrom(params: URLSearchParams, prefix: '' | 'parent'): RevisionRefV1 | undefined | null {
  const kind = params.get(prefix ? 'parentRevisionKind' : 'revisionKind');
  const value = params.get(prefix ? 'parentRevision' : 'revision');
  if (!kind && !value) return undefined;
  if (!kind || !value) return null;
  return { kind, value } as RevisionRefV1;
}

/**
 * Parses only canonical entity URLs. Passing expectedWorkspaceId fails closed
 * when a stale URL belongs to another workspace.
 */
export function parseEntityRoute(input: string, expectedWorkspaceId?: string | null): EntityRefV1 | null {
  if (!input.startsWith('/') || input.startsWith('//') || /[\\\u0000-\u001f]/.test(input)) return null;
  let url: URL;
  try {
    url = new URL(input, 'https://rorca.invalid');
  } catch {
    return null;
  }
  if (url.origin !== 'https://rorca.invalid' || url.hash) return null;
  const parsed = parsePath(url.pathname);
  if (!parsed || (expectedWorkspaceId && parsed.workspaceId !== expectedWorkspaceId)) return null;

  const revision = revisionFrom(url.searchParams, '');
  const parentRevision = revisionFrom(url.searchParams, 'parent');
  if (revision === null || parentRevision === null) return null;

  const queryParentKind = url.searchParams.get('parentKind');
  const queryParentId = url.searchParams.get('parentId');
  if ((queryParentKind && !queryParentId) || (!queryParentKind && queryParentId)) return null;
  if (queryParentKind && !(ENTITY_KINDS as readonly string[]).includes(queryParentKind)) return null;

  const parentKind = (queryParentKind as EntityKind | null) ?? parsed.impliedParent?.kind;
  const parentId = queryParentId ?? parsed.impliedParent?.id;
  if (parsed.impliedParent && (parentKind !== parsed.impliedParent.kind || parentId !== parsed.impliedParent.id)) return null;

  const candidate: EntityRefV1 = {
    schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
    workspaceId: parsed.workspaceId,
    kind: parsed.kind,
    id: parsed.kind === 'workspace' ? (url.searchParams.get('entityId') ?? parsed.id) : parsed.id,
    label: url.searchParams.get('label') ?? parsed.id,
    ...(revision ? { revision } : {}),
    ...(parentKind && parentId ? {
      parent: {
        workspaceId: parsed.workspaceId,
        kind: parentKind,
        id: parentId,
        label: url.searchParams.get('parentLabel') ?? parentId,
        ...(parentRevision ? { revision: parentRevision } : {}),
      },
    } : {}),
  };
  const result = EntityRefV1Schema.safeParse(candidate);
  return result.success ? result.data : null;
}

/** Identity from another workspace is incompatible and must be cleared. */
export function entityForWorkspace(entity: EntityRefV1 | null | undefined, workspaceId: string | null): EntityRefV1 | null {
  if (!entity || !workspaceId || entity.workspaceId !== workspaceId) return null;
  const result = EntityRefV1Schema.safeParse(entity);
  return result.success ? result.data : null;
}

/** Resolve an exact entity-bearing payload; legacy guessed links are ignored. */
export function resolveEntityNavigation(
  entity: EntityRefV1 | null | undefined,
  canonicalHref: string | null | undefined,
  workspaceId: string | null,
): EntityRefV1 | null {
  return entityForWorkspace(entity, workspaceId)
    ?? (canonicalHref ? parseEntityRoute(canonicalHref, workspaceId) : null);
}

/** Removes only canonical identity metadata, preserving view-owned query state. */
export function stripEntityIdentitySearch(search: string): string {
  const params = new URLSearchParams(search);
  for (const key of IDENTITY_QUERY_KEYS) params.delete(key);
  const value = params.toString();
  return value ? `?${value}` : '';
}
