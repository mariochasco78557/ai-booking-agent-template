# ─── Demo Salon AI booking middleware — production image ─────────────────────────
#
# Multi-stage. The runtime stage carries only `dist/` and production
# dependencies: no TypeScript sources, no dev dependencies, no tests, and — by
# construction — NO credentials. Every secret arrives at RUN time through the
# environment (see compose.yaml's `env_file`), never at BUILD time, so nothing
# sensitive can be baked into a layer or recovered from the image history.
#
# Node 22 LTS is deliberate: it is a supported LTS line (maintenance through
# April 2027, i.e. not EOL) AND it is the exact major the test suite was run
# against locally, so the deployed runtime is the tested runtime.

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22.19-alpine AS builder

WORKDIR /build

# Dependency layer first, so a source-only change does not re-install.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: production dependencies only ────────────────────────────────────
FROM node:22.19-alpine AS deps

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:22.19-alpine AS runtime

# `node` (uid/gid 1000) already exists in the official image. The app runs as
# that unprivileged user, never root — reinforced by `user:` in compose.yaml so
# the constraint is visible in both places.
ENV NODE_ENV=production

# The deployed commit SHA, set by compose.yaml's build `args:` (defaulting to
# "dev" when unset — a plain `docker build` outside the deploy scripts). Baked
# in as an env var so `/health` and every log line can say exactly which code
# is serving a call — see src/utils/appVersion.ts.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

WORKDIR /app

COPY --from=deps  --chown=node:node /build/node_modules ./node_modules
COPY --from=builder --chown=node:node /build/dist       ./dist
COPY --chown=node:node package.json ./
# Datos de negocio del cliente (D-007): `clientes/<CLIENT_ID>/cliente.yaml`, leído
# en el arranque por src/core/config/clientConfig.ts. Sin secretos. Sin este
# directorio el proceso se niega a arrancar (o usa CLIENT_CONFIG_PATH).
COPY --chown=node:node clientes ./clientes

# The single writable path the running app has (the root filesystem is mounted
# read-only in compose.yaml). It exists HERE, in the image, rather than only as
# a compose volume, because Docker copies an image directory's ownership into
# an empty named volume the first time it is mounted — created here as
# node:node, the volume comes up writable by the unprivileged process. Created
# root-owned by the volume driver instead, it would not.
RUN mkdir -p /var/lib/booking-agent && chown node:node /var/lib/booking-agent && chmod 700 /var/lib/booking-agent

USER node

# The port is EXPOSEd on the container's own network interface only. It is
# never published to the host in compose.yaml — Caddy reaches it over the
# internal Docker network by service name, so no Node port is reachable from
# the Internet or even from the VPS host.
EXPOSE 3000

# Uses Node's own global fetch (Node 18+) rather than adding curl/wget to the
# image: fewer packages, smaller attack surface, and no shell needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
