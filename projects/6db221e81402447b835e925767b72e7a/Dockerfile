FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV PARTY_OUTPUT_DIR=/app/dist
ENV XDG_CACHE_HOME=/tmp/venture-gauntlet-cache
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
ENV HOST=0.0.0.0
CMD ["node", "scripts/start.mjs"]
