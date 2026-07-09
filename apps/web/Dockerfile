# syntax=docker/dockerfile:1
FROM node:22-slim AS base
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
RUN useradd --system --uid 1001 nextjs
ENV NODE_ENV=production
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 3000
ENV PORT=3000
CMD ["node", "apps/web/server.js"]
