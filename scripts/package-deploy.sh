#!/usr/bin/env bash
# Packages the deployment files of one release into a flat tar.gz that deploys as it unpacks: each
# mounted docker/ directory becomes a file prefix, and the staged compose file is rewritten to
# mount from beside itself and to pin our three images to the release. Extra files land at the top.
#
#   package-deploy.sh <version> <output.tar.gz> [extra-file ...]
#
# Run from the repository root. Used by release.yml and by scripts/airgap/package.ts.
set -euo pipefail

version="${1:?usage: package-deploy.sh <version> <output.tar.gz> [extra-file ...]}"
name="${2:?usage: package-deploy.sh <version> <output.tar.gz> [extra-file ...]}"
shift 2
extras=("$@")

# CrowdSec is in it but behind its Compose profile, so it starts only once turned on.
dirs=(clickhouse socket-proxy crowdsec)

# An archive, as GitHub renames a dotfile asset (`.env.example`); tar.gz opens on Windows too.
entries=(docker-compose.yml .env.example)
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
# What the rewrites below start from, and so what the image check compares against.
base=docker-compose.yml
cp .env.example "$staging/"
cp "$base" "$staging/docker-compose.yml"

# A missing bind source becomes an empty directory the proxy cannot render.
for dir in "${dirs[@]}"; do
  for f in "docker/${dir}"/*; do
    entry="${dir}-$(basename "$f")"
    cp "$f" "${staging}/${entry}"
    entries+=("$entry")
  done
  # Host side only.
  sed -i "s#\./docker/${dir}/#./${dir}-#g" "$staging/docker-compose.yml"
done

# A snapshot with `:latest` would silently upgrade on a later redeploy. Only our three images:
# third-party ones are pinned already, and our version would name missing tags. Caddy's is the
# default inside `${CADDY_IMAGE:-...}`, so an own build can replace it.
sed -i -E \
  "s#(image: (\\\$\\{CADDY_IMAGE:-)?ghcr\.io/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*/(web|caddy|agent)):latest#\\1:${version}#" \
  "$staging/docker-compose.yml"

for service in web caddy agent; do
  if ! grep -qE "image: (\\\$\\{CADDY_IMAGE:-)?ghcr\.io/.*/${service}:${version}\\}?\$" "$staging/docker-compose.yml"; then
    echo "::error::${name}: docker-compose.yml does not pin ${service} to ${version}"
    grep -n 'image:' "$staging/docker-compose.yml"
    exit 1
  fi
done

# Nor too far. Compared, not listed, so a Dependabot bump cannot break the release.
if ! diff <(grep -E '^[[:space:]]*image:' "$base" | grep -vE '/(web|caddy|agent):') \
          <(grep -E '^[[:space:]]*image:' "$staging/docker-compose.yml" | grep -vE '/(web|caddy|agent):'); then
  echo "::error::${name}: docker-compose.yml changed a third-party image reference"
  exit 1
fi

# A sed that matched nothing would ship mounts of a directory the archive lacks.
if grep -qE '\./docker/' "$staging/docker-compose.yml"; then
  echo "::error::${name}: docker-compose.yml still references ./docker/"
  grep -nE '\./docker/' "$staging/docker-compose.yml"
  exit 1
fi
for entry in "${entries[@]:2}"; do
  if ! grep -q "\./${entry}:" "$staging/docker-compose.yml"; then
    echo "::error::${name}: docker-compose.yml does not mount ${entry}"
    exit 1
  fi
done

for extra in "${extras[@]}"; do
  cp -p "$extra" "$staging/"
  entries+=("$(basename "$extra")")
done

tar -czf "$name" -C "$staging" "${entries[@]}"

# Asserted: a misnamed `.env.example` would look fine until someone deployed. Listed once: under
# pipefail, `tar | grep -q` fails whenever grep exits before tar has written everything.
listing="$(tar -tzf "$name")"
for want in docker-compose.yml .env.example clickhouse-low-disk-write.yml socket-proxy-haproxy.cfg.template; do
  if ! grep -qxF "$want" <<<"$listing"; then
    echo "::error::${name} is missing ${want}"
    echo "$listing"
    exit 1
  fi
done

echo "--- ${name} ---"
tar -tzvf "$name"
