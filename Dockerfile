# Arc Launchpad — self-hosted UI for Arc
# SvelteKit app with Node adapter

FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Dummy secrets for build-time only (SvelteKit prerender touches server code)
RUN LAUNCHPAD_JWT_SECRET=build-placeholder npm run build

# Production stage
FROM node:22-slim

WORKDIR /app

COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/src/lib/server/disposable-domains.txt ./src/lib/server/disposable-domains.txt

# Create data directory for SQLite
RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV PORT=3000
ENV NODE_ENV=production
ENV LAUNCHPAD_DB_PATH=/app/data/launchpad.db

EXPOSE 3000

# node:22-slim has no curl; use Node's http client for the healthcheck. We use
# http.get on 127.0.0.1 (not fetch) — undici's fetch can fail on IPv6 loopback
# resolution inside some container runtimes. A 302 redirect to /login = healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "build"]
