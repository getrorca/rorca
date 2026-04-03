#!/usr/bin/env bash
set -euo pipefail

# ── OVH VPS-3 — Install Coolify ──────────────────────────────────────────────
# Usage: ./install-coolify.sh <VPS_PUBLIC_IP>
# Prereq: SSH key added to VPS during OVH ordering, cloud-init.yml applied
# ─────────────────────────────────────────────────────────────────────────────

VPS_IP="${1:?Usage: ./install-coolify.sh <VPS_PUBLIC_IP>}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"

echo "==> Waiting for VPS to be ready at $VPS_IP..."
until ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=5 root@"$VPS_IP" "echo ready" 2>/dev/null; do
  echo "   Not ready yet, retrying in 5s..."
  sleep 5
done

echo "==> Installing Coolify (takes 2-5 minutes)..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no root@"$VPS_IP" \
  "curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash"

echo ""
echo "✅ Coolify installed on OVH VPS-3."
echo ""
echo "─── Next steps ──────────────────────────────────────────────────────────"
echo "1. Open Coolify:     http://$VPS_IP:8000"
echo "2. Create admin account (first-run wizard)"
echo "3. Settings > General > set Instance URL to https://coolify.yourdomain.com"
echo ""
echo "─── Deploy PostgreSQL ───────────────────────────────────────────────────"
echo "4. New Resource > Database > PostgreSQL 16"
echo "   Image: pgvector/pgvector:pg16  (includes pgvector + AGE)"
echo "   Set a strong password, note the internal connection string"
echo ""
echo "─── Deploy Rorca API + Worker ───────────────────────────────────────────"
echo "5. New Resource > Application > From GitHub > getrorca/rorca"
echo "   Dockerfile: Dockerfile  (root)"
echo "   Port: 3030"
echo "   Start command: (leave default)"
echo "   Env vars — required:"
echo "     DATABASE_URL=postgres://...  (from step 4)"
echo "     NODE_ENV=production"
echo "     JWT_SECRET=\$(openssl rand -hex 32)"
echo "     CORS_ORIGIN=https://yourdomain.com"
echo "     RORCA_SERVE_STATIC=1"
echo "     RORCA_STATIC_DIR=/app/dist"
echo ""
echo "6. New Resource > Application > From GitHub > getrorca/rorca  (worker)"
echo "   Same Dockerfile, same env vars, PLUS:"
echo "   Start command: node backend/dist/worker.js"
echo "   RORCA_PROCESS_ROLE=worker"
echo ""
echo "─── Domain + SSL ────────────────────────────────────────────────────────"
echo "7. Point your DNS A record to: $VPS_IP"
echo "8. In Coolify app settings: set domain + enable Let's Encrypt SSL"
echo ""
echo "─── Verify ──────────────────────────────────────────────────────────────"
echo "   curl https://yourdomain.com/api/health"
echo "   curl https://yourdomain.com/api/pipeline/worker/health"
