# AGENTS.md — forge/

## `run-loop.sh` is retired

`forge/run-loop.sh` is a fail-closed compatibility stub. It never starts a model,
loads workspace environment variables, writes a run, or executes workspace code.
The old shell loop could not provide the mandatory PID/proc/user/mount/network
namespace boundary or exact-host model-egress confinement.

All implementation work belongs in `backend/src/lib/execution-engine.ts` and the
canonical worker-backed pipeline:

1. persist a spec through the canonical spec API;
2. review and approve it;
3. call `/api/pipeline/trigger` (or its MCP alias);
4. let the worker preflight `linux-bwrap`, start the trusted model CONNECT broker,
   and launch the execution engine.

Do not restore shell-loop fallback, direct model CLI flags, ambient environment
inheritance, or API-side execution orchestration. Hosts without the Linux boundary
may use non-tool HTTP SDK drafting paths, but autonomous workspace execution must
fail closed.
