#!/usr/bin/env bash
# CrowdSec in external mode against the rig's own LAPI (crowdsec-lapi): decisions made with cscli
# refuse traffic on HTTP and L4 hosts and stop when deleted, a host can opt out, AppSec's virtual
# patching blocks a known probe, and a scenario tripped by Caddy's own access log bans the client.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
. "$(dirname "${BASH_SOURCE[0]}")/../helpers/opt-in-caddy.sh"

banner "crowdsec (external LAPI)"

ensure_opt_in_caddy

LAPI_CONTAINER=cpm-test-crowdsec-lapi
LAPI_URL=http://crowdsec-lapi:8080
APPSEC_URL=http://crowdsec-lapi:7422
# docker-compose.yml registers it as BOUNCER_KEY_caddy.
BOUNCER_KEY=cpm-docker-tests-crowdsec-bouncer-key
L4_PORT=19480
RUN="r$(date +%s)$$"

cscli() { docker exec "$LAPI_CONTAINER" cscli "$@"; }

settings() {  # settings EXTRAS_JSON -> PUT, external mode with a one-second ticker
  api PUT /api/v1/settings/crowdsec "$(jq -nc --arg u "$LAPI_URL" --arg k "$BOUNCER_KEY" \
    --argjson x "${1:-null}" \
    '{enabled: true, mode: "external", apiUrl: $u, apiKey: $k, tickerInterval: "1s"} + $x')"
}

# A banned runner would fail every later file, so whatever happens the decisions go.
teardown() {
  cscli decisions delete --ip "$CLIENT_IP" >/dev/null 2>&1
  api PUT /api/v1/settings/crowdsec '{"enabled":false}' >/dev/null 2>&1
  api PUT /api/v1/settings/logging '{"enabled":false}' >/dev/null 2>&1
  cleanup_tracked
}
trap teardown EXIT

HOST=
host() {  # host SLUG [EXTRAS_JSON] -> HOST, plain HTTP on origin-a, once Caddy has it
  HOST=$(domain_for "$1")
  create_host_or_fail "the $1 host can be created" "$(jq -nc --arg d "$HOST" \
    --argjson x "${2:-null}" '{name: ("docker-test " + $d), domains: [$d],
      upstreams: ["origin-a:8080"], sslForced: false} + $x')" &&
    pass "the $1 host can be created"
  wait_for "$HOST in Caddy's config" 60 in_caddy_config "$HOST"
}

status_is() {  # status_is WANT URL
  [ "$(http_code "$2")" = "$1" ]
}

decision() {  # decision TYPE - for the runner, long enough to outlast the file
  cscli decisions add --ip "$CLIENT_IP" --type "$1" --duration 15m --reason "docker-tests $RUN" \
    >/dev/null 2>&1
}

clear_decisions() { cscli decisions delete --ip "$CLIENT_IP" >/dev/null 2>&1; }

# ── Settings ────────────────────────────────────────────────────────────────

clear_decisions
settings
t_eq "external CrowdSec can be configured over REST" "200" "$API_STATUS" \
  || info "$(printf '%.300s' "$API_BODY")"

api GET /api/v1/settings/crowdsec
t_eq "the settings say a key is stored" "true" "$(jqr '.hasApiKey')"
t_not_contains "the key itself is never returned" "$BOUNCER_KEY" "$API_BODY"
t_eq "nor is a managed key" "null" "$(jqr '.managedApiKey')"

app=$(curl -sS --max-time 5 http://caddy:2019/config/apps/crowdsec 2>/dev/null)
t_eq "Caddy gets the crowdsec app with the LAPI address" "$LAPI_URL" \
  "$(printf '%s' "$app" | jq -r '.api_url')"
t_eq "and the ticker it was given" "1s" "$(printf '%s' "$app" | jq -r '.ticker_interval')"

host crowdsec
guarded=$HOST
host crowdsec-optout '{"crowdsec": false}'
optout=$HOST

t_eq "a host passes while the LAPI has no decision" "200" "$(http_code "http://$guarded/$RUN")"

bouncer_pulled() {
  cscli bouncers list -o json 2>/dev/null \
    | jq -e '.[] | select(.name == "caddy") | .last_pull != null and .last_pull != ""' >/dev/null
}
if wait_for "Caddy's bouncer to pull the decision stream" 30 bouncer_pulled; then
  pass "Caddy's bouncer authenticates to the LAPI with the key"
else
  fail "Caddy's bouncer authenticates to the LAPI with the key" "$(cscli bouncers list 2>&1 | tail -5)"
fi

# ── Ban ─────────────────────────────────────────────────────────────────────

decision ban
if wait_for "the ban to reach Caddy" 30 status_is 403 "http://$guarded/$RUN/ban"; then
  pass "a ban decision refuses the client with 403"
else
  fail "a ban decision refuses the client with 403" "HTTP $(http_code "http://$guarded/$RUN/ban")"
fi
t_eq "a host that opted out still lets the client through" "200" \
  "$(http_code "http://$optout/$RUN/optout")"
t_eq "another client is not refused" "200" "$(from_other_ip "/$RUN/other" "$guarded")"

clear_decisions
if wait_for "the deletion to reach Caddy" 30 status_is 200 "http://$guarded/$RUN/unban"; then
  pass "deleting the decision lets the client back in"
else
  fail "deleting the decision lets the client back in" "HTTP $(http_code "http://$guarded/$RUN/unban")"
fi

# ── Throttle and captcha ────────────────────────────────────────────────────

decision throttle
if wait_for "the throttle to reach Caddy" 30 status_is 429 "http://$guarded/$RUN/throttle"; then
  pass "a throttle decision answers 429"
  fetch "http://$guarded/$RUN/throttle"
  t_matches "with a numeric Retry-After" '^[0-9]+$' "$(header_value retry-after)"
else
  fail "a throttle decision answers 429" "HTTP $(http_code "http://$guarded/$RUN/throttle")"
fi
clear_decisions
wait_for "the throttle to be lifted" 30 status_is 200 "http://$guarded/$RUN/unthrottle"

decision captcha
if wait_for "the captcha decision to reach Caddy" 30 status_is 403 "http://$guarded/$RUN/captcha"; then
  pass "a captcha decision answers 403, since the module has no captcha"
else
  fail "a captcha decision answers 403, since the module has no captcha" \
    "HTTP $(http_code "http://$guarded/$RUN/captcha")"
fi
clear_decisions
wait_for "the captcha to be lifted" 30 status_is 200 "http://$guarded/$RUN/uncaptcha"

# ── L4 ──────────────────────────────────────────────────────────────────────

tcp_probe() {  # tcp_probe MESSAGE -> the echo's reply, empty when the connection was closed
  printf '%s\nQUIT\n' "$1" | timeout 12 socat -t3 - "TCP:caddy:$L4_PORT" 2>/dev/null
}
echoes() { tcp_probe "cs-$RUN" | grep -q "ECHO origin-tcp cs-$RUN"; }
refused() { ! echoes; }

if create_l4_host "$(jq -nc --arg l ":$L4_PORT" '{
  name: "docker-test crowdsec l4", protocol: "tcp", listenAddress: $l,
  upstreams: ["origin-tcp:9000"], matcherType: "none"
}')"; then
  pass "an L4 host with CrowdSec on can be created"
  # The agent recreates Caddy to publish the port first, which takes a while.
  if wait_for "the L4 host to relay" 180 echoes; then
    pass "the L4 host relays while there is no decision"
    decision ban
    if wait_for "the ban to reach the L4 matcher" 30 refused; then
      pass "a banned address has its TCP connection closed"
    else
      fail "a banned address has its TCP connection closed" "reply: $(tcp_probe "cs-$RUN")"
    fi
    clear_decisions
    if wait_for "the L4 host to relay again" 30 echoes; then
      pass "the connection is relayed again once the decision is deleted"
    else
      fail "the connection is relayed again once the decision is deleted" "no echo"
    fi
  else
    fail "the L4 host relays while there is no decision" "reply: $(tcp_probe "cs-$RUN")"
  fi
else
  fail "an L4 host with CrowdSec on can be created" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
fi

# ── AppSec ──────────────────────────────────────────────────────────────────

t_eq "without AppSec a .env request is proxied like any other" "200" \
  "$(http_code "http://$guarded/$RUN/before/.env")"

# A new address to send the key to, so the key has to come with it (keepStoredCrowdSecKey).
api PUT /api/v1/settings/crowdsec "$(jq -nc --arg u "$LAPI_URL" --arg a "$APPSEC_URL" \
  '{enabled: true, mode: "external", apiUrl: $u, apiKey: "", appsecUrl: $a, tickerInterval: "1s"}')"
t_eq "a new AppSec address without the key is refused" "400" "$API_STATUS"

settings "$(jq -nc --arg a "$APPSEC_URL" '{appsecUrl: $a}')"
t_eq "AppSec can be switched on with the key" "200" "$API_STATUS"
appsec_on() {
  curl -sS --max-time 5 http://caddy:2019/config/apps/crowdsec 2>/dev/null \
    | jq -e --arg a "$APPSEC_URL" '.appsec_url == $a' >/dev/null
}
wait_for "Caddy to get the AppSec address" 30 appsec_on

# crowdsecurity/vpatch-env-access, an in-band rule of crowdsecurity/appsec-default: URI ending .env.
fetch "http://$guarded/$RUN/.env"
t_eq "AppSec's virtual patching refuses a request for a .env file" "403" "$FETCH_CODE"
t_eq "an ordinary request still passes AppSec" "200" "$(http_code "http://$guarded/$RUN/page")"
t_eq "a host that opted out is not sent to AppSec" "200" "$(http_code "http://$optout/$RUN/.env")"
env_seen=$(curl -sS --max-time 10 "http://origin-a:8080/__requests" 2>/dev/null \
  | jq -r --arg n "$guarded" --arg p "/$RUN/.env" \
    '[.[] | select(.headers.host == $n and .raw_path == $p)] | length')
t_eq "the refused .env request never reached the origin" "0" "$env_seen"

settings
wait_for "AppSec to be switched off" 30 bash -c '! curl -sS --max-time 5 http://caddy:2019/config/apps/crowdsec | grep -q appsec_url'

# ── A scenario from Caddy's access log ──────────────────────────────────────

# External mode leaves the log to the operator: this is the setting they would turn on.
api PUT /api/v1/settings/logging '{"enabled":true,"format":"json"}'
t_eq "the JSON access log can be switched on" "200" "$API_STATUS"
logging_on() {
  curl -sS --max-time 5 http://caddy:2019/config/logging/logs/http_access 2>/dev/null \
    | jq -e '.writer.filename == "/logs/access.log"' >/dev/null
}
wait_for "Caddy to write the access log" 30 logging_on

# crowdsecurity/http-sensitive-files: 4 distinct requests ending in a listed suffix, leaking one per
# 5s; six in a row overflow it.
for file in dump.sql backup.sql.gz db.sql.zip .bash_history .bashrc .env.local; do
  http_code "http://$optout/$RUN/$file" >/dev/null
done

banned_by_scenario() {
  cscli decisions list --ip "$CLIENT_IP" -o json 2>/dev/null \
    | jq -e '[.[]?.decisions[]? | select(.scenario == "crowdsecurity/http-sensitive-files")] | length > 0' \
      >/dev/null
}
if wait_for "CrowdSec to ban the client from the access log" 60 banned_by_scenario; then
  pass "Caddy's access log trips crowdsecurity/http-sensitive-files for the client's address"
  if wait_for "the scenario's ban to reach Caddy" 30 status_is 403 "http://$guarded/$RUN/after-scan"; then
    pass "the bouncer then refuses the scanning client"
  else
    fail "the bouncer then refuses the scanning client" \
      "HTTP $(http_code "http://$guarded/$RUN/after-scan")"
  fi
else
  fail "Caddy's access log trips crowdsecurity/http-sensitive-files for the client's address" \
    "$(cscli alerts list 2>&1 | tail -5)"
fi
clear_decisions
wait_for "the scenario's ban to be lifted" 30 status_is 200 "http://$guarded/$RUN/done"

finish
