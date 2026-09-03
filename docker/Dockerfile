# Multi-stage build: the app is compiled INSIDE Docker, so a plain clone
# of this repository is enough — the host needs only Docker, no Node/npm.
# Build from the repo root as context (see docker/docker-compose.yaml):
#   docker build -f docker/Dockerfile -t weblate-friendly-bridge:latest .
# or: docker compose -f docker/docker-compose.yaml up -d --build

# ---- Build stage: install dependencies and produce dist/ ----
FROM node:22-alpine AS build

WORKDIR /app

# Dependencies first (their own layer: cached unless the lockfile changes).
COPY package.json package-lock.json ./
RUN npm ci

# Then the sources (public/ ships the vendored Swagger UI assets).
COPY . .
RUN npm run build

# ---- Runtime stage: self-contained server bundle + built frontend ----
# The esbuild server bundle needs no node_modules; the Express server
# serves dist/client from the working directory.
FROM node:22-alpine

WORKDIR /app

COPY --from=build /app/dist/server/index.cjs dist/server/index.cjs
COPY --from=build /app/dist/client dist/client

# app.listen(port) binds all interfaces, so the port is reachable
# from outside the container without extra configuration.
ENV PORT=4000

EXPOSE 4000

USER node

CMD ["node", "dist/server/index.cjs"]