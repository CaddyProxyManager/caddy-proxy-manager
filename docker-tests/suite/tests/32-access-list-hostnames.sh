#!/usr/bin/env bash
# A hostname in an access list's IP rules, resolved by the controller through the global DNS
# resolvers - here the rig's, which answer dyn.cpm.test from a zone this file rewrites. The name
# stands for the runner, then for a second address the runner also holds, then fails to resolve.
# Saving looks up only names never seen, so a changed answer waits for the refresher: a pass every
# minute, re-resolving names whose TTL (clamped to at least 60 s) ran out.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "hostnames in access-list IP rules"

home="home.$DYN_DOMAIN"
domain=$(domain_for "acl-hostname")
L4_PORT=19040
# Two refresher wakes and a TTL, with room for the apply.
REFRESH_WAIT=200

restore() {
  api PUT /api/v1/settings/dns '{"enabled":false,"resolvers":[]}' >/dev/null 2>&1
  rig_dns_del "$home" "" --no-wait
  rig_zone_write
}
trap 'cleanup_tracked; restore' EXIT

if ! add_client_alias; then
  fail "the runner can take a second address" "ip addr add $ALT_CLIENT_IP failed (NET_ADMIN?)"
  finish
fi

code_from() {  # code_from SOURCE_IP
  curl -sS --max-time 10 -o /dev/null -w '%{http_code}' --cacert "$CA_BUNDLE" \
    --interface "$1" "https://$domain/" 2>/dev/null || true
}

tcp_from() {  # tcp_from SOURCE_IP - what the L4 host relays back, empty when it closed
  printf 'acl-hostname\nQUIT\n' |
    timeout 12 socat -t3 - "TCP:caddy:$L4_PORT,bind=$1" 2>/dev/null
}

rule_field() {  # rule_field JQ [jq args...] - on the list's hostname rule, freshly read
  local filter="$1"; shift
  api GET "/api/v1/access-lists/$list_id"
  jqr "first(.ipRules[] | select(.hostname != null)) | $filter" "$@"
}

api_expect "the global resolvers can point at the rig's DNS" 200 PUT /api/v1/settings/dns \
  "$(jq -nc --arg r "$RIG_DNS" '{enabled:true, resolvers:[$r]}')"
rig_dns_set "$home" A "$CLIENT_IP"

# ── The name stands for the runner ──────────────────────────────────────────

if ! create_resource access-lists "$(jq -nc --arg h "$home" '{
  name: "docker-test acl hostname",
  ipDefault: "deny",
  ipRules: [{action: "allow", hostname: $h}]
}')"; then
  fail "a list with a hostname rule can be created" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
  finish
fi
list_id="$NEW_ID"
pass "a list with a hostname rule can be created"
t_eq "the save resolves a new name at once" "[\"$CLIENT_IP/32\"]" \
  "$(jqr -c 'first(.ipRules[] | select(.hostname != null)) | .resolved.ranges')"

create_host_or_fail "an HTTP host can use the list" "$(jq -nc --arg d "$domain" --argjson l "$list_id" \
  '{name:"docker-test acl hostname", domains:[$d], upstreams:["origin-a:8080"], accessListId:$l}')" \
  && pass "an HTTP host can use the list"
if ! create_l4_host "$(jq -nc --arg l ":$L4_PORT" --argjson a "$list_id" '{
  name: "docker-test acl hostname l4", protocol: "tcp", listenAddress: $l,
  upstreams: ["origin-tcp:9000"], matcherType: "none", accessListId: $a
}')"; then
  fail "an L4 host can use the same list" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
  finish
fi
pass "an L4 host can use the same list"

wait_for_https "$domain" 120
wait_for "the L4 listener" 60 bash -c "printf 'QUIT\n' | timeout 5 socat -t2 - TCP:caddy:$L4_PORT"

t_eq "the address the name resolves to is allowed" "200" "$(code_from "$CLIENT_IP")"
t_eq "another client is denied by the default" "403" "$(code_from "$ALT_CLIENT_IP")"
t_contains "the L4 host relays the name's address" "ECHO origin-tcp acl-hostname" "$(tcp_from "$CLIENT_IP")"
t_eq "and closes on another client" "" "$(tcp_from "$ALT_CLIENT_IP")"

# ── The record changes ──────────────────────────────────────────────────────

rig_dns_set "$home" A "$ALT_CLIENT_IP"
if wait_for "the refresher to pick up the new address" "$REFRESH_WAIT" \
     bash -c "[ \"\$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' --cacert '$CA_BUNDLE' \
       --interface '$CLIENT_IP' 'https://$domain/')\" = 403 ]"; then
  pass "a changed answer is applied without a save"
else
  fail "a changed answer is applied without a save" "the old address is still allowed"
fi
t_eq "the new address is allowed" "200" "$(code_from "$ALT_CLIENT_IP")"
t_eq "the list shows what the name stands for now" "[\"$ALT_CLIENT_IP/32\"]" \
  "$(rule_field '.resolved.ranges' -c)"
t_contains "the L4 host follows the same answer" "ECHO origin-tcp acl-hostname" \
  "$(tcp_from "$ALT_CLIENT_IP")"
t_eq "and closes on the old address" "" "$(tcp_from "$CLIENT_IP")"

# ── The name stops resolving ────────────────────────────────────────────────

rig_dns_del "$home"
if wait_for "a failed lookup to be recorded" "$REFRESH_WAIT" \
     bash -c "curl -sS --max-time 8 -H 'Authorization: Bearer $(cat "$TOKEN_FILE")' \
       '$CPM_API/api/v1/access-lists/$list_id' | jq -e '.ipRules[] | select(.hostname != null) | .resolved.lastError != null'"; then
  pass "a failed lookup is recorded on the rule"
else
  fail "a failed lookup is recorded on the rule" "$(rule_field '.resolved' -c)"
fi
t_eq "the last known answer is kept" "[\"$ALT_CLIENT_IP/32\"]" "$(rule_field '.resolved.ranges' -c)"
t_eq "so that address is still allowed" "200" "$(code_from "$ALT_CLIENT_IP")"
t_eq "and the runner still denied" "403" "$(code_from "$CLIENT_IP")"
t_contains "on the L4 host too" "ECHO origin-tcp acl-hostname" "$(tcp_from "$ALT_CLIENT_IP")"

finish
