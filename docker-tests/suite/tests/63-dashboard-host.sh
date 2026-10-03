#!/usr/bin/env bash
# The dashboard served through Caddy on a domain of its own, over a certificate from Pebble:
# Settings → Dashboard Host saved and applied through its actions, the login page and a sign-in on
# that domain, the host options it was given reaching the response, and switching it off again.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "dashboard host"

PAGE=/settings/dashboard
DASH=$(domain_for "dash")
JAR="$STATE_DIR/dash-cookies.txt"
rm -f "$JAR"

# save_dashboard [FIELD=VALUE...] - stage and apply Settings → Dashboard Host
save_dashboard() {
  server_action "$PAGE" updateDashboardSettingsAction --form "$@" &&
    server_action "$PAGE" applyStagedSettingsAction &&
    [ "$(printf '%s' "$ACTION_RESULT" | jq -r '.success')" = "true" ]
}

trap 'save_dashboard "domain=$DASH" >/dev/null 2>&1; cleanup_tracked' EXIT

if save_dashboard enabled=on tls=on "domain=$DASH" dashboardOptionsPresent=on \
     discourageIndexingPresent=on discourageIndexing=on \
     'customPreHandlersJson=[{"handler":"headers","response":{"set":{"X-Rig-Dashboard":["through-caddy"]}}}]'; then
  pass "the dashboard host can be saved and applied"
else
  fail "the dashboard host can be saved and applied" "$(printf '%.300s' "$ACTION_RESULT")"
fi

route=$(curl -sS --max-time 10 http://caddy:2019/config/apps/http/servers/cpm/routes 2>/dev/null \
  | jq -c --arg d "$DASH" '[.[] | select(.match[0].host // [] | index($d))]')
t_contains "Caddy proxies its domain to the controller" '"dial":"web:3000"' "$route"

if wait_for_https "$DASH" 120; then
  pass "the dashboard domain gets a certificate from Pebble"
else
  fail "the dashboard domain gets a certificate from Pebble" "no usable certificate for $DASH"
  finish
fi

fetch "https://$DASH/login"
t_eq "the login page is served on the dashboard domain" "200" "$FETCH_CODE"
t_contains "and is the dashboard's" "CPM Docker Test" "$FETCH_BODY"
t_eq "with the host's own pre-handler applied" "through-caddy" "$(header_value x-rig-dashboard)"
t_contains "and its discourage-indexing option" "noindex" "$(header_value x-robots-tag)"
t_contains "and HSTS, since it is served over TLS" "max-age=" "$(header_value strict-transport-security)"

t_eq "plain HTTP is redirected to HTTPS" "308" "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "http://$DASH/login")"

# A sign-in through the dashboard's own origin, which the auth layer must trust.
status=$(curl -sS --max-time 15 --cacert "$CA_BUNDLE" -o /dev/null -w '%{http_code}' -c "$JAR" \
  -H 'Content-Type: application/json' -H "Origin: https://$DASH" \
  --data-binary "$(jq -nc --arg u "$CPM_ADMIN_USER" --arg p "$CPM_ADMIN_PASSWORD" '{username:$u, password:$p}')" \
  "https://$DASH/api/auth/sign-in/username")
t_eq "an administrator can sign in on the dashboard domain" "200" "$status"
t_eq "and the session works there" "200" "$(http_code "https://$DASH/api/v1/proxy-hosts" -b "$JAR")"

# ── Off again ───────────────────────────────────────────────────────────────

if save_dashboard "domain=$DASH"; then
  pass "the dashboard host can be switched off"
else
  fail "the dashboard host can be switched off" "$(printf '%.300s' "$ACTION_RESULT")"
fi
gone() { ! curl -sS --max-time 10 http://caddy:2019/config/apps/http/servers/cpm/routes | grep -q "\"$DASH\""; }
if wait_for "the dashboard route to leave Caddy" 30 gone; then
  pass "its route is removed"
else
  fail "its route is removed" "$DASH is still in Caddy's routes"
fi
t_ne "and the domain no longer reaches the dashboard" "200" "$(http_code "https://$DASH/login")"

finish
