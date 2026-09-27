#!/usr/bin/env bash
# Host-side entry point for the docker integration suite.
#
#   ./run.sh                     build if needed, bring the rig up, run everything, tear down
#   ./run.sh mtls l4             run only the test files matching those patterns
#   ./run.sh --keep              leave the rig running afterwards
#   ./run.sh --rebuild           force a rebuild of the web and caddy images
#   ./run.sh --shell             drop into a shell in the client container
#   ./run.sh --logs [service]    tail logs
#   ./run.sh --down              tear the rig down, volumes and all
#
# Needs docker with the compose plugin; every other tool lives in the client container.
set -uo pipefail

# Git Bash on Windows rewrites arguments that look like absolute paths, which
# would turn /suite/run-tests.sh into a host path before docker ever sees it.
export MSYS2_ARG_CONV_EXCL="*"
export MSYS_NO_PATHCONV=1

cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

COMPOSE=(docker compose)
PROFILES=()
KEEP=0
REBUILD=0
ACTION=run
FILTERS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep)    KEEP=1 ;;
    --rebuild) REBUILD=1 ;;
    --shell)   ACTION=shell ;;
    --down)    ACTION=down ;;
    --logs)    ACTION=logs; shift; FILTERS=("$@"); break ;;
    --no-geoblock) export CPM_TEST_GEOBLOCK=0 ;;
    --no-waf)      export CPM_TEST_WAF=0 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        echo "unknown option: $1" >&2; exit 2 ;;
    *)         FILTERS+=("$1") ;;
  esac
  shift
done

compose() { "${COMPOSE[@]}" "${PROFILES[@]}" "$@"; }

case "$ACTION" in
  down)
    echo "==> tearing the rig down"
    compose down -v --remove-orphans
    exit $?
    ;;
  logs)
    compose logs -f "${FILTERS[@]}"
    exit $?
    ;;
esac

teardown() {
  if [ "$KEEP" = "1" ]; then
    echo
    echo "==> rig left running (--keep). Tear it down with: ./run.sh --down"
    return
  fi
  echo
  echo "==> tearing the rig down"
  compose down -v --remove-orphans >/dev/null 2>&1
}

# ── Build ───────────────────────────────────────────────────────────────────

echo "==> building images (the first run compiles Caddy with its plugins and can take several minutes)"
build_args=()
[ "$REBUILD" = "1" ] && build_args+=(--no-cache)
if ! compose build "${build_args[@]}"; then
  echo "build failed" >&2
  exit 1
fi

# ── Up ──────────────────────────────────────────────────────────────────────

echo "==> starting the rig"
# dnsmasq's entire configuration is a bind mount, so compose sees no change to
# the service when it is edited and leaves a stale container running.
compose up -d --force-recreate dns >/dev/null 2>&1
# certgen is left off on purpose: a one-shot others wait on via `service_completed_successfully`,
# whose exit --wait would treat as a failure to become healthy.
if ! compose up -d --wait --wait-timeout 300 \
      dns pebble caddy web origin-a origin-b origin-tls origin-tcp origin-udp; then
  echo "the rig did not come up healthy" >&2
  compose ps
  compose logs --tail 60 web caddy pebble
  teardown
  exit 1
fi

compose up -d runner >/dev/null 2>&1

if [ "$ACTION" = "shell" ]; then
  echo "==> opening a shell in the client container (the suite lives in /suite)"
  compose exec runner bash
  exit $?
fi

# ── Run ─────────────────────────────────────────────────────────────────────

echo "==> running the suite"
compose exec -T runner bash /suite/run-tests.sh "${FILTERS[@]+"${FILTERS[@]}"}"
status=$?

if [ "$status" -ne 0 ]; then
  echo
  echo "==> recent logs from the system under test"
  compose logs --tail 40 web caddy
fi

teardown
exit "$status"
