#!/usr/bin/env bash
# Per-host rate limiting through caddy-ratelimit, on the image with the opt-in modules: the 429 and
# its Retry-After, one bucket per client, what trusted proxies change about who the client is,
# ip+path keys, path-scoped zones, the host's own 429 page, and the window running out.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
. "$(dirname "${BASH_SOURCE[0]}")/../helpers/opt-in-caddy.sh"

banner "rate limiting"

ensure_opt_in_caddy

# In every path, so the origin's request log can be searched for this run alone.
RUN="r$(date +%s)$$"

# host SLUG RATE_LIMIT_JSON [EXTRAS_JSON] -> HOST, plain HTTP on origin-a, once Caddy has it.
HOST=
host() {
  local extras="${3:-}"
  HOST=$(domain_for "$1")
  create_host_or_fail "the $1 host can be created" "$(jq -nc --arg d "$HOST" --argjson r "$2" \
    --argjson x "${extras:-null}" '{name: ("docker-test " + $d), domains: [$d],
      upstreams: ["origin-a:8080"], sslForced: false, rateLimit: $r} + $x')" &&
    pass "the $1 host can be created"
  # Not a probe request, which would count against the bucket under test.
  wait_for "$HOST in Caddy's config" 60 in_caddy_config "$HOST"
}

zone() {  # zone MAX WINDOW KEY [PATHS_JSON]
  jq -nc --argjson m "$1" --arg w "$2" --arg k "$3" --argjson p "${4:-[]}" \
    '{enabled: true, zones: [{maxEvents: $m, window: $w, key: $k, paths: $p}]}'
}

codes() {  # codes N URL [curl args...] -> the N statuses, space-separated
  local n="$1" url="$2"; shift 2
  local out=()
  for _ in $(seq 1 "$n"); do out+=("$(http_code "$url" "$@")"); done
  printf '%s' "${out[*]}"
}

origin_saw() {
  curl -sS --max-time 10 "http://origin-a:8080/__requests" 2>/dev/null \
    | jq -r --arg n "$1" '[.[] | select(.raw_path | contains($n))] | length' 2>/dev/null
}

# Starts clean: 65-settings-and-admin clears it too, but a --keep rerun may not have.
api PUT /api/v1/settings/trusted-proxies '{"ranges":[],"client_ip_headers":[]}'

# ── One bucket per client ───────────────────────────────────────────────────

host rl-ip "$(zone 3 10s ip)"
ip_host=$HOST
api GET "/api/v1/proxy-hosts/$NEW_ID"
t_eq "the API reports the zone" "3 10s ip" "$(jqr '.rateLimit.zones[0] | "\(.maxEvents) \(.window) \(.key)"')"

first=$(date +%s)
t_eq "the first three requests in the window pass" "200 200 200" \
  "$(codes 3 "http://$ip_host/$RUN/ip")"
fetch "http://$ip_host/$RUN/ip-fourth"
t_eq "the fourth is refused with 429" "429" "$FETCH_CODE"
t_matches "with a numeric Retry-After" '^[0-9]+$' "$(header_value retry-after)"
t_eq "the refused request never reaches the origin" "0" "$(origin_saw "$RUN/ip-fourth")"

t_eq "another client address has its own bucket" "200" "$(from_other_ip "/$RUN/other" "$ip_host")"

fetch "http://$ip_host/$RUN/spoof" -H 'X-Forwarded-For: 10.66.0.1'
t_eq "without trusted proxies X-Forwarded-For is ignored, so spoofing it does not reset the bucket" \
  "429" "$FETCH_CODE"

# Sliding: the oldest of the three leaves the window 10s after it was counted.
passed_again() { [ "$(http_code "http://$ip_host/$RUN/after")" = "200" ]; }
if wait_for "the window to run out" 25 passed_again; then
  waited=$(( $(date +%s) - first ))
  if [ "$waited" -ge 9 ]; then
    pass "requests pass again once the window has run out"
  else
    fail "requests pass again once the window has run out" "passed after only ${waited}s"
  fi
else
  fail "requests pass again once the window has run out" "still refused after 25s"
fi

# ── Trusted proxies decide who the client is ────────────────────────────────

api PUT /api/v1/settings/trusted-proxies \
  "$(jq -nc --arg r "$CLIENT_IP/32" '{ranges: [$r], client_ip_headers: ["X-Forwarded-For"]}')"
t_eq "the runner can be made a trusted proxy" "200" "$API_STATUS"

host rl-xff "$(zone 2 30s ip)"
xff_host=$HOST
t_eq "a forwarded client uses up its own bucket" "200 200 429" \
  "$(codes 3 "http://$xff_host/$RUN/xff" -H 'X-Forwarded-For: 10.66.0.1')"
t_eq "another forwarded client is counted apart" "200" \
  "$(http_code "http://$xff_host/$RUN/xff" -H 'X-Forwarded-For: 10.66.0.2')"
t_eq "and so is the proxy itself, forwarding for nobody" "200" "$(http_code "http://$xff_host/$RUN/xff")"
t_eq "an address outside the trusted range cannot choose its bucket" "200 200 429" \
  "$(for _ in 1 2 3; do printf '%s ' "$(from_other_ip "/$RUN/xff" "$xff_host")"; done | sed 's/ $//')"

api PUT /api/v1/settings/trusted-proxies '{"ranges":[],"client_ip_headers":[]}'
t_eq "trusted proxies can be cleared again" "200" "$API_STATUS"

# ── ip+path ─────────────────────────────────────────────────────────────────

host rl-ip-path "$(zone 2 30s ip+path)"
path_host=$HOST
t_eq "ip+path counts one path on its own" "200 200 429" "$(codes 3 "http://$path_host/$RUN/a")"
t_eq "another path from the same client has its own bucket" "200" \
  "$(http_code "http://$path_host/$RUN/b")"

# ── Path-scoped zone ────────────────────────────────────────────────────────

host rl-scoped "$(zone 2 30s ip '["/api/*"]')"
scoped_host=$HOST
t_eq "a path in the zone is limited" "200 200 429" "$(codes 3 "http://$scoped_host/api/$RUN")"
t_eq "a path outside it is not" "200 200 200 200 200" "$(codes 5 "http://$scoped_host/$RUN/free")"

# ── The host's own 429 page ─────────────────────────────────────────────────

host rl-error-page "$(zone 1 30s ip)" '{
  "errorPages": [{"statuses": [429], "body": "<p>slow down, rig</p>",
                  "contentType": "text/html; charset=utf-8"}]
}'
page_host=$HOST
fetch "http://$page_host/$RUN/page"
t_eq "the first request passes" "200" "$FETCH_CODE"
fetch "http://$page_host/$RUN/page"
t_eq "the host's 429 page keeps the status" "429" "$FETCH_CODE"
t_contains "with its own body" "slow down, rig" "$FETCH_BODY"
t_matches "and Retry-After survives the error route" '^[0-9]+$' "$(header_value retry-after)"

finish
