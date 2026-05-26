import type { Metadata } from 'next';
import Link from 'next/link';
import { buildMetadata, SITE_URL } from '@/lib/metadata';

export const metadata: Metadata = buildMetadata({
  title: 'Pi extension guide',
  description: 'In-depth guide to the Rorca Pi extension: install, slash commands, flags, model selection, run/watch/retry flows, and execution caveats.',
  path: '/docs/pi-extension',
  ogImage: `${SITE_URL}/og/home.png`,
});

const installSteps = [
  'rorca pi install',
  '/reload',
  '# restart Pi if commands still do not appear',
] as const;

const commandCards = [
  {
    cmd: '/rorca-create-spec <brief|@file> [--workspace <id>] [--approve] [--run] [--queue] [--model <model>]',
    desc: 'Preferred skill-first spec creation path from inside Pi.',
  },
  {
    cmd: '/rorca-approve <spec-slug> [--workspace <id>]',
    desc: 'Approve one pending spec.',
  },
  {
    cmd: '/rorca-run <spec-slug> [--workspace <id>] [--story <id>] [--queue] [--model <model>] [--sequential] [--no-watch]',
    desc: 'Trigger an approved spec with Pi as the execution engine.',
  },
  {
    cmd: '/rorca-status [runId|workspaceId] [--workspace <id>]',
    desc: 'Inspect one run or list recent runs in a workspace.',
  },
  {
    cmd: '/rorca-watch [runId]',
    desc: 'Start watching the latest known run or a specific run id.',
  },
  {
    cmd: '/rorca-attach [runId]',
    desc: 'Alias for /rorca-watch.',
  },
  {
    cmd: '/rorca-retry <runId> [storyId...] [--sequential] [--no-watch]',
    desc: 'Retry failed stories from a prior run.',
  },
  {
    cmd: '/rorca-mcp-status',
    desc: 'Check the Rorca MCP bridge from inside Pi.',
  },
] as const;

const runFlags = [
  ['--workspace <id>', 'Choose a workspace explicitly instead of using the last known workspace or Pi workspace prompt flow.'],
  ['--story <id>', 'Run one story only. Best debugging path for reproducible failures.'],
  ['--queue', 'Queue the run instead of immediately watching the foreground run.'],
  ['--model <model>', 'Override the Pi runtime model.'],
  ['--sequential', 'Force sequential execution for the run.'],
  ['--no-watch', 'Do not auto-start the watch UI after triggering the run.'],
] as const;

const retryFlags = [
  ['storyId...', 'Limit the retry to one or more failed story ids.'],
  ['--sequential', 'Force the retry run to execute sequentially.'],
  ['--no-watch', 'Do not automatically start watching the retried run.'],
] as const;

function CodeList({ items }: { items: readonly { cmd: string; desc: string }[] }) {
  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item.cmd} className="rounded-xl border border-white/10 bg-black/20 p-4">
          <code className="block text-sm text-white font-mono break-words">{item.cmd}</code>
          <p className="mt-2 text-sm text-zinc-400 leading-relaxed">{item.desc}</p>
        </li>
      ))}
    </ul>
  );
}

function FlagGrid({ items }: { items: readonly (readonly [string, string])[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {items.map(([flag, desc]) => (
        <div key={flag} className="rounded-xl border border-white/10 bg-black/20 p-4">
          <code className="block text-sm text-white font-mono break-words">{flag}</code>
          <p className="mt-2 text-sm text-zinc-400 leading-relaxed">{desc}</p>
        </div>
      ))}
    </div>
  );
}

export default function DocsPiExtensionPage() {
  return (
    <div className="max-w-5xl">
      <div className="mb-10">
        <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-4">Pi extension guide</p>
        <h1 className="text-4xl md:text-5xl font-medium tracking-tight mb-4">The Pi extension is a Pi-native operator surface, not the executor selector.</h1>
        <p className="text-zinc-400 text-lg leading-relaxed max-w-4xl">
          Use the Pi extension when you are already working inside Pi and want Rorca slash commands for create-spec, approve, run, watch, retry, and MCP bridge status. The extension gives you a Pi-native operator UX on top of the same backend contract used by the dashboard, CLI, and TUI.
        </p>
      </div>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Install + reload</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Preferred path</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{installSteps.join('\n')}</code></pre>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Advanced/dev fallback</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`pi install ./packages/rorca-pi-extension -l
# for dev-only direct execution:
pi --no-extensions -e ./packages/rorca-pi-extension/extensions/rorca/index.ts`}</code></pre>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Mental model</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="text-white font-medium mb-2">Pi extension</div><p className="text-zinc-400 leading-relaxed">Slash-command operator surface inside Pi.</p></div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="text-white font-medium mb-2">Pi CLI</div><p className="text-zinc-400 leading-relaxed">One execution runtime provider that Rorca can use for stories.</p></div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4"><div className="text-white font-medium mb-2">Rorca backend</div><p className="text-zinc-400 leading-relaxed">Owns spec persistence, pipeline state, retry logic, runs, watch state, and MCP bridge operations.</p></div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Command surface</h2>
        <CodeList items={commandCards} />
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">`/rorca-run` in depth</h2>
        <div className="rounded-xl border border-white/10 bg-black/30 p-4 font-mono text-sm text-zinc-200 overflow-x-auto mb-4">
          /rorca-run &lt;spec-slug&gt; [--workspace &lt;id&gt;] [--story &lt;id&gt;] [--queue] [--model &lt;model&gt;] [--sequential] [--no-watch]
        </div>
        <FlagGrid items={runFlags} />
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Single-story debug run</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`/rorca-run bullmq-worker-containers-coolify-fast-import-parallelism \
  --workspace cashflow \
  --story ING-001 \
  --model openai-codex/gpt-5.4 \
  --sequential`}</code></pre>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Queued foreground-safe run</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`/rorca-run zz-my-spec --workspace rorca --queue --no-watch`}</code></pre>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">`/rorca-retry` in depth</h2>
        <div className="rounded-xl border border-white/10 bg-black/30 p-4 font-mono text-sm text-zinc-200 overflow-x-auto mb-4">
          /rorca-retry &lt;runId&gt; [storyId...] [--sequential] [--no-watch]
        </div>
        <FlagGrid items={retryFlags} />
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Retry every failed story</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>/rorca-retry 20260316000319</code></pre>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Retry one story sequentially</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>/rorca-retry 20260316000319 ING-001 --sequential</code></pre>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Create-spec, approve, watch, and status flows</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Preferred skill-first create-spec flow</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`/rorca-create-spec @brief.md --workspace cashflow --approve --run --model openai-codex/gpt-5.4`}</code></pre>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Approve only</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>/rorca-approve zz-my-spec --workspace cashflow</code></pre>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Watch latest run</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`/rorca-watch
/rorca-attach`}</code></pre>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Inspect one run</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`/rorca-status 20260316000319
/rorca-status --workspace cashflow`}</code></pre>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Model selection and execution truth</h2>
        <div className="space-y-4 text-zinc-300 leading-relaxed">
          <p><strong className="text-white">What you can choose from the Pi extension:</strong> the runtime model via <code className="text-zinc-300">--model</code>.</p>
          <p><strong className="text-white">What the extension does not choose today:</strong> Claude Code CLI vs Codex CLI vs OpenCode as the executor. The Pi extension’s run surface triggers Pi-backed execution specifically.</p>
          <p><strong className="text-white">If you want Claude, Codex, or OpenCode execution instead:</strong> use the standalone Rorca CLI, the dashboard run controls, the TUI, or the backend API trigger surface.</p>
        </div>
        <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-zinc-200 leading-relaxed">
          Important distinction: the <strong className="text-white">Pi extension</strong> is an operator surface. The <strong className="text-white">Pi CLI</strong> is one execution engine. The extension is not the cross-engine chooser.
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-10">
        <h2 className="text-2xl font-medium mb-4">Sequential vs wave-parallel from Pi</h2>
        <ul className="space-y-2 text-zinc-300 leading-relaxed">
          <li><strong className="text-white">Sequential</strong> is the right debugging move when you want fewer concurrency variables, easier logs, or a one-story reproduction.</li>
          <li><strong className="text-white">Wave-parallel</strong> remains the default backend orchestration story when the dependency graph allows it and you do not force sequential mode.</li>
          <li><strong className="text-white">Retries</strong> can now also be forced sequentially from inside Pi with <code className="text-zinc-300">/rorca-retry ... --sequential</code>.</li>
        </ul>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link href="/docs/cli" className="px-4 py-2 rounded-lg bg-white text-zinc-950 font-medium hover:bg-zinc-200 transition-colors">CLI guide</Link>
        <Link href="/docs/tui" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">TUI guide</Link>
        <Link href="/docs/execution" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Execution guide</Link>
      </div>
    </div>
  );
}
