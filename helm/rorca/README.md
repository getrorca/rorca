# Rorca Helm Chart

Installs Rorca — AI spec orchestration platform — on Kubernetes.

## Prerequisites

- Kubernetes 1.25+
- Helm 3.12+
- PostgreSQL (built-in via Bitnami subchart, or external)

## Quick Install

```bash
# With built-in PostgreSQL
helm repo add rorca https://getrorca.github.io/helm-charts
helm install rorca rorca/rorca

# With external PostgreSQL
helm install rorca rorca/rorca \
  --set postgresql.enabled=false \
  --set externalDatabase.host=my-postgres.example.com \
  --set externalDatabase.password=my-password
```

## from OCI Registry

```bash
helm install rorca oci://ghcr.io/getrorca/helm/rorca
```

## Configuration

See `values.yaml` for all options. Key parameters:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `rorca.agent` | Execution agent (claude, opencode, codex, pi) | `claude` |
| `rorca.model` | Model override | `""` |
| `rorca.anthropicApiKey` | Anthropic API key | `""` |
| `rorca.openaiApiKey` | OpenAI API key | `""` |
| `postgresql.enabled` | Deploy Bitnami PostgreSQL | `true` |
| `ingress.enabled` | Enable ingress | `false` |
| `persistence.enabled` | Persistent volume for Rorca data | `true` |

## Production Deployment

```bash
helm install rorca rorca/rorca \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=rorca.example.com \
  --set ingress.tls[0].secretName=rorca-tls \
  --set ingress.tls[0].hosts[0]=rorca.example.com \
  --set rorca.anthropicApiKey=sk-ant-... \
  --set rorca.openaiApiKey=sk-... \
  --set postgresql.auth.password=$(openssl rand -base64 32) \
  --set persistence.size=50Gi \
  --set resources.limits.memory=4Gi \
  --set resources.limits.cpu=4
```

## Upgrading

```bash
helm repo update
helm upgrade rorca rorca/rorca
```
