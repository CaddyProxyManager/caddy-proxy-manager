# Headscale on Alpine: its own image has no shell, and the rig needs one to mint a pre-auth key at
# startup for Caddy's node and the client's.
FROM headscale/headscale:v0.29.4@sha256:8833f828b414c0907b7e5c71da76473216fe17cce0818a166b536ec552c0903f AS headscale

FROM alpine:3.24
RUN apk add --no-cache curl jq
COPY --from=headscale /ko-app/headscale /usr/local/bin/headscale
COPY headscale-start.sh /usr/local/bin/headscale-start.sh
RUN mkdir -p /var/lib/headscale /var/run/headscale && chmod +x /usr/local/bin/headscale-start.sh
ENTRYPOINT ["/usr/local/bin/headscale-start.sh"]
