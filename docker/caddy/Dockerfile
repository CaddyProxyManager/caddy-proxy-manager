# syntax=docker/dockerfile:1.6@sha256:ac85f380a63b13dfcefa89046420e1781752bab202122f8f50032edf31be0021

# Builder on the host arch (BUILDPLATFORM) with xcaddy cross-compiling via GOOS/GOARCH - avoids QEMU
# when building linux/arm64 on an x86 runner. caddy:<version>-builder rather than golang:: it ships
# xcaddy and the Go toolchain that release was built with, so cold builds skip the xcaddy compile
# and the version stops floating. Pinned to an exact tag for that second reason; it selects the Go
# toolchain and xcaddy only - what gets compiled is pinned in docker/caddy/go.mod. The two are
# allowed to drift: this tag is the xcaddy pin, go.mod is the Caddy and plugin pin.
FROM --platform=$BUILDPLATFORM caddy:2.11.4-builder@sha256:369218c81ca6d6af249981221b3a5c764d886dd5b058f51d144066de13f2418d AS builder

ARG TARGETOS
ARG TARGETARCH

# What gets compiled - Caddy's own version and every plugin's - is pinned in docker/caddy/go.mod,
# which build.sh reads. Dependabot updates it weekly, and update-compatibility-pins.sh keeps the
# cel-go replacement consistent with the pinned Caddy release - which is what lets that be a release
# tag rather than the master commit this used to track.
WORKDIR /build
COPY docker/caddy/go.mod docker/caddy/go.sum docker/caddy/build.sh ./

# Plugins compiled into the binary: whitespace-separated Go module paths with an optional @version.
# Settings → Caddy Build overrides this through a generated compose override. Keep in sync with
# SHIPPED_CADDY_MODULES in packages/shared/src/caddy-modules.ts - the controller's
# tests/unit/caddy-modules.test.ts asserts the two match. Declared in this stage only; the runtime stage reads the resolved list from a file the
# build writes, since ARG scope is per stage.
ARG CADDY_MODULES="\
github.com/caddy-dns/cloudflare \
github.com/caddy-dns/route53 \
github.com/caddy-dns/digitalocean \
github.com/caddy-dns/duckdns \
github.com/caddy-dns/hetzner \
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
github.com/caddy-dns/cloudns \
github.com/caddy-dns/rfc2136 \
github.com/mholt/caddy-l4 \
github.com/tailscale/caddy-tailscale \
github.com/fuomag9/caddy-blocker-plugin \
github.com/corazawaf/coraza-caddy/v2"

# build.sh expands the list into `--with path@version` flags, resolving each version from go.mod, so
# the build arg stays a plain list the app can generate and diff without knowing xcaddy's syntax or
# carrying versions; word splitting separates the entries, and paths are allowlisted upstream
# (validateCustomModule). The cache mounts matter for the rebuild-from-the-UI flow - without them
# every module change recompiles from scratch. BuildKit keeps them on the same daemon the agent
# talks to.
#
# What lands in /caddy-modules.txt is the requested list, not build.sh's resolved one: the agent
# records that same unresolved list as "applied", and the two must match or the UI reports a rebuild
# that already happened. The exact versions go to /caddy-modules.resolved.txt instead.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    set -eu; \
    CADDY_MODULES="${CADDY_MODULES}" TARGETOS="$TARGETOS" TARGETARCH="$TARGETARCH" sh ./build.sh; \
    printf '%s\n' "${CADDY_MODULES}" > /caddy-modules.txt

# Alpine, matching the builder's base: the xcaddy binary is statically linked, and keeping both
# stages on one distro means it stays that way even if a plugin pulls in cgo. Not caddy:<version>
# itself - this stage overwrites /usr/bin/caddy, so the official binary would sit in a lower layer
# as ~50MB of dead weight. wget is busybox's, which the compose healthcheck uses unchanged.
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

# Accept build args for user/group IDs to support rootless operation
# Using 10000 as default to avoid conflicts with system users
ARG PUID=10000
ARG PGID=10000

# Install runtime dependencies
RUN apk add --no-cache ca-certificates

# Copy caddy binary from builder
COPY --from=builder /usr/bin/caddy /usr/bin/caddy

# Create the caddy user and directories with configurable IDs for rootless operation, removing any
# existing user/group with the same UID/GID. `shadow` supplies useradd/userdel, which busybox does
# not; installing it for one layer and removing it keeps the ID-remapping logic - which decides
# ownership of /data, /config and /logs - unchanged, without shipping the tooling.
#
# waf-audit.log is created here, group-writable, rather than left to Coraza: the agent truncates it
# once ingested and reaches it only through caddy's group, but Coraza creates it 0644. A new named
# volume copies this file in with its mode, and Coraza opens an existing file without changing it.
#
# No /acme-ca: web's image owns that directory, and a new volume takes its owner from the first image
# that has one. A copy here would hand the volume to root if Caddy happened to mount it first.
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

# Record what this image was built with, so an image is inspectable on its own:
# `docker run --rm <image> cat /etc/caddy/caddy-modules.txt`. Copied from the builder rather than
# re-read from a build arg - ARG is per stage, and this is written from the very variable the build
# looped over, so it cannot disagree with the binary beside it.
COPY --from=builder /caddy-modules.txt /etc/caddy/caddy-modules.txt
COPY --from=builder /caddy-modules.resolved.txt /etc/caddy/caddy-modules.resolved.txt

COPY --chown=caddy:caddy docker/caddy/Caddyfile /etc/caddy/Caddyfile

# Image identity, so a pulled image describes itself without the compose file beside it. Static
# facts only: the version, revision and build timestamp are supplied by docker/metadata-action in
# .github/workflows/docker-build-trusted.yml, whose --label flags override anything set here. The
# compiled-in plugin list is deliberately not a label - it is a build arg the UI overrides, and
# /etc/caddy/caddy-modules.txt above records whatever this image was actually built with.
LABEL org.opencontainers.image.title="Caddy Proxy Manager Caddy Handler" \
      org.opencontainers.image.description="Caddy built with xcaddy, bundling the DNS, layer-4 and WAF plugins Caddy Proxy Manager configures." \
      org.opencontainers.image.vendor="SilentSpud" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.url="https://github.com/SilentSpud/caddy-proxy-manager" \
      org.opencontainers.image.source="https://github.com/SilentSpud/caddy-proxy-manager" \
      org.opencontainers.image.documentation="https://github.com/SilentSpud/caddy-proxy-manager#readme" \
      org.opencontainers.image.base.name="docker.io/library/alpine:3.24"

EXPOSE 80 443 2019

# Set environment variables to use /data and /config like official Caddy image
ENV XDG_CONFIG_HOME=/config
ENV XDG_DATA_HOME=/data

# Run as non-root user (fully rootless)
USER caddy

CMD ["caddy", "run", "--resume", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
