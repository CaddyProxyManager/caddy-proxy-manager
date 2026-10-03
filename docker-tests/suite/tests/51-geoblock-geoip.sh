#!/usr/bin/env bash
# Country, continent and ASN blocking against MaxMind's public test databases, which the runner puts
# where an agent would (Caddy's /usr/share/GeoIP). The runner is the only trusted proxy, so the
# address it forwards is the client the databases are asked about: 81.2.69.160 is GB (EU),
# 89.160.20.112 SE (EU), 216.160.83.56 US (NA), 67.43.156.1 BT (AS) and AS35908, 1.128.0.1 AS1221.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "geo blocking by country, continent and ASN"

if [ "${TEST_GEOBLOCK:-1}" != "1" ]; then
  skip "GeoIP blocking" "disabled via CPM_TEST_GEOBLOCK=0"
  finish
fi

GB=81.2.69.160 SE=89.160.20.112 US=216.160.83.56 BT=67.43.156.1 AS1221=1.128.0.1

install -m 0644 /opt/maxmind/GeoIP2-Country-Test.mmdb /geoip/GeoLite2-Country.mmdb
install -m 0644 /opt/maxmind/GeoLite2-ASN-Test.mmdb /geoip/GeoLite2-ASN.mmdb

# rules FILTER - a geoblock document: nothing blocked, the runner trusted, FILTER applied.
rules() {
  jq -nc --arg ip "$CLIENT_IP/32" '{
    enabled: true,
    block_countries: [], block_continents: [], block_asns: [], block_cidrs: [], block_ips: [],
    allow_countries: [], allow_continents: [], allow_asns: [], allow_cidrs: [], allow_ips: [],
    trusted_proxies: [$ip], fail_closed: false,
    response_status: 403, response_body: "Forbidden", response_headers: {}, redirect_url: ""
  }' | jq -c "$1"
}

restore_global() { api PUT /api/v1/settings/geoblock "$(rules '.enabled = false | .trusted_proxies = []')" >/dev/null 2>&1; }
trap 'restore_global; cleanup_tracked' EXIT

# host SLUG FILTER - a host in override mode with those rules -> HOST, once it answers
HOST=
host() {
  HOST=$(domain_for "geoip-$1")
  create_host_or_fail "the $1 host can be created" "$(jq -nc --arg d "$HOST" --argjson g "$(rules "$2")" \
    '{name: ("docker-test geoip " + $d), domains: [$d], upstreams: ["origin-a:8080"], sslForced: false,
      geoblock: $g, geoblockMode: "override"}')" && pass "the $1 host can be created"
  wait_for "$HOST to answer" 60 curl -sS --max-time 5 -o /dev/null "http://$HOST/"
}

as_from() { http_code "http://$HOST/" -H "X-Forwarded-For: $1"; }  # as_from IP -> the status

host country '.block_countries = ["GB"]'
country_host=$HOST
t_eq "a request from GB is blocked by country" "403" "$(as_from "$GB")"
t_eq "one from SE is not" "200" "$(as_from "$SE")"
t_eq "nor is an address the database does not know" "200" "$(http_code "http://$country_host/")"

handler=$(curl -sS --max-time 10 http://caddy:2019/config/apps/http/servers/cpm/routes 2>/dev/null \
  | jq -c --arg d "$country_host" 'first(.. | objects | select(.handler? == "blocker"))')
t_eq "the blocker is pointed at the databases' paths" \
  "/usr/share/GeoIP/GeoLite2-Country.mmdb|/usr/share/GeoIP/GeoLite2-ASN.mmdb" \
  "$(printf '%s' "$handler" | jq -r '"\(.geoip_db)|\(.asn_db)"')"

host continent '.block_continents = ["EU"]'
t_eq "a continent rule blocks GB" "403" "$(as_from "$GB")"
t_eq "and SE" "403" "$(as_from "$SE")"
t_eq "but not the US" "200" "$(as_from "$US")"

host asn '.block_asns = [1221]'
t_eq "an ASN rule blocks an address in that network" "403" "$(as_from "$AS1221")"
t_eq "and not one in another" "200" "$(as_from "$BT")"

host allow '.block_continents = ["NA", "EU"] | .allow_countries = ["US"]'
t_eq "an allowed country passes a continent block" "200" "$(as_from "$US")"
t_eq "the rest of the continent does not" "403" "$(as_from "$SE")"

host response '.block_countries = ["SE"] | .response_status = 451 | .response_body = "not from here"'
fetch "http://$HOST/" -H "X-Forwarded-For: $SE"
t_eq "the host's own status is served to a blocked client" "451" "$FETCH_CODE"
t_eq "with its own body" "not from here" "$FETCH_BODY"

# Only a trusted proxy chooses the client: from the runner's second address the header is ignored.
add_client_alias
t_eq "a forwarded address from an untrusted peer is ignored" "200" \
  "$(http_code "http://$country_host/" --interface "$ALT_CLIENT_IP" -H "X-Forwarded-For: $GB")"

# ── Global rules reach a host with none of its own ──────────────────────────

neutral=$(domain_for "geoip-neutral")
create_host_or_fail "a host with no geoblock rules can be created" "$(jq -nc --arg d "$neutral" \
  '{name:"docker-test geoip neutral", domains:[$d], upstreams:["origin-a:8080"], sslForced:false}')" \
  && pass "a host with no geoblock rules can be created"
wait_for "$neutral to answer" 60 curl -sS --max-time 5 -o /dev/null "http://$neutral/"
HOST=$neutral

api_expect "a global country block can be saved" 200 PUT /api/v1/settings/geoblock "$(rules '.block_countries = ["BT"]')"
if wait_for "the global block to reach $neutral" 30 bash -c "[ \"\$(curl -sS -o /dev/null -w '%{http_code}' -H 'X-Forwarded-For: $BT' 'http://$neutral/')\" = 403 ]"; then
  pass "the global country block applies to a host with no rules"
else
  fail "the global country block applies to a host with no rules" "got $(as_from "$BT")"
fi
t_eq "other countries still pass" "200" "$(as_from "$GB")"
HOST=$country_host
t_eq "a host in override mode keeps only its own rules" "200" "$(as_from "$BT")"

finish
