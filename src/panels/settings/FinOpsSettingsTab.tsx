/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * FinOps billing-profile settings (FIN-006).
 *
 * Operators declare HOW each provider/model is paid for: subscription monthly
 * cost, how that flat cost is allocated to runs, whether the profile is
 * enabled, its effective date window, and whether it participates in the
 * blended effective total. The editor surfaces the marginal-vs-allocated
 * distinction explicitly so the billing semantics aren't buried in ad hoc
 * controls. All I/O goes through the typed `analytics` API client (apiFetch);
 * no raw fetch, no hardcoded colors.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Wallet, Plus, Pencil, Trash2, Loader2, AlertTriangle, Check, X, Power,
} from 'lucide-react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useGlobalToast } from '../../contexts/ToastContext';
import { ApiError } from '../../lib/apiFetch';
import SlideOver from '../../components/SlideOver';
import type { BillingMode, BillingProfile } from '../../api/types';
import { BILLING_MODES, ALLOCATION_BASES } from '../../api/types';
import {
  listBillingProfiles,
  createBillingProfile,
  updateBillingProfile,
  deleteBillingProfile,
  billingProfileContributesToBlended,
} from '../../api/analytics';
import {
  type FinOpsProfileFormState,
  emptyFinOpsProfileForm,
  profileToFinOpsForm,
  validateFinOpsProfileForm,
  isFinOpsProfileFormValid,
  finOpsFormToInput,
  formContributesToBlended,
  modeSupportsMonthlyCost,
  BILLING_MODE_LABELS,
  ALLOCATION_BASIS_LABELS,
} from './finopsProfileForm';

// ─── Field primitives (token-driven styling only) ────────────────────────────

const FIELD_CLASS =
  'w-full bg-bg border border-border rounded px-3 py-2 text-sm text-[var(--text)] ' +
  'placeholder:text-muted/50 focus:border-accent/60 outline-none transition-colors';

function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="block text-xs font-medium text-muted mb-1.5">
      {children}
    </label>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1 flex items-center gap-1 text-xs text-error">
      <AlertTriangle size={12} />
      {message}
    </p>
  );
}

// ─── Profile editor (create + edit share this SlideOver) ─────────────────────

interface ProfileEditorProps {
  isOpen: boolean;
  /** null = create flow, otherwise editing this profile. */
  editing: BillingProfile | null;
  workspaceId: string | null;
  onClose: () => void;
  onSaved: () => void;
}

function ProfileEditor({ isOpen, editing, workspaceId, onClose, onSaved }: ProfileEditorProps) {
  const toast = useGlobalToast();
  const [form, setForm] = useState<FinOpsProfileFormState>(emptyFinOpsProfileForm);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset the form whenever the editor opens (fresh blank or hydrated profile).
  useEffect(() => {
    if (!isOpen) return;
    setForm(editing ? profileToFinOpsForm(editing) : emptyFinOpsProfileForm());
    setSubmitted(false);
  }, [isOpen, editing]);

  const errors = useMemo(() => validateFinOpsProfileForm(form), [form]);
  const valid = isFinOpsProfileFormValid(form);
  const supportsCost = modeSupportsMonthlyCost(form.billingMode);
  const blended = formContributesToBlended(form);

  const set = useCallback(
    <K extends keyof FinOpsProfileFormState>(key: K, value: FinOpsProfileFormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const handleSubmit = useCallback(async () => {
    setSubmitted(true);
    if (!isFinOpsProfileFormValid(form)) return;
    setSaving(true);
    try {
      const input = finOpsFormToInput(form, workspaceId);
      if (editing) {
        await updateBillingProfile(editing.id, input);
        toast.success('Billing profile updated');
      } else {
        await createBillingProfile(input);
        toast.success('Billing profile created');
      }
      onSaved();
      onClose();
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : 'Failed to save billing profile';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }, [form, workspaceId, editing, toast, onSaved, onClose]);

  // Only show field errors after a submit attempt to avoid shouting on first keystroke.
  const shownErrors = submitted ? errors : {};

  return (
    <SlideOver
      isOpen={isOpen}
      onClose={onClose}
      title={editing ? 'Edit Billing Profile' : 'New Billing Profile'}
    >
      <div className="flex flex-col gap-5 p-4">
        {/* Provider + model pattern */}
        <div>
          <FieldLabel htmlFor="finops-provider">Provider</FieldLabel>
          <input
            id="finops-provider"
            className={FIELD_CLASS}
            placeholder="anthropic"
            value={form.provider}
            onChange={(e) => set('provider', e.target.value)}
          />
          <FieldError message={shownErrors.provider} />
        </div>

        <div>
          <FieldLabel htmlFor="finops-model-pattern">Model pattern (optional)</FieldLabel>
          <input
            id="finops-model-pattern"
            className={FIELD_CLASS}
            placeholder="claude-opus-*"
            value={form.modelPattern}
            onChange={(e) => set('modelPattern', e.target.value)}
          />
          <p className="mt-1 text-xs text-muted/70">
            Glob match, e.g. <code>claude-opus-*</code>. Leave blank to apply to all
            models for this provider.
          </p>
        </div>

        {/* Billing mode */}
        <div>
          <FieldLabel htmlFor="finops-billing-mode">Billing mode</FieldLabel>
          <select
            id="finops-billing-mode"
            className={FIELD_CLASS}
            value={form.billingMode}
            onChange={(e) => set('billingMode', e.target.value as BillingMode)}
          >
            {BILLING_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {BILLING_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </div>

        {/* Marginal vs allocated explainer */}
        <div className="rounded-md border border-border bg-panel/60 px-3 py-2.5 text-xs leading-relaxed text-muted">
          <p>
            <span className="font-semibold text-[var(--text)]">Marginal cost</span> is what
            each run actually adds — pay-per-token API spend that disappears when you stop
            running.
          </p>
          <p className="mt-1.5">
            <span className="font-semibold text-[var(--text)]">Allocated cost</span> spreads a
            flat <span className="text-accent">subscription</span> fee across runs even though
            the fee is paid whether or not you run anything. Allocation only applies to
            subscription mode below.
          </p>
        </div>

        {/* Subscription cost (subscription only) */}
        {supportsCost && (
          <div>
            <FieldLabel htmlFor="finops-monthly-cost">Subscription monthly cost (USD)</FieldLabel>
            <input
              id="finops-monthly-cost"
              type="number"
              min={0}
              step="0.01"
              className={FIELD_CLASS}
              placeholder="200"
              value={form.monthlyCostUsd}
              onChange={(e) => set('monthlyCostUsd', e.target.value)}
            />
            <FieldError message={shownErrors.monthlyCostUsd} />
          </div>
        )}

        {/* Allocation basis (subscription only) */}
        {supportsCost && (
          <div>
            <FieldLabel htmlFor="finops-allocation-basis">Allocation basis</FieldLabel>
            <select
              id="finops-allocation-basis"
              className={FIELD_CLASS}
              value={form.allocationBasis}
              onChange={(e) =>
                set('allocationBasis', e.target.value as FinOpsProfileFormState['allocationBasis'])
              }
            >
              {ALLOCATION_BASES.map((basis) => (
                <option key={basis} value={basis}>
                  {ALLOCATION_BASIS_LABELS[basis]}
                </option>
              ))}
            </select>
            <FieldError message={shownErrors.allocationBasis} />
          </div>
        )}

        {/* Effective window */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel htmlFor="finops-effective-from">Effective from</FieldLabel>
            <input
              id="finops-effective-from"
              type="date"
              className={FIELD_CLASS}
              value={form.effectiveFrom}
              onChange={(e) => set('effectiveFrom', e.target.value)}
            />
            <p className="mt-1 text-xs text-muted/70">Blank = effective now.</p>
          </div>
          <div>
            <FieldLabel htmlFor="finops-effective-to">Effective to</FieldLabel>
            <input
              id="finops-effective-to"
              type="date"
              className={FIELD_CLASS}
              value={form.effectiveTo}
              onChange={(e) => set('effectiveTo', e.target.value)}
            />
            <p className="mt-1 text-xs text-muted/70">Blank = open-ended.</p>
            <FieldError message={shownErrors.effectiveTo} />
          </div>
        </div>

        {/* Enabled + blended participation */}
        <div className="flex flex-col gap-3 rounded-md border border-border px-3 py-3">
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <span className="text-sm text-[var(--text)]">Enabled</span>
            <input
              type="checkbox"
              aria-label="Enabled"
              className="h-4 w-4 accent-[var(--accent)]"
              checked={form.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
            />
          </label>
          <div className="flex items-start justify-between gap-3 border-t border-border pt-3">
            <div className="min-w-0">
              <p className="text-sm text-[var(--text)]">Participates in blended total</p>
              <p className="mt-0.5 text-xs text-muted/70">
                A profile feeds allocated cost into the blended effective total only when it is
                an enabled subscription with a positive cost and an allocation basis other than
                none.
              </p>
            </div>
            <span
              className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                blended
                  ? 'bg-success/15 text-success'
                  : 'bg-surface-200 text-muted'
              }`}
            >
              {blended ? <Check size={11} /> : <X size={11} />}
              {blended ? 'Yes' : 'No'}
            </span>
          </div>
        </div>

        {/* Notes */}
        <div>
          <FieldLabel htmlFor="finops-notes">Notes (optional)</FieldLabel>
          <textarea
            id="finops-notes"
            rows={2}
            className={`${FIELD_CLASS} resize-none`}
            placeholder="Context for teammates reviewing this profile…"
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
          />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-2 text-sm text-muted hover:text-[var(--text)] rounded transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={saving || (submitted && !valid)}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded bg-accent text-[var(--bg)] hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {editing ? 'Save changes' : 'Create profile'}
          </button>
        </div>
      </div>
    </SlideOver>
  );
}

// ─── Profile row ─────────────────────────────────────────────────────────────

function ProfileRow({
  profile,
  onEdit,
  onDelete,
  deleting,
}: {
  profile: BillingProfile;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const blended = billingProfileContributesToBlended(profile);
  return (
    <div className="flex items-center gap-3 border border-border rounded-md px-4 py-3 bg-panel">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--text)] truncate">
            {profile.provider}
            {profile.modelPattern ? ` · ${profile.modelPattern}` : ''}
          </span>
          {!profile.enabled && (
            <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-surface-200 px-2 py-0.5 text-[10px] font-medium text-muted">
              <Power size={10} /> Disabled
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span>{BILLING_MODE_LABELS[profile.billingMode]}</span>
          {profile.monthlyCostUsd != null && (
            <span>${profile.monthlyCostUsd.toFixed(2)}/mo</span>
          )}
          {profile.billingMode === 'subscription' && (
            <span>Alloc: {ALLOCATION_BASIS_LABELS[profile.allocationBasis]}</span>
          )}
          {blended && (
            <span className="inline-flex items-center gap-1 text-success">
              <Check size={11} /> Blended
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        aria-label={`Edit ${profile.provider} profile`}
        onClick={onEdit}
        className="p-2 rounded text-muted hover:text-[var(--text)] hover:bg-surface-200 transition-colors"
      >
        <Pencil size={15} />
      </button>
      <button
        type="button"
        aria-label={`Delete ${profile.provider} profile`}
        onClick={onDelete}
        disabled={deleting}
        className="p-2 rounded text-muted hover:text-error hover:bg-surface-200 transition-colors disabled:opacity-50"
      >
        {deleting ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
      </button>
    </div>
  );
}

// ─── Main tab ────────────────────────────────────────────────────────────────

export function FinOpsSettingsTab() {
  const { workspaceId } = useWorkspace();
  const toast = useGlobalToast();

  const [profiles, setProfiles] = useState<BillingProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<BillingProfile | null>(null);
  const [pendingDelete, setPendingDelete] = useState<BillingProfile | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { profiles: rows } = await listBillingProfiles(
        workspaceId ? { workspaceId } : {},
      );
      setProfiles(rows);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : 'Failed to load billing profiles';
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = useCallback(() => {
    setEditing(null);
    setEditorOpen(true);
  }, []);

  const openEdit = useCallback((profile: BillingProfile) => {
    setEditing(profile);
    setEditorOpen(true);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeletingId(pendingDelete.id);
    try {
      await deleteBillingProfile(pendingDelete.id);
      toast.success('Billing profile deleted');
      setPendingDelete(null);
      await load();
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : 'Failed to delete billing profile';
      toast.error(msg);
    } finally {
      setDeletingId(null);
    }
  }, [pendingDelete, toast, load]);

  return (
    <section aria-label="FinOps billing profiles">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text)]">
            <Wallet size={18} className="text-accent" />
            Billing Profiles
          </h2>
          <p className="mt-1 text-sm text-muted max-w-2xl">
            Declare how each provider is paid for so FinOps can separate{' '}
            <span className="text-[var(--text)]">marginal</span> API spend from{' '}
            <span className="text-[var(--text)]">allocated</span> subscription cost. Profiles
            with allocation feed the blended effective total used in analytics.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="shrink-0 inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded bg-accent text-[var(--bg)] hover:bg-accent-hover transition-colors"
        >
          <Plus size={15} />
          New profile
        </button>
      </div>

      {/* Body */}
      <div className="mt-6">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-muted">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center gap-3 rounded-md border border-error/40 bg-error/5 py-10 text-center">
            <AlertTriangle size={22} className="text-error" />
            <p className="text-sm text-[var(--text)]">{loadError}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="text-xs text-accent hover:underline"
            >
              Retry
            </button>
          </div>
        ) : profiles.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border py-12 text-center">
            <Wallet size={26} className="text-muted opacity-40" />
            <p className="text-sm text-muted">No billing profiles yet.</p>
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center gap-2 text-xs text-accent hover:underline"
            >
              <Plus size={13} /> Add your first profile
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {profiles.map((profile) => (
              <ProfileRow
                key={profile.id}
                profile={profile}
                onEdit={() => openEdit(profile)}
                onDelete={() => setPendingDelete(profile)}
                deleting={deletingId === profile.id}
              />
            ))}
          </div>
        )}
      </div>

      {/* Editor */}
      <ProfileEditor
        isOpen={editorOpen}
        editing={editing}
        workspaceId={workspaceId}
        onClose={() => setEditorOpen(false)}
        onSaved={() => void load()}
      />

      {/* Delete confirmation */}
      {pendingDelete && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm delete billing profile"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setPendingDelete(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-border bg-panel p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <AlertTriangle size={18} className="text-error" />
              <h3 className="text-sm font-semibold text-[var(--text)]">Delete billing profile?</h3>
            </div>
            <p className="mt-2 text-sm text-muted">
              This removes the <span className="text-[var(--text)]">{pendingDelete.provider}</span>{' '}
              profile. Past analytics already computed are unaffected, but future allocation will
              no longer use it.
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="px-3 py-2 text-sm text-muted hover:text-[var(--text)] rounded transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={deletingId === pendingDelete.id}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded bg-error text-[var(--bg)] hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {deletingId === pendingDelete.id ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Trash2 size={14} />
                )}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default FinOpsSettingsTab;
