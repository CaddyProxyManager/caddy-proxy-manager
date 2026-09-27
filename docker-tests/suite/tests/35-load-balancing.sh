#!/usr/bin/env bash
# Load balancing across several upstreams, plus active health checking taking a
# dead backend out of rotation.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "load balancing"

# Counts how many distinct origins answered over N requests.
origins_seen() {  # origins_seen URL COUNT [curl args...]
  local url="$1" count="$2"; shift 2
  local i
  for (( i=0; i<count; i++ )); do
    curl -sS --max-time 5 --cacert "$CA_BUNDLE" "$@" "$url" 2>/dev/null \
      | jq -r '.origin // "none"' 2>/dev/null
  done | sort -u | tr '\n' ' ' | sed 's/ *$//'
}

# ── Round robin ─────────────────────────────────────────────────────────────

rr=$(domain_for "lb-round-robin")
create_host_or_fail "a round-robin host can be created" "$(jq -nc --arg d "$rr" '{
  name: "docker-test lb round robin",
  domains: [$d],
  upstreams: ["origin-a:8080", "origin-b:8080"],
  loadBalancer: { enabled: true, policy: "round_robin" }
}')" && pass "a round-robin host can be created"

wait_for_https "$rr" 120

seen=$(origins_seen "https://$rr/" 12)
t_eq "round robin reaches both upstreams" "origin-a origin-b" "$seen"

# ── First-available ─────────────────────────────────────────────────────────
#
# The `first` policy always picks the first *available* upstream, so with both
# healthy every request must land on origin-a.

first=$(domain_for "lb-first")
create_host_or_fail "a first-available host can be created" "$(jq -nc --arg d "$first" '{
  name: "docker-test lb first",
  domains: [$d],
  upstreams: ["origin-a:8080", "origin-b:8080"],
  loadBalancer: { enabled: true, policy: "first" }
}')" && pass "a first-available host can be created"

wait_for_https "$first" 120

seen=$(origins_seen "https://$first/" 8)
t_eq "the first policy pins traffic to the first upstream" "origin-a" "$seen"

# ── Sticky by client IP ─────────────────────────────────────────────────────
#
# One client means one bucket: every request has to land on the same upstream,
# whichever one the hash picks.

sticky=$(domain_for "lb-ip-hash")
create_host_or_fail "an ip_hash host can be created" "$(jq -nc --arg d "$sticky" '{
  name: "docker-test lb ip hash",
  domains: [$d],
  upstreams: ["origin-a:8080", "origin-b:8080"],
  loadBalancer: { enabled: true, policy: "ip_hash" }
}')" && pass "an ip_hash host can be created"

wait_for_https "$sticky" 120

seen=$(origins_seen "https://$sticky/" 10)
t_matches "ip_hash keeps one client on one upstream" '^origin-[ab]$' "$seen"

# ── Health checking ─────────────────────────────────────────────────────────
#
# One real upstream and one refusing connections; without health checks roughly half the
# requests would fail.

hc=$(domain_for "lb-health")
create_host_or_fail "a health-checked host can be created" "$(jq -nc --arg d "$hc" '{
  name: "docker-test lb health",
  domains: [$d],
  upstreams: ["origin-a:8080", "origin-a:9"],
  loadBalancer: {
    enabled: true,
    policy: "round_robin",
    tryDuration: "5s",
    tryInterval: "250ms",
    retries: 3,
    activeHealthCheck: {
      enabled: true, uri: "/__health", interval: "1s", timeout: "1s", status: 200
    }
  }
}')" && pass "a health-checked host can be created"

wait_for_https "$hc" 120

# Give the health checker a couple of intervals to mark the dead upstream down.
sleep 4

failures=0
for _ in $(seq 1 12); do
  code=$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' --cacert "$CA_BUNDLE" "https://$hc/" 2>/dev/null)
  [ "$code" = "200" ] || failures=$((failures + 1))
done
t_eq "a dead upstream is taken out of rotation" "0" "$failures"

seen=$(origins_seen "https://$hc/" 6)
t_eq "only the healthy upstream answers" "origin-a" "$seen"

# ── Per-location load balancing ─────────────────────────────────────────────

locrr=$(domain_for "lb-location")
create_host_or_fail "a location rule can carry its own load balancer" "$(jq -nc --arg d "$locrr" '{
  name: "docker-test lb location",
  domains: [$d],
  upstreams: ["origin-a:8080"],
  locationRules: [
    { path: "/spread/*",
      upstreams: ["origin-a:8080", "origin-b:8080"],
      loadBalancer: { enabled: true, policy: "round_robin" } }
  ]
}')" && pass "a location rule can carry its own load balancer"

wait_for_https "$locrr" 120

seen=$(origins_seen "https://$locrr/spread/x" 12)
t_eq "the location rule balances across its own upstreams" "origin-a origin-b" "$seen"

seen=$(origins_seen "https://$locrr/elsewhere" 4)
t_eq "the host default is unaffected by the rule's balancer" "origin-a" "$seen"

finish
