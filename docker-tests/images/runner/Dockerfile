# The simulated client: deliberately no project code, only HTTP/TLS/TCP/UDP like an outside user.
# docker-cli is for the agent phase, through a socket proxy that exists only then.
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
      diffutils \
      docker-cli

WORKDIR /suite
ENV BASH_ENV=""
CMD ["sleep", "infinity"]
