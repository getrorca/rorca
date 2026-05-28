/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import RorcaLogo from '../../components/RorcaLogo';

interface FieldErrors {
  email?: string;
  password?: string;
  confirmPassword?: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function RegisterPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState('');
  const [confirmationMessage, setConfirmationMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function validateForm(): FieldErrors {
    const nextErrors: FieldErrors = {};
    const trimmedEmail = email.trim();

    if (!trimmedEmail) {
      nextErrors.email = 'Email is required';
    } else if (!EMAIL_REGEX.test(trimmedEmail)) {
      nextErrors.email = 'Enter a valid email address';
    }

    if (!password) {
      nextErrors.password = 'Password is required';
    } else if (password.length < 8) {
      nextErrors.password = 'Password must be at least 8 characters';
    }

    if (!confirmPassword) {
      nextErrors.confirmPassword = 'Please confirm your password';
    } else if (password !== confirmPassword) {
      nextErrors.confirmPassword = 'Passwords do not match';
    }

    return nextErrors;
  }

  function clearFieldError(field: keyof FieldErrors) {
    setFieldErrors((current) => {
      if (!current[field]) {
        return current;
      }
      return { ...current, [field]: undefined };
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setConfirmationMessage('');

    const nextErrors = validateForm();
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setSubmitting(true);
    const { data, error: signUpError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
    });
    setSubmitting(false);

    if (signUpError) {
      setError(signUpError.message || 'Unable to create account');
      return;
    }

    if (data.session !== null) {
      navigate('/');
      return;
    }

    setConfirmationMessage('Check your email for a confirmation link');
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center">
          <RorcaLogo size={48} variant="gradient" className="mb-3" />
          <h1 className="font-mono text-2xl font-bold tracking-tight text-[var(--text)]">Rorca</h1>
          <p className="mt-1 text-sm text-muted">AI spec orchestration</p>
        </div>

        <div className="rounded-lg border border-border bg-panel p-6">
          <h2 className="mb-6 text-lg font-semibold text-[var(--text)]">Create account</h2>

          {confirmationMessage ? (
            <div className="space-y-4">
              <div className="rounded border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-[var(--text)]">
                {confirmationMessage}
              </div>
              <p className="text-sm text-muted">
                Already have an account?{' '}
                <Link to="/auth/login" className="text-accent transition-colors hover:text-accent-hover">
                  Sign in
                </Link>
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <div>
                <label htmlFor="register-email" className="mb-1 block text-sm text-muted">
                  Email
                </label>
                <input
                  id="register-email"
                  type="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    clearFieldError('email');
                  }}
                  autoComplete="email"
                  aria-describedby={fieldErrors.email ? 'register-email-error' : undefined}
                  className={`w-full rounded border bg-bg px-3 py-2 text-sm text-[var(--text)] placeholder:text-muted/50 focus:outline-none transition-colors ${fieldErrors.email ? 'border-error focus:border-error' : 'border-border focus:border-accent'}`}
                  placeholder="you@example.com"
                />
                {fieldErrors.email && (
                  <p id="register-email-error" className="mt-1 text-xs text-error">
                    {fieldErrors.email}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="register-password" className="mb-1 block text-sm text-muted">
                  Password
                </label>
                <input
                  id="register-password"
                  type="password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    clearFieldError('password');
                    clearFieldError('confirmPassword');
                  }}
                  autoComplete="new-password"
                  aria-describedby={fieldErrors.password ? 'register-password-error' : undefined}
                  className={`w-full rounded border bg-bg px-3 py-2 text-sm text-[var(--text)] placeholder:text-muted/50 focus:outline-none transition-colors ${fieldErrors.password ? 'border-error focus:border-error' : 'border-border focus:border-accent'}`}
                  placeholder="Create a password"
                />
                {fieldErrors.password && (
                  <p id="register-password-error" className="mt-1 text-xs text-error">
                    {fieldErrors.password}
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="register-confirm-password" className="mb-1 block text-sm text-muted">
                  Confirm password
                </label>
                <input
                  id="register-confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => {
                    setConfirmPassword(event.target.value);
                    clearFieldError('confirmPassword');
                  }}
                  autoComplete="new-password"
                  aria-describedby={fieldErrors.confirmPassword ? 'register-confirm-password-error' : undefined}
                  className={`w-full rounded border bg-bg px-3 py-2 text-sm text-[var(--text)] placeholder:text-muted/50 focus:outline-none transition-colors ${fieldErrors.confirmPassword ? 'border-error focus:border-error' : 'border-border focus:border-accent'}`}
                  placeholder="Confirm your password"
                />
                {fieldErrors.confirmPassword && (
                  <p id="register-confirm-password-error" className="mt-1 text-xs text-error">
                    {fieldErrors.confirmPassword}
                  </p>
                )}
              </div>

              {error && (
                <p className="text-sm text-error" role="alert">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="flex w-full items-center justify-center rounded bg-accent py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : 'Create account'}
              </button>

              <p className="text-sm text-muted">
                Already have an account?{' '}
                <Link to="/auth/login" className="text-accent transition-colors hover:text-accent-hover">
                  Sign in
                </Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
