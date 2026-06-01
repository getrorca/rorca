# Privacy Policy — Rorca

Rorca is a local-first open-source tool.

## Default data model

By default, Rorca stores its working data on infrastructure you control:
- local files
- your local or self-hosted PostgreSQL instance
- your own git repositories
- provider credentials you configure locally or through your deployment environment

Rorca does not require a hosted Rorca account for normal OSS use.

## Telemetry

Telemetry is **off by default**.

If you choose to add telemetry in your own deployment, you are responsible for what you collect, where it is sent, and how it is disclosed to your users.

## Third-party providers

Rorca can interact with external tools and model providers that you configure, such as:
- Claude Code
- OpenCode providers
- Codex
- GitHub

Those services are governed by their own terms and privacy policies.

## Secrets and credentials

You should provide secrets through:
- environment variables
- local CLI auth
- local credential stores
- your own deployment secret manager

Do not commit secrets to git.

## Public OSS repo

This repository should not contain:
- committed user secrets
- hosted identity data
- production customer data

If you discover a privacy or data-handling issue, please report it responsibly.

## Contact

- Security: `security@rorca.app`
- Issues: `https://github.com/getrorca/rorca/issues`
