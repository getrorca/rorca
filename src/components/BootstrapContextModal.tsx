/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowLeft,
  ArrowRight,
  Clipboard,
  FolderOpen,
  Link,
  Sparkles,
  Upload,
  Wand2,
  X,
  Zap,
} from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useFocusTrap } from '../hooks/useFocusTrap';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BootstrapContextModalProps {
  workspaceId: string;
  activeLayer: 1 | 2 | 3;
  onAccept: (yaml: string) => void;
  onClose: () => void;
}

type LayerTarget = 1 | 2 | 3;
type TabId = 'wizard' | 'paste' | 'upload' | 'filepath' | 'url' | 'multi';

interface ExtractionResult {
  yaml: string;
  confidence: 'high' | 'medium' | 'low';
  extracted: string[];
  missing: string[];
  tokenCount: number;
}

interface MultiSourceEntry {
  id: string;
  type: 'paste' | 'filepath' | 'url';
  label: string;
  content: string;
}

interface UrlPreview {
  preview: string;
  contentLength: number;
  contentType: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAYER_LABELS: Record<LayerTarget, string> = {
  1: 'Standards',
  2: 'Conventions',
  3: 'Project',
};

const LAYER_DESCRIPTIONS: Record<LayerTarget, string> = {
  1: 'Repo-wide engineering rules',
  2: 'Team and codebase patterns',
  3: 'Project-specific context',
};

const TABS: { id: TabId; icon: LucideIcon; label: string }[] = [
  { id: 'wizard', icon: Wand2, label: 'Wizard' },
  { id: 'paste', icon: Clipboard, label: 'Paste' },
  { id: 'upload', icon: Upload, label: 'Upload' },
  { id: 'filepath', icon: FolderOpen, label: 'File' },
  { id: 'url', icon: Link, label: 'URL' },
  { id: 'multi', icon: Zap, label: 'Multi-source' },
];

const WIZARD_QUESTIONS = [
  { key: 'project_name', q: 'What is the project name?', placeholder: 'freelance-invoicing', type: 'input' as const },
  { key: 'purpose', q: 'What does it do? (one sentence)', placeholder: 'Invoicing and payment tracking for freelancers', type: 'input' as const },
  { key: 'users', q: 'Who are the primary users?', placeholder: 'Freelancers and their clients', type: 'input' as const },
  { key: 'stack', q: "What is the tech stack? (comma-separated, or 'Not decided yet')", placeholder: 'React, Node.js, PostgreSQL, Stripe', type: 'input' as const },
  { key: 'features', q: 'What are the 3 most important features?', placeholder: 'Online booking, deposit payments, appointment reminders', type: 'textarea' as const },
  { key: 'constraints', q: 'What are the hard constraints? (things that must not change)', placeholder: 'Must work offline, no card data stored on our servers', type: 'textarea' as const },
  { key: 'v1_done', q: 'What does v1 done look like? (one sentence)', placeholder: 'An artist can accept a booking + deposit without any back-and-forth DMs', type: 'input' as const },
  { key: 'codebase_type', q: 'Is this greenfield or an existing codebase?', placeholder: '', type: 'radio' as const },
  { key: 'references', q: 'Any similar products for reference? (helps calibrate UX expectations)', placeholder: 'Wave, FreshBooks \u2014 but simpler and mobile-first', type: 'input' as const },
];

const WIZARD_STEP_TITLES = [
  'Project identity',
  'Core purpose',
  'Primary users',
  'Technology stack',
  'Important features',
  'Hard constraints',
  'Version-one outcome',
  'Codebase status',
  'Reference products',
];

const ALLOWED_EXTENSIONS = ['.md', '.txt', '.sql', '.prisma', '.ts', '.tsx', '.json', '.yaml', '.yml', '.py', '.go'];
const MAX_PASTE_CHARS = 12_000;
const MAX_MULTI_CHARS = 16_000;
const MAX_FILES = 10;
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function getFileExtension(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

const confidenceColors: Record<string, string> = {
  high: 'text-[var(--success)]',
  medium: 'text-[var(--warning)]',
  low: 'text-[var(--error)]',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BootstrapContextModal({
  workspaceId,
  activeLayer,
  onAccept,
  onClose,
}: BootstrapContextModalProps) {
  const [targetLayer, setTargetLayer] = useState<LayerTarget>(activeLayer);
  const [activeTab, setActiveTab] = useState<TabId>('wizard');
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [editedYaml, setEditedYaml] = useState('');
  const [sourceTab, setSourceTab] = useState<TabId>('wizard'); // tab that triggered extraction

  // ----- Wizard state -----
  const [wizardStep, setWizardStep] = useState(0);
  const [wizardAnswers, setWizardAnswers] = useState<Record<string, string>>({});

  // ----- Paste state -----
  const [pasteText, setPasteText] = useState('');

  // ----- Upload state -----
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploadWarnings, setUploadWarnings] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ----- File Path state -----
  const [filePath, setFilePath] = useState('');
  const [quickPicks, setQuickPicks] = useState<string[]>([]);
  const [quickPicksLoaded, setQuickPicksLoaded] = useState(false);

  // ----- URL state -----
  const [urlInput, setUrlInput] = useState('');
  const [urlPreview, setUrlPreview] = useState<UrlPreview | null>(null);
  const [urlPreviewLoading, setUrlPreviewLoading] = useState(false);
  const [urlPreviewError, setUrlPreviewError] = useState<string | null>(null);

  // ----- Multi-Source state -----
  const [multiSources, setMultiSources] = useState<MultiSourceEntry[]>([]);

  // Load quick picks when File Path tab is selected
  useEffect(() => {
    if (activeTab === 'filepath' && !quickPicksLoaded) {
      apiFetch<{ exists: string[] }>(
        `/api/workspaces/${workspaceId}/files?patterns=README.md,CLAUDE.md,docs/*.md,**/*.sql`
      )
        .then((data) => {
          setQuickPicks(data.exists);
          setQuickPicksLoaded(true);
        })
        .catch(() => setQuickPicksLoaded(true));
    }
  }, [activeTab, quickPicksLoaded, workspaceId]);

  // ----- Extraction handlers -----

  const handleExtract = useCallback(async (
    mode: string,
    payload: Record<string, unknown>,
  ) => {
    setIsExtracting(true);
    setExtractError(null);
    setSourceTab(activeTab);
    try {
      const data = await apiFetch<ExtractionResult>('/api/context/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, targetLayer, ...payload }),
      });
      setResult(data);
      setEditedYaml(data.yaml);
    } catch (err: any) {
      setExtractError(err.message || 'Extraction failed');
    } finally {
      setIsExtracting(false);
    }
  }, [activeTab, targetLayer]);

  const handleUploadExtract = useCallback(async () => {
    setIsExtracting(true);
    setExtractError(null);
    setSourceTab(activeTab);
    try {
      const formData = new FormData();
      formData.append('targetLayer', String(targetLayer));
      uploadFiles.forEach((f) => formData.append('files', f));

      const data = await apiFetch<ExtractionResult>('/api/context/upload', {
        method: 'POST',
        body: formData,
      });
      setResult(data);
      setEditedYaml(data.yaml);
    } catch (err: any) {
      setExtractError(err.message || 'Upload extraction failed');
    } finally {
      setIsExtracting(false);
    }
  }, [activeTab, targetLayer, uploadFiles]);

  const handleMultiExtract = useCallback(async () => {
    const sources = multiSources.map((s) => ({
      type: s.type,
      content: s.content,
      label: s.label,
    }));
    await handleExtract('multi', { sources });
  }, [handleExtract, multiSources]);

  const handleTryAgain = () => {
    setResult(null);
    setEditedYaml('');
    setActiveTab(sourceTab);
  };

  const handleAccept = () => {
    onAccept(editedYaml);
    onClose();
  };

  // ----- File handling -----

  const addFiles = (fileList: FileList | null) => {
    if (!fileList) return;
    const warnings: string[] = [];
    const valid: File[] = [];

    Array.from(fileList).forEach((f) => {
      const ext = getFileExtension(f.name);
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        warnings.push(`${f.name} \u2014 unsupported type`);
      } else if (f.size > MAX_FILE_SIZE) {
        warnings.push(`${f.name} \u2014 exceeds 5MB limit`);
      } else {
        valid.push(f);
      }
    });

    const total = uploadFiles.length + valid.length;
    if (total > MAX_FILES) {
      warnings.push(`Max ${MAX_FILES} files. ${total - MAX_FILES} file(s) skipped.`);
      valid.splice(MAX_FILES - uploadFiles.length);
    }

    setUploadFiles((prev) => [...prev, ...valid]);
    setUploadWarnings((prev) => [...prev, ...warnings]);
  };

  const removeFile = (idx: number) => {
    setUploadFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  // ----- URL preview -----

  const handleUrlPreview = async () => {
    if (!urlInput.trim()) return;
    setUrlPreviewLoading(true);
    setUrlPreviewError(null);
    try {
      const data = await apiFetch<UrlPreview>(
        `/api/context/fetch-preview?url=${encodeURIComponent(urlInput.trim())}`
      );
      setUrlPreview(data);
    } catch (err: any) {
      setUrlPreviewError(err.message || 'Preview failed');
    } finally {
      setUrlPreviewLoading(false);
    }
  };

  // ----- Multi-source helpers -----

  const addMultiSource = () => {
    setMultiSources((prev) => [
      ...prev,
      { id: uid(), type: 'paste', label: '', content: '' },
    ]);
  };

  const updateMultiSource = (id: string, update: Partial<MultiSourceEntry>) => {
    setMultiSources((prev) =>
      prev.map((s) => (s.id === id ? { ...s, ...update } : s))
    );
  };

  const removeMultiSource = (id: string) => {
    setMultiSources((prev) => prev.filter((s) => s.id !== id));
  };

  const multiCharEstimate = multiSources.reduce((sum, s) => {
    if (s.type === 'paste') return sum + s.content.length;
    return sum + 3000; // estimate for filepath/url
  }, 0);

  // ----- Render helpers -----

  const renderSpinner = () => (
    <div className="flex items-center justify-center gap-2 py-12 text-muted text-sm">
      <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24" fill="none">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      Extracting context...
    </div>
  );

  // ----- Preview pane (shown after extraction) -----

  if (result) {
    return (
      <ModalShell onClose={onClose}>
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="px-5 py-4 border-b border-border">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text">
                \u2728 Extracted for {LAYER_LABELS[targetLayer]}
              </h2>
              <button onClick={onClose} className="text-muted hover:text-text text-lg leading-none">&times;</button>
            </div>
            <div className="flex items-center gap-4 mt-2 text-xs">
              <span>
                Confidence:{' '}
                <span className={`font-semibold ${confidenceColors[result.confidence]}`}>
                  {result.confidence.charAt(0).toUpperCase() + result.confidence.slice(1)}
                </span>
              </span>
              <span className="text-muted">Tokens used: ~{result.tokenCount.toLocaleString()}</span>
            </div>
          </div>

          {/* Extracted / Missing fields */}
          <div className="px-5 py-3 border-b border-border text-xs">
            <div className="text-muted mb-1 font-medium">Extracted fields:</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {result.extracted.map((f) => (
                <span key={f} className="text-[var(--success)]">{'\u2713'} {f}</span>
              ))}
              {result.missing.map((f) => (
                <span key={f} className="text-[var(--error)]">{'\u2717'} {f} <span className="text-muted">(not found)</span></span>
              ))}
            </div>
          </div>

          {/* Editable YAML */}
          <div className="flex-1 flex flex-col min-h-0 px-5 py-3">
            <div className="text-xs text-muted mb-2">Generated YAML (editable before accepting):</div>
            <textarea
              value={editedYaml}
              onChange={(e) => setEditedYaml(e.target.value)}
              className="flex-1 w-full p-3 font-mono text-sm bg-panel text-text border border-border rounded resize-none outline-none focus:border-accent"
              spellCheck={false}
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-between px-5 py-3 border-t border-border">
            <button
              onClick={handleTryAgain}
              className="px-3 py-1.5 text-sm text-muted hover:text-text transition-colors"
            >
              &larr; Try Again
            </button>
            <button
              onClick={handleAccept}
              className="px-4 py-1.5 text-sm font-medium bg-accent hover:bg-[var(--accent-hover)] text-white rounded transition-colors"
            >
              {'\u2713'} Accept &mdash; Populate {LAYER_LABELS[targetLayer].split(' ').slice(0, 1)[0]}{targetLayer}
            </button>
          </div>
        </div>
      </ModalShell>
    );
  }

  // ----- Main modal (input tabs) -----

  return (
    <ModalShell onClose={onClose}>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border bg-panel/40 rounded-t-xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  <Sparkles size={16} />
                </span>
                <div>
                  <h2 className="text-base font-semibold text-text">Add Context</h2>
                  <p className="mt-0.5 text-xs text-muted">
                    Generate direction from a wizard, docs, files, URLs, or several sources at once.
                  </p>
                </div>
              </div>
            </div>
            <button
              onClick={onClose}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-bg hover:text-text focus:outline-none focus:ring-2 focus:ring-accent/50"
              aria-label="Close add context modal"
            >
              <X size={16} />
            </button>
          </div>
          {/* Layer selector */}
          <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl border border-border bg-bg/70 p-1">
            {([1, 2, 3] as const).map((n) => (
              <label key={n} className="group relative cursor-pointer">
                <input
                  type="radio"
                  name="targetLayer"
                  checked={targetLayer === n}
                  onChange={() => setTargetLayer(n)}
                  className="sr-only"
                />
                <span
                  className={`block rounded-lg px-3 py-2 text-left transition-colors ${
                    targetLayer === n
                      ? 'bg-accent/15 text-text ring-1 ring-accent/40'
                      : 'text-muted hover:bg-panel hover:text-text'
                  }`}
                >
                  <span className="block text-xs font-semibold">{LAYER_LABELS[n]}</span>
                  <span className="mt-0.5 block truncate text-[11px] opacity-80">{LAYER_DESCRIPTIONS[n]}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* Tab strip */}
        <div className="border-b border-border bg-bg/80 px-4 py-3">
          <div className="grid grid-cols-6 gap-1 rounded-xl border border-border bg-panel/40 p-1">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 ${
                    activeTab === tab.id
                      ? 'bg-accent/15 text-text shadow-sm ring-1 ring-accent/35'
                      : 'text-muted hover:bg-bg hover:text-text'
                  }`}
                >
                  <Icon size={13} />
                  <span className="truncate">{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-auto p-5 min-h-0">
          {isExtracting ? renderSpinner() : (
            <>
              {extractError && (
                <div className="mb-3 px-3 py-2 text-xs text-[var(--error)] bg-[var(--error)]/10 rounded">
                  {extractError}
                </div>
              )}

              {activeTab === 'wizard' && (
                <WizardTab
                  step={wizardStep}
                  answers={wizardAnswers}
                  onAnswer={(key, val) => setWizardAnswers((prev) => ({ ...prev, [key]: val }))}
                  onNext={() => setWizardStep((s) => Math.min(s + 1, WIZARD_QUESTIONS.length))}
                  onBack={() => setWizardStep((s) => Math.max(s - 1, 0))}
                  onSkip={() => {
                    setWizardStep((s) => Math.min(s + 1, WIZARD_QUESTIONS.length));
                  }}
                  onExtract={() => handleExtract('qa', { answers: wizardAnswers })}
                />
              )}

              {activeTab === 'paste' && (
                <PasteTab
                  text={pasteText}
                  onChange={setPasteText}
                  onExtract={() => handleExtract('paste', { text: pasteText })}
                />
              )}

              {activeTab === 'upload' && (
                <UploadTab
                  files={uploadFiles}
                  warnings={uploadWarnings}
                  fileInputRef={fileInputRef}
                  onAdd={addFiles}
                  onRemove={removeFile}
                  onExtract={handleUploadExtract}
                />
              )}

              {activeTab === 'filepath' && (
                <FilePathTab
                  path={filePath}
                  onChange={setFilePath}
                  quickPicks={quickPicks}
                  onExtract={() => handleExtract('filepath', { filePath })}
                />
              )}

              {activeTab === 'url' && (
                <UrlTab
                  url={urlInput}
                  onChange={setUrlInput}
                  preview={urlPreview}
                  previewLoading={urlPreviewLoading}
                  previewError={urlPreviewError}
                  onPreview={handleUrlPreview}
                  onExtract={() => handleExtract('url', { url: urlInput.trim() })}
                />
              )}

              {activeTab === 'multi' && (
                <MultiSourceTab
                  sources={multiSources}
                  charEstimate={multiCharEstimate}
                  onAdd={addMultiSource}
                  onUpdate={updateMultiSource}
                  onRemove={removeMultiSource}
                  onExtract={handleMultiExtract}
                />
              )}
            </>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

// ===========================================================================
// ModalShell — dark overlay + centered 780px container
// ===========================================================================

function ModalShell({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const trapRef = useFocusTrap<HTMLDivElement>(true, undefined, { onEscape: onClose });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Bootstrap context"
    >
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      {/* Modal */}
      <div
        ref={trapRef}
        className="relative flex flex-col rounded-xl border border-border bg-bg shadow-2xl shadow-black/40"
        style={{ width: 'min(920px, calc(100vw - 32px))', maxHeight: '86vh' }}
      >
        {children}
      </div>
    </div>
  );
}

// ===========================================================================
// Tab 1: Wizard
// ===========================================================================

function WizardTab({
  step,
  answers,
  onAnswer,
  onNext,
  onBack,
  onSkip,
  onExtract,
}: {
  step: number;
  answers: Record<string, string>;
  onAnswer: (key: string, val: string) => void;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  onExtract: () => void;
}) {
  const isSummary = step >= WIZARD_QUESTIONS.length;

  if (isSummary) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-panel/40 p-4">
          <div className="text-sm font-semibold text-text">Summary</div>
          <p className="mt-1 text-xs text-muted">Review the captured answers before extracting direction YAML.</p>
        </div>
        <div className="grid gap-2">
          {WIZARD_QUESTIONS.map((wq, index) => (
            <div key={wq.key} className="rounded-lg border border-border bg-bg/60 p-3 text-xs">
              <div className="flex items-center gap-2 text-muted">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-panel text-[10px]">{index + 1}</span>
                <span>{wq.q}</span>
              </div>
              <div className="mt-1.5 pl-7 text-text">
                {answers[wq.key] || <span className="text-muted italic">Skipped</span>}
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-border pt-4">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-muted transition-colors hover:bg-panel hover:text-text"
          >
            <ArrowLeft size={13} /> Back
          </button>
          <button
            onClick={onExtract}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[var(--accent-hover)]"
          >
            Extract <ArrowRight size={13} />
          </button>
        </div>
      </div>
    );
  }

  const q = WIZARD_QUESTIONS[step];
  return (
    <div className="space-y-5">
      {/* Progress */}
      <div className="rounded-xl border border-border bg-panel/40 p-4">
        <div className="mb-3 flex items-center justify-between gap-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-accent">Step {step + 1} of {WIZARD_QUESTIONS.length}</div>
            <div className="mt-1 text-base font-semibold text-text">{WIZARD_STEP_TITLES[step]}</div>
          </div>
          <span className="rounded-full border border-border bg-bg px-2 py-1 text-xs text-muted">{step + 1}/{WIZARD_QUESTIONS.length}</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-border">
          <div
            className="h-full rounded-full bg-accent transition-all"
            style={{ width: `${((step + 1) / WIZARD_QUESTIONS.length) * 100}%` }}
          />
        </div>
      </div>

      <div>
        <label className="mb-2 block text-sm font-semibold text-text">
          {q.q}
        </label>

        {q.type === 'radio' ? (
          <div className="grid gap-2">
            {['Greenfield \u2014 new project', 'Existing codebase'].map((opt) => (
              <label key={opt} className="cursor-pointer rounded-lg border border-border bg-panel/60 px-3 py-2.5 text-sm transition-colors hover:border-accent/60 hover:bg-panel">
                <input
                  type="radio"
                  name="codebase_type"
                  checked={answers[q.key] === opt}
                  onChange={() => onAnswer(q.key, opt)}
                  className="mr-2 accent-[var(--accent)]"
                />
                <span className="text-text">{opt}</span>
              </label>
            ))}
          </div>
        ) : q.type === 'textarea' ? (
          <textarea
            value={answers[q.key] || ''}
            onChange={(e) => onAnswer(q.key, e.target.value)}
            placeholder={q.placeholder}
            rows={4}
            className="w-full rounded-lg border border-border bg-panel p-3 font-mono text-sm text-text outline-none resize-none placeholder:text-muted/50 transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        ) : (
          <input
            type="text"
            value={answers[q.key] || ''}
            onChange={(e) => onAnswer(q.key, e.target.value)}
            placeholder={q.placeholder}
            className="h-11 w-full rounded-lg border border-border bg-panel px-3 text-sm text-text outline-none placeholder:text-muted/50 transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            autoFocus
          />
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <div>
          {step > 0 && (
            <button
              onClick={onBack}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-muted transition-colors hover:bg-panel hover:text-text"
            >
              <ArrowLeft size={13} /> Back
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onSkip}
            className="rounded-lg px-3 py-2 text-xs font-medium text-muted transition-colors hover:bg-panel hover:text-text"
          >
            Skip for now
          </button>
          <button
            onClick={onNext}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[var(--accent-hover)]"
          >
            Next <ArrowRight size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Tab 2: Paste
// ===========================================================================

function PasteTab({
  text,
  onChange,
  onExtract,
}: {
  text: string;
  onChange: (val: string) => void;
  onExtract: () => void;
}) {
  const truncated = text.length > MAX_PASTE_CHARS;

  return (
    <div className="flex flex-col h-full">
      <div className="text-xs text-muted mb-2">
        Paste any text here &mdash; a PRD, whitepaper, design doc, Notion export, meeting notes, or even a rough brain dump.
      </div>
      <textarea
        value={text}
        onChange={(e) => onChange(e.target.value.slice(0, MAX_PASTE_CHARS))}
        rows={18}
        className="w-full p-3 font-mono text-sm bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent resize-y"
        placeholder="Paste your text here..."
        spellCheck={false}
      />
      <div className="flex items-center justify-between mt-2">
        <div className="text-xs text-muted">
          {text.length.toLocaleString()} / {MAX_PASTE_CHARS.toLocaleString()} chars
          {truncated && (
            <span className="text-[var(--warning)] ml-2">{'\u26a0'} Truncated at {MAX_PASTE_CHARS.toLocaleString()}</span>
          )}
        </div>
        <button
          disabled={!text.trim()}
          onClick={onExtract}
          className="px-4 py-1.5 text-xs font-medium bg-accent hover:bg-[var(--accent-hover)] text-white rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Extract to YAML &rarr;
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Tab 3: Upload
// ===========================================================================

function UploadTab({
  files,
  warnings,
  fileInputRef,
  onAdd,
  onRemove,
  onExtract,
}: {
  files: File[];
  warnings: string[];
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  onAdd: (fl: FileList | null) => void;
  onRemove: (idx: number) => void;
  onExtract: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);

  return (
    <div>
      {/* Drop zone */}
      <div
        className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
          dragOver ? 'border-accent bg-accent/5' : 'border-border hover:border-muted'
        }`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          onAdd(e.dataTransfer.files);
        }}
      >
        <div className="text-sm text-muted">
          Drag files here, or click to browse
        </div>
        <div className="text-xs text-muted/60 mt-1">
          Supported: {ALLOWED_EXTENSIONS.join(' ')}
        </div>
        <div className="text-xs text-muted/60">
          Up to {MAX_FILES} files &middot; {MAX_FILE_SIZE / 1024 / 1024}MB each
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ALLOWED_EXTENSIONS.join(',')}
        className="hidden"
        onChange={(e) => { onAdd(e.target.files); e.target.value = ''; }}
      />

      {/* File list */}
      {files.length > 0 && (
        <div className="mt-3 space-y-1">
          <div className="text-xs text-muted font-medium">Uploaded files:</div>
          {files.map((f, i) => (
            <div key={`${f.name}-${i}`} className="flex items-center justify-between text-xs px-2 py-1 bg-panel rounded">
              <span className="text-[var(--success)]">{'\u2713'} {f.name} <span className="text-muted">({formatBytes(f.size)})</span></span>
              <button onClick={() => onRemove(i)} className="text-muted hover:text-[var(--error)] ml-2">{'\u2715'}</button>
            </div>
          ))}
        </div>
      )}

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="mt-2 space-y-1">
          {warnings.map((w, i) => (
            <div key={i} className="text-xs text-[var(--warning)]">{'\u26a0'} {w}</div>
          ))}
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <button
          disabled={files.length === 0}
          onClick={onExtract}
          className="px-4 py-1.5 text-xs font-medium bg-accent hover:bg-[var(--accent-hover)] text-white rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Extract All &rarr;
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Tab 4: File Path
// ===========================================================================

function FilePathTab({
  path,
  onChange,
  quickPicks,
  onExtract,
}: {
  path: string;
  onChange: (val: string) => void;
  quickPicks: string[];
  onExtract: () => void;
}) {
  return (
    <div>
      <label className="block text-xs text-muted mb-1">Absolute file path:</label>
      <input
        type="text"
        value={path}
        onChange={(e) => onChange(e.target.value)}
        placeholder="/Users/me/my-project/CLAUDE.md"
        className="w-full p-2 text-sm font-mono bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent"
      />

      {quickPicks.length > 0 && (
        <div className="mt-3">
          <div className="text-xs text-muted font-medium mb-1">Quick picks (detected in workspace):</div>
          <div className="space-y-1">
            {quickPicks.map((fp) => (
              <button
                key={fp}
                onClick={() => onChange(fp)}
                className="block text-xs text-accent hover:text-[var(--accent-hover)] transition-colors"
              >
                &bull; {fp}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <button
          disabled={!path.trim()}
          onClick={onExtract}
          className="px-4 py-1.5 text-xs font-medium bg-accent hover:bg-[var(--accent-hover)] text-white rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Extract from File &rarr;
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Tab 5: URL
// ===========================================================================

function UrlTab({
  url,
  onChange,
  preview,
  previewLoading,
  previewError,
  onPreview,
  onExtract,
}: {
  url: string;
  onChange: (val: string) => void;
  preview: UrlPreview | null;
  previewLoading: boolean;
  previewError: string | null;
  onPreview: () => void;
  onExtract: () => void;
}) {
  return (
    <div>
      <label className="block text-xs text-muted mb-1">Fetch from URL:</label>
      <div className="flex gap-2">
        <input
          type="text"
          value={url}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://github.com/user/repo/blob/main/README.md"
          className="flex-1 p-2 text-sm font-mono bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent"
        />
        <button
          disabled={!url.trim() || previewLoading}
          onClick={onPreview}
          className="px-3 py-1.5 text-xs text-muted hover:text-text border border-border rounded transition-colors disabled:opacity-40"
        >
          Preview {'\u2197'}
        </button>
      </div>

      {previewLoading && (
        <div className="mt-3 text-xs text-muted">Loading preview...</div>
      )}

      {previewError && (
        <div className="mt-3 text-xs text-[var(--error)]">{previewError}</div>
      )}

      {preview && !previewLoading && (
        <div className="mt-3 border border-border rounded p-3">
          <div className="text-xs text-muted mb-2">
            Content-Type: {preview.contentType} &middot; ~{preview.contentLength.toLocaleString()} chars
          </div>
          <div className="border-t border-border pt-2">
            <pre className="text-xs text-text whitespace-pre-wrap font-mono">{preview.preview}</pre>
          </div>
        </div>
      )}

      <div className="mt-3 text-xs text-muted space-y-0.5">
        <div>&bull; GitHub blob URLs are auto-converted to raw content</div>
        <div>&bull; Public Notion pages, docs sites, and wikis work too</div>
        <div>&bull; Private/authenticated URLs will not load</div>
      </div>

      <div className="mt-4 flex justify-end">
        <button
          disabled={!url.trim()}
          onClick={onExtract}
          className="px-4 py-1.5 text-xs font-medium bg-accent hover:bg-[var(--accent-hover)] text-white rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Extract from URL &rarr;
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Tab 6: Multi-Source
// ===========================================================================

function MultiSourceTab({
  sources,
  charEstimate,
  onAdd,
  onUpdate,
  onRemove,
  onExtract,
}: {
  sources: MultiSourceEntry[];
  charEstimate: number;
  onAdd: () => void;
  onUpdate: (id: string, update: Partial<MultiSourceEntry>) => void;
  onRemove: (id: string) => void;
  onExtract: () => void;
}) {
  const pct = Math.min((charEstimate / MAX_MULTI_CHARS) * 100, 100);

  return (
    <div>
      <div className="text-xs text-muted mb-3">
        {'\u26a1'} Combine multiple sources into one extraction pass.
        Each source is read and merged &mdash; the LLM sees all content together.
      </div>

      <button
        onClick={onAdd}
        className="px-3 py-1.5 text-xs text-accent hover:text-[var(--accent-hover)] border border-border rounded transition-colors mb-3"
      >
        + Add Source
      </button>

      <div className="space-y-2">
        {sources.map((src, idx) => (
          <div key={src.id} className="border border-border rounded p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs text-muted font-medium">#{idx + 1}</span>
              <select
                value={src.type}
                onChange={(e) => onUpdate(src.id, { type: e.target.value as MultiSourceEntry['type'], content: '' })}
                className="text-xs bg-panel border border-border rounded px-2 py-1 text-text outline-none"
              >
                <option value="paste">Paste</option>
                <option value="filepath">File Path</option>
                <option value="url">URL</option>
              </select>
              <input
                type="text"
                value={src.label}
                onChange={(e) => onUpdate(src.id, { label: e.target.value })}
                placeholder="Label"
                className="flex-1 text-xs bg-panel border border-border rounded px-2 py-1 text-text placeholder:text-muted/50 outline-none"
              />
              <button
                onClick={() => onRemove(src.id)}
                className="text-xs text-muted hover:text-[var(--error)] transition-colors"
              >
                {'\u2715'} Remove
              </button>
            </div>

            {src.type === 'paste' && (
              <textarea
                value={src.content}
                onChange={(e) => onUpdate(src.id, { content: e.target.value })}
                rows={3}
                placeholder="Paste text..."
                className="w-full p-2 text-xs font-mono bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none resize-y"
              />
            )}
            {src.type === 'filepath' && (
              <input
                type="text"
                value={src.content}
                onChange={(e) => onUpdate(src.id, { content: e.target.value })}
                placeholder="/path/to/file"
                className="w-full p-2 text-xs font-mono bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none"
              />
            )}
            {src.type === 'url' && (
              <input
                type="text"
                value={src.content}
                onChange={(e) => onUpdate(src.id, { content: e.target.value })}
                placeholder="https://..."
                className="w-full p-2 text-xs font-mono bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none"
              />
            )}
          </div>
        ))}
      </div>

      {sources.length > 0 && (
        <div className="mt-3">
          <div className="text-xs text-muted mb-1">
            Estimated context: ~{charEstimate.toLocaleString()} chars (of {MAX_MULTI_CHARS.toLocaleString()} max)
          </div>
          <div className="h-2 bg-border rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${pct > 90 ? 'bg-[var(--warning)]' : 'bg-accent'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <button
          disabled={sources.length === 0}
          onClick={onExtract}
          className="px-4 py-1.5 text-xs font-medium bg-accent hover:bg-[var(--accent-hover)] text-white rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Extract All Sources &rarr;
        </button>
      </div>
    </div>
  );
}
