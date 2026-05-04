/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';

function getSafeReturnTo(value: string | null): string {
  if (!value) return '/';
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//')) return '/';
  return value;
}

function getOAuthErrorMessage(params: URLSearchParams): string | null {
  const error = params.get('error');
  const errorCode = params.get('error_code');
  const errorDescription = params.get('error_description');

  if (error === 'access_denied') {
    return 'Sign-in was cancelled.';
  }

  if (error === 'invalid_request' || errorCode === 'otp_expired') {
    return 'Sign-in link expired or is invalid. Please try again.';
  }

  if (error === 'server_error') {
    return 'Network error while completing sign-in. Please try again.';
  }

  if (errorDescription) {
    const normalized = errorDescription.toLowerCase();
    if (normalized.includes('state')) {
      return 'Security check failed. Please try again.';
    }
    if (normalized.includes('network') || normalized.includes('fetch')) {
      return 'Network error while completing sign-in. Please try again.';
    }
    return errorDescription;
  }

  if (error) {
    return 'Unable to complete sign-in. Please try again.';
  }

  return null;
}

export default function AuthCallbackPage() {
  const navigate = useNavigate();

  useEffect(() => {
    let isActive = true;

    const completeAuth = async () => {
      const url = new URL(window.location.href);
      const params = url.searchParams;
      const returnTo = getSafeReturnTo(params.get('returnTo'));
      const oauthError = getOAuthErrorMessage(params);

      if (oauthError) {
        navigate(`/auth/login?error=${encodeURIComponent(oauthError)}`, { replace: true });
        return;
      }

      try {
        const { error } = await supabase.auth.exchangeCodeForSession(window.location.href);

        if (!isActive) return;

        if (error) {
          const message = error.message.toLowerCase().includes('state')
            ? 'Security check failed. Please try again.'
            : error.message.toLowerCase().includes('network')
              ? 'Network error while completing sign-in. Please try again.'
              : error.message;
          navigate(`/auth/login?error=${encodeURIComponent(message)}`, { replace: true });
          return;
        }

        navigate(returnTo, { replace: true });
      } catch (error) {
        if (!isActive) return;
        const message = error instanceof Error
          ? (error.message.toLowerCase().includes('network')
            ? 'Network error while completing sign-in. Please try again.'
            : error.message.toLowerCase().includes('state')
              ? 'Security check failed. Please try again.'
              : error.message)
          : 'Unable to complete sign-in. Please try again.';
        navigate(`/auth/login?error=${encodeURIComponent(message)}`, { replace: true });
      }
    };

    void completeAuth();

    return () => {
      isActive = false;
    };
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-[var(--border)] border-t-[var(--accent)]" aria-hidden="true" />
        <div className="space-y-1">
          <h1 className="text-base font-medium text-[var(--text)]">Completing sign-in...</h1>
          <p className="text-sm text-[var(--muted)]">Please wait while we finish your authentication.</p>
        </div>
      </div>
    </div>
  );
}
