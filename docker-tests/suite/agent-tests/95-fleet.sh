#!/usr/bin/env bash
# A fleet of two: a second agent paired by six-letter code, with its own Caddy on a network of its
# own (fleet/docker-compose.yml, reached through fleet-gw). A host for every agent is served by
# both, a host pinned to one only by that one, a Caddy that stops is named in the apply failure,
# and unpairing sends the second agent idle, which stops its Caddy.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "fleet: a second agent"

AGENT_PAGE=/settings/agent
AGENT2=cpm-test-agent-2
CADDY2=cpm-test-caddy-2
GW=172.28.0.15

gql_agents() {
  curl -sS --max-time 20 -H "Authorization: Bearer $(cat "$TOKEN_FILE")" -H 'Content-Type: application/json' \
    --data-binary '{"query":"{ agents { id name connected } }"}' "$CPM_API/api/graphql" 2>/dev/null
}
connected_count() { gql_agents | jq '[.data.agents[] | select(.connected)] | length'; }
running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]; }
stopped() { ! running "$1"; }
preview() {  # preview AGENT_ID CODE -> the status
  curl -sS --max-time 15 -o "$STATE_DIR/preview.json" -w '%{http_code}' -H 'Content-Type: application/json' \
    --data-binary "$(jq -nc --arg a "$1" --arg c "$2" '{agentId:$a, code:$c}')" "$CPM_API/api/agent/v1/pair/preview"
}
via_caddy2() { http_code "http://$1/" --resolve "$1:80:$GW"; }   # the status through the second Caddy
via_caddy1() { http_code "http://$1/"; }                         # through the rig's own

agent2_row=
unpair() {
  [ -n "$agent2_row" ] && server_action "$AGENT_PAGE" unpairAgentAction --form-only "agentId=$agent2_row" >/dev/null 2>&1
}
# Its Caddy back first while still paired, or deleting the hosts fails on it; then idle.
trap '[ -n "$agent2_row" ] && docker start "$CADDY2" >/dev/null 2>&1; cleanup_tracked; unpair' EXIT

connected_is() { [ "$(connected_count)" = "$1" ]; }

if ! wait_for "the first agent to be connected" 120 connected_is 1; then
  fail "the first agent is connected" "$(gql_agents)"
  finish
fi
before=$(gql_agents | jq -c '[.data.agents[].id]')
t_ok "the second agent's Caddy starts out stopped, as an unpaired agent leaves it" stopped "$CADDY2"

# ── Pairing by code ─────────────────────────────────────────────────────────

probe_id=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
t_eq "a code that was never issued is refused" "401" "$(preview "$probe_id" ABCDEF)"

server_action "$AGENT_PAGE" pairingCodeAction
code=$(printf '%s' "$ACTION_RESULT" | jq -r '.code')
t_matches "an admin can issue a six-letter code" '^[A-HJ-NP-Z]{6}$' "$code"

t_eq "the preview names the controller for a valid code" "200" "$(preview "$probe_id" "$code")"
t_eq "as a first pairing, not a re-pair" "false" "$(jq -r '.repair' "$STATE_DIR/preview.json")"
t_ne "with the controller's name" "" "$(jq -r '.controllerName // ""' "$STATE_DIR/preview.json")"
t_eq "a lower-case code is the same code" "200" "$(preview "$probe_id" "$(printf '%s' "$code" | tr 'A-Z' 'a-z')")"

pair_out=$(docker exec "$AGENT2" /app/cpm-agent --pair --host web --port 3000 --code "$code" --yes 2>&1)
t_contains "the second agent pairs with it from its own CLI" "Paired with" "$pair_out"
t_eq "the code is spent" "401" "$(preview "$probe_id" "$code")"

if wait_for "two connected agents" 90 connected_is 2; then
  pass "both agents are connected"
else
  fail "both agents are connected" "$(gql_agents)"
  finish
fi
agents=$(gql_agents)
agent2_row=$(printf '%s' "$agents" | jq -r --argjson b "$before" 'first(.data.agents[] | select(.id as $i | $b | index($i) | not)) | .id')
agent2_name=$(printf '%s' "$agents" | jq -r --argjson r "$agent2_row" 'first(.data.agents[] | select(.id == $r)) | .name')
agent1_row=$(printf '%s' "$agents" | jq -r --argjson r "$agent2_row" 'first(.data.agents[] | select(.id != $r)) | .id')

if wait_for "the second agent to start its Caddy" 120 running "$CADDY2"; then
  pass "the second agent starts its own Caddy once paired"
else
  fail "the second agent starts its own Caddy once paired" "$CADDY2 is not running"
  finish
fi

# ── One host, two Caddies; a host pinned to one ─────────────────────────────

shared=$(domain_for "fleet-shared")
create_host_or_fail "a host for every agent can be created" "$(jq -nc --arg d "$shared" \
  '{name:"docker-test fleet shared", domains:[$d], upstreams:["origin-a:8080"], sslForced:false}')" \
  && pass "a host for every agent can be created"
shared_id=$NEW_ID
both() { [ "$(via_caddy1 "$shared")" = "200" ] && [ "$(via_caddy2 "$shared")" = "200" ]; }
if wait_for "both Caddies to serve it" 60 both; then
  pass "it is served by both agents' Caddies"
else
  fail "it is served by both agents' Caddies" "rig: $(via_caddy1 "$shared") second: $(via_caddy2 "$shared")"
fi

pinned=$(domain_for "fleet-pinned")
create_host_or_fail "a host pinned to the second agent can be created" "$(jq -nc --arg d "$pinned" --argjson a "$agent2_row" \
  '{name:"docker-test fleet pinned", domains:[$d], upstreams:["origin-a:8080"], sslForced:false, agentIds:[$a]}')" \
  && pass "a host pinned to the second agent can be created"
pinned_id=$NEW_ID
only2() { [ "$(via_caddy2 "$pinned")" = "200" ]; }
wait_for "the second Caddy to serve the pinned host" 60 only2 && pass "the agent it is pinned to serves it" \
  || fail "the agent it is pinned to serves it" "got $(via_caddy2 "$pinned")"
t_ne "the other does not" "200" "$(via_caddy1 "$pinned")"
t_not_contains "and its Caddy has no route for it" "\"$pinned\"" \
  "$(curl -sS --max-time 10 http://caddy:2019/config/apps/http/servers/cpm/routes)"

api PUT "/api/v1/proxy-hosts/$pinned_id" "$(jq -nc --argjson a "$agent1_row" '{agentIds:[$a]}')"
moved() { [ "$(via_caddy1 "$pinned")" = "200" ] && [ "$(via_caddy2 "$pinned")" != "200" ]; }
wait_for "the host to move to the first agent" 60 moved && pass "re-pinning moves it to the other agent" \
  || fail "re-pinning moves it to the other agent" "rig: $(via_caddy1 "$pinned") second: $(via_caddy2 "$pinned")"

# ── A Caddy that is down ────────────────────────────────────────────────────

docker stop "$CADDY2" >/dev/null 2>&1
wait_for "the second Caddy to stop" 30 stopped "$CADDY2"
# The agent waits out its own timeout on a Caddy that is gone, so give the action longer.
SERVER_ACTION_TIMEOUT=240 server_action /proxy-hosts toggleProxyHostAction --args "[$shared_id, false]"
t_contains "an apply that cannot reach a Caddy names its agent" "$agent2_name" "$ACTION_RESULT"
API_MAX_TIME=240 api POST /api/v1/caddy/apply
t_eq "and fails over REST too" "500" "$API_STATUS"
t_ne "while the rig's own Caddy still took it" "200" "$(via_caddy1 "$shared")"

docker start "$CADDY2" >/dev/null 2>&1
healthy_again() { api POST /api/v1/caddy/apply; [ "$API_STATUS" = "200" ]; }
wait_for "applies to succeed again" 90 healthy_again && pass "with the Caddy back, applies succeed again" \
  || fail "with the Caddy back, applies succeed again" "HTTP $API_STATUS: $(printf '%.200s' "$API_BODY")"

# ── Unpairing ───────────────────────────────────────────────────────────────

server_action "$AGENT_PAGE" unpairAgentAction --form-only "agentId=$agent2_row"
agent2_row_was=$agent2_row
agent2_row=
t_eq "the second agent can be unpaired" "false" \
  "$(gql_agents | jq --argjson r "$agent2_row_was" '[.data.agents[].id] | index($r) != null')"
if wait_for "the unpaired agent to stop its Caddy" 90 stopped "$CADDY2"; then
  pass "unpaired, the agent goes idle and stops its Caddy"
else
  fail "unpaired, the agent goes idle and stops its Caddy" "$CADDY2 is still running"
fi
t_eq "while the first agent stays connected" "1" "$(connected_count)"

finish
