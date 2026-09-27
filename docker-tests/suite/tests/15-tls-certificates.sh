#!/usr/bin/env bash
# Certificates: ACME issuance against the in-network CA, imported certificates,
# wildcards, and multi-domain hosts.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "TLS certificates"

# ── ACME issuance ───────────────────────────────────────────────────────────
#
# The rig has no internet route, so a valid certificate can only have come from
# Pebble over a real HTTP-01 order.

acme_domain=$(domain_for "acme")
create_host_or_fail "an auto-managed host can be created" "$(jq -nc --arg d "$acme_domain" \
  '{name:"docker-test acme", domains:[$d], upstreams:["origin-a:8080"]}')" || finish
pass "an auto-managed host can be created"

if wait_for_https "$acme_domain" 120; then
  pass "Caddy obtains a certificate from the ACME server"
else
  fail "Caddy obtains a certificate from the ACME server" "no usable certificate for $acme_domain"
  finish
fi

issuer=$(tls_field "$acme_domain" -issuer)
t_contains "the certificate was issued by Pebble, not a public CA" "Pebble" "$issuer"

subject_alt=$(tls_cert "$acme_domain" | openssl x509 -noout -text 2>/dev/null | grep -A1 'Subject Alternative Name')
t_contains "the certificate covers the requested domain" "$acme_domain" "$subject_alt"

t_ok "the chain verifies against the ACME root alone" tls_handshake_ok "$acme_domain"

fetch "https://$acme_domain/"
t_eq "traffic flows over the ACME certificate" "200" "$FETCH_CODE"

# -- Renew now -----------------------------------------------------------------
#
# Caddy has no renew endpoint; CPM widens the name's renewal window and reloads.
# A fresh certificate is the only proof that worked.

# The rig runs no agent to read Caddy's storage, so the request names the certificate's dates:
# Pebble's last five years, and this one is a minute old, which no fixed window would reach.
tls_cert "$acme_domain" >"$STATE_DIR/acme-before.pem"
first_serial=$(cert_serial "$STATE_DIR/acme-before.pem")
api_session POST /api/certificates/renew "$(jq -nc --arg n "$acme_domain" \
  --arg b "$(cert_date_iso "$STATE_DIR/acme-before.pem" -startdate)" \
  --arg a "$(cert_date_iso "$STATE_DIR/acme-before.pem" -enddate)" \
  '{name:$n, notBefore:$b, notAfter:$a}')"
t_eq "Renew now is accepted for a managed name" "200" "$API_STATUS"

renewed() {
  local serial
  serial=$(tls_cert "$acme_domain" | openssl x509 -noout -serial 2>/dev/null | sed 's/.*=//')
  [ -n "$serial" ] && [ "$serial" != "$first_serial" ]
}
if wait_for "a new certificate for $acme_domain" 120 renewed; then
  pass "Renew now makes Caddy obtain a new certificate"
else
  fail "Renew now makes Caddy obtain a new certificate" "still serving $first_serial"
fi

api_session POST /api/certificates/renew '{"name":"10.0.0.1"}'
t_eq "Renew now refuses something that is not a hostname" "400" "$API_STATUS"

# ── Several domains on one host ─────────────────────────────────────────────

alpha=$(domain_for "multi-alpha")
beta=$(domain_for "multi-beta")
create_host_or_fail "a host can carry several domains" "$(jq -nc --arg a "$alpha" --arg b "$beta" \
  '{name:"docker-test multi", domains:[$a,$b], upstreams:["origin-a:8080"]}')" \
  && pass "a host can carry several domains"

if wait_for_https "$alpha" 120 && wait_for_https "$beta" 120; then
  pass "every domain on the host gets a certificate"
else
  fail "every domain on the host gets a certificate" "one of $alpha / $beta never became usable"
fi

fetch "https://$alpha/"
t_eq "the first domain routes to the upstream" "200" "$FETCH_CODE"
fetch "https://$beta/"
t_eq "the second domain routes to the same upstream" "200" "$FETCH_CODE"
t_eq "the second domain forwards its own Host" "$beta" "$(fetch_json '.host')"

# ── Imported certificates ───────────────────────────────────────────────────
#
# An operator-supplied certificate must take precedence over ACME: Caddy should
# serve exactly the bytes that were uploaded and never attempt an order.

make_ca imported || fail "the local test CA can be created" "openssl failed"
trust_ca imported

imported_domain=$(domain_for "imported")
issue_cert imported imported-leaf "/CN=$imported_domain" "DNS:$imported_domain" serverAuth \
  || fail "a leaf certificate can be issued locally" "openssl failed"

cert_body=$(jq -nc --arg d "$imported_domain" \
  --rawfile crt "$STATE_DIR/imported-leaf.crt.pem" \
  --rawfile key "$STATE_DIR/imported-leaf.key.pem" \
  --rawfile ca "$STATE_DIR/imported-ca.crt.pem" \
  '{name:"docker-test imported", type:"imported", domainNames:[$d],
    certificatePem:($crt + $ca), privateKeyPem:$key}')

if create_resource certificates "$cert_body"; then
  pass "a certificate can be imported"
  cert_id="$NEW_ID"
  t_eq "the imported certificate reports its type" "imported" "$(jqr '.type')"

  create_host_or_fail "a host can use an imported certificate" "$(jq -nc \
    --arg d "$imported_domain" --argjson c "$cert_id" \
    '{name:"docker-test imported host", domains:[$d], upstreams:["origin-a:8080"], certificateId:$c}')" \
    && pass "a host can use an imported certificate"

  if wait_for_https "$imported_domain" 60; then
    pass "the imported certificate is served"
    served_issuer=$(tls_field "$imported_domain" -issuer)
    t_contains "the served certificate came from the local CA" "CPM Docker Test imported CA" "$served_issuer"
    t_not_contains "no ACME order was placed for the imported domain" "Pebble" "$served_issuer"

    fetch "https://$imported_domain/"
    t_eq "traffic flows over the imported certificate" "200" "$FETCH_CODE"
  else
    fail "the imported certificate is served" "TLS to $imported_domain never verified"
  fi
else
  fail "a certificate can be imported" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
fi

api POST /api/v1/certificates \
  '{"name":"no pem","type":"imported","domainNames":["nopem.cpm.test"]}'
t_ne "an imported certificate with no PEM is rejected" "201" "$API_STATUS"

# ── Wildcards ───────────────────────────────────────────────────────────────
#
# HTTP-01 cannot issue a wildcard, so an auto-managed one needs a DNS provider;
# an explicit certificate lifts that.

api POST /api/v1/proxy-hosts \
  '{"name":"auto wildcard","domains":["*.auto-wild.cpm.test"],"upstreams":["origin-a:8080"]}'
t_ne "an auto-managed wildcard host is refused without a DNS provider" "201" "$API_STATUS"
t_contains "the refusal explains why" "DNS provider" "$API_BODY"

issue_cert imported wildcard-leaf "/CN=*.wild.$TEST_DOMAIN" \
  "DNS:*.wild.$TEST_DOMAIN,DNS:wild.$TEST_DOMAIN" serverAuth \
  || fail "a wildcard certificate can be issued locally" "openssl failed"

wild_body=$(jq -nc --arg d "*.wild.$TEST_DOMAIN" \
  --rawfile crt "$STATE_DIR/wildcard-leaf.crt.pem" \
  --rawfile key "$STATE_DIR/wildcard-leaf.key.pem" \
  --rawfile ca "$STATE_DIR/imported-ca.crt.pem" \
  '{name:"docker-test wildcard", type:"imported", domainNames:[$d],
    certificatePem:($crt + $ca), privateKeyPem:$key}')

if create_resource certificates "$wild_body"; then
  wild_cert_id="$NEW_ID"
  create_host_or_fail "a wildcard host can be created with an explicit certificate" "$(jq -nc \
    --arg d "*.wild.$TEST_DOMAIN" --argjson c "$wild_cert_id" \
    '{name:"docker-test wildcard host", domains:[$d], upstreams:["origin-b:8080"], certificateId:$c}')" \
    && pass "a wildcard host can be created with an explicit certificate"

  # Two unrelated labels, neither of which appears anywhere in the config.
  for label in anything else-entirely; do
    if wait_for "https://$label.wild.$TEST_DOMAIN/ to answer" 60 \
         curl -sS --max-time 5 -o /dev/null --cacert "$CA_BUNDLE" "https://$label.wild.$TEST_DOMAIN/"; then
      fetch "https://$label.wild.$TEST_DOMAIN/"
      t_eq "the wildcard host serves $label.wild" "200" "$FETCH_CODE"
      t_eq "the wildcard host reaches its upstream for $label" "origin-b" "$(fetch_json '.origin')"
    else
      fail "the wildcard host serves $label.wild" "no response"
    fi
  done
else
  fail "a wildcard certificate can be imported" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
fi

finish
