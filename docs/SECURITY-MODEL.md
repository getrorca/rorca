# OSS Security Model

This document describes the intended security posture of the future Apache 2.0 `rorca` repo.

## Trust model

- The OSS edition is **local-first** and **self-hostable**.
- The OSS codebase should be treated as **operator-controlled and modifiable**.
- Local UI checks and defaults are product ergonomics, not strong anti-tamper enforcement.

## Identity boundary

The Apache 2.0 OSS repo should **not** ship hosted identity infrastructure such as:
- Supabase auth
- hosted GitHub web sign-in
- other SaaS-style account/session systems

Those belong in `rorca-opencore`.

## GitHub access in OSS

Rorca still needs to interact with user repositories in the OSS edition.
That capability should remain available through local/operator-managed credentials such as:
- GitHub personal access tokens (PATs)
- local git credentials already configured on the machine
- local CLI auth flows managed by developer tools

GitHub repository capability stays in OSS.
GitHub web-login identity does not.

## Local dashboard protection

If an OSS dashboard needs protection outside pure localhost use, prefer a minimal local-only control such as:
- a static API key
- a locally managed shared secret
- network-level protection provided by the operator

Do not require hosted identity infrastructure just to run the local OSS product.

## Commercial enforcement

The OSS repo should not be treated as a secure place to enforce:
- billing
- subscriptions
- seat limits
- enterprise RBAC
- hosted entitlements

Those controls belong in `rorca-opencore` and other infrastructure under operator/company control.
