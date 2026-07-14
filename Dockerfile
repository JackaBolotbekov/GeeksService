# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
COPY scripts ./scripts
COPY tsconfig.json vite.config.ts ./
COPY index.html ./
COPY public ./public
COPY src ./src
RUN npm run build \
    && npm cache clean --force
USER node
EXPOSE 3000
CMD ["sh", "-c", "node scripts/migrate.mjs && node dist/server/index.js"]
