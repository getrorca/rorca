import { useState, type FormEvent } from 'react';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ForgotPasswordPageProps {
  onSwitchToLogin: () => void;
}

export default function ForgotPasswordPage({ onSwitchToLogin }: ForgotPasswordPageProps) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [resetLink, setResetLink] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');
    setResetLink('');

    const trimmed = email.trim();
    if (!trimmed) {
      setError('Email is required');
      return;
    }
    if (!EMAIL_REGEX.test(trimmed)) {
      setError('Invalid email format');
      return;
    }

    setSubmitting(true);
    try {
      const resp = await fetch('http://localhost:3030/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        setError(data.error || 'Something went wrong. Please try again.');
        return;
      }

      setSuccess(data.message);
      if (data.resetLink) {
        setResetLink(data.resetLink);
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="font-mono font-bold text-accent text-2xl tracking-tight">rorcha</h1>
          <p className="text-muted text-sm mt-1">AI spec orchestration</p>
        </div>

        {/* Card */}
        <div className="bg-panel border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-[var(--text)] mb-2">Reset password</h2>
          <p className="text-muted text-sm mb-6">
            Enter your email address and we'll send you a link to reset your password.
          </p>

          {error && (
            <div className="mb-4 px-3 py-2 rounded bg-error/10 border border-error/30 text-error text-sm">
              {error}
            </div>
          )}

          {success && (
            <div className="mb-4 px-3 py-2 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-sm">
              {success}
              {resetLink && (
                <div className="mt-2">
                  <span className="text-muted text-xs block mb-1">Dev mode — reset link:</span>
                  <a
                    href={resetLink}
                    className="text-accent hover:text-accent-hover text-xs break-all"
                  >
                    {resetLink}
                  </a>
                </div>
              )}
            </div>
          )}

          {!success && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label htmlFor="forgot-email" className="block text-sm text-muted mb-1">
                  Email
                </label>
                <input
                  id="forgot-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  className="w-full px-3 py-2 rounded bg-bg border border-border text-[var(--text)] text-sm
                    placeholder:text-muted/50 focus:outline-none focus:border-accent transition-colors"
                  placeholder="you@example.com"
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2 rounded bg-accent text-white text-sm font-medium
                  hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Sending...' : 'Send reset link'}
              </button>
            </form>
          )}
        </div>

        {/* Footer link */}
        <p className="text-center text-sm text-muted mt-4">
          <button
            type="button"
            onClick={onSwitchToLogin}
            className="text-accent hover:text-accent-hover transition-colors"
          >
            Back to sign in
          </button>
        </p>
      </div>
    </div>
  );
}
