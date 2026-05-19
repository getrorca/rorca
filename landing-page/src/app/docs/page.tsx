import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Download, Github } from 'lucide-react';
import { buildMetadata, SITE_URL } from '@/lib/metadata';
import { docsNav } from '@/lib/docs-nav';

export const metadata: Metadata = buildMetadata({
  title: 'Docs',
  description: 'Start here for install, explicit spec creation, architecture, memory, execution, and packaging guidance.',
  path: '/docs',
  ogImage: `${SITE_URL}/og/home.png`,
});

export default function DocsPage() {
  return (
    <div className="max-w-5xl">
      <div className="max-w-3xl mb-12">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-white/10 bg-white/5 text-xs font-medium text-zinc-400 mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-fizz animate-pulse" />
          Start here
        </div>
        <h1 className="text-4xl md:text-6xl font-medium tracking-tight mb-5">
          Docs for the real Rorca product.
        </h1>
        <p className="text-zinc-400 text-lg md:text-xl leading-relaxed max-w-2xl">
          Local-first setup, explicit spec creation, backend-native retrieval, provider-selected execution, a single tools reference, and the pricing shape that preserves open-source trust.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-12">
        <Link href="/download" className="inline-flex items-center justify-center gap-2 px-5 py-3 bg-white text-zinc-950 rounded-lg font-medium hover:bg-zinc-200 transition-colors">
          <Download className="w-4 h-4" />
          Install Rorca
        </Link>
        <a href="https://github.com/getrorca/rorca#readme" target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-2 px-5 py-3 border border-white/10 text-white rounded-lg font-medium hover:bg-white/5 transition-colors">
          <Github className="w-4 h-4" />
          View README
        </a>
        <Link href="/docs/spec-creation" className="inline-flex items-center justify-center gap-2 px-5 py-3 border border-white/10 text-zinc-300 rounded-lg font-medium hover:bg-white/5 transition-colors">
          Explicit create-spec flow
          <ArrowRight className="w-4 h-4" />
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-12">
        {docsNav.map((item) => (
          <Link key={item.href} href={item.href} className="group rounded-2xl border border-white/10 bg-zinc-950/60 p-6 hover:border-zinc-700 transition-colors">
            <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500 mb-2">{item.eyebrow}</div>
            <h2 className="text-xl font-medium text-white mb-3 tracking-tight">{item.title}</h2>
            <p className="text-zinc-400 leading-relaxed">{item.description}</p>
          </Link>
        ))}
      </div>

      <section className="bg-zinc-950 border border-white/10 rounded-2xl p-6">
        <p className="text-sm uppercase tracking-[0.24em] text-zinc-500 mb-4">Start with these routes</p>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-zinc-300 leading-relaxed">
          <Link href="/download" className="block hover:text-white transition-colors">/download — install and run locally</Link>
          <Link href="/architecture" className="block hover:text-white transition-colors">/architecture — control-plane overview</Link>
          <Link href="/memory" className="block hover:text-white transition-colors">/memory — retrieval and graph story</Link>
          <Link href="/execution" className="block hover:text-white transition-colors">/execution — provider-selected runtime story</Link>
          <Link href="/docs/tools" className="block hover:text-white transition-colors">/docs/tools — CLI, TUI, MCP, and Pi extension reference</Link>
          <Link href="/pricing" className="block hover:text-white transition-colors">/pricing — public packaging surface</Link>
        </div>
      </section>
    </div>
  );
}
