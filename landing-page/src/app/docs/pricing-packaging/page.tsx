import type { Metadata } from 'next';
import Link from 'next/link';
import { buildMetadata, SITE_URL } from '@/lib/metadata';

export const metadata: Metadata = buildMetadata({
  title: 'Pricing & packaging',
  description: 'Free local core, managed convenience, shared workspaces, and governance layers for Rorca.',
  path: '/docs/pricing-packaging',
  ogImage: `${SITE_URL}/og/pricing.png`,
});

export default function DocsPricingPackagingPage() {
  return (
    <div className="max-w-4xl">
      <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-4">Pricing & packaging</p>
      <h1 className="text-4xl md:text-5xl font-medium tracking-tight mb-4">Keep the local core free.</h1>
      <p className="text-zinc-400 text-lg leading-relaxed max-w-3xl mb-10">
        The clean commercial boundary is simple: single-user local Rorca is free, and paid layers start when you need shared state, managed infrastructure, governance, or enterprise controls.
      </p>

      <div className="grid gap-4 md:grid-cols-3 mb-8">
        <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6">
          <p className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Free</p>
          <h2 className="text-xl font-medium mb-3">Local</h2>
          <ul className="space-y-2 text-zinc-300 leading-relaxed text-sm">
            <li>Dashboard / UI</li>
            <li>CLI + embedded TUI</li>
            <li>Local MCP server</li>
            <li>Provider attachment</li>
            <li>Local memory / retrieval / graph</li>
            <li>Local execution</li>
          </ul>
        </section>
        <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6">
          <p className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Pro</p>
          <h2 className="text-xl font-medium mb-3">Managed solo</h2>
          <ul className="space-y-2 text-zinc-300 leading-relaxed text-sm">
            <li>Cloud sync between devices</li>
            <li>Hosted artifacts and history</li>
            <li>Managed background execution</li>
            <li>Backups and easier upgrades</li>
          </ul>
        </section>
        <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6">
          <p className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Team / Enterprise</p>
          <h2 className="text-xl font-medium mb-3">Shared + governed</h2>
          <ul className="space-y-2 text-zinc-300 leading-relaxed text-sm">
            <li>Shared workspaces</li>
            <li>RBAC / SSO / auditability</li>
            <li>Org-level secrets and policy</li>
            <li>Governance and support</li>
          </ul>
        </section>
      </div>

      <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-6 mb-10 text-zinc-200 leading-relaxed">
        The local core is designed to be useful on its own: dashboard, CLI/TUI, local MCP, provider attachment, local execution, and local retrieval remain available for single-user local workflows. Paid tiers focus on managed infrastructure, shared workspaces, governance, and enterprise controls.
      </section>

      <div className="flex flex-wrap gap-3">
        <Link href="/pricing" className="px-4 py-2 rounded-lg bg-white text-zinc-950 font-medium hover:bg-zinc-200 transition-colors">Public pricing page</Link>
        <a href="https://github.com/getrorca/rorca#readme" target="_blank" rel="noreferrer" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">README</a>
      </div>
    </div>
  );
}
