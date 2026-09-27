#!/bin/sh
# CADDY_MODULES says which plugins (from Settings -> Caddy Build), go.mod which versions. Kept
# apart so the app's desired/applied diff compares like with like: a pin moving is a reviewed
# change, not something that makes the UI claim a rebuild is pending.
set -eu

# The *required* version, not the resolved one: a replaced module resolves to a version its own
# path lacks. Empty for a custom module go.mod does not carry.
module_version() {
    go list -m -f '{{.Version}}' "$1" 2>/dev/null || true
}

caddy_version="$(module_version github.com/caddyserver/caddy/v2)"
if [ -z "$caddy_version" ]; then
    echo "go.mod does not pin github.com/caddyserver/caddy/v2" >&2
    exit 1
fi

set -- "$caddy_version"
resolved=""
unpinned=""

for spec in ${CADDY_MODULES:-}; do
    case "$spec" in
        *@*)
            with="$spec"
            ;;
        *)
            version="$(module_version "$spec")"
            if [ -n "$version" ]; then
                with="$spec@$version"
            else
                # Floats to latest, flagged in the build log so an unpinned build is not silent.
                with="$spec"
                unpinned="$unpinned $spec"
            fi
            ;;
    esac
    set -- "$@" --with "$with"
    resolved="$resolved $with"
done

# Every versioned replacement in go.mod, where each says why it exists. Not `while read`: its
# subshell would discard the appended arguments. Local-directory replacements are skipped.
replacements="$(go list -m -f '{{if and .Replace .Replace.Version}}{{.Path}}={{.Replace.Path}}@{{.Replace.Version}}{{end}}' all 2>/dev/null | grep . || true)"
for replacement in $replacements; do
    set -- "$@" --replace "$replacement"
done

echo "Building Caddy $caddy_version with:${resolved:- no plugins}"
if [ -n "$replacements" ]; then
    echo "Replacements:"
    for replacement in $replacements; do
        echo "  $replacement"
    done
fi
if [ -n "$unpinned" ]; then
    echo "WARNING: no pinned version in go.mod for:$unpinned"
fi

GOOS="$TARGETOS" GOARCH="$TARGETARCH" xcaddy build "$@" --output /usr/bin/caddy

# So an image can be audited: docker run --rm <image> cat /etc/caddy/caddy-modules.resolved.txt
# With the replacements, or a forked module would be reported as the upstream one.
{
    printf '%s\n' "${resolved# }"
    for replacement in $replacements; do
        printf 'replace %s\n' "$replacement"
    done
} > /caddy-modules.resolved.txt
