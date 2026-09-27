#!/usr/bin/env bash
# The rig itself. Runs first because a failure here explains every later failure.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "infrastructure"

# ── DNS ─────────────────────────────────────────────────────────────────────

resolved=$(dig +short "app.$TEST_DOMAIN" @172.28.0.5 | tail -n1)
t_eq "any *.$TEST_DOMAIN name resolves to Caddy" "$CADDY_IP" "$resolved"

deep=$(dig +short "a.b.c.$TEST_DOMAIN" | tail -n1)
t_eq "arbitrarily deep subdomains resolve to Caddy" "$CADDY_IP" "$deep"

t_ok "container names still resolve through the same resolver" getent hosts web
t_ok "origin container names resolve" getent hosts origin-a

# ── Network restriction ─────────────────────────────────────────────────────
#
# `internal: true`, which is also what proves the ACME tests reach Pebble, not a public CA.

t_fails "the client cannot route to a public address" \
  curl -sS --max-time 5 -o /dev/null http://1.1.1.1/

# bind-tools 9.20 prints ";; no servers could be reached" on stdout even with `+short`.
external=$(dig +short +time=2 +tries=1 example.com @172.28.0.5 2>/dev/null | grep -v '^;' | tail -n1)
t_eq "public DNS names do not resolve" "" "$external"

# ── Simulated destinations ──────────────────────────────────────────────────

fetch "http://origin-a:8080/__health"
t_eq "L7 origin A answers directly" "200" "$FETCH_CODE"

fetch "http://origin-b:8080/__health"
t_eq "L7 origin B answers directly" "200" "$FETCH_CODE"

fetch "https://origin-tls:8443/__health" -k
t_eq "HTTPS origin answers directly" "200" "$FETCH_CODE"

# Deliberately issued for a name it is not reachable under; later tests rely on that.
tls_name=$(printf '' | openssl s_client -connect origin-tls:8443 2>/dev/null \
  | openssl x509 -noout -subject 2>/dev/null)
t_contains "HTTPS origin serves a hostname-mismatched certificate" \
  "not-the-origin-hostname.invalid" "$tls_name"

tcp_reply=$(printf 'ping\nQUIT\n' | timeout 10 socat - TCP:origin-tcp:9000 2>/dev/null)
t_contains "L4 TCP destination echoes directly" "ECHO origin-tcp ping" "$tcp_reply"

udp_reply=$(printf 'ping' | timeout 10 socat - UDP-DATAGRAM:origin-udp:9001 2>/dev/null)
t_contains "L4 UDP destination echoes directly" "ECHO origin-udp ping" "$udp_reply"

# ── System under test ───────────────────────────────────────────────────────

fetch "$CPM_API/api/health"
t_eq "the CPM API reports healthy" "200" "$FETCH_CODE"
t_eq "the health payload is well formed" "ok" "$(fetch_json '.status')"

# Binding 0.0.0.0 makes Caddy skip Host validation, so the Origin pin is all that stops a page in
# the operator's browser reconfiguring the proxy.
admin_code=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
  -H 'Origin: http://attacker.example' "http://caddy:2019/config/" 2>/dev/null)
t_eq "the Caddy admin API refuses a foreign Origin" "403" "$admin_code"

# Allowed by design: the admin port is not published, so the network bounds reachability.
admin_ok=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "http://caddy:2019/config/" 2>/dev/null)
t_eq "the Caddy admin API answers a same-origin request" "200" "$admin_ok"

finish
