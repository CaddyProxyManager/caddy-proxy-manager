#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$script_dir"

# caddy-blocker-plugin may want a newer cel-go than pinned Caddy supports; derive
# the replacement from Caddy's own pin rather than a second hand-kept version.
caddy_version="$(go list -m -f '{{.Version}}' github.com/caddyserver/caddy/v2)"
go mod download "github.com/caddyserver/caddy/v2@${caddy_version}"
caddy_mod_file="$(go env GOMODCACHE)/cache/download/github.com/caddyserver/caddy/v2/@v/${caddy_version}.mod"
# cel-go became cel.dev/cel-go at v0.32.0 (Caddy v2.11.6). Look under both paths, since Caddy
# and the plugins migrate separately.
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

# Caddy's path only. The other is a separate module that cannot clash with Caddy's, and Go refuses
# one version standing in for both paths, so a replace left on it from before the move is dropped.
for path in $cel_paths; do
  if [ "$path" != "$caddy_cel_path" ]; then
    go mod edit "-dropreplace=${path}"
  fi
done
go mod edit "-replace=${caddy_cel_path}=${caddy_cel_path}@${cel_go_version}"
echo "Pinned ${caddy_cel_path} to ${cel_go_version}"

# tidy, not `go mod download all`, which records the whole transitive closure in go.sum and made
# the scheduled run open a PR of pure churn every week.
go mod tidy
