# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Copy static frontend assets into dist/web/public
RUN mkdir -p dist/web/public && cp -r src/web/public/* dist/web/public/

# Stage 2: Runtime
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/data/mception.db

RUN addgroup -S mception && adduser -S mception -G mception && \
    mkdir -p /data && chown -R mception:mception /data

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

USER mception

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "dist/index.js"]
