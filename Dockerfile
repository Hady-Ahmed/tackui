# ─── Stage 1: Install dependencies ─────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ─── Stage 2: Build ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Next.js reads env at build time for some features. Set a dummy DATABASE_URL
# so the build doesn't fail when trying to resolve the pg.Pool at module load
# (the pool is lazy — no real connection is made during build).
ENV DATABASE_URL="postgres://build:build@localhost:5432/build"
# AUTH_DISABLED=true during build prevents the BETTER_AUTH_SECRET boot guard
# in lib/auth/auth.ts from throwing when Next.js collects page data for
# /api/auth/[...all]. This ONLY affects the build step — at runtime the real
# AUTH_DISABLED / BETTER_AUTH_SECRET from docker-compose environment applies.
ENV AUTH_DISABLED="true"
ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* vars are statically inlined into the client JS bundle at
# build time by the Next.js compiler. They CANNOT be supplied at runtime —
# once `next build` runs, the value is frozen in the .next/static chunks.
# Pass them as build args so they're present when `npm run build` executes.
# Default to empty (Sentry client stays a no-op when unset, matching
# instrumentation-client.ts:15's `if (process.env.NEXT_PUBLIC_SENTRY_DSN)` guard).
ARG NEXT_PUBLIC_SENTRY_DSN=""
ARG NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE="0.1"
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=$NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE

RUN npm run build

# ─── Stage 3: Runner ───────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Run as non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy the standalone build (includes minimal server.js + only the needed
# node_modules — much smaller than copying the full node_modules).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Migration SQL files are NOT included in the standalone build (Next.js only
# bundles JS/TS). Copy them separately so instrumentation.ts can read them
# at boot to auto-run migrations.
COPY --from=builder /app/lib/db/migrations ./lib/db/migrations

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
