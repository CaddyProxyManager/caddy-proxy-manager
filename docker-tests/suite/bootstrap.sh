#!/usr/bin/env bash
# Prepares the runner before any test file executes: waits for the CPM API and Pebble, signs in as
# the seeded admin and mints a bearer token, builds the CA bundle the client verifies Caddy with,
# and points CPM's ACME settings at Pebble so every auto-managed host gets a real, validated
# certificate without the network leaving the rig. State lands in $STATE_DIR, read by lib.sh.
set -uo pipefail

SUITE_NAME=bootstrap
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PEBBLE_MGMT="${PEBBLE_MGMT:-https://pebble:15000}"
PEBBLE_DIRECTORY="${PEBBLE_DIRECTORY:-https://pebble:14000/dir}"
PEBBLE_ENDPOINT_CA=/certs/pebble-ca.crt.pem
COOKIE_JAR="$STATE_DIR/cookies.txt"

die() { printf '%sbootstrap: %s%s\n' "$C_RED" "$*" "$C_OFF" >&2; exit 1; }

# ── 1. Wait for the moving parts ────────────────────────────────────────────

banner "bootstrap"

wait_for "the CPM API" 120 curl -sSf --max-time 5 -o /dev/null "$CPM_API/api/health" \
  || die "web never became healthy at $CPM_API"
info "CPM API is up"

wait_for "Pebble's directory" 120 \
  curl -sSf --max-time 5 -o /dev/null --cacert "$PEBBLE_ENDPOINT_CA" "$PEBBLE_DIRECTORY" \
  || die "pebble never served $PEBBLE_DIRECTORY"
info "Pebble ACME directory is up"

# An empty dyn.cpm.test: CoreDNS serves nothing for it until the file exists.
: >"$RIG_ZONE_DIR/records"
rig_zone_write
wait_for "CoreDNS to load dyn.cpm.test" 30 \
  bash -c "dig +norec @$COREDNS '$DYN_DOMAIN' SOA | grep -q 'status: NOERROR'" \
  || die "CoreDNS never loaded $RIG_ZONE_DIR/db.$DYN_DOMAIN"
info "rig DNS zone $DYN_DOMAIN is up"

# ── 2. Sign in and mint an API token ────────────────────────────────────────

rm -f "$COOKIE_JAR"

status=$(cpm_sign_in "$CPM_API" "$COOKIE_JAR" "$CPM_ADMIN_USER" "$CPM_ADMIN_PASSWORD")
[ "$status" = "200" ] || die "admin sign-in failed (HTTP $status): $SIGN_IN_BODY"
info "signed in as $CPM_ADMIN_USER"

# A user holds at most ten tokens, and every run mints one: a rig kept up would run out.
api_session GET /api/v1/tokens
for stale in $(jqr '.[]? | select(.name == "docker-test-suite") | .id'); do
  api_session DELETE "/api/v1/tokens/$stale"
done

cpm_mint_token "$CPM_API" "$COOKIE_JAR" "docker-test-suite" >"$TOKEN_FILE"
[ -s "$TOKEN_FILE" ] || die "could not mint an API token - the response carried no raw_token"
chmod 600 "$TOKEN_FILE"
info "minted an API token for the suite"

# ── 3. Build the client's trust store ───────────────────────────────────────
#
# Two CAs: the one signing Pebble's HTTPS endpoint (certgen) and the one Pebble issues from,
# generated at startup and so fetched rather than baked in.

: >"$CA_BUNDLE"
# Rebuilt from scratch, so trust_ca's "already added" markers go too - or a second run would
# skip the local CAs and every imported-certificate test would fail to verify.
rm -f "$STATE_DIR"/.trusted-*
cat "$PEBBLE_ENDPOINT_CA" >>"$CA_BUNDLE"

roots_ok=0
for index in 0 1; do
  if curl -sSf --max-time 10 --cacert "$PEBBLE_ENDPOINT_CA" \
      "$PEBBLE_MGMT/roots/$index" >>"$CA_BUNDLE" 2>/dev/null; then
    roots_ok=1
  fi
done
[ "$roots_ok" = "1" ] || die "could not fetch Pebble's issuing root from $PEBBLE_MGMT/roots/0"

# Pebble issues from an intermediate; Caddy staples it, but fetching it too
# keeps `openssl verify` usable directly against the bundle.
curl -sSf --max-time 10 --cacert "$PEBBLE_ENDPOINT_CA" \
  "$PEBBLE_MGMT/intermediates/0" >>"$CA_BUNDLE" 2>/dev/null || true

info "CA bundle has $(grep -c 'BEGIN CERTIFICATE' "$CA_BUNDLE") certificate(s)"

# ── 4. Point CPM at the in-network ACME server ──────────────────────────────

acme_body=$(jq -nc --arg url "$PEBBLE_DIRECTORY" --rawfile root "$PEBBLE_ENDPOINT_CA" \
  '{caUrl:$url, caRootPem:$root}')
api PUT "/api/v1/settings/acme" "$acme_body"
[ "$API_STATUS" = "200" ] || die "could not save ACME settings (HTTP $API_STATUS): $API_BODY"

general_body=$(jq -nc --arg d "$TEST_DOMAIN" '{defaultDomain:$d, acmeEmail:"docker-tests@cpm.test"}')
api PUT "/api/v1/settings/general" "$general_body"
[ "$API_STATUS" = "200" ] || die "could not save general settings (HTTP $API_STATUS): $API_BODY"

info "CPM will issue certificates from $PEBBLE_DIRECTORY"

# ── 4b. Snapshot the declared API surface ───────────────────────────────────
#
# Measured by run-tests.sh; taken from the running instance so it describes the build under test.

api GET /api/v1/openapi.json
if [ "$API_STATUS" = "200" ]; then
  printf '%s' "$API_BODY" >"$SPEC_FILE"
  info "API surface: $(jq '[.paths[] | keys[]] | length' <"$SPEC_FILE" 2>/dev/null) documented operations"
else
  rm -f "$SPEC_FILE"
  info "could not fetch the OpenAPI document (HTTP $API_STATUS) - skipping API coverage"
fi

# ── 5. Prove the whole chain works before running any test ──────────────────
#
# Broken issuance would fail every HTTPS assertion for the same uninformative reason.

probe_domain=$(domain_for "bootstrap-probe")
create_host "$(jq -nc --arg d "$probe_domain" \
  '{name:"bootstrap probe", domains:[$d], upstreams:["origin-a:8080"]}')" \
  || die "could not create the probe proxy host (HTTP $API_STATUS): $API_BODY"

if wait_for_https "$probe_domain" 120; then
  info "end-to-end certificate issuance verified against $probe_domain"
else
  die "Caddy never obtained a certificate for $probe_domain - check 'docker compose logs caddy pebble'"
fi

printf '%sbootstrap complete%s\n' "$C_GREEN" "$C_OFF"
