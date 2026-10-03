#!/usr/bin/env bash
# What a host does to responses that only a real Caddy can prove: compression, the robots
# headers, maintenance mode and upstream timeouts. Plain HTTP throughout, since none of it
# depends on TLS and an ACME order per host would only slow the file down.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "response shaping"

# The runner's own address, which a maintenance bypass range has to name.
RUNNER_IP=172.28.0.40

# host SLUG JSON_EXTRAS -> HOST: a plain-HTTP host on origin-a, once it answers. Not echoed, as a
# $(...) subshell would lose the teardown `track`.
HOST=
host() {
  HOST=$(domain_for "$1")
  create_host_or_fail "the $1 host can be created" "$(jq -nc --arg d "$HOST" --argjson x "$2" \
    '{name: ("docker-test " + $d), domains: [$d], upstreams: ["origin-a:8080"],
      sslForced: false} + $x')" && pass "the $1 host can be created"
  wait_for_http "http://$HOST/__health" 60
}

# ── Compression ─────────────────────────────────────────────────────────────

host compression '{"compression":"on"}'
gz=$HOST

fetch "http://$gz/large" -H 'Accept-Encoding: gzip'
t_eq "a large text response is proxied" "200" "$FETCH_CODE"
t_eq "gzip is used when that is all the client takes" "gzip" "$(header_value content-encoding)"

fetch "http://$gz/large" -H 'Accept-Encoding: gzip, zstd'
t_eq "zstd is preferred when the client takes both" "zstd" "$(header_value content-encoding)"

fetch "http://$gz/large" --compressed
t_eq "the compressed body decodes to what the origin sent" "100000" "${#FETCH_BODY}"

fetch "http://$gz/image.png" -H 'Accept-Encoding: gzip, zstd'
t_eq "an image is proxied" "200" "$FETCH_CODE"
t_eq "an image is not compressed again" "" "$(header_value content-encoding)"

host compression-off '{"compression":"off"}'
plain=$HOST
fetch "http://$plain/large" -H 'Accept-Encoding: gzip, zstd'
t_eq "a host with compression off sends identity" "" "$(header_value content-encoding)"

# ── Discouraging search engines ─────────────────────────────────────────────

host noindex '{"discourageIndexing":true}'
noindex=$HOST

fetch "http://$noindex/page"
t_eq "the page is still proxied" "origin-a" "$(fetch_json '.origin')"
t_eq "every response says noindex" "noindex, nofollow" "$(header_value x-robots-tag)"

fetch "http://$noindex/status/404"
t_eq "an origin error keeps its status" "404" "$FETCH_CODE"
t_eq "and carries the header too" "noindex, nofollow" "$(header_value x-robots-tag)"

fetch "http://$noindex/robots.txt"
t_eq "robots.txt is answered by Caddy" "200" "$FETCH_CODE"
t_contains "robots.txt disallows everything" "Disallow: /" "$FETCH_BODY"
t_eq "robots.txt never reaches the origin" "" "$(header_value x-origin-id)"

fetch "http://$gz/robots.txt"
t_eq "a host without the option proxies robots.txt" "origin-a" "$(header_value x-origin-id)"
t_eq "and sends no X-Robots-Tag" "" "$(header_value x-robots-tag)"

# ── Maintenance mode ────────────────────────────────────────────────────────

host maintenance '{"maintenance":{"enabled":true,"retryAfter":120}}'
down=$HOST

fetch "http://$down/anything"
t_eq "a host in maintenance answers 503" "503" "$FETCH_CODE"
t_eq "with the Retry-After it was given" "120" "$(header_value retry-after)"
t_eq "and a response nothing may cache" "no-store" "$(header_value cache-control)"
t_contains "the built-in page says why" "Down for maintenance" "$FETCH_BODY"
t_eq "the origin is never asked" "" "$(header_value x-origin-id)"

host maintenance-bypass "$(jq -nc --arg ip "$RUNNER_IP/32" \
  '{maintenance: {enabled: true, bypassCidrs: [$ip, "10.9.9.0/24"]}}')"
bypass=$HOST
fetch "http://$bypass/anything"
t_eq "an address in the bypass ranges reaches the origin" "200" "$FETCH_CODE"
t_eq "the bypassed request is proxied as usual" "origin-a" "$(fetch_json '.origin')"

host maintenance-others '{"maintenance":{"enabled":true,"bypassCidrs":["10.9.9.0/24"]}}'
others=$HOST
fetch "http://$others/anything"
t_eq "everyone outside the ranges still gets 503" "503" "$FETCH_CODE"
t_eq "no Retry-After is sent when none was set" "" "$(header_value retry-after)"

host maintenance-error-page '{
  "maintenance": {"enabled": true},
  "errorPages": [{"statuses": [503], "body": "<p>back after lunch</p>",
                  "contentType": "text/html; charset=utf-8"}]
}'
custom=$HOST
fetch "http://$custom/"
t_eq "the host's 503 error page answers for maintenance" "503" "$FETCH_CODE"
t_contains "with its own body" "back after lunch" "$FETCH_BODY"

# ── Upstream timeouts ───────────────────────────────────────────────────────

host upstream-timeout '{"upstreamTimeouts":{"responseHeaderTimeout":"1s"}}'
impatient=$HOST

fetch "http://$impatient/slow?ms=200"
t_eq "an upstream inside the timeout is proxied" "200" "$FETCH_CODE"

fetch "http://$impatient/slow?ms=4000"
t_eq "an upstream slower than response_header_timeout is a 504" "504" "$FETCH_CODE"

host upstream-no-timeout '{}'
patient=$HOST
fetch "http://$patient/slow?ms=2000"
t_eq "without the timeout the same wait is proxied" "200" "$FETCH_CODE"

finish
