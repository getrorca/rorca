import type { Metadata } from 'next';
import Link from 'next/link';
import { buildMetadata, SITE_URL } from '@/lib/metadata';

export const metadata: Metadata = buildMetadata({
  title: 'Tools & commands',
  description: 'Reference index for the Rorca CLI, embedded TUI, MCP tools, and Pi extension, with links into the dense operator guides.',
  path: '/docs/tools',
  ogImage: `${SITE_URL}/og/home.png`,
});

const cliCommands = [
  { cmd: 'rorca start', desc: 'Start the local stack.' },
  { cmd: 'rorca init', desc: 'Scaffold a new workspace.' },
  { cmd: 'rorca tui', desc: 'Open the embedded terminal UI.' },
  { cmd: 'rorca forge <brief...>', desc: 'Generate a spec from a brief.' },
  { cmd: 'rorca run <specSlug>', desc: 'Run an approved spec.' },
  { cmd: 'rorca status [runId]', desc: 'Inspect run status or recent runs.' },
  { cmd: 'rorca attach <runId>', desc: 'Attach to a running story stream.' },
  { cmd: 'rorca doctor', desc: 'Check local dependencies and health.' },
  { cmd: 'rorca chat', desc: 'Open a Pi-powered Rorca chat session.' },
  { cmd: 'rorca pi install [--global]', desc: 'Install the bundled Rorca Pi extension into Pi.' },
  { cmd: 'rorca auth status|login|logout|install', desc: 'Manage provider auth.' },
  { cmd: 'rorca mcp token|setup-claude|rotate-token|status|diagnose-clients', desc: 'Manage MCP bridge auth and setup.' },
  { cmd: 'rorca db start|stop|status|reset|logs', desc: 'Manage the optional Docker Postgres sidecar.' },
];

const tuiShortcuts = [
  { key: 'w / Enter', desc: 'Watch the selected running board item.' },
  { key: 'r', desc: 'Run the selected approved spec from the board.' },
  { key: 'a', desc: 'Approve the selected pending spec from the board.' },
  { key: 's', desc: 'Open the workspace picker.' },
  { key: 'Esc', desc: 'Toggle between board and live stream when attached.' },
  { key: 'b', desc: 'Return from a live stream to the board.' },
  { key: 'Tab', desc: 'Cycle combined run and story substreams.' },
  { key: '0', desc: 'Select the combined run stream.' },
  { key: '1-9', desc: 'Select a specific story substream.' },
];

const mcpGroups = [
  {
    title: 'Specs & pipeline',
    tools: [
      'rorca_get_context',
      'rorca_create_spec',
      'rorca_generate_spec',
      'rorca_persist_spec',
      'rorca_list_specs',
      'rorca_approve_spec',
      'rorca_pipeline_status',
      'rorca_trigger_run',
      'rorca_run_status',
      'rorca_list_runs',
      'rorca_retry_story',
      'rorca_usage_stats',
    ],
  },
  {
    title: 'Story editing',
    tools: ['rorca_edit_story', 'rorca_add_stories', 'rorca_delete_story', 'rorca_search_stories'],
  },
  {
    title: 'Direction stack',
    tools: ['rorca_get_direction', 'rorca_update_direction', 'rorca_synthesize_direction'],
  },
  {
    title: 'Workspaces',
    tools: ['rorca_list_workspaces', 'rorca_create_workspace', 'rorca_workspace_stats', 'rorca_team_members'],
  },
  {
    title: 'Memory',
    tools: ['rorca_save_memory', 'rorca_log_decision', 'rorca_get_memories'],
  },
];

const piCommands = [
  { cmd: 'rorca pi install', desc: 'Install the bundled extension into the current Pi project.' },
  { cmd: 'pi install ./packages/rorca-pi-extension -l', desc: 'Advanced/dev fallback install path.' },
  { cmd: 'pi --no-extensions -e ./packages/rorca-pi-extension/extensions/rorca/index.ts', desc: 'Run the extension directly during development.' },
  { cmd: '/rorca-help', desc: 'Print the extension command list.' },
  { cmd: '/rorca-create-spec <brief|@file> [--workspace <id>] [--approve] [--run] [--queue] [--model <model>]', desc: 'Preferred skill-first create-spec command.' },
  { cmd: '/rorca-approve <spec-slug> [--workspace <id>]', desc: 'Approve a spec.' },
  { cmd: '/rorca-run <spec-slug> [--workspace <id>] [--story <id>] [--queue] [--model <model>] [--sequential] [--no-watch]', desc: 'Trigger an approved spec with Pi.' },
  { cmd: '/rorca-status [runId|workspaceId] [--workspace <id>]', desc: 'Inspect one run or recent runs.' },
  { cmd: '/rorca-watch [runId]', desc: 'Watch the latest or specified run.' },
  { cmd: '/rorca-attach [runId]', desc: 'Alias for /rorca-watch.' },
  { cmd: '/rorca-retry <runId> [storyId...] [--sequential] [--no-watch]', desc: 'Retry failed stories in a run.' },
  { cmd: '/rorca-mcp-status', desc: 'Check MCP bridge status.' },
];

function CodeList({ items }: { items: Array<{ cmd: string; desc: string }> }) {
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

export default function DocsToolsPage() {
  return (
    <div className="max-w-4xl">
      <div className="mb-10">
        <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-4">Reference</p>
        <h1 className="text-4xl md:text-5xl font-medium tracking-tight mb-4">Tools & commands</h1>
        <p className="text-zinc-400 text-lg leading-relaxed max-w-3xl">
          This page is the cross-surface index. Use it to find the command names quickly, then jump into the dedicated in-depth guides for the CLI, embedded TUI, and Pi extension when you need the full operator story.
        </p>
      </div>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Read these deep guides next</h2>
        <div className="grid gap-4 md:grid-cols-3 mb-8">
          <Link href="/docs/cli" className="rounded-xl border border-white/10 bg-black/20 p-4 hover:border-zinc-700 transition-colors">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">CLI</div>
            <div className="text-white font-medium mb-2">Standalone operator guide</div>
            <p className="text-zinc-400 leading-relaxed">Flags, engine examples, sequential mode, forge/run patterns, attach, doctor, auth, MCP, and DB helpers.</p>
          </Link>
          <Link href="/docs/tui" className="rounded-xl border border-white/10 bg-black/20 p-4 hover:border-zinc-700 transition-colors">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">TUI</div>
            <div className="text-white font-medium mb-2">Embedded control-room guide</div>
            <p className="text-zinc-400 leading-relaxed">Board mode, live substreams, model picker, recall, and story editing in the terminal UI.</p>
          </Link>
          <Link href="/docs/pi-extension" className="rounded-xl border border-white/10 bg-black/20 p-4 hover:border-zinc-700 transition-colors">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Pi extension</div>
            <div className="text-white font-medium mb-2">Pi-native slash-command guide</div>
            <p className="text-zinc-400 leading-relaxed">Install, reload, run, retry, watch, status, sequential mode, and Pi-specific execution caveats.</p>
          </Link>
        </div>
        <h2 className="text-2xl font-medium mb-4">Which surface should I use?</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Local operator surface</div>
            <div className="text-white font-medium mb-2">Rorca CLI + embedded TUI</div>
            <p className="text-zinc-400 leading-relaxed">Use the CLI for setup, runs, auth, and diagnostics. Use <code className="text-zinc-300">rorca tui</code> when you want board, live stream, and workspace switching in one terminal UI.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Machine-facing contract</div>
            <div className="text-white font-medium mb-2">MCP tools</div>
            <p className="text-zinc-400 leading-relaxed">Use MCP when a client or skill should explicitly call Rorca tools. The preferred spec-authoring path is <code className="text-zinc-300">rorca_create_spec</code> for explicit draft persistence; <code className="text-zinc-300">rorca_generate_spec</code> remains available as a backend-drafting fallback.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Pi-native operator surface</div>
            <div className="text-white font-medium mb-2">Pi extension</div>
            <p className="text-zinc-400 leading-relaxed">Use Pi slash commands when you are already inside Pi. The extension can create specs, run them, watch output, and bridge into MCP when available.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Best first command</div>
            <div className="text-white font-medium mb-2"><code className="text-zinc-300">rorca_help</code> / <code className="text-zinc-300">/rorca-help</code></div>
            <p className="text-zinc-400 leading-relaxed">If you only remember one thing, start with the help command on the surface you are using.</p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Auth model + provider matrix</h2>
        <p className="text-zinc-400 leading-relaxed mb-6">
          Rorca supports both subscription-backed CLIs and API-key-backed providers. In the UI, the settings screen uses <strong className="text-white">BYOA</strong> (Bring Your Own Auth) as the product-level label; public docs can describe that as the user bringing their own subscription or key depending on the provider.
        </p>
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

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Copy-paste examples</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">CLI</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`rorca start
rorca tui
rorca forge "Add a docs-only story"
rorca run zz-my-spec --agent codex --model gpt-5.4
rorca run zz-my-spec --story US-001 --sequential`}</code></pre>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">TUI</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`rorca tui
# board: w to watch
# board/live: s to switch workspace
# live: Tab to cycle streams`}</code></pre>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">MCP</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`# preferred explicit-draft flow
Tool: rorca_create_spec
workspaceId: rorca
title: Add a docs-only story
stories: [...]`}</code></pre>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Pi extension</div>
            <pre className="overflow-x-auto text-sm text-zinc-200 leading-relaxed"><code>{`/rorca-create-spec @brief.md --workspace rorca --approve --run
/rorca-run zz-my-spec --workspace rorca --story US-001 --sequential
/rorca-watch
/rorca-status`}</code></pre>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">CLI reference</h2>
        <CodeList items={cliCommands} />
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">TUI shortcuts</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {tuiShortcuts.map((item) => (
            <div key={item.key} className="rounded-xl border border-white/10 bg-black/20 p-4">
              <div className="text-white font-mono text-sm mb-1">{item.key}</div>
              <p className="text-sm text-zinc-400 leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm text-zinc-400 leading-relaxed">
          The TUI board now supports direct watch from selected runs, live stream ↔ board navigation, story substream cycling, and workspace switching without relaunching from a different directory.
        </p>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">MCP tools</h2>
        <p className="text-zinc-400 leading-relaxed mb-6">
          These are the backend tools exposed through the MCP HTTP surface and bridged into supported clients. The live list is also visible from <code className="text-zinc-300">GET /api/mcp/tools</code>. Not every tool has equal priority in day-to-day flows: some are canonical, some remain compatibility aliases, and some are legacy fallbacks.
        </p>
        <div className="space-y-6">
          {mcpGroups.map((group) => (
            <div key={group.title}>
              <h3 className="text-lg font-medium text-white mb-3">{group.title}</h3>
              <div className="flex flex-wrap gap-2">
                {group.tools.map((tool) => (
                  <span key={tool} className="inline-flex items-center rounded-full border border-white/10 bg-black/20 px-3 py-1 text-sm text-zinc-300 font-mono">
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-6 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm text-zinc-200 leading-relaxed space-y-2">
          <p><strong className="text-zinc-100">Preferred:</strong> fetch context if needed, draft in the caller/skill, then persist with <code className="text-zinc-100">rorca_create_spec</code>.</p>
          <p><strong className="text-zinc-100">Compatibility alias:</strong> <code className="text-zinc-100">rorca_persist_spec</code> points at the same explicit-draft persistence path.</p>
          <p><strong className="text-zinc-100">Legacy/fallback:</strong> <code className="text-zinc-100">rorca_generate_spec</code> still exists when you explicitly want Rorca to draft server-side, but it is no longer the primary product-wide authoring flow.</p>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-10">
        <h2 className="text-2xl font-medium mb-4">Pi extension commands</h2>
        <p className="text-zinc-400 leading-relaxed mb-6">
          Install the extension with <code className="text-zinc-300">rorca pi install</code>. If Pi was already open, run <code className="text-zinc-300">/reload</code>; if commands still do not appear, restart Pi. The raw <code className="text-zinc-300">pi install ./packages/rorca-pi-extension -l</code> path remains available for advanced/dev use. Deprecated compatibility aliases like <code className="text-zinc-300">/rorca-forge</code> and <code className="text-zinc-300">/rorca-forge-run</code> now forward to the same skill-first flow but are no longer the public command story.
        </p>
        <CodeList items={piCommands} />
      </section>

      <div className="flex flex-wrap gap-3">
        <Link href="/docs/spec-creation" className="px-4 py-2 rounded-lg bg-white text-zinc-950 font-medium hover:bg-zinc-200 transition-colors">Spec creation</Link>
        <Link href="/docs/architecture" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Architecture</Link>
        <Link href="/docs/execution" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Execution</Link>
      </div>
    </div>
  );
}
