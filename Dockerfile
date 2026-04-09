# Stage 1: Build
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# Install Playwright browsers in SAME env
RUN npx playwright install --with-deps chromium-headless-shell

COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY scripts/start.sh ./start.sh

RUN chmod +x start.sh
RUN npm run build
RUN npm prune --omit=dev


# Stage 2: Runtime
FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=7860
ENV PLAYWRIGHT_BROWSERS_PATH=/app/data/ms-playwright

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    zstd \
    xz-utils \
    tar \
    pipewire \
    pipewire-pulse \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://ollama.com/install.sh | sh

COPY --from=builder /app /app

RUN mkdir -p /app/data \
    && chown -R node:node /app

VOLUME ["/app/data"]

USER node

EXPOSE 7860

CMD ["./start.sh"]