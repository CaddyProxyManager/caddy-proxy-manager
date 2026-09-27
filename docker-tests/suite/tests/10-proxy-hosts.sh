#!/usr/bin/env bash
# Proxy host lifecycle and the plain reverse-proxy behaviour every other test
# builds on.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "proxy hosts - CRUD and basic proxying"

domain=$(domain_for "basic")

# ── Create ──────────────────────────────────────────────────────────────────

create_host_or_fail "a proxy host can be created" "$(jq -nc --arg d "$domain" '{
  name: "docker-test basic",
  domains: [$d],
  upstreams: ["origin-a:8080"]
}')" || finish

host_id="$NEW_ID"
pass "a proxy host can be created"
t_eq "the created host echoes its domain" "$domain" "$(jqr '.domains[0]')"
t_eq "the created host echoes its upstream" "origin-a:8080" "$(jqr '.upstreams[0]')"
t_eq "a new host is enabled by default" "true" "$(jqr '.enabled')"

api GET "/api/v1/proxy-hosts/$host_id"
t_eq "the host can be read back by id" "200" "$API_STATUS"
t_eq "the round-tripped host keeps its name" "docker-test basic" "$(jqr '.name')"

# ── Proxying ────────────────────────────────────────────────────────────────

if ! wait_for_https "$domain"; then
  fail "Caddy serves the host over HTTPS" "no certificate was issued for $domain"
  finish
fi
pass "Caddy serves the host over HTTPS"

fetch "https://$domain/hello?x=1"
t_eq "the request reaches the upstream" "200" "$FETCH_CODE"
t_eq "it reaches the configured origin" "origin-a" "$(fetch_json '.origin')"
t_eq "the path is passed through unchanged" "/hello" "$(fetch_json '.path')"
t_eq "the query string is passed through unchanged" "x=1" "$(fetch_json '.query')"

# Virtual-hosted upstreams need the client's Host kept.
t_eq "the original Host header is forwarded" "$domain" "$(fetch_json '.host')"

t_eq "X-Forwarded-Proto reflects the client's scheme" "https" \
  "$(fetch_json '.headers["x-forwarded-proto"]')"
t_contains "X-Forwarded-For carries the client address" "$CLIENT_IP" \
  "$(fetch_json '.headers["x-forwarded-for"]')"
t_eq "X-Forwarded-Host carries the requested host" "$domain" \
  "$(fetch_json '.headers["x-forwarded-host"]')"

# Proves the request is proxied, not DNS pointing at the backend.
t_eq "the upstream's peer is Caddy" "$CADDY_IP" "$(fetch_json '.peer')"

fetch "https://$domain/echo" -X POST -H 'Content-Type: text/plain' --data-binary 'payload-from-client'
t_eq "a POST body survives the proxy" "payload-from-client" "$(fetch_json '.body')"
t_eq "the method survives the proxy" "POST" "$(fetch_json '.method')"

fetch "https://$domain/large"
t_eq "a large response body is proxied intact" "100000" "${#FETCH_BODY}"

fetch "https://$domain/status/503"
t_eq "an upstream error status is passed through" "503" "$FETCH_CODE"

# ── Update ──────────────────────────────────────────────────────────────────

api PUT "/api/v1/proxy-hosts/$host_id" "$(jq -nc --arg d "$domain" '{
  name: "docker-test basic (moved)",
  domains: [$d],
  upstreams: ["origin-b:8080"]
}')"
t_eq "the host can be updated" "200" "$API_STATUS"

if wait_for "traffic to move to origin-b" 30 \
     bash -c "curl -sS --max-time 5 --cacert '$CA_BUNDLE' 'https://$domain/' | grep -q origin-b"; then
  pass "an upstream change takes effect without a restart"
else
  fetch "https://$domain/"
  fail "an upstream change takes effect without a restart" "still served by $(fetch_json '.origin')"
fi

# ── Disable ─────────────────────────────────────────────────────────────────

api PUT "/api/v1/proxy-hosts/$host_id" "$(jq -nc --arg d "$domain" '{
  name: "docker-test basic (moved)",
  domains: [$d],
  upstreams: ["origin-b:8080"],
  enabled: false
}')"
t_eq "the host can be disabled" "200" "$API_STATUS"
t_eq "the disabled flag round-trips" "false" "$(jqr '.enabled')"

# Dropped entirely, TLS policy included, so the handshake has nothing to answer.
if wait_for "the disabled host to stop answering" 30 \
     bash -c "! curl -sS --max-time 5 --cacert '$CA_BUNDLE' -o /dev/null 'https://$domain/'"; then
  pass "a disabled host is no longer served"
else
  fail "a disabled host is no longer served" "https://$domain/ still answers"
fi

# ── Delete ──────────────────────────────────────────────────────────────────

api DELETE "/api/v1/proxy-hosts/$host_id"
t_matches "the host can be deleted" '^(200|204)$' "$API_STATUS"
CLEANUP_STACK=()

api GET "/api/v1/proxy-hosts/$host_id"
t_eq "a deleted host is gone" "404" "$API_STATUS"

# ── Validation ──────────────────────────────────────────────────────────────

api POST /api/v1/proxy-hosts '{"name":"no domains","domains":[],"upstreams":["origin-a:8080"]}'
t_ne "a host with no domains is rejected" "201" "$API_STATUS"

api POST /api/v1/proxy-hosts "$(jq -nc --arg d "$(domain_for no-upstream)" \
  '{name:"no upstreams", domains:[$d], upstreams:[]}')"
t_ne "a host with no upstreams is rejected" "201" "$API_STATUS"

api POST /api/v1/proxy-hosts \
  '{"name":"bad domain","domains":["not a hostname"],"upstreams":["origin-a:8080"]}'
t_ne "a malformed domain is rejected" "201" "$API_STATUS"

api POST /api/v1/proxy-hosts \
  '{"name":"mid-label wildcard","domains":["we*rd.cpm.test"],"upstreams":["origin-a:8080"]}'
t_ne "a wildcard outside the leading label is rejected" "201" "$API_STATUS"

# Domains are normalised on the way in: case-folded, trailing dot stripped,
# duplicates collapsed.
create_host_or_fail "a host with messy domain input can be created" "$(jq -nc \
  --arg upper "$(printf '%s' "$(domain_for NORMALISE)" | tr 'a-z' 'A-Z')" \
  --arg dotted "$(domain_for normalise)." \
  '{name:"normalise", domains:[$upper, $dotted], upstreams:["origin-a:8080"]}')" \
  && pass "a host with messy domain input can be created" \
  && t_eq "domains are normalised and de-duplicated" \
       "$(domain_for normalise)" "$(jqr '.domains | join(",")')"

finish
