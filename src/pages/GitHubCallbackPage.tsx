import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';

/**
 * GitHub OAuth callback page.
 *
 * The backend redirects here after a successful OAuth exchange:
 *   /auth/github/callback#accessToken=...&refreshToken=...
 *
 * For error cases (access denied, CSRF mismatch, etc.) the backend uses query params:
 *   /auth/github/callback?error=github_denied
 *
 * This page shows "Completing GitHub sign-in..." while processing, then
 * navigates to / on success or displays an error message on failure.
 */
export default function GitHubCallbackPage() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.slice(1));

    // Check query param errors (user denied, CSRF failure, etc.)
    const qError = params.get('error');
    if (qError) {
      const messages: Record<string, string> = {
        github_denied: 'GitHub sign-in was cancelled.',
        invalid_state: 'Security check failed. Please try again.',
        missing_code: 'Authorization code missing. Please try again.',
        token_exchange_failed: 'Failed to complete GitHub sign-in. Please try again.',
        no_verified_email: 'Your GitHub account has no verified email address.',
        github_error: 'An unexpected error occurred. Please try again.',
        github_not_configured: 'GitHub sign-in is not configured on this server.',
      };
      setError(messages[qError] ?? 'GitHub sign-in failed. Please try again.');
      // Clean up URL
      window.history.replaceState(null, '', '/');
      return;
    }

    // Check hash fragment errors (legacy path)
    const hashError = hashParams.get('error');
    if (hashError) {
      setError(decodeURIComponent(hashError));
      window.history.replaceState(null, '', '/');
      return;
    }

    // Extract tokens from hash fragment
    const accessToken = hashParams.get('accessToken');
    const refreshToken = hashParams.get('refreshToken');

    // Clean up URL immediately to prevent token leakage
    window.history.replaceState(null, '', '/');

    if (!accessToken || !refreshToken) {
      setError('GitHub sign-in failed: tokens not received.');
      return;
    }

    void supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
      .then(({ error: sessionError }) => {
        if (sessionError) {
          throw sessionError;
        }

        const returnTo = sessionStorage.getItem('github_oauth_return') || '/';
        sessionStorage.removeItem('github_oauth_return');
        navigate(returnTo, { replace: true });
      })
      .catch(() => {
        setError('Session validation failed. Please try signing in again.');
      });
  }, [navigate]);

  if (error) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        gap: '16px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#ef4444',
      }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <p style={{ margin: 0, fontSize: '15px' }}>{error}</p>
        <button
          onClick={() => navigate('/', { replace: true })}
          style={{
            padding: '8px 16px',
            background: '#1f2937',
            color: '#f9fafb',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '14px',
          }}
        >
          Back to Rorca
        </button>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      gap: '16px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      color: '#6b7280',
    }}>
      {/* Spinner */}
      <svg
        width="32"
        height="32"
        viewBox="0 0 32 32"
        fill="none"
        style={{ animation: 'spin 0.8s linear infinite' }}
      >
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <circle
          cx="16"
          cy="16"
          r="13"
          stroke="#e5e7eb"
          strokeWidth="3"
        />
        <path
          d="M16 3 A13 13 0 0 1 29 16"
          stroke="#6366f1"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      <p style={{ margin: 0, fontSize: '15px' }}>Completing GitHub sign-in...</p>
    </div>
  );
}
