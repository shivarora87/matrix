FROM node:20-alpine AS builder
RUN apk add --no-cache openssl

WORKDIR /app

# Install all deps (dev deps needed for build)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY . .

# Swap to PostgreSQL schema
RUN cp prisma/schema.prod.prisma prisma/schema.prisma

# Generate Prisma client against the PostgreSQL schema
RUN npx prisma generate

# Build (SHOPIFY_APP_URL must be a valid URL for vite)
ENV SHOPIFY_APP_URL=http://localhost
RUN npm run build

# ── Production image ──────────────────────────────────────────────────────────
FROM node:20-alpine AS production
RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production

# Production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Built app + Prisma schema + generated client from builder
COPY --from=builder /app/build ./build
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 3000

CMD ["/app/start.sh"]
