#!/usr/bin/env bash
# Per-host tailnet listeners through caddy-tailscale, with Headscale as the control server. Caddy
# joins the tailnet as its own node; the runner reaches it only through `tsclient`, a tailnet client
# whose SOCKS5 server dials over the tailnet, at the address Headscale gave the node.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "Tailscale"

AUTHKEY=$(cat /tailnet-keys/authkey 2>/dev/null)
CONTROL=http://headscale:8080
NODE="rig$(date +%s | tail -c 5)"
SOCKS=tsclient:1055

# The runner has no Docker API in this phase, so "stopping" the control server means killing the
# runner's own forwarder to Headscale: Caddy then finds nothing at the control URL it was given.
FWD_PORT=18080
FWD_CONTROL="http://$CLIENT_IP:$FWD_PORT"
start_control() {
  socat "TCP-LISTEN:$FWD_PORT,fork,reuseaddr" TCP:headscale:8080 >/dev/null 2>&1 &
  wait_for "the control forwarder" 10 nc -z 127.0.0.1 "$FWD_PORT"
}
# -f takes the forked children too, and with them the nodes' open control streams.
stop_control() { pkill -f "TCP-LISTEN:$FWD_PORT" 2>/dev/null; ! nc -z 127.0.0.1 "$FWD_PORT"; }

tailscale_settings() {  # tailscale_settings ENABLED [AUTHKEY] [CONTROL_URL] [HTTP3]
  jq -nc --argjson e "$1" --arg k "${2-$AUTHKEY}" --arg c "${3:-$CONTROL}" --argjson h "${4:-false}" \
    '{enabled: $e, authKey: $k, controlUrl: $c, ephemeral: true, stateDir: "/data/tailscale",
      tags: [], defaultNode: "caddy", http3: $h}'
}

restore() { api PUT /api/v1/settings/tailscale "$(tailscale_settings false "")" >/dev/null 2>&1; }
# Tailscale off before the hosts go: each delete is a config load, which must not wait on a node.
trap 'stop_control; restore; cleanup_tracked' EXIT

NODE_IP=
node_ip() {  # node_ip [NAME] - a node's tailnet address, from Headscale's API
  NODE_IP=$(curl -sS --max-time 5 -H "Authorization: Bearer $(cat /tailnet-keys/apikey)" \
    http://headscale:8080/api/v1/node 2>/dev/null | jq -r --arg n "${1:-$NODE}" \
    'first(.nodes[] | select(.givenName == $n or .name == $n) | .ipAddresses[] | select(startswith("100.")))')
  [ -n "$NODE_IP" ] && [ "$NODE_IP" != "null" ]
}

caddy_config() { curl -sS --max-time 5 http://caddy:2019/config/ 2>/dev/null; }

# over_tailnet URL [curl args] - the status of an http:// URL, dialled at Caddy's node over the
# tailnet; the body lands in $STATE_DIR/ts-body
over_tailnet() {
  local url="$1" host; shift
  host=$(printf '%s' "$url" | sed -E 's#^http://([^/:]+).*#\1#')
  curl -sS --max-time 20 -o "$STATE_DIR/ts-body" -w '%{http_code}' --socks5 "$SOCKS" \
    --connect-to "$host:80:$NODE_IP:80" "$@" "$url" 2>/dev/null
}

if [ -z "$AUTHKEY" ]; then
  fail "Headscale left a pre-auth key" "/tailnet-keys/authkey is empty"
  finish
fi

domain=$(domain_for "tailnet-only")
create_host "$(jq -nc --arg d "$domain" --arg n "$NODE" \
  '{name:"docker-test tailscale refused", domains:[$d], upstreams:["origin-a:8080"],
    tailscale:{serve:true, node:$n}}')"
t_eq "a tailnet host is refused while no auth key is stored" "400" "$API_STATUS"

api_expect "Tailscale can be enabled with a Headscale control URL" 200 \
  PUT /api/v1/settings/tailscale "$(tailscale_settings true)"
api GET /api/v1/settings/tailscale
t_eq "the auth key reads back only as present" "true" "$(jqr '.hasAuthKey')"
t_not_contains "and never as itself" "$AUTHKEY" "$API_BODY"

create_host_or_fail "a tailnet-only host can be created" "$(jq -nc --arg d "$domain" --arg n "$NODE" \
  '{name:"docker-test tailscale", domains:[$d], upstreams:["origin-a:8080"], sslForced:false,
    tailscale:{serve:true, node:$n, tailnetOnly:true, auth:true, forwardIdentity:true}}')" \
  && pass "a tailnet-only host can be created"

config=$(curl -sS --max-time 10 http://caddy:2019/config/ 2>/dev/null)
t_eq "Caddy gets a server listening on the node" "tailscale/$NODE:80 tailscale/$NODE:443" \
  "$(printf '%s' "$config" | jq -r --arg n "cpm_tailscale_$NODE" '.apps.http.servers[$n].listen | join(" ")')"
t_eq "joining through Headscale" "$CONTROL" "$(printf '%s' "$config" | jq -r '.apps.tailscale.control_url')"
t_not_contains "the host is left off the public server" "\"$domain\"" \
  "$(printf '%s' "$config" | jq -c '.apps.http.servers.cpm // {}')"

if wait_for "Caddy's node to join through Headscale" 90 node_ip; then
  pass "Caddy's node joins the tailnet through Headscale"
else
  fail "Caddy's node joins the tailnet through Headscale" "no node named $NODE"
  finish
fi

tailnet_ready() { [ "$(over_tailnet "http://$domain/")" = "200" ]; }
if wait_for "Caddy's node to answer on the tailnet" 120 tailnet_ready; then
  pass "the host is served on the tailnet"
else
  fail "the host is served on the tailnet" "last status $(over_tailnet "http://$domain/")"
  finish
fi
body=$(cat "$STATE_DIR/ts-body")
t_eq "by its upstream" "origin-a" "$(printf '%s' "$body" | jq -r '.origin')"
t_eq "which is told the tailnet user" "rig" "$(printf '%s' "$body" | jq -r '.headers["x-tailscale-user"] // empty' | sed 's/@.*//')"

over_tailnet "http://$domain/" -H 'X-Tailscale-User: mallory@evil.example' >/dev/null
t_ne "a client cannot supply its own tailnet identity" "mallory@evil.example" \
  "$(jq -r '.headers["x-tailscale-user"] // empty' "$STATE_DIR/ts-body")"

t_ne "it is not served off the tailnet" "200" "$(http_code "http://$domain/")"

# ── HTTP/3 and an unreachable control server ────────────────────────────────
# An h3 listener brings its node up inside Caddy's config load, which then waits on the control
# server for as long as it is gone - holding Caddy's admin API the whole time.

t_eq "a tailnet server leaves HTTP/3 out by default" '["h1","h2"]' \
  "$(caddy_config | jq -c --arg n "cpm_tailscale_$NODE" '.apps.http.servers[$n].protocols')"
public_protocols=$(caddy_config | jq -c '.apps.http.servers.cpm.protocols')

NODE_B="${NODE}b"
if start_control; then
  pass "a forwarder to Headscale stands in for the control server"
else
  fail "a forwarder to Headscale stands in for the control server" "nothing on :$FWD_PORT"
  finish
fi
api_expect "the control URL can point at it" 200 \
  PUT /api/v1/settings/tailscale "$(tailscale_settings true "$AUTHKEY" "$FWD_CONTROL")"
domain_b=$(domain_for "tailnet-b")
create_host_or_fail "a host on a second node can be created" "$(jq -nc --arg d "$domain_b" --arg n "$NODE_B" \
  '{name:"docker-test tailscale b", domains:[$d], upstreams:["origin-a:8080"], sslForced:false,
    tailscale:{serve:true, node:$n, tailnetOnly:true}}')" \
  && pass "a host on a second node can be created"
# Otherwise the stop below could prove nothing: this is the path that has to go away.
if wait_for "the second node to join through the forwarder" 90 node_ip "$NODE_B"; then
  pass "a node joins through the forwarded control server"
else
  fail "a node joins through the forwarded control server" "no node named $NODE_B"
fi

if stop_control; then
  pass "the control server is stopped"
else
  fail "the control server is stopped" ":$FWD_PORT still answers"
fi

# A node never registered cannot come up without the control server, whatever is on disk.
NODE_C="${NODE}c"
domain_c=$(domain_for "tailnet-c")
started=$(date +%s)
create_host "$(jq -nc --arg d "$domain_c" --arg n "$NODE_C" \
  '{name:"docker-test tailscale c", domains:[$d], upstreams:["origin-a:8080"], sslForced:false,
    tailscale:{serve:true, node:$n, tailnetOnly:true}}')"
elapsed=$(( $(date +%s) - started ))
t_matches "a new tailnet host still applies with the control server stopped" '^20[01]$' "$API_STATUS"
if [ "$elapsed" -le 20 ]; then
  pass "and the config load does not wait on the control server"
else
  fail "and the config load does not wait on the control server" "took ${elapsed}s"
fi
admin_started=$(date +%s)
config=$(caddy_config)
t_ne "Caddy's admin API still answers" "" "$config"
t_eq "and at once" "1" "$(( $(date +%s) - admin_started <= 5 ))"
t_eq "the new node's server is loaded without HTTP/3" '["h1","h2"]' \
  "$(printf '%s' "$config" | jq -c --arg n "cpm_tailscale_$NODE_C" '.apps.http.servers[$n].protocols')"

# Opted in with the control server back, so the load that brings the nodes up can finish.
if start_control; then
  pass "the control server is started again"
else
  fail "the control server is started again" "nothing on :$FWD_PORT"
fi
api_expect "HTTP/3 on tailnet listeners can be turned on" 200 \
  PUT /api/v1/settings/tailscale "$(tailscale_settings true "$AUTHKEY" "$FWD_CONTROL" true)"
api GET /api/v1/settings/tailscale
t_eq "and reads back" "true" "$(jqr '.http3')"
config=$(caddy_config)
# No `protocols` is Caddy's own default, h3 included.
t_eq "the tailnet servers then keep HTTP/3" "null null" \
  "$(printf '%s' "$config" | jq -r --arg a "cpm_tailscale_$NODE" --arg c "cpm_tailscale_$NODE_C" \
    '[.apps.http.servers[$a].protocols, .apps.http.servers[$c].protocols] | map(tostring) | join(" ")')"
t_eq "and the public server is untouched" "$public_protocols" \
  "$(printf '%s' "$config" | jq -c '.apps.http.servers.cpm.protocols')"

finish
