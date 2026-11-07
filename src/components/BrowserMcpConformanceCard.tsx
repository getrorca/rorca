/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  CHATGPT_CONSUMER_CONTRACT_VERSION,
  CLAUDE_CONSUMER_CONTRACT_VERSION,
  advanceChatGptMcpConformanceJourney,
  advanceClaudeMcpConformanceJourney,
  getChatGptMcpConformanceJourney,
  getClaudeMcpConformanceJourney,
  startChatGptMcpConformanceJourney,
  startClaudeMcpConformanceJourney,
  type BrowserMcpConformanceJourney,
  type BrowserMcpConformanceProvider,
  type ChatGptMcpConformanceExecutionReceipt,
  type ClaudeMcpConformanceExecutionReceipt,
} from '../api/browser-session-broker';

interface BrowserMcpConformanceCardProps {
  workspaceId: string;
  runId: number;
}

type ConsumerReceipt = ClaudeMcpConformanceExecutionReceipt | ChatGptMcpConformanceExecutionReceipt;
type ConsumerJourney = BrowserMcpConformanceJourney<ConsumerReceipt>;

interface ConsumerUiContract {
  label: 'Claude' | 'ChatGPT';
  storyId: 'BSB-004' | 'BSB-005';
  surface: 'Real Claude web' | 'Real ChatGPT web';
  aliasPattern: string;
  aliasPlaceholder: string;
}

const UI_CONTRACT_BY_PROVIDER: Record<BrowserMcpConformanceProvider, ConsumerUiContract> = {
  claude: {
    label: 'Claude',
    storyId: 'BSB-004',
    surface: 'Real Claude web',
    aliasPattern: 'claude-[a-z0-9][a-z0-9._-]{2,100}',
    aliasPlaceholder: 'claude-dedicated-conformance',
  },
  chatgpt: {
    label: 'ChatGPT',
    storyId: 'BSB-005',
    surface: 'Real ChatGPT web',
    aliasPattern: 'chatgpt-[a-z0-9][a-z0-9._-]{2,100}',
    aliasPlaceholder: 'chatgpt-dedicated-conformance',
  },
};

const PHASE_LABELS: Record<ConsumerJourney['phase'], string> = {
  install: 'Install and consent',
  tool: 'Deterministic tool',
  refresh: 'OAuth refresh',
  revoke: 'Revocation',
  post_revocation: 'Post-revocation denial',
};

const STATE_LABELS: Record<ConsumerJourney['state'], string> = {
  running: 'Ready to advance',
  waiting_for_authentication: 'Waiting for human consent',
  waiting_for_fixture: 'Waiting for fixture observation',
  waiting_for_refresh: 'Waiting for access lease expiry',
  settling: 'Settling receipt',
  completed: 'Verified',
  failed: 'Failed closed',
};

function shortDigest(value: string): string {
  return value.length > 24 ? `${value.slice(0, 16)}…${value.slice(-6)}` : value;
}

function ConsumerJourneyCard({
  provider,
  workspaceId,
  runId,
}: BrowserMcpConformanceCardProps & { provider: BrowserMcpConformanceProvider }) {
  const uiContract = UI_CONTRACT_BY_PROVIDER[provider];
  const [journey, setJourney] = useState<ConsumerJourney | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [bindingId, setBindingId] = useState('');
  const [accountAlias, setAccountAlias] = useState('');
  const [fixturePublicOrigin, setFixturePublicOrigin] = useState('');
  const [profileGeneration, setProfileGeneration] = useState(1);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const request = provider === 'claude'
      ? getClaudeMcpConformanceJourney(workspaceId, runId, { signal: controller.signal })
      : getChatGptMcpConformanceJourney(workspaceId, runId, { signal: controller.signal });
    request
      .then((response) => setJourney(response.journey))
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : 'Conformance state could not be loaded.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [provider, runId, workspaceId]);

  const advance = useCallback(async () => {
    if (!journey || journey.state === 'completed' || journey.state === 'failed') return;
    setWorking(true);
    setError(null);
    try {
      let current = journey;
      for (let count = 0; count < 12; count += 1) {
        const response = provider === 'claude'
          ? await advanceClaudeMcpConformanceJourney(current.journeyId)
          : await advanceChatGptMcpConformanceJourney(current.journeyId);
        current = response.journey;
        setJourney(current);
        if (current.state !== 'running') break;
      }
    } catch (advanceError) {
      setError(advanceError instanceof Error
        ? advanceError.message
        : `The fixed ${uiContract.label} contract could not advance.`);
    } finally {
      setWorking(false);
    }
  }, [journey, provider, uiContract.label]);

  useEffect(() => {
    if (journey?.state !== 'waiting_for_refresh' || working) return;
    const timer = window.setTimeout(() => void advance(), 10_250);
    return () => window.clearTimeout(timer);
  }, [advance, journey?.state, working]);

  const start = async () => {
    setWorking(true);
    setError(null);
    try {
      const common = {
        workspaceId,
        runId: String(runId),
        bindingId,
        profileGeneration,
        accountAlias,
        fixturePublicOrigin,
        expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      };
      const response = provider === 'claude'
        ? await startClaudeMcpConformanceJourney({
          ...common,
          storyId: 'BSB-004',
          consumerContractVersion: CLAUDE_CONSUMER_CONTRACT_VERSION,
        })
        : await startChatGptMcpConformanceJourney({
          ...common,
          storyId: 'BSB-005',
          consumerContractVersion: CHATGPT_CONSUMER_CONTRACT_VERSION,
        });
      setJourney(response.journey);
      setShowSetup(false);
    } catch (startError) {
      setError(startError instanceof Error
        ? startError.message
        : `The ${uiContract.label} conformance journey could not start.`);
    } finally {
      setWorking(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" /> Loading {uiContract.label} conformance evidence…
      </div>
    );
  }

  const receipt = journey?.receipt;
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-border bg-panel p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="rounded-lg border border-accent/25 bg-accent/10 p-2 text-accent">
              <ShieldCheck size={20} />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-[var(--text)]">{uiContract.label} MCP conformance</h2>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
                {uiContract.surface}, one dedicated profile, one disposable Rorca-owned fixture, one harmless fixed-input tool.
                Evidence retains redacted artifacts and hashes—not cookies, credentials, authorization codes, OAuth values,
                MFA material, or recovery codes. No Categoric/Cashflow-App dependency.
              </p>
            </div>
          </div>
          {journey && (
            <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${
              journey.state === 'completed'
                ? 'border-success/30 bg-success/10 text-success'
                : journey.state === 'failed'
                  ? 'border-danger/30 bg-danger/10 text-danger'
                  : 'border-accent/30 bg-accent/10 text-accent'
            }`}>
              {STATE_LABELS[journey.state]}
            </span>
          )}
        </div>

        {!journey && !showSetup && (
          <button
            type="button"
            onClick={() => setShowSetup(true)}
            className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-medium text-[var(--text)] transition-colors hover:bg-bg"
          >
            <Play size={14} /> Configure dedicated {uiContract.label} journey
          </button>
        )}

        {!journey && showSetup && (
          <form
            className="mt-4 grid gap-3 rounded-lg border border-border bg-bg p-4 md:grid-cols-2"
            onSubmit={(event) => { event.preventDefault(); void start(); }}
          >
            <label className="space-y-1 text-xs text-muted">
              <span>Dedicated {uiContract.label} account alias</span>
              <input
                required
                pattern={uiContract.aliasPattern}
                value={accountAlias}
                onChange={(event) => setAccountAlias(event.target.value)}
                placeholder={uiContract.aliasPlaceholder}
                className="w-full rounded border border-border bg-panel px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-accent"
              />
            </label>
            <label className="space-y-1 text-xs text-muted">
              <span>Encrypted profile binding ID</span>
              <input
                required
                type="text"
                value={bindingId}
                onChange={(event) => setBindingId(event.target.value)}
                placeholder="UUID"
                className="w-full rounded border border-border bg-panel px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-accent"
              />
            </label>
            <label className="space-y-1 text-xs text-muted">
              <span>Public Rorca fixture origin</span>
              <input
                required
                type="url"
                value={fixturePublicOrigin}
                onChange={(event) => setFixturePublicOrigin(event.target.value)}
                placeholder="https://fixture.example.test"
                className="w-full rounded border border-border bg-panel px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-accent"
              />
            </label>
            <label className="space-y-1 text-xs text-muted">
              <span>Profile generation</span>
              <input
                required
                type="number"
                min={1}
                value={profileGeneration}
                onChange={(event) => setProfileGeneration(Number(event.target.value))}
                className="w-full rounded border border-border bg-panel px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-accent"
              />
            </label>
            <div className="flex items-center gap-2 md:col-span-2">
              <button
                type="submit"
                disabled={working}
                className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-accent-foreground disabled:opacity-50"
              >
                {working ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                Start isolated {uiContract.label} journey
              </button>
              <button
                type="button"
                onClick={() => setShowSetup(false)}
                className="rounded-lg px-3 py-2 text-xs text-muted hover:text-[var(--text)]"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {journey && !receipt && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-bg p-3">
            <div>
              <p className="text-xs font-medium text-[var(--text)]">{PHASE_LABELS[journey.phase]}</p>
              <p className="mt-0.5 text-[11px] text-muted">
                Fixed action {journey.actionIndex + 1} · {STATE_LABELS[journey.state]}
              </p>
              {journey.state === 'waiting_for_authentication' && (
                <p className="mt-1 text-[11px] text-warning">Complete or cancel consent in the Terminal takeover surface.</p>
              )}
            </div>
            {journey.state !== 'failed' && journey.state !== 'waiting_for_authentication' && (
              <button
                type="button"
                disabled={working}
                onClick={() => void advance()}
                className="inline-flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-xs font-semibold text-accent disabled:opacity-50"
              >
                {working ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                Advance fixed contract
              </button>
            )}
          </div>
        )}

        {error && (
          <div role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}
      </section>

      {receipt && (
        <>
          <section className="rounded-xl border border-success/30 bg-success/5 p-4 md:p-5">
            <div className="flex items-center gap-2 text-success">
              <CheckCircle2 size={18} />
              <h3 className="text-sm font-semibold">Complete ExecutionReceipt</h3>
            </div>
            <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
              <div><dt className="text-muted">Consumer</dt><dd className="mt-1 font-medium text-[var(--text)]">{uiContract.surface}</dd></div>
              <div><dt className="text-muted">Tool result</dt><dd className="mt-1 font-mono text-[var(--text)]">{shortDigest(receipt.fixture.resultHash)}</dd></div>
              <div><dt className="text-muted">Session / OAuth</dt><dd className="mt-1 font-medium text-success">Revoked / Revoked</dd></div>
              <div><dt className="text-muted">Profile policy</dt><dd className="mt-1 font-medium capitalize text-[var(--text)]">{receipt.leases.profile.disposition}</dd></div>
            </dl>
            <p className="mt-4 text-[11px] text-muted">
              Completed <time dateTime={receipt.completedAt}>{new Date(receipt.completedAt).toLocaleString()}</time>
              {' · '}Revocation proof <span className="font-mono">{shortDigest(receipt.revocationProof.proofDigest)}</span>
            </p>
          </section>

          <section className="rounded-xl border border-border bg-panel p-4 md:p-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Provider-specific UI contract</h3>
            <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
              {Object.entries(receipt.consumer.providerDifferences).map(([difference, value]) => (
                <div key={difference} className="rounded-lg border border-border bg-bg p-3">
                  <dt className="text-[10px] uppercase tracking-wide text-muted">{difference.replaceAll(/([A-Z])/g, ' $1')}</dt>
                  <dd className="mt-1 font-mono text-[var(--text)]">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-[11px] text-muted">
              Account, encrypted profile, browser lease, and OAuth grant are provider-bound and non-interchangeable.
              Isolation proof <span className="font-mono">{shortDigest(receipt.isolation.identityBoundaryDigest)}</span>.
            </p>
          </section>
          <section className="rounded-xl border border-border bg-panel p-4 md:p-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Real consumer UI observations</h3>
            <p className="mt-1 text-[11px] text-muted">
              Fixed-contract actions and observed result digests only; browser input and provider response text are not retained.
            </p>
            <ol className="mt-3 grid gap-2 md:grid-cols-2">
              {receipt.consumer.uiObservations.map((observation, index) => (
                <li
                  key={`${observation.observedAt}-${observation.action}-${index}`}
                  className="rounded-lg border border-border bg-bg p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium text-[var(--text)]">{observation.action}</p>
                      <p className="mt-1 text-[10px] uppercase tracking-wide text-muted">{PHASE_LABELS[observation.phase]}</p>
                    </div>
                    <time className="shrink-0 text-[10px] text-muted" dateTime={observation.observedAt}>
                      {new Date(observation.observedAt).toLocaleTimeString()}
                    </time>
                  </div>
                  {observation.resultDigest && (
                    <p className="mt-2 text-[11px] text-muted">
                      Result digest <span className="font-mono text-[var(--text)]">{shortDigest(observation.resultDigest)}</span>
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </section>


          <section className="rounded-xl border border-border bg-panel p-4 md:p-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Redacted evidence observations</h3>
            <p className="mt-1 text-[11px] text-muted">{receipt.evidence.requiredClasses.join(' · ')}</p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {receipt.evidence.observations.map((observation) => (
                <article key={observation.stage} className="rounded-lg border border-border bg-bg p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-[var(--text)]">{PHASE_LABELS[observation.stage]}</span>
                    <time className="text-[10px] text-muted" dateTime={observation.observedAt}>
                      {new Date(observation.observedAt).toLocaleTimeString()}
                    </time>
                  </div>
                  <dl className="mt-2 space-y-1 text-[11px]">
                    <div className="flex justify-between gap-3"><dt className="text-muted">Screenshot</dt><dd className="font-mono text-[var(--text)]">{shortDigest(observation.screenshot.digest)}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-muted">Accessibility</dt><dd className="font-mono text-[var(--text)]">{shortDigest(observation.accessibilitySnapshot.digest)}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-muted">Network events</dt><dd className="text-[var(--text)]">{observation.networkMetadata.length} redacted</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-muted">Session observed</dt><dd className={observation.authenticatedSessionObserved ? 'text-success' : 'text-warning'}>{observation.authenticatedSessionObserved ? 'Healthy' : 'Unverified'}</dd></div>
                  </dl>
                  {observation.networkMetadata.length > 0 && (
                    <ul className="mt-3 space-y-1.5 border-t border-border pt-3" aria-label={`${PHASE_LABELS[observation.stage]} redacted network metadata`}>
                      {observation.networkMetadata.map((metadata, index) => (
                        <li
                          key={`${metadata.observedAt}-${metadata.pathDigest}-${index}`}
                          className="rounded border border-border px-2 py-1.5 text-[10px] text-muted"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                            <span>
                              <span className="font-medium text-[var(--text)]">{metadata.method} {metadata.effect}</span>
                              {' · '}{metadata.decision}
                            </span>
                            <time dateTime={metadata.observedAt}>{new Date(metadata.observedAt).toLocaleTimeString()}</time>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                            <span>{metadata.origin ?? 'Origin unavailable'}</span>
                            <span className="font-mono text-[var(--text)]">Path {shortDigest(metadata.pathDigest)}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-panel p-4 md:p-5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Fixture protocol events</h3>
            <ol className="mt-3 grid gap-2 sm:grid-cols-2">
              {receipt.fixture.events.map((event) => (
                <li key={`${event.sequence}-${event.type}`} className="flex items-center gap-2 text-xs text-[var(--text)]">
                  <CheckCircle2 size={13} className="shrink-0 text-success" />
                  <span className="font-mono text-[10px] text-muted">{String(event.sequence).padStart(2, '0')}</span>
                  <span>{event.type.replaceAll('_', ' ')}</span>
                  <time className="ml-auto text-[10px] text-muted" dateTime={event.observedAt}>
                    {new Date(event.observedAt).toLocaleTimeString()}
                  </time>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </div>
  );
}

export default function BrowserMcpConformanceCard({ workspaceId, runId }: BrowserMcpConformanceCardProps) {
  const [provider, setProvider] = useState<BrowserMcpConformanceProvider>('claude');

  return (
    <div className="h-full overflow-y-auto bg-bg p-4 md:p-6">
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="inline-flex rounded-lg border border-border bg-panel p-1" role="tablist" aria-label="MCP consumer provider">
          {(['claude', 'chatgpt'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={provider === candidate}
              onClick={() => setProvider(candidate)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                provider === candidate ? 'bg-accent text-accent-foreground' : 'text-muted hover:text-[var(--text)]'
              }`}
            >
              {UI_CONTRACT_BY_PROVIDER[candidate].label}
            </button>
          ))}
        </div>
        <ConsumerJourneyCard key={provider} provider={provider} workspaceId={workspaceId} runId={runId} />
      </div>
    </div>
  );
}
