#!/usr/bin/env bash
# Mutual TLS end to end. The three path modes differ by enforcement layer:
#   full-site  - the TLS policy runs require_and_verify, so a certless client never handshakes (000)
#   whitelist  - TLS auth optional; only listed paths gated, certless requests get HTTP 403
#   exclusion  - TLS auth optional; everything except the listed paths gated the same way
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "mutual TLS"

ALPHA=(--cert "$STATE_DIR/mtls-alpha.crt.pem" --key "$STATE_DIR/mtls-alpha.key.pem")
BETA=(--cert "$STATE_DIR/mtls-beta.crt.pem" --key "$STATE_DIR/mtls-beta.key.pem")
STRANGER=(--cert "$STATE_DIR/mtls-stranger.crt.pem" --key "$STATE_DIR/mtls-stranger.key.pem")

# ── Client PKI ──────────────────────────────────────────────────────────────

make_ca mtls || { fail "an mTLS CA can be generated" "openssl failed"; finish; }
for leaf in alpha beta stranger; do
  issue_cert mtls "mtls-$leaf" "/CN=$leaf.client.cpm.test" "" clientAuth \
    || fail "a client certificate for $leaf can be issued" "openssl failed"
done
pass "client certificates can be issued locally"

# ── Register the CA and the certificates with CPM ────────────────────────────

if ! create_resource ca-certificates "$(jq -nc \
    --rawfile pem "$STATE_DIR/mtls-ca.crt.pem" \
    '{name:"docker-test client CA", certificatePem:$pem}')"; then
  fail "the client CA can be registered" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
  finish
fi
ca_id="$NEW_ID"
pass "the client CA can be registered"

register_client_cert() {  # register_client_cert LEAF -> NEW_ID
  local leaf="$1" file="$STATE_DIR/mtls-$1.crt.pem"
  create_resource client-certificates "$(jq -nc \
    --argjson ca "$ca_id" \
    --arg cn "$leaf.client.cpm.test" \
    --arg serial "$(cert_serial "$file")" \
    --arg fp "$(cert_fingerprint "$file")" \
    --rawfile pem "$file" \
    --arg from "$(cert_date_iso "$file" -startdate)" \
    --arg to "$(cert_date_iso "$file" -enddate)" \
    '{caCertificateId:$ca, commonName:$cn, serialNumber:$serial, fingerprintSha256:$fp,
      certificatePem:$pem, validFrom:$from, validTo:$to}')"
}

register_client_cert alpha || { fail "the alpha certificate can be registered" "$API_BODY"; finish; }
alpha_cert_id="$NEW_ID"
register_client_cert beta || { fail "the beta certificate can be registered" "$API_BODY"; finish; }
beta_cert_id="$NEW_ID"
pass "issued client certificates can be registered"

# stranger is signed by the same CA but never registered, to exercise leaf pinning.

# ── Roles ───────────────────────────────────────────────────────────────────

create_resource mtls-roles '{"name":"docker-test staff","description":"alpha only"}' \
  || { fail "an mTLS role can be created" "$API_BODY"; finish; }
staff_role="$NEW_ID"
create_resource mtls-roles '{"name":"docker-test ops","description":"beta only"}' \
  || { fail "a second mTLS role can be created" "$API_BODY"; finish; }
ops_role="$NEW_ID"
pass "mTLS roles can be created"

api POST "/api/v1/mtls-roles/$staff_role/certificates" "{\"certificateId\":$alpha_cert_id}"
t_eq "a certificate can be assigned to a role" "201" "$API_STATUS"
api POST "/api/v1/mtls-roles/$ops_role/certificates" "{\"certificateId\":$beta_cert_id}"
t_eq "a second certificate can be assigned to another role" "201" "$API_STATUS"

api GET "/api/v1/mtls-roles/$staff_role"
t_eq "the role reports its certificate count" "1" "$(jqr '.certificateCount')"

# ── Validation ──────────────────────────────────────────────────────────────

api POST /api/v1/proxy-hosts "$(jq -nc --arg d "$(domain_for mtls-empty)" '{
  name: "mtls with no trust", domains: [$d], upstreams: ["origin-a:8080"],
  mtls: { enabled: true }
}')"
t_ne "enabling mTLS with no trust material is rejected" "201" "$API_STATUS"
t_contains "the rejection explains what is missing" "mTLS is enabled" "$API_BODY"

# ── Full-site mTLS ──────────────────────────────────────────────────────────

full=$(domain_for "mtls-full")
create_host_or_fail "a full-site mTLS host can be created" "$(jq -nc --arg d "$full" --argjson r "$staff_role" '{
  name: "docker-test mtls full", domains: [$d], upstreams: ["origin-a:8080"],
  mtls: { enabled: true, trusted_role_ids: [$r] }
}')" && pass "a full-site mTLS host can be created"

if wait_for "the mTLS host to accept the alpha certificate" 120 \
     bash -c "curl -sS --max-time 8 -o /dev/null -f --cacert '$CA_BUNDLE' --cert '$STATE_DIR/mtls-alpha.crt.pem' --key '$STATE_DIR/mtls-alpha.key.pem' 'https://$full/'"; then
  pass "a trusted client certificate is admitted"
else
  fail "a trusted client certificate is admitted" \
    "code $(http_code "https://$full/" "${ALPHA[@]}")"
fi

t_eq "a client with no certificate cannot complete the handshake" "000" \
  "$(http_code "https://$full/")"

t_eq "a certificate outside the trusted role is refused" "000" \
  "$(http_code "https://$full/" "${BETA[@]}")"

t_eq "an unregistered certificate from the same CA is refused" "000" \
  "$(http_code "https://$full/" "${STRANGER[@]}")"

body=$(http_body "https://$full/deep/path" "${ALPHA[@]}")
t_contains "an admitted request reaches the upstream" "origin-a" "$body"

# Enforcement is in the handshake, so no path may get an in-band 403.
t_eq "no path escapes full-site enforcement" "000" \
  "$(http_code "https://$full/anything/at/all")"

# ── Whitelist mode (protected_paths) ────────────────────────────────────────

white=$(domain_for "mtls-whitelist")
create_host_or_fail "a whitelist-mode mTLS host can be created" "$(jq -nc --arg d "$white" --argjson r "$staff_role" '{
  name: "docker-test mtls whitelist", domains: [$d], upstreams: ["origin-a:8080"],
  mtls: { enabled: true, trusted_role_ids: [$r], protected_paths: ["/admin/*"] }
}')" && pass "a whitelist-mode mTLS host can be created"

wait_for "the whitelist host to answer" 120 \
  bash -c "curl -sS --max-time 8 -o /dev/null --cacert '$CA_BUNDLE' 'https://$white/'"

t_eq "an unprotected path is open without a certificate" "200" "$(http_code "https://$white/public")"
t_eq "a protected path is refused without a certificate" "403" "$(http_code "https://$white/admin/panel")"
t_eq "a protected path opens with a trusted certificate" "200" \
  "$(http_code "https://$white/admin/panel" "${ALPHA[@]}")"
t_eq "the catch-all stays open even for an untrusted certificate" "200" \
  "$(http_code "https://$white/public" "${STRANGER[@]}")"

body=$(http_body "https://$white/admin/panel" "${ALPHA[@]}")
t_contains "the protected path proxies through to the upstream" "origin-a" "$body"

# ── Exclusion mode (excluded_paths) ─────────────────────────────────────────

excl=$(domain_for "mtls-exclusion")
create_host_or_fail "an exclusion-mode mTLS host can be created" "$(jq -nc --arg d "$excl" --argjson r "$staff_role" '{
  name: "docker-test mtls exclusion", domains: [$d], upstreams: ["origin-a:8080"],
  mtls: { enabled: true, trusted_role_ids: [$r], excluded_paths: ["/health", "/public/*"] }
}')" && pass "an exclusion-mode mTLS host can be created"

wait_for "the exclusion host to answer" 120 \
  bash -c "curl -sS --max-time 8 -o /dev/null --cacert '$CA_BUNDLE' 'https://$excl/health'"

t_eq "an excluded path is open without a certificate" "200" "$(http_code "https://$excl/health")"
t_eq "an excluded prefix is open without a certificate" "200" "$(http_code "https://$excl/public/logo.png")"
t_eq "everything else is refused without a certificate" "403" "$(http_code "https://$excl/private")"
t_eq "everything else opens with a trusted certificate" "200" \
  "$(http_code "https://$excl/private" "${ALPHA[@]}")"

# ── Per-path RBAC ───────────────────────────────────────────────────────────
#
# Both certificates pass TLS here, so the HTTP layer must tell them apart by fingerprint.

rbac=$(domain_for "mtls-rbac")
create_host_or_fail "an mTLS host trusting two roles can be created" "$(jq -nc --arg d "$rbac" \
  --argjson s "$staff_role" --argjson o "$ops_role" '{
  name: "docker-test mtls rbac", domains: [$d], upstreams: ["origin-a:8080"],
  mtls: { enabled: true, trusted_role_ids: [$s, $o] }
}')" && pass "an mTLS host trusting two roles can be created"
rbac_host="$NEW_ID"

api POST "/api/v1/proxy-hosts/$rbac_host/mtls-access-rules" \
  "$(jq -nc --argjson o "$ops_role" '{pathPattern:"/ops/*", allowedRoleIds:[$o], priority:10}')"
t_eq "a role-scoped access rule can be created" "201" "$API_STATUS"

api POST "/api/v1/proxy-hosts/$rbac_host/mtls-access-rules" \
  '{"pathPattern":"/nobody/*", "denyAll":true, "priority":20}'
t_eq "a deny-all access rule can be created" "201" "$API_STATUS"

wait_for "the RBAC host to accept the ops certificate" 120 \
  bash -c "curl -sS --max-time 8 -o /dev/null -f --cacert '$CA_BUNDLE' --cert '$STATE_DIR/mtls-beta.crt.pem' --key '$STATE_DIR/mtls-beta.key.pem' 'https://$rbac/ops/dashboard'"

t_eq "the permitted role reaches the scoped path" "200" \
  "$(http_code "https://$rbac/ops/dashboard" "${BETA[@]}")"
t_eq "another trusted role is refused on the scoped path" "403" \
  "$(http_code "https://$rbac/ops/dashboard" "${ALPHA[@]}")"
t_eq "a deny-all rule refuses every certificate" "403" \
  "$(http_code "https://$rbac/nobody/here" "${ALPHA[@]}")"
t_eq "a deny-all rule refuses the other role too" "403" \
  "$(http_code "https://$rbac/nobody/here" "${BETA[@]}")"
t_eq "paths with no rule stay open to any trusted certificate" "200" \
  "$(http_code "https://$rbac/unscoped" "${ALPHA[@]}")"

# ── Revocation ──────────────────────────────────────────────────────────────

api DELETE "/api/v1/client-certificates/$beta_cert_id"
t_eq "a client certificate can be revoked" "200" "$API_STATUS"
t_ne "the revocation is recorded" "null" "$(jqr '.revokedAt')"

if wait_for "the revoked certificate to stop working" 60 \
     bash -c "[ \"\$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' --cacert '$CA_BUNDLE' --cert '$STATE_DIR/mtls-beta.crt.pem' --key '$STATE_DIR/mtls-beta.key.pem' 'https://$rbac/ops/dashboard' 2>/dev/null)\" != '200' ]"; then
  pass "a revoked certificate is no longer admitted"
else
  fail "a revoked certificate is no longer admitted" "beta still reaches /ops/dashboard"
fi

t_eq "the remaining certificate is unaffected by the revocation" "200" \
  "$(http_code "https://$rbac/unscoped" "${ALPHA[@]}")"

finish
