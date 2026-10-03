#!/usr/bin/env bash
# Settings groups, the metrics listener, groups and sessions, the audit trail,
# manual config apply, and the OpenAPI document.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "settings and administration"

# ── Settings groups round-trip ──────────────────────────────────────────────

for group in general acme dns dns-provider upstream-dns geoblock waf error-pages trusted-proxies metrics logging authentik cloudflare; do
  api GET "/api/v1/settings/$group"
  if [ "$API_STATUS" = "200" ]; then
    pass "settings group '$group' can be read"
  else
    fail "settings group '$group' can be read" "HTTP $API_STATUS"
  fi
done

# Every certificate assertion in the suite depends on bootstrap's ACME config.
api GET /api/v1/settings/acme
t_contains "the ACME directory points at the in-network CA" "pebble" "$(jqr '.caUrl')"
t_contains "the ACME CA root is stored" "BEGIN CERTIFICATE" "$(jqr '.caRootPem')"

api GET /api/v1/settings/general
t_eq "the default domain round-trips" "$TEST_DOMAIN" "$(jqr '.defaultDomain')"

api PUT /api/v1/settings/trusted-proxies \
  '{"ranges":["172.28.0.0/24"],"client_ip_headers":["X-Forwarded-For"]}'
t_eq "trusted proxy ranges can be saved" "200" "$API_STATUS"
api GET /api/v1/settings/trusted-proxies
t_eq "trusted proxy ranges round-trip" "172.28.0.0/24" "$(jqr '.ranges[0]')"
api PUT /api/v1/settings/trusted-proxies '{"ranges":[],"client_ip_headers":[]}'
t_eq "trusted proxy ranges can be cleared" "200" "$API_STATUS"

api PUT /api/v1/settings/upstream-dns '{"enabled":true,"family":"ipv4"}'
t_eq "upstream DNS resolution settings can be saved" "200" "$API_STATUS"
api GET /api/v1/settings/upstream-dns
t_eq "upstream DNS resolution settings round-trip" "ipv4" "$(jqr '.family')"
api PUT /api/v1/settings/upstream-dns '{"enabled":false,"family":"both"}'
t_eq "upstream DNS resolution can be switched off again" "200" "$API_STATUS"

api PUT /api/v1/settings/dns \
  '{"enabled":true,"resolvers":["172.28.0.5"],"fallbacks":["172.28.0.5"],"timeout":"5s"}'
t_eq "DNS resolver settings can be saved" "200" "$API_STATUS"
api GET /api/v1/settings/dns
t_eq "the configured resolver round-trips" "172.28.0.5" "$(jqr '.resolvers[0]')"

# The resolver lands in the proxy transport; a bad one breaks every upstream.
dnsdomain=$(domain_for "custom-resolver")
create_host_or_fail "a host can be created with a custom DNS resolver in effect" "$(jq -nc --arg d "$dnsdomain" '{
  name: "docker-test custom resolver", domains: [$d], upstreams: ["origin-a:8080"],
  dnsResolver: { enabled: true, resolvers: ["172.28.0.5"], timeout: "5s" }
}')" && pass "a host can be created with a custom DNS resolver in effect"

wait_for_https "$dnsdomain" 120
t_eq "upstream resolution through the configured resolver works" "200" "$(http_code "https://$dnsdomain/")"

api PUT /api/v1/settings/dns '{"enabled":false,"resolvers":[]}'
t_eq "DNS resolver settings can be switched off again" "200" "$API_STATUS"

# ── Metrics listener ────────────────────────────────────────────────────────

api PUT /api/v1/settings/metrics '{"enabled":true,"port":9090}'
if [ "$API_STATUS" = "200" ]; then
  pass "metrics can be enabled"
  if wait_for "the metrics listener to open" 30 \
       bash -c "curl -sS --max-time 5 -o /dev/null 'http://caddy:9090/metrics'"; then
    metrics=$(curl -sS --max-time 10 "http://caddy:9090/metrics" 2>/dev/null)
    t_contains "the metrics endpoint serves Prometheus output" "caddy_" "$metrics"
  else
    fail "the metrics listener opens on the configured port" "nothing listening on caddy:9090"
  fi
  api PUT /api/v1/settings/metrics '{"enabled":false}'
  t_eq "metrics can be disabled again" "200" "$API_STATUS"
else
  fail "metrics can be enabled" "HTTP $API_STATUS: $(printf '%.200s' "$API_BODY")"
fi

# ── Access logging ──────────────────────────────────────────────────────────

api PUT /api/v1/settings/logging '{"enabled":true,"format":"json"}'
t_eq "access logging can be enabled" "200" "$API_STATUS"
api GET /api/v1/settings/logging
t_eq "the log format round-trips" "json" "$(jqr '.format')"
api PUT /api/v1/settings/logging '{"enabled":false}'
t_eq "access logging can be switched off again" "200" "$API_STATUS"

# ── Groups ──────────────────────────────────────────────────────────────────

if create_resource groups '{"name":"docker-test group","description":"created by the suite"}'; then
  pass "a group can be created"
  group_id="$NEW_ID"

  api POST "/api/v1/groups/$group_id/members" '{"userId":1}'
  t_matches "a user can be added to a group" '^(200|201)$' "$API_STATUS"

  api GET "/api/v1/groups/$group_id"
  t_contains "the group reflects its new member" "1" "$(jqr '[.members[]? | .id // .userId] | join(",")')"

  api DELETE "/api/v1/groups/$group_id/members/1"
  t_matches "a user can be removed from a group" '^(200|204)$' "$API_STATUS"
else
  fail "a group can be created" "HTTP $API_STATUS: $(printf '%.200s' "$API_BODY")"
fi

# ── Sessions ────────────────────────────────────────────────────────────────

api GET /api/v1/sessions
t_eq "active sessions can be listed" "200" "$API_STATUS"
t_eq "the session listing is an array" "array" "$(jqr 'type')"

# ── Audit trail ─────────────────────────────────────────────────────────────

api GET "/api/v1/audit-log?per_page=100"
t_eq "the audit log can be read" "200" "$API_STATUS"
audit_body="$API_BODY"
t_contains "creating proxy hosts was recorded" "proxy_host" "$audit_body"
t_contains "the audit entries carry an action" "create" "$audit_body"

# ── Manual config apply ─────────────────────────────────────────────────────

api POST /api/v1/caddy/apply
t_eq "the Caddy config can be re-applied on demand" "200" "$API_STATUS"
t_eq "the apply reports success" "true" "$(jqr '.ok')"

running=$(curl -sS --max-time 10 "http://caddy:2019/config/" 2>/dev/null)
t_contains "Caddy is running a CPM-generated config" '"cpm"' "$running"

# ── Misc endpoints ──────────────────────────────────────────────────────────

api GET /api/v1/openapi.json
t_eq "the OpenAPI document is served" "200" "$API_STATUS"
t_ne "the OpenAPI document describes some paths" "null" "$(jqr '.paths | keys | length')"
t_contains "the OpenAPI document covers proxy hosts" "/proxy-hosts" "$API_BODY"

api GET /api/v1/dns-providers
t_eq "the DNS provider catalogue can be read" "200" "$API_STATUS"

api GET /api/v1/oauth-providers
t_eq "OAuth providers can be listed" "200" "$API_STATUS"

# ── Endpoints outside /api/v1 ───────────────────────────────────────────────
# The middleware treats these as pages: session works, bearer redirects to login. Both halves are
# pinned, since its allowlist is easy to change by accident.

api_session GET /api/geoip-status
t_eq "the GeoIP status endpoint answers a session request" "200" "$API_STATUS"

api_session GET /api/l4-ports
t_eq "the L4 port status endpoint answers a session request" "200" "$API_STATUS"
t_ne "the L4 port status carries a diff" "null" "$(jqr '.diff')"

api GET /api/geoip-status
t_eq "a bearer caller is redirected away from the non-v1 endpoints" "307" "$API_STATUS"

# ── Global Caddyfile ────────────────────────────────────────────────────────
#
# Merged by addition only: a site on its own port is served, a replacement of CPM's config refused.

put_global_caddyfile() {
  api PUT /api/v1/settings/global-caddy-config "$(jq -nc --arg c "$1" '{caddyfile: $c}')"
}

put_global_caddyfile ':8081 {
  respond "from the global caddyfile" 200
}'
t_eq "a global Caddyfile with a site block of its own can be saved" "200" "$API_STATUS"
if wait_for "Caddy to serve :8081" 30 curl -sS --max-time 3 -o /dev/null http://caddy:8081/; then
  t_eq "its site block is served on its own port" "from the global caddyfile"     "$(curl -sS --max-time 5 http://caddy:8081/)"
else
  fail "its site block is served on its own port" "nothing answered on caddy:8081"
fi
t_ne "CPM's own server keeps answering alongside it" "000"   "$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' http://caddy/ 2>/dev/null)"

put_global_caddyfile '{
  admin :3000
}'
t_eq "a global Caddyfile that would move the admin API is refused" "400" "$API_STATUS"
t_contains "the refusal names what it would replace" "admin" "$API_BODY"

put_global_caddyfile ':80 {
  respond "hijack"
}'
t_eq "a global Caddyfile claiming port 80 is refused" "400" "$API_STATUS"

put_global_caddyfile ':8082 {
  not_a_directive
}'
t_eq "a global Caddyfile Caddy cannot read is refused" "400" "$API_STATUS"

api GET /api/v1/settings/global-caddy-config
t_contains "a refused save leaves the last good one in place" "8081" "$(jqr '.caddyfile')"

api PUT /api/v1/settings/global-caddy-config '{"caddyfile":""}'
t_eq "the global Caddyfile can be cleared" "200" "$API_STATUS"
if wait_for "caddy:8081 to stop answering" 30 sh -c '! curl -sS --max-time 3 -o /dev/null http://caddy:8081/'; then
  pass "clearing it removes its site block"
else
  fail "clearing it removes its site block" "caddy:8081 still answers"
fi

finish
