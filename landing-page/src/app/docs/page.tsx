import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, Download, Github } from 'lucide-react';
import { buildMetadata, SITE_URL } from '@/lib/metadata';
import { docsNav } from '@/lib/docs-nav';

export const metadata: Metadata = buildMetadata({
  title: 'Docs',
  description: 'Start here for the true beginner setup path, then go deeper into spec creation, execution, memory, CLI, TUI, and Pi workflows.',
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
          Start with the true beginner guide first, then go deeper into spec creation, providers and models, skills, execution, memory, and the operator surfaces.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-8">
        <Link href="/docs/getting-started" className="inline-flex items-center justify-center gap-2 px-5 py-3 bg-white text-zinc-950 rounded-lg font-medium hover:bg-zinc-200 transition-colors">
          Start the beginner guide
          <ArrowRight className="w-4 h-4" />
        </Link>
        <Link href="/download" className="inline-flex items-center justify-center gap-2 px-5 py-3 border border-white/10 text-white rounded-lg font-medium hover:bg-white/5 transition-colors">
          <Download className="w-4 h-4" />
          Install Rorca
        </Link>
        <a href="https://github.com/getrorca/rorca#readme" target="_blank" rel="noreferrer" className="inline-flex items-center justify-center gap-2 px-5 py-3 border border-white/10 text-zinc-300 rounded-lg font-medium hover:bg-white/5 transition-colors">
          <Github className="w-4 h-4" />
          View README
        </a>
      </div>

      <div className="flex flex-wrap gap-2 mb-12 text-xs text-zinc-400">
        <span className="inline-flex items-center rounded-full border border-white/8 bg-black/20 px-3 py-1">Claude Code · Codex CLI = subscription-backed</span>
        <span className="inline-flex items-center rounded-full border border-white/8 bg-black/20 px-3 py-1">OpenCode = BYOA / API-key-backed</span>
        <span className="inline-flex items-center rounded-full border border-white/8 bg-black/20 px-3 py-1">Pi CLI = provider-authenticated</span>
      </div>

      <section className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-6 mb-8">
        <p className="text-sm uppercase tracking-[0.24em] text-zinc-500 mb-4">New to Rorca?</p>
        <h2 className="text-2xl font-medium mb-3">Read the beginner guide before choosing a surface.</h2>
        <p className="text-zinc-300 leading-relaxed mb-4 max-w-3xl">
          If you do not yet understand workspaces, providers, models, skills, specs, story selection, and runs, start with the dashboard-first guide. It explains how to get from a local repo to a real first execution without assuming you already think in Rorca concepts.
        </p>
        <Link href="/docs/getting-started" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white text-zinc-950 font-medium hover:bg-zinc-200 transition-colors">
          Open the getting started guide
          <ArrowRight className="w-4 h-4" />
        </Link>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-12">
        <p className="text-sm uppercase tracking-[0.24em] text-zinc-500 mb-4">Start here by surface</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Link href="/docs/cli" className="rounded-xl border border-white/10 bg-black/20 p-4 hover:border-zinc-700 transition-colors">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">CLI</div>
            <div className="text-white font-medium mb-2">Local setup and orchestration</div>
            <p className="text-zinc-400 leading-relaxed">Use <code className="text-zinc-300">rorca start</code>, <code className="text-zinc-300">rorca forge</code>, <code className="text-zinc-300">rorca run</code>, <code className="text-zinc-300">rorca attach</code>, and the execution-engine flags from the dedicated CLI guide.</p>
          </Link>
          <Link href="/docs/tui" className="rounded-xl border border-white/10 bg-black/20 p-4 hover:border-zinc-700 transition-colors">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">TUI</div>
            <div className="text-white font-medium mb-2">Board, watch, model picker, workspace</div>
            <p className="text-zinc-400 leading-relaxed">Open the embedded terminal UI with <code className="text-zinc-300">rorca tui</code>, then learn board mode, live streams, agent/model switching, recall, and story editing from the dedicated TUI guide.</p>
          </Link>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">MCP</div>
            <div className="text-white font-medium mb-2">Explicit tool contract</div>
            <p className="text-zinc-400 leading-relaxed">Use <code className="text-zinc-300">rorca_create_spec</code>, <code className="text-zinc-300">rorca_get_context</code>, and <code className="text-zinc-300">rorca_pipeline_status</code> when a client or skill should call Rorca directly.</p>
          </div>
          <Link href="/docs/pi-extension" className="rounded-xl border border-white/10 bg-black/20 p-4 hover:border-zinc-700 transition-colors">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Pi extension</div>
            <div className="text-white font-medium mb-2">Pi-native slash commands</div>
            <p className="text-zinc-400 leading-relaxed">Install with <code className="text-zinc-300">rorca pi install</code>, then use <code className="text-zinc-300">/rorca-run</code>, <code className="text-zinc-300">/rorca-watch</code>, <code className="text-zinc-300">/rorca-retry</code>, and the extension guide for the full Pi-native operator flow.</p>
          </Link>
        </div>
      </section>

      <section className="rounded-3xl border border-white/10 bg-zinc-950/70 p-6 md:p-8 mb-12">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between mb-6">
          <div>
            <p className="text-sm uppercase tracking-[0.24em] text-zinc-500 mb-3">The user guide</p>
            <h2 className="text-2xl md:text-3xl font-medium tracking-tight text-white">Read the product in the same order you’ll use it.</h2>
          </div>
          <p className="text-sm text-zinc-400 max-w-2xl leading-relaxed">
            Install → understand the control plane → pick a surface → create a spec → review → run → watch → learn.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {[
            {
              href: '/docs/getting-started',
              title: 'Getting started',
              desc: 'The first-run path for new users: install, connect a workspace, pick a provider, and finish one small successful run.',
              src: '/docs-images/user-guide/getting-started.png',
            },
            {
              href: '/architecture',
              title: 'Architecture',
              desc: 'The full control-plane diagram: surfaces, spec truth, execution truth, and the feedback loop.',
              src: '/docs-images/user-guide/architecture.png',
            },
            {
              href: '/docs/cli',
              title: 'CLI guide',
              desc: 'The standalone operator surface for setup, forge, run, attach, doctor, auth, and MCP workflows.',
              src: '/docs-images/user-guide/cli.png',
            },
            {
              href: '/docs/pi-extension',
              title: 'Pi extension',
              desc: 'Pi-native slash commands for create-spec, run, watch, retry, status, and MCP bridge inspection.',
              src: '/docs-images/user-guide/pi-extension.png',
            },
          ].map((item) => (
            <Link key={item.href} href={item.href} className="group overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/70 hover:border-white/20 transition-colors">
              <div className="relative aspect-[16/11] overflow-hidden border-b border-white/10 bg-black/20">
                <Image
                  src={item.src}
                  alt={item.title}
                  fill
                  sizes="(min-width: 1024px) 50vw, 100vw"
                  className="object-cover object-top transition-transform duration-500 group-hover:scale-[1.01]"
                />
              </div>
              <div className="p-5">
                <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Guide</div>
                <div className="text-xl font-medium text-white mb-2 tracking-tight">{item.title}</div>
                <p className="text-sm text-zinc-400 leading-relaxed">{item.desc}</p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="rounded-3xl border border-white/10 bg-zinc-950/70 p-6 md:p-8 mb-12">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between mb-6">
          <div>
            <p className="text-sm uppercase tracking-[0.24em] text-zinc-500 mb-3">Product in action</p>
            <h2 className="text-2xl md:text-3xl font-medium tracking-tight text-white">Real screens from the actual app, not mockups.</h2>
          </div>
          <div className="max-w-2xl">
            <p className="text-sm text-zinc-400 leading-relaxed mb-3">
              These are live captures of the dashboard surfaces users actually move through: specs, settings, review, runs, and marketplace.
            </p>
            <Link href="/docs/product-tour" className="inline-flex items-center gap-2 text-sm font-medium text-cyan-200 hover:text-white transition-colors">
              Open the guided product tour
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/30 mb-5">
          <video
            className="w-full"
            src="/docs-images/product-tour/rorca-product-tour.mp4"
            poster="/docs-images/product-surfaces/specs-home.png"
            controls
            muted
            loop
            playsInline
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {[
            {
              title: 'Specs board',
              desc: 'The real board view with draft, in-progress, and done columns.',
              src: '/docs-images/product-surfaces/specs-home.png',
            },
            {
              title: 'Providers & Models',
              desc: 'Workspace settings with provider connections and model routing.',
              src: '/docs-images/product-surfaces/settings-providers.png',
            },
            {
              title: 'Spec review',
              desc: 'Pending spec review with stories, criteria, and action buttons.',
              src: '/docs-images/product-surfaces/spec-review.png',
            },
            {
              title: 'Run progress',
              desc: 'A live run view showing streaming execution trace and story status.',
              src: '/docs-images/product-surfaces/run-view-running.png',
            },
            {
              title: 'Marketplace',
              desc: 'Skills marketplace with search, install actions, and installed library.',
              src: '/docs-images/product-surfaces/marketplace.png',
            },
            {
              title: 'GitHub integration',
              desc: 'Repository webhook setup, Actions workflow download, CI autofix, and PR automation settings.',
              src: '/docs-images/product-surfaces/github-settings.png',
            },
            {
              title: 'Retry inspection',
              desc: 'A failed story view that shows the smallest safe scope for retry planning.',
              src: '/docs-images/product-surfaces/run-view-stories.png',
            },
          ].map((item) => (
            <div key={item.title} className="overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/70">
              <div className="relative aspect-[16/10] overflow-hidden border-b border-white/10 bg-black/20">
                <Image
                  src={item.src}
                  alt={item.title}
                  fill
                  sizes="(min-width: 1280px) 33vw, (min-width: 768px) 50vw, 100vw"
                  className="object-cover object-top"
                />
              </div>
              <div className="p-4">
                <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Surface</div>
                <div className="text-lg font-medium text-white mb-2 tracking-tight">{item.title}</div>
                <p className="text-sm text-zinc-400 leading-relaxed">{item.desc}</p>
              </div>
            </div>
          ))}
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
          <Link href="/docs/product-tour" className="block hover:text-white transition-colors">/docs/product-tour — guided product demo, MP4, GIF, and screenshots</Link>
          <Link href="/docs/cli" className="block hover:text-white transition-colors">/docs/cli — standalone CLI deep guide</Link>
          <Link href="/docs/tui" className="block hover:text-white transition-colors">/docs/tui — embedded TUI deep guide</Link>
          <Link href="/docs/pi-extension" className="block hover:text-white transition-colors">/docs/pi-extension — Pi extension deep guide</Link>
          <Link href="/docs/tools" className="block hover:text-white transition-colors">/docs/tools — reference index across all operator surfaces</Link>
          <Link href="/pricing" className="block hover:text-white transition-colors">/pricing — public packaging surface</Link>
        </div>
      </section>
    </div>
  );
}
