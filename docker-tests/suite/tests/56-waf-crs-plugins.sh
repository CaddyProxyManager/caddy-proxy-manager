#!/usr/bin/env bash
# CRS plugins from a registry of the operator's own. `files` serves the registry's registry.json and
# stands in for api.github.com and raw.githubusercontent.com, where CPM reads a plugin's releases
# and rule files: a plugin is installed from it, and its rule blocks in Coraza once a host loads it.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "WAF: CRS plugins from a custom registry"

if [ "${TEST_WAF:-1}" != "1" ]; then
  skip "CRS plugins" "disabled via CPM_TEST_WAF=0"
  finish
fi

FILES=/files
OWNER=rig
TAG=v1.2.0

# plugin NAME RULES - a GitHub repository rig/NAME with a release TAG holding NAME-before.conf
plugin() {
  local api="$FILES/api.github.com/repos/$OWNER/$1" raw="$FILES/raw.githubusercontent.com/$OWNER/$1/$TAG"
  mkdir -p "$api/releases" "$api/contents" "$raw/plugins"
  jq -nc --arg t "$TAG" '{tag_name:$t}' >"$api/releases/latest"
  jq -nc --arg n "$1-before.conf" '[{name:$n, type:"file"}, {name:"README.md", type:"file"}]' >"$api/contents/plugins"
  printf 'plugin:\n  name: %s\n  description: The rig'"'"'s own plugin\ncompatibility:\n  engines: [coraza]\n' "$1" >"$raw/plugin.yaml"
  printf '%s\n' "$2" >"$raw/plugins/$1-before.conf"
}

mkdir -p "$FILES/files.rig.internal/crs"
jq -nc '{plugins: [
  {name:"rig-tripwire", repository:"https://github.com/rig/rig-tripwire", type:"3rd-party", status:"tested",
   license:"Apache-2.0", rule_id_range:{start:9531000, end:9531999}},
  {name:"rig-overreach", repository:"https://github.com/rig/rig-overreach", type:"3rd-party", status:"untested",
   license:"Apache-2.0", rule_id_range:{start:9532000, end:9532999}},
  {name:"rig-elsewhere", repository:"https://gitlab.example/rig/elsewhere", type:"3rd-party", status:"tested",
   license:"MIT", rule_id_range:{start:9533000, end:9533999}}
]}' >"$FILES/files.rig.internal/crs/registry.json"

plugin rig-tripwire 'SecRule REQUEST_URI "@contains /rig-plugin-tripwire" "id:9531001,phase:1,deny,status:403,log,msg:'"'"'rig plugin tripwire'"'"'"'
# A rule id outside the range the registry gives the plugin.
plugin rig-overreach 'SecRule REQUEST_URI "@contains /overreach" "id:900001,phase:1,deny,status:403,log"'

registries_before=
restore() {
  [ -n "$registries_before" ] && api PUT /api/v1/crs-plugins/registry/settings "$registries_before" >/dev/null 2>&1
}
trap 'cleanup_tracked; restore' EXIT

api GET /api/v1/crs-plugins/registry/settings
registries_before=$(jqr '{registries: .registries}' -c)

api PUT /api/v1/crs-plugins/registry/settings '{"registries":[{"name":"Rig","url":"http://files.rig.internal/crs/registry.json"}]}'
t_eq "a registry over plain HTTP is refused" "400" "$API_STATUS"

api_expect "a registry of the operator's own can be added" 200 PUT /api/v1/crs-plugins/registry/settings \
  "$(printf '%s' "$registries_before" | jq -c '.registries += [{name:"Rig", url:"https://files.rig.internal/crs/registry.json"}]')"
rig_registry=$(jqr 'first(.registries[] | select(.name == "Rig")) | .id')

api POST /api/v1/crs-plugins/registry/check
t_eq "a sync reads it" "200" "$API_STATUS"
api GET /api/v1/crs-plugins/registry
t_eq "its plugins are listed" "rig-overreach,rig-tripwire" \
  "$(jqr '[.[] | select(.registryId == $r) | .name] | sort | join(",")' --arg r "$rig_registry")"
t_eq "one outside github.com is dropped" "0" "$(jqr '[.[] | select(.name == "rig-elsewhere")] | length')"

if create_resource crs-plugins "$(jq -nc --arg r "$rig_registry" '{name:"rig-tripwire", registry:$r}')"; then
  pass "a plugin can be installed from it"
else
  fail "a plugin can be installed from it" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
  finish
fi
plugin_id=$NEW_ID
t_eq "at the release's tag" "$TAG" "$(jqr '.version')"
t_eq "with its rule file only" "rig-tripwire-before.conf" "$(jqr '.fileNames | join(",")')"
t_contains "and the rule in it" "id:9531001" "$(jqr '.beforeRules')"
t_eq "and plugin.yaml's description" "The rig's own plugin" "$(jqr '.description')"

requests=$(curl -sS --max-time 10 --cacert "$CA_BUNDLE" https://files.rig.internal/__requests)
t_contains "fetched from the release's own tag" "/rig/rig-tripwire/$TAG/plugins/rig-tripwire-before.conf" \
  "$(printf '%s' "$requests" | jq -r '[.[] | select(.host == "raw.githubusercontent.com") | .raw_path] | join(" ")')"

api POST /api/v1/crs-plugins "$(jq -nc --arg r "$rig_registry" '{name:"rig-tripwire", registry:$r}')"
t_eq "installing it twice is a conflict" "409" "$API_STATUS"
create_resource crs-plugins "$(jq -nc --arg r "$rig_registry" '{name:"rig-overreach", registry:$r}')"
t_eq "a plugin with a rule outside its id range is refused" "400" "$API_STATUS"
t_contains "naming the rule" "900001" "$API_BODY"

# ── In Coraza ───────────────────────────────────────────────────────────────

domain=$(domain_for "crs-plugin")
create_host_or_fail "a host loading the plugin can be created" "$(jq -nc --arg d "$domain" --argjson p "$plugin_id" '{
  name:"docker-test crs plugin", domains:[$d], upstreams:["origin-a:8080"],
  waf:{enabled:true, mode:"On", load_owasp_crs:true, plugin_ids:[$p], custom_directives:"", waf_mode:"override"}}')" \
  && pass "a host loading the plugin can be created"
wait_for_https "$domain" 120

directives=$(curl -sS --max-time 10 http://caddy:2019/config/apps/http/servers/cpm/routes | jq -r --arg d "$domain" \
  '[.[] | select(.match[0].host // [] | index($d)) | .. | objects | select(.handler? == "waf") | .directives] | first')
t_contains "the plugin's rule is inlined into the host's WAF" "id:9531001" "$directives"
before_at=$(printf '%s' "$directives" | grep -n "9531001" | head -n1 | cut -d: -f1)
crs_at=$(printf '%s' "$directives" | grep -n "@owasp_crs/\*.conf" | head -n1 | cut -d: -f1)
t_eq "ahead of the Core Rule Set, as a -before file is" "true" \
  "$([ -n "$before_at" ] && [ -n "$crs_at" ] && [ "$before_at" -lt "$crs_at" ] && echo true || echo false)"

t_eq "the plugin blocks what its rule matches" "403" "$(http_code "https://$domain/rig-plugin-tripwire")"
t_eq "and lets the rest through" "200" "$(http_code "https://$domain/ordinary")"

host_id=$NEW_ID

# ── A new release ───────────────────────────────────────────────────────────

TAG=v1.3.0
plugin rig-tripwire 'SecRule REQUEST_URI "@contains /rig-plugin-moved" "id:9531002,phase:1,deny,status:403,log,msg:'"'"'rig plugin moved'"'"'"'
api POST "/api/v1/crs-plugins/$plugin_id/update"
t_eq "an installed plugin can be updated to its latest release" "200|$TAG" "$API_STATUS|$(jqr '.version')"
moved() { [ "$(http_code "https://$domain/rig-plugin-moved")" = "403" ]; }
wait_for "the new release to reach the host" 30 moved && pass "a host loading it gets the new rules" \
  || fail "a host loading it gets the new rules" "got $(http_code "https://$domain/rig-plugin-moved")"
t_eq "and loses the old ones" "200" "$(http_code "https://$domain/rig-plugin-tripwire")"

api PUT "/api/v1/crs-plugins/$plugin_id" '{"config":"SecAction \"id:9531900,phase:1,pass,nolog,setvar:tx.rig_plugin_enabled=1\""}'
t_eq "its -config file can be overridden" "200" "$API_STATUS"
api GET "/api/v1/crs-plugins/$plugin_id"
t_contains "and the override reads back" "rig_plugin_enabled" "$(jqr '.configOverride')"
api PUT "/api/v1/crs-plugins/$plugin_id" '{"config":"SecRule ARGS \"@rx x\" \"id:1,phase:1,deny\""}'
t_eq "an override with a rule outside the plugin's range is refused" "400" "$API_STATUS"

api PUT "/api/v1/proxy-hosts/$host_id" '{"waf":{"enabled":true,"mode":"On","load_owasp_crs":true,"plugin_ids":[],"custom_directives":"","waf_mode":"override"}}'
unloaded() { [ "$(http_code "https://$domain/rig-plugin-moved")" = "200" ]; }
if wait_for "the plugin to leave the host" 30 unloaded; then
  pass "a host that stops loading it stops blocking"
else
  fail "a host that stops loading it stops blocking" "still $(http_code "https://$domain/rig-plugin-tripwire")"
fi

finish
