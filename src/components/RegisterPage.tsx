import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import RorcaLogo from './RorcaLogo';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface RegisterPageProps {
  onSwitchToLogin: () => void;
}

interface FieldErrors {
  email?: string;
  password?: string;
  confirmPassword?: string;
  displayName?: string;
}

export default function RegisterPage({ onSwitchToLogin }: RegisterPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};

    if (!email.trim()) {
      errors.email = 'Email is required';
    } else if (!EMAIL_REGEX.test(email.trim())) {
      errors.email = 'Invalid email format';
    }

    if (!password) {
      errors.password = 'Password is required';
    } else if (password.length < 8) {
      errors.password = 'Password must be at least 8 characters';
    }

    if (!confirmPassword) {
      errors.confirmPassword = 'Please confirm your password';
    } else if (password !== confirmPassword) {
      errors.confirmPassword = 'Passwords do not match';
    }

    if (!displayName.trim()) {
      errors.displayName = 'Display name is required';
    }

    return errors;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setServerError('');

    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    try {
      const { error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            display_name: displayName.trim(),
          },
        },
      });

      if (signUpError) {
        throw signUpError;
      }

      onSwitchToLogin();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Registration failed';
      setServerError(message || 'Registration failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // Clear field error on change
  function handleFieldChange(field: keyof FieldErrors, value: string) {
    if (fieldErrors[field]) {
      setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
    }
    switch (field) {
      case 'email': setEmail(value); break;
      case 'password': setPassword(value); break;
      case 'confirmPassword': setConfirmPassword(value); break;
      case 'displayName': setDisplayName(value); break;
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
          <h2 className="text-lg font-semibold text-[var(--text)] mb-6">Create account</h2>

          {serverError && (
            <div className="mb-4 px-3 py-2 rounded bg-error/10 border border-error/30 text-error text-sm">
              {serverError}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Display Name */}
            <div>
              <label htmlFor="register-name" className="block text-sm text-muted mb-1">
                Display name
              </label>
              <input
                id="register-name"
                type="text"
                value={displayName}
                onChange={(e) => handleFieldChange('displayName', e.target.value)}
                autoComplete="name"
                className={`w-full px-3 py-2 rounded bg-bg border text-[var(--text)] text-sm
                  placeholder:text-muted/50 focus:outline-none transition-colors
                  ${fieldErrors.displayName ? 'border-error focus:border-error' : 'border-border focus:border-accent'}`}
                placeholder="Your name"
              />
              {fieldErrors.displayName && (
                <p className="text-error text-xs mt-1">{fieldErrors.displayName}</p>
              )}
            </div>

            {/* Email */}
            <div>
              <label htmlFor="register-email" className="block text-sm text-muted mb-1">
                Email
              </label>
              <input
                id="register-email"
                type="email"
                value={email}
                onChange={(e) => handleFieldChange('email', e.target.value)}
                autoComplete="email"
                className={`w-full px-3 py-2 rounded bg-bg border text-[var(--text)] text-sm
                  placeholder:text-muted/50 focus:outline-none transition-colors
                  ${fieldErrors.email ? 'border-error focus:border-error' : 'border-border focus:border-accent'}`}
                placeholder="you@example.com"
              />
              {fieldErrors.email && (
                <p className="text-error text-xs mt-1">{fieldErrors.email}</p>
              )}
            </div>

            {/* Password */}
            <div>
              <label htmlFor="register-password" className="block text-sm text-muted mb-1">
                Password
              </label>
              <input
                id="register-password"
                type="password"
                value={password}
                onChange={(e) => handleFieldChange('password', e.target.value)}
                autoComplete="new-password"
                className={`w-full px-3 py-2 rounded bg-bg border text-[var(--text)] text-sm
                  placeholder:text-muted/50 focus:outline-none transition-colors
                  ${fieldErrors.password ? 'border-error focus:border-error' : 'border-border focus:border-accent'}`}
                placeholder="Minimum 8 characters"
              />
              {fieldErrors.password && (
                <p className="text-error text-xs mt-1">{fieldErrors.password}</p>
              )}
            </div>

            {/* Confirm Password */}
            <div>
              <label htmlFor="register-confirm" className="block text-sm text-muted mb-1">
                Confirm password
              </label>
              <input
                id="register-confirm"
                type="password"
                value={confirmPassword}
                onChange={(e) => handleFieldChange('confirmPassword', e.target.value)}
                autoComplete="new-password"
                className={`w-full px-3 py-2 rounded bg-bg border text-[var(--text)] text-sm
                  placeholder:text-muted/50 focus:outline-none transition-colors
                  ${fieldErrors.confirmPassword ? 'border-error focus:border-error' : 'border-border focus:border-accent'}`}
                placeholder="Re-enter your password"
              />
              {fieldErrors.confirmPassword && (
                <p className="text-error text-xs mt-1">{fieldErrors.confirmPassword}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2 rounded bg-accent text-white text-sm font-medium
                hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Creating account...' : 'Create account'}
            </button>
          </form>
        </div>

        {/* Footer link */}
        <p className="text-center text-sm text-muted mt-4">
          Already have an account?{' '}
          <button
            type="button"
            onClick={onSwitchToLogin}
            className="text-accent hover:text-accent-hover transition-colors"
          >
            Sign in
          </button>
        </p>
      </div>
    </div>
  );
}
