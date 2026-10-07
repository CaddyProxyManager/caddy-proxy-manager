#!/bin/sh
# Loads Caddy Proxy Manager's images from an air-gap bundle, then checks that every third-party
# image the stack runs is already on this host at the digest the release names. It pulls nothing:
# bring those in first, through a registry mirror or `docker load`.
#
#   ./airgap-load.sh [bundle-dir]     run from the unpacked deploy archive; default bundle-dir is .
#
# Check the manifest's signature on a connected machine before trusting its checksums.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
bundle="$(cd "${1:-.}" && pwd)"

fail() {
  echo "airgap-load: $*" >&2
  exit 1
}

manifest=""
for candidate in "$bundle"/*-airgap-manifest.txt; do
  [ -e "$candidate" ] || continue
  [ -z "$manifest" ] || fail "more than one *-airgap-manifest.txt in ${bundle}; keep one release's bundle per directory"
  manifest="$candidate"
done
[ -n "$manifest" ] || fail "no *-airgap-manifest.txt in ${bundle}"

if command -v sha256sum >/dev/null 2>&1; then
  hash_stdin() { sha256sum | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  hash_stdin() { shasum -a 256 | cut -d' ' -f1; }
else
  fail "neither sha256sum nor shasum is installed"
fi

want_arch="$(awk '$1 == "arch" { print $2 }' "$manifest")"
case "$(docker info --format '{{.Architecture}}')" in
  x86_64 | amd64) host_arch=amd64 ;;
  aarch64 | arm64) host_arch=arm64 ;;
  *) host_arch=unknown ;;
esac
[ "$want_arch" = "$host_arch" ] || fail "this bundle is for ${want_arch}, but Docker here runs ${host_arch}"

# Every published file first, so a truncated download is named before anything is loaded.
bad=""
while read -r kind sum _bytes name; do
  [ "$kind" = file ] || continue
  if [ ! -f "${bundle}/${name}" ]; then
    bad="${bad}  missing:  ${name}
"
  elif [ "$(hash_stdin <"${bundle}/${name}")" != "$sum" ]; then
    bad="${bad}  corrupt:  ${name}
"
  fi
done <"$manifest"
[ -z "$bad" ] || fail "these files do not match the manifest:
${bad}"

# An archive over GitHub's asset limit ships in parts, streamed into docker load rather than joined
# on disk. The loop reads the manifest on stdin, so nothing inside may.
while read -r kind service image sum file; do
  [ "$kind" = image ] || continue
  if [ -f "${bundle}/${file}" ]; then
    set -- "${bundle}/${file}"
  else
    set -- "${bundle}/${file}".part-*
    [ -f "$1" ] || fail "${file} is missing, and so are its parts"
  fi
  [ "$(cat "$@" | hash_stdin)" = "$sum" ] || fail "${file} does not match the manifest"
  echo "==> loading ${service}: ${image}"
  cat "$@" | docker load
  docker image inspect "$image" </dev/null >/dev/null 2>&1 || fail "${file} did not provide ${image}"
done <"$manifest"

# The images compose would run, overrides included, so a private registry's names count. The two
# required variables only need a value for compose to read the file.
images="$(cd "$here" && SESSION_SECRET="${SESSION_SECRET:-placeholder}" \
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-placeholder}" \
  docker compose --profile '*' config --images)" || fail "docker compose could not read ${here}"

missing=""
while read -r kind service image; do
  [ "$kind" = third-party ] || continue
  digest="${image##*@}"
  effective="$(printf '%s\n' "$images" | grep -F "@${digest}" | head -n 1 || true)"
  if [ -z "$effective" ]; then
    missing="${missing}  ${service}: the compose files no longer name ${image}; an override changed its digest
"
  elif ! docker image inspect "$effective" </dev/null >/dev/null 2>&1; then
    missing="${missing}  ${service}: ${effective}
"
  fi
done <"$manifest"

if [ -n "$missing" ]; then
  fail "these third-party images are not on this host at the digest this release pins:
${missing}
Bring them in through a registry mirror (docker compose pull) or docker load, then run this again.
Nothing was started."
fi

echo "==> every image is present. Start the stack with: docker compose up -d"
