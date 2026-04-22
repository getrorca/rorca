import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { AlertTriangle, Loader2, Save, Trash2, User as UserIcon } from 'lucide-react';
import { AnimatedModal } from '../../components/AnimatedModal';
import { useAuth } from '../../contexts/AuthContext';
import { useGlobalToast } from '../../contexts/ToastContext';
import { apiFetch, clearTokens } from '../../lib/apiFetch';
import { supabase } from '../../lib/supabase';

interface DeleteAccountResponse {
  message: string;
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function getInitials(fullName: string | null | undefined, email: string | null | undefined): string {
  const source = fullName?.trim() || email?.trim() || 'U';
  const parts = source.split(/\s+/).filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }

  return source.slice(0, 2).toUpperCase();
}

function getAvatarColor(seed: string): string {
  const hue = hashString(seed) % 360;
  return `hsl(${hue} 65% 45%)`;
}

function ProfileAvatar({
  avatarUrl,
  fullName,
  email,
}: {
  avatarUrl: string | null;
  fullName: string;
  email: string;
}) {
  const initials = useMemo(() => getInitials(fullName, email), [email, fullName]);
  const backgroundColor = useMemo(() => getAvatarColor(fullName || email), [email, fullName]);

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={`${fullName || email} avatar`}
        className="h-20 w-20 rounded-full border border-border object-cover"
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <div
      className="flex h-20 w-20 items-center justify-center rounded-full text-lg font-semibold text-white"
      style={{ backgroundColor }}
      aria-label={`${fullName || email} initials avatar`}
    >
      {initials || <UserIcon size={24} />}
    </div>
  );
}

function PasswordSection({ isEmailAccount }: { isEmailAccount: boolean }) {
  const { success, error: showError } = useGlobalToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPasswordError(null);

    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters long.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError('New password and confirmation do not match.');
      return;
    }

    if (!currentPassword) {
      setPasswordError('Enter your current password to confirm this change.');
      return;
    }

    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword }, {
        emailRedirectTo: window.location.origin,
      });

      if (error) {
        throw error;
      }

      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      success('Password updated successfully.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update password.';
      setPasswordError(message);
      showError(message);
    } finally {
      setSaving(false);
    }
  };

  if (!isEmailAccount) {
    return (
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-text">Password</h3>
        <div className="rounded-lg border border-border bg-panel px-4 py-3 text-sm text-muted">
          Account managed via GitHub. Change your password in your GitHub account settings.
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text">Password</h3>
        <p className="mt-1 text-xs text-muted">Update your password for this email account.</p>
      </div>

      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted" htmlFor="current-password">Current password</label>
          <input
            id="current-password"
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            className="w-full rounded-lg border border-border bg-panel px-3 py-2 text-sm text-text outline-none transition focus:border-accent"
            autoComplete="current-password"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted" htmlFor="new-password">New password</label>
          <input
            id="new-password"
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            className="w-full rounded-lg border border-border bg-panel px-3 py-2 text-sm text-text outline-none transition focus:border-accent"
            autoComplete="new-password"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted" htmlFor="confirm-password">Confirm new password</label>
          <input
            id="confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            className="w-full rounded-lg border border-border bg-panel px-3 py-2 text-sm text-text outline-none transition focus:border-accent"
            autoComplete="new-password"
          />
        </div>

        {passwordError ? <p className="text-sm text-red-500">{passwordError}</p> : null}

        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          Change password
        </button>
      </form>
    </section>
  );
}

function DeleteAccountSection({ email }: { email: string }) {
  const { success, error: showError } = useGlobalToast();
  const [isOpen, setIsOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const isConfirmationValid = confirmation === 'DELETE' || confirmation === email;

  const closeModal = () => {
    if (submitting) return;
    setIsOpen(false);
    setConfirmation('');
    setDeleteError(null);
  };

  const handleDelete = async () => {
    if (!isConfirmationValid) {
      setDeleteError('Type DELETE or your email address to confirm account deletion.');
      return;
    }

    setSubmitting(true);
    setDeleteError(null);

    try {
      await apiFetch<DeleteAccountResponse>('/api/users/me', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation }),
      });

      await supabase.auth.signOut();
      clearTokens();
      success('Your account has been deleted.');
      window.location.assign('/');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete account.';
      setDeleteError(message);
      showError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="space-y-4 pt-2">
      <div>
        <h3 className="text-sm font-semibold text-red-500">Delete account</h3>
        <p className="mt-1 text-xs text-muted">
          Permanently remove your account and profile data. This action cannot be undone.
        </p>
      </div>

      <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 shrink-0 text-red-500" size={18} />
          <div className="space-y-3">
            <p className="text-sm text-text">
              This deletes your Supabase account and signs you out of Rorca.
            </p>
            <button
              type="button"
              onClick={() => setIsOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-red-500/40 px-4 py-2 text-sm font-medium text-red-500 transition hover:bg-red-500/10"
            >
              <Trash2 size={16} />
              Delete account
            </button>
          </div>
        </div>
      </div>

      <AnimatedModal isOpen={isOpen} onClose={closeModal} closeOnBackdropClick={!submitting}>
        <div className="w-[min(92vw,28rem)] rounded-xl border border-border bg-panel shadow-xl">
          <div className="border-b border-border px-6 py-4">
            <h4 className="text-base font-semibold text-text">Confirm account deletion</h4>
            <p className="mt-1 text-sm text-muted">Type `DELETE` or `{email}` to continue.</p>
          </div>

          <div className="space-y-4 px-6 py-5">
            <input
              type="text"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder="DELETE"
              className="w-full rounded-lg border border-border bg-panel px-3 py-2 text-sm text-text outline-none transition focus:border-red-500"
              autoFocus
            />

            {deleteError ? <p className="text-sm text-red-500">{deleteError}</p> : null}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={closeModal}
                disabled={submitting}
                className="rounded-lg border border-border px-4 py-2 text-sm text-text transition hover:bg-bg disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={!isConfirmationValid || submitting}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                Permanently delete
              </button>
            </div>
          </div>
        </div>
      </AnimatedModal>
    </section>
  );
}

export function AccountSettingsTab() {
  const { user } = useAuth();
  const { success, error: showError } = useGlobalToast();
  const [displayName, setDisplayName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);

  useEffect(() => {
    setDisplayName((user?.user_metadata?.full_name as string | undefined) ?? '');
  }, [user]);

  const email = user?.email ?? '';
  const avatarUrl = (user?.user_metadata?.avatar_url as string | undefined) ?? null;
  const provider = (user?.app_metadata?.provider as string | undefined) ?? 'email';
  const isEmailAccount = provider === 'email';
  const hasProfileChanges = displayName.trim() !== ((user?.user_metadata?.full_name as string | undefined) ?? '').trim();

  const handleProfileSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNameError(null);

    if (!displayName.trim()) {
      setNameError('Display name is required.');
      return;
    }

    setSavingProfile(true);
    try {
      const { error } = await supabase.auth.updateUser({
        data: { full_name: displayName.trim() },
      });

      if (error) {
        throw error;
      }

      success('Profile updated successfully.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update profile.';
      setNameError(message);
      showError(message);
    } finally {
      setSavingProfile(false);
    }
  };

  if (!user) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" />
        Loading account settings...
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <section className="space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-text">Profile</h2>
          <p className="mt-1 text-xs text-muted">Manage your account profile and sign-in details.</p>
        </div>

        <div className="rounded-xl border border-border bg-panel p-4 sm:p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <ProfileAvatar avatarUrl={avatarUrl} fullName={displayName} email={email} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold text-text">{displayName || email}</p>
              <p className="truncate text-sm text-muted">{email}</p>
              <p className="mt-1 text-xs text-muted">
                Signed in with {provider === 'github' ? 'GitHub' : 'email and password'}.
              </p>
            </div>
          </div>
        </div>

        <form className="space-y-4" onSubmit={handleProfileSave}>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted" htmlFor="account-display-name">Display name</label>
            <input
              id="account-display-name"
              type="text"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="w-full rounded-lg border border-border bg-panel px-3 py-2 text-sm text-text outline-none transition focus:border-accent"
              placeholder="Your name"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted" htmlFor="account-email">Email</label>
            <input
              id="account-email"
              type="email"
              value={email}
              readOnly
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-muted outline-none"
            />
          </div>

          {nameError ? <p className="text-sm text-red-500">{nameError}</p> : null}

          <button
            type="submit"
            disabled={!hasProfileChanges || savingProfile}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {savingProfile ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            Save changes
          </button>
        </form>
      </section>

      <div className="border-t border-border pt-6">
        <PasswordSection isEmailAccount={isEmailAccount} />
      </div>

      <div className="border-t border-border pt-6">
        <DeleteAccountSection email={email} />
      </div>
    </div>
  );
}
