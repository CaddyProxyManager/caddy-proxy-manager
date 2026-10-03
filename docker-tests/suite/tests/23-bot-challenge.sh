#!/usr/bin/env bash
# The bot challenge against the rig's real Anubis (config/anubis/policy.yaml): the redirect, the
# challenge page, a solved proof of work, ALLOW/DENY, exempt paths, the address Anubis is told,
# and what the check subrequest carries.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "bot challenge (Anubis)"

ANUBIS_URL=http://anubis:8923
CHECK_URI=/.within.website/x/cmd/anubis/api/check
BROWSER_UA='Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'
ALLOWED_UA=cpm-test-allowed/1.0
DENIED_UA=cpm-test-denied/1.0
JAR="$STATE_DIR/anubis-cookies.txt"
rm -f "$JAR"
# In every path, so the origins' request logs can be searched for this run alone.
RUN="r$(date +%s)$$"

# origin_saw ORIGIN NEEDLE -> the origin's logged requests whose path contains NEEDLE, as JSON lines.
origin_saw() {
  curl -sS --max-time 10 "http://$1:8080/__requests" 2>/dev/null \
    | jq -c --arg n "$2" '.[] | select(.raw_path | contains($n))' 2>/dev/null
}

# The check's own log entries on the echo, by the original URI it was asked about.
check_saw() {
  curl -sS --max-time 10 "http://$1:8080/__requests" 2>/dev/null \
    | jq -c --arg n "$2" '.[] | select((.headers["x-forwarded-uri"] // "") | contains($n))' 2>/dev/null
}

# redir_of LOCATION -> the decoded redir parameter.
redir_of() {
  python3 -c 'import sys, urllib.parse as u; print(u.parse_qs(u.urlsplit(sys.argv[1]).query)["redir"][0])' "$1" 2>/dev/null
}

domain=$(domain_for "bot-challenge")
create_host_or_fail "a host with the bot challenge can be created" "$(jq -nc --arg d "$domain" \
  --arg a "$ANUBIS_URL" '{
    name: "docker-test bot challenge", domains: [$d], upstreams: ["origin-a:8080"],
    anubis: {enabled: true, upstream: $a, exemptPaths: ["/api/*"]}
  }')" || finish
pass "a host with the bot challenge can be created"
host_id="$NEW_ID"

api GET "/api/v1/proxy-hosts/$host_id"
t_eq "the API reports it enabled" "true" "$(jqr '.anubis.enabled')"
t_eq "with the exempt path" '["/api/*"]' "$(jqr '.anubis.exemptPaths' -c)"

wait_for_https "$domain" 120

# ── No pass: redirected to the challenge ───────────────────────────────────

# `&`, `?` and an escaped `&` must all survive the trip through redir.
uri="/shop/$RUN/search?q=a&b=c?d&e=%26f"
fetch "https://$domain$uri" -A "$BROWSER_UA"
t_eq "a browser without a pass is redirected" "307" "$FETCH_CODE"
location=$(header_value location)
t_matches "to the challenge page on the same host" '^/\.within\.website/\?redir=' "$location"
t_eq "redir decodes to the original URI" "$uri" "$(redir_of "$location")"
t_eq "the redirect is not cached" "no-store" "$(header_value cache-control)"
t_eq "the origin is never asked" "" "$(origin_saw origin-a "/shop/$RUN/")"

# ── The challenge page ─────────────────────────────────────────────────────

# Anubis refuses a challenge to 1 in 64 clients that do not take gzip, as a browser always does.
fetch "https://$domain$location" -A "$BROWSER_UA" --compressed -c "$JAR" -b "$JAR"
t_eq "the challenge page answers" "200" "$FETCH_CODE"
t_contains "and comes from Anubis" 'id="anubis_challenge"' "$FETCH_BODY"
t_eq "not from the origin" "" "$(header_value x-origin-id)"
page="$FETCH_BODY"

# ── Solving it ─────────────────────────────────────────────────────────────

if ! solved=$(printf '%s' "$page" | python3 /suite/helpers/anubis_solve.py 2>&1); then
  fail "the challenge can be solved" "$solved"
else
  pass "the challenge can be solved"
  { read -r chal_id; read -r chal_hash; read -r chal_nonce; read -r chal_ip; } <<<"$solved"
  t_eq "Anubis recorded the client's address, not Caddy's" "$CLIENT_IP" "$chal_ip"

  # What the page script sends: its own URL as redir, which Anubis then unwraps to the original.
  fetch "https://$domain/.within.website/x/cmd/anubis/api/pass-challenge" -G -L \
    -A "$BROWSER_UA" --compressed -c "$JAR" -b "$JAR" \
    --data-urlencode "id=$chal_id" --data-urlencode "response=$chal_hash" \
    --data-urlencode "nonce=$chal_nonce" --data-urlencode "redir=https://$domain$location" \
    --data-urlencode "elapsedTime=12"
  t_eq "the solved challenge ends at the origin" "200" "$FETCH_CODE"
  t_eq "on origin-a" "origin-a" "$(fetch_json '.origin')"
  t_eq "at the original URI, query intact" "$uri" "$(fetch_json '.raw_path')"
  t_contains "the pass is a cookie" "techaro.lol-anubis-auth" "$(cat "$JAR" 2>/dev/null)"

  fetch "https://$domain/shop/$RUN/next" -A "$BROWSER_UA" -b "$JAR"
  t_eq "with the pass, a later request goes straight through" "200" "$FETCH_CODE"
  t_eq "to the origin" "origin-a" "$(fetch_json '.origin')"
  # Anubis's own redirect parameter on a passing request must not become Anubis's redirect.
  fetch "https://$domain/shop/$RUN/login?redir=%2Felsewhere" -A "$BROWSER_UA" -b "$JAR"
  t_eq "a page with its own redir parameter still reaches the origin" "200" "$FETCH_CODE"
  t_eq "with the query intact" "/shop/$RUN/login?redir=%2Felsewhere" "$(fetch_json '.raw_path')"
fi

# ── Policy decisions ───────────────────────────────────────────────────────

fetch "https://$domain/allowed/$RUN" -A "$ALLOWED_UA"
t_eq "an allowed user agent reaches the origin" "200" "$FETCH_CODE"
t_eq "and is answered by it" "origin-a" "$(fetch_json '.origin')"

fetch "https://$domain/allowed/$RUN/post" -A "$ALLOWED_UA" -X POST \
  -H 'Content-Type: text/plain' --data-binary "body-$RUN"
t_eq "a POST that passes reaches the origin" "200" "$FETCH_CODE"
t_eq "with its body, which the check did not consume" "body-$RUN" "$(fetch_json '.body')"
t_eq "and its method" "POST" "$(fetch_json '.method')"

fetch "https://$domain/denied/$RUN" -A "$DENIED_UA"
t_eq "a denied user agent is refused" "403" "$FETCH_CODE"
t_eq "by Anubis, not the origin" "" "$(header_value x-origin-id)"
t_eq "the origin never sees the denied request" "" "$(origin_saw origin-a "/denied/$RUN")"

# ── Exempt paths ───────────────────────────────────────────────────────────

fetch "https://$domain/api/$RUN/items" -A "$BROWSER_UA"
t_eq "an exempt path is served without a challenge" "200" "$FETCH_CODE"
t_eq "by the origin" "origin-a" "$(fetch_json '.origin')"
# The policy would refuse this agent anywhere Anubis is asked.
t_eq "Anubis is never asked about an exempt path" "200" \
  "$(http_code "https://$domain/api/$RUN/denied" -A "$DENIED_UA")"

# ── The address Anubis is told ─────────────────────────────────────────────

t_eq "a rule on the client's address matches" "403" \
  "$(http_code "https://$domain/address-probe/client" -A "$ALLOWED_UA")"
t_eq "a rule on Caddy's address does not" "200" \
  "$(http_code "https://$domain/address-probe/caddy" -A "$ALLOWED_UA")"
t_eq "a client cannot claim Caddy's address" "200" \
  "$(http_code "https://$domain/address-probe/caddy" -A "$ALLOWED_UA" \
    -H "X-Real-Ip: $CADDY_IP" -H "X-Forwarded-For: $CADDY_IP")"
t_eq "or shed its own" "403" \
  "$(http_code "https://$domain/address-probe/client" -A "$ALLOWED_UA" \
    -H 'X-Real-Ip: 10.9.9.9' -H 'X-Forwarded-For: 10.9.9.9')"

# ── What the check carries (an echo standing in for Anubis) ────────────────

echo_domain=$(domain_for "bot-challenge-echo")
create_host_or_fail "a host checking against an echo can be created" "$(jq -nc --arg d "$echo_domain" '{
    name: "docker-test bot challenge echo", domains: [$d], upstreams: ["origin-b:8080"],
    sslForced: false, anubis: {enabled: true, upstream: "http://origin-a:8080"}
  }')" && pass "a host checking against an echo can be created"
wait_for_http "http://$echo_domain/__health" 60

fetch "http://$echo_domain/.within.website/$RUN/asset.js" -H 'Authorization: Bearer secret-token'
t_eq "the challenge prefix is proxied to Anubis's upstream" "origin-a" "$(fetch_json '.origin')"
t_eq "with the path unchanged" "/.within.website/$RUN/asset.js" "$(fetch_json '.raw_path')"
t_eq "without Authorization" "absent" "$(fetch_json '.headers.authorization // "absent"')"
t_eq "naming the client in X-Real-Ip" "$CLIENT_IP" "$(fetch_json '.headers["x-real-ip"]')"
t_eq "and X-Forwarded-For" "$CLIENT_IP" "$(fetch_json '.headers["x-forwarded-for"]')"

fetch "http://$echo_domain/page/$RUN?x=1&y=2" -A "$BROWSER_UA" \
  -H 'Authorization: Bearer secret-token' -H 'Cookie: session=abc' -X POST --data-binary 'form=1'
t_eq "a 2xx from the check continues to the host's upstream" "origin-b" "$(fetch_json '.origin')"
t_eq "which still gets Authorization" "Bearer secret-token" "$(fetch_json '.headers.authorization')"
t_eq "and the body" "form=1" "$(fetch_json '.body')"

check=$(check_saw origin-a "/page/$RUN?x=1&y=2" | tail -n1)
if [ -z "$check" ]; then
  fail "the check subrequest reached Anubis" "no request with that X-Forwarded-Uri on origin-a"
else
  pass "the check subrequest reached Anubis"
  cj() { printf '%s' "$check" | jq -r "$1"; }
  t_eq "the check is a GET" "GET" "$(cj '.method')"
  t_eq "to the check endpoint alone, no query" "$CHECK_URI" "$(cj '.raw_path')"
  t_eq "the check never carries Authorization" "absent" "$(cj '.headers.authorization // "absent"')"
  t_eq "it carries the pass cookie Anubis reads" "session=abc" "$(cj '.headers.cookie')"
  t_eq "the client in X-Real-Ip" "$CLIENT_IP" "$(cj '.headers["x-real-ip"]')"
  t_eq "the original method" "POST" "$(cj '.headers["x-forwarded-method"]')"
  t_eq "the original host" "$echo_domain" "$(cj '.headers["x-forwarded-host"]')"
  t_eq "the original scheme" "http" "$(cj '.headers["x-forwarded-proto"]')"
  t_eq "the user agent, for the policy" "$BROWSER_UA" "$(cj '.headers["user-agent"]')"
fi

# The dashboard host is not covered here: no REST surface configures it, and the editor strips the
# challenge from its options. caddy-anubis.test.ts holds the builder's own guard.

finish
