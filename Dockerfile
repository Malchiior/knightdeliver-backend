# KnightDeliver Backend Dockerfile
# Using Debian-slim instead of Alpine for OpenSSL compatibility with Prisma
FROM node:20-slim AS builder

WORKDIR /app

# Install OpenSSL (required by Prisma)
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Copy package files and prisma schema (needed for postinstall)
COPY package*.json ./
COPY prisma ./prisma

# Install dependencies (prisma generate runs in postinstall)
RUN npm ci

# Copy rest of source code
COPY . .

# Build TypeScript
RUN npm run build

# Generate Prisma client (ensure it's built for the target platform)
RUN npx prisma generate

# Production stage
FROM node:20-slim

WORKDIR /app

# Install OpenSSL (required by Prisma at runtime)
RUN apt-get update -y && apt-get install -y openssl wget && rm -rf /var/lib/apt/lists/*

# Copy from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma

# Create non-root user
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs nodejs

USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

# Start server
CMD ["node", "dist/index.js"]
