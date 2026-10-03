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

# MaxMind's public test databases, pinned to a commit: GeoLite2 is a licensed download, and these
# map documented addresses (81.2.69.160 is GB, 1.128.0.0/11 is AS1221) to answers a test can assert.
ARG MAXMIND_DB_REV=276926d23b4109ca5452709bfb5931c338afb34c
ADD https://raw.githubusercontent.com/maxmind/MaxMind-DB/${MAXMIND_DB_REV}/test-data/GeoIP2-Country-Test.mmdb \
    https://raw.githubusercontent.com/maxmind/MaxMind-DB/${MAXMIND_DB_REV}/test-data/GeoLite2-ASN-Test.mmdb \
    https://raw.githubusercontent.com/maxmind/MaxMind-DB/${MAXMIND_DB_REV}/test-data/GeoIP2-City-Test.mmdb \
    /opt/maxmind/
RUN chmod 0644 /opt/maxmind/*.mmdb

WORKDIR /suite
ENV BASH_ENV=""
CMD ["sleep", "infinity"]
