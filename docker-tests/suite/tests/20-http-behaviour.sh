#!/usr/bin/env bash
# Per-host HTTP behaviour: scheme forcing, HSTS, host headers, WebSockets, and HTTPS upstreams with
# a mismatched certificate.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "HTTP behaviour"

# ── HTTP is served alongside HTTPS unless forced ────────────────────────────

plain=$(domain_for "plain-http")
create_host_or_fail "a host without sslForced can be created" "$(jq -nc --arg d "$plain" \
  '{name:"docker-test plain http", domains:[$d], upstreams:["origin-a:8080"], sslForced:false}')" \
  && pass "a host without sslForced can be created"

wait_for_http "http://$plain/" 60
fetch "http://$plain/"
t_eq "plain HTTP is served when sslForced is off" "200" "$FETCH_CODE"
t_eq "the HTTP request reaches the upstream" "origin-a" "$(fetch_json '.origin')"
t_eq "X-Forwarded-Proto reports http for a plain request" "http" \
  "$(fetch_json '.headers["x-forwarded-proto"]')"

# ── sslForced ───────────────────────────────────────────────────────────────

forced=$(domain_for "ssl-forced")
create_host_or_fail "a host with sslForced can be created" "$(jq -nc --arg d "$forced" \
  '{name:"docker-test ssl forced", domains:[$d], upstreams:["origin-a:8080"], sslForced:true}')" \
  && pass "a host with sslForced can be created"

wait_for_https "$forced" 120

fetch "http://$forced/some/path?keep=me"
t_eq "an HTTP request is redirected" "308" "$FETCH_CODE"
location=$(header_value location)
t_eq "the redirect points at HTTPS and keeps the URI" "https://$forced/some/path?keep=me" "$location"

fetch "http://$forced/some/path?keep=me" -L
t_eq "following the redirect lands on the upstream" "200" "$FETCH_CODE"
t_eq "the followed request kept its path" "/some/path" "$(fetch_json '.path')"

# ── HSTS ────────────────────────────────────────────────────────────────────

hsts=$(domain_for "hsts")
create_host_or_fail "a host with HSTS can be created" "$(jq -nc --arg d "$hsts" '{
  name: "docker-test hsts", domains: [$d], upstreams: ["origin-a:8080"],
  sslForced: true, hstsEnabled: true, hstsSubdomains: true
}')" && pass "a host with HSTS can be created"

wait_for_https "$hsts" 120
fetch "https://$hsts/"
sts=$(header_value strict-transport-security)
t_contains "the HSTS header is set" "max-age=63072000" "$sts"
t_contains "subdomains are included when asked for" "includeSubDomains" "$sts"

# hstsSubdomains defaults off: HSTS alone must not claim names the host does not serve.
plain_hsts=$(domain_for "hsts-no-subdomains")
create_host_or_fail "a host with HSTS but not subdomains can be created" "$(jq -nc --arg d "$plain_hsts" '{
  name: "docker-test hsts no subdomains", domains: [$d], upstreams: ["origin-a:8080"],
  sslForced: true, hstsEnabled: true, hstsSubdomains: false
}')" && pass "a host with HSTS but not subdomains can be created"

wait_for_https "$plain_hsts" 120
fetch "https://$plain_hsts/"
sts=$(header_value strict-transport-security)
t_contains "HSTS is still set" "max-age=63072000" "$sts"
t_not_contains "subdomains are not claimed unless asked for" "includeSubDomains" "$sts"

# A stale max-age would keep browsers pinned to HTTPS long after the operator changed their mind.
no_hsts=$(domain_for "hsts-off")
create_host_or_fail "a host with HSTS switched off can be created" "$(jq -nc --arg d "$no_hsts" '{
  name: "docker-test hsts off", domains: [$d], upstreams: ["origin-a:8080"],
  sslForced: true, hstsEnabled: false
}')" && pass "a host with HSTS switched off can be created"

wait_for_https "$no_hsts" 120
fetch "https://$no_hsts/"
t_eq "no HSTS header is sent when the host disables it" "" "$(header_value strict-transport-security)"

# ── Host header handling ────────────────────────────────────────────────────
#
# preserveHostHeader pins Host explicitly, which matters once other handlers rewrite it.

preserve=$(domain_for "preserve-host")
create_host_or_fail "a host with preserveHostHeader can be created" "$(jq -nc --arg d "$preserve" '{
  name: "docker-test preserve host", domains: [$d], upstreams: ["origin-a:8080"],
  preserveHostHeader: true
}')" && pass "a host with preserveHostHeader can be created"

wait_for_https "$preserve" 120
fetch "https://$preserve/"
t_eq "preserveHostHeader forwards the requested host" "$preserve" "$(fetch_json '.host')"

# ── WebSockets ──────────────────────────────────────────────────────────────

ws=$(domain_for "websocket")
create_host_or_fail "a websocket-enabled host can be created" "$(jq -nc --arg d "$ws" '{
  name: "docker-test websocket", domains: [$d], upstreams: ["origin-a:8080"],
  allowWebsocket: true
}')" && pass "a websocket-enabled host can be created"

wait_for_https "$ws" 120

# A 101 proves Caddy passed the Upgrade through rather than answering or stripping it.
fetch "https://$ws/ws" \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  --http1.1
t_eq "the upgrade handshake is proxied" "101" "$FETCH_CODE"
t_contains "the upgrade response comes from the origin" "Sec-WebSocket-Accept" "$FETCH_HEADERS"

# A real frame exchange proves the connection stays open and bidirectional.
ws_reply=$(python3 /suite/helpers/ws_client.py "$ws" /ws "$CA_BUNDLE" hello-over-ws 2>&1)
t_contains "a websocket frame round-trips through the proxy" "echo:hello-over-ws" "$ws_reply"

# ── HTTPS upstreams ─────────────────────────────────────────────────────────
#
# origin-tls's certificate names a host it is not reached under: refused unless the host opts out
# of upstream hostname verification.

strict=$(domain_for "https-upstream-strict")
create_host_or_fail "a host with an HTTPS upstream can be created" "$(jq -nc --arg d "$strict" '{
  name: "docker-test https upstream", domains: [$d], upstreams: ["https://origin-tls:8443"]
}')" && pass "a host with an HTTPS upstream can be created"

wait_for_https "$strict" 120
fetch "https://$strict/"
t_eq "a mismatched upstream certificate is rejected" "502" "$FETCH_CODE"

lax=$(domain_for "https-upstream-lax")
create_host_or_fail "a host that skips upstream hostname validation can be created" "$(jq -nc --arg d "$lax" '{
  name: "docker-test https upstream lax", domains: [$d], upstreams: ["https://origin-tls:8443"],
  skipHttpsHostnameValidation: true
}')" && pass "a host that skips upstream hostname validation can be created"

wait_for_https "$lax" 120
if wait_for "the lax host to reach its HTTPS upstream" 30 \
     bash -c "curl -sS --max-time 5 --cacert '$CA_BUNDLE' 'https://$lax/' | grep -q origin-tls"; then
  pass "skipHttpsHostnameValidation allows the mismatched upstream"
else
  fetch "https://$lax/"
  fail "skipHttpsHostnameValidation allows the mismatched upstream" \
    "HTTP $FETCH_CODE: $(printf '%.200s' "$FETCH_BODY")"
fi

fetch "https://$lax/"
t_eq "the response comes from the TLS origin" "origin-tls" "$(fetch_json '.origin')"

finish
