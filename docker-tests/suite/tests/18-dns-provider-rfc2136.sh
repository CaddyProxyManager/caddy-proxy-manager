#!/usr/bin/env bash
# DNS-01 through a DNS provider module: rfc2136 against a real BIND that is authoritative for
# rfc.cpm.test and accepts TSIG-signed updates. Pebble asks the rig's DNS for the challenge TXT,
# which dnsmasq forwards to BIND, so a certificate here means Caddy wrote the record over RFC 2136.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "DNS provider: rfc2136"

ZONE="rfc.$TEST_DOMAIN"
BIND_IP=172.28.0.53
TSIG_NAME=cpm-rig
TSIG_SECRET="Y3BtLWRvY2tlci10ZXN0cy1yZmMyMTM2LXRzaWctMDE="

provider() {  # provider DEFAULT [KEY] - the rfc2136 credentials, with DEFAULT as the default
  jq -nc --arg d "$1" --arg k "${2:-$TSIG_SECRET}" --arg n "$TSIG_NAME" --arg s "$BIND_IP:53" '{
    providers: {rfc2136: {key_name: $n, key_alg: "hmac-sha256", key: $k, server: $s}},
    default: (if $d == "" then null else $d end)
  }'
}

restore() {
  api PUT /api/v1/settings/dns-provider '{"providers":{},"default":null}' >/dev/null 2>&1
  api PUT /api/v1/settings/dns '{"enabled":false,"resolvers":[]}' >/dev/null 2>&1
}
trap 'cleanup_tracked; restore' EXIT

tls_policy() {  # the automation policy Caddy is running for NAME
  curl -sS --max-time 10 "http://caddy:2019/config/apps/tls/automation/policies" 2>/dev/null \
    | jq -c --arg n "$1" 'first(.[] | select((.subjects // []) | index($n)))'
}

san_of() { tls_cert "$1" | openssl x509 -noout -ext subjectAltName 2>/dev/null; }

api_expect "the challenge resolvers can point at the rig's DNS" 200 PUT /api/v1/settings/dns \
  "$(jq -nc --arg r "$RIG_DNS" '{enabled:true, resolvers:[$r]}')"

api GET /api/v1/dns-providers
t_eq "the catalogue lists rfc2136 with its four fields" "key,key_alg,key_name,server" \
  "$(jqr 'first(.[] | select(.name == "rfc2136")) | [.fields[] | select(.required) | .key] | sort | join(",")')"

api PUT /api/v1/settings/dns-provider "$(provider "" | jq -c 'del(.providers.rfc2136.server)')"
t_eq "credentials missing a required field are refused" "400" "$API_STATUS"

api_expect "rfc2136 credentials can be saved, with no default provider" 200 \
  PUT /api/v1/settings/dns-provider "$(provider "")"

api GET /api/v1/settings/dns-provider
t_eq "the saved credentials read back redacted" "key,key_alg,key_name,server" \
  "$(jqr '.providers.rfc2136.configuredFields | sort | join(",")')"
t_not_contains "the TSIG secret is never read back" "$TSIG_SECRET" "$API_BODY"

# ── A wildcard needs DNS-01 ─────────────────────────────────────────────────

wild="*.wild.$ZONE"
api POST /api/v1/proxy-hosts "$(jq -nc --arg d "$wild" \
  '{name:"docker-test rfc2136 refused", domains:[$d], upstreams:["origin-a:8080"]}')"
t_eq "a wildcard host with no provider for it is refused" "400" "$API_STATUS"
[ "$API_STATUS" = "201" ] && track "proxy-hosts/$(jqr '.id')"

if create_resource certificates "$(jq -nc --arg w "$wild" --arg a "wild.$ZONE" '{
     name: "docker-test rfc2136 wildcard", type: "managed", domainNames: [$a, $w],
     providerOptions: {provider: "rfc2136"}}')"; then
  pass "a managed certificate can name the rfc2136 provider"
  cert_id="$NEW_ID"
else
  fail "a managed certificate can name the rfc2136 provider" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
fi
t_eq "and reads back with it" "rfc2136" "$(jqr '.providerOptions.provider')"

create_host_or_fail "a wildcard host on that certificate can be created" "$(jq -nc --arg d "$wild" \
  --arg a "wild.$ZONE" --argjson c "${cert_id:-null}" '{name:"docker-test rfc2136 wildcard",
    domains:[$a, $d], upstreams:["origin-a:8080"], certificateId:$c}')" \
  && pass "a wildcard host on that certificate can be created"

policy=$(tls_policy "$wild")
t_eq "Caddy solves it over DNS-01 through rfc2136" "rfc2136" \
  "$(printf '%s' "$policy" | jq -r '.issuers[0].challenges.dns.provider.name')"
t_eq "against the configured server" "$BIND_IP:53" \
  "$(printf '%s' "$policy" | jq -r '.issuers[0].challenges.dns.provider.server')"
t_eq "signing with the TSIG key" "$TSIG_NAME|hmac-sha256" \
  "$(printf '%s' "$policy" | jq -r '.issuers[0].challenges.dns.provider | "\(.key_name)|\(.key_alg)"')"
t_eq "with no HTTP challenge to fall back on" "null" \
  "$(printf '%s' "$policy" | jq -r '.issuers[0].challenges.http // null')"

if wait_for_https "a.wild.$ZONE" 180; then
  pass "a wildcard certificate is issued over DNS-01 through BIND"
else
  fail "a wildcard certificate is issued over DNS-01 through BIND" "no usable certificate for a.wild.$ZONE"
fi
t_contains "it was issued by Pebble" "Pebble" "$(tls_field "a.wild.$ZONE" -issuer)"
t_contains "and covers the wildcard" "DNS:$wild" "$(san_of "a.wild.$ZONE")"
fetch "https://b.wild.$ZONE/"
t_eq "any name under the wildcard is served" "200|origin-a" "$FETCH_CODE|$(fetch_json '.origin')"
# Caddy orders the bare name apart from the wildcard, through the same provider.
if wait_for_https "wild.$ZONE" 180; then
  t_contains "the certificate's bare name is issued too" "DNS:wild.$ZONE" "$(san_of "wild.$ZONE")"
else
  fail "the certificate's bare name is issued too" "no usable certificate for wild.$ZONE"
fi

# The records were written to BIND and removed after validation: none is left behind.
t_eq "the challenge record is cleaned up afterwards" "" \
  "$(dig +short +norec @"$BIND_IP" "_acme-challenge.wild.$ZONE" TXT 2>/dev/null)"

# ── The default provider ────────────────────────────────────────────────────

api_expect "rfc2136 can be made the default provider" 200 \
  PUT /api/v1/settings/dns-provider "$(provider rfc2136)"

plain="default.$ZONE"
create_host_or_fail "a host with no certificate of its own can be created" "$(jq -nc --arg d "$plain" \
  '{name:"docker-test rfc2136 default", domains:[$d], upstreams:["origin-b:8080"]}')" \
  && pass "a host with no certificate of its own can be created"
t_eq "an auto-managed host uses the default provider" "rfc2136" \
  "$(tls_policy "$plain" | jq -r '.issuers[0].challenges.dns.provider.name')"
if wait_for_https "$plain" 180; then
  pass "and is issued its certificate over DNS-01"
else
  fail "and is issued its certificate over DNS-01" "no usable certificate for $plain"
fi
fetch "https://$plain/"
t_eq "which it serves" "200|origin-b" "$FETCH_CODE|$(fetch_json '.origin')"

finish
