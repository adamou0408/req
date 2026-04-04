# ──────────────────────────────────────────────
# Demand-Driven Dev — Application Dockerfile
# ──────────────────────────────────────────────
# Multi-stage build for minimal production image

# ── Stage 1: Build ────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/

# ── Stage 2: Production ──────────────────────
FROM node:20-alpine AS production

# Security: non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

COPY --from=builder --chown=appuser:appgroup /app ./

USER appuser

# Health check for closed-loop monitoring
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${APP_PORT:-8080}/health || exit 1

ENV NODE_ENV=production
ENV APP_PORT=8080

EXPOSE ${APP_PORT}

CMD ["node", "src/index.js"]
