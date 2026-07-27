# rpc-proxy service — :4005
#
# The ONLY container that holds RPC credentials (audit finding H-5). Nothing
# here is user-facing beyond `POST /rpc/evm`, and that route can only read:
# broadcasting and signing methods are refused by the allowlist, so a leaked
# browser token cannot become a transaction relay.
#
# Build context is `new-backend/` (the workspace root), because this service
# depends on the `@chains/shared` workspace. See docker-compose.yml:
#     build: { context: ., dockerfile: ./services/rpc-proxy/Dockerfile }
#
#     docker build -f services/rpc-proxy/Dockerfile -t chains/rpc-proxy new-backend/

# ---------- build ----------
FROM node:20-alpine AS build
WORKDIR /app

# `npm install` rather than `npm ci`: while the services are being built in
# parallel the lockfile moves under us. Switch to `npm ci` once the tree is
# stable — it is the reproducible-build step.
COPY . .
RUN npm install --no-audit --no-fund \
    && npm run build --workspace @chains/shared \
    && npm run build --workspace @chains/rpc-proxy \
    && npm prune --omit=dev

# ---------- runtime ----------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN apk add --no-cache tini

# node_modules/@chains/shared is a relative symlink into packages/shared,
# which is why both are copied.
COPY --from=build --chown=node:node /app/node_modules                    ./node_modules
COPY --from=build --chown=node:node /app/package.json                    ./package.json
COPY --from=build --chown=node:node /app/packages/shared/package.json    ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist            ./packages/shared/dist
COPY --from=build --chown=node:node /app/services/rpc-proxy/package.json ./services/rpc-proxy/package.json
COPY --from=build --chown=node:node /app/services/rpc-proxy/dist         ./services/rpc-proxy/dist

# Non-root. EVM_RPC_URL arrives through the environment at runtime and is never
# baked into a layer.
USER node
EXPOSE 4005

# Node 20 has a global fetch, so the healthcheck needs no extra package and no
# shell utilities in the image.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4005/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies and forwards SIGTERM so graceful shutdown actually runs.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "services/rpc-proxy/dist/index.js"]
