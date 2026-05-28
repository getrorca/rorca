/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import RorcaLogo from '../../components/RorcaLogo';

function getSafeReturnTo(value: string | null): string {
  if (!value) return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//')) return '/';
  return value;
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
    />
  );
}

export default function LoginPage() {
  const { isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [githubLoading, setGitHubLoading] = useState(false);
  const [error, setError] = useState('');

  const returnTo = getSafeReturnTo(searchParams.get('returnTo'));

  useEffect(() => {
    if (isAuthenticated) {
      navigate(returnTo, { replace: true });
    }
  }, [isAuthenticated, navigate, returnTo]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setLoading(true);

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        throw signInError;
      }

      navigate(returnTo, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid login credentials');
    } finally {
      setLoading(false);
    }
  }

  async function handleGitHubSignIn() {
    setError('');
    setGitHubLoading(true);

    try {
      const redirectParams = new URLSearchParams();
      if (returnTo !== '/') {
        redirectParams.set('returnTo', returnTo);
      }

      const redirectSuffix = redirectParams.toString();
      const redirectTo = `${window.location.origin}/auth/callback${redirectSuffix ? `?${redirectSuffix}` : ''}`;

      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: { redirectTo },
      });

      if (oauthError) {
        throw oauthError;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start GitHub sign-in');
      setGitHubLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-gray-900 px-4 py-10 text-white">
      <div className="w-full max-w-sm">
        <div className="w-full rounded-xl border border-gray-800 bg-gray-900 shadow-2xl shadow-black/30">
          <div className="px-6 pt-8 text-center">
            <RorcaLogo size={48} variant="gradient" className="mx-auto mb-3" />
            <h1 className="font-mono text-2xl font-bold tracking-tight text-white">Rorca</h1>
            <p className="mt-1 text-sm text-gray-400">Sign in to continue</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4 px-6 py-8">
            <button
              type="button"
              onClick={handleGitHubSignIn}
              disabled={loading || githubLoading}
              aria-label="Continue with GitHub"
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-750 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {githubLoading ? <Spinner /> : null}
              <span>{githubLoading ? 'Redirecting to GitHub...' : 'Continue with GitHub'}</span>
            </button>

            <div className="relative">
              <div className="absolute inset-0 flex items-center" aria-hidden="true">
                <div className="w-full border-t border-gray-800" />
              </div>
              <div className="relative flex justify-center text-xs uppercase tracking-wide text-gray-500">
                <span className="bg-gray-900 px-2">Or continue with email</span>
              </div>
            </div>

            <div>
              <label htmlFor="login-email" className="mb-1 block text-sm text-gray-300">
                Email
              </label>
              <input
                id="login-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-white placeholder-gray-500 focus:border-gray-500 focus:outline-none"
              />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between gap-3">
                <label htmlFor="login-password" className="block text-sm text-gray-300">
                  Password
                </label>
                <Link
                  to="/auth/forgot-password"
                  className="text-sm text-gray-400 transition-colors hover:text-white"
                >
                  Forgot password?
                </Link>
              </div>
              <input
                id="login-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 text-white placeholder-gray-500 focus:border-gray-500 focus:outline-none"
              />
            </div>

            {error && <div className="text-sm text-red-400">{error}</div>}

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-gray-900 transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? <Spinner /> : null}
              <span>{loading ? 'Signing in...' : 'Sign in'}</span>
            </button>

            <p className="text-center text-sm text-gray-400">
              Don&apos;t have an account?{' '}
              <Link to="/auth/register" className="text-white transition-colors hover:text-gray-300">
                Create account
              </Link>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
