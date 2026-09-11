# Stage 1: Build Frontend & Backend
FROM node:22-alpine AS builder
WORKDIR /app

# Copy dependency manifests
COPY package.json package-lock.json* bun.lock* ./

# Install dependencies for building
RUN npm install

# Copy source tree and compile
COPY . .
RUN npm run build

# Stage 2: Production Runtime
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

# Install production dependencies only
COPY package.json package-lock.json* bun.lock* ./
RUN npm install --omit=dev

# Copy compiled assets from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server/db/schema.sql ./server/db/schema.sql

EXPOSE 3000

CMD ["node", "dist/server.cjs"]
