# syntax=docker/dockerfile:1
FROM node:22-slim AS base
# Installed in the shared base (not just the runner) so `prisma generate`
# detects the same OpenSSL version at build time that will actually be
# present at runtime — node:22-slim has no OpenSSL by default, so without
# this Prisma silently falls back to guessing "openssl-1.1.x" for the
# engine it bundles, then fails outright at runtime once a real OpenSSL
# 3.0.x is only added to the final stage (a real bundling mismatch, not
# just a log warning — hit and confirmed via a local `docker run` before
# adding this build-stage installation too).
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable

# --- deps: install workspace dependencies ---
FROM base AS deps
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile --filter=@specmate/web...

# --- build ---
FROM base AS build
WORKDIR /repo
COPY --from=deps /repo /repo
RUN pnpm --filter=@specmate/web run prisma:generate
RUN pnpm --filter=@specmate/web run build

# --- run ---
FROM node:22-slim AS runner
WORKDIR /app
# A fresh FROM, not inherited from `base` — needs its own OpenSSL install
# too (see `base`'s comment above for why this matters on both sides).
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 1001 nextjs
ENV NODE_ENV=production
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 3000
ENV PORT=3000
CMD ["node", "apps/web/server.js"]
