#!/usr/bin/env bash
# The GeoIP updater against a stand-in for MaxMind: dnsmasq points download.maxmind.com and
# updates.maxmind.com at the rig's `files` server, whose certificate web trusts through the rig
# CA. It serves the metadata check, answers downloads with a redirect to a presigned-style URL as
# MaxMind does, and the archives hold MaxMind's public test databases. The databases are left in
# place: the agent phase checks the agent downloads them from the controller.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "GeoIP updater"

GEOIP_PAGE=/settings/geoip
ACCOUNT=123456
LICENSE=rig-license-key
FILES=/files
EDITIONS="GeoLite2-Country GeoLite2-ASN GeoLite2-City"

declare -A SOURCE=(
  [GeoLite2-Country]=GeoIP2-Country-Test.mmdb
  [GeoLite2-ASN]=GeoLite2-ASN-Test.mmdb
  [GeoLite2-City]=GeoIP2-City-Test.mmdb
)

basic() { printf 'Basic %s' "$(printf '%s:%s' "$1" "$2" | base64 | tr -d '\n')"; }

# publish DATE - archives built on DATE (YYYYMMDD) and metadata announcing them
publish() {
  local date="$1" edition work
  work=$(mktemp -d)
  mkdir -p "$FILES/files.rig.internal/r2" "$FILES/updates.maxmind.com/geoip/updates"
  for edition in $EDITIONS; do
    mkdir -p "$work/${edition}_$date" "$FILES/download.maxmind.com/geoip/databases/$edition"
    cp "/opt/maxmind/${SOURCE[$edition]}" "$work/${edition}_$date/$edition.mmdb"
    tar -czf "$FILES/files.rig.internal/r2/$edition-$date.tar.gz" -C "$work" "${edition}_$date"
    printf 'https://files.rig.internal/r2/%s-%s.tar.gz\n' "$edition" "$date" \
      >"$FILES/download.maxmind.com/geoip/databases/$edition/download.redirect"
  done
  jq -nc --arg d "${date:0:4}-${date:4:2}-${date:6:2}" --arg e "$EDITIONS" \
    '{databases: [$e | split(" ")[] | {edition_id: ., date: $d}]}' \
    >"$FILES/updates.maxmind.com/geoip/updates/metadata"
  rm -rf "$work"
}

require_key() {  # require_key LICENSE - the credentials both MaxMind hosts accept
  basic "$ACCOUNT" "$1" >"$FILES/download.maxmind.com/.auth"
  basic "$ACCOUNT" "$1" >"$FILES/updates.maxmind.com/.auth"
}

requests() { curl -sS --max-time 10 --cacert "$CA_BUNDLE" https://files.rig.internal/__requests 2>/dev/null; }
downloads() {  # downloads HOST -> how many archive requests HOST has seen
  requests | jq --arg h "$1" '[.[] | select(.host == $h and (.raw_path | test("download|r2/")))] | length'
}

UPDATED=
update_now() {  # Settings → GeoIP's "Check now" -> UPDATED (true/false) and ACTION_RESULT
  server_action "$GEOIP_PAGE" updateGeoipDatabasesAction
  UPDATED=$(printf '%s' "$ACTION_RESULT" | jq -r '.success' 2>/dev/null)
}

signed() {  # requests to download.maxmind.com carrying the right credentials
  requests | jq --arg a "$(basic "$ACCOUNT" "$LICENSE")" \
    '[.[] | select(.host == "download.maxmind.com" and .authorization == $a)] | length'
}

databases_present() {
  api_session GET /api/geoip-status
  [ "$(jqr '"\(.enabled)|\(.country)|\(.asn)"')" = "true|true|true" ]
}

publish 20260901
require_key "$LICENSE"
signed_before=$(signed)

server_action "$GEOIP_PAGE" updateGeoipSettingsAction --form geoipEnabled=on \
  "geoipAccountId=$ACCOUNT" "geoipLicenseKey=$LICENSE" geoipUpdateIntervalHours=24
t_eq "MaxMind credentials can be saved in Settings → GeoIP" "true" \
  "$(printf '%s' "$ACTION_RESULT" | jq -r '.success' 2>/dev/null)"

# Saving starts the first download itself.
if wait_for "the databases to download" 60 databases_present; then
  pass "saving them downloads the databases"
else
  fail "saving them downloads the databases" "status: $API_BODY"
fi
update_now
t_eq "a check straight after succeeds" "true" "$UPDATED"

log=$(requests)
t_eq "the metadata check sends the account's credentials" "$(basic "$ACCOUNT" "$LICENSE")" \
  "$(printf '%s' "$log" | jq -r 'last(.[] | select(.host == "updates.maxmind.com")) | .authorization')"
t_contains "asking about all three editions" "edition_id=GeoLite2-City" \
  "$(printf '%s' "$log" | jq -r 'last(.[] | select(.host == "updates.maxmind.com")) | .raw_path')"
t_eq "each download asks MaxMind with them" "3" "$(( $(signed) - signed_before ))"
t_eq "and follows the redirect without them" "null" \
  "$(printf '%s' "$log" | jq -r '[.[] | select(.host == "files.rig.internal" and (.raw_path | startswith("/r2/")))] | last | .authorization')"

# ── Nothing new, nothing downloaded ─────────────────────────────────────────

before=$(downloads download.maxmind.com)
update_now
t_eq "an update with no newer build succeeds" "true" "$UPDATED"
t_eq "without downloading anything" "$before" "$(downloads download.maxmind.com)"

publish 20260915
before=$(downloads download.maxmind.com)
update_now
t_eq "a newer build is downloaded" "true" "$UPDATED"
t_eq "for every edition" "$((before + 3))" "$(downloads download.maxmind.com)"

# ── Rejected credentials ────────────────────────────────────────────────────

require_key other-license
publish 20260920
update_now
t_eq "an update with credentials MaxMind rejects fails" "false" "$UPDATED"
api_session GET /api/geoip-status
t_eq "and keeps the databases it had" "true|true" "$(jqr '"\(.country)|\(.asn)"')"
require_key "$LICENSE"
publish 20260915

# ── The agents' route ───────────────────────────────────────────────────────

t_eq "the agents' download route refuses an unsigned request" "404" \
  "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$CPM_API/api/agent/geoip/GeoLite2-Country")"

finish
