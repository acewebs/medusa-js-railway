# syntax=docker/dockerfile:1
#
# Build context is the repository root, the same as the other two images.

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 proxy \
  && adduser --system --uid 1001 proxy \
  && chown proxy:proxy /app
USER proxy

COPY --chown=proxy:proxy media-proxy/package.json media-proxy/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --chown=proxy:proxy media-proxy/server.mjs ./

EXPOSE 9200

CMD ["node", "server.mjs"]
