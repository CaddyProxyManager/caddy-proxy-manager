#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"

# caddy-blocker-plugin may want a newer cel-go than pinned Caddy supports; derive
# the replacement from Caddy's own pin rather than a second hand-kept version.
caddy_version="$(go list -m -f '{{.Version}}' github.com/caddyserver/caddy/v2)"
go mod download "github.com/caddyserver/caddy/v2@${caddy_version}"
caddy_mod_file="$(go env GOMODCACHE)/cache/download/github.com/caddyserver/caddy/v2/@v/${caddy_version}.mod"
# cel-go became cel.dev/cel-go at v0.32.0. Match either path on both sides, since Caddy and the
# plugins migrate separately.
cel_paths="github.com/google/cel-go cel.dev/cel-go"

caddy_cel_path=""
cel_go_version=""
for path in $cel_paths; do
  cel_go_version="$(awk -v p="$path" '$1 == p { print $2; exit }' "$caddy_mod_file")"
  if [ -n "$cel_go_version" ]; then
    caddy_cel_path="$path"
    break
  fi
done

if [ -z "$cel_go_version" ]; then
  echo "Unable to resolve Caddy's cel-go compatibility version" >&2
  exit 1
fi

# Under whichever path our graph requires; a replace may cross paths.
replaced=""
for path in $cel_paths; do
  if go list -m "$path" >/dev/null 2>&1; then
    go mod edit "-replace=${path}=${caddy_cel_path}@${cel_go_version}"
    replaced="${replaced} ${path}"
  fi
done

if [ -z "$replaced" ]; then
  echo "No cel-go in the module graph; nothing to pin." >&2
else
  echo "Pinned${replaced} to ${caddy_cel_path}@${cel_go_version}"
fi

# tidy, not `go mod download all`, which records the whole transitive closure in go.sum and made
# the scheduled run open a PR of pure churn every week.
go mod tidy
