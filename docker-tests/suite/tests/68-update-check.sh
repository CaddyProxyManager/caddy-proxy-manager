#!/usr/bin/env bash
# The update check against a real container registry (registry:2 over TLS from the rig CA): Settings
# → Updates pointed at it, the newest semver tag found among ones that are not, a prerelease ranked
# below its release, the dashboard told when the release is newer than what runs, and a repository
# the registry does not have reported as such.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "update check"

REGISTRY=https://registry.rig.internal
REPO="rig/cpm$(date +%s)"
PAGE=/settings/updates

# push TAG - an empty OCI image under $REPO/web:TAG
push() {
  local config='{}' digest location
  digest="sha256:$(printf '%s' "$config" | sha256sum | cut -d' ' -f1)"
  location=$(curl -sS --max-time 20 --cacert "$CA_BUNDLE" -X POST -D - -o /dev/null \
    "$REGISTRY/v2/$REPO/web/blobs/uploads/" | tr -d '\r' | awk 'tolower($1) == "location:" {print $2}')
  case "$location" in /*) location="$REGISTRY$location" ;; esac
  curl -sS --max-time 20 --cacert "$CA_BUNDLE" -X PUT -o /dev/null -H 'Content-Type: application/octet-stream' \
    --data-binary "$config" "$location&digest=$digest"
  curl -sS --max-time 20 --cacert "$CA_BUNDLE" -X PUT -o /dev/null -w '%{http_code}' \
    -H 'Content-Type: application/vnd.oci.image.manifest.v1+json' \
    --data-binary "$(jq -nc --arg d "$digest" '{schemaVersion:2, mediaType:"application/vnd.oci.image.manifest.v1+json",
      config:{mediaType:"application/vnd.oci.image.config.v1+json", digest:$d, size:2}, layers:[]}')" \
    "$REGISTRY/v2/$REPO/web/manifests/$1"
}

settings() {  # settings REPOSITORY - save Settings → Updates, which checks at once
  server_action "$PAGE" updateUpdateSettingsAction --form updateCheckEnabled=on "updateImageRepository=$1" &&
    server_action "$PAGE" applyStagedSettingsAction
}
check() { server_action "$PAGE" checkForUpdatesAction; printf '%s' "$ACTION_RESULT" | jq -r '.message'; }
update_flag() {  # what the dashboard layout was told: true or false
  curl -sS --max-time 30 -b "$STATE_DIR/cookies.txt" "$CPM_API/proxy-hosts" 2>/dev/null \
    | grep -oE 'updateAvailable\\?":(true|false)' | head -n1 | grep -oE 'true|false'
}
# The shipped default; saving it checks ghcr.io, which the rig cannot reach, and records that.
restore() { settings ghcr.io/caddyproxymanager >/dev/null 2>&1; }
trap 'restore; cleanup_tracked' EXIT

for tag in 3.1.0 v3.2.0 latest nightly sha-0123abc 3.3; do
  [ "$(push "$tag")" = "201" ] || fail "tag $tag can be pushed to the rig's registry" "push failed"
done
t_eq "the registry lists the tags" "6" \
  "$(curl -sS --max-time 10 --cacert "$CA_BUNDLE" "$REGISTRY/v2/$REPO/web/tags/list" | jq '.tags | length')"

if settings "registry.rig.internal/$REPO"; then
  pass "the update check can be pointed at another registry"
else
  fail "the update check can be pointed at another registry" "$(printf '%.300s' "$ACTION_RESULT")"
fi

t_contains "it finds the newest release among tags that are not versions" "v3.2.0" "$(check)"

push 99.0.0-rc.1 >/dev/null
t_contains "a newer prerelease is found" "99.0.0-rc.1" "$(check)"
push 99.0.0 >/dev/null
t_contains "and its release ranks above it" "99.0.0" "$(check)"
t_not_contains "not the prerelease" "rc.1" "$(check)"
t_eq "the dashboard is told a newer release exists" "true" "$(update_flag)"

server_action "$PAGE" updateUpdateSettingsAction --form "updateImageRepository=registry.rig.internal/$REPO"
server_action "$PAGE" applyStagedSettingsAction
t_eq "switching the check off tells the dashboard nothing" "false" "$(update_flag)"

settings "registry.rig.internal/rig/nothing-here" >/dev/null
t_contains "a repository the registry does not have is reported" "No such repository" "$(check)"

server_action "$PAGE" updateUpdateSettingsAction --form updateCheckEnabled=on "updateImageRepository=https://registry.rig.internal/$REPO"
t_eq "a repository written as a URL is refused" "false" "$(printf '%s' "$ACTION_RESULT" | jq -r '.success')"

finish
