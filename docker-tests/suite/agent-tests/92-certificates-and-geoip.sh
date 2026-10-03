#!/usr/bin/env bash
# What only an agent can reach. Caddy's own certificate storage: the dashboard's inventory lists
# the certificate Caddy obtained for a host, and the stored endpoint hands back the chain Caddy
# serves, its key only to a fresh sign-in. And the GeoIP databases 52-geoip-updater left on the
# controller, which the agent downloads through the signed route, byte for byte.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "certificate storage and GeoIP through the agent"

fingerprint() { openssl x509 -noout -fingerprint -sha256 2>/dev/null | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f'; }
cert_pubkey() { openssl x509 -noout -pubkey 2>/dev/null | openssl pkey -pubin -pubout 2>/dev/null | sha256sum | cut -d' ' -f1; }
key_pubkey() { openssl pkey -pubout 2>/dev/null | sha256sum | cut -d' ' -f1; }

domain=$(domain_for "agent-inventory")
create_host_or_fail "a host can be created" "$(jq -nc --arg d "$domain" \
  '{name:"docker-test agent inventory", domains:[$d], upstreams:["origin-a:8080"]}')" \
  && pass "a host can be created"
wait_for_https "$domain" 180 || fail "Caddy obtains its certificate" "no TLS to $domain"
served=$(tls_cert "$domain" | fingerprint)

listed() {
  api_session GET /api/certificates/inventory
  [ "$(jqr '[.agents[].certificates[]? | select(.names | index($d))] | length' --arg d "$domain")" -ge 1 ]
}
if wait_for "the inventory to list the certificate" 60 listed; then
  pass "the inventory lists the certificate Caddy obtained"
else
  fail "the inventory lists the certificate Caddy obtained" "$(printf '%.300s' "$API_BODY")"
  finish
fi
entry=$(jqr 'first(.agents[] as $a | $a.certificates[]? | select(.names | index($d)) | . + {agentId: $a.agentId})' \
  --arg d "$domain" -c)
t_eq "with the fingerprint of the one served" "$served" \
  "$(printf '%s' "$entry" | jq -r '.fingerprint' | tr -d ':' | tr 'A-F' 'a-f')"
t_contains "issued by Pebble" "Pebble" "$(printf '%s' "$entry" | jq -r '.issuer')"

query="agent=$(printf '%s' "$entry" | jq -r '.agentId | @uri')&issuer=$(printf '%s' "$entry" | jq -r '.issuerKey | @uri')&name=$(printf '%s' "$entry" | jq -r '.name | @uri')"
api_session GET "/api/certificates/stored?$query"
t_eq "the stored certificate is the one served" "200|$served" "$API_STATUS|$(jqr '.certificatePem' | fingerprint)"
t_eq "without its key unless asked" "null" "$(jqr '.keyPem')"

fresh_session || fail "the admin can sign in again" "$SIGN_IN_BODY"
api_session GET "/api/certificates/stored?$query&key=1"
t_eq "a fresh session gets the key that goes with it" "$(tls_cert "$domain" | cert_pubkey)" "$(jqr '.keyPem' | key_pubkey)"
api_session GET "/api/certificates/stored?agent=nobody&issuer=x&name=$domain"
t_eq "an agent that does not exist is a 404" "404" "$API_STATUS"

# ── GeoIP ───────────────────────────────────────────────────────────────────

api_session GET /api/geoip-status
if [ "$(jqr '.country')" != "true" ]; then
  skip "the agent downloads the GeoIP databases" "the controller has none; run 52-geoip-updater first"
  finish
fi
downloaded() {
  [ "$(docker exec cpm-test-agent sha256sum /data/geoip/GeoLite2-Country.mmdb 2>/dev/null | cut -d' ' -f1)" = \
    "$(sha256sum /opt/maxmind/GeoIP2-Country-Test.mmdb | cut -d' ' -f1)" ]
}
if wait_for "the agent to download the Country database" 120 downloaded; then
  pass "the agent downloads the controller's Country database, byte for byte"
else
  fail "the agent downloads the controller's Country database, byte for byte" \
    "$(docker exec cpm-test-agent ls -l /data/geoip 2>&1 | tr '\n' ' ')"
fi
t_eq "and the ASN one" "$(sha256sum /opt/maxmind/GeoLite2-ASN-Test.mmdb | cut -d' ' -f1)" \
  "$(docker exec cpm-test-agent sha256sum /data/geoip/GeoLite2-ASN.mmdb 2>/dev/null | cut -d' ' -f1)"

finish
