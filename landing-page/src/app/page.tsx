import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav } from '@/components/Nav';
import { Hero } from '@/components/Hero';
import { FeatureGrid } from '@/components/FeatureGrid';
import { HowItWorks } from '@/components/HowItWorks';
import { Footer } from '@/components/Footer';
import { buildMetadata, PAGES_METADATA, SITE_URL } from '@/lib/metadata';

export const metadata: Metadata = buildMetadata(PAGES_METADATA.home);

const organizationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Rorca',
  url: SITE_URL,
  description:
    'Rorca is an AI spec orchestration platform. Turn a plain-English brief into a structured spec, then execute every story autonomously.',
  sameAs: ['https://github.com/getrorca/rorca'],
  logo: {
    '@type': 'ImageObject',
    url: `${SITE_URL}/og/og-default.png`,
  },
};

export default function Home() {
  return (
    <main className="min-h-screen bg-abyss selection:bg-fizz selection:text-abyss relative overflow-hidden flex flex-col">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
      />
      <Nav />
      <div className="pt-32 flex-grow">
        <Hero />
        <section className="px-6 sm:px-12 mx-auto max-w-7xl mb-16">
          <div className="rounded-3xl border border-white/10 bg-zinc-950/70 p-6 md:p-8">
            <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between mb-6">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-3">Start here by surface</p>
                <h2 className="text-2xl md:text-3xl font-medium tracking-tight text-white">Choose the surface that matches how you work.</h2>
              </div>
              <Link href="/docs/tools" className="text-sm text-fizz hover:text-white transition-colors font-medium">
                See the full tools reference →
              </Link>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
              <Link href="/download" className="rounded-2xl border border-white/10 bg-black/20 p-4 hover:border-white/20 hover:bg-white/[0.04] transition-colors">
                <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">CLI</div>
                <div className="text-white font-medium mb-2">Local setup + orchestration</div>
                <p className="text-sm text-zinc-400 leading-relaxed">Install, start the stack, forge a spec, and run approved work locally.</p>
              </Link>
              <Link href="/docs/tools" className="rounded-2xl border border-white/10 bg-black/20 p-4 hover:border-white/20 hover:bg-white/[0.04] transition-colors">
                <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">TUI</div>
                <div className="text-white font-medium mb-2">Board, watch, switch</div>
                <p className="text-sm text-zinc-400 leading-relaxed">Open the embedded terminal UI for board navigation, live streams, and workspace switching.</p>
              </Link>
              <Link href="/docs/spec-creation" className="rounded-2xl border border-white/10 bg-black/20 p-4 hover:border-white/20 hover:bg-white/[0.04] transition-colors">
                <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">MCP</div>
                <div className="text-white font-medium mb-2">Explicit tool contract</div>
                <p className="text-sm text-zinc-400 leading-relaxed">Use the canonical create-spec and retrieval tools from clients and skills.</p>
              </Link>
              <Link href="/docs/tools" className="rounded-2xl border border-white/10 bg-black/20 p-4 hover:border-white/20 hover:bg-white/[0.04] transition-colors">
                <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Pi extension</div>
                <div className="text-white font-medium mb-2">Pi-native commands</div>
                <p className="text-sm text-zinc-400 leading-relaxed">Use /rorca-help, /rorca-create-spec, /rorca-run, and /rorca-watch inside Pi.</p>
              </Link>
            </div>
          </div>
        </section>
        <FeatureGrid />
        <div className="w-full h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent my-10" />
        <HowItWorks />
      </div>
      <Footer />
    </main>
  );
}
