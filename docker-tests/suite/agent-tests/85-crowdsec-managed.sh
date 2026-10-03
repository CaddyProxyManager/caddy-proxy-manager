#!/usr/bin/env bash
# CrowdSec in managed mode: the bundled agent starts the `crowdsec` Compose profile with the key the
# controller generated, Caddy bounces against it, the online API stays off, and switching back to
# external stops the container again.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
. "$(dirname "${BASH_SOURCE[0]}")/../helpers/opt-in-caddy.sh"

banner "crowdsec (managed by the agent)"

ensure_opt_in_caddy

MANAGED_CONTAINER=cpm-test-crowdsec
MANAGED_URL=http://cpm-crowdsec:8080
LAPI_URL=http://crowdsec-lapi:8080
BOUNCER_KEY=cpm-docker-tests-crowdsec-bouncer-key
RUN="r$(date +%s)$$"

cscli() { docker exec "$MANAGED_CONTAINER" cscli "$@"; }
container() { docker inspect -f "$1" "$MANAGED_CONTAINER" 2>/dev/null; }
crowdsec_app() { curl -sS --max-time 5 http://caddy:2019/config/apps/crowdsec 2>/dev/null; }
status_is() { [ "$(http_code "$2")" = "$1" ]; }

teardown() {
  cscli decisions delete --ip "$CLIENT_IP" >/dev/null 2>&1
  api PUT /api/v1/settings/crowdsec '{"enabled":false}' >/dev/null 2>&1
  cleanup_tracked
}
trap teardown EXIT

# The access log must be forced on by managed mode alone, not left over from another file.
api PUT /api/v1/settings/logging '{"enabled":false}'

guarded=$(domain_for "crowdsec-managed")
create_host_or_fail "a host can be created" "$(jq -nc --arg d "$guarded" '{
  name: "docker-test crowdsec managed", domains: [$d], upstreams: ["origin-a:8080"],
  sslForced: false
}')" && pass "a host can be created"
wait_for "$guarded in Caddy's config" 60 in_caddy_config "$guarded"

# ── Switching to managed starts the container ───────────────────────────────

api PUT /api/v1/settings/crowdsec '{"enabled":true,"mode":"managed","tickerInterval":"1s"}'
t_eq "managed mode can be switched on over REST" "200" "$API_STATUS" \
  || info "$(printf '%.300s' "$API_BODY")"

healthy() { [ "$(container '{{.State.Health.Status}}')" = "healthy" ]; }
if wait_for "the agent to start the managed container" 240 healthy; then
  pass "the agent starts the crowdsec profile's container, and it becomes healthy"
else
  fail "the agent starts the crowdsec profile's container, and it becomes healthy" \
    "state: $(container '{{.State.Status}} {{.State.Health.Status}}')"
  finish
fi
t_eq "it belongs to the rig's Compose project" "cpm-docker-tests" \
  "$(container '{{index .Config.Labels "com.docker.compose.project"}}')"

env_of() { container '{{range .Config.Env}}{{println .}}{{end}}' | sed -n "s/^$1=//p"; }
key=$(env_of BOUNCER_KEY_caddy)
t_matches "the container is handed a generated bouncer key" '^[0-9a-f]{64}$' "$key"
t_eq "and the online API switched off" "true" "$(env_of DISABLE_ONLINE_API)"

managed_app() { crowdsec_app | jq -e --arg u "$MANAGED_URL" '.api_url == $u' >/dev/null; }
wait_for "Caddy to point at the managed LAPI" 60 managed_app
app=$(crowdsec_app)
t_eq "Caddy's crowdsec app points at the managed LAPI" "$MANAGED_URL" \
  "$(printf '%s' "$app" | jq -r '.api_url')"
t_eq "with the same key the container registered" "$key" "$(printf '%s' "$app" | jq -r '.api_key')"

api GET /api/v1/settings/crowdsec
t_eq "the settings report managed mode" "managed" "$(jqr '.mode')"
t_not_contains "the generated key is never returned" "${key:-no-key}" "$API_BODY"

t_eq "managed mode writes the access log the container reads, logging setting or not" \
  "/logs/access.log" \
  "$(curl -sS --max-time 5 http://caddy:2019/config/logging/logs/http_access | jq -r '.writer.filename')"

# ── The online API is off ───────────────────────────────────────────────────

capi=$(cscli capi status 2>&1)
t_fails "cscli capi status finds no Central API to talk to" cscli capi status
t_eq "the config has no online_client" "null" \
  "$(docker exec "$MANAGED_CONTAINER" sh -c "cscli config show-yaml | yq e '.api.server.online_client' -" 2>/dev/null)"
info "capi status: $(printf '%.160s' "$capi")"

# ── Decisions in the managed LAPI refuse traffic ────────────────────────────

bouncer_pulled() {
  cscli bouncers list -o json 2>/dev/null \
    | jq -e '.[] | select(.name == "caddy") | .last_pull != null and .last_pull != ""' >/dev/null
}
if wait_for "Caddy's bouncer to pull from the managed LAPI" 30 bouncer_pulled; then
  pass "Caddy's bouncer authenticates to the managed LAPI"
else
  fail "Caddy's bouncer authenticates to the managed LAPI" "$(cscli bouncers list 2>&1 | tail -5)"
fi

t_eq "the host passes with no decision" "200" "$(http_code "http://$guarded/$RUN")"
cscli decisions add --ip "$CLIENT_IP" --type ban --duration 15m --reason "docker-tests $RUN" \
  >/dev/null 2>&1
if wait_for "the managed ban to reach Caddy" 30 status_is 403 "http://$guarded/$RUN/ban"; then
  pass "a decision added in the managed container refuses the client"
else
  fail "a decision added in the managed container refuses the client" \
    "HTTP $(http_code "http://$guarded/$RUN/ban")"
fi
cscli decisions delete --ip "$CLIENT_IP" >/dev/null 2>&1
if wait_for "the managed ban to be lifted" 30 status_is 200 "http://$guarded/$RUN/unban"; then
  pass "deleting it lets the client back in"
else
  fail "deleting it lets the client back in" "HTTP $(http_code "http://$guarded/$RUN/unban")"
fi

# ── Managed AppSec ──────────────────────────────────────────────────────────

api PUT /api/v1/settings/crowdsec \
  '{"enabled":true,"mode":"managed","managedAppsec":true,"tickerInterval":"1s"}'
t_eq "managed AppSec can be switched on" "200" "$API_STATUS"
managed_appsec() { crowdsec_app | jq -e '.appsec_url == "http://cpm-crowdsec:7422"' >/dev/null; }
if wait_for "Caddy to get the managed AppSec address" 60 managed_appsec; then
  pass "Caddy is sent the managed AppSec listener"
else
  fail "Caddy is sent the managed AppSec listener" "$(crowdsec_app | head -c 300)"
fi
t_eq "the managed AppSec refuses a .env probe" "403" "$(http_code "http://$guarded/$RUN/.env")"
t_eq "and passes an ordinary request" "200" "$(http_code "http://$guarded/$RUN/fine")"

# ── Back to external stops it ───────────────────────────────────────────────

api PUT /api/v1/settings/crowdsec "$(jq -nc --arg u "$LAPI_URL" --arg k "$BOUNCER_KEY" \
  '{enabled: true, mode: "external", apiUrl: $u, apiKey: $k, tickerInterval: "1s"}')"
t_eq "switching back to external is accepted" "200" "$API_STATUS"
stopped() { [ "$(container '{{.State.Running}}')" != "true" ]; }
if wait_for "the agent to stop the managed container" 120 stopped; then
  pass "switching back to external stops the managed container"
else
  fail "switching back to external stops the managed container" "$(container '{{.State.Status}}')"
fi
external_app() { crowdsec_app | jq -e --arg u "$LAPI_URL" '.api_url == $u' >/dev/null; }
if wait_for "Caddy to point at the external LAPI again" 60 external_app; then
  pass "and Caddy bounces against the external LAPI again"
else
  fail "and Caddy bounces against the external LAPI again" "$(crowdsec_app | head -c 300)"
fi

finish
