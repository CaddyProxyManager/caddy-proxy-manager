# shellcheck shell=bash
# Sourced by agent-phase files that need Rate Limit, CrowdSec or the HTTP cache, after lib.sh. Puts
# Caddy on the image with all of them, the way an operator does it: select the modules, rebuild
# under the tag the agent runs (a retag of cpm-test/caddy:opt-in here), then Load built image.
# Skipped when already done.

OPT_IN_IMAGE=cpm-test/caddy:opt-in
AGENT_IMAGE=cpm-test/caddy:external
RATELIMIT_MODULE=github.com/mholt/caddy-ratelimit
CROWDSEC_MODULE=github.com/hslatman/caddy-crowdsec-bouncer
CACHE_MODULE=github.com/caddyserver/cache-handler
CACHE_REDIS_MODULE=github.com/darkweak/storages/redis/caddy

opt_in_agent_ready() {
  api_session GET /api/caddy-build
  [ "$API_STATUS" = "200" ] && [ "$(jqr '.external | length')" = "1" ] &&
    [ "$(jqr '.external[0].image')" != "null" ]
}

opt_in_applied() {
  api_session GET /api/caddy-build
  [ "$API_STATUS" = "200" ] &&
    [ "$(printf '%s' "$API_BODY" | jq -r '[$ARGS.positional[] as $m | .diff.appliedSpecs | index($m) != null] | all' \
      --args "$RATELIMIT_MODULE" "$CROWDSEC_MODULE" "$CACHE_MODULE" "$CACHE_REDIS_MODULE")" = "true" ]
}

# Merged into the stored selection: PUT replaces the map, and a module left out reverts to default.
opt_in_select() {
  api GET /api/v1/caddy/modules
  local selection
  selection=$(jqr '.selection.modules + {"caddy-ratelimit": true, "caddy-crowdsec": true,
    "cache-handler": true, "souin-storage-redis": true}' -c)
  api PUT /api/v1/caddy/modules "$(jq -nc --argjson m "$selection" '{modules: $m}')"
  [ "$API_STATUS" = "200" ]
}

# A host is served once its name is in the loaded config; no request needed, so none is counted.
in_caddy_config() {
  curl -sS --max-time 5 http://caddy:2019/config/apps/http/servers/cpm/routes 2>/dev/null \
    | grep -qF "\"$1\""
}

caddy_answers() { curl -sS --max-time 5 -o /dev/null http://caddy:2019/config/; }

ensure_opt_in_caddy() {
  if ! wait_for "the agent to pair and report external build mode" 180 opt_in_agent_ready; then
    fail "the agent is paired in external build mode" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
    finish
  fi
  if opt_in_select; then
    pass "the opt-in modules can be selected in Settings → Caddy Build"
  else
    fail "the opt-in modules can be selected in Settings → Caddy Build" \
      "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
  fi

  if opt_in_applied; then
    info "Caddy already runs an image with the opt-in modules"
    return 0
  fi

  if ! docker tag "$OPT_IN_IMAGE" "$AGENT_IMAGE" 2>/dev/null; then
    fail "the operator's image can be rebuilt under the agent's tag" "docker tag failed"
    finish
  fi

  local loaded=0
  for _ in $(seq 1 20); do
    api_session POST /api/caddy-build/image
    if [ "$API_STATUS" = "200" ]; then loaded=1; break; fi
    case "$API_BODY" in *"already running"*) sleep 3 ;; *) break ;; esac
  done
  if [ "$loaded" != "1" ]; then
    fail "the image with the opt-in modules can be loaded" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
    finish
  fi

  if wait_for "the agent to report the opt-in modules applied" 300 opt_in_applied; then
    pass "the agent reads the opt-in modules off the loaded image's caddy-modules.txt"
  else
    fail "the agent reads the opt-in modules off the loaded image's caddy-modules.txt" \
      "applied: $(jqr -c '.diff.appliedSpecs') status: $(jqr -c '.status')"
    finish
  fi
  t_eq "the selection and the image now agree" "false" "$(jqr '.diff.needsRebuild')" \
    || info "added: $(jqr -c '.diff.added') removed: $(jqr -c '.diff.removed')"
  wait_for "Caddy on the new image" 120 caddy_answers
}

# from_other_ip PATH HOST -> the status origin-b's address (not the runner's) gets, plain HTTP.
from_other_ip() {
  local path="$1" host="$2"
  docker exec cpm-test-origin-b python3 -c '
import sys, urllib.request, urllib.error
req = urllib.request.Request("http://172.28.0.10" + sys.argv[1], headers={"Host": sys.argv[2]})
try:
    print(urllib.request.urlopen(req, timeout=10).status)
except urllib.error.HTTPError as e:
    print(e.code)
except Exception:
    print("000")
' "$path" "$host" 2>/dev/null || printf '000'
}
