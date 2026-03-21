# Stage 1: Builder
# Use full node image for building — needs python3, make, g++ for native modules
FROM node:20-slim AS builder

WORKDIR /app

# Build tools for native modules (node-llama-cpp, onnxruntime-node)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Force node-llama-cpp to compile for CPU with all optimizations
ENV CMAKE_BUILD_PARALLEL_LEVEL=2
ENV LLAMA_NATIVE=1

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle

COPY scripts/start.sh ./start.sh
RUN chmod +x start.sh
CMD ["./start.sh"]

RUN npm run build && npm prune --omit=dev

# Stage 2: Runtime
# Separate stage keeps final image lean — no build tools, no dev deps
FROM node:20-slim AS runtime

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production

# Runtime dependencies only:
# - Chromium deps for Playwright
# - pipewire + pipewire-pulse for TTS pw-play (replaces pulseaudio)
# - libgomp1 for onnxruntime-node OpenMP support
# - ca-certificates for HTTPS
RUN apt-get update && apt-get install -y --no-install-recommends \
    pipewire \
    pipewire-pulse \
    libgomp1 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright Chromium deps BEFORE copying app
# Doing it here means this layer is cached even if source changes
RUN npx -y playwright install-deps chromium-headless-shell \
    && rm -rf /var/lib/apt/lists/*

# Install Chromium browser binary
RUN npx -y playwright install chromium-headless-shell

# Copy built artifacts and pruned node_modules from builder
COPY --from=builder /app/dist        ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY drizzle ./drizzle

# Create runtime directories and non-root user
RUN mkdir -p /app/data /app/models \
    && groupadd -r auroic \
    && useradd -r -g auroic -s /sbin/nologin auroic \
    && chown -R auroic:auroic /app \
    && chown -R auroic:auroic /ms-playwright

USER auroic

EXPOSE 3789

# Use tini-style signal handling via node --enable-source-maps
CMD ["node", "--enable-source-maps", "dist/index.js"]