import { useState, type FormEvent } from 'react';

interface ResetPasswordPageProps {
  token: string;
  onSwitchToLogin: () => void;
}

export default function ResetPasswordPage({ token, onSwitchToLogin }: ResetPasswordPageProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (!password) {
      setError('Password is required');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setSubmitting(true);
    try {
      const resp = await fetch('http://localhost:3030/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: password }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        setError(data.error || 'Something went wrong. Please try again.');
        return;
      }

      setSuccess(true);
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
          {success ? (
            <>
              <h2 className="text-lg font-semibold text-[var(--text)] mb-4">Password reset</h2>
              <div className="mb-4 px-3 py-2 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-sm">
                Your password has been reset successfully.
              </div>
              <button
                type="button"
                onClick={onSwitchToLogin}
                className="w-full py-2 rounded bg-accent text-white text-sm font-medium
                  hover:bg-accent-hover transition-colors"
              >
                Sign in with new password
              </button>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold text-[var(--text)] mb-2">Set new password</h2>
              <p className="text-muted text-sm mb-6">
                Enter your new password below.
              </p>

              {error && (
                <div className="mb-4 px-3 py-2 rounded bg-error/10 border border-error/30 text-error text-sm">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="reset-password" className="block text-sm text-muted mb-1">
                    New password
                  </label>
                  <input
                    id="reset-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    className="w-full px-3 py-2 rounded bg-bg border border-border text-[var(--text)] text-sm
                      placeholder:text-muted/50 focus:outline-none focus:border-accent transition-colors"
                    placeholder="Minimum 8 characters"
                  />
                </div>

                <div>
                  <label htmlFor="reset-confirm" className="block text-sm text-muted mb-1">
                    Confirm password
                  </label>
                  <input
                    id="reset-confirm"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    className="w-full px-3 py-2 rounded bg-bg border border-border text-[var(--text)] text-sm
                      placeholder:text-muted/50 focus:outline-none focus:border-accent transition-colors"
                    placeholder="Re-enter your password"
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full py-2 rounded bg-accent text-white text-sm font-medium
                    hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting ? 'Resetting...' : 'Reset password'}
                </button>
              </form>
            </>
          )}
        </div>

        {!success && (
          <p className="text-center text-sm text-muted mt-4">
            <button
              type="button"
              onClick={onSwitchToLogin}
              className="text-accent hover:text-accent-hover transition-colors"
            >
              Back to sign in
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
