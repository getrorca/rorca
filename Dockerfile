# ── Stage 1: Build ──────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Native build deps (pg, node-gyp)
RUN apk add --no-cache python3 make g++

# Root deps (frontend)
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

# Backend deps
COPY backend/package.json backend/package-lock.json ./backend/
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
FROM node:20-alpine
RUN apk add --no-cache postgresql16-client
WORKDIR /app

# Copy pruned production node_modules (includes native addons built in stage 1)
COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY --from=build /app/backend/package.json ./backend/

# Copy built frontend
COPY --from=build /app/dist ./dist

# Copy compiled backend
COPY --from=build /app/backend/dist ./backend/dist

# Copy pg-migrations SQL files (migration runner reads from disk)
COPY --from=build /app/backend/src/db/pg-migrations ./backend/src/db/pg-migrations

# Copy entrypoint and package manifests
COPY cli.js package.json ./

ENV NODE_ENV=production
ENV RORCA_SERVE_STATIC=1
ENV RORCA_STATIC_DIR=/app/dist
EXPOSE 3030

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3030/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "cli.js", "start", "--no-open"]
