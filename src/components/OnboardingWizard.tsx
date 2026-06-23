/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, type FormEvent } from 'react';
import { CheckCircle2, Cloud, Database, Server, ShieldCheck } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { graphModeLabel } from './GraphCapabilityNotice';
import {
  defaultDatabaseSetupGuidance,
  getDatabaseModeGuide,
  type DatabaseSetupGuidance,
  type DbMode,
} from '../lib/databaseSetup';

interface OnboardingState {
  currentStep: number;
  workspaceId: string | null;
  directionDone: boolean;
  completed: boolean;
}

interface HealthResponse {
  databaseSetup?: DatabaseSetupGuidance;
  databaseCapability?: {
    dbMode: DbMode;
  };
}

const MODE_ICON: Record<DbMode, typeof Server> = {
  native: Server,
  docker: Database,
  byop: Cloud,
};

// Direction stack templates for common stacks
const STACK_TEMPLATES: Record<string, { label: string; l1: string; l3: string }> = {
  react: {
    label: 'React + TypeScript',
    l1: `coding_standards:
  - Use TypeScript strict mode
  - Prefer functional components with hooks
  - Use named exports over default exports
testing:
  - Write unit tests for utility functions
  - Test components with React Testing Library
code_style:
  - Use Prettier for formatting
  - ESLint for linting`,
    l3: `name: my-react-app
type: web-application
stack:
  - React 18
  - TypeScript
  - Vite
  - Tailwind CSS
purpose: Modern web application
key_modules:
  - src/components (UI components)
  - src/hooks (custom hooks)
  - src/lib (utilities)`,
  },
  node: {
    label: 'Node.js + Express',
    l1: `coding_standards:
  - Use TypeScript strict mode
  - Handle errors explicitly, no silent catches
  - Validate inputs at API boundaries
testing:
  - Write integration tests for API endpoints
  - Use Jest for unit tests
code_style:
  - Use async/await over callbacks
  - Prefer named exports`,
    l3: `name: my-node-api
type: api-server
stack:
  - Node.js
  - Express
  - TypeScript
  - SQLite
purpose: REST API backend
key_modules:
  - src/routes (API endpoints)
  - src/lib (business logic)
  - src/db (database layer)`,
  },
  python: {
    label: 'Python + FastAPI',
    l1: `coding_standards:
  - Use type hints everywhere
  - Follow PEP 8 conventions
  - Use Pydantic for data validation
testing:
  - Write tests with pytest
  - Use fixtures for test setup
code_style:
  - Use Black for formatting
  - Use isort for import ordering`,
    l3: `name: my-python-api
type: api-server
stack:
  - Python 3.11+
  - FastAPI
  - SQLAlchemy
  - Pydantic
purpose: Python API server
key_modules:
  - app/routes (API endpoints)
  - app/models (data models)
  - app/services (business logic)`,
  },
  fullstack: {
    label: 'Full-Stack (React + Node)',
    l1: `coding_standards:
  - Use TypeScript strict mode everywhere
  - Share types between frontend and backend
  - Handle errors at system boundaries
testing:
  - Unit tests for business logic
  - Integration tests for API endpoints
  - Component tests for UI
code_style:
  - Use Prettier + ESLint
  - Prefer named exports`,
    l3: `name: my-fullstack-app
type: full-stack-application
stack:
  - React 18
  - TypeScript
  - Node.js
  - Express
  - SQLite
purpose: Full-stack web application
key_modules:
  - src/ (frontend React code)
  - backend/src/routes (API endpoints)
  - backend/src/lib (backend logic)
  - backend/src/db (database)`,
  },
};

const SAMPLE_BRIEF = `Add a user profile page that displays the user's name, email, and avatar. Include an edit form that allows updating name and avatar. The page should be responsive and follow existing design patterns.`;

const STEPS = ['Welcome', 'Connect Repository', 'Direction', 'First Spec'];

export default function OnboardingWizard() {
  const { addWorkspace } = useWorkspace();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);

  // Step 1: Workspace form state
  const [wsLabel, setWsLabel] = useState('');
  const [wsPath, setWsPath] = useState('');
  const [wsDomains, setWsDomains] = useState('');
  const [wsDbMode, setWsDbMode] = useState<DbMode>('native');
  const [wsDatabaseUrl, setWsDatabaseUrl] = useState('');
  const [databaseSetup, setDatabaseSetup] = useState<DatabaseSetupGuidance>(defaultDatabaseSetupGuidance);
  const [modeTouched, setModeTouched] = useState(false);
  const [wsErrors, setWsErrors] = useState<Record<string, string>>({});
  const [wsSubmitting, setWsSubmitting] = useState(false);
  const [createdWorkspaceId, setCreatedWorkspaceId] = useState<string | null>(null);

  // Step 2: Direction stack state
  const [selectedTemplate, setSelectedTemplate] = useState<string>('react');
  const [l1Content, setL1Content] = useState(STACK_TEMPLATES.react.l1);
  const [l2Content, setL2Content] = useState('');
  const [l3Content, setL3Content] = useState(STACK_TEMPLATES.react.l3);
  const [dirSaving, setDirSaving] = useState(false);
  const [dirSaved, setDirSaved] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [scanConfidence, setScanConfidence] = useState<string | null>(null);

  // Step 3: Spec generation state
  const [specBrief, setSpecBrief] = useState(SAMPLE_BRIEF);
  const [specTitle, setSpecTitle] = useState('user-profile-page');
  const [specGenerating, setSpecGenerating] = useState(false);
  const [specGenerated, setSpecGenerated] = useState(false);
  const [specError, setSpecError] = useState('');

  // Load persisted state on mount
  useEffect(() => {
    apiFetch<OnboardingState>('/api/onboarding')
      .then((state) => {
        if (state.completed) {
          // Already completed, shouldn't be showing wizard
          return;
        }
        setStep(state.currentStep);
        if (state.workspaceId) setCreatedWorkspaceId(state.workspaceId);
        if (state.directionDone) setDirSaved(true);
      })
      .catch(() => {
        // First time — start from step 0
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    apiFetch<HealthResponse>('/api/health', { silent: true })
      .then((data) => {
        const setup = data.databaseSetup ?? defaultDatabaseSetupGuidance;
        setDatabaseSetup(setup);
        if (!modeTouched) {
          setWsDbMode(data.databaseSetup?.selectedMode ?? data.databaseCapability?.dbMode ?? setup.selectedMode);
        }
      })
      .catch(() => {
        // Keep fallback guidance during first-run/offline cases.
      });
  }, [modeTouched]);

  // Persist step changes
  function persistStep(newStep: number, extra?: Partial<OnboardingState>) {
    apiFetch('/api/onboarding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentStep: newStep, ...extra }),
    }).catch(() => { /* best effort */ });
  }

  function goToStep(newStep: number, extra?: Partial<OnboardingState>) {
    setStep(newStep);
    persistStep(newStep, extra);
  }

  // Step 1: Create workspace
  async function handleCreateWorkspace(e: FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!wsLabel.trim()) errs.label = 'Label is required';
    else if (wsLabel.length > 64) errs.label = 'Label must be 64 characters or fewer';
    if (!wsPath.trim()) errs.path = 'Path is required';
    else if (!wsPath.startsWith('/')) errs.path = 'Path must be absolute (start with /)';
    if (wsDbMode === 'byop' && !wsDatabaseUrl.trim()) errs.databaseUrl = 'DATABASE_URL is required for BYOP mode';
    if (Object.keys(errs).length > 0) {
      setWsErrors(errs);
      return;
    }
    setWsErrors({});
    setWsSubmitting(true);

    const id = wsLabel.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const domainList = wsDomains.split(',').map((d) => d.trim()).filter(Boolean);

    try {
      const res = await apiFetch<{ workspace: { id: string; label: string; path: string; domains: string[] } }>(
        '/api/workspaces',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id,
            label: wsLabel.trim(),
            path: wsPath.trim(),
            domains: domainList,
            dbMode: wsDbMode,
            databaseUrl: wsDbMode === 'byop' ? wsDatabaseUrl.trim() : undefined,
          }),
        },
      );
      const ws = { id: res.workspace.id, name: res.workspace.label, git_path: res.workspace.path };
      addWorkspace(ws);
      setCreatedWorkspaceId(res.workspace.id);
      goToStep(2, { workspaceId: res.workspace.id });
    } catch (err: any) {
      const msg = err.message || 'Failed to create workspace';
      if (msg.includes('Path does not exist')) {
        setWsErrors({ path: 'Path does not exist on filesystem' });
      } else if (msg.includes('not a git repository') || msg.includes('Not a git')) {
        setWsErrors({ path: 'Path is not a git repository' });
      } else if (msg.includes('already exists')) {
        setWsErrors({ label: 'A workspace with this name already exists' });
      } else if (msg.toLowerCase().includes('database_url') || msg.toLowerCase().includes('postgres') || msg.toLowerCase().includes('pgvector')) {
        setWsErrors({ databaseUrl: msg });
      } else {
        setWsErrors({ path: msg });
      }
    } finally {
      setWsSubmitting(false);
    }
  }

  // Step 2: Scan repo to auto-fill direction
  async function handleScanRepo() {
    if (!createdWorkspaceId) return;
    setIsScanning(true);
    setScanConfidence(null);
    try {
      const result = await apiFetch<{
        l1Draft: string; l2Draft: string; l3Draft: string;
        confidence: string; filesScanned: string[];
      }>(`/api/workspaces/${createdWorkspaceId}/scan-direction`, { method: 'POST' });
      setL1Content(result.l1Draft);
      setL2Content(result.l2Draft);
      setL3Content(result.l3Draft);
      setScanConfidence(result.confidence);
      setSelectedTemplate('');
      setDirSaved(false);
    } catch (err: any) {
      alert(`Scan failed: ${err.message}`);
    } finally {
      setIsScanning(false);
    }
  }

  // Step 2: Save direction layers
  async function handleSaveDirection() {
    if (!createdWorkspaceId) return;
    setDirSaving(true);
    try {
      // Save L1 (global)
      await apiFetch('/api/direction', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layer: 1, contentYaml: l1Content }),
      });
      // Save L2 (domain) if populated (e.g. from repo scan)
      if (l2Content.trim()) {
        await apiFetch('/api/direction', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ layer: 2, workspaceId: createdWorkspaceId, contentYaml: l2Content }),
        });
      }
      // Save L3 (project)
      await apiFetch('/api/direction', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layer: 3, workspaceId: createdWorkspaceId, contentYaml: l3Content }),
      });
      setDirSaved(true);
      goToStep(3, { directionDone: true });
    } catch (err: any) {
      // Show error in alert — validation errors from backend
      alert(`Failed to save direction: ${err.message}`);
    } finally {
      setDirSaving(false);
    }
  }

  // Step 3: Generate spec
  async function handleGenerateSpec() {
    if (!createdWorkspaceId) return;
    setSpecGenerating(true);
    setSpecError('');
    try {
      await apiFetch('/api/specs/forge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: createdWorkspaceId,
          title: specTitle.trim() || 'my-first-spec',
          brief: specBrief,
          storyCount: 5,
          agentOverride: 'pi',
        }),
      });
      setSpecGenerated(true);
    } catch (err: any) {
      setSpecError(err.message || 'Spec generation failed');
    } finally {
      setSpecGenerating(false);
    }
  }

  const selectedGuide = getDatabaseModeGuide(databaseSetup, wsDbMode);

  // Finish onboarding
  function handleFinish() {
    persistStep(step, { completed: true });
    // Force reload to get normal app shell
    window.location.reload();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-muted text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full p-4">
      <div className="w-full max-w-2xl">
        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium transition-colors ${
                  i < step
                    ? 'bg-green-500/20 text-green-400 border border-green-500/40'
                    : i === step
                    ? 'bg-accent text-white'
                    : 'bg-panel border border-border text-muted'
                }`}
              >
                {i < step ? '\u2713' : i + 1}
              </div>
              {i < STEPS.length - 1 && (
                <div className={`w-8 h-px ${i < step ? 'bg-green-500/40' : 'bg-border'}`} />
              )}
            </div>
          ))}
        </div>

        <div className="bg-panel border border-border rounded-lg p-8">
          {/* Step 0: Welcome */}
          {step === 0 && (
            <div className="text-center">
              <h1 className="text-2xl font-bold mb-3">Welcome to Rorca</h1>
              <p className="text-muted mb-2 max-w-md mx-auto">
                AI spec orchestration for autonomous development. Turn plain-English briefs into structured specs, then execute them with Claude.
              </p>
              <div className="text-left bg-bg rounded-lg p-4 my-6 text-sm space-y-2">
                <p><span className="text-accent font-medium">1.</span> Connect a git repository as your workspace</p>
                <p><span className="text-accent font-medium">2.</span> Configure your direction (coding standards + project context)</p>
                <p><span className="text-accent font-medium">3.</span> Generate your first spec and see the full flow</p>
              </div>
              <button
                onClick={() => goToStep(1)}
                className="px-6 py-2.5 rounded bg-accent text-white hover:opacity-90 transition-opacity font-medium"
              >
                Get Started
              </button>
            </div>
          )}

          {/* Step 1: Connect Repository */}
          {step === 1 && (
            <div>
              <h2 className="text-xl font-semibold mb-1">Connect Repository</h2>
              <p className="text-muted text-sm mb-6">
                Point Rorca at a git repository. This is where specs and run-loop scripts will live.
              </p>
              <form onSubmit={handleCreateWorkspace} className="flex flex-col gap-4">
                <div className="rounded-lg border border-accent/20 bg-accent/5 p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <p className="text-sm font-medium text-primary">Choose a database mode first</p>
                      <p className="text-xs text-muted mt-1">{databaseSetup.selectionNote}</p>
                    </div>
                    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-bg px-2.5 py-1 text-[11px] font-medium text-muted">
                      <ShieldCheck className="h-3.5 w-3.5 text-accent" />
                      {databaseSetup.validationFlow}
                    </span>
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    {databaseSetup.modes.map((option) => {
                      const Icon = MODE_ICON[option.mode];
                      const selected = wsDbMode === option.mode;
                      return (
                        <button
                          key={option.mode}
                          type="button"
                          onClick={() => {
                            setWsDbMode(option.mode);
                            setModeTouched(true);
                            setWsErrors((current) => ({ ...current, databaseUrl: '' }));
                          }}
                          className={`rounded-lg border p-4 text-left transition-colors ${selected ? 'border-accent bg-accent/10' : 'border-border bg-bg hover:border-accent/40'}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface text-primary">
                              <Icon className="h-4 w-4" />
                            </div>
                            {selected && <CheckCircle2 className="h-4 w-4 text-accent shrink-0" />}
                          </div>
                          <p className="mt-3 text-sm font-semibold text-primary">{option.label}</p>
                          <p className="mt-1 text-xs text-muted">{option.summary}</p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${option.graphExpectation === 'full' ? 'bg-success/10 text-success border border-success/20' : 'bg-warning/10 text-warning border border-warning/20'}`}>
                              {graphModeLabel(option.graphExpectation)} expected
                            </span>
                            {databaseSetup.selectedMode === option.mode && (
                              <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-medium text-muted">
                                Current default
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  <div className="grid gap-4 lg:grid-cols-[1.4fr,1fr]">
                    <div className="rounded-lg border border-border bg-bg p-4">
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div>
                          <p className="text-sm font-medium text-primary">{selectedGuide.label}</p>
                          <p className="text-xs text-muted mt-1">{selectedGuide.graphSummary}</p>
                        </div>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${selectedGuide.graphExpectation === 'full' ? 'bg-success/10 text-success border border-success/20' : 'bg-warning/10 text-warning border border-warning/20'}`}>
                          {graphModeLabel(selectedGuide.graphExpectation)}
                        </span>
                      </div>
                      <ol className="mt-3 space-y-2 text-xs text-muted list-decimal pl-4">
                        {selectedGuide.startupGuide.map((step) => (
                          <li key={step}>{step}</li>
                        ))}
                      </ol>
                    </div>

                    <div className="rounded-lg border border-border bg-bg p-4 space-y-3">
                      <p className="text-sm font-medium text-primary">Full Graph vs Graph Lite</p>
                      {databaseSetup.graphModes.map((entry) => (
                        <div key={entry.mode} className="rounded-lg border border-border bg-surface p-3">
                          <p className="text-xs font-semibold text-primary">{entry.label}</p>
                          <p className="mt-1 text-xs text-muted">{entry.summary}</p>
                          <ul className="mt-2 space-y-1 text-xs text-muted">
                            {entry.tradeoffs.map((item) => (
                              <li key={item}>• {item}</li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div>
                  <label htmlFor="ob-label" className="block text-sm font-medium mb-1">
                    Workspace Name
                  </label>
                  <input
                    id="ob-label"
                    type="text"
                    value={wsLabel}
                    onChange={(e) => setWsLabel(e.target.value)}
                    maxLength={64}
                    placeholder="My Project"
                    className="w-full px-3 py-2 rounded border border-border bg-bg text-sm focus:outline-none focus:border-accent"
                  />
                  {wsErrors.label && <p className="text-red-500 text-xs mt-1">{wsErrors.label}</p>}
                </div>
                <div>
                  <label htmlFor="ob-path" className="block text-sm font-medium mb-1">
                    Repository Path
                  </label>
                  <input
                    id="ob-path"
                    type="text"
                    value={wsPath}
                    onChange={(e) => setWsPath(e.target.value)}
                    placeholder="/Users/me/my-project"
                    className="w-full px-3 py-2 rounded border border-border bg-bg text-sm font-mono focus:outline-none focus:border-accent"
                  />
                  {wsErrors.path && <p className="text-red-500 text-xs mt-1">{wsErrors.path}</p>}
                  <p className="text-xs text-muted mt-1">Absolute path to a git repository</p>
                </div>
                <div>
                  <label htmlFor="ob-domains" className="block text-sm font-medium mb-1">
                    Tags <span className="text-muted font-normal">(optional)</span>
                  </label>
                  <input
                    id="ob-domains"
                    type="text"
                    value={wsDomains}
                    onChange={(e) => setWsDomains(e.target.value)}
                    placeholder="react, typescript, saas"
                    className="w-full px-3 py-2 rounded border border-border bg-bg text-sm focus:outline-none focus:border-accent"
                  />
                  <p className="text-xs text-muted mt-1">Comma-separated domain tags</p>
                </div>

                {wsDbMode === 'byop' && (
                  <div className="rounded-lg border border-border bg-bg p-4">
                    <label htmlFor="ob-database-url" className="block text-sm font-medium mb-1">
                      Secure DATABASE_URL input
                    </label>
                    <textarea
                      id="ob-database-url"
                      value={wsDatabaseUrl}
                      onChange={(e) => setWsDatabaseUrl(e.target.value)}
                      placeholder="postgres://postgres:password@db.example.supabase.co:5432/postgres?sslmode=require"
                      rows={4}
                      spellCheck={false}
                      autoComplete="off"
                      className="w-full px-3 py-2 rounded border border-border bg-surface text-sm font-mono focus:outline-none focus:border-accent resize-y"
                    />
                    <p className="text-xs text-muted mt-2">{databaseSetup.byop.secretSafeInput}</p>
                    <p className="text-xs text-muted mt-1">Validation on save: {databaseSetup.byop.validationChecks.join(' · ')}</p>
                    {wsErrors.databaseUrl && <p className="text-red-500 text-xs mt-2">{wsErrors.databaseUrl}</p>}
                  </div>
                )}

                <div className="rounded-lg border border-border bg-bg px-4 py-3 text-xs text-muted">
                  Rorca will not bootstrap a local database or validate your hosted connection until you click Connect Repository.
                </div>

                <div className="flex justify-between mt-2">
                  <button
                    type="button"
                    onClick={() => goToStep(0)}
                    className="px-4 py-2 text-sm rounded border border-border hover:bg-bg transition-colors"
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={wsSubmitting}
                    className="px-6 py-2 text-sm rounded bg-accent text-white hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {wsSubmitting ? 'Connecting...' : 'Connect Repository'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Step 2: Direction */}
          {step === 2 && (
            <div>
              <h2 className="text-xl font-semibold mb-1">Configure Direction</h2>
              <p className="text-muted text-sm mb-4">
                Direction guides AI spec generation. Pick a template that matches your project, then customize.
              </p>

              {/* Scan Repo button */}
              <div className="mb-4 p-3 bg-accent/5 border border-accent/20 rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Auto-detect from repo</p>
                    <p className="text-xs text-muted mt-0.5">Scans package.json, CLAUDE.md, README.md, and directory structure</p>
                  </div>
                  <button
                    onClick={handleScanRepo}
                    disabled={isScanning}
                    className="px-4 py-2 text-sm rounded bg-accent text-white hover:opacity-90 transition-opacity disabled:opacity-50 shrink-0 ml-3"
                  >
                    {isScanning ? 'Scanning...' : 'Scan Repo'}
                  </button>
                </div>
                {scanConfidence && (
                  <p className="text-xs text-green-400 mt-2">Scan complete (confidence: {scanConfidence})</p>
                )}
              </div>

              <div className="flex items-center gap-3 mb-4">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-muted">or pick a template</span>
                <div className="flex-1 h-px bg-border" />
              </div>

              {/* Template selector */}
              <div className="mb-4">
                <label className="block text-sm font-medium mb-2">Stack Template</label>
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(STACK_TEMPLATES).map(([key, tmpl]) => (
                    <button
                      key={key}
                      onClick={() => {
                        setSelectedTemplate(key);
                        setL1Content(tmpl.l1);
                        setL2Content('');
                        setL3Content(tmpl.l3);
                        setScanConfidence(null);
                        setDirSaved(false);
                      }}
                      className={`px-3 py-2 text-sm rounded border text-left transition-colors ${
                        selectedTemplate === key
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border hover:border-accent/50'
                      }`}
                    >
                      {tmpl.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Standards */}
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1">Standards</label>
                <textarea
                  value={l1Content}
                  onChange={(e) => { setL1Content(e.target.value); setDirSaved(false); }}
                  rows={6}
                  className="w-full px-3 py-2 rounded border border-border bg-bg text-xs font-mono focus:outline-none focus:border-accent resize-y"
                />
              </div>

              {/* Conventions (shown when populated from scan) */}
              {l2Content.trim() && (
                <div className="mb-4">
                  <label className="block text-sm font-medium mb-1">Conventions</label>
                  <textarea
                    value={l2Content}
                    onChange={(e) => { setL2Content(e.target.value); setDirSaved(false); }}
                    rows={4}
                    className="w-full px-3 py-2 rounded border border-border bg-bg text-xs font-mono focus:outline-none focus:border-accent resize-y"
                  />
                </div>
              )}

              {/* Project */}
              <div className="mb-4">
                <label className="block text-sm font-medium mb-1">Project</label>
                <textarea
                  value={l3Content}
                  onChange={(e) => { setL3Content(e.target.value); setDirSaved(false); }}
                  rows={8}
                  className="w-full px-3 py-2 rounded border border-border bg-bg text-xs font-mono focus:outline-none focus:border-accent resize-y"
                />
              </div>

              <div className="flex justify-between items-center mt-2">
                <button
                  type="button"
                  onClick={() => goToStep(3)}
                  className="text-sm text-muted hover:text-[var(--text)] transition-colors"
                >
                  Skip for now
                </button>
                <div className="flex gap-2">
                  {dirSaved && (
                    <span className="text-green-400 text-sm flex items-center gap-1">
                      {'\u2713'} Saved
                    </span>
                  )}
                  <button
                    onClick={handleSaveDirection}
                    disabled={dirSaving}
                    className="px-6 py-2 text-sm rounded bg-accent text-white hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {dirSaving ? 'Saving...' : dirSaved ? 'Save & Continue' : 'Save Direction'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Generate First Spec */}
          {step === 3 && (
            <div>
              <h2 className="text-xl font-semibold mb-1">Generate Your First Spec</h2>
              <p className="text-muted text-sm mb-4">
                Try the full flow: write a brief, generate a structured spec with user stories. You can use the sample below or write your own.
              </p>

              <div className="mb-4">
                <label htmlFor="ob-spec-title" className="block text-sm font-medium mb-1">
                  Spec Title (slug)
                </label>
                <input
                  id="ob-spec-title"
                  type="text"
                  value={specTitle}
                  onChange={(e) => setSpecTitle(e.target.value)}
                  placeholder="my-feature"
                  className="w-full px-3 py-2 rounded border border-border bg-bg text-sm font-mono focus:outline-none focus:border-accent"
                />
              </div>

              <div className="mb-4">
                <label htmlFor="ob-spec-brief" className="block text-sm font-medium mb-1">
                  Feature Brief
                </label>
                <textarea
                  id="ob-spec-brief"
                  value={specBrief}
                  onChange={(e) => setSpecBrief(e.target.value)}
                  rows={5}
                  className="w-full px-3 py-2 rounded border border-border bg-bg text-sm focus:outline-none focus:border-accent resize-y"
                />
              </div>

              {specError && (
                <p className="text-red-500 text-sm mb-4">{specError}</p>
              )}

              {specGenerated && (
                <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4 mb-4">
                  <p className="text-green-400 text-sm font-medium">Spec generated successfully!</p>
                  <p className="text-muted text-xs mt-1">
                    Check the Review Queue to see your spec and approve it for pipeline execution.
                  </p>
                </div>
              )}

              <div className="flex justify-between items-center mt-2">
                <button
                  type="button"
                  onClick={handleFinish}
                  className="text-sm text-muted hover:text-[var(--text)] transition-colors"
                >
                  {specGenerated ? 'Skip' : 'Skip for now'}
                </button>
                <div className="flex gap-2">
                  {specGenerated ? (
                    <button
                      onClick={handleFinish}
                      className="px-6 py-2 text-sm rounded bg-accent text-white hover:opacity-90 transition-opacity"
                    >
                      Open Dashboard
                    </button>
                  ) : (
                    <button
                      onClick={handleGenerateSpec}
                      disabled={specGenerating || !specBrief.trim()}
                      className="px-6 py-2 text-sm rounded bg-accent text-white hover:opacity-90 transition-opacity disabled:opacity-50"
                    >
                      {specGenerating ? 'Generating...' : 'Generate Spec'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Step labels */}
        <div className="flex justify-center mt-4">
          <span className="text-xs text-muted">
            Step {step + 1} of {STEPS.length}: {STEPS[step]}
          </span>
        </div>
      </div>
    </div>
  );
}
