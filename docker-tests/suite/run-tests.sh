#!/usr/bin/env bash
# Entry point inside the client container.
#
#   /suite/run-tests.sh              run everything
#   /suite/run-tests.sh mtls l4      run only files whose name matches a pattern
#   /suite/run-tests.sh --agent      the agent phase (agent-tests/), once run.sh has started one
#
# One bash process per file, so a crash takes down only that file.
set -uo pipefail

SUITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export STATE_DIR="${STATE_DIR:-/tmp/cpm-test}"
export RESULT_FILE="$STATE_DIR/results.tsv"

export CALLS_FILE="$STATE_DIR/api-calls.tsv"

mkdir -p "$STATE_DIR"
: >"$RESULT_FILE"
: >"$CALLS_FILE"

if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_RED=; C_GREEN=; C_YELLOW=; C_BOLD=; C_DIM=; C_OFF=
fi

started=$(date +%s)

# ── Select test files ───────────────────────────────────────────────────────

TESTS_DIR="$SUITE_DIR/tests"
AGENT_PHASE=0
if [ "${1:-}" = "--agent" ]; then
  TESTS_DIR="$SUITE_DIR/agent-tests"
  AGENT_PHASE=1
  shift
fi

mapfile -t ALL_TESTS < <(find "$TESTS_DIR" -maxdepth 1 -name '*.sh' | sort)

TESTS=()
if [ "$#" -eq 0 ]; then
  TESTS=("${ALL_TESTS[@]}")
else
  for file in "${ALL_TESTS[@]}"; do
    for pattern in "$@"; do
      case "$(basename "$file")" in
        *"$pattern"*) TESTS+=("$file"); break ;;
      esac
    done
  done
fi

if [ "${#TESTS[@]}" -eq 0 ]; then
  echo "no test files matched: $*" >&2
  exit 2
fi

# ── Bootstrap ───────────────────────────────────────────────────────────────

if ! bash "$SUITE_DIR/bootstrap.sh"; then
  printf '\n%sbootstrap failed - no tests were run%s\n' "$C_RED" "$C_OFF" >&2
  exit 3
fi

# ── Run ─────────────────────────────────────────────────────────────────────

declare -a CRASHED=()

for file in "${TESTS[@]}"; do
  name=$(basename "$file" .sh)
  # Not `if ! bash "$file"`: the negation resets $?, and every failure would look like a crash.
  bash "$file"
  status=$?
  # 1 is failed assertions, already recorded; above that the file blew up and left no trace.
  if [ "$status" -gt 1 ]; then
    CRASHED+=("$name")
    printf '%s  file exited %d without completing%s\n' "$C_RED" "$status" "$C_OFF"
    printf 'FAIL\t%s\t<file aborted>\texit status %d\n' "$name" "$status" >>"$RESULT_FILE"
  fi
done

# ── Summary ─────────────────────────────────────────────────────────────────

elapsed=$(( $(date +%s) - started ))
passed=$(grep -c '^PASS' "$RESULT_FILE" || true)
failed=$(grep -c '^FAIL' "$RESULT_FILE" || true)
skipped=$(grep -c '^SKIP' "$RESULT_FILE" || true)

printf '\n%s────────────────────────────────────────────────────────%s\n' "$C_BOLD" "$C_OFF"

if [ "$failed" -gt 0 ]; then
  printf '%sFailures:%s\n' "$C_RED" "$C_OFF"
  awk -F'\t' '$1=="FAIL" {printf "  %-28s %s\n", $2, $3; if ($4 != "") printf "      %s\n", $4}' "$RESULT_FILE"
  printf '\n'
fi

if [ "$skipped" -gt 0 ]; then
  printf '%sSkipped:%s\n' "$C_YELLOW" "$C_OFF"
  awk -F'\t' '$1=="SKIP" {printf "  %-28s %s (%s)\n", $2, $3, $4}' "$RESULT_FILE"
  printf '\n'
fi

# ── API surface coverage ────────────────────────────────────────────────────
#
# Informational, never a gate - see helpers/api_coverage.py.
if [ "$#" -eq 0 ] && [ "$AGENT_PHASE" = "0" ] && [ -s "$STATE_DIR/openapi.json" ]; then
  python3 "$SUITE_DIR/helpers/api_coverage.py" "$STATE_DIR/openapi.json" "$CALLS_FILE" || true
elif [ "$#" -gt 0 ] || [ "$AGENT_PHASE" = "1" ]; then
  printf '%sAPI surface coverage skipped - a filtered run does not measure the whole surface%s\n\n' \
    "$C_DIM" "$C_OFF"
fi

printf '%s%d passed%s, ' "$C_GREEN" "$passed" "$C_OFF"
if [ "$failed" -gt 0 ]; then
  printf '%s%d failed%s, ' "$C_RED" "$failed" "$C_OFF"
else
  printf '%d failed, ' "$failed"
fi
printf '%d skipped  %s(%ds)%s\n' "$skipped" "$C_DIM" "$elapsed" "$C_OFF"

if [ "${#CRASHED[@]}" -gt 0 ]; then
  printf '%saborted files: %s%s\n' "$C_RED" "${CRASHED[*]}" "$C_OFF"
fi

printf '%s────────────────────────────────────────────────────────%s\n' "$C_BOLD" "$C_OFF"

[ "$failed" -eq 0 ] || exit 1
