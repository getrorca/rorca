import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { buildMetadata, SITE_URL } from '@/lib/metadata';

export const metadata: Metadata = buildMetadata({
  title: 'GitHub integration guide',
  description: 'Connect a workspace repository, configure webhooks, enable auto-PR, dispatch GitHub Actions workflows, tune CI autofix, and customize PR templates.',
  path: '/docs/github',
  ogImage: `${SITE_URL}/og/home.png`,
});

const webhookEvents = ['push', 'pull_request', 'issues', 'check_run'] as const;

const prVariables = [
  '{{spec.title}}',
  '{{spec.brief}}',
  '{{run.id}}',
  '{{run.storiesPassed}}',
  '{{run.storiesTotal}}',
  '{{run.storiesFailed}}',
  '{{run.storiesSkipped}}',
  '{{run.tokensInput}}',
  '{{run.tokensOutput}}',
  '{{run.tokensTotal}}',
  '{{run.costUsd}}',
  '{{run.duration}}',
  '{{run.agentType}}',
  '{{run.model}}',
  '{{run.diffStats}}',
  '{{run.diffSummary}}',
] as const;

export default function DocsGitHubPage() {
  return (
    <div className="max-w-5xl">
      <div className="mb-10">
        <p className="text-xs uppercase tracking-[0.24em] text-zinc-500 mb-4">GitHub integration guide</p>
        <h1 className="text-4xl md:text-5xl font-medium tracking-tight mb-4">GitHub in Rorca is three things: identity, repository wiring, and automation.</h1>
        <p className="text-zinc-400 text-lg leading-relaxed max-w-4xl">
          The GitHub settings page mixes a few different concepts on purpose: your user-level GitHub account connection, the workspace-to-repository webhook connection, and optional automation layers like auto-PRs, workflow dispatch, CI autofix, and PR templates. This guide explains what each section actually controls.
        </p>
      </div>

      <figure className="mb-10 overflow-hidden rounded-2xl border border-white/10 bg-zinc-950/70 p-2 shadow-2xl shadow-black/30">
        <Image
          src="/docs-images/product-surfaces/github-settings.png"
          alt="Real screenshot of the GitHub settings page showing GitHub account, workspace repository connection, Actions workflow download, workflows, CI autofix, and PR description template sections."
          width={1600}
          height={1557}
          priority
          sizes="(min-width: 1024px) 896px, 100vw"
          className="h-auto w-full rounded-xl"
        />
        <figcaption className="px-3 pb-2 pt-3 text-sm text-zinc-500">
          The real GitHub settings surface in Rorca: one page for account status, repo webhook setup, and post-run automation controls.
        </figcaption>
      </figure>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Keep these three layers separate</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <h3 className="font-medium text-white mb-2">GitHub account</h3>
            <p className="text-zinc-400 leading-relaxed">Your user-level GitHub identity, scopes, token validation, and account disconnect state.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <h3 className="font-medium text-white mb-2">Workspace repository</h3>
            <p className="text-zinc-400 leading-relaxed">The repository webhook connection for one workspace, including repo owner, repo name, webhook id, and inbound events.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <h3 className="font-medium text-white mb-2">Automation on top</h3>
            <p className="text-zinc-400 leading-relaxed">Auto-PR creation, workflow dispatch, CI autofix, and PR description templating build on top of the repo connection.</p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">GitHub Account</h2>
        <p className="text-zinc-300 leading-relaxed mb-4">
          This section is about your connected GitHub identity, not about which repository a workspace uses. That distinction matters: a workspace can be wired to a repository even when the visible user account card says no GitHub account is connected.
        </p>
        <ul className="space-y-2 text-zinc-300 leading-relaxed list-disc list-inside mb-4">
          <li><strong className="text-white">Connected account card:</strong> shows username, avatar, connect date, granted scopes, and token test status.</li>
          <li><strong className="text-white">Test:</strong> validates the current account token so you can see whether GitHub still accepts it.</li>
          <li><strong className="text-white">Disconnect:</strong> removes the user-level GitHub account connection without automatically describing or removing every workspace-level repository automation choice.</li>
        </ul>
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-zinc-200 leading-relaxed">
          Important: the page intentionally tells you that workspace GitHub integration is configured separately from user sign-in. That is not an error state. It means identity and repository wiring are modeled separately.
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Workspace Repository</h2>
        <p className="text-zinc-300 leading-relaxed mb-4">
          This is the section that actually connects a workspace to a GitHub repository. It creates the webhook Rorca uses to receive GitHub events and enables the rest of the repository-driven GitHub features.
        </p>
        <div className="grid gap-4 lg:grid-cols-2 mb-4">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Connect form</div>
            <ul className="space-y-2 text-sm text-zinc-300 leading-relaxed list-disc list-inside">
              <li><code className="text-zinc-200">Repo owner</code> and <code className="text-zinc-200">Repo name</code> identify the target repository.</li>
              <li>A GitHub personal access token with <code className="text-zinc-200">admin:repo_hook</code> scope is used to register the webhook.</li>
              <li>The token is used for webhook setup and is not stored as the persistent repository-connection token.</li>
            </ul>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Connected state</div>
            <ul className="space-y-2 text-sm text-zinc-300 leading-relaxed list-disc list-inside">
              <li>Shows repository name, webhook id, initial connect time, and last webhook activity.</li>
              <li>If a webhook id is present, Rorca considers inbound GitHub event delivery configured.</li>
              <li>If the webhook is missing, GitHub-triggered automation will not fire even if other settings are enabled.</li>
            </ul>
          </div>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/20 p-4 mb-4">
          <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Webhook events Rorca expects</div>
          <div className="flex flex-wrap gap-2">
            {webhookEvents.map((event) => (
              <span key={event} className="inline-flex items-center rounded-full border border-white/10 bg-zinc-900 px-3 py-1 text-xs font-mono text-zinc-300">
                {event}
              </span>
            ))}
          </div>
          <p className="text-sm text-zinc-400 leading-relaxed mt-3">
            Those events unlock repository-aware behaviors such as issue intake, PR lifecycle updates, commit/check feedback, and CI-triggered autofix.
          </p>
        </div>
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-zinc-200 leading-relaxed">
          The section-level <strong className="text-white">Disconnect Repository</strong> action removes the webhook connection for that repo/workspace pair. Use it when you want to stop inbound GitHub events without necessarily tearing down every other GitHub identity setting.
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Auto-PR Settings</h2>
        <p className="text-zinc-300 leading-relaxed mb-4">
          Auto-PR settings control what happens after a Rorca run finishes and GitHub repository wiring already exists. When enabled, Rorca can automatically open or update a pull request for the run output instead of leaving the branch state purely local.
        </p>
        <ul className="space-y-2 text-zinc-300 leading-relaxed list-disc list-inside mb-4">
          <li><strong className="text-white">Enable toggle:</strong> turns auto-PR creation on or off for that workspace/repository connection.</li>
          <li><strong className="text-white">Target branch:</strong> the branch the generated PR should target, usually <code className="text-zinc-200">main</code>.</li>
          <li><strong className="text-white">Reviewers:</strong> optional GitHub usernames that Rorca will add as requested reviewers.</li>
        </ul>
        <p className="text-zinc-400 leading-relaxed">
          This section is about PR creation policy, not about the execution engine. The run still executes through Claude Code, OpenCode, Codex, or Pi the same way; auto-PR only changes how the resulting branch work is represented back in GitHub.
        </p>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">GitHub Actions Workflow download</h2>
        <p className="text-zinc-300 leading-relaxed mb-4">
          The download button gives you a starter GitHub Actions workflow file that can trigger Rorca pipeline runs from GitHub. The page tells you exactly where to place it:
          <code className="text-zinc-200"> .github/workflows/rorca-pipeline.yml</code>.
        </p>
        <div className="rounded-xl border border-white/10 bg-black/20 p-4 mb-4">
          <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Required repository secrets</div>
          <ul className="space-y-2 text-sm text-zinc-300 leading-relaxed list-disc list-inside">
            <li><code className="text-zinc-200">RORCA_API_URL</code> — where the workflow should call your Rorca backend.</li>
            <li><code className="text-zinc-200">RORCA_API_TOKEN</code> — the token the workflow uses to authenticate with Rorca.</li>
            <li><code className="text-zinc-200">WORKSPACE_ID</code> — which workspace the workflow should target.</li>
          </ul>
        </div>
        <p className="text-zinc-400 leading-relaxed">
          This is the quickest way to bootstrap a GitHub-driven run trigger without hand-authoring the YAML from scratch.
        </p>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">Workflows</h2>
        <p className="text-zinc-300 leading-relaxed mb-4">
          The <strong className="text-white">Workflows</strong> section is different from the YAML download section. It configures an outbound action that Rorca performs after a successful run: dispatching an existing GitHub Actions workflow via <code className="text-zinc-200">workflow_dispatch</code>.
        </p>
        <div className="grid gap-4 lg:grid-cols-2 mb-4">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">What you configure</div>
            <ul className="space-y-2 text-sm text-zinc-300 leading-relaxed list-disc list-inside">
              <li>Enable/disable workflow dispatch on run completion</li>
              <li>Workflow filename or numeric workflow id</li>
              <li>Branch/ref to dispatch against</li>
              <li>Optional JSON inputs passed to the workflow</li>
            </ul>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">What must already exist</div>
            <ul className="space-y-2 text-sm text-zinc-300 leading-relaxed list-disc list-inside">
              <li>A repository connection above</li>
              <li>A GitHub workflow that supports <code className="text-zinc-200">workflow_dispatch</code></li>
              <li>A token with the <code className="text-zinc-200">workflow</code> scope when dispatch requires it</li>
            </ul>
          </div>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/20 p-4 font-mono text-sm text-zinc-300 overflow-x-auto">
          successful Rorca run → optional workflow_dispatch call → GitHub workflow executes on configured ref with optional JSON inputs
        </div>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">CI Autofix</h2>
        <p className="text-zinc-300 leading-relaxed mb-4">
          CI Autofix listens for failed GitHub <code className="text-zinc-200">check_run</code> events and asks Rorca to generate and run a fix workflow automatically. The page gives you the controls to scope which failed checks should trigger this and how many times Rorca should retry per commit SHA.
        </p>
        <div className="grid gap-4 lg:grid-cols-2 mb-4">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Controls</div>
            <ul className="space-y-2 text-sm text-zinc-300 leading-relaxed list-disc list-inside">
              <li><strong className="text-white">Enable toggle</strong> to activate check-run-driven autofix</li>
              <li><strong className="text-white">Check name patterns</strong> using micromatch-style globs such as <code className="text-zinc-200">*</code> or <code className="text-zinc-200">ci / *</code></li>
              <li><strong className="text-white">Max retries per SHA</strong> to prevent infinite fix loops on the same commit</li>
              <li><strong className="text-white">Recent runs</strong> list so operators can inspect what autofix attempted recently</li>
            </ul>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Webhook requirement</div>
            <p className="text-sm text-zinc-300 leading-relaxed mb-2">
              CI Autofix depends on GitHub sending <code className="text-zinc-200">check_run</code> events to your Rorca webhook endpoint.
            </p>
            <p className="text-sm text-zinc-400 leading-relaxed">
              The UI guidance mirrors this: GitHub repo → Settings → Webhooks → Add webhook → point it at <code className="text-zinc-200">/api/webhooks/github</code> and enable check-run delivery.
            </p>
          </div>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/20 p-4 font-mono text-sm text-zinc-300 overflow-x-auto mb-4">
          failed check_run webhook → Rorca creates fix scope → selected execution agent runs the fix → branch is updated → recent autofix history records the outcome
        </div>
        <p className="text-zinc-400 leading-relaxed">
          CI Autofix is especially useful when you want Rorca to respond to broken CI as a repository event rather than only as a manually triggered spec run.
        </p>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-8">
        <h2 className="text-2xl font-medium mb-4">PR Description Template</h2>
        <p className="text-zinc-300 leading-relaxed mb-4">
          This section customizes the body used when Rorca creates an automatic pull request. It supports Handlebars-style variable substitution, a live preview, reset-to-default behavior, and a safe fallback rule: unknown variables are left as-is instead of crashing the render.
        </p>
        <div className="rounded-xl border border-white/10 bg-black/20 p-4 mb-4">
          <div className="text-xs uppercase tracking-[0.22em] text-zinc-500 mb-2">Useful template variables</div>
          <div className="flex flex-wrap gap-2">
            {prVariables.map((variable) => (
              <code key={variable} className="rounded border border-white/10 bg-zinc-900 px-2 py-1 text-xs text-zinc-200">
                {variable}
              </code>
            ))}
          </div>
        </div>
        <ul className="space-y-2 text-zinc-300 leading-relaxed list-disc list-inside">
          <li><strong className="text-white">Show Preview</strong> renders sample output so operators can see the PR body shape before saving.</li>
          <li><strong className="text-white">Reset to Default</strong> falls back to Rorca’s built-in PR template.</li>
          <li><strong className="text-white">Template scope:</strong> this affects auto-PR content, not the run logic itself.</li>
        </ul>
      </section>

      <section className="rounded-2xl border border-white/10 bg-zinc-950/60 p-6 mb-10">
        <h2 className="text-2xl font-medium mb-4">Disconnect choices</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <h3 className="font-medium text-white mb-2">Disconnect Repository</h3>
            <p className="text-zinc-400 leading-relaxed">Use this when you want to remove the webhook and stop repository-level event delivery for the workspace.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/20 p-4">
            <h3 className="font-medium text-white mb-2">Disconnect GitHub</h3>
            <p className="text-zinc-400 leading-relaxed">Use the full disconnect when you want to revoke workspace GitHub integration data more broadly. Pipeline runs can still continue, but without GitHub-linked behavior.</p>
          </div>
        </div>
      </section>

      <div className="flex flex-wrap gap-3">
        <Link href="/docs/architecture" className="px-4 py-2 rounded-lg bg-white text-zinc-950 font-medium hover:bg-zinc-200 transition-colors">Architecture</Link>
        <Link href="/docs/execution" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Execution</Link>
        <Link href="/docs/troubleshooting" className="px-4 py-2 rounded-lg border border-white/10 text-zinc-300 hover:bg-white/5 transition-colors">Troubleshooting</Link>
      </div>
    </div>
  );
}
