# -------- Stage 1: Build --------
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY scripts/start.sh ./start.sh

RUN chmod +x start.sh

# Build project
RUN npm run build

# Remove dev deps
RUN npm prune --omit=dev


# -------- Stage 2: Runtime --------
FROM node:20-slim

WORKDIR /app

# ENV config
ENV NODE_ENV=production
ENV PORT=7860
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    pipewire \
    pipewire-pulse \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright deps + browser
RUN npx -y playwright install-deps chromium-headless-shell \
    && npx -y playwright install chromium-headless-shell \
    && rm -rf /var/lib/apt/lists/*

# Install Ollama
RUN curl -fsSL https://ollama.com/install.sh | sh

# Copy app
COPY --from=builder /app/dist         ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/start.sh     ./start.sh
COPY drizzle ./drizzle

# Permissions
RUN mkdir -p /app/data \
    && chown -R node:node /app \
    && chown -R node:node /ms-playwright

USER node

EXPOSE 7860

CMD ["./start.sh"]