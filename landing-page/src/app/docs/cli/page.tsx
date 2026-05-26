import type { Metadata } from 'next';
import Link from 'next/link';
import { buildMetadata, SITE_URL } from '@/lib/metadata';

export const metadata: Metadata = buildMetadata({
  title: 'CLI guide',
  description: 'In-depth Rorca CLI guide with execution-engine examples, flags, orchestration modes, and copy-paste operator workflows.',
  path: '/docs/cli',
  ogImage: `${SITE_URL}/og/home.png`,
});

const topLevelCommands = [
  ['rorca start', 'Start the local backend stack.'],
  ['rorca init', 'Scaffold a new workspace and local prerequisites.'],
  ['rorca forge <brief...>', 'Draft a spec through the shared forge path from the standalone CLI.'],
  ['rorca run <specSlug>', 'Run an approved spec through the selected execution CLI.'],
  ['rorca status', 'Inspect recent runs or one run in detail.'],
  ['rorca attach <runId>', 'Attach to an active run stream from the terminal.'],
  ['rorca tui', 'Open the embedded terminal UI.'],
  ['rorca chat', 'Open a Pi-backed Rorca chat session.'],
  ['rorca doctor', 'Check health, versions, tokens, backend, and local setup.'],
  ['rorca auth ...', 'Inspect or change provider authentication.'],
  ['rorca pi install', 'Install the bundled Pi extension.'],
  ['rorca mcp ...', 'Manage MCP tokens and Claude MCP setup.'],
  ['rorca db ...', 'Manage the optional Docker Postgres sidecar.'],
] as const;

const syntaxMatrix = [
  'rorca start [--port <port>] [--host <host>] [--no-db]',
  'rorca init [--path <dir>] [--auto-install-pi] [--skip-docker]',
  'rorca chat [--model <model>] [--workspace-id <id>]',
  'rorca forge <brief...> [--approve] [--run] [--agent <agent>] [--model <model>]',
  'rorca run <specSlug> [--story <id>] [--dry-run] [--agent <agent>] [--model <model>] [--sequential] [--tail]',
  'rorca status [--run-id <id>]',
  'rorca attach <runId>',
  'rorca doctor [--json] [--check <name>] [--verbose]',
  'rorca auth status|login|logout|install',
  'rorca pi install [--global]',
  'rorca mcp token [--admin]',
  'rorca mcp setup-claude [--admin]',
  'rorca mcp rotate-token [--public|--admin|--all]',
  'rorca mcp status',
  'rorca mcp diagnose-clients',
  'rorca db start|stop|status',
  'rorca db reset [--yes]',
  'rorca db logs [--tail <lines>]',
] as const;

const runFlags = [
  ['--story <id>', 'Run exactly one story from the approved spec. Best debugging path when isolating a failure.'],
  ['--dry-run', 'Return the estimated run cost/shape without executing stories.'],
  ['--agent <agent>', 'Execution CLI override: claude, opencode, codex, or pi.'],
  ['--model <model>', 'Runtime model override for the selected execution CLI.'],
  ['--sequential', 'Force sequential execution by sending forceSequential / parallelism=1.'],
  ['--tail', 'Tail raw run output alongside lifecycle updates while attached.'],
] as const;

const forgeFlags = [
  ['--approve', 'Approve the drafted spec after forge completes.'],
  ['--run', 'Approve and immediately trigger execution after forge completes.'],
  ['--agent <agent>', 'Forge drafting engine override: claude, opencode, codex, or pi.'],
  ['--model <model>', 'Forge model override for the drafting step.'],
] as const;

const startFlags = [
  ['--port <port>', 'Backend port override. Defaults to 3030.'],
  ['--host <host>', 'Backend bind host. Defaults to 127.0.0.1.'],
  ['--no-db', 'Skip Docker sidecar management when you already have Postgres.'],
] as const;

const doctorFlags = [
  ['--json', 'Emit machine-readable doctor output.'],
  ['--check <name>', 'Run one named doctor check instead of the full suite.'],
  ['--verbose', 'Print additional doctor detail.'],
] as const;

const authCommands = [
  'rorca auth status',
  'rorca auth login [provider]',
  'rorca auth logout [provider]',
  'rorca auth install',
] as const;

const mcpCommands = [
  'rorca mcp token [--admin]',
  'rorca mcp setup-claude [--admin]',
  'rorca mcp rotate-token [--public|--admin|--all]',
  'rorca mcp status',
  'rorca mcp diagnose-clients',
] as const;

const dbCommands = [
  'rorca db start',
  'rorca db stop',
  'rorca db status',
  'rorca db reset --yes',
  'rorca db logs --tail 200',
] as const;

const engineExamples = [
  {
    title: 'Claude Code CLI',
    body: 'Use Claude as the execution engine when you want Claude Code to do the story work under Rorca orchestration.',
    example: `rorca run zz-my-spec --agent claude`,
  },
  {
    title: 'Codex CLI',
    body: 'Use Codex when you want ChatGPT Plus/Pro-backed CLI execution and optional model override.',
    example: `rorca run zz-my-spec --agent codex --model gpt-5.4`,
  },
  {
    title: 'OpenCode',
    body: 'Use OpenCode when you want its provider/model bridge as the execution runtime.',
    example: `rorca run zz-my-spec --agent opencode --model openai/gpt-4.1`,
  },
  {
    title: 'Pi',
    body: 'Use Pi when you want Pi CLI execution instead of the Pi extension operator surface.',
    example: `rorca run zz-my-spec --agent pi --model openai-codex/gpt-5.4`,
  },
] as const;

function FlagTable({ items }: { items: readonly (readonly [string, string])[] }) {
  return (
    <div className="space-y-3">
      {items.map(([flag, desc]) => (
        <div key={flag} className="rounded-xl border border-white/10 bg-black/20 p-4">
          <code className="block text-sm text-white font-mono break-words">{flag}</code>
          <p className="mt-2 text-sm text-zinc-400 leading-relaxed">{desc}</p>
        </div>
      ))}
    </div>
  );
}

export default function DocsCliPage() {
  return (
    <div className="max-w-5xl">
      <div className="mb-10">
        <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-4">CLI guide</p>
        <h1 className="text-4xl md:text-5xl font-medium tracking-tight mb-4">The standalone CLI is the clearest operator surface.</h1>
        <p className="text-zinc-400 text-lg leading-relaxed max-w-4xl">
          Use the Rorca CLI when you want explicit, scriptable control over setup, forge, execution, attach, doctor, auth, MCP, and local DB workflows. The CLI is the best surface for dense, repeatable operator behavior outside the browser and outside Pi.
        </p>
      </div>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Mental model</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Setup</div>
            <p className="text-zinc-400 leading-relaxed">Bring up the local control plane with <code className="text-zinc-300">rorca start</code> or scaffold with <code className="text-zinc-300">rorca init</code>.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Spec loop</div>
            <p className="text-zinc-400 leading-relaxed">Use <code className="text-zinc-300">rorca forge</code> to draft, then <code className="text-zinc-300">rorca run</code> to execute approved work.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Live operations</div>
            <p className="text-zinc-400 leading-relaxed">Use <code className="text-zinc-300">rorca status</code>, <code className="text-zinc-300">rorca attach</code>, and <code className="text-zinc-300">rorca doctor</code> while runs are active or when debugging.</p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Top-level command map</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {topLevelCommands.map(([cmd, desc]) => (
            <div key={cmd} className="rounded-xl border border-white/10 bg-black/20 p-4">
              <code className="block text-sm text-white font-mono break-words">{cmd}</code>
              <p className="mt-2 text-sm text-zinc-400 leading-relaxed">{desc}</p>
            </div>
          ))}
        </div>
        <div className="mt-6 rounded-xl border border-white/10 bg-black/30 p-4">
          <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Full syntax matrix</div>
          <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{syntaxMatrix.join('\n')}</code></pre>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Execution CLI examples</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {engineExamples.map((item) => (
            <div key={item.title} className="rounded-xl border border-white/10 bg-black/20 p-4">
              <div className="text-white font-medium mb-2">{item.title}</div>
              <p className="text-sm text-zinc-400 leading-relaxed mb-3">{item.body}</p>
              <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{item.example}</code></pre>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">`rorca run` in depth</h2>
        <p className="text-zinc-300 leading-relaxed mb-4">
          <code className="text-zinc-300">rorca run &lt;specSlug&gt;</code> is the main execution entry point from the standalone CLI. It resolves the approved spec, infers the workspace from that spec slug, triggers the backend run, and attaches live output.
        </p>
        <div className="rounded-xl border border-white/10 bg-black/30 p-4 font-mono text-sm text-zinc-200 overflow-x-auto mb-4">
          rorca run &lt;specSlug&gt; [--story &lt;id&gt;] [--dry-run] [--agent &lt;agent&gt;] [--model &lt;model&gt;] [--sequential] [--tail]
        </div>
        <FlagTable items={runFlags} />
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Single-story debug run</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`rorca run bullmq-worker-containers-coolify-fast-import-parallelism \
  --story ING-001 \
  --agent pi \
  --model openai-codex/gpt-5.4 \
  --sequential`}</code></pre>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Full-spec Codex run</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`rorca run categoric-autonomous-accounting-suite \
  --agent codex \
  --model gpt-5.4`}</code></pre>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Dry run only</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`rorca run zz-my-spec --dry-run --agent claude`}</code></pre>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Tail-heavy troubleshooting</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`rorca run zz-my-spec --agent opencode --tail`}</code></pre>
          </div>
        </div>
        <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-zinc-200 leading-relaxed">
          Current CLI caveat: <code className="text-zinc-100">rorca run</code> does not yet take an explicit <code className="text-zinc-100">--workspace</code> flag. It resolves the workspace from the approved spec slug, so duplicate slugs across workspaces are a real ambiguity to avoid.
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Sequential vs wave-parallel</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-white font-medium mb-2">Sequential</div>
            <p className="text-zinc-400 leading-relaxed mb-3">One story at a time. Best for first debugging passes, risky refactors, ambiguous repo state, or when you want simpler logs and fewer moving parts.</p>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>rorca run zz-my-spec --sequential</code></pre>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-white font-medium mb-2">Wave-parallel</div>
            <p className="text-zinc-400 leading-relaxed mb-3">Rorca groups stories into dependency-safe waves and runs independent stories concurrently when allowed by the spec graph and orchestration config.</p>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>rorca run zz-my-spec --agent codex</code></pre>
          </div>
        </div>
        <ul className="mt-4 space-y-2 text-zinc-300 leading-relaxed">
          <li><strong className="text-white">Use sequential</strong> when reproducing one flaky story, chasing no-code-change failures, or minimizing concurrency variables.</li>
          <li><strong className="text-white">Use wave-parallel</strong> when the spec has real independent branches and you want throughput.</li>
          <li><strong className="text-white">Single-story runs</strong> are already effectively sequential, but <code className="text-zinc-300">--sequential</code> still makes your intent explicit.</li>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">`rorca forge` in depth</h2>
        <div className="rounded-xl border border-white/10 bg-black/30 p-4 font-mono text-sm text-zinc-200 overflow-x-auto mb-4">
          rorca forge &lt;brief...&gt; [--approve] [--run] [--agent &lt;agent&gt;] [--model &lt;model&gt;]
        </div>
        <FlagTable items={forgeFlags} />
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Draft only</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`rorca forge "Add lightweight export audit stories" --agent codex --model gpt-5.4`}</code></pre>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Draft, approve, and run</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`rorca forge "Build a retry-safe ingestion queue" --approve --run --agent pi --model openai-codex/gpt-5.4`}</code></pre>
          </div>
        </div>
      </section>

      <section className="grid gap-8 lg:grid-cols-2 mb-8">
        <div className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6">
          <h2 className="text-2xl font-medium mb-4">Setup, doctor, and support commands</h2>
          <div className="space-y-6">
            <div>
              <div className="text-white font-medium mb-3">`rorca start` flags</div>
              <FlagTable items={startFlags} />
            </div>
            <div>
              <div className="text-white font-medium mb-3">`rorca doctor` flags</div>
              <FlagTable items={doctorFlags} />
            </div>
          </div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6">
          <h2 className="text-2xl font-medium mb-4">Auth, MCP, and DB helpers</h2>
          <div className="space-y-5 text-zinc-300 leading-relaxed">
            <div>
              <div className="text-white font-medium mb-2">Auth</div>
              <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{authCommands.join('\n')}</code></pre>
            </div>
            <div>
              <div className="text-white font-medium mb-2">MCP</div>
              <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{mcpCommands.join('\n')}</code></pre>
            </div>
            <div>
              <div className="text-white font-medium mb-2">DB sidecar</div>
              <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{dbCommands.join('\n')}</code></pre>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-10">
        <h2 className="text-2xl font-medium mb-4">Attach, status, and review loop</h2>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-white font-medium mb-2">Status</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`rorca status
rorca status --run-id 20260316000319`}</code></pre>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-white font-medium mb-2">Attach</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>rorca attach 20260316000319</code></pre>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-white font-medium mb-2">TUI handoff</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`rorca tui
# board/watch workflows live there`}</code></pre>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link href="/docs/tui" className="px-4 py-2 rounded-lg bg-white text-zinc-950 font-medium hover:bg-zinc-200 transition-colors">TUI guide</Link>
        <Link href="/docs/pi-extension" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Pi extension guide</Link>
        <Link href="/docs/execution" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Execution guide</Link>
      </div>
    </div>
  );
}
