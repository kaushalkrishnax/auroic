FROM node:20-slim

WORKDIR /app

# Environment variables for Playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Install system dependencies
# - Playwright Chromium dependencies
# - PulseAudio for TTS voice note recording (optional)
# - Build tools for native modules (node-llama-cpp, onnxruntime-node)
RUN apt-get update && apt-get install -y \
  python3 \
  make \
  g++ \
  pulseaudio \
  && rm -rf /var/lib/apt/lists/*

# Copy package files and install Node dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Install Playwright Chromium (full browser, not headless-shell)
RUN npx playwright install chromium
RUN npx playwright install-deps chromium

# Copy source files
COPY tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle

# Build project and remove dev dependencies
RUN npm run build && npm prune --omit=dev

# Create application directories
RUN mkdir -p /app/data /app/models \
  && groupadd -r auroic \
  && useradd -r -g auroic auroic \
  && chown -R auroic:auroic /app \
  && chown -R auroic:auroic /ms-playwright

USER auroic

# Expose dashboard port
EXPOSE 3789

CMD ["node", "dist/index.js"]