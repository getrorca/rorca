'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Check, X, RefreshCw, Server, Zap, Building2 } from 'lucide-react';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { trackPricingToggle, trackCtaClick } from '@/lib/analytics';

// ─── Static pricing data ───────────────────────────────────────────────────

const FEATURES: { label: string; free: boolean | string; pro: boolean | string; team: boolean | string }[] = [
    { label: 'Local dashboard + CLI + embedded TUI', free: true, pro: true, team: true },
    { label: 'Local execution through your selected provider CLI', free: true, pro: true, team: true },
    { label: 'Local MCP server', free: true, pro: true, team: true },
    { label: 'Local memory / retrieval / graph', free: true, pro: true, team: true },
    { label: 'Managed cloud sync + hosted artifacts', free: false, pro: true, team: true },
    { label: 'Shared workspaces', free: false, pro: false, team: true },
    { label: 'Model choice across planning, execution, and memory synthesis', free: true, pro: true, team: true },
    { label: 'RBAC & access control', free: false, pro: false, team: true },
    { label: 'Audit log / SSO / governance', free: false, pro: false, team: true },
    { label: 'Support', free: 'Community', pro: 'Priority', team: 'Priority + SLA' },
];

const STRIPE_PRO_PRICE_MONTHLY  = process.env.NEXT_PUBLIC_STRIPE_PRICE_ID_PRO_MONTHLY  ?? '';
const STRIPE_PRO_PRICE_ANNUAL   = process.env.NEXT_PUBLIC_STRIPE_PRICE_ID_PRO_ANNUAL   ?? '';

// ─── Sub-components ────────────────────────────────────────────────────────

function FeatureCell({ value }: { value: boolean | string }) {
    if (value === true)  return <Check className="w-5 h-5 text-accent mx-auto" strokeWidth={2} />;
    if (value === false) return <X     className="w-5 h-5 text-zinc-700 mx-auto" strokeWidth={2} />;
    return <span className="text-zinc-300 text-sm font-medium">{value}</span>;
}

function SkeletonGrid() {
    return (
        <div className="animate-pulse">
            {/* Skeleton header row */}
            <div className="grid grid-cols-4 gap-4 mb-6">
                <div className="h-6 bg-white/5 rounded col-span-1" />
                <div className="h-6 bg-white/5 rounded col-span-1" />
                <div className="h-6 bg-white/5 rounded col-span-1" />
                <div className="h-6 bg-white/5 rounded col-span-1" />
            </div>
            {/* Skeleton feature rows */}
            {Array.from({ length: 9 }).map((_, i) => (
                <div key={i} className="grid grid-cols-4 gap-4 py-3 border-t border-white/5">
                    <div className="h-4 bg-white/5 rounded col-span-1" />
                    <div className="h-4 bg-white/5 rounded-full w-5 mx-auto" />
                    <div className="h-4 bg-white/5 rounded-full w-5 mx-auto" />
                    <div className="h-4 bg-white/5 rounded-full w-5 mx-auto" />
                </div>
            ))}
        </div>
    );
}

interface StripeCTAProps {
    priceId: string;
    label: string;
    comingSoonLabel?: string;
}

function StripeCTA({ priceId, label, comingSoonLabel = 'Coming Soon' }: StripeCTAProps) {
    const [error, setError] = useState<string | null>(null);
    const [retrying, setRetrying] = useState(false);

    if (!priceId) {
        return (
            <span className="block w-full text-center px-6 py-2.5 rounded-lg border border-white/10 text-zinc-500 text-sm font-medium cursor-not-allowed select-none">
                {comingSoonLabel}
            </span>
        );
    }

    const handleClick = async () => {
        setError(null);
        setRetrying(true);
        try {
            const checkoutUrl = `https://checkout.stripe.com/pay/${encodeURIComponent(priceId)}`;
            window.location.href = checkoutUrl;
        } catch {
            setError('Payment service unavailable — try again later');
        } finally {
            setRetrying(false);
        }
    };

    return (
        <div>
            <button
                onClick={handleClick}
                disabled={retrying}
                className="w-full px-6 py-2.5 bg-white text-zinc-950 rounded-lg text-sm font-medium hover:bg-zinc-100 active:bg-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_40px_rgba(255,255,255,0.08)] hover:shadow-[0_0_60px_rgba(255,255,255,0.15)]"
            >
                {retrying ? 'Redirecting…' : label}
            </button>
            {error && (
                <div className="mt-2 text-xs text-red-400 flex items-center gap-1.5">
                    <span>{error}</span>
                    <button
                        onClick={handleClick}
                        className="flex items-center gap-1 text-red-300 hover:text-red-200 underline underline-offset-2 transition-colors"
                    >
                        <RefreshCw className="w-3 h-3" /> Retry
                    </button>
                </div>
            )}
        </div>
    );
}

// ─── Main page ─────────────────────────────────────────────────────────────

export default function PricingClient() {
    const [annual, setAnnual] = useState(false);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        const t = setTimeout(() => setLoaded(true), 500);
        return () => clearTimeout(t);
    }, []);

    const proMonthly  = 15;
    const teamMonthly = 30;
    const proAnnual   = Math.round((proMonthly  * 10) / 12);
    const teamAnnual  = Math.round((teamMonthly * 10) / 12);

    const proPrice    = annual ? proAnnual  : proMonthly;
    const teamPrice   = annual ? teamAnnual : teamMonthly;

    const proStripeId  = annual ? STRIPE_PRO_PRICE_ANNUAL  : STRIPE_PRO_PRICE_MONTHLY;

    return (
        <main className="min-h-screen bg-abyss text-white selection:bg-accent selection:text-white flex flex-col">
            <Nav />

            <div className="pt-32 pb-20 px-6 sm:px-12 mx-auto max-w-7xl w-full flex-grow">

                {/* Page header */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, ease: 'easeOut' }}
                    className="text-center mb-12"
                >
                    <h1 className="text-5xl md:text-6xl font-medium tracking-tight mb-4">
                        Simple,{' '}
                        <span className="bg-gradient-to-r from-zinc-300 via-zinc-500 to-zinc-400 bg-clip-text text-transparent">
                            transparent
                        </span>{' '}
                        pricing
                    </h1>
                    <p className="text-zinc-400 text-xl max-w-2xl mx-auto leading-relaxed">
                        Free locally. Pay for managed convenience, shared workspaces, and governance when you need them.
                    </p>
                </motion.div>

                {/* Self-hosted badge */}
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.1, ease: 'easeOut' }}
                    className="flex justify-center mb-10"
                >
                    <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-accent/10 border border-accent/25 rounded-full text-sm font-medium text-accent backdrop-blur-md">
                        <Server className="w-4 h-4" />
                        Local single-user Rorca is free
                    </div>
                </motion.div>

                {/* Monthly / Annual toggle */}
                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.15, ease: 'easeOut' }}
                    className="flex justify-center mb-14"
                >
                    <div className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-full px-1.5 py-1.5">
                        <button
                            onClick={() => { setAnnual(false); trackPricingToggle('monthly'); }}
                            className={`px-5 py-1.5 rounded-full text-sm font-medium transition-all ${
                                !annual
                                    ? 'bg-white text-zinc-950 shadow-sm'
                                    : 'text-zinc-400 hover:text-white'
                            }`}
                        >
                            Monthly
                        </button>
                        <button
                            onClick={() => { setAnnual(true); trackPricingToggle('annual'); }}
                            className={`px-5 py-1.5 rounded-full text-sm font-medium transition-all flex items-center gap-2 ${
                                annual
                                    ? 'bg-white text-zinc-950 shadow-sm'
                                    : 'text-zinc-400 hover:text-white'
                            }`}
                        >
                            Annual
                            <span className={`text-xs px-1.5 py-0.5 rounded-full font-semibold transition-colors ${
                                annual ? 'bg-accent/20 text-accent' : 'bg-white/10 text-zinc-400'
                            }`}>
                                2 mo free
                            </span>
                        </button>
                    </div>
                </motion.div>

                {/* ── Pricing grid ─────────────────────────────────────────── */}
                {!loaded ? (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="max-w-5xl mx-auto"
                    >
                        <SkeletonGrid />
                    </motion.div>
                ) : (
                    <motion.div
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.4, ease: 'easeOut' }}
                    >
                        {/* ── Desktop: 3-column card grid ── */}
                        <div className="hidden lg:grid lg:grid-cols-3 gap-6 max-w-5xl mx-auto mb-16">

                            {/* Free */}
                            <motion.div
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.5, delay: 0.0 }}
                                className="relative bg-surface border border-border rounded-2xl p-8 flex flex-col gap-6 group hover:border-zinc-700 transition-colors"
                            >
                                <div className="absolute inset-0 bg-gradient-to-br from-white/3 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-2xl pointer-events-none" />
                                <div>
                                    <div className="flex items-center gap-2 mb-3">
                                        <div className="w-8 h-8 rounded-lg bg-zinc-800/60 border border-white/5 flex items-center justify-center">
                                            <Zap className="w-4 h-4 text-zinc-400" />
                                        </div>
                                        <span className="text-sm font-medium text-zinc-400 uppercase tracking-widest">Free</span>
                                    </div>
                                    <div className="flex items-end gap-1 mb-1">
                                        <span className="text-5xl font-medium tracking-tight text-white">$0</span>
                                        <span className="text-zinc-500 text-sm mb-1.5">/ local</span>
                                    </div>
                                    <p className="text-zinc-500 text-sm">Dashboard, CLI, embedded TUI, MCP, provider attachment, and local execution.</p>
                                </div>
                                <a
                                    href="/download"
                                    onClick={() => trackCtaClick('free_get_started', '/pricing')}
                                    className="block w-full text-center px-6 py-2.5 rounded-lg border border-white/10 text-zinc-300 text-sm font-medium hover:bg-white/5 hover:border-white/20 transition-colors"
                                >
                                    Get Started
                                </a>
                                <ul className="flex flex-col gap-3 text-sm text-zinc-400">
                                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-accent shrink-0" /> Local dashboard + CLI + embedded TUI</li>
                                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-accent shrink-0" /> Local MCP server + provider attachment</li>
                                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-accent shrink-0" /> Local execution through Claude Code, OpenCode, Codex, or Pi</li>
                                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-accent shrink-0" /> Local memory / retrieval / graph</li>
                                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-accent shrink-0" /> Community support</li>
                                </ul>
                            </motion.div>

                            {/* Pro — highlighted */}
                            <motion.div
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.5, delay: 0.1 }}
                                className="relative bg-surface border border-accent/30 rounded-2xl p-8 flex flex-col gap-6 shadow-[0_0_40px_rgba(139,92,246,0.12)] group hover:border-accent/50 transition-colors"
                            >
                                {/* Most popular badge */}
                                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-accent rounded-full text-xs font-semibold text-white shadow-[0_0_20px_rgba(139,92,246,0.5)]">
                                    Most Popular
                                </div>
                                <div className="absolute inset-0 bg-gradient-to-br from-accent/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-2xl pointer-events-none" />
                                <div>
                                    <div className="flex items-center gap-2 mb-3">
                                        <div className="w-8 h-8 rounded-lg bg-accent/20 border border-accent/30 flex items-center justify-center">
                                            <Zap className="w-4 h-4 text-accent" />
                                        </div>
                                        <span className="text-sm font-medium text-accent uppercase tracking-widest">Pro</span>
                                    </div>
                                    <div className="flex items-end gap-1 mb-1">
                                        {annual && (
                                            <span className="text-zinc-600 line-through text-2xl font-medium mr-1">${proMonthly}</span>
                                        )}
                                        <span className="text-5xl font-medium tracking-tight text-white">${proPrice}</span>
                                        <span className="text-zinc-500 text-sm mb-1.5">/ mo{annual ? ', billed annually' : ''}</span>
                                    </div>
                                    {annual && (
                                        <p className="text-accent text-xs font-medium mb-1">Save ${(proMonthly - proPrice) * 12} / year</p>
                                    )}
                                    <p className="text-zinc-500 text-sm">Managed solo convenience: cloud sync, hosted history, and easier background execution.</p>
                                </div>
                                <StripeCTA priceId={proStripeId} label="Start Free Trial" />
                                <ul className="flex flex-col gap-3 text-sm text-zinc-400">
                                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-accent shrink-0" /> Everything in Free</li>
                                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-accent shrink-0" /> Cloud sync between devices</li>
                                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-accent shrink-0" /> Hosted run history and artifacts</li>
                                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-accent shrink-0" /> Managed background execution</li>
                                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-accent shrink-0" /> Easier provider and backup management</li>
                                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-accent shrink-0" /> Priority support</li>
                                </ul>
                            </motion.div>

                            {/* Team */}
                            <motion.div
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.5, delay: 0.2 }}
                                className="relative bg-surface border border-border rounded-2xl p-8 flex flex-col gap-6 group hover:border-zinc-700 transition-colors"
                            >
                                <div className="absolute inset-0 bg-gradient-to-br from-white/3 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 rounded-2xl pointer-events-none" />
                                <div>
                                    <div className="flex items-center gap-2 mb-3">
                                        <div className="w-8 h-8 rounded-lg bg-zinc-800/60 border border-white/5 flex items-center justify-center">
                                            <Building2 className="w-4 h-4 text-zinc-400" />
                                        </div>
                                        <span className="text-sm font-medium text-zinc-400 uppercase tracking-widest">Team</span>
                                    </div>
                                    <div className="flex items-end gap-1 mb-1">
                                        {annual && (
                                            <span className="text-zinc-600 line-through text-2xl font-medium mr-1">${teamMonthly}</span>
                                        )}
                                        <span className="text-5xl font-medium tracking-tight text-white">${teamPrice}</span>
                                        <span className="text-zinc-500 text-sm mb-1.5">/ seat / mo{annual ? ', billed annually' : ''}</span>
                                    </div>
                                    {annual && (
                                        <p className="text-accent text-xs font-medium mb-1">Save ${(teamMonthly - teamPrice) * 12} / seat / year</p>
                                    )}
                                    <p className="text-zinc-500 text-sm">Shared workspaces, governance, visibility, and enterprise-friendly controls.</p>
                                </div>
                                <a
                                    href="mailto:hello@rorca.app?subject=Team%20plan%20inquiry"
                                    onClick={() => trackCtaClick('team_contact_sales', '/pricing')}
                                    className="block w-full text-center px-6 py-2.5 rounded-lg border border-white/10 text-zinc-300 text-sm font-medium hover:bg-white/5 hover:border-white/20 transition-colors"
                                >
                                    Contact Sales
                                </a>
                                <ul className="flex flex-col gap-3 text-sm text-zinc-400">
                                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-accent shrink-0" /> Everything in Pro</li>
                                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-accent shrink-0" /> Shared workspaces</li>
                                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-accent shrink-0" /> RBAC &amp; access control</li>
                                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-accent shrink-0" /> Audit log + SSO / SAML</li>
                                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-accent shrink-0" /> Org-level governance + visibility</li>
                                    <li className="flex items-center gap-2"><Check className="w-4 h-4 text-accent shrink-0" /> Priority support</li>
                                </ul>
                            </motion.div>
                        </div>

                        {/* ── Mobile: stacked cards ── */}
                        <div className="lg:hidden flex flex-col gap-6 mb-16">
                            {/* Free */}
                            <div className="bg-surface border border-border rounded-2xl p-6 flex flex-col gap-5">
                                <div>
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-xs font-medium text-zinc-400 uppercase tracking-widest">Free</span>
                                    </div>
                                    <div className="flex items-end gap-1 mb-1">
                                        <span className="text-4xl font-medium text-white">$0</span>
                                        <span className="text-zinc-500 text-sm mb-1">/ local</span>
                                    </div>
                                    <p className="text-zinc-500 text-sm">Free local core.</p>
                                </div>
                                <a
                                    href="/download"
                                    onClick={() => trackCtaClick('free_get_started', '/pricing')}
                                    className="block text-center px-5 py-2.5 rounded-lg border border-white/10 text-zinc-300 text-sm font-medium hover:bg-white/5 transition-colors"
                                >
                                    Get Started
                                </a>
                            </div>

                            {/* Pro */}
                            <div className="bg-surface border border-accent/30 rounded-2xl p-6 flex flex-col gap-5 shadow-[0_0_30px_rgba(139,92,246,0.10)]">
                                <div>
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-xs font-medium text-accent uppercase tracking-widest">Pro — Most Popular</span>
                                    </div>
                                    <div className="flex items-end gap-1 mb-1">
                                        {annual && (
                                            <span className="text-zinc-600 line-through text-xl font-medium mr-1">${proMonthly}</span>
                                        )}
                                        <span className="text-4xl font-medium text-white">${proPrice}</span>
                                        <span className="text-zinc-500 text-sm mb-1">/ mo</span>
                                    </div>
                                    <p className="text-zinc-500 text-sm">Managed solo convenience.</p>
                                </div>
                                <StripeCTA priceId={proStripeId} label="Start Free Trial" />
                            </div>

                            {/* Team */}
                            <div className="bg-surface border border-border rounded-2xl p-6 flex flex-col gap-5">
                                <div>
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-xs font-medium text-zinc-400 uppercase tracking-widest">Team</span>
                                    </div>
                                    <div className="flex items-end gap-1 mb-1">
                                        {annual && (
                                            <span className="text-zinc-600 line-through text-xl font-medium mr-1">${teamMonthly}</span>
                                        )}
                                        <span className="text-4xl font-medium text-white">${teamPrice}</span>
                                        <span className="text-zinc-500 text-sm mb-1">/ seat / mo</span>
                                    </div>
                                    <p className="text-zinc-500 text-sm">Shared workspaces and governance.</p>
                                </div>
                                <a
                                    href="mailto:hello@rorca.app?subject=Team%20plan%20inquiry"
                                    onClick={() => trackCtaClick('team_contact_sales', '/pricing')}
                                    className="block text-center px-5 py-2.5 rounded-lg border border-white/10 text-zinc-300 text-sm font-medium hover:bg-white/5 transition-colors"
                                >
                                    Contact Sales
                                </a>
                            </div>
                        </div>

                        {/* ── Feature comparison table (desktop) ── */}
                        <motion.div
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.5, delay: 0.3 }}
                            className="hidden lg:block max-w-5xl mx-auto"
                        >
                            <h2 className="text-xl font-medium text-zinc-300 mb-6 text-center">Full feature comparison</h2>

                            {/* Table header */}
                            <div className="grid grid-cols-4 gap-4 pb-4 border-b border-white/10">
                                <div className="text-sm text-zinc-500 font-medium">Feature</div>
                                <div className="text-sm text-zinc-300 font-medium text-center">Free</div>
                                <div className="text-sm text-accent font-medium text-center">Pro</div>
                                <div className="text-sm text-zinc-300 font-medium text-center">Team</div>
                            </div>

                            {/* Feature rows */}
                            {FEATURES.map((row, i) => (
                                <div
                                    key={row.label}
                                    className={`grid grid-cols-4 gap-4 py-3.5 items-center border-b transition-colors hover:bg-white/2 ${
                                        i % 2 === 0 ? 'border-white/5' : 'border-white/5'
                                    }`}
                                >
                                    <div className="text-sm text-zinc-400">{row.label}</div>
                                    <div className="flex justify-center"><FeatureCell value={row.free} /></div>
                                    <div className="flex justify-center"><FeatureCell value={row.pro} /></div>
                                    <div className="flex justify-center"><FeatureCell value={row.team} /></div>
                                </div>
                            ))}
                        </motion.div>

                        {/* ── Feature comparison accordion (mobile) ── */}
                        <div className="lg:hidden max-w-5xl mx-auto">
                            <h2 className="text-base font-medium text-zinc-300 mb-4">Feature comparison</h2>
                            <div className="overflow-x-auto rounded-xl border border-white/10">
                                <table className="w-full text-sm min-w-[480px]">
                                    <thead>
                                        <tr className="border-b border-white/10">
                                            <th className="text-left px-4 py-3 text-zinc-500 font-medium">Feature</th>
                                            <th className="px-4 py-3 text-zinc-300 font-medium text-center">Free</th>
                                            <th className="px-4 py-3 text-accent font-medium text-center">Pro</th>
                                            <th className="px-4 py-3 text-zinc-300 font-medium text-center">Team</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {FEATURES.map((row, i) => (
                                            <tr
                                                key={row.label}
                                                className={`border-b border-white/5 ${i % 2 === 0 ? 'bg-white/[0.01]' : ''}`}
                                            >
                                                <td className="px-4 py-3 text-zinc-400">{row.label}</td>
                                                <td className="px-4 py-3 text-center"><FeatureCell value={row.free} /></td>
                                                <td className="px-4 py-3 text-center"><FeatureCell value={row.pro} /></td>
                                                <td className="px-4 py-3 text-center"><FeatureCell value={row.team} /></td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                    </motion.div>
                )}

                {/* Divider */}
                <div className="w-full h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent my-20" />

                {/* FAQ / CTA strip */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5 }}
                    className="text-center max-w-xl mx-auto"
                >
                    <p className="text-zinc-400 text-lg mb-6 leading-relaxed">
                        Questions about plans? We&apos;re happy to help.
                    </p>
                    <a
                        href="mailto:hello@rorca.app"
                        className="inline-flex items-center gap-2 px-6 py-3 border border-white/10 rounded-lg text-sm font-medium text-zinc-300 hover:bg-white/5 hover:border-white/20 transition-colors"
                    >
                        Get in touch
                    </a>
                </motion.div>

            </div>

            <Footer />
        </main>
    );
}
