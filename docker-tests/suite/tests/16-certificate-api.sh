#!/usr/bin/env bash
# What the certificate endpoints hand out, against what Caddy serves: an imported certificate's
# PEM over REST and the dashboard's download, its key only through the latter and only with a
# fresh sign-in, each key download audited. Caddy's own stored certificates are read in the agent
# phase, since only an agent can reach Caddy's storage (agent-tests/92-certificate-inventory).
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "certificate API"

make_ca certapi || fail "a local CA can be created" "openssl failed"
trust_ca certapi
domain=$(domain_for "certificate-api")
issue_cert certapi certapi-leaf "/CN=$domain" "DNS:$domain" serverAuth \
  || fail "a leaf can be issued" "openssl failed"

fingerprint() { openssl x509 -noout -fingerprint -sha256 2>/dev/null | sed 's/.*=//'; }
key_pubkey() { openssl pkey -pubout 2>/dev/null | sha256sum | cut -d' ' -f1; }
cert_pubkey() { openssl x509 -noout -pubkey 2>/dev/null | openssl pkey -pubin -pubout 2>/dev/null | sha256sum | cut -d' ' -f1; }

if create_resource certificates "$(jq -nc --arg d "$domain" --rawfile crt "$STATE_DIR/certapi-leaf.crt.pem" \
     --rawfile key "$STATE_DIR/certapi-leaf.key.pem" \
     '{name:"docker-test certificate api", type:"imported", domainNames:[$d], certificatePem:$crt, privateKeyPem:$key}')"; then
  pass "a certificate can be imported"
else
  fail "a certificate can be imported" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
  finish
fi
cert_id=$NEW_ID
t_eq "the import reports a key without returning it" "true|null" "$(jqr '"\(.hasPrivateKey)|\(.privateKeyPem)"')"

create_host_or_fail "a host on it can be created" "$(jq -nc --arg d "$domain" --argjson c "$cert_id" \
  '{name:"docker-test certificate api", domains:[$d], upstreams:["origin-a:8080"], certificateId:$c}')" \
  && pass "a host on it can be created"
wait_for_https "$domain" 60 || fail "the imported certificate is served" "no TLS to $domain"
served=$(tls_cert "$domain" | fingerprint)

api GET "/api/v1/certificates/$cert_id"
t_eq "REST returns the PEM Caddy serves" "$served" "$(jqr '.certificatePem' | fingerprint)"
t_not_contains "and never the key" "PRIVATE KEY" "$API_BODY"
api GET /api/v1/certificates
t_eq "the listing carries the same PEM" "$served" \
  "$(jqr 'first(.[] | select(.id == $i)) | .certificatePem' --argjson i "$cert_id" | fingerprint)"

api_session GET "/api/certificates/$cert_id/download"
t_eq "the dashboard's download is the served certificate" "200|$served" \
  "$API_STATUS|$(jqr '.certificatePem' | fingerprint)"
t_eq "without its key unless asked" "null" "$(jqr '.keyPem')"

fresh_session || fail "the admin can sign in again" "$SIGN_IN_BODY"
api_session GET "/api/certificates/$cert_id/download?key=1"
t_eq "a fresh session can download the key" "200" "$API_STATUS"
t_eq "which is the key of the served certificate" "$(tls_cert "$domain" | cert_pubkey)" "$(jqr '.keyPem' | key_pubkey)"

api GET "/api/v1/audit-log?per_page=20"
t_contains "downloading a key is audited" "certificate_key_exported" "$API_BODY"

api GET "/api/certificates/$cert_id/download"
t_eq "the download is for a signed-in session, not a token" "307" "$API_STATUS"
api_session GET /api/certificates/999999/download
t_eq "an unknown certificate is a 404" "404" "$API_STATUS"

# ── Changing and deleting ───────────────────────────────────────────────────

api PUT "/api/v1/certificates/$cert_id" '{"name":"docker-test certificate api renamed"}'
t_eq "a certificate can be renamed" "200|docker-test certificate api renamed" "$API_STATUS|$(jqr '.name')"
fetch "https://$domain/"
t_eq "without disturbing what is served" "200" "$FETCH_CODE"

make_ca certapi2 && trust_ca certapi2
issue_cert certapi2 certapi-leaf2 "/CN=$domain" "DNS:$domain" serverAuth
api PUT "/api/v1/certificates/$cert_id" "$(jq -nc --rawfile crt "$STATE_DIR/certapi-leaf2.crt.pem" \
  --rawfile key "$STATE_DIR/certapi-leaf2.key.pem" '{certificatePem:$crt, privateKeyPem:$key}')"
t_eq "a replacement PEM can be uploaded" "200" "$API_STATUS"
replaced() { tls_field "$domain" -issuer | grep -q "certapi2"; }
if wait_for "Caddy to serve the replacement" 30 replaced; then
  pass "Caddy serves the replacement"
else
  fail "Caddy serves the replacement" "issuer still $(tls_field "$domain" -issuer)"
fi

# Regression: this was stored, and Caddy then refused every config until someone fixed it.
api PUT "/api/v1/certificates/$cert_id" "$(jq -nc --rawfile key "$STATE_DIR/certapi-leaf.key.pem" '{privateKeyPem:$key}')"
t_eq "a key that does not match the certificate is refused" "400" "$API_STATUS"
api POST /api/v1/caddy/apply
t_eq "and Caddy keeps taking configs" "200" "$API_STATUS"
api POST /api/v1/certificates "$(jq -nc --arg d "$domain" --rawfile key "$STATE_DIR/certapi-leaf.key.pem" \
  '{name:"docker-test certificate api garbage", type:"imported", domainNames:[$d],
    certificatePem:"-----BEGIN CERTIFICATE-----\nnot\n-----END CERTIFICATE-----", privateKeyPem:$key}')"
t_eq "so is a certificate that does not parse" "400" "$API_STATUS"

finish
