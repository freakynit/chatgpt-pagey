# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data
WORKDIR /app
RUN addgroup -S pagey && adduser -S pagey -G pagey \
  && mkdir -p /data && chown -R pagey:pagey /data /app
COPY --from=build --chown=pagey:pagey /app/package.json /app/package-lock.json ./
COPY --from=build --chown=pagey:pagey /app/node_modules ./node_modules
COPY --from=build --chown=pagey:pagey /app/dist ./dist
USER pagey
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null || exit 1
CMD ["node", "dist/index.js"]
