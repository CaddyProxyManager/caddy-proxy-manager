#!/bin/sh

run_step() {
  label="$1"
  shift

  printf '\n==> %s\n' "$label"
  "$@"
  status=$?
  if [ "$status" -eq 0 ]; then
    printf '    %s: PASS\n' "$label"
  else
    printf '    %s: FAIL (%s)\n' "$label" "$status"
  fi
  return "$status"
}

lint_status=0
typecheck_status=0
unit_status=0
e2e_status=0

run_step "Lint" bun run lint
lint_status=$?

run_step "Typecheck" bun run typecheck
typecheck_status=$?

# The "check everything" entry point, so the coverage ratchet belongs here.
run_step "Unit + integration + coverage" bun run test:coverage
unit_status=$?

run_step "Playwright" bun run test:e2e
e2e_status=$?

printf '\n==> Summary\n'
printf '    Lint: %s\n' "$( [ "$lint_status" -eq 0 ] && printf PASS || printf FAIL )"
printf '    Typecheck: %s\n' "$( [ "$typecheck_status" -eq 0 ] && printf PASS || printf FAIL )"
printf '    Unit + integration + coverage: %s\n' "$( [ "$unit_status" -eq 0 ] && printf PASS || printf FAIL )"
printf '    Playwright: %s\n' "$( [ "$e2e_status" -eq 0 ] && printf PASS || printf FAIL )"

if [ "$lint_status" -ne 0 ] || [ "$typecheck_status" -ne 0 ] || [ "$unit_status" -ne 0 ] || [ "$e2e_status" -ne 0 ]; then
  exit 1
fi
