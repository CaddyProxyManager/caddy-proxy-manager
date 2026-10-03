#!/usr/bin/env bash
# DNS-01 through a challenge delegation, against a real acme-dns. The names live in dyn.cpm.test,
# whose `_acme-challenge` CNAMEs the rig's DNS follows into acme-dns, as a registrar's would: Pebble
# validates by asking the rig's DNS for the TXT, so a certificate here means the CNAME was followed.
# Two shapes: a delegation with a target (override_domain) and an account registered by hand, both
# set over REST, and Settings → Register with acme-dns, which adds a delegation with no target.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "DNS challenge delegation"

ACME_DNS_URL=http://acme-dns
ACME_DNS_IP=172.28.0.27
SETTINGS_PAGE=/settings/dns

rest_domain="rest.$DYN_DOMAIN"
act_domain="act.$DYN_DOMAIN"
wild_name="x.$act_domain"

restore() {
  api PUT /api/v1/settings/dns-provider '{"providers":{},"default":null}' >/dev/null 2>&1
  api PUT /api/v1/settings/dns '{"enabled":false,"resolvers":[]}' >/dev/null 2>&1
  local name
  for name in "$rest_domain" "_acme-challenge.$rest_domain" "$act_domain" \
              "_acme-challenge.$act_domain" "*.$act_domain"; do
    rig_dns_del "$name" "" --no-wait
  done
  rig_zone_write
}
trap 'cleanup_tracked; restore' EXIT

# The TXT values acme-dns holds for an account, one per line.
acme_dns_txt() { dig +short +norec @"$ACME_DNS_IP" "$1" TXT 2>/dev/null | tr -d '"' | grep -v '^$'; }

# The automation policy Caddy is running for NAME.
tls_policy() {
  curl -sS --max-time 10 "http://caddy:2019/config/apps/tls/automation/policies" 2>/dev/null \
    | jq -c --arg n "$1" 'first(.[] | select((.subjects // []) | index($n)))'
}

check_status() {  # check_status DOMAIN - from the last checkDnsDelegationsAction result
  printf '%s' "$ACTION_RESULT" | jq -r --arg d "$1" 'first(.[] | select(.domain == $d)) | .status'
}

# The challenge's resolvers come from the global DNS settings; point them at the rig's.
api_expect "the global resolvers can point at the rig's DNS" 200 PUT /api/v1/settings/dns \
  "$(jq -nc --arg r "$RIG_DNS" '{enabled:true, resolvers:[$r]}')"

# ── REST: an account registered by hand, a delegation with a target ────────

register=$(curl -sS --max-time 10 -X POST "$ACME_DNS_URL/register" 2>/dev/null)
rest_target=$(printf '%s' "$register" | jq -r '.fulldomain // empty')
t_matches "acme-dns registers an account" "^[0-9a-f-]{36}\.acmedns\.cpm\.test$" "$rest_target"

rig_dns_set "$rest_domain" A "$CADDY_IP"
rig_dns_set "_acme-challenge.$rest_domain" CNAME "$rest_target."

api_expect "a delegation with a target and its acme-dns account can be saved over REST" 200 \
  PUT /api/v1/settings/dns-provider "$(printf '%s' "$register" | jq -c \
    --arg d "$rest_domain" --arg url "$ACME_DNS_URL" '{
      providers: {acmedns: {}},
      default: null,
      delegations: [{domain: $d, target: .fulldomain, provider: "acmedns"}],
      acmeDnsAccounts: {($d): {username, password, subdomain, fulldomain, server_url: $url}}
    }')"

api GET /api/v1/settings/dns-provider
t_eq "the delegation reads back with its target" "$rest_target" \
  "$(jqr 'first(.delegations[] | select(.domain == $d)) | .target' --arg d "$rest_domain")"
t_not_contains "the account password is never read back" \
  "$(printf '%s' "$register" | jq -r .password)" "$API_BODY"

create_host_or_fail "a host under the delegated domain can be created" "$(jq -nc --arg d "$rest_domain" \
  '{name:"docker-test dns delegation rest", domains:[$d], upstreams:["origin-a:8080"]}')" \
  && pass "a host under the delegated domain can be created"

policy=$(tls_policy "$rest_domain")
t_eq "Caddy writes the challenge at the target (override_domain)" "$rest_target" \
  "$(printf '%s' "$policy" | jq -r '.issuers[0].challenges.dns.override_domain')"
t_eq "through the acme-dns module" "acmedns" \
  "$(printf '%s' "$policy" | jq -r '.issuers[0].challenges.dns.provider.name')"
# The module finds an account by the name it writes, here the target, not the domain.
t_eq "with the domain's account under the target's name" "$rest_target" \
  "$(printf '%s' "$policy" | jq -r --arg t "$rest_target" \
    '.issuers[0].challenges.dns.provider.config[$t].fulldomain')"
t_eq "with the rig's DNS as the challenge resolver" "$RIG_DNS" \
  "$(printf '%s' "$policy" | jq -r '.issuers[0].challenges.dns.resolvers[0]')"
t_eq "and no other challenge type left to fall back on" "null" \
  "$(printf '%s' "$policy" | jq -r '.issuers[0].challenges.http // null')"

if wait_for_https "$rest_domain" 180; then
  pass "a certificate is issued over DNS-01 through the delegation"
else
  fail "a certificate is issued over DNS-01 through the delegation" "no usable certificate for $rest_domain"
fi
t_contains "it was issued by Pebble" "Pebble" "$(tls_field "$rest_domain" -issuer)"
t_contains "it names the delegated host" "DNS:$rest_domain" \
  "$(tls_cert "$rest_domain" | openssl x509 -noout -ext subjectAltName 2>/dev/null)"
fetch "https://$rest_domain/"
t_eq "the host serves over it" "200" "$FETCH_CODE"

rest_txt=$(acme_dns_txt "$rest_target")
t_matches "the challenge TXT landed on acme-dns" "^[A-Za-z0-9_-]{43}$" "$(printf '%s' "$rest_txt" | head -n1)"
# What Pebble asked: the challenge name, answered through the CNAME.
followed=$(dig +short @"$RIG_DNS" "_acme-challenge.$rest_domain" TXT 2>/dev/null)
t_contains "the challenge name resolves through the CNAME" "$rest_target." "$followed"
t_contains "to the TXT on acme-dns" "$(printf '%s' "$rest_txt" | head -n1)" "$followed"

# ── Dashboard: Register with acme-dns, the CNAME, the check ─────────────────

server_action "$SETTINGS_PAGE" registerAcmeDnsAccountAction --form \
  "domain=$act_domain" "serverUrl=http://acme.$TEST_DOMAIN"
t_eq "Register refuses plain http to a public-looking server" "false" \
  "$(printf '%s' "$ACTION_RESULT" | jq -r '.success' 2>/dev/null)"
t_contains "saying it needs HTTPS" "HTTPS" "$ACTION_RESULT"

if server_action "$SETTINGS_PAGE" registerAcmeDnsAccountAction --form \
     "domain=$act_domain" "serverUrl=$ACME_DNS_URL" &&
   [ "$(printf '%s' "$ACTION_RESULT" | jq -r '.success')" = "true" ]; then
  pass "Register creates an account on acme-dns"
else
  fail "Register creates an account on acme-dns" "$(printf '%.300s' "$ACTION_RESULT")"
fi
act_target=$(printf '%s' "$ACTION_RESULT" | jq -r '.cname.target // empty')
t_eq "it names the record to create" "_acme-challenge.$act_domain" \
  "$(printf '%s' "$ACTION_RESULT" | jq -r '.cname.name')"
t_matches "pointing at the new account" "^[0-9a-f-]{36}\.acmedns\.cpm\.test$" "$act_target"
t_eq "the change is staged, not applied" "true" "$(printf '%s' "$ACTION_RESULT" | jq -r '.staged')"

server_action "$SETTINGS_PAGE" applyStagedSettingsAction
t_eq "the staged change applies" "true" "$(printf '%s' "$ACTION_RESULT" | jq -r '.success' 2>/dev/null)"

api GET /api/v1/settings/dns-provider
t_eq "the account is stored for the domain" "$act_target" \
  "$(jqr '.acmeDnsAccounts[$d].fulldomain' --arg d "$act_domain")"
t_eq "with a delegation to acme-dns and no target" "acmedns|null" \
  "$(jqr 'first(.delegations[] | select(.domain == $d)) | "\(.provider)|\(.target)"' --arg d "$act_domain")"
t_eq "the delegation saved over REST is kept" "$rest_target" \
  "$(jqr 'first(.delegations[] | select(.domain == $d)) | .target' --arg d "$rest_domain")"

server_action "$SETTINGS_PAGE" checkDnsDelegationsAction
t_eq "the check reports the CNAME missing before it exists" "missing" "$(check_status "$act_domain")"
t_eq "and the REST delegation's CNAME in place" "ok" "$(check_status "$rest_domain")"

rig_dns_set "_acme-challenge.$act_domain" CNAME "$act_target."
server_action "$SETTINGS_PAGE" checkDnsDelegationsAction
t_eq "the check reports ok once the CNAME exists" "ok" "$(check_status "$act_domain")"
t_eq "having found the account's name" "$act_target" \
  "$(printf '%s' "$ACTION_RESULT" | jq -r --arg d "$act_domain" \
    'first(.[] | select(.domain == $d)) | .found[0] | rtrimstr(".")')"

# ── A name and its wildcard on the registered account ───────────────────────
#
# Both answer at `_acme-challenge.<name>`, so both challenges go to the one account, which keeps
# the two newest TXT values - the case the per-domain account is sized for.

rig_dns_set "$act_domain" A "$CADDY_IP"
rig_dns_set "*.$act_domain" A "$CADDY_IP"

create_host_or_fail "a host for a name and its wildcard can be created" "$(jq -nc --arg d "$act_domain" \
  '{name:"docker-test dns delegation acme-dns", domains:[$d, "*." + $d], upstreams:["origin-a:8080"]}')" \
  && pass "a host for a name and its wildcard can be created"

policy=$(tls_policy "$act_domain")
t_eq "the registered domain's challenge has no override" "null" \
  "$(printf '%s' "$policy" | jq -r '.issuers[0].challenges.dns.override_domain // null')"
t_eq "the module is given that domain's account" "$act_target" \
  "$(printf '%s' "$policy" | jq -r --arg d "$act_domain" '.issuers[0].challenges.dns.provider.config[$d].fulldomain')"

if wait_for_https "$act_domain" 180 && wait_for_https "$wild_name" 180; then
  pass "the name and its wildcard both get certificates through the account"
else
  fail "the name and its wildcard both get certificates through the account" \
    "no usable certificate for $act_domain or $wild_name"
fi
t_contains "the wildcard certificate is Pebble's" "Pebble" "$(tls_field "$wild_name" -issuer)"
t_contains "and covers the wildcard" "DNS:*.$act_domain" \
  "$(tls_cert "$wild_name" | openssl x509 -noout -ext subjectAltName 2>/dev/null)"
fetch "https://$wild_name/"
t_eq "a name under the wildcard is served" "200" "$FETCH_CODE"

t_eq "both challenges were written to the one account" "2" \
  "$(acme_dns_txt "$act_target" | sort -u | grep -cE '^[A-Za-z0-9_-]{43}$')"

finish
