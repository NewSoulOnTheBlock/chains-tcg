# Wager service — :4004
#
# Escrow deposits, settlement, payouts and booster tickets. This is the only
# container that ever holds a signing key, and it holds TWO distinct ones
# (WAGER_ESCROW_KEYPAIR and BOOSTER_TREASURY_KEYPAIR — audit finding H-4).
#
# Build context is `new-backend/` (the workspace root), because this service
# depends on the `@chains/shared` workspace. See docker-compose.yml:
#     build: { context: ., dockerfile: ./services/wager/Dockerfile }
#
#     docker build -f services/wager/Dockerfile -t chains/wager new-backend/

# ---------- build ----------
FROM node:20-alpine AS build
WORKDIR /app

# `npm install` rather than `npm ci`: while the services are being built in
# parallel the lockfile moves under us. Switch to `npm ci` once the tree is
# stable — it is the reproducible-build step.
COPY . .
RUN npm install --no-audit --no-fund \
    && npm run build --workspace @chains/shared \
    && npm run build --workspace @chains/wager \
    && npm prune --omit=dev

# ---------- runtime ----------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN apk add --no-cache tini

# node_modules/@chains/shared is a relative symlink into packages/shared,
# which is why both are copied.
COPY --from=build --chown=node:node /app/node_modules                 ./node_modules
COPY --from=build --chown=node:node /app/package.json                 ./package.json
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist         ./packages/shared/dist
COPY --from=build --chown=node:node /app/services/wager/package.json  ./services/wager/package.json
COPY --from=build --chown=node:node /app/services/wager/dist          ./services/wager/dist

# Non-root. The escrow keypair arrives through the environment at runtime and is
# never baked into a layer.
USER node
EXPOSE 4004

# Node 20 has a global fetch, so the healthcheck needs no extra package and no
# shell utilities in the image.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4004/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies and forwards SIGTERM, so the settlement worker drains
# instead of being killed between "broadcast" and "recorded".
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "services/wager/dist/index.js"]
