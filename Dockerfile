# syntax=docker/dockerfile:1

# Node 22.18+ is required, not preferred: the server runs its TypeScript through
# Node's type stripping, so there is no server build step here — only the client
# is compiled. See README.md「必要環境」.
ARG NODE_VERSION=22

# ---- build: compile the SPA into client/dist --------------------------------
FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app

# Manifests first so the install layer survives every source edit.
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY shared/ shared/
COPY client/ client/
RUN npm run build --workspace client

# ---- runtime ----------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime
WORKDIR /app

# The server never reads NODE_ENV (docs/design.md); this is here for the
# libraries that do.
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
# Leaves hono and @hono/node-server. React is pulled in as a client dependency
# even though the runtime never loads it — it is already bundled into dist —
# but a few hundred KB is not worth a hand-maintained install.
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ server/
COPY shared/ shared/
COPY --from=build /app/client/dist client/dist

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]

# No npm in front of node: the process must be PID 1 so SIGTERM reaches the
# signal handler that closes the SQLite database.
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.ts"]
