#!/usr/bin/env bash
# REST API authentication and authorisation: bearer tokens, role enforcement,
# the CSRF guard on session-authenticated writes, and token lifecycle.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "API authentication"

# ── Bearer tokens ───────────────────────────────────────────────────────────

with_token "" api_expect "an unauthenticated request is rejected" 401 GET /api/v1/proxy-hosts
with_token "not-a-real-token" api_expect "a bogus bearer token is rejected" 401 GET /api/v1/proxy-hosts
api_expect "the suite's token is accepted" 200 GET /api/v1/proxy-hosts

api GET /api/v1/proxy-hosts
t_eq "the proxy host listing is a JSON array" "array" "$(jqr 'type')"

# ── Token validation ────────────────────────────────────────────────────────
#
# Minting needs a session, so a stolen bearer token cannot mint a replacement
# that survives its own revocation.

api_expect "a bearer token cannot mint another token" 403 POST /api/v1/tokens \
  '{"name":"docker-test-escalation"}'

api_session POST /api/v1/tokens '{}'
t_eq "a token with no name is rejected" "400" "$API_STATUS"

api_session POST /api/v1/tokens '{"name":"expired","expires_at":"2000-01-01T00:00:00.000Z"}'
t_eq "an expiry in the past is rejected" "400" "$API_STATUS"

api_session POST /api/v1/tokens '{"name":"bad-expiry","expires_at":12345}'
t_eq "a non-string expiry is rejected" "400" "$API_STATUS"

api_session POST /api/v1/tokens '{"name":"docker-test-throwaway"}'
t_eq "a token can be minted from a session" "201" "$API_STATUS"
throwaway_id=$(jqr '.token.id')
throwaway_raw=$(jqr '.raw_token')
t_matches "the raw token is 32 bytes of hex" '^[0-9a-f]{64}$' "$throwaway_raw"

with_token "$throwaway_raw" api_expect "the new token authenticates" 200 GET /api/v1/proxy-hosts

# Revocation is not session-only - only creation is.
api DELETE "/api/v1/tokens/$throwaway_id"
t_eq "the token can be revoked" "200" "$API_STATUS"
with_token "$throwaway_raw" api_expect "a revoked token no longer authenticates" 401 GET /api/v1/proxy-hosts

# ── Role enforcement ────────────────────────────────────────────────────────
#
# Reads too: `requireApiAdmin` guards the whole route, not just mutations.

viewer_email="viewer-$$@cpm.test"
viewer_password='V13wer-T3st!Passw0rd'
api POST /api/v1/users "$(jq -nc --arg e "$viewer_email" --arg p "$viewer_password" \
  '{email:$e, name:"Docker Test Viewer", password:$p, role:"viewer"}')"

if [ "$API_STATUS" != "201" ]; then
  fail "a non-admin user can be created" "HTTP $API_STATUS: $(printf '%.200s' "$API_BODY")"
else
  pass "a non-admin user can be created"
  viewer_id=$(jqr '.id')
  track "users/$viewer_id"

  jar="$STATE_DIR/viewer-cookies.txt"; rm -f "$jar"
  signin=$(curl -sS --max-time 15 -o "$STATE_DIR/viewer-signin.json" -w '%{http_code}' \
    -c "$jar" -H 'Content-Type: application/json' -H "Origin: $CPM_API" \
    --data-binary "$(jq -nc --arg e "$viewer_email" --arg p "$viewer_password" \
      '{email:$e, password:$p}')" \
    "$CPM_API/api/auth/sign-in/email")
  t_eq "the non-admin user can sign in" "200" "$signin"

  viewer_token=$(curl -sS --max-time 15 -b "$jar" \
    -H 'Content-Type: application/json' -H "Origin: $CPM_API" \
    --data-binary '{"name":"viewer-token"}' \
    "$CPM_API/api/v1/tokens" | jq -r '.raw_token')

  if [ -z "$viewer_token" ] || [ "$viewer_token" = "null" ]; then
    fail "the non-admin user can mint their own token" "no raw_token in the response"
  else
    pass "the non-admin user can mint their own token"
    with_token "$viewer_token" api_expect "a viewer cannot read proxy hosts" 403 GET /api/v1/proxy-hosts
    with_token "$viewer_token" api_expect "a viewer cannot create proxy hosts" 403 POST /api/v1/proxy-hosts \
      '{"name":"nope","domains":["nope.cpm.test"],"upstreams":["origin-a:8080"]}'
    with_token "$viewer_token" api_expect "a viewer cannot read users" 403 GET /api/v1/users
    with_token "$viewer_token" api_expect "a viewer can still manage their own tokens" 200 GET /api/v1/tokens
  fi
fi

# ── CSRF on session auth ────────────────────────────────────────────────────
#
# Bearer callers are exempt: they carry no ambient credential.

admin_jar="$STATE_DIR/cookies.txt"

no_origin=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' \
  -b "$admin_jar" -H 'Content-Type: application/json' \
  --data-binary '{"name":"csrf-probe"}' "$CPM_API/api/v1/tokens")
t_eq "a session write with no Origin header is refused" "403" "$no_origin"

cross_origin=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' \
  -b "$admin_jar" -H 'Content-Type: application/json' \
  -H 'Origin: https://evil.example' \
  --data-binary '{"name":"csrf-probe"}' "$CPM_API/api/v1/tokens")
t_eq "a session write from a foreign Origin is refused" "403" "$cross_origin"

# Not a token mint, which is session-only anyway. create_host keeps the host on
# the teardown stack: a failed push leaves a row with no id in the reply, which
# would break every later file's config push.
create_host "$(jq -nc --arg d "$(domain_for "bearer-csrf")" '{
  name: "docker-test-bearer-csrf", domains: [$d], upstreams: ["origin-a:8080"]
}')"
t_eq "a bearer write needs no Origin header" "201" "$API_STATUS"

# ── Unknown routes ──────────────────────────────────────────────────────────

api_expect "an unknown settings group is a 404" 404 GET /api/v1/settings/does-not-exist

finish
