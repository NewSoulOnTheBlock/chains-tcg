# Migration runner — a one-shot job, not a service.
#
# Build context is `new-backend/` (see docker-compose.yml) but this image only
# needs `db/`, so it stays tiny and does not depend on any service existing yet.
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY db/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY db/migrate.mjs ./migrate.mjs
COPY db/migrations ./migrations

# Non-root. `node` (uid 1000) ships with the base image.
USER node

# No healthcheck: this container is expected to run to completion and exit 0.
CMD ["node", "migrate.mjs"]
