#!/usr/bin/env bash
# Backup and restore on the running instance: a .cpmbak taken over REST, two hosts deleted, the
# file previewed and restored through the dashboard's route, and the hosts back and served. A
# restore signs everyone out, so the file ends by signing the suite's session in again.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "backup and restore"

PASSPHRASE='rig-backup-passphrase-0123'
FILE="$STATE_DIR/rig.cpmbak"
trap 'fresh_session >/dev/null 2>&1; cleanup_tracked' EXIT

# restore_post FIELD=VALUE... -> API_STATUS, API_BODY; multipart, as the dashboard's upload sends it
restore_post() {
  local out="$STATE_DIR/restore.$$" args=() field
  for field in "$@"; do args+=(-F "$field"); done
  API_STATUS=$(curl -sS --max-time 120 -o "$out" -w '%{http_code}' -b "$STATE_DIR/cookies.txt" \
    -H "Origin: $CPM_API" "${args[@]}" "$CPM_API/api/backup/restore" 2>/dev/null) || API_STATUS=000
  API_BODY=$(cat "$out" 2>/dev/null); rm -f "$out"
}

one=$(domain_for "backup-one") two=$(domain_for "backup-two")
create_host_or_fail "a first host can be created" "$(jq -nc --arg d "$one" \
  '{name:"docker-test backup one", domains:[$d], upstreams:["origin-a:8080"]}')" && pass "a first host can be created"
one_id=$NEW_ID
create_host_or_fail "a second host can be created" "$(jq -nc --arg d "$two" \
  '{name:"docker-test backup two", domains:[$d], upstreams:["origin-b:8080"]}')" && pass "a second host can be created"
two_id=$NEW_ID
wait_for_https "$one" 120 && wait_for_https "$two" 120

# ── Back up ─────────────────────────────────────────────────────────────────

api POST /api/v1/backup '{"passphrase":"short"}'
t_eq "a passphrase under twelve characters is refused" "400" "$API_STATUS"

status=$(curl -sS --max-time 120 -o "$FILE" -D "$FILE.headers" -w '%{http_code}' \
  -H "Authorization: Bearer $(cat "$TOKEN_FILE")" -H 'Content-Type: application/json' \
  --data-binary "$(jq -nc --arg p "$PASSPHRASE" '{passphrase:$p}')" "$CPM_API/api/v1/backup")
_record_api_call POST /api/v1/backup
t_eq "a backup can be taken with a token" "200" "$status"
t_matches "as a .cpmbak download" 'filename="cpm-backup-[0-9-]+\.cpmbak"' "$(tr -d '\r' <"$FILE.headers" | grep -i '^content-disposition')"
t_eq "whose first line names the format" "CPMBAK1" "$(head -n1 "$FILE")"
header=$(sed -n 2p "$FILE")
t_eq "and whose header counts the hosts" "true" \
  "$(printf '%s' "$header" | jq --argjson n 2 '.counts.proxyHosts // .counts.proxy_hosts >= $n')"
t_not_contains "the rest is encrypted" "docker-test backup one" "$(tail -n +3 "$FILE")"

# ── Lose the hosts ──────────────────────────────────────────────────────────

api DELETE "/api/v1/proxy-hosts/$one_id"
api DELETE "/api/v1/proxy-hosts/$two_id"
gone() { [ "$(http_code "https://$one/")" != "200" ] && [ "$(http_code "https://$two/")" != "200" ]; }
wait_for "both hosts to stop being served" 30 gone && pass "deleted hosts stop being served" \
  || fail "deleted hosts stop being served" "one: $(http_code "https://$one/") two: $(http_code "https://$two/")"

# ── Restore ─────────────────────────────────────────────────────────────────

fresh_session || fail "the admin can sign in again" "$SIGN_IN_BODY"

restore_post "file=@$FILE" preview=1
t_eq "the file can be previewed without its passphrase" "200" "$API_STATUS"
t_eq "the preview counts what it holds" "$(printf '%s' "$header" | jq -c '.counts')" "$(jqr '.counts' -c)"

restore_post "file=@$FILE" "passphrase=not-the-passphrase"
t_eq "the wrong passphrase is refused" "400" "$API_STATUS"
api GET "/api/v1/proxy-hosts/$one_id"
t_eq "and restores nothing" "404" "$API_STATUS"

printf 'CPMBAK1\n{"format":"something-else"}\n' >"$STATE_DIR/not-a-backup.cpmbak"
restore_post "file=@$STATE_DIR/not-a-backup.cpmbak" "passphrase=$PASSPHRASE"
t_eq "a file that is not a backup is refused" "400" "$API_STATUS"

restore_post "file=@$FILE" "passphrase=$PASSPHRASE"
t_eq "the backup restores" "200" "$API_STATUS"
t_matches "keeping a safety copy of what it replaced" 'before-restore-[0-9]+\.cpmbak$' "$(jqr '.safetyBackup')"

api GET "/api/v1/proxy-hosts/$one_id"
t_eq "the deleted hosts are back" "200|$one" "$API_STATUS|$(jqr '.domains[0]')"
api GET "/api/v1/proxy-hosts/$two_id"
t_eq "both of them" "200|$two" "$API_STATUS|$(jqr '.domains[0]')"
back() { [ "$(http_code "https://$one/")" = "200" ] && [ "$(http_code "https://$two/")" = "200" ]; }
if wait_for "the restored hosts to be served" 60 back; then
  pass "Caddy serves them again"
else
  fail "Caddy serves them again" "one: $(http_code "https://$one/") two: $(http_code "https://$two/")"
fi
fetch "https://$two/"
t_eq "each from its own upstream" "origin-b" "$(fetch_json '.origin')"

t_eq "the restore signed the session out" "401" \
  "$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -b "$STATE_DIR/cookies.txt" "$CPM_API/api/v1/sessions")"
api GET /api/v1/proxy-hosts
t_eq "while the token, older than the backup, still works" "200" "$API_STATUS"

finish
