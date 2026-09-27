# The simulated client: deliberately no project code, only HTTP/TLS/TCP/UDP like an outside user.
FROM alpine:3.24

RUN apk add --no-cache \
      bash \
      ca-certificates \
      coreutils \
      curl \
      openssl \
      jq \
      socat \
      python3 \
      bind-tools \
      netcat-openbsd \
      grep \
      sed \
      diffutils

WORKDIR /suite
ENV BASH_ENV=""
CMD ["sleep", "infinity"]
