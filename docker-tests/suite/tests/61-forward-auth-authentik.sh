#!/usr/bin/env bash
# Forward auth through a real Authentik and its embedded outpost. The provider (forward auth, single
# application) and its application are created through Authentik's API with the bootstrapped token;
# Authentik itself is a CPM host (authentik.cpm.test). A sign-in walks the flow executor the way
# Authentik's own login page does, then the outpost's callback, and the X-Authentik-* identity
# reaches the upstream while a client's own copy never does.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "forward auth: Authentik"

AK=http://authentik-server:9000
AK_TOKEN=rig-authentik-api-token-0123456789
IDP=$(domain_for "authentik")
APP=$(domain_for "authentik-app")
JAR="$STATE_DIR/authentik-cookies.txt"
rm -f "$JAR"

ak() {  # ak METHOD PATH [BODY] - Authentik's API with the bootstrap token -> AK_BODY
  AK_BODY=$(curl -sS --max-time 30 -X "$1" -H "Authorization: Bearer $AK_TOKEN" \
    -H 'Content-Type: application/json' ${3:+--data-binary "$3"} "$AK/api/v3$2" 2>/dev/null)
}

ak_ready() { ak GET /root/config/ && printf '%s' "$AK_BODY" | jq -e '.capabilities' >/dev/null; }
if ! wait_for "Authentik's API" 300 ak_ready; then
  fail "Authentik is up" "no answer from $AK"
  finish
fi

# ── Authentik: provider, application, embedded outpost ──────────────────────

flow_pk() { ak GET "/flows/instances/?slug=$1" && printf '%s' "$AK_BODY" | jq -r '.results[0].pk'; }
authz_flow=$(flow_pk default-provider-authorization-implicit-consent)
invalidation_flow=$(flow_pk default-provider-invalidation-flow)

ak GET "/providers/proxy/?name=rig-forward-auth"
provider=$(printf '%s' "$AK_BODY" | jq -r '.results[0].pk // empty')
if [ -z "$provider" ]; then
  ak POST /providers/proxy/ "$(jq -nc --arg h "https://$APP" --arg a "$authz_flow" --arg i "$invalidation_flow" \
    '{name:"rig-forward-auth", mode:"forward_single", external_host:$h, authorization_flow:$a, invalidation_flow:$i}')"
  provider=$(printf '%s' "$AK_BODY" | jq -r '.pk // empty')
fi
ak GET /core/applications/rig-app/
if [ "$(printf '%s' "$AK_BODY" | jq -r '.slug // empty')" != "rig-app" ]; then
  ak POST /core/applications/ "$(jq -nc --argjson p "${provider:-0}" '{name:"Rig App", slug:"rig-app", provider:$p}')"
fi
ak GET "/outposts/instances/?managed__iexact=goauthentik.io%2Foutposts%2Fembedded"
outpost=$(printf '%s' "$AK_BODY" | jq -r '.results[0].pk')
config=$(printf '%s' "$AK_BODY" | jq -c --arg u "https://$IDP" '.results[0].config + {authentik_host:$u, authentik_host_browser:$u}')
ak PATCH "/outposts/instances/$outpost/" "$(jq -nc --argjson p "${provider:-0}" --argjson c "$config" '{providers:[$p], config:$c}')"
t_eq "the embedded outpost serves a forward-auth provider" "$provider" "$(printf '%s' "$AK_BODY" | jq -r '.providers[0]')"

# ── CPM: Authentik behind it, and a host it protects ────────────────────────

create_host_or_fail "Authentik can be put behind CPM" "$(jq -nc --arg d "$IDP" \
  '{name:"docker-test authentik", domains:[$d], upstreams:["authentik-server:9000"]}')" \
  && pass "Authentik can be put behind CPM"
create_host_or_fail "a host behind Authentik can be created" "$(jq -nc --arg d "$APP" '{
    name:"docker-test authentik app", domains:[$d], upstreams:["origin-a:8080"],
    authentik:{enabled:true, outpostDomain:"outpost.goauthentik.io",
               outpostUpstream:"http://authentik-server:9000", excludedPaths:["/public/*"]}}')" \
  && pass "a host behind Authentik can be created"

wait_for_https "$IDP" 120
wait_for_https "$APP" 120

# The outpost picks its providers up on its own schedule.
bounced() { [ "$(http_code "https://$APP/private")" = "302" ]; }
if wait_for "the outpost to know the application" 120 bounced; then
  pass "an anonymous request is bounced"
else
  fail "an anonymous request is bounced" "got $(http_code "https://$APP/private")"
  finish
fi
fetch "https://$APP/private"
t_contains "to Authentik's authorization" "https://$IDP/application/o/authorize/" "$(header_value location)"
t_contains "with the outpost's callback on the host's own domain" \
  "redirect_uri=https%3A%2F%2F$APP%2Foutpost.goauthentik.io%2Fcallback" "$(header_value location)"

fetch "https://$APP/public/page" -H 'X-Authentik-Username: mallory'
t_eq "an excluded path is served anonymously" "200" "$FETCH_CODE"
t_eq "with a client's X-Authentik-Username stripped" "null" "$(fetch_json '.headers["x-authentik-username"]')"

# ── Signing in ──────────────────────────────────────────────────────────────

# get URL - follow redirects with the jar; prints the final URL
get() { curl -sS --max-time 30 --cacert "$CA_BUNDLE" -c "$JAR" -b "$JAR" -L -o /dev/null -w '%{url_effective}' "$1" 2>/dev/null; }
csrf() { awk '$6 == "authentik_csrf" {print $7}' "$JAR" | tail -n1; }
# executor SLUG QUERY [BODY] - one step of a flow, as Authentik's login page takes it
executor() {
  local url="https://$IDP/api/v3/flows/executor/$1/?query=$(printf '%s' "$2" | jq -sRr @uri)"
  # An answer is taken with a redirect back to the executor, which then returns the next challenge.
  if [ -n "${3:-}" ]; then
    curl -sS -L --max-time 30 --cacert "$CA_BUNDLE" -c "$JAR" -b "$JAR" -H 'Content-Type: application/json' \
      -H "X-authentik-CSRF: $(csrf)" -H "Origin: https://$IDP" -H "Referer: https://$IDP/" --data-binary "$3" "$url"
  else
    curl -sS --max-time 30 --cacert "$CA_BUNDLE" -c "$JAR" -b "$JAR" "$url"
  fi
}

landing=$(get "https://$APP/private")
t_contains "the bounce ends on Authentik's login flow" "https://$IDP/if/flow/" "$landing"
flow=$(printf '%s' "$landing" | sed -E 's#.*/if/flow/([^/]+)/.*#\1#')
query=${landing#*\?}

step=$(executor "$flow" "$query")
t_eq "which asks for a username" "ak-stage-identification" "$(printf '%s' "$step" | jq -r '.component')"
step=$(executor "$flow" "$query" '{"component":"ak-stage-identification","uid_field":"akadmin"}')
if [ "$(printf '%s' "$step" | jq -r '.component')" = "ak-stage-password" ]; then
  step=$(executor "$flow" "$query" '{"component":"ak-stage-password","password":"Rig-Authentik-Passw0rd"}')
fi
t_eq "and signs akadmin in" "xak-flow-redirect" "$(printf '%s' "$step" | jq -r '.component')"

# Back to the authorization, whose consent flow ends in the outpost's callback.
next=$(printf '%s' "$step" | jq -r '.to')
[ "${next#/}" != "$next" ] && next="https://$IDP$next"
landing=$(get "$next")
if printf '%s' "$landing" | grep -q "/if/flow/"; then
  flow=$(printf '%s' "$landing" | sed -E 's#.*/if/flow/([^/]+)/.*#\1#')
  step=$(executor "$flow" "${landing#*\?}")
  landing=$(get "$(printf '%s' "$step" | jq -r '.to')")
fi
t_eq "the outpost's callback returns to the page asked for" "https://$APP/private" "$landing"

fetch "https://$APP/private" -b "$JAR"
t_eq "the signed-in request is served" "200|origin-a" "$FETCH_CODE|$(fetch_json '.origin')"
t_eq "the upstream is told the username" "akadmin" "$(fetch_json '.headers["x-authentik-username"]')"
t_eq "and the email" "akadmin@cpm.test" "$(fetch_json '.headers["x-authentik-email"]')"
t_contains "and the groups" "authentik Admins" "$(fetch_json '.headers["x-authentik-groups"]')"
t_matches "and a signed JWT" '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' "$(fetch_json '.headers["x-authentik-jwt"]')"

fetch "https://$APP/private" -b "$JAR" -H 'X-Authentik-Username: mallory' -H 'X_Authentik_Groups: admins'
t_eq "a forged username is replaced by Authentik's" "akadmin" "$(fetch_json '.headers["x-authentik-username"]')"
t_eq "and an underscore spelling dropped" "null" "$(fetch_json '.headers["x_authentik_groups"]')"

# The outpost route drops a client's Authorization before it reaches Authentik.
fetch "https://$APP/outpost.goauthentik.io/auth/caddy" -b "$JAR" -H 'Authorization: Basic YWthZG1pbjp3cm9uZw=='
t_eq "the outpost answers on the host's domain with the session alone" "200" "$FETCH_CODE"

finish
