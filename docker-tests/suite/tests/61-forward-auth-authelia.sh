#!/usr/bin/env bash
# Forward auth through a real Authelia: its portal is a CPM host (auth.cpm.test), a protected host
# bounces there, the sign-in happens against Authelia's own API, and the identity it vouches for
# reaches the upstream while a client's own copy never does.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "forward auth: Authelia"

PORTAL=$(domain_for "auth")
APP=$(domain_for "authelia-app")
JAR="$STATE_DIR/authelia-cookies.txt"
rm -f "$JAR"

create_host_or_fail "Authelia's portal can be put behind CPM" "$(jq -nc --arg d "$PORTAL" \
  '{name:"docker-test authelia portal", domains:[$d], upstreams:["authelia:9091"]}')" \
  && pass "Authelia's portal can be put behind CPM"

forward_auth() {  # forward_auth [EXTRA_JSON] - the host's forwardAuth block
  jq -nc --argjson x "${1:-{\}}" '{enabled:true, provider:"authelia", authUpstream:"http://authelia:9091",
    excludedPaths:["/public/*"]} + $x'
}
create_host_or_fail "a host behind Authelia can be created" "$(jq -nc --arg d "$APP" --argjson f "$(forward_auth)" \
  '{name:"docker-test authelia app", domains:[$d], upstreams:["origin-a:8080"], forwardAuth:$f}')" \
  && pass "a host behind Authelia can be created"
app_id=$NEW_ID

wait_for_https "$PORTAL" 120
wait_for_https "$APP" 120

# ── Unauthenticated ─────────────────────────────────────────────────────────

fetch "https://$APP/private?x=1"
t_eq "an anonymous request is bounced" "302" "$FETCH_CODE"
t_contains "to Authelia's portal" "https://$PORTAL/" "$(header_value location)"
t_contains "carrying where it was going" "rd=https%3A%2F%2F$APP%2Fprivate" "$(header_value location)"
t_eq "the request never reached the upstream" "0" \
  "$(curl -sS --max-time 10 http://origin-a:8080/__requests | jq '[.[] | select(.raw_path == "/private?x=1" and .headers.host == "'"$APP"'")] | length')"

fetch "https://$APP/public/page" -H 'Remote-User: mallory' -H 'Remote_Groups: admins'
t_eq "an excluded path is served anonymously" "200" "$FETCH_CODE"
t_eq "with a client's Remote-User stripped" "null" "$(fetch_json '.headers["remote-user"]')"
t_eq "in either spelling" "null" "$(fetch_json '.headers["remote_groups"]')"

# ── Signing in through Authelia ─────────────────────────────────────────────

status=$(curl -sS --max-time 20 --cacert "$CA_BUNDLE" -o "$STATE_DIR/authelia-login.json" -w '%{http_code}' \
  -c "$JAR" -b "$JAR" -H 'Content-Type: application/json' -H "Origin: https://$PORTAL" \
  --data-binary "$(jq -nc --arg t "https://$APP/private" \
    '{username:"rigalice", password:"Rig-Authelia-Passw0rd", keepMeLoggedIn:false, targetURL:$t}')" \
  "https://$PORTAL/api/firstfactor")
t_eq "Authelia accepts the user's password" "200" "$status"
t_eq "and sends them back where they were going" "https://$APP/private" \
  "$(jq -r '.data.redirect // empty' "$STATE_DIR/authelia-login.json")"
t_contains "with a session cookie for the whole domain" "cpm.test" "$(grep authelia_session "$JAR")"

fetch "https://$APP/private" -b "$JAR"
t_eq "the signed-in request is served" "200|origin-a" "$FETCH_CODE|$(fetch_json '.origin')"
t_eq "the upstream is told who the user is" "rigalice" "$(fetch_json '.headers["remote-user"]')"
t_eq "and their groups" "admins,rig" "$(fetch_json '.headers["remote-groups"]')"
t_eq "and email" "rigalice@cpm.test" "$(fetch_json '.headers["remote-email"]')"
t_eq "and name" "Rig Alice" "$(fetch_json '.headers["remote-name"]')"

fetch "https://$APP/private" -b "$JAR" -H 'Remote-User: mallory' -H 'Remote_User: mallory'
t_eq "a forged Remote-User is replaced by Authelia's" "rigalice" "$(fetch_json '.headers["remote-user"]')"
t_eq "and its underscore spelling dropped" "null" "$(fetch_json '.headers["remote_user"]')"

# HTTP Basic straight to Authelia, with no session: the client's own credentials are exempt from
# the identity strip, so they reach the upstream - password and all - unless listed as a header
# Authelia vouches for, which it never answers with, so they are dropped.
BASIC="Basic $(printf 'rigalice:Rig-Authelia-Passw0rd' | base64)"
fetch "https://$APP/private" -H "Authorization: $BASIC"
t_eq "Authelia also signs a request in over HTTP Basic" "200|rigalice" "$FETCH_CODE|$(fetch_json '.headers["remote-user"]')"
t_eq "whose Authorization reaches the upstream while not a copied header" "$BASIC" \
  "$(fetch_json '.headers.authorization')"

api PUT "/api/v1/proxy-hosts/$app_id" "$(jq -nc --argjson f "$(forward_auth \
  '{"copyHeaders":["Remote-User","Remote-Groups","Authorization"]}')" '{forwardAuth:$f}')"
t_eq "Authorization can be made a header Authelia vouches for" "200" "$API_STATUS"
stripped() { fetch "https://$APP/private" -H "Authorization: $BASIC" &&
  [ "$(fetch_json '.headers.authorization')" = "null" ]; }
if wait_for "the client's Authorization to be dropped" 30 stripped; then
  pass "then the client's credentials never reach the upstream"
else
  fail "then the client's credentials never reach the upstream" "got $(fetch_json '.headers.authorization')"
fi
t_eq "while the identity still does" "rigalice" "$(fetch_json '.headers["remote-user"]')"
t_eq "and a header no longer listed is not copied" "null" "$(fetch_json '.headers["remote-email"]')"

# ── Signing out ─────────────────────────────────────────────────────────────

curl -sS --max-time 20 --cacert "$CA_BUNDLE" -o /dev/null -c "$JAR" -b "$JAR" -H 'Content-Type: application/json' \
  -H "Origin: https://$PORTAL" --data-binary '{}' "https://$PORTAL/api/logout"
fetch "https://$APP/private" -b "$JAR"
t_eq "after signing out of Authelia the host bounces again" "302" "$FETCH_CODE"

finish
