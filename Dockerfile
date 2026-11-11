# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:26-alpine

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
# Compose is CLI-only (T-004, DEV-004). Both packages exist for amd64 and arm64 in Alpine.
RUN apk add --no-cache docker-cli docker-cli-compose tini \
 && docker --version \
 && docker compose version

ENV NODE_ENV=production \
    PORT=8080 \
    BIND_ADDRESS=0.0.0.0 \
    CONFIG_PATH=/config/config.json \
    COMPOSE_FOLDER=/compose

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY bin ./bin

RUN mkdir -p /config /compose \
 && chown -R node:node /app /config \
 && chmod 0755 /app/bin/docker-manager \
 && ln -s /app/bin/docker-manager /usr/local/bin/docker-manager

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
