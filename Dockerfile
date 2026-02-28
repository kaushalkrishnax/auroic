FROM node:20-slim

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json* ./
RUN npm ci

RUN npx playwright install-deps chromium-headless-shell

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

RUN mkdir -p /app/data \
  && groupadd -r auroic \
  && useradd -r -g auroic auroic \
  && chown -R auroic:auroic /app \
  && chown -R auroic:auroic /ms-playwright

USER auroic

CMD ["node", "dist/index.js"]