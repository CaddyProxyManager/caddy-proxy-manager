#!/usr/bin/env bash
# The GraphQL API at /api/graphql with an API token: proxy hosts, access lists, certificates and
# settings driven through it and checked against what Caddy serves, then who may call it - no
# token, a bad one, a viewer's, a session from another origin - and introspection behind auth.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "GraphQL API"

GQL_STATUS=; GQL_BODY=
# gql QUERY [VARIABLES_JSON] -> GQL_STATUS, GQL_BODY; with the suite's token unless API_TOKEN is set
gql() {
  local token="${API_TOKEN-$(cat "$TOKEN_FILE" 2>/dev/null)}" out="$STATE_DIR/gql.$$"
  local args=(-sS --max-time 60 -o "$out" -w '%{http_code}' -H 'Content-Type: application/json')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  GQL_STATUS=$(curl "${args[@]}" --data-binary "$(jq -nc --arg q "$1" --argjson v "${2:-{\}}" \
    '{query:$q, variables:$v}')" "$CPM_API/api/graphql" 2>/dev/null) || GQL_STATUS=000
  GQL_BODY=$(cat "$out" 2>/dev/null); rm -f "$out"
}
gqr() { printf '%s' "$GQL_BODY" | jq -r "$@" 2>/dev/null; }

restore() { gql 'mutation { saveSettings(group: "logging", input: {enabled: false}) }' >/dev/null 2>&1; }
trap 'cleanup_tracked; restore' EXIT

# ── Proxy hosts ─────────────────────────────────────────────────────────────

domain=$(domain_for "graphql")
gql 'mutation($in: JSON!) { createProxyHost(input: $in) { id name domains enabled config } }' \
  "$(jq -nc --arg d "$domain" '{in: {name: "docker-test graphql", domains: [$d], upstreams: ["origin-a:8080"]}}')"
host_id=$(gqr '.data.createProxyHost.id')
if [ -n "$host_id" ] && [ "$host_id" != "null" ]; then
  pass "a proxy host can be created through GraphQL"
  track "proxy-hosts/$host_id"
else
  fail "a proxy host can be created through GraphQL" "HTTP $GQL_STATUS: $(printf '%.300s' "$GQL_BODY")"
  finish
fi
t_eq "it comes back as created" "$domain|true" "$(gqr '.data.createProxyHost | "\(.domains[0])|\(.enabled)"')"

wait_for_https "$domain" 120
fetch "https://$domain/"
t_eq "Caddy serves it" "200|origin-a" "$FETCH_CODE|$(fetch_json '.origin')"

gql 'query($id: Int!) { proxyHost(id: $id) { name upstreams } proxyHosts { id } }' "{\"id\":$host_id}"
t_eq "it can be read by id" "origin-a:8080" "$(gqr '.data.proxyHost.upstreams[0]')"
t_eq "and is in the listing" "true" "$(gqr --argjson i "$host_id" '[.data.proxyHosts[].id] | index($i) != null')"

gql 'mutation($id: Int!, $in: JSON!) { updateProxyHost(id: $id, input: $in) { upstreams } }' \
  "{\"id\":$host_id,\"in\":{\"upstreams\":[\"origin-b:8080\"]}}"
t_eq "it can be updated" "origin-b:8080" "$(gqr '.data.updateProxyHost.upstreams[0]')"
moved() { fetch "https://$domain/" && [ "$(fetch_json '.origin')" = "origin-b" ]; }
wait_for "the update to reach Caddy" 30 moved && pass "Caddy follows the update" \
  || fail "Caddy follows the update" "still $(fetch_json '.origin')"

# ── Access lists ────────────────────────────────────────────────────────────

gql 'mutation($in: JSON!) { createAccessList(input: $in) { id entries { username } } }' \
  '{"in":{"name":"docker-test graphql list","users":[{"username":"gql","password":"gql-secret-1"}]}}'
list_id=$(gqr '.data.createAccessList.id')
[ -n "$list_id" ] && [ "$list_id" != "null" ] && track "access-lists/$list_id"
t_eq "an access list can be created" "gql" "$(gqr '.data.createAccessList.entries[0].username')"
gql 'mutation($id: Int!, $in: JSON!) { updateProxyHost(id: $id, input: $in) { accessListId } }' \
  "{\"id\":$host_id,\"in\":{\"accessListId\":${list_id:-null}}}"
t_eq "and attached to the host" "$list_id" "$(gqr '.data.updateProxyHost.accessListId')"
challenged() { [ "$(http_code "https://$domain/")" = "401" ]; }
wait_for "the access list to reach Caddy" 30 challenged && pass "Caddy now asks for credentials" \
  || fail "Caddy now asks for credentials" "got $(http_code "https://$domain/")"
t_eq "which the list's user has" "200" "$(http_code "https://$domain/" -u gql:gql-secret-1)"
gql '{ accessLists { name entries { username } } }'
t_not_contains "passwords never come back" "gql-secret-1" "$GQL_BODY"

# ── Certificates, settings, the apply ───────────────────────────────────────

gql '{ certificates { id name type domainNames } caCertificates { id } }'
t_eq "certificates can be listed" "array" "$(gqr '.data.certificates | type')"

gql '{ s: settings(group: "general") }'
t_eq "a settings group can be read" "$TEST_DOMAIN" "$(gqr '.data.s.defaultDomain')"
gql 'mutation { saveSettings(group: "logging", input: {enabled: true, format: "json"}) }'
t_eq "a settings group can be saved" "json" "$(gqr '.data.saveSettings.format')"
api GET /api/v1/settings/logging
t_eq "REST reads what GraphQL saved" "true|json" "$(jqr '"\(.enabled)|\(.format)"')"
gql 'mutation { saveSettings(group: "no-such-group", input: {}) }'
t_ne "an unknown group is an error" "null" "$(gqr '.errors[0].message')"

gql 'mutation { applyCaddyConfig }'
t_eq "the config can be re-applied" "true" "$(gqr '.data.applyCaddyConfig')"

gql 'mutation($id: Int!) { deleteProxyHost(id: $id) }' "{\"id\":$host_id}"
t_eq "the host can be deleted" "true" "$(gqr '.data.deleteProxyHost')"
gone() { [ "$(http_code "https://$domain/")" != "401" ]; }
wait_for "the host to leave Caddy" 30 gone && pass "Caddy stops serving it" || fail "Caddy stops serving it" "still 401"

# ── Who may call it ─────────────────────────────────────────────────────────

with_token "" gql '{ proxyHosts { id } }'
t_eq "no token gets no data" "null" "$(gqr '.data')"
t_contains "and an error saying so" "nauthorized" "$(gqr '.errors[0].message')"
with_token "not-a-token" gql '{ proxyHosts { id } }'
t_ne "a bad token gets an error" "null" "$(gqr '.errors[0].message')"
with_token "" gql '{ __schema { queryType { name } } }'
t_eq "introspection needs a token too" "null" "$(gqr '.data.__schema // null')"

gql 'mutation { createApiToken(input: {name: "escalation"}) { secret } }'
t_contains "a token cannot mint another" "session" "$(gqr '.errors[0].message')"

viewer_email="gql-viewer-$$@cpm.test" viewer_password='V13wer-GraphQL!Passw0rd'
if create_resource users "$(jq -nc --arg e "$viewer_email" --arg p "$viewer_password" \
     '{email:$e, name:"GraphQL Viewer", password:$p, role:"viewer"}')"; then
  jar="$STATE_DIR/gql-viewer.txt"; rm -f "$jar"
  curl -sS --max-time 15 -o /dev/null -c "$jar" -H 'Content-Type: application/json' -H "Origin: $CPM_API" \
    --data-binary "$(jq -nc --arg e "$viewer_email" --arg p "$viewer_password" '{email:$e, password:$p}')" \
    "$CPM_API/api/auth/sign-in/email"
  viewer_token=$(cpm_mint_token "$CPM_API" "$jar" gql-viewer)
  with_token "$viewer_token" gql '{ proxyHosts { id } }'
  t_eq "a viewer's token cannot read hosts" "Administrator privileges required" "$(gqr '.errors[0].message')"
  with_token "$viewer_token" gql 'mutation { applyCaddyConfig }'
  t_eq "nor apply the config" "Administrator privileges required" "$(gqr '.errors[0].message')"
  with_token "$viewer_token" gql '{ apiTokens { name } }'
  t_eq "but can list its own tokens" "gql-viewer" "$(gqr '.data.apiTokens[0].name')"
else
  fail "a viewer can be created" "HTTP $API_STATUS"
fi

cross=$(curl -sS --max-time 15 -b "$STATE_DIR/cookies.txt" -H 'Content-Type: application/json' \
  -H 'Origin: https://evil.example' --data-binary '{"query":"{ proxyHosts { id } }"}' "$CPM_API/api/graphql")
t_eq "a session from another origin is refused" "null" "$(printf '%s' "$cross" | jq -r '.data')"
same=$(curl -sS --max-time 15 -b "$STATE_DIR/cookies.txt" -H 'Content-Type: application/json' \
  -H "Origin: $CPM_API" --data-binary '{"query":"{ proxyHosts { id } }"}' "$CPM_API/api/graphql")
t_eq "while the dashboard's own session works" "array" "$(printf '%s' "$same" | jq -r '.data.proxyHosts | type')"

finish
