# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# DexScreener Boost Tracker — production image
#
# Build:  docker build -t dex-boost-bot .
# Run:    docker run --rm -e TELEGRAM_BOT_TOKEN=... -e PORT=8080 -p 8080:8080 dex-boost-bot
#
# Works on any Docker host (Railway, Fly.io, Koyeb, a VPS, ...) — the image
# contains ONLY the api-server + its production dependencies, so it is small
# and starts fast (no cold-start API misses).
# ---------------------------------------------------------------------------

# ── Stage 1: build the bundled server ──────────────────────────────────────
FROM node:20-slim AS build
RUN corepack enable
WORKDIR /repo

# Workspace manifests first (cache-friendly), then sources.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json tsconfig.base.json ./
COPY artifacts artifacts
COPY lib lib
COPY scripts scripts

RUN pnpm install --frozen-lockfile \
 && pnpm --filter @workspace/api-server run build

# Prune to production dependencies only (includes @workspace/db → pg, which
# the bundle requires at runtime because pg is externalized in build.mjs).
# --legacy: this workspace doesn't use inject-workspace-packages.
RUN pnpm --filter @workspace/api-server deploy --prod --legacy /app

# ── Stage 2: runtime ───────────────────────────────────────────────────────
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app /app
COPY --from=build /repo/artifacts/api-server/dist ./dist
COPY --from=build /repo/artifacts/api-server/public ./public

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Non-root user for defense in depth.
USER node

CMD ["node", "--enable-source-maps", "dist/index.mjs"]
