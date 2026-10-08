# syntax=docker/dockerfile:1.6@sha256:ac85f380a63b13dfcefa89046420e1781752bab202122f8f50032edf31be0021

# On BUILDPLATFORM, cross-compiling, to avoid QEMU for arm64. The -builder image ships xcaddy and a
# pinned Go toolchain, so cold builds skip compiling xcaddy. This tag pins only those; go.mod pins
# Caddy and the plugins, and the two may drift.
FROM --platform=$BUILDPLATFORM caddy:2.11.7-builder@sha256:1ab914bd604996ab195f6326665cd2ae5d3df62feba973e776c4c8d5967d57a5 AS builder

ARG TARGETOS
ARG TARGETARCH

# update-compatibility-pins.sh keeps go.mod's cel-go replacement matched to the pinned Caddy.
WORKDIR /build
COPY docker/caddy/go.mod docker/caddy/go.sum docker/caddy/build.sh ./

# Overridden from Settings - Caddy Build. Must match SHIPPED_CADDY_MODULES in
# packages/shared/src/caddy-modules.ts (tests/unit/caddy/caddy-modules.test.ts checks).
ARG CADDY_MODULES="\
github.com/caddy-dns/cloudflare \
github.com/caddy-dns/route53 \
github.com/caddy-dns/digitalocean \
github.com/caddy-dns/duckdns \
github.com/caddy-dns/hetzner/v2 \
github.com/caddy-dns/vultr \
github.com/caddy-dns/porkbun \
github.com/caddy-dns/godaddy \
github.com/caddy-dns/namecheap \
github.com/caddy-dns/netcup \
github.com/caddy-dns/ovh \
github.com/caddy-dns/ionos \
github.com/caddy-dns/linode \
github.com/caddy-dns/njalla \
github.com/caddy-dns/spaceship \
github.com/caddy-dns/desec \
github.com/caddy-dns/dynu \
github.com/caddy-dns/acmedns \
github.com/caddy-dns/infomaniak \
github.com/caddy-dns/inwx \
github.com/caddy-dns/cloudns \
github.com/caddy-dns/rfc2136 \
github.com/mholt/caddy-l4 \
github.com/tailscale/caddy-tailscale \
github.com/fuomag9/caddy-blocker-plugin \
github.com/corazawaf/coraza-caddy/v2"

# build.sh resolves versions from go.mod, so the arg stays a plain list the app can diff; paths are
# allowlisted upstream (validateCustomModule). The cache mounts spare UI rebuilds a full recompile.
# caddy-modules.txt is the unresolved list, as the agent records it, or the UI re-asks for rebuilds.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    set -eu; \
    CADDY_MODULES="${CADDY_MODULES}" TARGETOS="$TARGETOS" TARGETARCH="$TARGETARCH" sh ./build.sh; \
    printf '%s\n' "${CADDY_MODULES}" > /caddy-modules.txt

# Alpine like the builder, so a cgo plugin still works. Not caddy:<version>, whose binary would sit
# under ours as ~50MB of dead weight. The compose healthcheck uses busybox's wget.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

# 10000 avoids clashing with system users.
ARG PUID=10000
ARG PGID=10000

RUN apk add --no-cache ca-certificates

COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# `shadow` is only for useradd/userdel, removed in the same layer. waf-audit.log is pre-created
# group-writable because the agent truncates it via caddy's group and Coraza would make it 0644.
# No /acme-ca: a new volume takes its owner from the first image that has it, and web's must win.
RUN apk add --no-cache --virtual .user-setup shadow && \
    (getent group ${PGID} && groupdel $(getent group ${PGID} | cut -d: -f1) || true) && \
    (getent passwd ${PUID} && userdel $(getent passwd ${PUID} | cut -d: -f1) || true) && \
    groupadd -g ${PGID} caddy && \
    useradd -r -u ${PUID} -g caddy -m -d /home/caddy caddy && \
    mkdir -p /data /config /logs && \
    touch /logs/waf-audit.log && \
    chown -R caddy:caddy /data /config /logs /home/caddy && \
    chmod 0660 /logs/waf-audit.log && \
    apk del .user-setup

# From the builder, not a build arg (ARG is per stage), so it cannot disagree with the binary.
COPY --from=builder /caddy-modules.txt /etc/caddy/caddy-modules.txt
COPY --from=builder /caddy-modules.resolved.txt /etc/caddy/caddy-modules.resolved.txt

COPY --chown=caddy:caddy docker/caddy/Caddyfile /etc/caddy/Caddyfile

# Static facts only: docker-build-trusted.yml adds version, revision and date. The plugin list is
# not a label since the UI overrides it; caddy-modules.txt records the real one.
LABEL org.opencontainers.image.title="Caddy Proxy Manager Caddy Handler" \
      org.opencontainers.image.description="Caddy built with xcaddy, bundling the DNS, layer-4 and WAF plugins Caddy Proxy Manager configures." \
      org.opencontainers.image.vendor="CaddyProxyManager" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.url="https://github.com/CaddyProxyManager/caddy-proxy-manager" \
      org.opencontainers.image.source="https://github.com/CaddyProxyManager/caddy-proxy-manager" \
      org.opencontainers.image.documentation="https://caddyproxy.com/" \
      org.opencontainers.image.base.name="docker.io/library/alpine:3.24"

EXPOSE 80 443 2019

ENV XDG_CONFIG_HOME=/config
ENV XDG_DATA_HOME=/data

USER caddy

CMD ["caddy", "run", "--resume", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
