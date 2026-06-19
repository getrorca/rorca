# Supabase Free Tier Setup

Rorca supports [Supabase](https://supabase.com) as a zero-cost, zero-maintenance PostgreSQL backend. The free tier includes:

- **500 MB database** — enough for hundreds of specs and thousands of runs
- **Auto-APIs** — REST and GraphQL auto-generated from your schema
- **Auth** — built-in authentication (if you enable multi-user mode)
- **No credit card required**

## Setup (5 minutes)

### 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) → Sign up
2. Click **New project**
3. Choose an organization, name your project (e.g., `rorca`)
4. Set a **database password** (save this — you'll need it)
5. Choose the **free tier** (500 MB)
6. Click **Create project** — wait ~2 minutes for provisioning

### 2. Get your connection string

1. In your Supabase dashboard, go to **Project Settings → Database**
2. Under **Connection string**, select **URI**
3. Check **Use connection pooling** (recommended for serverless/container workloads)
4. Copy the connection string. It looks like:
   ```
   postgresql://postgres.[ref]:[password]@aws-0-us-west-1.pooler.supabase.com:6543/postgres
   ```

### 3. Run Rorca with Supabase

**Docker Compose:**
```bash
# Create override file
cp docker-compose.supabase.yml docker-compose.override.yml

# Set your connection string
export SUPABASE_DB_URL="postgresql://postgres.abc123:your-password@aws-0-us-west-1.pooler.supabase.com:6543/postgres"

# Start Rorca (no local PostgreSQL needed)
docker compose up -d rorca worker
```

**npm / direct:**
```bash
export DATABASE_URL="postgresql://postgres.abc123:your-password@aws-0-us-west-1.pooler.supabase.com:6543/postgres"
export RORCA_DB_MODE=byop
rorca start
```

### 4. Verify

```bash
rorca doctor
# Should show: Database ✓ (Supabase, PostgreSQL 18)
```

## What the free tier gives you

| Resource | Free Tier Limit | Is it enough? |
|----------|----------------|---------------|
| Database size | 500 MB | ✅ Yes — specs + runs are lightweight |
| Bandwidth | 2 GB/month | ✅ Yes — text-based, not media-heavy |
| API requests | Unlimited | ✅ Yes |
| Auth users | Unlimited | ✅ Yes (if you enable multi-user) |
| Projects | 2 per org | ✅ Yes |
| Backups | 7 days PITR | ✅ Yes — free automatic backups |

## Upgrading later

If you outgrow the free tier:
- **Pro tier ($25/month):** 8 GB database, 50 GB bandwidth, daily backups, no project pause
- **Keep using the same connection string** — just update your billing in Supabase

## Notes

- **Connection pooling is ON by default** on port 6543. Use port 5432 for direct connections.
- **pgvector is included** in all Supabase projects — no extension setup needed.
- **Apache AGE (graph extension)** is NOT available on Supabase. Graph features will show a "lite mode" indicator. All core features (specs, pipeline, memory, retrieval) work without AGE.
- **IPv4 is required** — Supabase uses IPv4. Make sure your Docker host has IPv4 enabled.
