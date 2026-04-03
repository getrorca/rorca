#!/usr/bin/env bash
set -euo pipefail

# ── OVH VPS-3 — Order + Provision ────────────────────────────────────────────
# Usage:
#   export OVH_APP_KEY=xxx OVH_APP_SECRET=xxx OVH_CONSUMER_KEY=xxx
#   ./order-vps.sh [--datacenter BHS5] [--subsidiary CA]
#
# Get credentials (one-time, browser required):
#   https://api.ovh.com/createToken/?GET=/me&GET=/vps&GET=/vps/*&POST=/order/cart&POST=/order/cart/*&GET=/order/cart/*
#
# After ordering the VPS, this script:
#   1. Creates the OVH order cart and places the order
#   2. Polls until the VPS is provisioned and SSH is ready
#   3. Runs all cloud-init.yml commands remotely (swap, firewall, hardening)
#   4. Calls install-coolify.sh to complete the setup
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Defaults ──────────────────────────────────────────────────────────────────
API_URL="${OVH_API_URL:-https://eu.api.ovh.com}"
APP_KEY="${OVH_APP_KEY:?Missing OVH_APP_KEY — see script header for token URL}"
APP_SECRET="${OVH_APP_SECRET:?Missing OVH_APP_SECRET}"
CONSUMER_KEY="${OVH_CONSUMER_KEY:?Missing OVH_CONSUMER_KEY}"

OVH_SUBSIDIARY="${OVH_SUBSIDIARY:-IE}"
VPS_PLAN="${VPS_PLAN:-vps-le-2024-04}"   # VPS-3: 8 vCPU · 24GB · 200GB NVMe
VPS_DURATION="${VPS_DURATION:-P1M}"
VPS_DATACENTER="${VPS_DATACENTER:-BHS5}"   # Beauharnois (CA) — low-latency NA
VPS_OS="${VPS_OS:-ubuntu2404-server-64bit}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"

# Parse CLI flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --datacenter) VPS_DATACENTER="$2"; shift 2 ;;
    --subsidiary) OVH_SUBSIDIARY="$2"; shift 2 ;;
    --plan)       VPS_PLAN="$2"; shift 2 ;;
    --os)         VPS_OS="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────────────────

# Authenticated OVH API call
ovh_api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"

  local ts
  ts=$(curl -sf "$API_URL/1.0/auth/time")

  local sig_str="${APP_SECRET}+${CONSUMER_KEY}+${method}+${API_URL}/1.0${path}+${body}+${ts}"
  local sig
  sig="\$1\$$(printf '%s' "$sig_str" | openssl dgst -sha1 -hex | awk '{print $2}')"

  local args=(-sf -X "$method"
    -H "X-Ovh-Application: $APP_KEY"
    -H "X-Ovh-Timestamp: $ts"
    -H "X-Ovh-Signature: $sig"
    -H "X-Ovh-Consumer: $CONSUMER_KEY"
    -H "Content-Type: application/json"
  )
  [[ -n "$body" ]] && args+=(-d "$body")

  curl "${args[@]}" "$API_URL/1.0$path"
}

require_cmd() { command -v "$1" &>/dev/null || { echo "Error: '$1' not found"; exit 1; }; }

# ── Preflight ─────────────────────────────────────────────────────────────────
require_cmd curl
require_cmd jq
require_cmd openssl
require_cmd ssh

echo ""
echo "══════════════════════════════════════════════"
echo "  Rorca · OVH VPS-3 Full Provisioner"
echo "══════════════════════════════════════════════"
echo "  Plan:        $VPS_PLAN"
echo "  Datacenter:  $VPS_DATACENTER"
echo "  OS:          $VPS_OS"
echo "  Subsidiary:  $OVH_SUBSIDIARY"
echo "  Duration:    $VPS_DURATION"
echo "══════════════════════════════════════════════"
echo ""

# Verify credentials work
echo "==> Verifying OVH API credentials..."
ME=$(ovh_api GET "/me" || { echo "  ✗ Auth failed — check your credentials"; exit 1; })
echo "  ✓ Authenticated as $(echo "$ME" | jq -r '.firstname + " " + .name') ($(echo "$ME" | jq -r '.email'))"
echo ""

# ── Step 1: Discover available plan codes ─────────────────────────────────────
echo "==> Fetching available VPS plans to confirm planCode..."
TEMP_CART=$(ovh_api POST "/order/cart" "{\"ovhSubsidiary\":\"$OVH_SUBSIDIARY\",\"description\":\"rorca-probe\"}")
PROBE_CART_ID=$(echo "$TEMP_CART" | jq -r '.cartId')

AVAILABLE=$(ovh_api GET "/order/cart/$PROBE_CART_ID/vps" 2>/dev/null || echo "[]")
MATCH=$(echo "$AVAILABLE" | jq -r --arg p "$VPS_PLAN" '.[] | select(.planCode == $p) | .planCode' 2>/dev/null | head -1)

if [[ -z "$MATCH" ]]; then
  echo ""
  echo "  ⚠  planCode '$VPS_PLAN' not found in this region's catalog."
  echo "  Available VPS plans:"
  echo "$AVAILABLE" | jq -r '.[] | "    " + .planCode + " — " + (.prices[]? | select(.capacityCode=="renew") | .price.text // "?") + "/mo"' 2>/dev/null | head -20
  echo ""
  echo "  Set VPS_PLAN=<planCode> and re-run, or pass --plan <planCode>"
  # Clean up probe cart (best effort)
  ovh_api DELETE "/order/cart/$PROBE_CART_ID" >/dev/null 2>&1 || true
  exit 1
fi
echo "  ✓ Plan confirmed: $VPS_PLAN"

# ── Step 2: Create order cart ─────────────────────────────────────────────────
echo ""
echo "==> Creating order cart..."
CART=$(ovh_api POST "/order/cart" "{\"ovhSubsidiary\":\"$OVH_SUBSIDIARY\"}")
CART_ID=$(echo "$CART" | jq -r '.cartId')
echo "  ✓ Cart ID: $CART_ID"

# ── Step 3: Add VPS to cart ───────────────────────────────────────────────────
echo "==> Adding VPS-3 to cart..."
VPS_ITEM=$(ovh_api POST "/order/cart/$CART_ID/vps" \
  "{\"duration\":\"$VPS_DURATION\",\"planCode\":\"$VPS_PLAN\",\"pricingMode\":\"default\",\"quantity\":1}")
ITEM_ID=$(echo "$VPS_ITEM" | jq -r '.itemId')
echo "  ✓ Item ID: $ITEM_ID"

# ── Step 4: Configure datacenter ─────────────────────────────────────────────
echo "==> Configuring datacenter ($VPS_DATACENTER)..."
ovh_api POST "/order/cart/$CART_ID/item/$ITEM_ID/configuration" \
  "{\"label\":\"vps_datacenter\",\"value\":\"$VPS_DATACENTER\"}" > /dev/null
echo "  ✓ Datacenter set"

# ── Step 5: Configure OS ──────────────────────────────────────────────────────
echo "==> Configuring OS ($VPS_OS)..."
ovh_api POST "/order/cart/$CART_ID/item/$ITEM_ID/configuration" \
  "{\"label\":\"vps_os\",\"value\":\"$VPS_OS\"}" > /dev/null
echo "  ✓ OS set"

# ── Step 6: Configure SSH key ─────────────────────────────────────────────────
if [[ -f "${SSH_KEY}.pub" ]]; then
  echo "==> Injecting SSH public key..."
  SSH_PUB=$(cat "${SSH_KEY}.pub")
  ovh_api POST "/order/cart/$CART_ID/item/$ITEM_ID/configuration" \
    "{\"label\":\"vps_ssh_key\",\"value\":$(jq -n --arg v "$SSH_PUB" '$v')}" > /dev/null 2>&1 || \
    echo "  ⚠  SSH key injection not supported via API for this plan — add key manually in OVH panel if needed"
  echo "  ✓ SSH key set (or will be applied post-provision)"
fi

# ── Step 7: Validate + show price ─────────────────────────────────────────────
echo ""
echo "==> Validating cart..."
SUMMARY=$(ovh_api GET "/order/cart/$CART_ID/checkout")
TOTAL=$(echo "$SUMMARY" | jq -r '.prices.withTax.text // .prices.total.text // "unknown"')
echo "  ✓ Order total: $TOTAL/month"

echo ""
read -r -p "  Confirm order and charge payment method? [y/N] " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  echo "  Aborted — cart $CART_ID not checked out"
  exit 0
fi

# ── Step 8: Place order ───────────────────────────────────────────────────────
echo ""
echo "==> Placing order..."
ORDER=$(ovh_api POST "/order/cart/$CART_ID/checkout" \
  "{\"autoPayWithPreferredPaymentMethod\":true,\"waiveRetractationPeriod\":true}")
ORDER_ID=$(echo "$ORDER" | jq -r '.orderId')
ORDER_URL=$(echo "$ORDER" | jq -r '.url // "n/a"')
echo "  ✓ Order placed — ID: $ORDER_ID"
echo "  Receipt: $ORDER_URL"

# ── Step 9: Poll until VPS appears ────────────────────────────────────────────
echo ""
echo "==> Waiting for VPS to be provisioned (this takes 5–15 minutes)..."
VPS_NAME=""
MAX_WAIT=90   # 90 × 10s = 15 min
for ((i=1; i<=MAX_WAIT; i++)); do
  VPSS=$(ovh_api GET "/vps" 2>/dev/null || echo "[]")
  COUNT=$(echo "$VPSS" | jq 'length')
  if [[ "$COUNT" -gt 0 ]]; then
    # If multiple VPS, pick the newest (last in list)
    VPS_NAME=$(echo "$VPSS" | jq -r '.[-1]')
    echo "  ✓ VPS detected: $VPS_NAME"
    break
  fi
  printf "  [%02d/%d] not ready yet...\r" "$i" "$MAX_WAIT"
  sleep 10
done

if [[ -z "$VPS_NAME" ]]; then
  echo "  ✗ Timed out waiting for VPS. Check https://www.ovh.com/manager/#/dedicated/vps"
  echo "    Once you have the VPS IP, run:  ./install-coolify.sh <IP>"
  exit 1
fi

# Get VPS IP
VPS_IP=""
for ((i=1; i<=30; i++)); do
  VPS_DETAIL=$(ovh_api GET "/vps/$VPS_NAME" 2>/dev/null || echo "{}")
  VPS_STATE=$(echo "$VPS_DETAIL" | jq -r '.state // "unknown"')
  VPS_IP=$(echo "$VPS_DETAIL" | jq -r '.netbootMode // empty' 2>/dev/null || true)
  # Try direct IP from vps/{name}/ips
  IPS=$(ovh_api GET "/vps/$VPS_NAME/ips" 2>/dev/null || echo "[]")
  VPS_IP=$(echo "$IPS" | jq -r '.[] | select(test("^[0-9]+\\.")) | .' 2>/dev/null | head -1)
  if [[ -n "$VPS_IP" ]]; then
    echo "  ✓ VPS IP: $VPS_IP  (state: $VPS_STATE)"
    break
  fi
  printf "  [%02d/30] waiting for IP...\r" "$i"
  sleep 10
done

if [[ -z "$VPS_IP" ]]; then
  echo ""
  echo "  ⚠  Could not retrieve IP automatically."
  read -r -p "  Enter VPS IP manually: " VPS_IP
fi

# ── Step 10: Wait for SSH ─────────────────────────────────────────────────────
echo ""
echo "==> Waiting for SSH to be ready at $VPS_IP..."
until ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=5 \
    root@"$VPS_IP" "echo ready" 2>/dev/null; do
  printf "  Not ready yet, retrying in 10s...\n"
  sleep 10
done
echo "  ✓ SSH ready"

# ── Step 11: Apply cloud-init commands remotely ───────────────────────────────
echo ""
echo "==> Applying system configuration (cloud-init equivalent)..."

ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no root@"$VPS_IP" bash <<'REMOTE'
set -e

echo "  → Updating packages..."
apt-get update -qq && apt-get upgrade -y -qq

echo "  → Installing packages..."
apt-get install -y -qq fail2ban curl git htop unattended-upgrades ufw

echo "  → Hardening SSH..."
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/PermitRootLogin yes/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart sshd

echo "  → Enabling auto-security updates..."
dpkg-reconfigure --priority=low unattended-upgrades

echo "  → Configuring 8GB swap..."
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 8G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "  → Tuning kernel (Docker + pg-boss + AGE)..."
sysctl -w vm.overcommit_memory=1
grep -q 'vm.overcommit_memory' /etc/sysctl.conf || echo 'vm.overcommit_memory=1' >> /etc/sysctl.conf
sysctl -w vm.swappiness=10
grep -q 'vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf

echo "  → Configuring firewall..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 8000/tcp
ufw --force enable

echo "  ✓ System configuration complete"
REMOTE

echo "  ✓ Cloud-init equivalent applied"

# ── Step 12: Install Coolify ──────────────────────────────────────────────────
echo ""
echo "==> Handing off to install-coolify.sh..."
echo ""

SSH_KEY="$SSH_KEY" bash "$SCRIPT_DIR/install-coolify.sh" "$VPS_IP"
