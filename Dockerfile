# Build stage
FROM node:20-slim AS build

WORKDIR /app

# Install dependencies (layer caching)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Runtime stage
FROM node:20-slim

WORKDIR /app

# Copy production node_modules and compiled JS from the build stage.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./

# Create data directory for SQLite.
RUN mkdir -p /data

# Run as non-root for security.
RUN groupadd -r auroic && useradd -r -g auroic auroic
RUN chown -R auroic:auroic /app
USER auroic

CMD ["node", "dist/index.js"]
