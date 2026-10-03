#!/usr/bin/env bash
# Host-side entry point for the docker integration suite.
#
#   ./run.sh                     build if needed, bring the rig up, run everything, tear down
#   ./run.sh mtls l4             run only the test files matching those patterns
#   ./run.sh --keep              leave the rig running afterwards
#   ./run.sh --rebuild           force a rebuild of the web and caddy images
#   ./run.sh --no-agent          skip the agent phase (an agent in external build mode, run last)
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
AGENT=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep)    KEEP=1 ;;
    --rebuild) REBUILD=1 ;;
    --shell)   ACTION=shell ;;
    --down)    ACTION=down ;;
    --logs)    ACTION=logs; shift; FILTERS=("$@"); break ;;
    --no-geoblock) export CPM_TEST_GEOBLOCK=0 ;;
    --no-waf)      export CPM_TEST_WAF=0 ;;
    --no-agent)    AGENT=0 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        echo "unknown option: $1" >&2; exit 2 ;;
    *)         FILTERS+=("$1") ;;
  esac
  shift
done

compose() { "${COMPOSE[@]}" "${PROFILES[@]}" "$@"; }
# The agent phase's services, which `down` must name too or they outlive the rig. `crowdsec` is the
# managed one the agent starts itself.
AGENT_PROFILES=(--profile agent --profile agent-build --profile crowdsec)
agent_compose() { "${COMPOSE[@]}" "${PROFILES[@]}" "${AGENT_PROFILES[@]}" "$@"; }

# The shipped modules, read off the Dockerfile's default so the opt-in image cannot drift from it.
shipped_modules() {
  awk '/^ARG CADDY_MODULES="/ {on=1; next}
       on {line=$0; gsub(/[\\"]/, "", line); gsub(/^ +| +$/, "", line)
           if (line != "") printf "%s ", line
           if ($0 ~ /"$/) exit}' ../docker/caddy/Dockerfile
}
CPM_TEST_OPT_IN_MODULES="$(shipped_modules)github.com/mholt/caddy-ratelimit github.com/hslatman/caddy-crowdsec-bouncer"
export CPM_TEST_OPT_IN_MODULES

# Which half a filter selects: a pattern matching nothing in a half skips that half.
matches() {  # matches DIR - true when a file in DIR matches a filter, or there are none
  [ "${#FILTERS[@]}" -eq 0 ] && return 0
  local file pattern
  for file in "$1"/*.sh; do
    for pattern in "${FILTERS[@]}"; do
      case "$(basename "$file")" in *"$pattern"*) return 0 ;; esac
    done
  done
  return 1
}
MAIN=0; matches suite/tests && MAIN=1
[ "$AGENT" = "1" ] && ! matches suite/agent-tests && AGENT=0

case "$ACTION" in
  down)
    echo "==> tearing the rig down"
    agent_compose down -v --remove-orphans
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
  agent_compose down -v --remove-orphans >/dev/null 2>&1
}

# ── Build ───────────────────────────────────────────────────────────────────

echo "==> building images (the first run compiles Caddy with its plugins and can take several minutes)"
build_args=()
[ "$REBUILD" = "1" ] && build_args+=(--no-cache)
if ! compose build "${build_args[@]}"; then
  echo "build failed" >&2
  exit 1
fi
if [ "$AGENT" = "1" ] && ! agent_compose build "${build_args[@]}" \
     agent caddy-external caddy-opt-in crowdsec-lapi; then
  echo "build failed (agent phase)" >&2
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
      dns coredns acme-dns pebble caddy web origin-a origin-b origin-tls origin-tcp origin-udp \
      anubis; then
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

status=0
if [ "$MAIN" = "1" ]; then
  echo "==> running the suite"
  compose exec -T runner bash /suite/run-tests.sh "${FILTERS[@]+"${FILTERS[@]}"}"
  status=$?
fi

if [ "$AGENT" = "1" ]; then
  echo
  echo "==> agent phase: an agent in external build mode"
  if ! agent_compose up -d --wait --wait-timeout 300 crowdsec-lapi runner-docker-proxy ||
     ! agent_compose up -d docker-socket-proxy agent; then
    echo "the agent did not start" >&2
    status=1
  else
    compose exec -T runner bash /suite/run-tests.sh --agent "${FILTERS[@]+"${FILTERS[@]}"}"
    agent_status=$?
    [ "$agent_status" -gt "$status" ] && status=$agent_status
    [ "$agent_status" -ne 0 ] && agent_compose logs --tail 60 agent
  fi
fi

if [ "$status" -ne 0 ]; then
  echo
  echo "==> recent logs from the system under test"
  compose logs --tail 40 web caddy
fi

teardown
exit "$status"
