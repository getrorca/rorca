import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import RorcaLogo from '../../components/RorcaLogo';
import { useGlobalToast } from '../../contexts/ToastContext';
import { supabase } from '../../lib/supabase';

const MIN_PASSWORD_LENGTH = 8;

function getHashTokens() {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const params = new URLSearchParams(hash);
  return {
    accessToken: params.get('access_token') ?? '',
    refreshToken: params.get('refresh_token') ?? '',
  };
}

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const { success, error: showError } = useGlobalToast();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inlineError, setInlineError] = useState('');
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const [initializing, setInitializing] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const passwordTooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const passwordsMismatch = confirmPassword.length > 0 && password !== confirmPassword;
  const isSubmitDisabled = useMemo(
    () => !sessionReady || submitting || password.length < MIN_PASSWORD_LENGTH || password !== confirmPassword,
    [password, confirmPassword, sessionReady, submitting],
  );

  useEffect(() => {
    let isMounted = true;

    async function initializeSession() {
      const { accessToken, refreshToken } = getHashTokens();

      if (!accessToken || !refreshToken) {
        if (!isMounted) return;
        const message = 'Reset link is invalid or expired. Request a new password reset email.';
        setSessionError(message);
        setInitializing(false);
        showError(message);
        window.setTimeout(() => navigate('/auth/forgot-password', { replace: true }), 1200);
        return;
      }

      const { error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
      });

      if (!isMounted) return;

      if (error) {
        const message = error.message || 'Reset link is invalid or expired. Request a new password reset email.';
        setSessionError(message);
        showError(message);
        setInitializing(false);
        window.setTimeout(() => navigate('/auth/forgot-password', { replace: true }), 1200);
        return;
      }

      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      setSessionReady(true);
      setInitializing(false);
    }

    void initializeSession();

    return () => {
      isMounted = false;
    };
  }, [navigate, showError]);

  function validateForm(): string {
    if (password.length < MIN_PASSWORD_LENGTH) {
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    }
    if (password !== confirmPassword) {
      return 'Passwords do not match';
    }
    return '';
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextError = validateForm();
    setInlineError(nextError);
    if (nextError) return;

    setSubmitting(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });

      if (error) {
        throw error;
      }

      success('Password updated successfully');
      navigate('/', { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to update password';
      showError(message || 'Unable to update password');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-bg px-4 py-8 sm:flex sm:items-center sm:justify-center">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <RorcaLogo size={48} variant="gradient" className="mb-3" />
          <h1 className="font-mono text-2xl font-bold tracking-tight text-[var(--text)]">Rorca</h1>
          <p className="mt-1 text-sm text-muted">AI spec orchestration</p>
        </div>

        <div className="rounded-lg border border-border bg-panel p-6">
          <h2 className="mb-2 text-lg font-semibold text-[var(--text)]">Reset password</h2>
          <p className="mb-6 text-sm text-muted">Choose a new password for your account.</p>

          {initializing ? (
            <div className="flex items-center gap-2 rounded border border-border bg-bg px-3 py-2 text-sm text-muted">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-muted/30 border-t-muted" />
              Verifying reset link...
            </div>
          ) : sessionError ? (
            <div className="rounded border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
              {sessionError}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="reset-password" className="mb-1 block text-sm text-muted">
                  New password
                </label>
                <input
                  id="reset-password"
                  type="password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    if (inlineError) {
                      setInlineError('');
                    }
                  }}
                  autoComplete="new-password"
                  required
                  placeholder="Minimum 8 characters"
                  className="w-full rounded border border-border bg-bg px-3 py-2 text-sm text-[var(--text)] placeholder:text-muted/50 focus:border-accent focus:outline-none transition-colors"
                />
                {passwordTooShort ? (
                  <p className="mt-1 text-sm text-error">Password must be at least 8 characters</p>
                ) : null}
              </div>

              <div>
                <label htmlFor="reset-confirm-password" className="mb-1 block text-sm text-muted">
                  Confirm password
                </label>
                <input
                  id="reset-confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => {
                    setConfirmPassword(event.target.value);
                    if (inlineError) {
                      setInlineError('');
                    }
                  }}
                  autoComplete="new-password"
                  required
                  placeholder="Re-enter your password"
                  className="w-full rounded border border-border bg-bg px-3 py-2 text-sm text-[var(--text)] placeholder:text-muted/50 focus:border-accent focus:outline-none transition-colors"
                />
                {passwordsMismatch ? (
                  <p className="mt-1 text-sm text-error">Passwords do not match</p>
                ) : null}
              </div>

              {inlineError ? <p className="text-sm text-error">{inlineError}</p> : null}

              <button
                type="submit"
                disabled={isSubmitDisabled}
                className="flex w-full items-center justify-center rounded bg-accent py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Updating password...
                  </span>
                ) : 'Update password'}
              </button>
            </form>
          )}
        </div>

        <p className="mt-4 text-center text-sm text-muted">
          <Link to="/auth/login" className="text-accent transition-colors hover:text-accent-hover">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
