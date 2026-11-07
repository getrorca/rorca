# Publishing and Maintenance Guide for the Rorca Pi Extension

This document is for maintainers who want to ship `@rorca/pi-extension` as a polished package or present it publicly.

## Current state

Today the package is configured as:
- name: `@rorca/pi-extension`
- version: `0.1.0`
- `private: true`

That means it is currently intended for in-repo installation and development, not public registry publishing.

## What would need to be true before publishing

Before publishing, confirm all of the following:

### Product readiness
- command names are stable
- backend API contracts used by the extension are stable
- MCP bridge behavior is stable
- install/update docs are correct for real users
- Pi peer dependency expectations are clear

### Operational readiness
- you can explain the extension in one sentence
- you can explain how it differs from the Rorca app/TUI and from MCP tools
- you have a support stance for backend version compatibility
- you know whether the package is internal, open-source, or commercial

### Runtime compatibility
- tested against the target Pi versions you plan to support
- tested against at least one fresh install flow
- tested with backend on default port and non-default port
- tested with MCP token fallback and explicit env token override

## Recommended product positioning

Suggested positioning:

> The Rorca Pi Extension is a Pi-native operator interface for Rorca that lets you forge specs, approve them, trigger Pi-backed runs, inspect status, and bridge Rorca MCP tools directly into a Pi session.

Key distinction to keep explicit:
- **Rorca orchestrates**
- **Pi executes**
- **the extension provides UX inside Pi**

## Recommended public package checklist

### 1. Package metadata
Consider updating:
- `private: false`
- repository URL
- homepage URL
- bugs URL
- keywords
- description
- author / org metadata

Potential additions to `package.json`:
- `description`
- `repository`
- `homepage`
- `bugs`
- `files`
- `engines`

### 2. Versioning policy
Use semver, but document compatibility boundaries clearly.

Suggested policy:
- patch: docs, fixes, no command/API contract changes
- minor: new commands, backward-compatible flags, new widgets
- major: breaking command syntax, changed extension state, changed backend requirements

### 3. Public compatibility statement
Document which combinations you support:
- Pi version range
- Rorca backend version range
- whether MCP bridge requires a minimum backend version

Example:

```text
Compatibility:
- Pi: >= 0.67.x
- Rorca backend: >= version containing HTTP MCP initialize/tools/list/tools/call support and Pi trigger fields
```

### 4. Install story
A publishable package needs a dead-simple install story.

If published to a registry, document something like:

```bash
pi install @rorca/pi-extension -l
```

If it remains repo-local, keep documenting:

```bash
pi install ./packages/rorca-pi-extension -l
```

### 5. Release notes discipline
Every release should state:
- new commands or flags
- changed defaults
- backend compatibility notes
- known limitations
- migration steps, if any

## Documentation set to publish with

At minimum, publish these docs together:

1. `README.md`
   - what it is
   - install
   - command reference
   - examples
   - troubleshooting
2. `PUBLISHING.md`
   - maintainer guidance
3. release notes / changelog
4. compatibility matrix

Optional but useful:
- architecture diagram
- short demo transcript
- FAQ

## Suggested FAQ topics

- Does this replace the Rorca app?
- Does this replace the MCP server?
- Does this call the `rorca` CLI internally?
- What happens if MCP is down but REST is up?
- How does workspace selection work?
- How does model selection work?
- Where does it keep its local state?

## Security and auth notes to document

The extension can bridge privileged MCP tools. Public docs should clearly explain:

- how MCP auth works
- where the token is loaded from
- how to rotate that token
- what happens when no token is present
- that slash commands use REST directly and MCP bridging is additive

Current token resolution order:
1. `RORCA_PI_MCP_TOKEN`
2. `~/.rorca/mcp-admin-token`

## Recommended release validation checklist

Before each release, run:

```bash
npm run test:pi-extension
npm run typecheck
npm run build
cd backend && npx tsc --noEmit
```

Also perform a live smoke test:

```bash
pi --no-extensions -e ./packages/rorca-pi-extension/extensions/rorca/index.ts -p "/rorca-help"
```

Recommended end-to-end smoke path:
1. `/rorca-forge-run "Create a tiny docs-only story" --workspace <id>`
2. `/rorca-status`
3. `/rorca-watch <runId>`
4. `/rorca-mcp-status`

For single-story verification:

```text
/rorca-run <spec-slug> --workspace <id> --story US-001
```

Verify in backend state:
- one `story_started`
- one `story_passed`
- one `story_results` row for that run/story

## Known design decisions worth documenting publicly

### REST-first command UX
Slash commands are REST-first because that gives a simpler and more predictable user interaction model.

### MCP is additive
The MCP bridge exists so Pi can directly access Rorca tools when useful, but users should still be able to perform normal forge/run/status operations even if the bridge is unavailable.

### Rorca remains orchestrator
The extension should never be described as moving orchestration into Pi. That would misrepresent the product architecture.

## Suggested public-facing limitations section

Be explicit about limitations. Suggested examples:
- requires a running Rorca backend
- requires a running Rorca worker for actual execution
- existing Pi sessions may need restart/reload after installation
- model availability depends on the user’s local Pi/provider auth setup
- command semantics follow the backend version in use

## If you choose to publish to a registry

Suggested steps:

1. remove `private: true`
2. add package metadata
3. verify package contents with `npm pack --dry-run`
4. ensure README renders correctly
5. publish from a clean tag
6. announce supported Pi and Rorca backend versions

## Post-publish support expectations

Once public, assume users will need help with:
- backend URL misconfiguration
- workspace selection confusion
- MCP token setup
- provider auth / model mismatch
- old sessions not reloading the extension

Good docs and a strong troubleshooting section reduce most support load.

## Summary

To publish this well, frame it as:
- a Pi-native front-end for Rorca workflows
- powered by REST plus optional MCP bridging
- with Rorca still acting as the control plane and Pi as the execution backend
