# Build stage: install deps and produce the Vite build.
FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Production stage: run the Bun server with only what's needed.
FROM oven/bun:1-slim
RUN groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs -s /bin/sh -m nodejs
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json bun.lock ./
COPY server/ ./server/
COPY src/shared/ ./src/shared/
USER nodejs
EXPOSE 4000
ENV NODE_ENV=production PORT=4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1
CMD ["bun", "run", "server/index.ts"]
