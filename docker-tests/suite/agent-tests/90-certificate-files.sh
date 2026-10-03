#!/usr/bin/env bash
# Certificates from files on the agent's host (CERT_FILES_HOST_DIR), in certbot's layout: `live/`
# symlinks into a root-only `archive/`, repointed on renewal. The agent reads them in a throwaway
# container through its socket proxy; the runner writes them through its own mount of the volume
# whose host directory that is.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "certificates from files on an agent's host"

FILES=/cert-files
NAME=certfile
domain=$(domain_for "certfile")
alt_domain=$(domain_for "certfile-alt")
CADDY_CONTAINER=cpm-test-caddy

trap 'cleanup_tracked; rm -rf "${FILES:?}"/live "${FILES:?}"/archive' EXIT

# The agent's row id, which only GraphQL lists.
agent_row_id() {
  curl -sS --max-time 10 -H "Authorization: Bearer $(cat "$TOKEN_FILE")" \
    -H 'Content-Type: application/json' --data '{"query":"{ agents { id connected } }"}' \
    "$CPM_API/api/graphql" 2>/dev/null |
    jq -r 'first(.data.agents[] | select(.connected)) | .id // empty' 2>/dev/null
}
row_id=""
for _ in $(seq 1 60); do
  row_id=$(agent_row_id)
  [ -n "$row_id" ] && break
  sleep 2
done
if [ -z "$row_id" ]; then
  fail "the agent is connected" "GraphQL lists no connected agent"
  finish
fi

# ── certbot's layout ────────────────────────────────────────────────────────

make_ca certfiles || { fail "a local CA can be made" "openssl failed"; finish; }

# version N KEY_FROM SAN - archive/<name>/{cert,chain,fullchain,privkey}N.pem, as certbot writes.
version() {
  local n="$1" key_from="$2" san="$3" dir="$FILES/archive/$NAME"
  issue_cert certfiles "certfile-$n" "/CN=$domain" "$san" serverAuth || return 1
  cp "$STATE_DIR/certfile-$n.crt.pem" "$dir/cert$n.pem"
  cp "$STATE_DIR/certfiles-ca.crt.pem" "$dir/chain$n.pem"
  cat "$dir/cert$n.pem" "$dir/chain$n.pem" >"$dir/fullchain$n.pem"
  cp "$STATE_DIR/certfile-$key_from.key.pem" "$dir/privkey$n.pem"
  chmod 600 "$dir/privkey$n.pem"
}

point_live_at() {  # point_live_at N - what `certbot renew` does after writing version N
  local kind
  for kind in cert chain fullchain privkey; do
    ln -sfn "../../archive/$NAME/$kind$1.pem" "$FILES/live/$NAME/$kind.pem"
  done
}

rm -rf "${FILES:?}"/live "${FILES:?}"/archive
mkdir -p "$FILES/live/$NAME" "$FILES/archive/$NAME"
chmod 700 "$FILES/archive" "$FILES/archive/$NAME"
version 1 1 "DNS:$domain" || { fail "the first version can be written" "openssl failed"; finish; }
point_live_at 1

served_fingerprint() { tls_cert "$domain" | openssl x509 -noout -fingerprint -sha256 2>/dev/null \
  | sed 's/.*=//; s/://g' | tr 'A-Z' 'a-z'; }
serves() { [ "$(served_fingerprint)" = "$(cert_fingerprint "$FILES/archive/$NAME/cert$1.pem")" ]; }
caddy_started() { docker inspect -f '{{.State.StartedAt}}' "$CADDY_CONTAINER" 2>/dev/null; }
reread() { api POST "/api/v1/certificates/$cert_id/reread"; }

# ── Import from the agent ───────────────────────────────────────────────────

api POST /api/v1/certificates "$(jq -nc --argjson a "$row_id" --arg n "$NAME" '{
  name: "docker-test certificate file", source: "agent-file", sourceAgentId: $a,
  sourceCertPath: ("live/" + $n + "/fullchain.pem"), sourceKeyPath: ("live/" + $n + "/privkey.pem")
}')"
if [ "$API_STATUS" != "201" ] && [ "$API_STATUS" != "200" ]; then
  fail "a certificate is imported from files on the agent" "HTTP $API_STATUS: $(printf '%.300s' "$API_BODY")"
  finish
fi
cert_id=$(jqr '.id')
track "certificates/$cert_id"
pass "a certificate is imported from files on the agent"
t_eq "its names come from the files" "[\"$domain\"]" "$(jqr -c '.domainNames')"
t_eq "it records where it came from" "agent-file|$row_id|null" \
  "$(jqr '"\(.source)|\(.sourceAgentId)|\(.sourceError)"')"

host_body() {  # host_body [AGENT_IDS_JSON]
  jq -nc --arg d "$domain" --argjson c "$cert_id" --argjson a "${1:-null}" '{
    name: "docker-test certificate file", domains: [$d], upstreams: ["origin-a:8080"],
    certificateId: $c
  } + (if $a == null then {} else {agentIds: $a} end)'
}
api POST /api/v1/proxy-hosts "$(host_body)"
t_eq "a host not pinned to that agent cannot use it" "400" "$API_STATUS"
create_host_or_fail "a host pinned to the agent can use it" "$(host_body "[$row_id]")" \
  && pass "a host pinned to the agent can use it"

if wait_for "Caddy to serve the file's certificate" 90 serves 1; then
  pass "Caddy serves exactly the certificate in the files"
else
  fail "Caddy serves exactly the certificate in the files" "served $(served_fingerprint)"
fi
fetch "https://$domain/" --insecure
t_eq "the host answers over it" "200" "$FETCH_CODE"
started=$(caddy_started)
t_ne "Caddy's start time can be read" "" "$started"

# ── Renewal: a new version, the links repointed ─────────────────────────────

version 2 2 "DNS:$domain,DNS:$alt_domain"
point_live_at 2
reread
t_eq "Re-read now is accepted" "200" "$API_STATUS"
t_eq "the names follow the renewed certificate" "[\"$alt_domain\",\"$domain\"]" \
  "$(jqr -c '.domainNames | sort')"
t_eq "with no error" "null" "$(jqr '.sourceError')"
if wait_for "Caddy to serve the renewed certificate" 60 serves 2; then
  pass "Caddy serves the renewed certificate"
else
  fail "Caddy serves the renewed certificate" "served $(served_fingerprint)"
fi
t_eq "without restarting Caddy" "$started" "$(caddy_started)"

# ── A renewal that went wrong keeps the last good one ───────────────────────

version 3 1 "DNS:$domain"
point_live_at 3
reread
t_eq "a key that does not match is recorded" "key-mismatch" "$(jqr '.sourceError')"
t_eq "and the stored names are left alone" "[\"$alt_domain\",\"$domain\"]" \
  "$(jqr -c '.domainNames | sort')"
sleep 3
t_ok "the last good certificate keeps serving" serves 2

ln -sfn /etc/ssl/certs/ca-certificates.crt "$FILES/live/$NAME/fullchain.pem"
reread
t_eq "a link out of the directory is refused on re-read" "outside-directory" "$(jqr '.sourceError')"
t_ok "still serving the last good certificate" serves 2

mkdir -p "$FILES/live/escape"
ln -sfn ../../../../../etc/ssl/certs/ca-certificates.crt "$FILES/live/escape/fullchain.pem"
ln -sfn "../../archive/$NAME/privkey2.pem" "$FILES/live/escape/privkey.pem"
api POST /api/v1/certificates "$(jq -nc --argjson a "$row_id" '{
  name: "docker-test certificate file escape", source: "agent-file", sourceAgentId: $a,
  sourceCertPath: "live/escape/fullchain.pem", sourceKeyPath: "live/escape/privkey.pem"
}')"
t_eq "an import through a link out of the directory is refused" "400" "$API_STATUS"
t_contains "and says why" "outside" "$API_BODY"
[ "$API_STATUS" = "201" ] && track "certificates/$(jqr '.id')"

point_live_at 2
reread
t_eq "the error clears when the files are right again" "null" "$(jqr '.sourceError')"

finish
