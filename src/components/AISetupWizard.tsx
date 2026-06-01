/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useCallback } from 'react';
import { apiFetch } from '../lib/apiFetch';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AISetupWizardProps {
  workspaceId: string;
  onComplete: (layers: { l1: string; l2: string; l3: string }) => void;
  onClose: () => void;
  hasExistingLayers?: boolean;
}

interface WizardQuestion {
  key: string;
  question: string;
  placeholder: string;
  type: 'input' | 'textarea' | 'radio';
  options?: string[];
}

interface WizardResult {
  l1: string;
  l2: string;
  l3: string;
  l3Valid: boolean;
  l3Errors: { path: string; message: string }[];
  usage: { inputTokens: number; outputTokens: number };
}

type Phase = 'questions' | 'generating' | 'preview';

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

const QUESTIONS: WizardQuestion[] = [
  {
    key: 'project_description',
    question: 'Tell me about your project. What are you building and why?',
    placeholder: 'e.g. A mobile-first invoicing app for freelancers who want to get paid faster without chasing clients',
    type: 'textarea',
  },
  {
    key: 'tech_stack',
    question: 'What technologies are you using (or planning to use)?',
    placeholder: 'e.g. React, Node.js, PostgreSQL, Stripe, deployed on Vercel',
    type: 'input',
  },
  {
    key: 'key_constraints',
    question: 'What are the hard constraints or non-negotiables?',
    placeholder: 'e.g. Must work offline, HIPAA compliant, no vendor lock-in, mobile-first',
    type: 'textarea',
  },
  {
    key: 'team_and_deployment',
    question: 'Who is on the team and where does this deploy?',
    placeholder: 'e.g. Solo developer, deploying to AWS with Docker. Or: 3-person team, Vercel + Supabase',
    type: 'input',
  },
  {
    key: 'domain',
    question: 'What industry or domain does this serve?',
    placeholder: 'e.g. Fintech, Healthcare, E-commerce, Education, Developer tools',
    type: 'input',
  },
  {
    key: 'coding_preferences',
    question: 'Any coding style or engineering preferences you want enforced?',
    placeholder: 'e.g. Prefer functional style, no classes. Always use TypeScript strict mode. Test-first development.',
    type: 'textarea',
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AISetupWizard({
  workspaceId,
  onComplete,
  onClose,
  hasExistingLayers,
}: AISetupWizardProps) {
  const [phase, setPhase] = useState<Phase>('questions');
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Preview state
  const [result, setResult] = useState<WizardResult | null>(null);
  const [editedL1, setEditedL1] = useState('');
  const [editedL2, setEditedL2] = useState('');
  const [editedL3, setEditedL3] = useState('');
  const [previewTab, setPreviewTab] = useState<1 | 2 | 3>(1);
  const [isSaving, setIsSaving] = useState(false);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);

  const isSummary = step >= QUESTIONS.length;
  const answeredCount = Object.values(answers).filter((v) => v.trim()).length;

  // Generate layers via backend
  const handleGenerate = useCallback(async () => {
    setPhase('generating');
    setError(null);
    try {
      const data = await apiFetch<WizardResult>('/api/direction/wizard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers }),
      });
      setResult(data);
      setEditedL1(data.l1);
      setEditedL2(data.l2);
      setEditedL3(data.l3);
      setPhase('preview');
    } catch (err: any) {
      setError(err.message || 'Generation failed');
      setPhase('questions');
      setStep(QUESTIONS.length); // back to summary
    }
  }, [answers]);

  // Save all 3 layers via PUT /api/direction
  const handleSave = useCallback(async () => {
    if (hasExistingLayers && !confirmOverwrite) {
      setConfirmOverwrite(true);
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      await Promise.all([
        apiFetch('/api/direction', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ layer: 1, contentYaml: editedL1 }),
        }),
        apiFetch('/api/direction', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ layer: 2, workspaceId, contentYaml: editedL2 }),
        }),
        apiFetch('/api/direction', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ layer: 3, workspaceId, contentYaml: editedL3 }),
        }),
      ]);
      onComplete({ l1: editedL1, l2: editedL2, l3: editedL3 });
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save layers');
    } finally {
      setIsSaving(false);
    }
  }, [editedL1, editedL2, editedL3, workspaceId, hasExistingLayers, confirmOverwrite, onComplete, onClose]);

  // ----- Generating screen -----
  if (phase === 'generating') {
    return (
      <ModalShell onClose={onClose}>
        <div className="flex flex-col items-center justify-center h-full py-16">
          <svg className="w-8 h-8 animate-spin text-accent mb-4" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <div className="text-sm text-text font-medium">Generating your direction...</div>
          <div className="text-xs text-muted mt-1">Claude is synthesizing Standards, Conventions, and Project from your answers</div>
        </div>
      </ModalShell>
    );
  }

  // ----- Preview screen -----
  if (phase === 'preview' && result) {
    const layers = { 1: editedL1, 2: editedL2, 3: editedL3 };
    const setters = { 1: setEditedL1, 2: setEditedL2, 3: setEditedL3 };
    const labels = { 1: 'Standards', 2: 'Conventions', 3: 'Project' };

    return (
      <ModalShell onClose={onClose} wide>
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="px-5 py-4 border-b border-border">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text">
                Preview Generated Direction
              </h2>
              <button onClick={onClose} className="text-muted hover:text-text text-lg leading-none">&times;</button>
            </div>
            <div className="flex items-center gap-4 mt-2 text-xs text-muted">
              <span>Tokens: ~{((result.usage.inputTokens || 0) + (result.usage.outputTokens || 0)).toLocaleString()}</span>
              {!result.l3Valid && (
                <span className="text-[var(--warning)]">
                  Project has validation warnings — review before saving
                </span>
              )}
            </div>
          </div>

          {/* Layer tabs */}
          <div className="flex border-b border-border">
            {([1, 2, 3] as const).map((n) => (
              <button
                key={n}
                onClick={() => setPreviewTab(n)}
                className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
                  previewTab === n
                    ? 'text-text border-b-2 border-accent'
                    : 'text-muted hover:text-text'
                }`}
              >
                {labels[n]}
                {n === 3 && !result.l3Valid && (
                  <span className="ml-1 text-[var(--warning)]">!</span>
                )}
              </button>
            ))}
          </div>

          {/* Editable YAML */}
          <div className="flex-1 flex flex-col min-h-0 px-5 py-3">
            <div className="text-xs text-muted mb-2">
              Edit the generated YAML below before saving. All three layers will be saved at once.
            </div>
            <textarea
              value={layers[previewTab]}
              onChange={(e) => setters[previewTab](e.target.value)}
              className="flex-1 w-full p-3 font-mono text-sm bg-panel text-text border border-border rounded resize-none outline-none focus:border-accent"
              spellCheck={false}
            />
          </div>

          {/* Error / Overwrite confirmation */}
          {error && (
            <div className="mx-5 mb-2 px-3 py-2 text-xs text-[var(--error)] bg-[var(--error)]/10 rounded">
              {error}
            </div>
          )}

          {confirmOverwrite && (
            <div className="mx-5 mb-2 px-3 py-2 text-xs text-[var(--warning)] bg-[var(--warning)]/10 rounded">
              This will overwrite your existing direction layers. Click "Save All Layers" again to confirm.
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between px-5 py-3 border-t border-border">
            <button
              onClick={() => {
                setPhase('questions');
                setStep(QUESTIONS.length);
                setConfirmOverwrite(false);
              }}
              className="px-3 py-1.5 text-sm text-muted hover:text-text transition-colors"
            >
              &larr; Back to Questions
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="px-4 py-1.5 text-sm font-medium bg-accent hover:bg-[var(--accent-hover)] text-white rounded transition-colors disabled:opacity-60"
            >
              {isSaving ? 'Saving...' : confirmOverwrite ? 'Confirm Overwrite' : 'Save All Layers'}
            </button>
          </div>
        </div>
      </ModalShell>
    );
  }

  // ----- Questions phase -----
  return (
    <ModalShell onClose={onClose}>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="px-5 py-4 border-b border-border">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text">
              Setup with AI
            </h2>
            <button onClick={onClose} className="text-muted hover:text-text text-lg leading-none">&times;</button>
          </div>
          <div className="text-xs text-muted mt-1">
            Answer a few questions and Claude will generate your Standards, Conventions, and Project direction layers.
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-5 min-h-0">
          {error && (
            <div className="mb-3 px-3 py-2 text-xs text-[var(--error)] bg-[var(--error)]/10 rounded">
              {error}
            </div>
          )}

          {isSummary ? (
            /* Summary before generation */
            <div>
              <div className="text-xs font-medium text-muted mb-3">
                Review your answers ({answeredCount}/{QUESTIONS.length} answered)
              </div>
              <div className="space-y-3 mb-4">
                {QUESTIONS.map((q, idx) => (
                  <div key={q.key} className="text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-muted font-medium">Q{idx + 1}.</span>
                      <span className="text-muted">{q.question}</span>
                    </div>
                    <div className="text-text mt-0.5 pl-6">
                      {answers[q.key]?.trim() || <span className="text-muted italic">Skipped</span>}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setStep(QUESTIONS.length - 1)}
                  className="px-3 py-1.5 text-xs text-muted hover:text-text transition-colors"
                >
                  &larr; Back
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={answeredCount < 2}
                  className="px-4 py-1.5 text-xs font-medium bg-accent hover:bg-[var(--accent-hover)] text-white rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ml-auto"
                >
                  Generate Direction &rarr;
                </button>
              </div>
              {answeredCount < 2 && (
                <div className="text-xs text-muted mt-2">
                  Please answer at least 2 questions to generate useful layers.
                </div>
              )}
            </div>
          ) : (
            /* Individual question */
            <div>
              {/* Progress */}
              <div className="flex items-center gap-2 mb-4">
                <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent transition-all"
                    style={{ width: `${((step + 1) / QUESTIONS.length) * 100}%` }}
                  />
                </div>
                <span className="text-xs text-muted">{step + 1}/{QUESTIONS.length}</span>
              </div>

              <label className="block text-sm font-medium text-text mb-2">
                {QUESTIONS[step].question}
              </label>

              {QUESTIONS[step].type === 'textarea' ? (
                <textarea
                  value={answers[QUESTIONS[step].key] || ''}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [QUESTIONS[step].key]: e.target.value }))}
                  placeholder={QUESTIONS[step].placeholder}
                  rows={4}
                  className="w-full p-2 text-sm font-mono bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent resize-none"
                  autoFocus
                />
              ) : QUESTIONS[step].type === 'radio' && QUESTIONS[step].options ? (
                <div className="flex flex-col gap-2 mb-4">
                  {QUESTIONS[step].options!.map((opt) => (
                    <label key={opt} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="radio"
                        name={QUESTIONS[step].key}
                        checked={answers[QUESTIONS[step].key] === opt}
                        onChange={() => setAnswers((prev) => ({ ...prev, [QUESTIONS[step].key]: opt }))}
                        className="accent-[var(--accent)]"
                      />
                      <span className="text-text">{opt}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <input
                  type="text"
                  value={answers[QUESTIONS[step].key] || ''}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [QUESTIONS[step].key]: e.target.value }))}
                  placeholder={QUESTIONS[step].placeholder}
                  className="w-full p-2 text-sm bg-panel border border-border rounded text-text placeholder:text-muted/50 outline-none focus:border-accent"
                  autoFocus
                />
              )}

              <div className="flex items-center gap-2 mt-4">
                {step > 0 && (
                  <button
                    onClick={() => setStep((s) => s - 1)}
                    className="px-3 py-1.5 text-xs text-muted hover:text-text transition-colors"
                  >
                    &larr; Back
                  </button>
                )}
                <button
                  onClick={() => setStep((s) => s + 1)}
                  className="px-3 py-1.5 text-xs text-muted hover:text-text transition-colors"
                >
                  Skip
                </button>
                <button
                  onClick={() => setStep((s) => s + 1)}
                  className="px-4 py-1.5 text-xs font-medium bg-accent hover:bg-[var(--accent-hover)] text-white rounded transition-colors ml-auto"
                >
                  {step === QUESTIONS.length - 1 ? 'Review' : 'Next'} &rarr;
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

// ===========================================================================
// ModalShell
// ===========================================================================

function ModalShell({
  onClose,
  children,
  wide,
}: {
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        className="relative bg-bg border border-border rounded-lg shadow-2xl flex flex-col"
        style={{ width: wide ? 900 : 680, maxHeight: '85vh' }}
      >
        {children}
      </div>
    </div>
  );
}
