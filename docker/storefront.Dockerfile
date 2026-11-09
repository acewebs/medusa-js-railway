# syntax=docker/dockerfile:1
#
# Build context is the repository root.
#
# The NEXT_PUBLIC_ values are build arguments, not just environment: Next inlines
# them into the client bundle, so they have to be known while this runs. On
# Railway a service variable is passed to the build as a build argument of the
# same name, and the publishable key is a value both services share rather than
# one the backend generates, so this builds correctly even on the very first
# deploy, when no backend exists yet.

FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat
RUN corepack enable
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/storefront/package.json apps/storefront/
RUN pnpm install --frozen-lockfile --filter @dtc/storefront...

FROM deps AS builder
ARG NEXT_PUBLIC_MEDUSA_BACKEND_URL
ARG NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_DEFAULT_REGION
ARG NEXT_PUBLIC_BASE_URL
ARG NEXT_PUBLIC_STRIPE_KEY
ENV NEXT_PUBLIC_MEDUSA_BACKEND_URL=$NEXT_PUBLIC_MEDUSA_BACKEND_URL \
  NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=$NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY \
  NEXT_PUBLIC_DEFAULT_REGION=$NEXT_PUBLIC_DEFAULT_REGION \
  NEXT_PUBLIC_BASE_URL=$NEXT_PUBLIC_BASE_URL \
  NEXT_PUBLIC_STRIPE_KEY=$NEXT_PUBLIC_STRIPE_KEY \
  NODE_ENV=production
COPY apps/storefront apps/storefront
RUN pnpm --filter @dtc/storefront build

FROM base AS runner
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nextjs \
  && adduser --system --uid 1001 nextjs \
  && chown nextjs:nextjs /app
USER nextjs

# Standalone output, plus the two directories Next does not trace into it.
COPY --from=builder --chown=nextjs:nextjs /app/apps/storefront/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/apps/storefront/.next/static ./apps/storefront/.next/static
COPY --from=builder --chown=nextjs:nextjs /app/apps/storefront/public ./apps/storefront/public

EXPOSE 8000

# Railway injects PORT; 8000 is what the starter uses locally.
ENV PORT=8000 HOSTNAME=0.0.0.0

CMD ["node", "apps/storefront/server.js"]
