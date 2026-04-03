# Rorca — OVH VPS-3 Deployment

**Target**: OVH VPS-3 · 8 vCPU · 24GB RAM · 200GB NVMe · ~$12.75/mo
**Stack**: Ubuntu 24.04 → Coolify → PostgreSQL 16 (pgvector + AGE) → Rorca API + Worker

---

## Option A — Fully Automated (Recommended)

Order the VPS, provision it, and install Coolify all from one terminal command.

### Prerequisites

- OVH account with billing set up
- SSH key pair (`~/.ssh/id_ed25519` or similar)
- `curl`, `jq`, `openssl` installed locally
- Domain name with DNS access

### One-time: Get OVH API Credentials

Open this URL in a browser and click **Create token**:

```
https://ca.api.ovh.com/createToken/?GET=/me&GET=/vps&GET=/vps/*&POST=/order/cart&POST=/order/cart/*&GET=/order/cart/*&DELETE=/order/cart/*
```

Copy the three values: **Application Key**, **Application Secret**, **Consumer Key**.

### Run the script

```bash
cd ovh-deploy
chmod +x order-vps.sh install-coolify.sh

export OVH_APP_KEY=xxxxxxxxxxxxxxxx
export OVH_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export OVH_CONSUMER_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

./order-vps.sh
```

This will:
1. Verify your credentials and confirm the plan exists in your region
2. Build the order cart, show the total price, and ask for confirmation before charging
3. Place the order and poll until the VPS is provisioned (~5–15 min)
4. SSH in and apply all system configuration (swap, firewall, kernel tuning, SSH hardening)
5. Install Coolify and print the step-by-step UI instructions

**Optional flags:**
```bash
./order-vps.sh --datacenter SBG5    # Strasbourg (EU)
./order-vps.sh --subsidiary FR      # French billing
./order-vps.sh --plan vps-le-2024-04 --datacenter BHS5
```

**Available datacenters:** `BHS5` (Canada), `GRA11` (France), `SBG5` (France), `DE1` (Germany), `UK1` (UK), `SGP1` (Singapore)

---

## Option B — Manual (Step by Step)

### Step 1 — Order the VPS

1. Go to [OVH VPS](https://www.ovhcloud.com/en/vps/) → select **VPS-3**
2. Choose **Ubuntu 24.04**
3. In the **"User data / cloud-init"** field, paste the entire contents of [`cloud-init.yml`](./cloud-init.yml)
4. Add your SSH public key (`cat ~/.ssh/id_ed25519.pub`)
5. Complete the order — provisioning takes ~5 minutes

### Step 2 — Install Coolify

```bash
cd ovh-deploy
chmod +x install-coolify.sh
./install-coolify.sh <YOUR_VPS_IP>
```

This will:
- Wait for the VPS to come online
- Install Coolify via the official installer
- Print step-by-step instructions for the Coolify UI setup

---

## Step 3 — Deploy via Coolify UI

Follow the printed instructions from the script. Summary:

1. Open `http://<VPS_IP>:8000` → create admin account
2. Add PostgreSQL 16 database (`pgvector/pgvector:pg16` image)
3. Add Rorca API application from GitHub (`Dockerfile`, port 3030)
4. Add Rorca Worker application from GitHub (same Dockerfile, start cmd: `node backend/dist/worker.js`)
5. Set domain + enable Let's Encrypt SSL

---

## Required Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Postgres connection string from Coolify DB |
| `NODE_ENV` | `production` |
| `JWT_SECRET` | Random 32-byte hex: `openssl rand -hex 32` |
| `CORS_ORIGIN` | Your domain, e.g. `https://rorca.yourdomain.com` |
| `RORCA_SERVE_STATIC` | `1` (serves frontend from same process) |
| `RORCA_STATIC_DIR` | `/app/dist` |
| `RORCA_PROCESS_ROLE` | `worker` (worker service only) |

Optional:
| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | For spec generation via Anthropic API |
| `OPENROUTER_API_KEY` | For OpenRouter execution engine |
| `GITHUB_OAUTH_CLIENT_ID` | GitHub integration |
| `GITHUB_OAUTH_CLIENT_SECRET` | GitHub integration |

---

## Verify Deployment

```bash
# API health
curl https://yourdomain.com/api/health

# Worker health (should show last_seen < 90s ago)
curl https://yourdomain.com/api/pipeline/worker/health

# MCP endpoint (397 tools)
curl -X POST https://yourdomain.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

---

## VPS-3 Resource Fit

| Component | Usage | VPS-3 headroom |
|-----------|-------|----------------|
| Rorca API | ~200MB RAM | ✅ 24GB available |
| Rorca Worker | ~150MB RAM | ✅ |
| PostgreSQL 16 + AGE | ~500MB–2GB RAM | ✅ |
| AGE extension build | 8GB swap burst | ✅ (8GB swap configured) |
| Parallel pipeline runs | 1–4 concurrent | ✅ 8 vCPU handles it |
| NVMe storage | DB + logs + backups | ✅ 200GB |
