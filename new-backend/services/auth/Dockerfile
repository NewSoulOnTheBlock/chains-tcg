# Auth service — :4001
#
# Build context is `new-backend/` (the workspace root), because this service
# depends on the `@chains/shared` workspace. See docker-compose.yml:
#     build: { context: ., dockerfile: ./services/auth/Dockerfile }
#
# The other services follow the same pattern — copy the workspace root, install,
# build `@chains/shared` first, then the service.

# ---------- build ----------
FROM node:20-alpine AS build
WORKDIR /app

# `npm install` rather than `npm ci`: while the five services are being built in
# parallel the lockfile moves under us. Switch to `npm ci` once the tree is
# stable — it is the reproducible-build step.
COPY . .
RUN npm install --no-audit --no-fund \
    && npm run build --workspace @chains/shared \
    && npm run build --workspace @chains/auth \
    && npm prune --omit=dev

# ---------- runtime ----------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN apk add --no-cache tini

# node_modules/@chains/shared is a relative symlink into packages/shared,
# which is why both are copied.
COPY --from=build --chown=node:node /app/node_modules              ./node_modules
COPY --from=build --chown=node:node /app/package.json              ./package.json
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist      ./packages/shared/dist
COPY --from=build --chown=node:node /app/services/auth/package.json  ./services/auth/package.json
COPY --from=build --chown=node:node /app/services/auth/dist        ./services/auth/dist

USER node
EXPOSE 4001

# Node 20 has a global fetch, so the healthcheck needs no extra package and no
# shell utilities in the image.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4001/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies and forwards SIGTERM, so graceful shutdown actually runs.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "services/auth/dist/index.js"]
