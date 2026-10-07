# syntax=docker/dockerfile:1.6@sha256:ac85f380a63b13dfcefa89046420e1781752bab202122f8f50032edf31be0021

# $BUILDPLATFORM: emulated, `vinext build` deadlocks until the runner's 6-hour cap, so the binary
# is cross-compiled instead. Keep the tag in step with bun-version in the workflows and db-seed.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS base
WORKDIR /app

FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Every workspace manifest, or `bun install` fails; bunfig.toml pins the linker whose layout the
# builder copies.
COPY package.json bun.lock bunfig.toml ./
# A frozen install refuses to run without the patchedDependencies files.
COPY patches ./patches
COPY apps/controller/package.json ./apps/controller/
COPY apps/agent/package.json ./apps/agent/
COPY apps/site/package.json ./apps/site/
COPY packages/shared/package.json ./packages/shared/
# Nothing needs a native addon build: the PostgreSQL driver is Bun.SQL.
RUN bun install --frozen-lockfile --ignore-scripts

FROM base AS builder
ARG TARGETARCH
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Never connected to; only satisfies dialect.ts's import-time URL check.
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5/unused
# The git tag without its v; unset, vite.config.ts uses package.json's version.
ARG APP_VERSION
# Both trees: the isolated linker puts the store at the root and symlinks into it per member.
# packages/shared has no dependencies, so no node_modules.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/controller/node_modules ./apps/controller/node_modules
COPY . .
# Cross-compiled for the target; the musl variants match the Alpine runtime.
RUN case "$TARGETARCH" in \
      amd64) export BUN_COMPILE_TARGET=bun-linux-x64-musl ;; \
      arm64) export BUN_COMPILE_TARGET=bun-linux-arm64-musl ;; \
      *) echo "docker/web/Dockerfile: unsupported TARGETARCH '$TARGETARCH'" >&2; exit 1 ;; \
    esac && \
    bun run build && bun run build:binary

# ── Runtime ──────────────────────────────────────────────────────────────────
# The binary carries its own musl-linked Bun, which still loads libgcc and libstdc++. node_modules
# is installed on Debian, so a native addon in it must ship a musl build too: today only sharp
# (next's optional dependency) does, and nothing imports it.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS runner
ARG PUID=10001
ARG PGID=10001

ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

# Without a trust store every TLS call (ACME, OIDC, ClickHouse) fails at runtime, not build time.
RUN apk add --no-cache ca-certificates libgcc libstdc++

# `shadow` is only for useradd/userdel, removed in the same layer.
RUN apk add --no-cache --virtual .user-setup shadow && \
    (getent group ${PGID} && groupdel $(getent group ${PGID} | cut -d: -f1) || true) && \
    (getent passwd ${PUID} && userdel $(getent passwd ${PUID} | cut -d: -f1) || true) && \
    groupadd -g ${PGID} cpm && \
    useradd -r -u ${PUID} -g cpm cpm && \
    apk del .user-setup

# Verbatim, package.json included ("type": "module"). The bundle stays on disk: vinext import()s a
# real path, which Bun's embedded-asset filesystem does not support.
COPY --from=builder --chown=cpm:cpm /app/apps/controller/dist/standalone ./

COPY --from=builder --chown=cpm:cpm /app/apps/controller/drizzle ./drizzle

RUN mkdir -p /app/data && chown -R cpm:cpm /app/data

# The ACME CA root Caddy trusts (#192), so only web may write it. A new named volume takes this
# directory's owner and mode on first mount.
RUN mkdir -p /acme-ca && chown cpm:cpm /acme-ca && chmod 0755 /acme-ca

COPY --chown=cpm:cpm docker/web/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Static facts only: docker-build-trusted.yml's metadata-action supplies version and revision.
LABEL org.opencontainers.image.title="Caddy Proxy Manager Web Dashboard" \
      org.opencontainers.image.description="Web UI and API for managing Caddy reverse proxies, certificates and routes." \
      org.opencontainers.image.vendor="CaddyProxyManager" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.url="https://github.com/CaddyProxyManager/caddy-proxy-manager" \
      org.opencontainers.image.source="https://github.com/CaddyProxyManager/caddy-proxy-manager" \
      org.opencontainers.image.documentation="https://caddyproxy.com/" \
      org.opencontainers.image.base.name="docker.io/library/alpine:3.24"

EXPOSE 3000
USER cpm
ENTRYPOINT ["/entrypoint.sh"]
