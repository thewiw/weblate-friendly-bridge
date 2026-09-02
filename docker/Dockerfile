# Runtime image for the already-built app (run `npm run build` first).
# Build from the repo root as context (see docker/docker-compose.yaml):
#   docker build -f docker/Dockerfile -t weblate-friendly-bridge:latest .
# The server bundle is fully self-contained (esbuild), and the Express
# server serves dist/client from the working directory, so only the
# dist/ output is needed — no node_modules.
FROM node:22-alpine

WORKDIR /app

COPY dist/server/index.cjs dist/server/index.cjs
COPY dist/client dist/client

# app.listen(port) binds all interfaces, so the port is reachable
# from outside the container without extra configuration.
ENV PORT=4000

EXPOSE 4000

USER node

CMD ["node", "dist/server/index.cjs"]