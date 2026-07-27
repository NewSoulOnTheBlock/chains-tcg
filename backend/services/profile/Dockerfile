# Build context is the REPO ROOT (see backend/docker-compose.yml) so the
# file:../../../packages/game-core dependency resolves inside the image.
FROM node:22-alpine

WORKDIR /app

# Mirror the repo layout the file: dependency expects.
COPY packages/game-core packages/game-core
COPY backend/services/profile backend/services/profile

# game-core is consumed via a file:/symlink, so its own imports (boardgame.io)
# resolve from packages/game-core/node_modules — install them there too.
WORKDIR /app/packages/game-core
RUN npm install --omit=dev

WORKDIR /app/backend/services/profile
RUN npm install --omit=dev

EXPOSE 8001
CMD ["npm", "start"]
