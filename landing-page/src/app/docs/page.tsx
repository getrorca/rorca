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

      <div className="flex flex-col sm:flex-row gap-3 mb-8">
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

      <div className="flex flex-wrap gap-2 mb-12 text-xs text-zinc-400">
        <span className="inline-flex items-center rounded-full border border-white/8 bg-black/20 px-3 py-1">Claude Code · Codex CLI = subscription-backed</span>
        <span className="inline-flex items-center rounded-full border border-white/8 bg-black/20 px-3 py-1">OpenCode = BYOA / API-key-backed</span>
        <span className="inline-flex items-center rounded-full border border-white/8 bg-black/20 px-3 py-1">Pi CLI = provider-authenticated</span>
      </div>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-12">
        <p className="text-sm uppercase tracking-[0.24em] text-zinc-500 mb-4">Start here by surface</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">CLI</div>
            <div className="text-white font-medium mb-2">Local setup and orchestration</div>
            <p className="text-zinc-400 leading-relaxed">Use <code className="text-zinc-300">rorca start</code>, <code className="text-zinc-300">rorca tui</code>, <code className="text-zinc-300">rorca forge</code>, and <code className="text-zinc-300">rorca run</code> for local operator work.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">TUI</div>
            <div className="text-white font-medium mb-2">Board, watch, workspace</div>
            <p className="text-zinc-400 leading-relaxed">Open the embedded terminal UI with <code className="text-zinc-300">rorca tui</code>, then use <code className="text-zinc-300">w</code>, <code className="text-zinc-300">s</code>, <code className="text-zinc-300">Tab</code>, and <code className="text-zinc-300">Esc</code>.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">MCP</div>
            <div className="text-white font-medium mb-2">Explicit tool contract</div>
            <p className="text-zinc-400 leading-relaxed">Use <code className="text-zinc-300">rorca_create_spec</code>, <code className="text-zinc-300">rorca_get_context</code>, and <code className="text-zinc-300">rorca_pipeline_status</code> when a client or skill should call Rorca directly.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Pi extension</div>
            <div className="text-white font-medium mb-2">Pi-native slash commands</div>
            <p className="text-zinc-400 leading-relaxed">Install with <code className="text-zinc-300">rorca pi install</code>, then inside Pi start with <code className="text-zinc-300">/rorca-help</code>. If Pi was already open, run <code className="text-zinc-300">/reload</code>.</p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-12">
        <p className="text-sm uppercase tracking-[0.24em] text-zinc-500 mb-4">Auth model + provider matrix</p>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Claude Code</div>
            <div className="text-white font-medium mb-2">Subscription-backed</div>
            <p className="text-zinc-400 leading-relaxed">Uses your Claude subscription via the Claude CLI. No API key needed.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">OpenCode</div>
            <div className="text-white font-medium mb-2">API-key-backed</div>
            <p className="text-zinc-400 leading-relaxed">Uses the OpenCode CLI with your chosen model/provider credentials.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Codex CLI</div>
            <div className="text-white font-medium mb-2">Subscription-backed</div>
            <p className="text-zinc-400 leading-relaxed">Uses your ChatGPT Plus/Pro subscription via the Codex CLI. No API key needed.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Pi CLI</div>
            <div className="text-white font-medium mb-2">Provider-authenticated</div>
            <p className="text-zinc-400 leading-relaxed">Pi manages provider authentication natively. The Pi extension remains a separate operator surface.</p>
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-zinc-300 leading-relaxed">
          Broader model/provider sources also exist in settings, including OpenAI-compatible, OpenRouter, and local paths. This page focuses on the execution CLIs and the explicit control surfaces newcomers should learn first.
        </div>
      </section>

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
