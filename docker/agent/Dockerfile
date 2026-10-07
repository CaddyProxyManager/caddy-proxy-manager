# syntax=docker/dockerfile:1.6@sha256:ac85f380a63b13dfcefa89046420e1781752bab202122f8f50032edf31be0021

# A single Bun binary, but the runtime still needs the Docker CLI and compose plugin to recreate Caddy.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS builder
WORKDIR /app

# Every workspace manifest: `bun install` fails on a member it cannot read.
COPY package.json bun.lock bunfig.toml ./
# A frozen install refuses to run without the patchedDependencies files.
COPY patches ./patches
COPY apps/controller/package.json ./apps/controller/
COPY apps/agent/package.json ./apps/agent/
COPY apps/site/package.json ./apps/site/
COPY packages/shared/package.json ./packages/shared/
RUN bun install --frozen-lockfile --ignore-scripts

COPY packages/shared ./packages/shared
# Only what the compile reads, so a test-only change keeps this layer and the binary cached.
COPY apps/agent/tsconfig.json ./apps/agent/
COPY apps/agent/src ./apps/agent/src

# Runs on the host arch, so the binary is cross-compiled for the target.
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) export BUN_COMPILE_TARGET=bun-linux-x64-musl ;; \
      arm64) export BUN_COMPILE_TARGET=bun-linux-arm64-musl ;; \
      *) echo "docker/agent/Dockerfile: unsupported TARGETARCH '$TARGETARCH'" >&2; exit 1 ;; \
    esac && \
    cd apps/agent && bun run build:binary

# ── Runtime ──────────────────────────────────────────────────────────────────
# Alpine, not docker:cli, so the Docker tools are pinned here rather than by that image's tag. The
# binary's Bun is musl-linked and still loads libgcc and libstdc++.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS runner

# buildx because the legacy builder cannot build docker/caddy/Dockerfile. Pinned to majors, not
# exact builds, since the repository drops old ones. Bump the majors by hand.
RUN apk add --no-cache ca-certificates libgcc libstdc++ \
      'docker-cli~29' 'docker-cli-compose~5' 'docker-cli-buildx~0'

WORKDIR /app
COPY --from=builder /app/apps/agent/dist/cpm-agent /app/cpm-agent
# For the documented `docker exec ... cpm-agent --pair`.
ENV PATH="/app:${PATH}"

# Non-root, though the socket proxy makes it host-root-equivalent anyway. /data/geoip exists up
# front because Caddy mounts it as a subpath, which fails if missing. Colliding IDs are removed
# first so a PUID/PGID override never fails the build. `shadow` is only for useradd/userdel.
ARG PUID=10002
ARG PGID=10002
RUN apk add --no-cache --virtual .user-setup shadow && \
    (getent group ${PGID} && groupdel $(getent group ${PGID} | cut -d: -f1) || true) && \
    (getent passwd ${PUID} && userdel $(getent passwd ${PUID} | cut -d: -f1) || true) && \
    groupadd -g ${PGID} agent && \
    useradd -r -u ${PUID} -g agent -m -d /home/agent agent && \
    mkdir -p /data/geoip && \
    chown -R agent:agent /data && \
    apk del .user-setup

# Static facts only: version, revision and timestamp come from docker-build-trusted.yml's labels.
LABEL org.opencontainers.image.title="Caddy Proxy Manager Builder Agent" \
      org.opencontainers.image.description="Host-side agent that rebuilds the Caddy image and recreates its container on behalf of Caddy Proxy Manager." \
      org.opencontainers.image.vendor="CaddyProxyManager" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.url="https://github.com/CaddyProxyManager/caddy-proxy-manager" \
      org.opencontainers.image.source="https://github.com/CaddyProxyManager/caddy-proxy-manager" \
      org.opencontainers.image.documentation="https://caddyproxy.com/" \
      org.opencontainers.image.base.name="docker.io/library/alpine:3.24"

ENV DATA_DIR=/data
ENV COMPOSE_DIR=/compose
ENV AGENT_MODE=standalone
# The docker CLI keeps its config under $HOME, and buildx its state.
ENV HOME=/home/agent

USER agent

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD /app/cpm-agent --healthcheck

ENTRYPOINT ["/app/cpm-agent"]
