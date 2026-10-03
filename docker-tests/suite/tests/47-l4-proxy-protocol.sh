#!/usr/bin/env bash
# IP rules and IP blocking on L4 hosts, with and without PROXY protocol received. Behind PROXY
# protocol the client is the header's source, whatever address the connection comes from; without
# it the header is only data and the connection's own address is what is matched. The runner's
# address is denied by both the list and the geo block, so a relay here is never an accident.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "L4 IP rules behind PROXY protocol"

PP_PORT=19050
PLAIN_PORT=19051
DENIED_IP=203.0.113.7
GEO_BLOCKED_IP=203.0.113.8
ALLOWED_IP=198.51.100.9

if ! add_client_alias; then
  fail "the runner can take a second address" "ip addr add $ALT_CLIENT_IP failed (NET_ADMIN?)"
  finish
fi

# probe PORT [PROXY_SOURCE] [BIND_IP] - the relayed reply, empty when the connection was closed.
probe() {
  local port="$1" source="${2:-}" bind="${3:-$CLIENT_IP}" header=""
  [ -n "$source" ] && header=$(printf 'PROXY TCP4 %s %s 40000 %s\r' "$source" "$CADDY_IP" "$port")
  { [ -n "$header" ] && printf '%s\n' "$header"; printf 'l4-guard\nQUIT\n'; } |
    timeout 12 socat -t3 - "TCP:caddy:$port,bind=$bind" 2>/dev/null
}

if ! create_resource access-lists "$(jq -nc --arg d "$DENIED_IP" --arg c "$CLIENT_IP" '{
  name: "docker-test l4 proxy protocol",
  ipDefault: "allow",
  ipRules: [{action: "deny", cidr: $d}, {action: "deny", cidr: $c}]
}')"; then
  fail "a list denying two addresses can be created" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
  finish
fi
list_id="$NEW_ID"
pass "a list denying two addresses can be created"

l4_body() {  # l4_body PORT PROXY_PROTOCOL_RECEIVE
  jq -nc --arg l ":$1" --argjson pp "$2" --argjson a "$list_id" \
    --arg g "$GEO_BLOCKED_IP" --arg c "$CLIENT_IP" '{
    name: ("docker-test l4 proxy protocol " + $l), protocol: "tcp", listenAddress: $l,
    upstreams: ["origin-tcp:9000"], matcherType: "none",
    proxyProtocolReceive: $pp, accessListId: $a,
    geoblock: {
      enabled: true,
      block_countries: [], block_continents: [], block_asns: [],
      block_cidrs: [], block_ips: [$g, $c],
      allow_countries: [], allow_continents: [], allow_asns: [],
      allow_cidrs: [], allow_ips: []
    },
    geoblockMode: "override"
  }'
}

if ! create_l4_host "$(l4_body "$PP_PORT" true)"; then
  fail "an L4 host receiving PROXY protocol takes a list and a geo block" \
    "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
  finish
fi
pass "an L4 host receiving PROXY protocol takes a list and a geo block"
create_l4_host "$(l4_body "$PLAIN_PORT" false)" \
  && pass "so does one without it" \
  || fail "so does one without it" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"

# Only a connect: the runner's own address is closed on both.
wait_for "both L4 listeners" 60 bash -c "nc -z -w2 caddy $PP_PORT && nc -z -w2 caddy $PLAIN_PORT"

# ── Behind PROXY protocol: the header's source is the client ────────────────

reply=$(probe "$PP_PORT" "$ALLOWED_IP")
t_contains "an allowed source is relayed, though the connection's own address is denied" \
  "ECHO origin-tcp l4-guard" "$reply"
t_not_contains "the header is consumed, not relayed" "PROXY TCP4" "$reply"
t_eq "a source the list denies is closed" "" "$(probe "$PP_PORT" "$DENIED_IP")"
t_eq "a source the geo block names is closed" "" "$(probe "$PP_PORT" "$GEO_BLOCKED_IP")"
t_contains "the same from another connecting address" "ECHO origin-tcp l4-guard" \
  "$(probe "$PP_PORT" "$ALLOWED_IP" "$ALT_CLIENT_IP")"
t_eq "which a denied header still closes" "" "$(probe "$PP_PORT" "$DENIED_IP" "$ALT_CLIENT_IP")"

# ── Without it: the connection's own address, whatever the bytes claim ──────

t_eq "the runner's own address is closed" "" "$(probe "$PLAIN_PORT")"
t_eq "and a header claiming an allowed source does not open it" "" \
  "$(probe "$PLAIN_PORT" "$ALLOWED_IP")"
reply=$(probe "$PLAIN_PORT" "$DENIED_IP" "$ALT_CLIENT_IP")
t_contains "an allowed address is relayed, whatever source its bytes claim" \
  "ECHO origin-tcp l4-guard" "$reply"
t_contains "the header reaches the upstream as data" "ECHO origin-tcp PROXY TCP4 $DENIED_IP" "$reply"
t_contains "a geo-blocked claim does not close it either" "ECHO origin-tcp l4-guard" \
  "$(probe "$PLAIN_PORT" "$GEO_BLOCKED_IP" "$ALT_CLIENT_IP")"

finish
