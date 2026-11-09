# syntax=docker/dockerfile:1
#
# The Medusa server and the worker run this same image, differing only in
# MEDUSA_WORKER_MODE. Build context is the repository root.

FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat
RUN corepack enable
WORKDIR /app

# Workspace dependencies, build tooling included
FROM base AS deps
# Every workspace manifest has to be present for --frozen-lockfile to verify the
# lockfile, even though only the backend is installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc turbo.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/storefront/package.json apps/storefront/
RUN pnpm install --frozen-lockfile --filter @dtc/backend...

# Compile the server and the admin dashboard
FROM deps AS builder
COPY apps/backend apps/backend
# Produces apps/backend/.medusa/server: compiled source, the built admin under
# public/admin, and a package.json of only the runtime dependencies.
RUN pnpm --filter @dtc/backend build

# Runtime
FROM base AS runner
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 medusa \
  && adduser --system --uid 1001 medusa \
  && chown medusa:medusa /app
USER medusa

COPY --from=builder --chown=medusa:medusa /app/apps/backend/.medusa/server ./
# .medusa/server is a standalone package rather than a workspace member, so its
# dependencies are resolved here on their own. npm, not pnpm: there is no
# lockfile to be frozen against and npm ships with the image, where corepack
# would resolve whatever pnpm is newest on the day of the build.
#
# --legacy-peer-deps because Medusa's own packages ship a peer range they do not
# satisfy between themselves (draft-order asks for @medusajs/ui 4.2.10 against
# the 4.2.9 the starter pins), which npm treats as fatal and pnpm does not.
RUN npm install --omit=dev --legacy-peer-deps --no-audit --no-fund \
  && npm cache clean --force

COPY --chown=medusa:medusa docker/backend-entrypoint.sh docker/wait-for-tcp.mjs docker/

EXPOSE 9000

ENTRYPOINT ["/app/docker/backend-entrypoint.sh"]
