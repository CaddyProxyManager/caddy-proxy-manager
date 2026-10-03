#!/usr/bin/env bash
# Upstream DNS pinning: an upstream named in dyn.cpm.test is resolved by the controller when it
# builds the config and dialled by address, so a changed record reaches Caddy only on the next
# apply. Records are rewritten with rig_dns_set; origin-a is 172.28.0.20, origin-b 172.28.0.21.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "upstream DNS pinning"

A=172.28.0.20 B=172.28.0.21
name="pin.$DYN_DOMAIN"
loose="loose.$DYN_DOMAIN"
restore() {
  api PUT /api/v1/settings/upstream-dns '{"enabled":false,"family":"both"}' >/dev/null 2>&1
  rig_dns_del "$name" "" --no-wait; rig_dns_del "$loose" "" --no-wait; rig_zone_write
}
trap 'cleanup_tracked; restore' EXIT

dials() {  # dials DOMAIN -> the sorted dial addresses of DOMAIN's reverse_proxy
  curl -sS --max-time 10 http://caddy:2019/config/apps/http/servers/cpm/routes 2>/dev/null | jq -r --arg d "$1" \
    '[.[] | select(.match[0].host // [] | index($d)) | .. | objects | select(.handler? == "reverse_proxy")
      | .upstreams[]?.dial] | unique | join(" ")'
}
origin_of() { fetch "https://$1/" && fetch_json '.origin'; }

rig_dns_set "$name" A "$A"
rig_dns_set "$loose" A "$A"

pinned=$(domain_for "dns-pinned")
create_host_or_fail "a host pinning its upstream can be created" "$(jq -nc --arg d "$pinned" --arg u "$name:8080" \
  '{name:"docker-test dns pinned", domains:[$d], upstreams:[$u],
    upstreamDnsResolution:{enabled:true, family:"ipv4"}}')" && pass "a host pinning its upstream can be created"
pinned_id=$NEW_ID

unpinned=$(domain_for "dns-unpinned")
create_host_or_fail "a host dialling by name can be created" "$(jq -nc --arg d "$unpinned" --arg u "$loose:8080" \
  '{name:"docker-test dns unpinned", domains:[$d], upstreams:[$u]}')" && pass "a host dialling by name can be created"

t_eq "the pinned upstream is dialled at the address it resolved to" "$A:8080" "$(dials "$pinned")"
t_eq "the other keeps its name" "$loose:8080" "$(dials "$unpinned")"

wait_for_https "$pinned" 120
wait_for_https "$unpinned" 120
t_eq "traffic reaches the resolved origin" "origin-a" "$(origin_of "$pinned")"
fetch "https://$pinned/"
t_eq "with the host's own name in Host" "$pinned" "$(fetch_json '.host')"

# ── A changed record ────────────────────────────────────────────────────────

rig_dns_set "$name" A "$B"
rig_dns_set "$loose" A "$B"
t_eq "a changed record does not move a pinned upstream by itself" "$A:8080" "$(dials "$pinned")"
t_eq "so its traffic stays where it was" "origin-a" "$(origin_of "$pinned")"
moved() { [ "$(origin_of "$unpinned")" = "origin-b" ]; }
if wait_for "Caddy's own lookup to follow the record" 30 moved; then
  pass "a host dialling by name follows the record"
else
  fail "a host dialling by name follows the record" "still $(origin_of "$unpinned")"
fi

api_expect "the next apply re-resolves" 200 POST /api/v1/caddy/apply
t_eq "the pinned upstream moves to the new address" "$B:8080" "$(dials "$pinned")"
t_eq "and its traffic with it" "origin-b" "$(origin_of "$pinned")"

# ── Several addresses ───────────────────────────────────────────────────────

printf '%s. IN A %s\n' "$name" "$A" >>"$RIG_ZONE_DIR/records"
rig_zone_write
wait_for "both records" 15 bash -c "[ \"\$(dig +short +norec @$COREDNS '$name' A | wc -l)\" = 2 ]"
api PUT "/api/v1/proxy-hosts/$pinned_id" '{"loadBalancer":{"enabled":true,"policy":"round_robin"}}'
t_eq "a name with two addresses becomes two upstreams" "$A:8080 $B:8080" "$(dials "$pinned")"
seen=$(for _ in 1 2 3 4 5 6; do origin_of "$pinned"; echo; done | grep -v '^$' | sort -u | tr '\n' ' ')
t_eq "and traffic reaches both" "origin-a origin-b " "$seen"

# ── Unresolvable, and the global setting ────────────────────────────────────

rig_dns_del "$name"
api PUT "/api/v1/proxy-hosts/$pinned_id" '{"description":"re-applied with no record"}'
t_eq "a name that no longer resolves falls back to dialling it" "$name:8080" "$(dials "$pinned")"

api_expect "pinning can be switched on for every host" 200 PUT /api/v1/settings/upstream-dns \
  '{"enabled":true,"family":"ipv4"}'
t_eq "a host with no setting of its own is pinned by it" "$B:8080" "$(dials "$unpinned")"
api PUT "/api/v1/proxy-hosts/$pinned_id" '{"upstreamDnsResolution":{"enabled":false}}'
rig_dns_set "$name" A "$A"
api POST /api/v1/caddy/apply
t_eq "and a host that opts out keeps its name" "$name:8080" "$(dials "$pinned")"

finish
