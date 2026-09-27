#!/usr/bin/env bash
# An agent in external build mode (CADDY_BUILD_MODE=external), behind a socket proxy that denies
# BuildKit: it pairs itself, reports the image Caddy runs, and on "Load built image" swaps Caddy onto
# the operator's image, taking the applied modules from that image. The image here has one DNS
# module, so the swap drops every module the running config may use, and Caddy must still come up.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "external caddy build"

EXTERNAL_IMAGE=cpm-test/caddy:external
CLOUDFLARE=github.com/caddy-dns/cloudflare

build_state() { api_session GET /api/caddy-build; }

agent_is_external() {
  build_state
  # The image is read on its first reconcile, a report or two after it connects.
  [ "$API_STATUS" = "200" ] && [ "$(jqr '.external | length')" = "1" ] &&
    [ "$(jqr '.external[0].image')" != "null" ]
}

# ── The agent pairs and says it will not build ──────────────────────────────

if wait_for "the agent to pair and report external build mode" 180 agent_is_external; then
  pass "the agent pairs itself and reports external build mode"
else
  fail "the agent pairs itself and reports external build mode" \
    "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
  finish
fi

build_state
t_eq "no agent builds its own image" "0" "$(jqr '.builders')"
t_eq "it reports the image Caddy runs now" "cpm-test/caddy:latest" "$(jqr '.external[0].image')"
t_eq "the applied set comes from that image, not an assumption" "true" \
  "$(jqr '.diff.appliedSpecs | index("github.com/mholt/caddy-l4") != null')"

# ── A host serving before the swap ──────────────────────────────────────────

swap=$(domain_for "external-swap")
create_host_or_fail "a host can be created before the swap" "$(jq -nc --arg d "$swap" '{
  name: "docker-test external swap", domains: [$d], upstreams: ["origin-a:8080"]
}')" && pass "a host can be created before the swap"
wait_for_https "$swap" 120
fetch "https://$swap/"
t_eq "the host serves before the swap" "200" "$FETCH_CODE"

# ── Load built image ────────────────────────────────────────────────────────

# The agent's first frames may still hold its one-at-a-time lock (a services stop, say).
loaded=0
for _ in $(seq 1 20); do
  api_session POST /api/caddy-build/image
  if [ "$API_STATUS" = "200" ]; then loaded=1; break; fi
  case "$API_BODY" in *"already running"*) sleep 3 ;; *) break ;; esac
done
if [ "$loaded" = "1" ]; then
  pass "the load is accepted"
else
  fail "the load is accepted" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
  finish
fi

load_settled() {
  build_state
  case "$(jqr '.status.state')" in applied|failed) return 0 ;; *) return 1 ;; esac
}
wait_for "the load to finish" 300 load_settled
build_state
t_eq "the load succeeds on an image with fewer modules" "applied" "$(jqr '.status.state')" \
  || info "status: $(jqr '.status')"
t_eq "the agent now reports the loaded image" "$EXTERNAL_IMAGE" "$(jqr '.external[0].image')"
t_eq "the applied set is that image's own list" "[\"$CLOUDFLARE\"]" "$(jqr -c '.diff.appliedSpecs')"
t_eq "what the selection wants but the image lacks shows as still to add" "true" \
  "$(jqr '.diff.added | index("github.com/mholt/caddy-l4") != null')"

# ── Caddy came back on the new image ────────────────────────────────────────

if wait_for "the host to serve again on the new image" 120 \
     bash -c "curl -sS --max-time 5 -o /dev/null -w '%{http_code}' --cacert '$CA_BUNDLE' 'https://$swap/' | grep -q 200"; then
  pass "the host serves after the swap"
else
  fetch "https://$swap/"
  fail "the host serves after the swap" "HTTP $FETCH_CODE: $(printf '%.200s' "$FETCH_BODY")"
fi

# Nothing changed, so the second load recreates nothing and still reads the list.
api_session POST /api/caddy-build/image
t_eq "loading the same image again is accepted" "200" "$API_STATUS"
wait_for "the second load to finish" 180 load_settled
build_state
t_eq "loading the same image again changes nothing" "[\"$CLOUDFLARE\"]" \
  "$(jqr -c '.diff.appliedSpecs')"

finish
