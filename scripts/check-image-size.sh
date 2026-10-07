#!/usr/bin/env sh
# Fails when a local image is larger than its budget, so a size regression breaks the build instead
# of quietly growing every install and the air-gap bundle.
#
#   check-image-size.sh <image> <max-mib>
set -eu

image="${1:?usage: check-image-size.sh <image> <max-mib>}"
max_mib="${2:?usage: check-image-size.sh <image> <max-mib>}"

bytes="$(docker image inspect --format '{{.Size}}' "$image")"
mib=$((bytes / 1048576))

echo "${image}: ${mib} MiB (budget ${max_mib} MiB)"
if [ "$mib" -gt "$max_mib" ]; then
  echo "::error::${image} is ${mib} MiB, over its ${max_mib} MiB budget" >&2
  exit 1
fi
