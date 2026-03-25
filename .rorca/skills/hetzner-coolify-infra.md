---
name: hetzner-coolify-infra
description: Use when planning, provisioning, or managing Hetzner Cloud VMs with Coolify for self-hosted application deployment. Covers VM sizing, networking, Coolify installation, service deployment, DNS, SSL, and pre-production environment setup.
license: MIT
compatibility: opencode, claude
metadata:
  audience: devops, engineers, founders
  category: infrastructure, cloud, self-hosting
  updated: 2026-03-24
---

# Hetzner + Coolify Infrastructure

Opinionated guide for provisioning Hetzner Cloud VMs and installing Coolify to run self-hosted applications (including Rorca) in a pre-production or production environment. Covers everything from VM creation to first deployment.

**Verified against**: Hetzner Cloud pricing March 2026, Coolify v4 docs, Ubuntu 24.04 LTS.

## When to use me

Use this skill when:
- Provisioning a Hetzner Cloud VM for the first time
- Installing Coolify on a fresh server
- Setting up pre-prod or staging environments
- Deploying Rorca (or any Node.js/Postgres app) via Coolify
- Configuring private networking between services
- Setting up DNS, SSL, firewall rules
- Writing Terraform/hcloud CLI scripts for infrastructure-as-code
- Troubleshooting Coolify deployments or Hetzner networking

---

## Automation Scripts

The sections below are **copy-paste-ready scripts**. Run them in order. Steps 1–3 are pure CLI (no UI needed). Step 4 onwards requires opening the Coolify web UI — those steps cannot be fully automated without using Coolify's REST API (covered at the end).

### Script 1: Provision Hetzner infrastructure (`provision.sh`)

Run this locally. Takes ~3 minutes. Creates VM, network, floating IP, firewall — everything.

```bash
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
CLOUD_INIT_FILE="./cloud-init.yml" # see Script 1b below
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
```

### Script 1b: `cloud-init.yml` (place in same directory as `provision.sh`)

```yaml
#cloud-config
package_update: true
package_upgrade: true
packages:
  - fail2ban
  - curl
  - git
  - htop
  - unattended-upgrades

runcmd:
  - sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
  - sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
  # prohibit-password = blocks password login, keeps SSH key auth working
  # Do NOT use 'PermitRootLogin no' — configure-vm.sh and install-coolify.sh SSH as root
  - sed -i 's/PermitRootLogin yes/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
  - systemctl restart sshd
  - dpkg-reconfigure --priority=low unattended-upgrades
  - fallocate -l 4G /swapfile
  - chmod 600 /swapfile
  - mkswap /swapfile
  - swapon /swapfile
  - echo '/swapfile none swap sw 0 0' >> /etc/fstab
  - sysctl -w vm.overcommit_memory=1
  - echo 'vm.overcommit_memory=1' >> /etc/sysctl.conf
```

**Note**: cloud-init disables root SSH login. After this runs, SSH as root won't work. Add your own user to the `users:` block (see Step 1d in the detailed guide) if you need non-root access.

### Script 2: Configure floating IP on VM (`configure-vm.sh`)

Run this locally. SSHs into the VM and makes the floating IP persistent across reboots.

```bash
#!/usr/bin/env bash
set -euo pipefail

VM_IP="${1:?Usage: ./configure-vm.sh <VM_PUBLIC_IP> <FLOATING_IP>}"
FLOATING_IP="${2:?Usage: ./configure-vm.sh <VM_PUBLIC_IP> <FLOATING_IP>}"
SSH_KEY="$HOME/.ssh/hetzner_ed25519"

echo "==> Waiting for VM to be ready..."
until ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=5 root@"$VM_IP" "echo ready" 2>/dev/null; do
  echo "   Not ready yet, retrying in 5s..."
  sleep 5
done

echo "==> Configuring floating IP $FLOATING_IP on VM..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no root@"$VM_IP" bash <<EOF
cat > /etc/netplan/99-floating-ipv4.yaml << 'NETPLAN'
network:
  version: 2
  ethernets:
    eth0:
      addresses:
        - ${FLOATING_IP}/32
NETPLAN
netplan apply
ip addr show eth0 | grep ${FLOATING_IP} && echo "Floating IP confirmed on eth0" || echo "WARNING: floating IP not found on eth0"
EOF

echo ""
echo "✅ Done. Floating IP $FLOATING_IP is now configured."
echo "   Point your DNS A record to: $FLOATING_IP"
echo "   Then run Script 3: ./install-coolify.sh $VM_IP"
```

Usage: `./configure-vm.sh <VM_PUBLIC_IP> <FLOATING_IP>`

### Script 3: Install Coolify (`install-coolify.sh`)

Run this locally. SSHs into the VM and runs the official Coolify installer.

```bash
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
echo "   4. Set env vars (see Environment Variables section in this skill)"
echo "   5. Add rorca-worker as a second Application from same repo, start cmd: node backend/dist/worker.js"
```

Usage: `./install-coolify.sh <VM_PUBLIC_IP>`

### What can't be automated (requires Coolify UI)

The following require Coolify's web UI or REST API — they involve credentials and interactive OAuth that can't run headlessly without more setup:

| Step | Why UI-only |
|------|-------------|
| Create admin account | First-run wizard, sets password interactively |
| Connect GitHub App | OAuth flow that redirects to GitHub |
| Add Postgres service | Coolify API exists but credentials are generated at creation time |
| Set env vars | Can be automated via Coolify API (see below) |
| Enable S3 backup | Coolify API exists |

### Optional: Coolify REST API (automate env vars after manual setup)

After you've created services manually, use Coolify's API to set env vars programmatically:

```bash
# Get your API token from Coolify: Security > API Tokens
COOLIFY_URL="https://coolify.yourdomain.com"
COOLIFY_TOKEN="your-api-token"
APP_UUID="your-app-uuid"  # from Coolify UI URL

# Set all env vars for rorca-app in one call
curl -s -X POST "$COOLIFY_URL/api/v1/applications/$APP_UUID/envs/bulk" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "data": [
      {"key": "NODE_ENV",           "value": "production"},
      {"key": "PORT",               "value": "3030"},
      {"key": "RORCA_AGENT",        "value": "opencode"},
      {"key": "RORCA_MODEL",        "value": "anthropic/claude-sonnet-4-6"},
      {"key": "RORCA_SERVE_STATIC", "value": "1"},
      {"key": "RORCA_STATIC_DIR",   "value": "/app/dist"},
      {"key": "JWT_SECRET",         "value": "<your-jwt-secret>"},
      {"key": "ANTHROPIC_API_KEY",  "value": "<your-key>"},
      {"key": "DATABASE_URL",       "value": "<from-coolify-postgres-connection-tab>"}
    ]
  }'
```

---

## Architecture — Opinionated Defaults

### Recommended topology for Rorca pre-prod

```
Hetzner Project: rorca-infra
|
+-- Network: rorca-private (10.0.0.0/16, region: hel1)
|
+-- VM: coolify-main (CX33, Ubuntu 24.04)
|   +-- Public IP: <floating IP>
|   +-- Private IP: 10.0.0.2
|   +-- Roles: Coolify orchestrator, Traefik reverse proxy, Let's Encrypt
|   +-- Services managed:
|       +-- rorca-app (Node.js, port 3030)
|       +-- rorca-frontend (Vite static, served via rorca-app with RORCA_SERVE_STATIC=1)
|       +-- rorca-worker (pg-boss, separate container, no port)
|       +-- rorca-postgres (PostgreSQL 16, port 5432, internal Docker network only)
|
+-- VM: rorca-runner (CPX22, Ubuntu 24.04) [optional, for spec execution]
    +-- Private IP: 10.0.0.3
    +-- Roles: Claude Code subprocess runner, git worktree execution
```

### Why this topology
- **Single Coolify VM** handles orchestration + Traefik — no additional load balancer cost for pre-prod
- **Private network** isolates Postgres from public internet — only app VM can reach port 5432
- **Floating IP** decouples DNS from VM — can rebuild VM without changing DNS
- **Separate runner VM** (optional) isolates untrusted subprocess execution (claude --print) from the main app

---

## VM Sizing Guide (March 2026 — pre-April 1 price increase)

### CX Series — Cost-Optimized Shared (EU only: Germany/Finland)
| Type | vCPU | RAM | Storage | €/mo | Use case |
|------|------|-----|---------|------|----------|
| CX23 | 2 | 4GB | 40GB | 3.49 | Minimal dev, testing |
| **CX33** | **4** | **8GB** | **80GB** | **5.49** | **Coolify + Rorca pre-prod (recommended)** |
| CX43 | 8 | 16GB | 160GB | 9.49 | Production, multiple services |
| CX53 | 16 | 32GB | 320GB | 17.49 | Heavy workloads |

### CPX Series — Regular Performance AMD (all regions)
| Type | vCPU | RAM | Storage | €/mo | Use case |
|------|------|-----|---------|------|----------|
| CPX22 | 2 | 4GB | 80GB | 6.49 | Runner VM, US region |
| CPX32 | 4 | 8GB | 160GB | 10.99 | Production runner |
| CPX42 | 8 | 16GB | 320GB | 19.99 | Heavy spec execution |

### CAX Series — ARM Shared (EU only)
| Type | vCPU | RAM | Storage | €/mo | Use case |
|------|------|-----|---------|------|----------|
| CAX11 | 2 | 4GB | 40GB | 3.79 | Cheapest option, ARM |
| CAX21 | 4 | 8GB | 80GB | 6.49 | ARM Coolify (Docker works fine on ARM) |

### CCX Series — Dedicated vCPU (all regions)
| Type | vCPU | RAM | Storage | €/mo | Use case |
|------|------|-----|---------|------|----------|
| CCX13 | 2 | 8GB | 80GB | 12.49 | Dedicated, consistent performance |
| CCX23 | 4 | 16GB | 160GB | 24.49 | Production, guaranteed CPU |

**IMPORTANT**: Old naming (CX11, CX21, CX31, CX41, CX51, CPX11, CPX21, CPX31, CPX41, CPX51) was **deprecated September 2024** and cannot be ordered. Existing servers still run but no new ones can be created.

**Default choice**: **CX33** for Coolify pre-prod (4 vCPU, 8GB RAM, 80GB, €5.49/mo). Runs Coolify + Rorca app + worker + Postgres on one VM. Upgrade to CX43 when you see memory pressure above 80%.

**Region**: `hel1` (Helsinki) or `nbg1` (Nuremberg) — both have lowest latency to EU users. Use `ash` (Ashburn) for US-primary user base. CX/CAX are EU-only; use CPX/CCX for US regions.

**Price increase**: Hetzner announced price increases effective April 1, 2026. CX33 goes from €5.49 to ~€7/mo. CPX22 from €6.49 to ~€8/mo.

---

## Coolify Requirements (v4, current stable)

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| CPU | 2 cores | 4 cores |
| RAM | 2 GB | 4+ GB |
| Storage | 30 GB | 80+ GB |
| OS | Ubuntu 20.04/22.04/24.04 LTS | Ubuntu 24.04 LTS |
| Docker | v24+ (auto-installed) | Latest |
| Architecture | AMD64 or ARM64 | AMD64 |

**Supported OS**: Debian-based (Ubuntu, Debian), Red Hat-based (CentOS, Fedora, AlmaLinux, Rocky), SUSE, Arch, Alpine, Raspberry Pi OS 64-bit.

**Auto-install only on Ubuntu LTS** (20.04, 22.04, 24.04). Non-LTS Ubuntu (e.g. 24.10) requires manual installation.

### Required ports for Coolify
| Port | Purpose | When to open |
|------|---------|-------------|
| 22 | SSH | Always |
| 80 | HTTP (Let's Encrypt ACME, redirects) | Always |
| 443 | HTTPS (Traefik reverse proxy) | Always |
| 8000 | Coolify dashboard (HTTP) | Initial setup only — restrict to your IP after configuring domain |
| 6001 | Coolify real-time WebSocket | Always (internal comms) |
| 6002 | Coolify terminal proxy (v4.0.0-beta.336+) | Always (terminal access in dashboard) |

---

## Prerequisites

### Pre-flight checklist

Before running any commands, confirm everything below is in place:

```
[ ] hcloud CLI installed and working (hcloud version)
[ ] ed25519 SSH key generated: ~/.ssh/hetzner_ed25519 (passphrase recommended)
[ ] Hetzner Cloud account created + project "rorca-infra" created
[ ] Hetzner API token generated (Read+Write) and pasted into hcloud context
[ ] Domain ready with DNS edit access (A record will point to Floating IP)
[ ] JWT_SECRET generated: openssl rand -hex 32 — save it now, paste into Coolify later
[ ] API key for execution engine ready (Anthropic, OpenRouter, etc.)
[ ] GitHub account with access to getrorca/rorca (private repo — Coolify needs to install a GitHub App)
[ ] Decided: RORCA_AGENT=claude (needs interactive auth on VM) vs opencode (API key only, simpler for cloud)
[ ] Stripe keys ready (only if billing feature is active)
```

### Local tools required
```bash
# Hetzner Cloud CLI
brew install hcloud       # macOS
# or: curl -LO https://github.com/hetznercloud/cli/releases/latest/download/hcloud-linux-amd64.tar.gz

# Verify
hcloud version

# Terraform (optional, for IaC)
brew install terraform

# SSH key (if not already generated)
ssh-keygen -t ed25519 -C "your@email.com" -f ~/.ssh/hetzner_ed25519
```

### Hetzner account setup
1. Create account at console.hetzner.cloud
2. Create a new Project (e.g., `rorca-infra`)
3. Generate an API token: Project -> Security -> API Tokens -> Generate (Read & Write)
4. Configure hcloud CLI:
```bash
hcloud context create rorca-infra
# Paste API token when prompted
hcloud context use rorca-infra
```

### Domain requirements
- A domain you control (e.g., `rorca.app` or a subdomain like `pre-prod.rorca.app`)
- Access to DNS records (A record pointing to Hetzner floating IP)
- Let's Encrypt will handle SSL automatically via Coolify/Traefik

### Execution engine decision

**RORCA_AGENT=opencode (recommended for cloud/Coolify deployments)**
- Requires an API key (Anthropic, OpenRouter, OpenAI, etc.)
- No interactive auth — key goes straight into Coolify env vars
- Works immediately after container start, no extra volume mounts

**RORCA_AGENT=claude (requires extra setup on the VM)**
- Requires an authenticated Claude session in `~/.claude/` on the host
- Must SSH into the VM and run `claude auth login` once interactively
- Must mount `~/.claude/` as a persistent volume in Coolify so credentials survive redeploys
- Preferred when you have a Claude Max subscription (prompt caching, surgical edits)

### Credentials needed before you start

| Credential | How to get it | Where it goes |
|-----------|--------------|--------------|
| Hetzner API token | Project → Security → API Tokens | `hcloud context create` |
| SSH public key | `~/.ssh/hetzner_ed25519.pub` | Uploaded via `hcloud ssh-key create` |
| JWT_SECRET | `openssl rand -hex 32` | Coolify env var on rorca-app + rorca-worker |
| DATABASE_URL | Generated by Coolify after Postgres deploy | Coolify env var on rorca-app + rorca-worker |
| ANTHROPIC_API_KEY or OPENROUTER_API_KEY | API console | Coolify env var on rorca-app + rorca-worker |
| Stripe keys | stripe.com/dashboard | Coolify env var (only if billing active) |
| Hetzner Object Storage keys | Hetzner Console → Object Storage → Credentials | Coolify → Storages → S3 config |

---

## Step 1: Hetzner Infrastructure Provisioning

### 1a. Upload SSH key
```bash
hcloud ssh-key create \
  --name rorca-deploy-key \
  --public-key-from-file ~/.ssh/hetzner_ed25519.pub
```

### 1b. Create private network
```bash
hcloud network create \
  --name rorca-private \
  --ip-range 10.0.0.0/16

hcloud network add-subnet rorca-private \
  --network-zone eu-central \
  --type cloud \
  --ip-range 10.0.0.0/24
```

### 1c. Create Coolify VM
```bash
hcloud server create \
  --name coolify-main \
  --type cx33 \
  --image ubuntu-24.04 \
  --location hel1 \
  --ssh-key rorca-deploy-key \
  --network rorca-private \
  --user-data-from-file ./cloud-init.yml
```

### 1d. cloud-init.yml (minimal hardening)

**IMPORTANT**: cloud-init handles initial OS hardening only. The primary firewall MUST be Hetzner Cloud Firewall (see step 1g), NOT UFW. Docker's NAT-based iptables rules bypass UFW — local firewall rules alone do NOT protect exposed Docker ports.

```yaml
#cloud-config
package_update: true
package_upgrade: true
packages:
  - fail2ban
  - curl
  - git
  - htop
  - unattended-upgrades

users:
  - name: deploy
    groups: sudo, docker
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - <YOUR_PUBLIC_KEY_CONTENTS>

runcmd:
  # Harden SSH — disable password auth, keep SSH key auth (prohibit-password not no)
  - sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
  - sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
  - sed -i 's/PermitRootLogin yes/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
  - systemctl restart sshd
  # Enable automatic security updates
  - dpkg-reconfigure --priority=low unattended-upgrades
  # Swap (important for CX33 8GB — Coolify + Docker + Postgres is memory-heavy)
  - fallocate -l 4G /swapfile
  - chmod 600 /swapfile
  - mkswap /swapfile
  - swapon /swapfile
  - echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Kernel tuning: vm.overcommit_memory=1 suppresses warnings from Redis containers.
  # Not required for Postgres or Node.js, but harmless and good practice if you run Redis.
  - sysctl -w vm.overcommit_memory=1
  - echo 'vm.overcommit_memory=1' >> /etc/sysctl.conf
```

### 1e. Create floating IP (stable DNS target)
```bash
hcloud floating-ip create \
  --type ipv4 \
  --home-location hel1 \
  --name rorca-prod-ip

# Assign to VM
hcloud floating-ip assign rorca-prod-ip coolify-main

# Get the IP
hcloud floating-ip list
```

### 1f. Configure floating IP on the VM
```bash
# SSH into the VM
ssh -i ~/.ssh/hetzner_ed25519 root@<VM_PUBLIC_IP>

# Create netplan config for floating IP
# File: /etc/netplan/99-floating-ipv4.yaml
cat > /etc/netplan/99-floating-ipv4.yaml << 'EOF'
network:
  version: 2
  ethernets:
    eth0:
      addresses:
        - <FLOATING_IP>/32
EOF

# Apply
netplan apply

# Verify
ip addr show eth0 | grep <FLOATING_IP>
```

**Note**: Use `99-floating-ipv4.yaml` (high number) to ensure it loads after cloud-init's `50-cloud-init.yaml`. Using a lower number can conflict with cloud-init's network config.

### 1g. Firewall rules (Hetzner Cloud Firewall — PRIMARY firewall)

**CRITICAL**: Use Hetzner Cloud Firewall as your primary firewall, NOT UFW. Docker's NAT-based iptables bypass UFW rules entirely — a Docker-exposed port will be accessible from the internet even if UFW blocks it. Hetzner Cloud Firewall operates at the hypervisor level, before traffic reaches the VM, so Docker cannot bypass it.

```bash
hcloud firewall create --name rorca-firewall

# Required: SSH, HTTP, HTTPS, Coolify ports
hcloud firewall add-rule rorca-firewall --direction in --protocol tcp --port 22 --source-ips 0.0.0.0/0
hcloud firewall add-rule rorca-firewall --direction in --protocol tcp --port 80 --source-ips 0.0.0.0/0
hcloud firewall add-rule rorca-firewall --direction in --protocol tcp --port 443 --source-ips 0.0.0.0/0
hcloud firewall add-rule rorca-firewall --direction in --protocol tcp --port 8000 --source-ips 0.0.0.0/0
hcloud firewall add-rule rorca-firewall --direction in --protocol tcp --port 6001 --source-ips 0.0.0.0/0
hcloud firewall add-rule rorca-firewall --direction in --protocol tcp --port 6002 --source-ips 0.0.0.0/0
hcloud firewall add-rule rorca-firewall --direction in --protocol icmp --source-ips 0.0.0.0/0

# Apply to VM
hcloud firewall apply-to-resource rorca-firewall --type server --server coolify-main
```

**Post-setup hardening**: After Coolify is configured with a custom domain and SSL, restrict management ports to your IP only:
```bash
# Remove public access to Coolify dashboard + WebSocket + terminal
hcloud firewall delete-rule rorca-firewall --direction in --protocol tcp --port 8000 --source-ips 0.0.0.0/0
hcloud firewall delete-rule rorca-firewall --direction in --protocol tcp --port 6001 --source-ips 0.0.0.0/0
hcloud firewall delete-rule rorca-firewall --direction in --protocol tcp --port 6002 --source-ips 0.0.0.0/0

# Re-add restricted to your IP
hcloud firewall add-rule rorca-firewall --direction in --protocol tcp --port 8000 --source-ips <YOUR_IP>/32
hcloud firewall add-rule rorca-firewall --direction in --protocol tcp --port 6001 --source-ips <YOUR_IP>/32
hcloud firewall add-rule rorca-firewall --direction in --protocol tcp --port 6002 --source-ips <YOUR_IP>/32
```

---

## Step 2: Coolify Installation

### 2a. Install Coolify (must run as root)
```bash
# SSH into the VM as root (Coolify installer requires root)
ssh -i ~/.ssh/hetzner_ed25519 root@<FLOATING_IP>

# Official one-line installer (installs Docker Engine 24+ and Coolify v4)
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash

# Installation takes 2-5 minutes
# Creates /data/coolify directory, configures Docker, generates SSH keys
# After completion, Coolify is available at http://<SERVER_IP>:8000
```

### 2b. Initial Coolify setup
1. Open `http://<FLOATING_IP>:8000` in browser
2. Create admin account (use a strong password — this controls all your infrastructure)
3. Skip the team setup for solo use
4. On "Server" setup: choose **localhost** (Coolify manages the same VM it runs on)
5. Validate server connection — should show green checkmark
6. Set up email notifications (optional: use Resend, Mailgun, or custom SMTP)

### 2c. Configure domain + SSL in Coolify
1. Settings -> General -> Set **Instance Domain** to `https://coolify.yourdomain.com`
2. Coolify auto-provisions SSL via Traefik + Let's Encrypt
3. After domain works with SSL, restrict ports 8000/6001/6002 in Hetzner Firewall (step 1g)

### 2d. Connect GitHub (for Rorca deployment)
1. Settings -> Source -> Add GitHub App
2. Follow OAuth flow — creates a GitHub App in your account
3. Install GitHub App on the `getrorca/rorca` repo (private)
4. Coolify will clone and build from GitHub on each deploy

---

## Step 3: PostgreSQL via Coolify

### 3a. Add PostgreSQL service
1. In Coolify: New Resource -> Database -> PostgreSQL 16
2. Name: `rorca-postgres`
3. Set credentials:
   - DB name: `rorca`
   - User: `rorca`
   - Password: (generate a strong password, save it)
4. **Network**: set to internal only (no public port exposure)
5. Deploy

### 3b. Install pgvector + Apache AGE extensions

Coolify deploys PostgreSQL as a Docker container. To add extensions required by Rorca:

Create a custom Dockerfile for the Postgres service in Coolify:
```dockerfile
# Use the official pgvector image — includes pgvector pre-installed
# Do NOT use FROM postgres:16 + apt-get install postgresql-16-pgvector.
# That package requires the PostgreSQL APT repo to be configured first,
# which is not present in the stock postgres:16 Debian image. The pgvector
# maintainers publish pre-built images to avoid this complexity.
FROM pgvector/pgvector:pg16

# Enable pgvector in your database after container starts:
#   psql -U rorca -d rorca -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Apache AGE for knowledge graph (optional)
# AGE requires building from source — add if needed:
# RUN apt-get update && apt-get install -y build-essential libreadline-dev bison flex && \
#     git clone https://github.com/apache/age.git /tmp/age && \
#     cd /tmp/age && make && make install && rm -rf /tmp/age
```

Or use Coolify's "Custom Docker Compose" resource type to deploy a Postgres container with extensions pre-installed.

**Note**: Rorca's `pg-index.ts` does NOT run `CREATE EXTENSION vector` automatically. You must run it once after first deploy:
```bash
docker exec -it <postgres-container-id> psql -U rorca -d rorca -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### 3c. Get internal connection string
Coolify provides an internal Docker network hostname. Use this in Rorca's env:
```
DATABASE_URL=postgres://rorca:<password>@<coolify-internal-host>:5432/rorca
```

The internal hostname is shown in Coolify under the service's Connection tab.

---

## Step 4: Rorca Deployment via Coolify

### 4a. Add Rorca as a service
1. New Resource -> Application -> From GitHub
2. Select the `getrorca/rorca` repo
3. Build settings:
   - Build pack: **Dockerfile** (preferred — gives full control)
   - Port: `3030`
4. Domain: `pre-prod.yourdomain.com`
5. SSL: Enable (Coolify handles via Traefik automatically)

### 4b. Environment variables in Coolify
Set these in the service's Environment tab:
```bash
NODE_ENV=production
PORT=3030
DATABASE_URL=postgres://rorca:<password>@<internal-host>:5432/rorca
RORCA_AGENT=claude
RORCA_SERVE_STATIC=1
RORCA_STATIC_DIR=/app/dist
ANTHROPIC_API_KEY=<key>
OPENROUTER_API_KEY=<key>
JWT_SECRET=<generate-random-64-char-hex>
CORS_ORIGIN=https://pre-prod.yourdomain.com
```

### 4c. Dockerfile for Rorca (add to repo root if not present)
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app

# Install root dependencies (frontend)
COPY package*.json ./
RUN npm ci

# Copy all source
COPY . .

# Build frontend (Vite)
RUN npm run build

# Build backend (TypeScript)
WORKDIR /app/backend
RUN npm ci
RUN npx tsc --project tsconfig.json

# Production stage
FROM node:20-alpine
WORKDIR /app

# Frontend build output
COPY --from=builder /app/dist ./dist

# Backend compiled output
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/node_modules ./backend/node_modules
COPY --from=builder /app/backend/package.json ./backend/package.json

# Migrations (run on startup)
COPY --from=builder /app/backend/src/db/pg-migrations ./backend/src/db/pg-migrations

EXPOSE 3030
CMD ["node", "backend/dist/server.js"]
```

### 4d. Worker process (pg-boss) — SEPARATE Coolify service
Rorca requires a separate worker process for pipeline execution. In Coolify:
1. New Resource -> Application -> From same GitHub repo
2. Name: `rorca-worker`
3. Start command override: `node backend/dist/worker.js`
4. **No port/domain needed** (worker is a background process, no HTTP server)
5. Same environment variables as rorca-app (especially DATABASE_URL)
6. **Disable "Health Check"** — worker has no HTTP endpoint; Coolify's default health check (HTTP GET /) will falsely report unhealthy
7. Restart policy: `unless-stopped` (worker should auto-restart on crash)

---

## Step 5: DNS Configuration

```
# Floating IP: 65.21.XX.XX (example)

# Point root/subdomain at floating IP
A     pre-prod.yourdomain.com    65.21.XX.XX    TTL: 300
A     coolify.yourdomain.com     65.21.XX.XX    TTL: 300

# Wildcard (optional — lets Coolify create subdomains dynamically)
A     *.yourdomain.com           65.21.XX.XX    TTL: 300
```

Propagation: 5-30 minutes. Verify with `dig pre-prod.yourdomain.com`.

**GitHub webhook requirement**: If using GitHub integration, ports 80 and 443 must be open to the internet (not IP-restricted). GitHub webhook IPs rotate frequently — check `https://api.github.com/meta` for current ranges if you want to restrict.

---

## Step 6: Persistent Storage

### Volumes for Rorca data
Rorca stores spec JSON files and workspace config in the filesystem. In Coolify:
1. Service -> Storage -> Add Volume
2. Mount path: `/app/forge` (spec JSON files — pending, approved, logs)
3. Mount path: `/app/.rorca` (memory, config, skills, personas)
4. These persist across deploys and container restarts

**Without volumes, every redeploy wipes spec files. This is the #1 cause of data loss.**

### Database backups
Coolify has built-in S3 backup for databases. Configure with Hetzner Object Storage:
1. In Coolify: the Postgres service -> Backups -> Enable
2. Schedule: daily at 03:00 UTC
3. Retention: 7 days
4. Destination: Hetzner Object Storage bucket (see section below)

---

## Monitoring & Observability

### Coolify built-in
- CPU/RAM/disk per service in real time
- Log viewer per service (tails Docker logs)
- Restart policies: `unless-stopped` (default) — Coolify restarts crashed containers
- Auto-updates: Coolify can self-update (Settings -> Auto Update)

### Recommended additions (all installable as Coolify services)
```
Uptime Kuma    — lightweight uptime monitoring, alerts on downtime
Plausible      — privacy-friendly analytics for the Rorca landing page
```

### Hetzner metrics
Hetzner Cloud Console shows VM-level CPU/RAM/bandwidth/disk graphs. No agent needed — built into the platform. Set alerts for CPU > 80% sustained.

---

## Security Hardening Checklist

- [ ] Root SSH login disabled (done via cloud-init)
- [ ] Password authentication disabled (done via cloud-init)
- [ ] **Hetzner Cloud Firewall is the PRIMARY firewall** (NOT UFW — Docker bypasses UFW)
- [ ] Coolify ports (8000, 6001, 6002) restricted to your IP after domain setup
- [ ] Postgres not exposed on public port (internal Docker network only)
- [ ] All secrets in Coolify environment variables (not in repo, not in Dockerfile)
- [ ] JWT_SECRET is a random 64-char hex: `openssl rand -hex 32`
- [ ] Fail2ban active (installed via cloud-init)
- [ ] Automatic security updates enabled (unattended-upgrades)
- [ ] Backups configured: Coolify S3 backup for Postgres + Hetzner snapshots for VM
- [ ] SSH key is ed25519 (not RSA) with passphrase

---

## Hetzner Object Storage (backups)

```bash
# Create bucket in Hetzner Console: Object Storage -> Create Bucket -> rorca-backups
# Select same region as your VM (e.g., nbg1)

# Configure in Coolify: Storages -> Add a new S3 Storage
# Endpoint: https://nbg1.your-objectstorage.com (region-specific)
#           Available regions: nbg1, fsn1, hel1
# Bucket:   rorca-backups
# Region:   can be anything (nbg1, us-east-1, etc. — Hetzner doesn't enforce this)
# Access key: (from Hetzner Console -> Object Storage -> Credentials)
# Secret key:  (from Hetzner Console -> Object Storage -> Credentials)
# Then: Settings -> Backup -> Enable "S3 Enabled" and select your storage
```

**KNOWN BUG (Coolify GitHub issue #6690, open as of 2026)**: Hetzner S3 backups may show a green success checkmark but files never appear in the bucket. This is an intermittent Coolify state management bug.
**Workaround**: If backups aren't appearing after 24h, delete the backup schedule and recreate it — this consistently resolves the issue. Test immediately after creating by manually triggering a backup.

---

## Troubleshooting

### Coolify UI unreachable after install
```bash
# Check Docker and Coolify containers
docker ps -a | grep coolify
docker logs coolify --tail 50

# Restart Coolify
docker restart coolify

# Check if port 8000 is open in Hetzner Cloud Firewall (not just UFW!)
```

### Service won't start — "Port already in use"
```bash
# Coolify uses Traefik for routing — all apps bind to 80/443 via Traefik
# Check Traefik logs
docker logs coolify-proxy --tail 50

# If port 80/443 is taken by Apache/Nginx:
systemctl stop nginx apache2 2>/dev/null
systemctl disable nginx apache2 2>/dev/null
```

### Docker bypassing firewall rules
```bash
# UFW rules do NOT apply to Docker containers!
# Docker uses NAT-based iptables that bypass UFW.
# Solutions:
# 1. (Recommended) Use Hetzner Cloud Firewall — operates at hypervisor level
# 2. Install ufw-docker: https://github.com/chaifeng/ufw-docker
# 3. Configure Docker daemon to bind only to localhost:
#    echo '{"iptables": false}' > /etc/docker/daemon.json && systemctl restart docker
#    WARNING: "iptables: false" breaks inter-container networking — test thoroughly
```

### Database connection refused from app
```bash
# Check if postgres container is on the same Docker network as the app
docker network inspect coolify
# Both app and postgres containers should appear in the same network

# Test connection from inside the app container
docker exec -it <app-container-id> sh
nc -zv <postgres-internal-host> 5432
```

### Rorca worker not picking up jobs
```bash
# Check worker container logs in Coolify
# Look for: "[worker] ready — listening for pipeline:run..."
# If missing, the worker process crashed — check DATABASE_URL is set correctly

# Also check: worker_heartbeat table
docker exec -it <postgres-container-id> psql -U rorca -d rorca -c "SELECT * FROM worker_heartbeat;"
```

### SSL certificate not issued
```bash
# Traefik attempts Let's Encrypt on first HTTPS request to the domain
# Domain MUST resolve to the server IP BEFORE SSL can be issued
dig yourdomain.com   # must show Hetzner floating IP

# Check Traefik ACME logs
docker logs coolify-proxy --tail 100 2>&1 | grep -i acme

# Common cause: DNS not propagated yet — wait 5-30 min after setting A record
# Common cause: Port 80 blocked — Let's Encrypt HTTP-01 challenge needs port 80 open
```

### Floating IP not working
```bash
# Verify netplan config exists
cat /etc/netplan/99-floating-ipv4.yaml

# Verify IP is assigned
ip addr show eth0 | grep <FLOATING_IP>

# If missing, re-apply
netplan apply

# Also verify floating IP is assigned in Hetzner Console
hcloud floating-ip list
```

---

## Cost Summary (pre-prod, March 2026)

| Resource | Monthly Cost (EUR) |
|----------|------------------|
| CX33 VM (Coolify + app + worker + postgres) | 5.49 |
| Floating IPv4 | ~4.00 |
| Private network | Free |
| Network egress (20TB included) | Free |
| Object Storage 50GB (backups) | ~3.00 |
| **Total** | **~13/mo** |

Compare: Railway ($5/service x 3 + $7 Postgres) = ~$22/mo. Heroku ($7/dyno x 3 + $9 Postgres) = $30/mo.

**Post April 1, 2026 price increase**: CX33 -> ~€7, total -> ~€15/mo.

---

## Rorca-Specific Notes

1. **RORCA_SERVE_STATIC=1** — serves the built React frontend from the Express backend on port 3030. No separate Nginx/Caddy needed. Single container, single port. Traefik routes the domain to this port.

2. **Worker is mandatory** — pipeline runs don't execute without the worker process. Deploy it as a separate Coolify service pointing at the same Docker image with `node backend/dist/worker.js` as the start command. Without the worker, `POST /api/pipeline/trigger` will queue jobs that never execute.

3. **`forge/` directory needs a persistent volume** — Rorca reads/writes spec JSON files to `forge/specs/`. Without a Coolify persistent volume mounted at `/app/forge`, every redeploy wipes your specs. This is the most common setup mistake.

4. **Claude CLI on the runner VM** — `claude --print` requires an authenticated Claude session. On the runner VM, run `claude auth login` once interactively, then mount `~/.claude/` as a volume so Rorca's execution engine inherits credentials across container restarts.

5. **Postgres migrations run automatically** — Rorca's `pg-index.ts` runs all pending migrations on startup. The `DATABASE_URL` just needs to point at a running Postgres instance — no manual migration step needed.

6. **Apache AGE extension** — If using the knowledge graph feature, PostgreSQL needs Apache AGE. This requires building from source in the Postgres Docker image (see Step 3b). It's optional — Rorca works without it but graph-based features (knowledge graph, drift detection) will be disabled.

7. **pgvector extension** — Required for memory embeddings and semantic search. Install via `apt-get install postgresql-16-pgvector` in the Postgres Dockerfile (see Step 3b). Without it, `retrieveContext()` falls back to text matching only.

8. **Environment parity** — The same `DATABASE_URL`, `RORCA_AGENT`, and API keys must be set on BOTH the app and worker Coolify services. They share the same database but run as separate containers. A common bug: worker can't find workspace because it has a different `DATABASE_URL`.
