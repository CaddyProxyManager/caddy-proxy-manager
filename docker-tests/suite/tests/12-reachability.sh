#!/usr/bin/env bash
# The host editor's reachability check: the controller resolves each domain and asks
# http://<domain>/.well-known/cpm-reachability for the token its Caddy answers with. Names in
# dyn.cpm.test point where each outcome needs: at Caddy, at acme-dns (another web server), at an
# address nothing answers on, or nowhere.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "reachability check"

up="up.$DYN_DOMAIN" elsewhere="elsewhere.$DYN_DOMAIN" silent="silent.$DYN_DOMAIN" missing="missing.$DYN_DOMAIN"
restore() {
  local name
  for name in "$up" "$elsewhere" "$silent" "$missing"; do rig_dns_del "$name" "" --no-wait; done
  rig_zone_write
}
trap 'cleanup_tracked; restore' EXIT

rig_dns_set "$up" A "$CADDY_IP"
rig_dns_set "$elsewhere" A 172.28.0.27
rig_dns_set "$silent" A 172.28.0.199

create_host_or_fail "a host with one domain per outcome can be created" "$(jq -nc \
  --arg a "$up" --arg b "$elsewhere" --arg c "$silent" --arg d "$missing" \
  '{name:"docker-test reachability", domains:[$a,$b,$c,$d], upstreams:["origin-a:8080"], sslForced:false}')" \
  && pass "a host with one domain per outcome can be created"
host_id=$NEW_ID

# The upstream is down; the check is about the domain reaching this Caddy, not about the upstream.
create_host_or_fail "a host whose upstream is down can be created" "$(jq -nc --arg a "down.$TEST_DOMAIN" \
  '{name:"docker-test reachability down", domains:[$a], upstreams:["origin-a:9"], sslForced:false}')" \
  && pass "a host whose upstream is down can be created"
down_id=$NEW_ID

probe() { api_session POST "/api/proxy-hosts/$1/reachability" "${2:-{\}}"; }
result() { jqr 'first(.results[] | select(.domain == $d)) | .result' --arg d "$1"; }

probe "$host_id"
t_eq "the check answers" "200" "$API_STATUS"
t_eq "a domain resolving to this Caddy is reached" "reached" "$(result "$up")"
t_contains "and names the address it resolved to" "$CADDY_IP" \
  "$(jqr 'first(.results[] | select(.domain == $d)) | .addresses | join(" ")' --arg d "$up")"
t_eq "one resolving to another web server is someone else's" "otherServer" "$(result "$elsewhere")"
t_eq "one resolving to an address nothing answers on gets no answer" "noAnswer" "$(result "$silent")"
t_eq "one that does not resolve is unresolved" "unresolved" "$(result "$missing")"

fetch "http://$up/.well-known/cpm-reachability"
t_matches "Caddy answers the probe path with the controller's token" '^cpm-reachability:[0-9a-f]{32}$' "$FETCH_BODY"
t_eq "and it is never cached" "no-store" "$(header_value cache-control)"

probe "$down_id"
t_eq "a host whose upstream is down is still reached" "reached" "$(result "down.$TEST_DOMAIN")"
t_eq "while the upstream itself fails" "502" "$(http_code "http://down.$TEST_DOMAIN/")"

# ── Who may ask ─────────────────────────────────────────────────────────────

api POST "/api/proxy-hosts/$host_id/reachability" '{}'
t_eq "a bearer token is sent to sign in" "307" "$API_STATUS"
t_eq "a session without a same-origin Origin is refused" "403" \
  "$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -b "$STATE_DIR/cookies.txt" -X POST \
      -H 'Content-Type: application/json' --data-binary '{}' "$CPM_API/api/proxy-hosts/$host_id/reachability")"
probe 999999
t_eq "an unknown host is a 404" "404" "$API_STATUS"

finish
