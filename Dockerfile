# Build stage
FROM node:20-slim AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Runtime stage
FROM node:20-slim

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./

# Create app data directory
RUN mkdir -p /app/data

# Create non-root user
RUN groupadd -r auroic && useradd -r -g auroic auroic

# Fix permissions
RUN chown -R auroic:auroic /app

USER auroic

CMD ["node", "dist/index.js"]