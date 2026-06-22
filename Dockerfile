# Stage 1: Build the application
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
COPY scripts/start.sh ./start.sh

RUN chmod +x start.sh && npm run build && npm prune --omit=dev

# Stage 2: Create the final image
FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=7860

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    zstd \
    xz-utils \
    tar \
    espeak-ng \
    pipewire \
    pipewire-pulse \
    && rm -rf /var/lib/apt/lists/*
    
COPY --from=builder /app /app

RUN curl -fsSL https://ollama.com/install.sh | sh

RUN mkdir -p /data/app \
    && chown -R node:node /app \
    && chown -R node:node /data

VOLUME ["/data/app"]

USER node

EXPOSE 7860

CMD ["./start.sh"]