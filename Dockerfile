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

# Install Playwright Chromium deps (Must be run as root)
RUN npx -y playwright install-deps chromium-headless-shell \
    && rm -rf /var/lib/apt/lists/*

# Install the browser binaries
RUN npx -y playwright install chromium-headless-shell

# Copy built artifacts and pruned node_modules from builder
COPY --from=builder /app/dist         ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/start.sh     ./start.sh
COPY drizzle ./drizzle

# FIX: Create a user explicitly with UID 1000 to match Hugging Face's requirements
RUN mkdir -p /app/data \
    && useradd -m -u 1000 auroic \
    && chown -R auroic:auroic /app \
    && chown -R auroic:auroic /ms-playwright

USER auroic

# FIX: Hugging Face exclusively uses port 7860
EXPOSE 7860
ENV PORT=7860

# Ensure your index.js is configured to listen on process.env.PORT
CMD ["node", "--enable-source-maps", "dist/index.js"]