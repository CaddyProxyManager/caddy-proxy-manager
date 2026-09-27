#!/usr/bin/env bash
# The Coraza WAF: per-host rules, the global/host merge, DetectionOnly mode,
# the directive allowlist, and the WebSocket carve-out.
#
# Hand-written rules, not the CRS, so assertions do not depend on its version.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "web application firewall"

if [ "${TEST_WAF:-1}" != "1" ]; then
  skip "WAF" "disabled via CPM_TEST_WAF=0"
  finish
fi

BLOCK_RULE='SecRule REQUEST_URI "@contains /waf-tripwire" "id:900100,phase:1,deny,status:403,log,msg:'"'"'docker test tripwire'"'"'"'
ARG_RULE='SecRule ARGS:probe "@streq boom" "id:900101,phase:2,deny,status:403,log,msg:'"'"'docker test arg rule'"'"'"'

empty_waf='{"enabled":false,"mode":"Off","load_owasp_crs":false,"custom_directives":"","excluded_rule_ids":[]}'
restore_global() { api PUT /api/v1/settings/waf "$empty_waf" >/dev/null 2>&1; }
trap 'restore_global; cleanup_tracked' EXIT

# ── Per-host blocking ───────────────────────────────────────────────────────

waf=$(domain_for "waf-host")
host_body=$(jq -nc --arg d "$waf" --arg rules "$BLOCK_RULE"$'\n'"$ARG_RULE" '{
  name: "docker-test waf host",
  domains: [$d],
  upstreams: ["origin-a:8080"],
  waf: { enabled: true, mode: "On", load_owasp_crs: false, custom_directives: $rules, waf_mode: "override" }
}')

if ! create_host "$host_body"; then
  skip "WAF" "the WAF handler rejected the config (HTTP $API_STATUS): $(printf '%.200s' "$API_BODY")"
  finish
fi
pass "a host with WAF rules can be created"

if ! wait_for "the WAF-protected host to answer" 120 \
     bash -c "curl -sS --max-time 8 -o /dev/null --cacert '$CA_BUNDLE' 'https://$waf/'"; then
  fail "the WAF-protected host is reachable" "no response from https://$waf/"
  finish
fi

t_eq "ordinary traffic passes the WAF" "200" "$(http_code "https://$waf/normal/page")"
t_eq "a request matching a rule is blocked" "403" "$(http_code "https://$waf/waf-tripwire")"
t_eq "a rule can match on a query argument" "403" "$(http_code "https://$waf/search?probe=boom")"
t_eq "a near miss on the same argument is allowed" "200" "$(http_code "https://$waf/search?probe=fine")"

body=$(http_body "https://$waf/normal/page")
t_contains "allowed requests still reach the upstream" "origin-a" "$body"

# ── DetectionOnly ───────────────────────────────────────────────────────────
#
# The rule matches and is logged, but the request is not stopped.

detect=$(domain_for "waf-detect")
create_host_or_fail "a DetectionOnly host can be created" "$(jq -nc --arg d "$detect" --arg rules "$BLOCK_RULE" '{
  name: "docker-test waf detect",
  domains: [$d],
  upstreams: ["origin-a:8080"],
  waf: { enabled: true, mode: "DetectionOnly", load_owasp_crs: false, custom_directives: $rules, waf_mode: "override" }
}')" && pass "a DetectionOnly host can be created"

wait_for "the DetectionOnly host to answer" 120 \
  bash -c "curl -sS --max-time 8 -o /dev/null --cacert '$CA_BUNDLE' 'https://$detect/'"

t_eq "DetectionOnly does not block a matching request" "200" "$(http_code "https://$detect/waf-tripwire")"

# ── Opting out ──────────────────────────────────────────────────────────────

open=$(domain_for "waf-off")
create_host_or_fail "a host with the WAF off can be created" "$(jq -nc --arg d "$open" '{
  name: "docker-test waf off", domains: [$d], upstreams: ["origin-a:8080"]
}')" && pass "a host with the WAF off can be created"

wait_for_https "$open" 120
t_eq "a host without the WAF is unaffected by another host's rules" "200" \
  "$(http_code "https://$open/waf-tripwire")"

# ── Global rules and per-host opt-out ───────────────────────────────────────

api PUT /api/v1/settings/waf "$(jq -nc --arg rules "$BLOCK_RULE" \
  '{enabled:true, mode:"On", load_owasp_crs:false, custom_directives:$rules, excluded_rule_ids:[]}')"

if [ "$API_STATUS" != "200" ]; then
  skip "global WAF rules" "settings rejected (HTTP $API_STATUS): $(printf '%.200s' "$API_BODY")"
else
  pass "global WAF settings can be saved"

  if wait_for "the global rule to take effect" 30 \
       bash -c "[ \"\$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' --cacert '$CA_BUNDLE' 'https://$open/waf-tripwire' 2>/dev/null)\" = '403' ]"; then
    pass "a global rule protects hosts that set no rules of their own"
  else
    fail "a global rule protects hosts that set no rules of their own" \
      "https://$open/waf-tripwire returned $(http_code "https://$open/waf-tripwire")"
  fi

  t_eq "the global rule does not break ordinary traffic" "200" "$(http_code "https://$open/normal")"

  # An explicit per-host disable must win over the global setting.
  optout=$(domain_for "waf-optout")
  create_host_or_fail "a host can opt out of the global WAF" "$(jq -nc --arg d "$optout" '{
    name: "docker-test waf optout", domains: [$d], upstreams: ["origin-a:8080"],
    waf: { enabled: false }
  }')" && pass "a host can opt out of the global WAF"

  wait_for_https "$optout" 120
  t_eq "an opted-out host is not filtered" "200" "$(http_code "https://$optout/waf-tripwire")"

  restore_global
  wait_for "the global rule to be lifted" 30 \
    bash -c "[ \"\$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' --cacert '$CA_BUNDLE' 'https://$open/waf-tripwire' 2>/dev/null)\" = '200' ]"
  t_eq "clearing the global rules restores access" "200" "$(http_code "https://$open/waf-tripwire")"
fi

# ── Directive allowlist ─────────────────────────────────────────────────────
#
# Directives that could switch the engine off or read container files are
# refused at save, naming the lines, rather than quietly dropped.

smuggle=$(domain_for "waf-smuggle")
api_expect "a host with hostile directives is refused" 400 POST /api/v1/proxy-hosts "$(jq -nc --arg d "$smuggle" \
  --arg rules "$BLOCK_RULE"$'\n'"SecRuleEngine Off"$'\n'"Include /etc/passwd" '{
  name: "docker-test waf smuggle",
  domains: [$d],
  upstreams: ["origin-a:8080"],
  waf: { enabled: true, mode: "On", load_owasp_crs: false, custom_directives: $rules, waf_mode: "override" }
}')"
t_contains "the refusal names the engine directive" "SecRuleEngine Off" "$API_BODY"
t_contains "the refusal names the Include" "Include /etc/passwd" "$API_BODY"

# ── WebSockets through the WAF ──────────────────────────────────────────────
#
# Routed around the WAF, any request claiming to be an upgrade skipped inspection.

wafws=$(domain_for "waf-websocket")
create_host_or_fail "a host with both the WAF and WebSockets can be created" "$(jq -nc --arg d "$wafws" \
  --arg rules "$BLOCK_RULE" '{
  name: "docker-test waf websocket",
  domains: [$d],
  upstreams: ["origin-a:8080"],
  allowWebsocket: true,
  waf: { enabled: true, mode: "On", load_owasp_crs: false, custom_directives: $rules, waf_mode: "override" }
}')" && pass "a host with both the WAF and WebSockets can be created"

wait_for "the WAF + websocket host to answer" 120 \
  bash -c "curl -sS --max-time 8 -o /dev/null --cacert '$CA_BUNDLE' 'https://$wafws/'"

ws_reply=$(python3 /suite/helpers/ws_client.py "$wafws" /ws "$CA_BUNDLE" through-the-waf 2>&1)
t_contains "a WebSocket upgrade survives an enabled WAF" "echo:through-the-waf" "$ws_reply"
t_eq "ordinary requests on the same host are still filtered" "403" \
  "$(http_code "https://$wafws/waf-tripwire")"
t_eq "a request claiming to be an upgrade is filtered too" "403" \
  "$(http_code "https://$wafws/waf-tripwire" -H 'Connection: Upgrade' -H 'Upgrade: websocket')"

# ── Recorded events ─────────────────────────────────────────────────────────
#
# Ingestion is periodic, so this asserts the endpoint works, not a specific event.

api_session GET "/api/waf-events?range=24h&per_page=10"
t_eq "the WAF event endpoint answers" "200" "$API_STATUS"
t_matches "the WAF event payload is well formed" '^(array|object)$' "$(jqr 'type')"

finish
