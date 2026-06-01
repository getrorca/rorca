# Rorca Production Deployment Guide

Step-by-step instructions for deploying Rorca to a production server.

## Prerequisites

- Linux server (Ubuntu 22.04+ recommended) or macOS
- Docker 24+ and Docker Compose v2
- Domain name with DNS pointed to your server
- SSL certificate (Let's Encrypt recommended)
- 2GB+ RAM, 10GB+ disk

## 1. Clone and Configure

```bash
git clone https://github.com/your-org/rorca.git /opt/rorca
cd /opt/rorca
```

Copy and fill in environment variables:

```bash
cp deploy/env.production.example .env
```

**Required variables** (see `deploy/env.production.example` for full docs):

| Variable | Example | Notes |
|----------|---------|-------|
| `JWT_SECRET` | (generate below) | Auth token signing key |
| `CORS_ORIGIN` | `https://app.rorca.dev` | Exact frontend URL |
| `RORCA_BASE_URL` | `https://app.rorca.dev` | OAuth callbacks |

Generate a secure JWT secret:

```bash
openssl rand -base64 32
```

## 2. SSL Certificate

### Option A: Let's Encrypt (recommended)

```bash
# Install certbot
sudo apt install certbot

# Get certificate (standalone — stop nginx first if running)
sudo certbot certonly --standalone -d app.rorca.dev

# Certificates saved to:
#   /etc/letsencrypt/live/app.rorca.dev/fullchain.pem
#   /etc/letsencrypt/live/app.rorca.dev/privkey.pem
```

Copy or symlink certificates for nginx:

```bash
sudo mkdir -p /etc/nginx/ssl
sudo ln -sf /etc/letsencrypt/live/app.rorca.dev/fullchain.pem /etc/nginx/ssl/fullchain.pem
sudo ln -sf /etc/letsencrypt/live/app.rorca.dev/privkey.pem /etc/nginx/ssl/privkey.pem
```

Set up auto-renewal:

```bash
sudo systemctl enable certbot.timer
```

### Option B: Self-signed (testing only)

```bash
sudo mkdir -p /etc/nginx/ssl
sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/privkey.pem \
  -out /etc/nginx/ssl/fullchain.pem \
  -subj "/CN=localhost"
```

## 3. Nginx Setup

Install the production nginx config:

```bash
# Replace $DOMAIN with your actual domain
sed 's/\$DOMAIN/app.rorca.dev/g' deploy/nginx.conf > /tmp/rorca-nginx.conf
sudo cp /tmp/rorca-nginx.conf /etc/nginx/sites-available/rorca
sudo ln -sf /etc/nginx/sites-available/rorca /etc/nginx/sites-enabled/rorca
sudo rm -f /etc/nginx/sites-enabled/default

# Test and reload
sudo nginx -t
sudo systemctl reload nginx
```

The production config (`deploy/nginx.conf`) includes:
- HTTPS termination with TLS 1.2/1.3
- Security headers (HSTS, CSP, X-Frame-Options, X-Content-Type-Options)
- Gzip compression
- Static asset caching (1 year for hashed assets)
- Rate limiting: 30 req/s API, 5 req/min auth, 3 req/min LLM generation
- SSE proxy with long timeouts for pipeline streaming
- Dotfile access denied

## 4. Database Migration

Database migrations run automatically on first backend startup. PostgreSQL connection is configured via `DATABASE_URL` env var.

For Docker deployments, the `rorca-pgdata` volume persists the database across container restarts. Docker Compose includes a PostgreSQL 16 service with pgvector + Apache AGE extensions.

### Manual migration (non-Docker)

```bash
cd /opt/rorca/backend
DATABASE_URL=postgres://rorca:rorca@localhost:5432/rorca NODE_ENV=production npx tsx src/server.ts
# Server starts, runs migrations, then Ctrl+C
```

Verify:

```bash
psql "$DATABASE_URL" -c "\dt"
# Should list: workspaces, direction_layers, pipeline_runs, story_results, wal_events, ...
```

## 5. Build and Deploy

### Option A: Docker Compose (recommended)

```bash
cd /opt/rorca

# Build images
docker compose build

# Start services
docker compose up -d

# Verify
docker compose ps
docker compose logs -f rorca-backend
```

### Option B: Direct (no Docker)

```bash
# Install dependencies
cd /opt/rorca && npm ci
cd /opt/rorca/backend && npm ci

# Build
cd /opt/rorca && npm run build

# Start backend
cd /opt/rorca/backend
NODE_ENV=production node dist/server.js &

# Serve frontend via nginx (copy build output)
sudo cp -r /opt/rorca/dist/* /usr/share/nginx/html/
sudo systemctl reload nginx
```

## 6. Backup Configuration

### Automated PostgreSQL Backups

Configure the backup directory:

```bash
# .env
BACKUP_DIR=/data/backups
```

Set up a cron job for regular backups using `pg_dump`:

```bash
# Daily backup at 2 AM
echo "0 2 * * * pg_dump \$DATABASE_URL --format=custom --file=/data/backups/rorca-\$(date +\%Y\%m\%d).dump" | sudo crontab -
```

### Off-site Backup

```bash
# Sync backups to S3 (daily, after local backup)
# 15 2 * * * aws s3 sync /data/backups/ s3://your-bucket/rorca-backups/ --delete
```

### Restore from Backup

```bash
# Stop the backend
docker compose stop rorca-backend

# Restore database
pg_restore --clean --if-exists -d "$DATABASE_URL" /data/backups/rorca-20260224.dump

# Restart
docker compose start rorca-backend
```

## 7. Log Rotation

Install the logrotate configuration:

```bash
sudo cp deploy/logrotate.conf /etc/logrotate.d/rorca
```

This rotates:
- Pipeline run logs (daily, 14 days retention, 100MB max)
- Application logs (daily, 30 days retention, 50MB max)
- Nginx access/error logs (daily, 30 days retention)

Test with dry run:

```bash
sudo logrotate -d /etc/logrotate.d/rorca
```

For Docker deployments, container logs are managed by Docker's logging driver. Configure in `daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "5"
  }
}
```

## 8. Health Monitoring

### Health Check Script

```bash
# Basic check
./deploy/healthcheck.sh

# JSON output (for monitoring integrations)
./deploy/healthcheck.sh --json

# Quiet mode (exit code only — for cron/alerting)
./deploy/healthcheck.sh --quiet
```

Exit codes: `0` = healthy, `1` = degraded, `2` = critical.

The script checks:
- Backend API responsiveness
- Database connectivity and file integrity
- Disk space (warn at 85%, critical at 95%)
- Backend process presence
- Stale pipeline run detection

### Monitoring Integration

```bash
# Cron-based alerting (every 5 minutes)
*/5 * * * * /opt/rorca/deploy/healthcheck.sh --quiet || echo "Rorca unhealthy" | mail -s "ALERT" ops@example.com

# Datadog/Nagios custom check
*/1 * * * * /opt/rorca/deploy/healthcheck.sh --json >> /var/log/rorca/healthcheck.json
```

### API Health Endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /api/health` | No | Basic: status, uptime, DB connected, active runs |
| `GET /api/health/detailed` | No | Extended: DB size, memory, pending specs, last backup |

## 9. Security Checklist

- [ ] `JWT_SECRET` is unique, randomly generated, and not the default
- [ ] SSL certificate installed and auto-renewing
- [ ] `.env` file is not in version control (check `.gitignore`)
- [ ] Firewall allows only ports 80, 443, and SSH
- [ ] Database credentials are stored securely (not in code)
- [ ] Nginx denies access to dotfiles
- [ ] Rate limiting is active on auth and LLM endpoints
- [ ] CORS_ORIGIN matches only your frontend domain
- [ ] Optional GitHub tokens/credentials (if used) are provided via environment or local CLI auth, not hardcoded
- [ ] Regular backups are configured and tested with a restore drill

## 10. Troubleshooting

### Backend won't start

```bash
# Check logs
docker compose logs rorca-backend

# Common: port already in use
lsof -ti:3030 | xargs kill -9
```

### Database connection issues

If you see "connection refused" or pool timeout errors:

```bash
# Check PostgreSQL is running
docker compose ps db
docker compose logs db

# Verify connectivity
psql "$DATABASE_URL" -c "SELECT 1"
```

### Stale pipeline runs

After a server restart, running pipelines are orphaned:

```bash
psql "$DATABASE_URL" -c "UPDATE pipeline_runs SET status='failed', finished_at=NOW() WHERE status='running';"
```

### SSE streams disconnecting

Ensure nginx has:
- `proxy_buffering off` on SSE endpoints
- `proxy_read_timeout 3600s` (1 hour minimum)
- No CDN/proxy in front that buffers responses

### Certificate renewal failed

```bash
sudo certbot renew --dry-run
# If standalone fails because port 80 is in use:
sudo certbot renew --webroot -w /usr/share/nginx/html
```
