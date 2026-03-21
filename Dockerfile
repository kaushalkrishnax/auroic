# Stage 1: Builder
# node:20-slim is sufficient now — no native module compilation needed
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle

COPY scripts/start.sh ./start.sh
RUN chmod +x start.sh

RUN npm run build && npm prune --omit=dev

# Stage 2: Runtime
FROM node:20-slim AS runtime

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production

# Runtime dependencies:
RUN apt-get update && apt-get install -y --no-install-recommends \
    pipewire \
    pipewire-pulse \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright Chromium deps BEFORE copying app
RUN npx -y playwright install-deps chromium-headless-shell \
    && rm -rf /var/lib/apt/lists/*

RUN npx -y playwright install chromium-headless-shell

# Copy built artifacts and pruned node_modules from builder
COPY --from=builder /app/dist         ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/start.sh     ./start.sh
COPY drizzle ./drizzle

# Create runtime directories and non-root user
RUN mkdir -p /app/data \
    && groupadd -r auroic \
    && useradd -r -g auroic -s /sbin/nologin auroic \
    && chown -R auroic:auroic /app \
    && chown -R auroic:auroic /ms-playwright

USER auroic

EXPOSE 3789

CMD ["node", "--enable-source-maps", "dist/index.js"]