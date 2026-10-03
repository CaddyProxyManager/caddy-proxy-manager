#!/usr/bin/env bash
# A host's shared cache in Caddy (Souin, "caddy" cache mode) with Redis as its storage, on the
# image with the opt-in modules: a miss stored, a hit that never reaches the origin, the entry in
# Redis, what the cache leaves alone (a request with a cookie, a path that is not an asset), and the
# host dropping the cache.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
. "$(dirname "${BASH_SOURCE[0]}")/../helpers/opt-in-caddy.sh"

banner "HTTP cache in Caddy, stored in Redis"

ensure_opt_in_caddy

RUN="c$(date +%s)$$"
settings_before=
restore() { [ -n "$settings_before" ] && api PUT /api/v1/settings/http-cache "$settings_before" >/dev/null 2>&1; }
trap 'cleanup_tracked; restore' EXIT

origin_saw() {
  curl -sS --max-time 10 http://origin-a:8080/__requests 2>/dev/null \
    | jq --arg p "$1" '[.[] | select(.raw_path == $p)] | length'
}
cache_status() { header_value cache-status; }

api GET /api/v1/settings/http-cache
settings_before=$(jqr '.' -c)
api_expect "the cache can be stored in Redis" 200 PUT /api/v1/settings/http-cache \
  "$(printf '%s' "$settings_before" | jq -c '.storage = "redis" | .redis.addresses = ["redis:6379"]')"
api PUT /api/v1/settings/http-cache "$(printf '%s' "$settings_before" | jq -c '.storage = "redis" | .redis.addresses = []')"
t_eq "Redis with no address is refused" "400" "$API_STATUS"

t_eq "Caddy's cache app points at Redis" '["redis:6379"]' \
  "$(curl -sS --max-time 10 http://caddy:2019/config/apps/cache 2>/dev/null | jq -c '.redis.configuration.InitAddress')"

domain=$(domain_for "http-cache")
create_host_or_fail "a host caching in Caddy can be created" "$(jq -nc --arg d "$domain" \
  '{name:"docker-test http cache", domains:[$d], upstreams:["origin-a:8080"], sslForced:false,
    cache:{mode:"caddy", maxAge:300}}')" && pass "a host caching in Caddy can be created"
host_id=$NEW_ID
wait_for "Caddy to serve $domain" 60 in_caddy_config "$domain"

asset="/app-$RUN.css"
fetch "http://$domain$asset"
t_eq "the first request for an asset is answered" "200" "$FETCH_CODE"
t_contains "by the origin, and stored" "stored" "$(cache_status)"
fetch "http://$domain$asset"
t_contains "the second is a hit" "hit" "$(cache_status)"
t_eq "with the origin's body" "origin-a" "$(fetch_json '.origin')"
fetch "http://$domain$asset"
t_eq "and the origin saw the asset once" "1" "$(origin_saw "$asset")"

in_redis() { docker exec cpm-test-redis redis-cli --scan 2>/dev/null | grep -q "app-$RUN.css"; }
t_ok "the entry is in Redis" in_redis

cookie="/cookie-$RUN.css"
fetch "http://$domain$cookie" -H 'Cookie: session=one'
fetch "http://$domain$cookie" -H 'Cookie: session=one'
t_eq "a request with a cookie is never answered from the cache" "2" "$(origin_saw "$cookie")"

page="/page-$RUN"
fetch "http://$domain$page"; fetch "http://$domain$page"
t_eq "nor is a path that is not an asset" "2" "$(origin_saw "$page")"

api PUT "/api/v1/proxy-hosts/$host_id" '{"cache":null}'
uncached() { fetch "http://$domain$asset" && [ "$(origin_saw "$asset")" -ge 2 ]; }
if wait_for "the host to stop caching" 30 uncached; then
  pass "a host that drops the cache sends the asset to the origin again"
else
  fail "a host that drops the cache sends the asset to the origin again" "origin saw it $(origin_saw "$asset") time(s)"
fi
t_eq "without a cache status" "" "$(cache_status)"

finish
