# Cerebro del WhatsApp de Demo Salon. Sin dependencias en tiempo de ejecución:
# solo Node 22, el JavaScript compilado y los prompts.
FROM node:22.19-alpine AS builder
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22.19-alpine AS runtime
ENV NODE_ENV=production PORT=8080 BRAIN_DATA_DIR=/data
WORKDIR /app
COPY --from=builder --chown=node:node /build/dist ./dist
COPY --chown=node:node prompts ./prompts
COPY --chown=node:node package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "dist/main.js"]
