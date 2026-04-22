import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import RorcaLogo from './RorcaLogo';

interface LoginPageProps {
  onSwitchToRegister?: () => void;
  onSwitchToForgotPassword: () => void;
}

export default function LoginPage({ onSwitchToForgotPassword }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        throw signInError;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      setError(message || 'Invalid email or password');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <RorcaLogo size={48} variant="gradient" className="mb-3" />
          <h1 className="font-mono font-bold text-[var(--text)] text-2xl tracking-tight">Rorca</h1>
          <p className="text-muted text-sm mt-1">AI spec orchestration</p>
        </div>

        {/* Card */}
        <div className="bg-panel border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-[var(--text)] mb-6">Sign in</h2>

          {error && (
            <div className="mb-4 px-3 py-2 rounded bg-error/10 border border-error/30 text-error text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="login-email" className="block text-sm text-muted mb-1">
                Email
              </label>
              <input
                id="login-email"
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

            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="login-password" className="block text-sm text-muted">
                  Password
                </label>
                <button
                  type="button"
                  onClick={onSwitchToForgotPassword}
                  className="text-xs text-accent hover:text-accent-hover transition-colors"
                >
                  Forgot password?
                </button>
              </div>
              <input
                id="login-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full px-3 py-2 rounded bg-bg border border-border text-[var(--text)] text-sm
                  placeholder:text-muted/50 focus:outline-none focus:border-accent transition-colors"
                placeholder="Enter your password"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2 rounded bg-accent text-white text-sm font-medium
                hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Signing in...' : 'Sign in'}
            </button>
          </form>

        </div>
      </div>
    </div>
  );
}
