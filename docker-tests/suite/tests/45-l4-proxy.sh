#!/usr/bin/env bash
# Layer 4 TCP/UDP and connection matchers. Reached on Caddy's own address: an L4 listener has no
# virtual hosting.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "layer 4 proxying"

TCP_PORT=19001
UDP_PORT=19002
HOSTMATCH_PORT=19003
DISABLED_PORT=19004
RANGE_FIRST=19010
RANGE_MIDDLE=19011
RANGE_LAST=19012

tcp_probe() {  # tcp_probe HOST PORT MESSAGE
  printf '%s\nQUIT\n' "$3" | timeout 12 socat -t3 - "TCP:$1:$2" 2>/dev/null
}

udp_probe() {  # udp_probe HOST PORT MESSAGE
  printf '%s' "$3" | timeout 12 socat -t3 - "UDP-DATAGRAM:$1:$2" 2>/dev/null
}

# ── TCP ─────────────────────────────────────────────────────────────────────

if ! create_l4_host "$(jq -nc --arg l ":$TCP_PORT" '{
  name: "docker-test l4 tcp",
  protocol: "tcp",
  listenAddress: $l,
  upstreams: ["origin-tcp:9000"],
  matcherType: "none"
}')"; then
  fail "a TCP stream host can be created" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
  finish
fi
tcp_host_id="$NEW_ID"
pass "a TCP stream host can be created"
t_eq "the stream host reports its protocol" "tcp" "$(jqr '.protocol')"
t_eq "the stream host reports its listen address" ":$TCP_PORT" "$(jqr '.listenAddress')"

if wait_for "Caddy to open the TCP listener" 60 \
     bash -c "printf 'QUIT\n' | timeout 5 socat -t2 - TCP:caddy:$TCP_PORT >/dev/null 2>&1"; then
  pass "Caddy opens the configured TCP port"
else
  fail "Caddy opens the configured TCP port" "nothing accepted a connection on caddy:$TCP_PORT"
  finish
fi

reply=$(tcp_probe caddy "$TCP_PORT" "ping-through-l4")
t_contains "the TCP stream reaches the destination" "HELLO origin-tcp" "$reply"
t_contains "the TCP stream carries data both ways" "ECHO origin-tcp ping-through-l4" "$reply"

# A stream proxy must not close after the first line like a request/response proxy.
multi=$(printf 'one\ntwo\nthree\nQUIT\n' | timeout 12 socat -t3 - "TCP:caddy:$TCP_PORT" 2>/dev/null)
t_contains "a long-lived connection stays open (first)" "ECHO origin-tcp one" "$multi"
t_contains "a long-lived connection stays open (last)" "ECHO origin-tcp three" "$multi"

# ── UDP ─────────────────────────────────────────────────────────────────────

if create_l4_host "$(jq -nc --arg l ":$UDP_PORT" '{
  name: "docker-test l4 udp",
  protocol: "udp",
  listenAddress: $l,
  upstreams: ["origin-udp:9001"],
  matcherType: "none"
}')"; then
  pass "a UDP stream host can be created"
  t_eq "the stream host reports the udp protocol" "udp" "$(jqr '.protocol')"

  if wait_for "the UDP datagram path to come up" 60 \
       bash -c "printf 'probe' | timeout 5 socat -t2 - UDP-DATAGRAM:caddy:$UDP_PORT 2>/dev/null | grep -q ECHO"; then
    pass "Caddy forwards UDP datagrams"
  else
    fail "Caddy forwards UDP datagrams" "no reply from caddy:$UDP_PORT"
  fi

  reply=$(udp_probe caddy "$UDP_PORT" "datagram-through-l4")
  t_contains "the UDP reply comes from the destination" "ECHO origin-udp datagram-through-l4" "$reply"
else
  fail "a UDP stream host can be created" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
fi

# ── Connection matchers ─────────────────────────────────────────────────────
# Routed by the Host header inside the stream, which Caddy must peek without terminating.

match_a=$(domain_for "l4-match-a")
match_b=$(domain_for "l4-match-b")

created_both=1
create_l4_host "$(jq -nc --arg l ":$HOSTMATCH_PORT" --arg h "$match_a" '{
  name: "docker-test l4 host match a",
  protocol: "tcp", listenAddress: $l,
  upstreams: ["origin-a:8080"],
  matcherType: "http_host", matcherValue: [$h]
}')" || created_both=0

create_l4_host "$(jq -nc --arg l ":$HOSTMATCH_PORT" --arg h "$match_b" '{
  name: "docker-test l4 host match b",
  protocol: "tcp", listenAddress: $l,
  upstreams: ["origin-b:8080"],
  matcherType: "http_host", matcherValue: [$h]
}')" || created_both=0

if [ "$created_both" = "1" ]; then
  pass "two stream hosts can share one listener"

  wait_for "the shared listener to accept connections" 60 \
    bash -c "curl -sS --max-time 5 -o /dev/null -H 'Host: $match_a' 'http://caddy:$HOSTMATCH_PORT/'"

  a_origin=$(curl -sS --max-time 8 -H "Host: $match_a" "http://caddy:$HOSTMATCH_PORT/" 2>/dev/null | jq -r '.origin')
  b_origin=$(curl -sS --max-time 8 -H "Host: $match_b" "http://caddy:$HOSTMATCH_PORT/" 2>/dev/null | jq -r '.origin')
  t_eq "the first Host matcher selects its own destination" "origin-a" "$a_origin"
  t_eq "the second Host matcher selects a different destination" "origin-b" "$b_origin"

  unmatched=$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' \
    -H "Host: nobody.$TEST_DOMAIN" "http://caddy:$HOSTMATCH_PORT/" 2>/dev/null)
  t_ne "an unmatched Host is not proxied" "200" "${unmatched:-000}"
else
  fail "two stream hosts can share one listener" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
fi

# ── Disabling and validation ────────────────────────────────────────────────

if create_l4_host "$(jq -nc --arg l ":$DISABLED_PORT" '{
  name: "docker-test l4 disabled",
  protocol: "tcp", listenAddress: $l,
  upstreams: ["origin-tcp:9000"], matcherType: "none", enabled: false
}')"; then
  pass "a disabled stream host can be created"
  sleep 2
  t_fails "a disabled stream host opens no listener" \
    bash -c "printf 'QUIT\n' | timeout 4 socat -t2 - TCP:caddy:$DISABLED_PORT"
else
  fail "a disabled stream host can be created" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
fi

api PUT "/api/v1/l4-proxy-hosts/$tcp_host_id" "$(jq -nc --arg l ":$TCP_PORT" '{
  name: "docker-test l4 tcp", protocol: "tcp", listenAddress: $l,
  upstreams: ["origin-tcp:9000"], matcherType: "none", enabled: false
}')"
t_eq "a stream host can be disabled" "200" "$API_STATUS"

if wait_for "the TCP listener to close" 30 \
     bash -c "! printf 'QUIT\n' | timeout 4 socat -t2 - TCP:caddy:$TCP_PORT >/dev/null 2>&1"; then
  pass "disabling a stream host closes its listener"
else
  fail "disabling a stream host closes its listener" "caddy:$TCP_PORT still accepts connections"
fi

# ── Port ranges ─────────────────────────────────────────────────────────────

# One listener per port in the range, all to one fixed upstream.
if create_l4_host "$(jq -nc --arg l ":$RANGE_FIRST-$RANGE_LAST" '{
  name: "docker-test l4 range", protocol: "tcp", listenAddress: $l,
  upstreams: ["origin-tcp:9000"], matcherType: "none"
}')"; then
  pass "a TCP host can listen on a port range"
  if wait_for "Caddy to open the range" 60 \
       bash -c "printf 'QUIT\n' | timeout 5 socat -t2 - TCP:caddy:$RANGE_LAST >/dev/null 2>&1"; then
    for port in "$RANGE_FIRST" "$RANGE_MIDDLE" "$RANGE_LAST"; do
      t_contains "port $port of the range reaches the upstream" "ECHO origin-tcp range-$port" \
        "$(tcp_probe caddy "$port" "range-$port")"
    done
  else
    fail "Caddy opens every port of the range" "nothing accepted a connection on caddy:$RANGE_LAST"
  fi
else
  fail "a TCP host can listen on a port range" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
fi

# "same": each connection dials the port it arrived on, captured from the listener's address.
# origin-tcp answers on 9000 only, so 9001 proves the port is not simply the first one's.
if create_l4_host "$(jq -nc '{
  name: "docker-test l4 same port", protocol: "tcp", listenAddress: ":9000-9001",
  upstreams: ["origin-tcp"], upstreamPortMode: "same", matcherType: "none"
}')"; then
  pass "a range can send each connection to the port it arrived on"
  if wait_for "Caddy to open the same-port range" 60 \
       bash -c "printf 'QUIT\n' | timeout 5 socat -t2 - TCP:caddy:9000 >/dev/null 2>&1"; then
    t_contains "port 9000 reaches origin-tcp:9000" "ECHO origin-tcp same-port" \
      "$(tcp_probe caddy 9000 "same-port")"
    t_not_contains "port 9001 dials origin-tcp:9001, where nothing listens" "ECHO" \
      "$(tcp_probe caddy 9001 "same-port")"
  else
    fail "Caddy opens the same-port range" "nothing accepted a connection on caddy:9000"
  fi
else
  fail "a range can send each connection to the port it arrived on" \
    "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
fi

api POST /api/v1/l4-proxy-hosts '{"name":"range over reserved","protocol":"tcp",
  "listenAddress":":2010-2030","upstreams":["origin-tcp:9000"]}'
t_eq "a range covering Caddy's admin port is refused" "400" "$API_STATUS"

api POST /api/v1/l4-proxy-hosts \
  '{"name":"bad listen","protocol":"tcp","listenAddress":"not-a-port","upstreams":["origin-tcp:9000"]}'
t_ne "a malformed listen address is rejected" "201" "$API_STATUS"

api POST /api/v1/l4-proxy-hosts \
  '{"name":"bad protocol","protocol":"sctp","listenAddress":":19099","upstreams":["origin-tcp:9000"]}'
t_ne "an unsupported protocol is rejected" "201" "$API_STATUS"

api POST /api/v1/l4-proxy-hosts \
  '{"name":"no upstreams","protocol":"tcp","listenAddress":":19098","upstreams":[]}'
t_ne "a stream host with no upstream is rejected" "201" "$API_STATUS"

finish
