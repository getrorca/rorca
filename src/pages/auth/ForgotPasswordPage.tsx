import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import RorcaLogo from '../../components/RorcaLogo';
import { useGlobalToast } from '../../contexts/ToastContext';
import { supabase } from '../../lib/supabase';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ForgotPasswordPage() {
  const { success, error: showError } = useGlobalToast();
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const trimmedEmail = useMemo(() => email.trim(), [email]);

  function validateEmail(value: string): string {
    if (!value) return 'Email is required';
    if (!EMAIL_REGEX.test(value)) return 'Enter a valid email address';
    return '';
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextError = validateEmail(trimmedEmail);
    setFieldError(nextError);
    if (nextError) return;

    setSubmitting(true);
    try {
      const redirectTo = `${window.location.origin}/auth/reset-password`;
      const { error } = await supabase.auth.resetPasswordForEmail(trimmedEmail, { redirectTo });

      if (error) {
        throw error;
      }

      setSubmitted(true);
      success('Password reset email sent — check your inbox');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to send reset email';
      showError(message || 'Unable to send reset email');
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
          <h2 className="mb-2 text-lg font-semibold text-[var(--text)]">Forgot password</h2>
          <p className="mb-6 text-sm text-muted">
            Enter your email address and we&apos;ll send you a link to reset your password.
          </p>

          {submitted ? (
            <div className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">
              Password reset email sent — check your inbox
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="forgot-password-email" className="mb-1 block text-sm text-muted">
                  Email
                </label>
                <input
                  id="forgot-password-email"
                  type="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    if (fieldError) {
                      setFieldError(validateEmail(event.target.value.trim()));
                    }
                  }}
                  autoComplete="email"
                  required
                  placeholder="you@example.com"
                  className="w-full rounded border border-border bg-bg px-3 py-2 text-sm text-[var(--text)] placeholder:text-muted/50 focus:border-accent focus:outline-none transition-colors"
                />
                {fieldError ? <p className="mt-1 text-sm text-error">{fieldError}</p> : null}
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="flex w-full items-center justify-center rounded bg-accent py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Sending reset link...
                  </span>
                ) : 'Send reset link'}
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
