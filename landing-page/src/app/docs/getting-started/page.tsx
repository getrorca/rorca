import type { Metadata } from 'next';
import Link from 'next/link';
import { buildMetadata, SITE_URL } from '@/lib/metadata';

export const metadata: Metadata = buildMetadata({
  title: 'Getting started',
  description: 'Install Rorca locally, understand the process model, and get from repo to a running dashboard, backend, and worker stack.',
  path: '/docs/getting-started',
  ogImage: `${SITE_URL}/og/home.png`,
});

const commands = [
  'npm install',
  'npm run dev',
  'npm run dev:full',
  'npm run dev:frontend',
  'npm run dev:server',
  'npm run dev:worker',
  'cd backend && npm run worker',
];

export default function DocsGettingStartedPage() {
  return (
    <div className="max-w-4xl">
      <div className="mb-10">
        <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-4">Getting started</p>
        <h1 className="text-4xl md:text-5xl font-medium tracking-tight mb-4">Run Rorca locally first.</h1>
        <p className="text-zinc-400 text-lg leading-relaxed max-w-3xl">
          The public website is a Next app in <code className="text-zinc-300">landing-page/</code>. The product you actually use day to day is the local Rorca stack: dashboard, backend, worker, CLI, and embedded TUI.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 mb-10">
        <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6">
          <h2 className="text-lg font-medium mb-3">What runs where</h2>
          <ul className="space-y-2 text-zinc-300 leading-relaxed">
            <li><strong className="text-white">Frontend dashboard</strong> — Vite app on <code className="text-zinc-300">:5210</code> in dev.</li>
            <li><strong className="text-white">Backend API + MCP</strong> — Express on <code className="text-zinc-300">:3030</code>.</li>
            <li><strong className="text-white">Landing page</strong> — Next app on <code className="text-zinc-300">:3002</code>.</li>
            <li><strong className="text-white">Worker</strong> — separate pg-boss process for queued runs and jobs.</li>
          </ul>
        </section>
        <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6">
          <h2 className="text-lg font-medium mb-3">Mental model</h2>
          <p className="text-zinc-300 leading-relaxed mb-3">
            Think in three layers: a local human-facing dashboard, a backend control plane, and a worker that executes queued work. Rorca’s CLI and embedded TUI sit on top of that same local system.
          </p>
          <p className="text-zinc-400 text-sm leading-relaxed">
            If you only remember one thing: the website explains the product, but the local stack is the product.
          </p>
        </section>
      </div>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-10">
        <h2 className="text-2xl font-medium mb-4">Commands that matter today</h2>
        <div className="rounded-xl border border-white/10 bg-black/30 p-4 font-mono text-sm text-zinc-300 overflow-x-auto">
          {commands.map((command) => (
            <div key={command} className="py-1">$ {command}</div>
          ))}
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 text-sm text-zinc-400">
          <p><code className="text-zinc-300">npm run dev</code> is the smart default. It starts the stack you need, or just the frontend if a healthy backend is already present.</p>
          <p><code className="text-zinc-300">cd backend && npm run worker</code> runs the worker supervisor directly when you want the full queued-job path under backend control.</p>
        </div>
      </section>

      <section className="mb-10">
        <h2 className="text-2xl font-medium mb-4">Quickstart path</h2>
        <ol className="space-y-4 text-zinc-300 leading-relaxed list-decimal list-inside">
          <li>Install dependencies and start the local stack.</li>
          <li>Open the dashboard and register your workspace.</li>
          <li>Create a spec either through the dashboard’s shared skill-first forge flow or through the explicit create-spec persistence path.</li>
          <li>Review and approve stories before execution.</li>
          <li>Run approved work through the provider CLI you selected.</li>
        </ol>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link href="/download" className="px-4 py-2 rounded-lg bg-white text-zinc-950 font-medium hover:bg-zinc-200 transition-colors">Install Rorca</Link>
        <Link href="/docs/spec-creation" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Spec creation docs</Link>
        <a href="https://github.com/getrorca/rorca#readme" target="_blank" rel="noreferrer" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">README</a>
      </div>
    </div>
  );
}
