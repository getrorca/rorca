#!/usr/bin/env bash
set -euo pipefail

VM_IP="${1:?Usage: ./install-coolify.sh <VM_PUBLIC_IP>}"
SSH_KEY="$HOME/.ssh/hetzner_ed25519"

echo "==> Installing Coolify on $VM_IP (takes 2-5 minutes)..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no root@"$VM_IP" \
  "curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash"

echo ""
echo "✅ Coolify installed."
echo "   Open: http://$VM_IP:8000"
echo "   Create admin account, then:"
echo "   1. Settings > General > set Instance Domain to https://coolify.yourdomain.com"
echo "   2. New Resource > Database > PostgreSQL 16 (use pgvector/pgvector:pg16 image)"
echo "   3. New Resource > Application > From GitHub > getrorca/rorca"
echo "   4. Set env vars (see hetzner-coolify-infra.md skill for full list)"
echo "   5. Add rorca-worker as a second Application from same repo, start cmd: node backend/dist/worker.js"
