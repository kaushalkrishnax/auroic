# Stage 1: Builder
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY scripts/start.sh ./start.sh
RUN chmod +x start.sh

# Build the app and prune dev dependencies
RUN npm run build && npm prune --omit=dev

# Stage 2: Runtime
FROM node:20-slim AS runtime

WORKDIR /app

# Playwright & Environment Config
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production
# Hugging Face requirement
ENV PORT=7860

# Runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    pipewire \
    pipewire-pulse \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright Chromium deps
RUN npx -y playwright install-deps chromium-headless-shell \
    && rm -rf /var/lib/apt/lists/*
RUN npx -y playwright install chromium-headless-shell

# Copy built artifacts from builder stage
COPY --from=builder /app/dist         ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/start.sh     ./start.sh
COPY drizzle ./drizzle

# FIX: Use the existing 'node' user (UID 1000) instead of creating a new one
RUN mkdir -p /app/data \
    && chown -R node:node /app \
    && chown -R node:node /ms-playwright

USER node

# Hugging Face exclusively uses port 7860
EXPOSE 7860

CMD ["node", "--enable-source-maps", "dist/index.js"]
