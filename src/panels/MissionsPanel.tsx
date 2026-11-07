/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Missions landing (/missions). A compact delivery-case list derived from the
 * existing persisted-specs API. This panel deliberately renders only what the
 * specs projection actually carries — spec file status, review status, story
 * count, readiness percent, creation time. It never derives lifecycle, stage,
 * or outcome semantics client-side; exact state lives in each Mission
 * workspace, reachable through the row's primary link.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import {
  CheckCheck, CheckCircle2, Clock3, Search, Target, XCircle,
  type LucideIcon,
} from 'lucide-react';
import { listSpecs } from '../api/specs';
import type { ArchiveSpec, SpecStatus } from '../api/types';
import EmptyState from '../components/EmptyState';
import ErrorBanner from '../components/ErrorBanner';
import { SkeletonLine } from '../components/Skeleton';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { ApiError } from '../lib/apiFetch';
import { entityRoute } from '../lib/entityRoutes';
import { formatRelativeTime } from '../lib/missionFormat';
import { missionCasePath } from '../lib/missionRoutes';
import { withReturnContext } from '../lib/returnContext';
import { MISSION_CONTRACT_VERSIONS } from '../../shared/contracts/mission';

/**
 * Spec file status is a persistence state, not an operational outcome. Icons
 * aid scanning, but the chip stays neutral — no outcome tone is invented here.
 */
const STATUS_ICONS: Record<SpecStatus, LucideIcon> = {
  pending: Clock3,
  approved: CheckCircle2,
  rejected: XCircle,
  completed: CheckCheck,
};

const SKELETON_ROWS = [0, 1, 2, 3] as const;

export default function MissionsPanel() {
  const { workspaceId } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();

  const [specs, setSpecs] = useState<ArchiveSpec[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    setSpecs([]);
    setNextCursor(null);
    setHasMore(false);
    setTotal(0);
    setLoading(true);
    setError(null);
    listSpecs({ workspaceId, status: 'all', limit: 50, signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        setSpecs(response.items);
        setNextCursor(response.cursor ?? null);
        setHasMore(response.hasMore);
        setTotal(response.total);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          err instanceof ApiError || err instanceof Error
            ? err.message
            : 'Failed to load missions.',
        );
        setLoading(false);
      });
    return () => controller.abort();
  }, [workspaceId, reloadToken]);

  // Presentation-only narrowing over the explicitly disclosed loaded scope.
  const visibleSpecs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return specs;
    return specs.filter((spec) => spec.specName.toLowerCase().includes(needle));
  }, [specs, query]);

  const loadMore = async () => {
    if (!workspaceId || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await listSpecs({
        workspaceId,
        status: 'all',
        limit: 50,
        cursor: nextCursor,
      });
      setSpecs((current) => {
        const seen = new Set(current.map((spec) => spec.id));
        const additions = response.items.filter((spec) => !seen.has(spec.id));
        return additions.length === 0 ? current : [...current, ...additions];
      });
      setNextCursor(response.cursor ?? null);
      setHasMore(response.hasMore);
      setTotal(response.total);
    } catch (loadError) {
      setError(
        loadError instanceof ApiError || loadError instanceof Error
          ? loadError.message
          : 'Failed to load more missions.',
      );
    } finally {
      setLoadingMore(false);
    }
  };

  const specReviewHref = (spec: ArchiveSpec): string => {
    const canonical = entityRoute({
      schemaVersion: MISSION_CONTRACT_VERSIONS.entityRef,
      workspaceId: workspaceId ?? '',
      kind: 'spec',
      id: spec.id,
      label: spec.specName.slice(0, 160) || spec.id,
    });
    return withReturnContext(canonical, location, {
      lens: 'missions',
      focus: `spec:${spec.id}`,
    });
  };

  const renderBody = () => {
    if (!workspaceId) {
      return (
        <EmptyState
          icon={Target}
          heading="Select a workspace"
          subtext="Missions are derived from the specs persisted in a workspace. Choose a workspace to see them."
          variant="section"
        />
      );
    }

    if (loading && specs.length === 0 && !error) {
      return (
        <ul aria-label="Loading missions" aria-busy="true" className="space-y-3">
          {SKELETON_ROWS.map((row) => (
            <li
              key={row}
              className="rounded-lg border border-border bg-panel px-4 py-3"
            >
              <SkeletonLine className="w-1/3" />
              <SkeletonLine className="mt-2 w-2/3" />
            </li>
          ))}
        </ul>
      );
    }

    return (
      <>
        {error && (
          <ErrorBanner
            message={error}
            onRetry={() => setReloadToken((token) => token + 1)}
            variant="inline"
          />
        )}
        {!error && specs.length === 0 && (
          <EmptyState
            icon={Target}
            heading="No missions yet"
            subtext="A mission appears here as soon as a spec is persisted in this workspace."
            action={{ label: 'Create a spec', onClick: () => navigate('/specs') }}
            variant="section"
          />
        )}
        {specs.length > 0 && visibleSpecs.length === 0 && (
          <p className="py-6 text-center text-sm text-muted">
            No missions match “{query.trim()}”.
          </p>
        )}
        {visibleSpecs.length > 0 && (
          <ul aria-label="Missions" className="space-y-3">
            {visibleSpecs.map((spec) => {
              const StatusIcon = STATUS_ICONS[spec.status] ?? Clock3;
              return (
                <li
                  key={spec.id}
                  className="flex justify-between gap-3 rounded-lg border border-border bg-panel px-4 py-3 max-sm:flex-col"
                >
                  <div className="min-w-0">
                    <Link
                      to={missionCasePath(spec.id)}
                      className="break-words font-medium text-[var(--text)] hover:text-accent hover:underline"
                    >
                      {spec.specName}
                    </Link>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
                      <span className="pk-chip">
                        <StatusIcon size={12} aria-hidden="true" />
                        status: {spec.status}
                      </span>
                      {spec.reviewStatus && <span>· review: {spec.reviewStatus}</span>}
                      <span>· {spec.storyCount} stories</span>
                      {typeof spec.readinessPercent === 'number' && (
                        <span>· readiness {spec.readinessPercent}%</span>
                      )}
                      <span title={spec.generatedAt}>
                        · created {formatRelativeTime(spec.generatedAt)}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-start max-sm:self-start">
                    <Link
                      to={specReviewHref(spec)}
                      className="whitespace-nowrap text-xs text-accent underline-offset-2 hover:underline"
                    >
                      Spec review
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {specs.length > 0 && hasMore && (
          <div className="mt-4 flex flex-col items-center gap-1.5">
            <button
              type="button"
              onClick={() => { void loadMore(); }}
              disabled={loadingMore || !nextCursor}
              aria-describedby="missions-search-scope"
              className="inline-flex min-h-9 items-center justify-center rounded-lg border border-border bg-panel px-4 py-2 text-sm font-medium text-[var(--text)] transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loadingMore ? 'Loading more missions…' : 'Load more missions'}
            </button>
            <span className="text-xs text-muted">
              {specs.length} of {total} missions loaded
            </span>
          </div>
        )}
      </>
    );
  };

  return (
    <section
      aria-labelledby="missions-heading"
      className="h-full overflow-y-auto bg-bg px-4 py-4 sm:px-6"
    >
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1
            id="missions-heading"
            className="text-xl font-semibold tracking-tight text-[var(--text)]"
          >
            Missions
          </h1>
          <p className="mt-1 text-sm text-muted">
            Delivery cases derived from persisted specs. Exact state lives in each Mission workspace.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-full sm:w-64">
            <div className="relative">
              <Search
                size={13}
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
              />
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter missions…"
                aria-label="Filter missions by title"
                aria-describedby="missions-search-scope"
                className="w-full rounded-lg border border-border bg-bg py-1.5 pl-8 pr-3 text-sm text-[var(--text)] placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </div>
            <p id="missions-search-scope" className="mt-1 text-[11px] leading-tight text-muted">
              {hasMore
                ? `Searching ${specs.length} loaded of ${total} missions. Load more to expand search.`
                : `Searching all ${specs.length} loaded missions.`}
            </p>
          </div>
          <Link
            to="/specs"
            className="whitespace-nowrap text-xs text-muted underline-offset-2 hover:text-[var(--text)] hover:underline"
          >
            Open expert Specs board
          </Link>
        </div>
      </header>
      {renderBody()}
    </section>
  );
}
