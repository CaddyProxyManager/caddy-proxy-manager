#!/usr/bin/env bash
# Documented operations nothing else drove, each checked for what it does rather than that it
# answers: WAF presets in Coraza, bulk host actions in Caddy, an access list's IP rules edited in
# place, a user's role and status changed, and sessions revoked.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "the rest of the REST surface"

RUN="s$(date +%s)$$"

# ── WAF presets ─────────────────────────────────────────────────────────────

rule() { printf 'SecRule REQUEST_URI "@contains /%s" "id:%s,phase:1,deny,status:403,log"' "$1" "$2"; }

if create_resource waf-presets "$(jq -nc --arg n "docker-test preset $RUN" --arg r "$(rule preset-tripwire 910001)" \
     '{name:$n, description:"from the suite", directives:$r}')"; then
  pass "a WAF preset can be created"
else
  fail "a WAF preset can be created" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
fi
preset_id=$NEW_ID
api GET "/api/v1/waf-presets/$preset_id"
t_contains "and read back" "910001" "$(jqr '.directives')"
api GET /api/v1/waf-presets
t_eq "and listed" "true" "$(jqr '[.[].id] | index($i) != null' --argjson i "$preset_id")"
api POST /api/v1/waf-presets "$(jq -nc --arg n "docker-test broken $RUN" '{name:$n, directives:"SecRule nonsense"}')"
t_eq "a preset Coraza cannot load is refused" "400" "$API_STATUS"

waf_domain=$(domain_for "waf-preset")
create_host_or_fail "a host using the preset can be created" "$(jq -nc --arg d "$waf_domain" --argjson p "$preset_id" '{
  name:"docker-test waf preset", domains:[$d], upstreams:["origin-a:8080"],
  waf:{enabled:true, mode:"On", load_owasp_crs:false, preset_ids:[$p], custom_directives:"", waf_mode:"override"}}')" \
  && pass "a host using the preset can be created"
waf_host=$NEW_ID
wait_for_https "$waf_domain" 120
t_eq "the preset's rule blocks on the host" "403" "$(http_code "https://$waf_domain/preset-tripwire")"
t_eq "and the rest passes" "200" "$(http_code "https://$waf_domain/fine")"

api PUT "/api/v1/waf-presets/$preset_id" "$(jq -nc --arg r "$(rule preset-changed 910002)" '{directives:$r}')"
t_eq "the preset can be changed" "200" "$API_STATUS"
changed() { [ "$(http_code "https://$waf_domain/preset-changed")" = "403" ]; }
wait_for "the change to reach the host" 30 changed && pass "every host using it follows the change" \
  || fail "every host using it follows the change" "got $(http_code "https://$waf_domain/preset-changed")"
t_eq "and the old rule is gone" "200" "$(http_code "https://$waf_domain/preset-tripwire")"

api DELETE "/api/v1/waf-presets/$preset_id"
t_eq "a preset a host uses cannot be deleted" "409" "$API_STATUS"

# ── Bulk actions ────────────────────────────────────────────────────────────

a=$(domain_for "bulk-a") b=$(domain_for "bulk-b")
create_host_or_fail "a first bulk host" "$(jq -nc --arg d "$a" '{name:"docker-test bulk a", domains:[$d], upstreams:["origin-a:8080"]}')"
bulk_a=$NEW_ID
create_host_or_fail "a second bulk host" "$(jq -nc --arg d "$b" '{name:"docker-test bulk b", domains:[$d], upstreams:["origin-b:8080"]}')"
bulk_b=$NEW_ID
wait_for_https "$a" 120 && wait_for_https "$b" 120

bulk() { api POST /api/v1/proxy-hosts/bulk "$(jq -nc --arg a "$1" --argjson i "[$bulk_a,$bulk_b]" '{action:$a, ids:$i}' | jq -c ". + ${2:-{\}}")"; }
both_are() { [ "$(http_code "https://$a/")" = "$1" ] && [ "$(http_code "https://$b/")" = "$1" ]; }

bulk maintenanceOn
t_eq "several hosts can be put into maintenance at once" "200" "$API_STATUS"
wait_for "both to answer 503" 30 both_are 503 && pass "both answer with maintenance" \
  || fail "both answer with maintenance" "$(http_code "https://$a/") $(http_code "https://$b/")"
bulk maintenanceOff
wait_for "both to be back" 30 both_are 200 && pass "and come back together" || fail "and come back together" "still down"

if create_resource access-lists "$(jq -nc --arg n "docker-test bulk list $RUN" '{name:$n, users:[{username:"bulk", password:"bulk-secret-1"}]}')"; then
  list_id=$NEW_ID
  bulk setAccessList "{\"accessListId\":$list_id}"
  t_eq "an access list can be put on several hosts" "200" "$API_STATUS"
  wait_for "both to ask for credentials" 30 both_are 401 && pass "both then ask for credentials" \
    || fail "both then ask for credentials" "$(http_code "https://$a/") $(http_code "https://$b/")"
  bulk setAccessList '{"accessListId":null}'
  wait_for "both to be open again" 30 both_are 200 && pass "and it can be taken off them" || fail "and it can be taken off them" "still 401"
fi

bulk disable
not_served() { [ "$(http_code "https://$a/")" != "200" ] && [ "$(http_code "https://$b/")" != "200" ]; }
wait_for "both to stop" 30 not_served && pass "several hosts can be disabled at once" || fail "several hosts can be disabled at once" "still served"
api GET "/api/v1/proxy-hosts/$bulk_a"
t_eq "and read back disabled" "false" "$(jqr '.enabled')"
bulk enable
wait_for "both to serve" 30 both_are 200 && pass "and enabled again" || fail "and enabled again" "not served"

api POST /api/v1/proxy-hosts/bulk '{"action":"disable","ids":[]}'
t_eq "an empty batch is refused" "400" "$API_STATUS"
api POST /api/v1/proxy-hosts/bulk "$(jq -nc --argjson i "[$bulk_a]" '{action:"explode", ids:$i}')"
t_eq "an unknown action is refused" "400" "$API_STATUS"

# ── An access list's IP rules ───────────────────────────────────────────────

if [ -n "${list_id:-}" ]; then
  api PUT "/api/v1/access-lists/$list_id" "$(jq -nc --arg n "docker-test bulk list renamed $RUN" '{name:$n}')"
  t_eq "an access list can be renamed" "200" "$API_STATUS"
  api PUT "/api/v1/access-lists/$list_id/ip-rules" "$(jq -nc --arg c "$CLIENT_IP/32" '[{action:"deny", cidr:$c}]')"
  t_eq "its IP rules can be replaced" "200" "$API_STATUS"
  api GET "/api/v1/access-lists/$list_id/ip-rules"
  t_eq "and read back" "deny $CLIENT_IP/32" "$(jqr '.[0] | "\(.action) \(.cidr)"')"
  api PUT "/api/v1/proxy-hosts/$bulk_a" "$(jq -nc --argjson l "$list_id" '{accessListId:$l}')"
  denied() { [ "$(http_code "https://$a/" -u bulk:bulk-secret-1)" = "403" ]; }
  wait_for "the deny rule to apply" 30 denied && pass "a denied address is refused even with credentials" \
    || fail "a denied address is refused even with credentials" "got $(http_code "https://$a/" -u bulk:bulk-secret-1)"
fi

# ── Users and sessions ──────────────────────────────────────────────────────

email="surface-$RUN@cpm.test" password='Surface-T3st!Passw0rd'
if create_resource users "$(jq -nc --arg e "$email" --arg p "$password" '{email:$e, password:$p, role:"viewer"}')"; then
  user_id=$NEW_ID
  jar="$STATE_DIR/surface-user.txt"; rm -f "$jar"
  sign_in() { curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -c "$1" -H 'Content-Type: application/json' \
    -H "Origin: $CPM_API" --data-binary "$(jq -nc --arg e "$email" --arg p "$password" '{email:$e, password:$p}')" \
    "$CPM_API/api/auth/sign-in/email"; }
  t_eq "a viewer can sign in" "200" "$(sign_in "$jar")"
  as_user() { curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -b "$jar" "$CPM_API$1"; }
  t_eq "and cannot list hosts" "403" "$(as_user /api/v1/proxy-hosts)"

  api PUT "/api/v1/users/$user_id" '{"role":"admin"}'
  t_eq "an admin can change a user's role" "200" "$API_STATUS"
  api GET "/api/v1/users/$user_id"
  t_eq "which reads back" "admin" "$(jqr '.role')"
  t_eq "and takes effect on the user's session" "200" "$(as_user /api/v1/proxy-hosts)"

  jar2="$STATE_DIR/surface-user-2.txt"; rm -f "$jar2"
  # Better Auth allows three sign-ins per 10s per client; wait one out rather than fail on it.
  for _ in $(seq 1 15); do [ "$(sign_in "$jar2")" = "200" ] && break; sleep 1; done
  own=$(curl -sS --max-time 15 -b "$jar" "$CPM_API/api/v1/sessions")
  other=$(printf '%s' "$own" | jq -r 'first(.[] | select(.current | not)) | .id')
  t_eq "a user sees both of their sessions" "2" "$(printf '%s' "$own" | jq 'length')"
  t_eq "revoking another of their sessions works" "200" \
    "$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -X DELETE -b "$jar" -H "Origin: $CPM_API" "$CPM_API/api/v1/sessions/$other")"
  t_eq "and that session is signed out" "401" \
    "$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -b "$jar2" "$CPM_API/api/v1/sessions")"
  t_eq "while the current one stays" "200" "$(as_user /api/v1/sessions)"

  api PUT "/api/v1/users/$user_id" '{"status":"disabled"}'
  t_eq "a user can be disabled" "200" "$API_STATUS"
  t_ne "and can no longer sign in" "200" "$(sign_in "$STATE_DIR/surface-user-3.txt")"
  api PUT "/api/v1/users/$user_id" '{"role":"emperor"}'
  t_eq "an unknown role is refused" "400" "$API_STATUS"
fi

api GET /api/v1/groups
t_eq "groups can be listed" "array" "$(jqr 'type')"

finish
