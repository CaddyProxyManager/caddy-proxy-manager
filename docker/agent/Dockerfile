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
      amd64) export BUN_COMPILE_TARGET=bun-linux-x64 ;; \
      arm64) export BUN_COMPILE_TARGET=bun-linux-arm64 ;; \
      *) echo "docker/agent/Dockerfile: unsupported TARGETARCH '$TARGETARCH'" >&2; exit 1 ;; \
    esac && \
    cd apps/agent && bun run build:binary

# ── Runtime ──────────────────────────────────────────────────────────────────
# Debian, not docker:cli: the binary's glibc-linked Bun runtime will not start on Alpine's musl.
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a AS runner

# buildx because the legacy builder cannot build docker/caddy/Dockerfile. Pinned to majors, not
# exact builds, since the repository drops old ones. Bump the majors by hand.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
       | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && chmod a+r /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
       https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends \
      'docker-ce-cli=5:29.*' 'docker-compose-plugin=5.*' 'docker-buildx-plugin=0.*' \
    && apt-get purge -y gnupg && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/apps/agent/dist/cpm-agent /app/cpm-agent
# For the documented `docker exec ... cpm-agent --pair`.
ENV PATH="/app:${PATH}"

# Non-root, though the socket proxy makes it host-root-equivalent anyway. /data/geoip exists up
# front because Caddy mounts it as a subpath, which fails if missing. Colliding IDs are removed
# first so a PUID/PGID override never fails the build.
ARG PUID=10002
ARG PGID=10002
RUN (getent group ${PGID} && groupdel $(getent group ${PGID} | cut -d: -f1) || true) && \
    (getent passwd ${PUID} && userdel $(getent passwd ${PUID} | cut -d: -f1) || true) && \
    groupadd -g ${PGID} agent && \
    useradd -r -u ${PUID} -g agent -m -d /home/agent agent && \
    mkdir -p /data/geoip && \
    chown -R agent:agent /data

# Static facts only: version, revision and timestamp come from docker-build-trusted.yml's labels.
LABEL org.opencontainers.image.title="Caddy Proxy Manager Builder Agent" \
      org.opencontainers.image.description="Host-side agent that rebuilds the Caddy image and recreates its container on behalf of Caddy Proxy Manager." \
      org.opencontainers.image.vendor="SilentSpud" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.url="https://github.com/SilentSpud/caddy-proxy-manager" \
      org.opencontainers.image.source="https://github.com/SilentSpud/caddy-proxy-manager" \
      org.opencontainers.image.documentation="https://github.com/SilentSpud/caddy-proxy-manager#readme" \
      org.opencontainers.image.base.name="docker.io/library/debian:trixie-slim"

ENV DATA_DIR=/data
ENV COMPOSE_DIR=/compose
ENV AGENT_MODE=standalone
# The docker CLI keeps its config under $HOME, and buildx its state.
ENV HOME=/home/agent

USER agent

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD /app/cpm-agent --healthcheck

ENTRYPOINT ["/app/cpm-agent"]
