#!/usr/bin/env bash
# HTTP versions: HTTP/3 over QUIC on UDP 443 and the Alt-Svc advertising it, HTTP/2 over ALPN, and
# Settings → HTTP protocols narrowing the cpm server to fewer. HTTP/3 requests go through h3client,
# a curl built with it, since the runner's is not.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "HTTP versions"

domain=$(domain_for "http-versions")

protocols() { api PUT /api/v1/settings/http-protocols "$(jq -nc --argjson a "$1" --argjson b "$2" '{http2:$a, http3:$b}')"; }
trap 'protocols true true >/dev/null 2>&1; cleanup_tracked' EXIT

# h3 URL [curl args] - curl --http3-only from h3client -> H3_RC, H3_OUT (body, then the version)
H3_RC=; H3_OUT=
h3() {
  local url="$1" reply; shift
  reply=$(curl -sS --max-time 60 -H 'Content-Type: application/json' http://h3client:8000/curl \
    --data-binary "$(jq -nc --rawfile ca "$CA_BUNDLE" --arg u "$url" \
      '{ca: $ca, args: (["-sS", "--max-time", "15", "--http3-only", "-w", "\n%{http_version}"] + $ARGS.positional + [$u])}' \
      --args "$@")" 2>/dev/null)
  H3_RC=$(printf '%s' "$reply" | jq -r '.rc // 99')
  H3_OUT=$(printf '%s' "$reply" | jq -r '.stdout // ""')
}

version() { curl -sS --max-time 15 --cacert "$CA_BUNDLE" -o /dev/null -w '%{http_version}' "$@" 2>/dev/null; }

caddy_protocols() {
  curl -sS --max-time 10 http://caddy:2019/config/apps/http/servers/cpm 2>/dev/null | jq -c '.protocols // "default"'
}

api_expect "every protocol can be enabled" 200 PUT /api/v1/settings/http-protocols '{"http2":true,"http3":true}'
create_host_or_fail "a host can be created" "$(jq -nc --arg d "$domain" \
  '{name:"docker-test http versions", domains:[$d], upstreams:["origin-a:8080"]}')" \
  && pass "a host can be created"
wait_for_https "$domain" 120

t_eq "with all three on, Caddy keeps its default protocols" '"default"' "$(caddy_protocols)"
fetch "https://$domain/"
t_contains "HTTPS responses advertise HTTP/3" 'h3=":443"' "$(header_value alt-svc)"
t_eq "HTTP/2 is negotiated over ALPN" "2" "$(version --http2 "https://$domain/")"

h3 "https://$domain/over-quic"
t_eq "an HTTP/3 request over QUIC succeeds" "0" "$H3_RC"
t_eq "and is answered in HTTP/3" "3" "$(printf '%s' "$H3_OUT" | tail -n1)"
t_eq "by the upstream" "origin-a" "$(printf '%s' "$H3_OUT" | head -n1 | jq -r '.origin')"
t_eq "with the path intact" "/over-quic" "$(printf '%s' "$H3_OUT" | head -n1 | jq -r '.path')"

# ── HTTP/3 off ──────────────────────────────────────────────────────────────

api_expect "HTTP/3 can be switched off" 200 PUT /api/v1/settings/http-protocols '{"http2":true,"http3":false}'
t_eq "the server is limited to h1 and h2" '["h1","h2"]' "$(caddy_protocols)"
no_alt_svc() { fetch "https://$domain/" && [ -z "$(header_value alt-svc)" ]; }
if wait_for "Alt-Svc to go" 30 no_alt_svc; then
  pass "HTTP/3 is no longer advertised"
else
  fail "HTTP/3 is no longer advertised" "alt-svc: $(header_value alt-svc)"
fi
h3 "https://$domain/"
t_ne "an HTTP/3 request is no longer answered" "0" "$H3_RC"
t_eq "HTTP/2 still is" "2" "$(version --http2 "https://$domain/")"

# ── HTTP/1.1 only ───────────────────────────────────────────────────────────

api_expect "HTTP/2 can be switched off too" 200 PUT /api/v1/settings/http-protocols '{"http2":false,"http3":false}'
t_eq "the server is limited to h1" '["h1"]' "$(caddy_protocols)"
t_eq "a client asking for HTTP/2 gets HTTP/1.1" "1.1" "$(version --http2 "https://$domain/")"

api PUT /api/v1/settings/http-protocols '{"http2":"yes","http3":false}'
t_eq "a value that is not a boolean is refused" "400" "$API_STATUS"

protocols true true
t_eq "switching both back on restores the default" '"default"' "$(caddy_protocols)"
h3 "https://$domain/"
t_eq "and HTTP/3 with it" "0|3" "$H3_RC|$(printf '%s' "$H3_OUT" | tail -n1)"

finish
