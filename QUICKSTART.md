# Quickstart

Pick your install method:

## npm (recommended)

**Prerequisites:** Node.js 20+

```bash
npm install -g rorca
rorca start
```

Opens dashboard at http://localhost:5210. That's it.

## curl

```bash
curl -fsSL https://raw.githubusercontent.com/getrorca/rorca/main/install.sh | sh
```

Auto-detects Node.js or falls back to Docker. Use `--docker` or `--npm` to force a method.

## Docker

```bash
docker run -d --name rorca \
  -p 5210:5210 -p 3030:3030 \
  -v rorca-data:/data \
  getrorca/rorca:latest
```

Or with Docker Compose:

```bash
git clone https://github.com/getrorca/rorca.git
cd rorca
docker compose up -d
```

## Helm (Kubernetes)

```bash
helm repo add rorca https://getrorca.github.io/helm-charts
helm install rorca rorca/rorca \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=rorca.example.com
```

Or from OCI:

```bash
helm install rorca oci://ghcr.io/getrorca/helm/rorca \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=rorca.example.com
```

See `helm/rorca/values.yaml` for all configuration options.

## What you'll need

- **Execution agent:** Claude Code, OpenCode, Codex CLI, or Pi
- **API keys:** One of Anthropic, OpenAI, or OpenRouter (for spec generation)
- That's it. Rorca handles the database, the frontend, and the orchestration.

## Your first workflow

```
1. Register a workspace  →  Point Rorca at any local git repo
2. Add direction          →  Describe your project conventions
3. Create a spec          →  Type a brief, Rorca generates a structured spec
4. Review and approve     →  Edit stories, set priorities
5. Run the work           →  Rorca executes story-by-story with live progress
6. Learn from outcomes    →  Retrieval feedback improves context over time
```

## All install paths at a glance

| Method | Command | Best for |
|--------|---------|----------|
| npm | `npm install -g rorca` | Developers with Node.js |
| curl | `curl \| sh` | Quick one-liner, CI/CD |
| Docker | `docker run getrorca/rorca` | Isolated, reproducible |
| Docker Compose | `docker compose up -d` | Local dev with PostgreSQL |
| Helm | `helm install rorca rorca/rorca` | Kubernetes, production |
| Source | `git clone && npm install` | Contributors, custom builds |
