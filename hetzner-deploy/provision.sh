#!/usr/bin/env bash
set -euo pipefail

# ── CONFIG — edit these ──────────────────────────────────────────────────────
PROJECT_NAME="rorca-infra"
VM_NAME="coolify-main"
VM_TYPE="cx33"                     # 4 vCPU, 8GB RAM, 80GB — see VM Sizing Guide
VM_IMAGE="ubuntu-24.04"
VM_LOCATION="hel1"                 # hel1=Helsinki, nbg1=Nuremberg, fsn1=Falkenstein
NETWORK_NAME="rorca-private"
NETWORK_ZONE="eu-central"          # eu-central covers hel1/nbg1/fsn1
SSH_KEY_NAME="rorca-deploy-key"
SSH_KEY_PATH="$HOME/.ssh/hetzner_ed25519.pub"
FIREWALL_NAME="rorca-firewall"
FLOATING_IP_NAME="rorca-prod-ip"
CLOUD_INIT_FILE="./cloud-init.yml" # see cloud-init.yml in this directory
# ─────────────────────────────────────────────────────────────────────────────

echo "==> Uploading SSH key..."
hcloud ssh-key create \
  --name "$SSH_KEY_NAME" \
  --public-key-from-file "$SSH_KEY_PATH" 2>/dev/null || echo "SSH key already exists, continuing."

echo "==> Creating private network..."
hcloud network create \
  --name "$NETWORK_NAME" \
  --ip-range 10.0.0.0/16 2>/dev/null || echo "Network already exists, continuing."

hcloud network add-subnet "$NETWORK_NAME" \
  --network-zone "$NETWORK_ZONE" \
  --type cloud \
  --ip-range 10.0.0.0/24 2>/dev/null || echo "Subnet already exists, continuing."

echo "==> Creating VM..."
hcloud server create \
  --name "$VM_NAME" \
  --type "$VM_TYPE" \
  --image "$VM_IMAGE" \
  --location "$VM_LOCATION" \
  --ssh-key "$SSH_KEY_NAME" \
  --network "$NETWORK_NAME" \
  --user-data-from-file "$CLOUD_INIT_FILE"

echo "==> Creating floating IP..."
hcloud floating-ip create \
  --type ipv4 \
  --home-location "$VM_LOCATION" \
  --name "$FLOATING_IP_NAME"

echo "==> Assigning floating IP to VM..."
hcloud floating-ip assign "$FLOATING_IP_NAME" "$VM_NAME"

echo "==> Creating firewall..."
hcloud firewall create --name "$FIREWALL_NAME"

echo "==> Adding firewall rules..."
hcloud firewall add-rule "$FIREWALL_NAME" --direction in --protocol tcp  --port 22   --source-ips 0.0.0.0/0
hcloud firewall add-rule "$FIREWALL_NAME" --direction in --protocol tcp  --port 80   --source-ips 0.0.0.0/0
hcloud firewall add-rule "$FIREWALL_NAME" --direction in --protocol tcp  --port 443  --source-ips 0.0.0.0/0
hcloud firewall add-rule "$FIREWALL_NAME" --direction in --protocol tcp  --port 8000 --source-ips 0.0.0.0/0
hcloud firewall add-rule "$FIREWALL_NAME" --direction in --protocol tcp  --port 6001 --source-ips 0.0.0.0/0
hcloud firewall add-rule "$FIREWALL_NAME" --direction in --protocol tcp  --port 6002 --source-ips 0.0.0.0/0
hcloud firewall add-rule "$FIREWALL_NAME" --direction in --protocol icmp          --source-ips 0.0.0.0/0

echo "==> Applying firewall to VM..."
hcloud firewall apply-to-resource "$FIREWALL_NAME" --type server --server "$VM_NAME"

# ── Output summary ────────────────────────────────────────────────────────────
VM_IP=$(hcloud server describe "$VM_NAME" -o json | python3 -c "import sys,json; print(json.load(sys.stdin)['public_net']['ipv4']['ip'])")
FLOATING_IP=$(hcloud floating-ip describe "$FLOATING_IP_NAME" -o json | python3 -c "import sys,json; print(json.load(sys.stdin)['ip'])")

echo ""
echo "✅ Done. Summary:"
echo "   VM public IP:   $VM_IP  (use this to SSH in until floating IP is configured)"
echo "   Floating IP:    $FLOATING_IP  (point your DNS A record here)"
echo "   SSH command:    ssh -i ~/.ssh/hetzner_ed25519 root@$VM_IP"
echo ""
echo "Next: wait ~60s for cloud-init to finish, then run Script 2 (configure-vm.sh)"
