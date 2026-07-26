# ── Stage 1: Build ──────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# Native build deps (pg, node-gyp)
RUN apk add --no-cache python3 make g++

# Root deps (frontend)
COPY package.json package-lock.json ./
# Backend is installed and verified explicitly below; avoid the root postinstall
# before its scripts and package manifest are available in this build stage.
RUN npm ci --legacy-peer-deps --ignore-scripts

# Backend deps. The backend postinstall runs the node-pty verifier, so make
# that script available before npm invokes lifecycle hooks.
COPY backend/package.json backend/package-lock.json ./backend/
COPY backend/scripts/verify-node-pty-install.js ./backend/scripts/
RUN cd backend && npm ci

# Copy source
COPY . .

# Build frontend (Vite → dist/)
RUN npx vite build

# Build backend (tsc → backend/dist/); fail the image build on compiler errors.
RUN cd backend && npx tsc

# Prune dev dependencies from backend node_modules
RUN cd backend && npm prune --omit=dev

# ── Stage 2: Runtime ────────────────────────────────────────────────────
FROM node:22-alpine

# Runtime tools needed by the execution engine. git/ssh are required for
# branch/worktree runs, and all supported agent CLIs are installed so Rorca can
# switch between claude, codex, opencode, and pi without rebuilding per-agent.
ARG INSTALL_AGENT_CLIS=true
# Defaults are pinned to the authenticated PTY v2 certification matrix. Override
# deliberately at build time when certifying a newer provider release.
ARG CLAUDE_CODE_NPM_PACKAGE=@anthropic-ai/claude-code@2.1.195
ARG CODEX_NPM_PACKAGE=@openai/codex@0.144.4
ARG OPENCODE_NPM_PACKAGE=opencode-ai@1.17.10
ARG PI_NPM_PACKAGE=@earendil-works/pi-coding-agent@0.80.6
RUN apk add --no-cache \
    bash \
    bubblewrap \
    git \
    github-cli \
    openssh-client \
    postgresql16-client \
    python3 \
    ripgrep \
  && if [ "$INSTALL_AGENT_CLIS" = "true" ]; then \
    npm install -g \
      "$CLAUDE_CODE_NPM_PACKAGE" \
      "$CODEX_NPM_PACKAGE" \
      "$OPENCODE_NPM_PACKAGE" \
      "$PI_NPM_PACKAGE" \
    && claude --version \
    && codex --version \
    && opencode --version \
    && pi --version; \
  fi \
  && npm cache clean --force
WORKDIR /app

# Copy pruned production node_modules (includes native addons built in stage 1)
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/package.json ./backend/
# Retain the verifier so Linux runtime certification can exercise the same
# require/helper/spawn contract after the production image is assembled.
COPY --from=build /app/backend/scripts/verify-node-pty-install.js ./backend/scripts/

# Copy built frontend
COPY --from=build /app/dist ./dist

# Copy compiled backend
COPY --from=build /app/backend/dist ./backend/dist

# Copy pg-migrations SQL files (migration runner reads from disk)
COPY --from=build /app/backend/src/db/pg-migrations ./backend/src/db/pg-migrations

# Copy entrypoint and package manifests
COPY cli.js package.json ./

ENV NODE_ENV=production
# Every autonomous/model-controlled subprocess must cross the worker's verified
# PID/mount/user/network namespace boundary. Runtime preflight fails closed when
# the host kernel/container policy does not permit bubblewrap isolation.
ENV RORCA_AUTONOMOUS_ISOLATION=linux-bwrap
ENV RORCA_BWRAP_BIN=/usr/bin/bwrap
ENV RORCA_AUTONOMOUS_MODEL_EGRESS_HOSTS=api.anthropic.com,api.openai.com,openrouter.ai,generativelanguage.googleapis.com
ENV RORCA_SERVE_STATIC=1
ENV RORCA_STATIC_DIR=/app/dist
EXPOSE 3030

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3030/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "cli.js", "start", "--no-open"]
