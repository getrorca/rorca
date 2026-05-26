'use client';

import { useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { trackAuthComplete } from '@/lib/analytics';
import { buildApiUrl } from '@/lib/api-base';

const GITHUB_CLIENT_ID = process.env.NEXT_PUBLIC_GITHUB_CLIENT_ID;

function GitHubIcon() {
    return (
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor" aria-hidden="true">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
        </svg>
    );
}

function Spinner() {
    return (
        <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
    );
}

export default function LoginPage() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({});
    const [isLoading, setIsLoading] = useState(false);
    const [isGithubLoading, setIsGithubLoading] = useState(false);

    function validate() {
        const next: typeof errors = {};
        if (!email) next.email = 'Email is required';
        else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) next.email = 'Enter a valid email address';
        if (!password) next.password = 'Password is required';
        return next;
    }

    function handleGitHubLogin() {
        if (!GITHUB_CLIENT_ID) return;
        setIsGithubLoading(true);
        trackAuthComplete('github');
        const params = new URLSearchParams({
            client_id: GITHUB_CLIENT_ID,
            redirect_uri: `${window.location.origin}/api/auth/github/callback`,
            scope: 'user:email,repo',
        });
        window.location.href = `https://github.com/login/oauth/authorize?${params.toString()}`;
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        const next = validate();
        if (Object.keys(next).length > 0) {
            setErrors(next);
            return;
        }
        setErrors({});
        setIsLoading(true);
        try {
            const res = await fetch(buildApiUrl('/api/auth/login'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            });
            if (res.status === 401) {
                setErrors({ form: 'Invalid email or password' });
                return;
            }
            if (!res.ok) {
                setErrors({ form: 'Something went wrong. Please try again.' });
                return;
            }
            trackAuthComplete('email');
            window.location.href = '/';
        } catch {
            setErrors({ form: 'Unable to connect. Please try again.' });
        } finally {
            setIsLoading(false);
        }
    }

    return (
        <main className="min-h-screen bg-background relative overflow-hidden flex flex-col">
            <Nav />

            {/* Background glow */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-accent/10 blur-[120px] pointer-events-none -z-10 rounded-full" />

            <div className="flex-grow flex items-center justify-center px-4 pt-20 pb-12">

                <motion.div
                    initial={{ opacity: 0, y: 24 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, ease: 'easeOut' }}
                    className="w-full max-w-md"
                >
                    {/* Card */}
                    <div className="bg-surface border border-border rounded-2xl p-8">
                        <div className="mb-8 text-center">
                            <h1 className="text-2xl font-semibold text-white tracking-tight">Welcome back</h1>
                            <p className="mt-2 text-sm text-zinc-400">Sign in to your Rorca account</p>
                        </div>

                        {/* GitHub OAuth */}
                        {GITHUB_CLIENT_ID && (
                            <>
                                <button
                                    onClick={handleGitHubLogin}
                                    disabled={isGithubLoading || isLoading}
                                    className="w-full flex items-center justify-center gap-3 px-4 py-2.5 bg-white text-zinc-950 rounded-lg text-sm font-medium hover:bg-zinc-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {isGithubLoading ? <Spinner /> : <GitHubIcon />}
                                    {isGithubLoading ? 'Redirecting…' : 'Continue with GitHub'}
                                </button>

                                <div className="relative my-6">
                                    <div className="absolute inset-0 flex items-center">
                                        <div className="w-full border-t border-border" />
                                    </div>
                                    <div className="relative flex justify-center text-xs">
                                        <span className="px-3 bg-surface text-zinc-500">or continue with email</span>
                                    </div>
                                </div>
                            </>
                        )}

                        {/* Email/password form */}
                        <form onSubmit={handleSubmit} noValidate className="space-y-4">
                            <div>
                                <label htmlFor="email" className="block text-sm font-medium text-zinc-300 mb-1.5">
                                    Email
                                </label>
                                <input
                                    id="email"
                                    type="email"
                                    autoComplete="email"
                                    value={email}
                                    onChange={e => { setEmail(e.target.value); setErrors(prev => ({ ...prev, email: undefined })); }}
                                    placeholder="you@example.com"
                                    className={`w-full px-3.5 py-2.5 bg-background border rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-accent/50 transition-colors ${errors.email ? 'border-red-500/70' : 'border-border hover:border-white/15'}`}
                                />
                                {errors.email && (
                                    <p className="mt-1.5 text-xs text-red-400">{errors.email}</p>
                                )}
                            </div>

                            <div>
                                <label htmlFor="password" className="block text-sm font-medium text-zinc-300 mb-1.5">
                                    Password
                                </label>
                                <input
                                    id="password"
                                    type="password"
                                    autoComplete="current-password"
                                    value={password}
                                    onChange={e => { setPassword(e.target.value); setErrors(prev => ({ ...prev, password: undefined })); }}
                                    placeholder="••••••••"
                                    className={`w-full px-3.5 py-2.5 bg-background border rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-accent/50 transition-colors ${errors.password ? 'border-red-500/70' : 'border-border hover:border-white/15'}`}
                                />
                                {errors.password && (
                                    <p className="mt-1.5 text-xs text-red-400">{errors.password}</p>
                                )}
                            </div>

                            {errors.form && (
                                <div className="px-3.5 py-2.5 bg-red-500/10 border border-red-500/20 rounded-lg">
                                    <p className="text-sm text-red-400">{errors.form}</p>
                                </div>
                            )}

                            <button
                                type="submit"
                                disabled={isLoading || isGithubLoading}
                                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-2"
                            >
                                {isLoading ? <><Spinner /> Signing in…</> : 'Sign in'}
                            </button>
                        </form>

                        <p className="mt-6 text-center text-sm text-zinc-500">
                            Don&apos;t have an account?{' '}
                            <Link href="/signup" className="text-accent hover:text-accent/80 font-medium transition-colors">
                                Create an account
                            </Link>
                        </p>
                    </div>
                </motion.div>
            </div>

            <Footer />
        </main>
    );
}
