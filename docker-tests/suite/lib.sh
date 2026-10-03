#!/usr/bin/env bash
# Shared helpers, sourced by every file under tests/. Assertions record and return rather than
# abort, so one broken feature does not hide the rest; a file exits non-zero if any failed.

# shellcheck disable=SC2034  # several colour vars are used only by some files

set -o pipefail

STATE_DIR="${STATE_DIR:-/tmp/cpm-test}"
RESULT_FILE="${RESULT_FILE:-$STATE_DIR/results.tsv}"
# For run-tests.sh's API-surface coverage report.
CALLS_FILE="${CALLS_FILE:-$STATE_DIR/api-calls.tsv}"
SPEC_FILE="$STATE_DIR/openapi.json"
TOKEN_FILE="$STATE_DIR/api-token"
CA_BUNDLE="$STATE_DIR/ca-bundle.pem"
CPM_API="${CPM_API:-http://web.cpm.internal:3000}"
TEST_DOMAIN="${TEST_DOMAIN:-cpm.test}"
CADDY_IP="${CADDY_IP:-172.28.0.10}"
CLIENT_IP="${CLIENT_IP:-172.28.0.40}"

mkdir -p "$STATE_DIR"

if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_RED=; C_GREEN=; C_YELLOW=; C_BLUE=; C_DIM=; C_BOLD=; C_OFF=
fi

SUITE_NAME="${SUITE_NAME:-$(basename "${BASH_SOURCE[1]:-suite}" .sh)}"
FAIL_COUNT=0

# ── Result recording ────────────────────────────────────────────────────────

_record() {
  # _record STATUS NAME DETAIL
  printf '%s\t%s\t%s\t%s\n' "$1" "$SUITE_NAME" "$2" "${3//$'\n'/ }" >>"$RESULT_FILE"
}

pass() {
  _record PASS "$1" ""
  printf '  %sok%s   %s\n' "$C_GREEN" "$C_OFF" "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  _record FAIL "$1" "${2:-}"
  printf '  %sFAIL%s %s\n' "$C_RED" "$C_OFF" "$1"
  if [ -n "${2:-}" ]; then
    printf '       %s%s%s\n' "$C_DIM" "$2" "$C_OFF"
  fi
}

skip() {
  _record SKIP "$1" "${2:-}"
  printf '  %sskip%s %s %s(%s)%s\n' "$C_YELLOW" "$C_OFF" "$1" "$C_DIM" "${2:-}" "$C_OFF"
}

info() { printf '  %s->%s %s\n' "$C_BLUE" "$C_OFF" "$*"; }

banner() {
  printf '\n%s== %s ==%s\n' "$C_BOLD" "$*" "$C_OFF"
}

# ── Assertions ──────────────────────────────────────────────────────────────

t_eq() {  # t_eq NAME EXPECTED ACTUAL
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected '$2', got '$3'"; fi
}

t_ne() {  # t_ne NAME NOT_EXPECTED ACTUAL
  if [ "$2" != "$3" ]; then pass "$1"; else fail "$1" "expected anything but '$2'"; fi
}

t_contains() {  # t_contains NAME NEEDLE HAYSTACK
  case "$3" in
    *"$2"*) pass "$1" ;;
    *) fail "$1" "'$2' not found in: $(printf '%.400s' "$3")" ;;
  esac
}

t_not_contains() {  # t_not_contains NAME NEEDLE HAYSTACK
  case "$3" in
    *"$2"*) fail "$1" "'$2' unexpectedly present in: $(printf '%.400s' "$3")" ;;
    *) pass "$1" ;;
  esac
}

t_matches() {  # t_matches NAME REGEX VALUE
  if printf '%s' "$3" | grep -Eq "$2"; then pass "$1"; else fail "$1" "'$3' does not match /$2/"; fi
}

t_ok() {  # t_ok NAME CMD...
  local name="$1"; shift
  local out
  if out=$("$@" 2>&1); then pass "$name"; else fail "$name" "command failed: $* :: $(printf '%.300s' "$out")"; fi
}

t_fails() {  # t_fails NAME CMD... - passes when the command exits non-zero
  local name="$1"; shift
  local out
  if out=$("$@" 2>&1); then fail "$name" "command unexpectedly succeeded: $*"; else pass "$name"; fi
}

# ── CPM REST API ────────────────────────────────────────────────────────────
#
# api METHOD PATH [BODY] -> API_STATUS, API_BODY, with bootstrap.sh's token unless API_TOKEN is set.
# API_MAX_TIME raises the 60s limit for a call that waits on something slow on purpose.

API_STATUS=
API_BODY=

# The raw path; the reporter matches it to a template, so nothing here knows which segments are ids.
_record_api_call() {
  printf '%s\t%s\n' "$1" "${2%%\?*}" >>"$CALLS_FILE" 2>/dev/null || true
}

api() {
  local method="$1" path="$2" body="${3:-}"
  _record_api_call "$method" "$path"
  local token="${API_TOKEN-$(cat "$TOKEN_FILE" 2>/dev/null)}"
  local base="${API_BASE:-$CPM_API}"
  local out="$STATE_DIR/api-out.$$"
  local args=(-sS -X "$method" --max-time "${API_MAX_TIME:-60}" -o "$out" -w '%{http_code}')
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data-binary "$body")
  fi
  API_STATUS=$(curl "${args[@]}" "$base$path" 2>"$out.err") || API_STATUS="000"
  API_BODY=$(cat "$out" 2>/dev/null)
  [ "$API_STATUS" = "000" ] && API_BODY="$(cat "$out.err" 2>/dev/null)"
  rm -f "$out" "$out.err"
}

# jqr FILTER [jq args...] - jq over the last response; extra args go before the filter.
jqr() {
  local filter="$1"; shift
  printf '%s' "$API_BODY" | jq -r "$@" "$filter" 2>/dev/null
}

# with_token TOKEN CMD... - `local` scopes dynamically, so `api` frames down sees the override.
with_token() {
  local API_TOKEN="$1"; shift
  "$@"
}

# cpm_sign_in BASE_URL COOKIE_JAR USERNAME PASSWORD -> prints the HTTP status
# Which of email or username better-auth accepts depends on how the account was made; try both.
cpm_sign_in() {
  local base="$1" jar="$2" user="$3" password="$4"
  local out="$STATE_DIR/signin-$$.json" status

  status=$(curl -sS --max-time 15 -o "$out" -w '%{http_code}' -c "$jar" \
    -H 'Content-Type: application/json' -H "Origin: $base" \
    --data-binary "$(jq -nc --arg e "${user}@localhost" --arg p "$password" \
      '{email:$e, password:$p, rememberMe:true}')" \
    "$base/api/auth/sign-in/email" 2>/dev/null)

  if [ "$status" != "200" ]; then
    status=$(curl -sS --max-time 15 -o "$out" -w '%{http_code}' -c "$jar" \
      -H 'Content-Type: application/json' -H "Origin: $base" \
      --data-binary "$(jq -nc --arg u "$user" --arg p "$password" \
        '{username:$u, password:$p, rememberMe:true}')" \
      "$base/api/auth/sign-in/username" 2>/dev/null)
  fi

  SIGN_IN_BODY=$(cat "$out" 2>/dev/null)
  rm -f "$out"
  printf '%s' "$status"
}

# cpm_mint_token BASE_URL COOKIE_JAR NAME -> prints the raw token, empty on failure
cpm_mint_token() {
  curl -sS --max-time 15 -b "$2" \
    -H 'Content-Type: application/json' -H "Origin: $1" \
    --data-binary "$(jq -nc --arg n "$3" '{name:$n}')" \
    "$1/api/v1/tokens" 2>/dev/null | jq -r '.raw_token // empty'
}

# A new admin session in bootstrap's jar. Key downloads and restores want a sign-in from the last
# ten minutes, which bootstrap's is not by the time a full run reaches them.
fresh_session() {
  [ "$(cpm_sign_in "$CPM_API" "$STATE_DIR/cookies.txt" "$CPM_ADMIN_USER" "$CPM_ADMIN_PASSWORD")" = "200" ]
}

# Endpoints outside /api/v1 (waf-events, geoip-status, l4-ports) need a session cookie, not a token.
api_session() {  # api_session METHOD PATH [BODY] -> API_STATUS, API_BODY
  local method="$1" path="$2" body="${3:-}"
  _record_api_call "$method" "$path"
  local out="$STATE_DIR/api-session-out.$$"
  local args=(-sS -X "$method" --max-time 60 -o "$out" -w '%{http_code}'
              -b "$STATE_DIR/cookies.txt" -H "Origin: $CPM_API")
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data-binary "$body")
  fi
  API_STATUS=$(curl "${args[@]}" "$CPM_API$path" 2>/dev/null) || API_STATUS="000"
  API_BODY=$(cat "$out" 2>/dev/null)
  rm -f "$out"
}

api_expect() {  # api_expect NAME EXPECTED_STATUS METHOD PATH [BODY]
  local name="$1" want="$2"; shift 2
  api "$@"
  if [ "$API_STATUS" = "$want" ]; then
    pass "$name"
  else
    fail "$name" "HTTP $API_STATUS (wanted $want): $(printf '%.300s' "$API_BODY")"
  fi
}

# ── Resource lifecycle ──────────────────────────────────────────────────────
#
# Torn down by the EXIT trap, so a failure part-way does not leak hosts into the next file.

CLEANUP_STACK=()

track() { CLEANUP_STACK+=("$1"); }   # track "proxy-hosts/12"

cleanup_tracked() {
  local i
  for (( i=${#CLEANUP_STACK[@]}-1; i>=0; i-- )); do
    api DELETE "/api/v1/${CLEANUP_STACK[$i]}" >/dev/null 2>&1
  done
  CLEANUP_STACK=()
}

trap cleanup_tracked EXIT

# create_resource COLLECTION JSON - sets NEW_ID and tracks it; non-zero on failure.
# Does not echo the id: a $(...) subshell would lose the `track` on the caller's cleanup stack.
NEW_ID=

create_resource() {
  local collection="$1" body="$2"
  NEW_ID=
  api POST "/api/v1/$collection" "$body"
  case "$API_STATUS" in
    200|201) ;;
    *)
      # A rejected config still leaves the row, failing every later push; adopt it for teardown.
      local name status_backup="$API_STATUS" body_backup="$API_BODY"
      name=$(printf '%s' "$body" | jq -r '.name // empty' 2>/dev/null)
      if [ -n "$name" ]; then
        api GET "/api/v1/$collection"
        local orphan
        while read -r orphan; do
          [ -n "$orphan" ] && track "$collection/$orphan"
        done < <(printf '%s' "$API_BODY" | jq -r --arg n "$name" '.[]? | select(.name == $n) | .id' 2>/dev/null)
      fi
      API_STATUS="$status_backup"; API_BODY="$body_backup"
      return 1 ;;
  esac
  local id; id=$(jqr '.id')
  [ -n "$id" ] && [ "$id" != "null" ] || return 1
  NEW_ID="$id"
  track "$collection/$id"
  return 0
}

create_host() { create_resource proxy-hosts "$1"; }
create_l4_host() { create_resource l4-proxy-hosts "$1"; }

# create_host_or_fail NAME JSON - records a failed assertion if rejected; NEW_ID on success.
create_host_or_fail() {
  local name="$1" body="$2"
  if create_host "$body"; then
    return 0
  fi
  fail "$name" "could not create proxy host: HTTP $API_STATUS $(printf '%.300s' "$API_BODY")"
  return 1
}

# ── HTTP client against Caddy ───────────────────────────────────────────────
#
# fetch URL [curl args...] -> FETCH_CODE, FETCH_BODY, FETCH_HEADERS, FETCH_RC
# Names resolve through dnsmasq, so Caddy sees a genuine SNI + Host pair.

FETCH_CODE=; FETCH_BODY=; FETCH_HEADERS=; FETCH_RC=0

fetch() {
  local url="$1"; shift
  local body="$STATE_DIR/fetch-body.$$" hdr="$STATE_DIR/fetch-hdr.$$"
  FETCH_CODE=$(curl -sS --max-time 20 --cacert "$CA_BUNDLE" \
    -o "$body" -D "$hdr" -w '%{http_code}' "$@" "$url" 2>"$hdr.err")
  FETCH_RC=$?
  FETCH_BODY=$(cat "$body" 2>/dev/null)
  FETCH_HEADERS=$(cat "$hdr" 2>/dev/null)
  [ "$FETCH_RC" -ne 0 ] && FETCH_HEADERS="$FETCH_HEADERS$(cat "$hdr.err" 2>/dev/null)"
  rm -f "$body" "$hdr" "$hdr.err"
  return $FETCH_RC
}

# Lower-cased name; the last occurrence wins.
header_value() {
  printf '%s' "$FETCH_HEADERS" \
    | tr -d '\r' \
    | grep -i "^$1:" \
    | tail -n1 \
    | sed "s/^[^:]*: *//"
}

fetch_json() { printf '%s' "$FETCH_BODY" | jq -r "$1" 2>/dev/null; }

# "000" when there was no response - a refused TLS handshake, as distinct from an HTTP rejection.
http_code() {
  local url="$1"; shift
  local code
  code=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' \
    --cacert "$CA_BUNDLE" "$@" "$url" 2>/dev/null)
  printf '%s' "${code:-000}"
}

http_body() {
  local url="$1"; shift
  curl -sS --max-time 20 --cacert "$CA_BUNDLE" "$@" "$url" 2>/dev/null
}

# ── TLS inspection ──────────────────────────────────────────────────────────

# tls_cert DOMAIN [openssl s_client args...] -> leaf certificate PEM on stdout
tls_cert() {
  local domain="$1"; shift
  printf '' | openssl s_client -connect "$domain:443" -servername "$domain" \
    "$@" 2>/dev/null | openssl x509 -outform pem 2>/dev/null
}

tls_field() {  # tls_field DOMAIN -subject|-issuer|-text
  local domain="$1" field="$2"; shift 2
  tls_cert "$domain" "$@" | openssl x509 -noout "$field" 2>/dev/null
}

# Succeeds only when a full TLS handshake completes and a certificate is served.
tls_handshake_ok() {
  local domain="$1"; shift
  printf '' | openssl s_client -connect "$domain:443" -servername "$domain" \
    -CAfile "$CA_BUNDLE" -verify_return_error "$@" 2>&1 | grep -q "Verify return code: 0 (ok)"
}

# ── Local PKI ───────────────────────────────────────────────────────────────
#
# Certificates CPM did not issue; idempotent across test files, all in $STATE_DIR.

# make_ca NAME - creates $STATE_DIR/NAME-ca.{crt,key}.pem and, for server CAs,
# adds the root to the bundle `fetch` verifies against.
make_ca() {
  local name="$1"
  local crt="$STATE_DIR/$name-ca.crt.pem"
  [ -s "$crt" ] && return 0
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$STATE_DIR/$name-ca.key.pem" -out "$crt" \
    -days 3650 -sha256 -subj "/CN=CPM Docker Test $name CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1 || return 1
  return 0
}

trust_ca() {  # trust_ca NAME - append a local CA to the client's trust store
  local name="$1" marker="$STATE_DIR/.trusted-$1"
  [ -e "$marker" ] && return 0
  cat "$STATE_DIR/$name-ca.crt.pem" >>"$CA_BUNDLE" && : >"$marker"
}

# issue_cert CA_NAME LEAF_NAME SUBJECT SAN PURPOSE
#   SAN     e.g. "DNS:a.cpm.test,DNS:*.b.cpm.test" - empty for client certs
#   PURPOSE serverAuth | clientAuth
issue_cert() {
  local ca="$1" leaf="$2" subject="$3" san="$4" purpose="${5:-serverAuth}"
  local base="$STATE_DIR/$leaf"
  openssl req -newkey rsa:2048 -nodes \
    -keyout "$base.key.pem" -out "$base.csr" -subj "$subject" >/dev/null 2>&1 || return 1
  {
    echo "basicConstraints=CA:FALSE"
    echo "keyUsage=critical,digitalSignature,keyEncipherment"
    echo "extendedKeyUsage=$purpose"
    [ -n "$san" ] && echo "subjectAltName=$san"
  } >"$base.ext"
  openssl x509 -req -in "$base.csr" \
    -CA "$STATE_DIR/$ca-ca.crt.pem" -CAkey "$STATE_DIR/$ca-ca.key.pem" -CAcreateserial \
    -out "$base.crt.pem" -days 825 -sha256 -extfile "$base.ext" >/dev/null 2>&1 || return 1
  rm -f "$base.csr" "$base.ext"
  return 0
}

cert_fingerprint() {  # lower-case hex, colon-free - the form Caddy compares against
  openssl x509 -in "$1" -noout -fingerprint -sha256 2>/dev/null \
    | sed 's/.*=//; s/://g' | tr 'A-Z' 'a-z'
}

cert_serial() { openssl x509 -in "$1" -noout -serial 2>/dev/null | sed 's/.*=//'; }
cert_not_before() { openssl x509 -in "$1" -noout -startdate 2>/dev/null | sed 's/.*=//'; }
cert_not_after() { openssl x509 -in "$1" -noout -enddate 2>/dev/null | sed 's/.*=//'; }

cert_date_iso() {  # cert_date_iso FILE -startdate|-enddate
  local raw; raw=$(openssl x509 -in "$1" -noout "$2" 2>/dev/null | sed 's/.*=//')
  date -u -d "$raw" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null
}

# ── Waiting ─────────────────────────────────────────────────────────────────

# wait_for DESCRIPTION TIMEOUT_SECONDS CMD...
wait_for() {
  local desc="$1" timeout="$2"; shift 2
  local deadline=$(( $(date +%s) + timeout ))
  while :; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      printf '  %s..%s timed out after %ss waiting for %s\n' "$C_DIM" "$C_OFF" "$timeout" "$desc"
      return 1
    fi
    sleep 1
  done
}

# Issuance is asynchronous after a config load.
wait_for_https() {
  local domain="$1" timeout="${2:-90}"
  wait_for "a certificate for $domain" "$timeout" tls_handshake_ok "$domain"
}

wait_for_http() {  # wait until an HTTP request to the domain returns a status
  local url="$1" timeout="${2:-30}"
  wait_for "$url to respond" "$timeout" curl -sS --max-time 5 -o /dev/null --cacert "$CA_BUNDLE" "$url"
}

# ── Rig DNS: dyn.cpm.test ───────────────────────────────────────────────────
#
# Records a test sets at run time, served by CoreDNS from a zone file on a volume the runner shares.
# The zone is rewritten whole with a higher serial, which CoreDNS reloads within a second. A file
# owns the names it sets and removes them itself.

RIG_ZONE_DIR="${RIG_ZONE_DIR:-/zones}"
RIG_DNS=172.28.0.5
COREDNS=172.28.0.6
DYN_DOMAIN="dyn.$TEST_DOMAIN"

rig_zone_write() {
  local serial now
  now=$(date +%s)
  serial=$(( $(cat "$RIG_ZONE_DIR/serial" 2>/dev/null || echo 0) + 1 ))
  [ "$serial" -lt "$now" ] && serial=$now
  printf '%s\n' "$serial" >"$RIG_ZONE_DIR/serial"
  touch "$RIG_ZONE_DIR/records"
  {
    printf '$ORIGIN %s.\n$TTL 1\n' "$DYN_DOMAIN"
    printf '@ IN SOA ns.%s. admin.%s. %s 60 60 60 1\n' "$DYN_DOMAIN" "$TEST_DOMAIN" "$serial"
    printf '@ IN NS ns.%s.\nns IN A %s\n' "$DYN_DOMAIN" "$COREDNS"
    cat "$RIG_ZONE_DIR/records"
  } >"$RIG_ZONE_DIR/zone.tmp" && mv "$RIG_ZONE_DIR/zone.tmp" "$RIG_ZONE_DIR/db.$DYN_DOMAIN"
}

rig_dns_answer() { dig +short +norec @"$COREDNS" "$1" "$2" 2>/dev/null; }

# rig_dns_set NAME TYPE VALUE - replaces NAME's records of TYPE; waits until CoreDNS answers.
rig_dns_set() {
  local name="${1%.}" type="$2" value="$3"
  rig_dns_del "$name" "$type" --no-wait
  printf '%s. IN %s %s\n' "$name" "$type" "$value" >>"$RIG_ZONE_DIR/records"
  rig_zone_write
  wait_for "$name $type $value in the rig DNS" 15 \
    bash -c "dig +short +norec @$COREDNS '$name' '$type' | grep -qxF '$value'"
}

# rig_dns_del NAME [TYPE] - every record of NAME, or only those of TYPE.
rig_dns_del() {
  local name="${1%.}" type="${2:-}" records="$RIG_ZONE_DIR/records"
  touch "$records"
  awk -v n="$name." -v t="$type" '!($1 == n && (t == "" || $3 == t))' "$records" \
    >"$records.tmp" && mv "$records.tmp" "$records"
  [ "${3:-}" = "--no-wait" ] && return 0
  rig_zone_write
  wait_for "$name to leave the rig DNS" 15 \
    bash -c "[ -z \"\$(dig +short +norec @$COREDNS '$name' '${type:-A}')\" ]"
}

# ── A second client address ─────────────────────────────────────────────────
#
# An alias on the runner's own interface, so an IP rule can be seen admitting one client and not
# the other. Outside Docker's allocation range in practice: nothing else is given .200.

ALT_CLIENT_IP="${ALT_CLIENT_IP:-172.28.0.200}"

add_client_alias() {
  local dev
  ip -o -4 addr show | grep -q " inet $ALT_CLIENT_IP/" && return 0
  dev=$(ip -o -4 addr show | awk -v ip="$CLIENT_IP" 'index($4, ip "/") == 1 {print $2; exit}')
  [ -n "$dev" ] && ip addr add "$ALT_CLIENT_IP/24" dev "$dev"
}

# ── Server actions ──────────────────────────────────────────────────────────
#
# server_action PAGE ACTION [--form] [key=value...] -> ACTION_RESULT (JSON), non-zero on a throw.
# For dashboard flows with no REST route, as the admin's session; see helpers/server_action.py.

ACTION_RESULT=

server_action() {
  ACTION_RESULT=$(python3 "$(dirname "${BASH_SOURCE[0]}")/helpers/server_action.py" \
    "$CPM_API" "$STATE_DIR/cookies.txt" "$@" 2>&1)
}

# ── Mail ────────────────────────────────────────────────────────────────────
#
# What mailpit received, through its API. BOX is a server's base URL: $MAILBOX or $MAILBOX_TLS.

MAILBOX="${MAILBOX:-http://mailpit:8025}"
MAILBOX_TLS="${MAILBOX_TLS:-http://mailpit-tls:8025}"

mail_clear() { curl -sS --max-time 10 -X DELETE "${1:-$MAILBOX}/api/v1/messages" >/dev/null 2>&1; }

# mail_find BOX TO SUBJECT_PART -> the newest matching message's id, empty when there is none
mail_find() {
  curl -sS --max-time 10 "$1/api/v1/messages?limit=200" 2>/dev/null | jq -r --arg to "$2" --arg s "$3" \
    'first(.messages[]? | select(any(.To[]?; .Address == $to) and (.Subject | contains($s)))) | .ID // empty'
}

_mail_present() { [ -n "$(mail_find "$1" "$2" "$3")" ]; }

# mail_wait BOX TO SUBJECT_PART [TIMEOUT] -> MAIL_ID, and the message as MAIL_JSON
MAIL_ID=; MAIL_JSON=
mail_wait() {
  local box="$1" to="$2" subject="$3" timeout="${4:-30}"
  MAIL_ID=; MAIL_JSON=
  wait_for "mail to $to about '$subject'" "$timeout" _mail_present "$box" "$to" "$subject" || return 1
  MAIL_ID=$(mail_find "$box" "$to" "$subject")
  MAIL_JSON=$(curl -sS --max-time 10 "$box/api/v1/message/$MAIL_ID" 2>/dev/null)
  [ -n "$MAIL_JSON" ]
}

mail_count() {  # mail_count BOX TO -> how many messages TO has received
  curl -sS --max-time 10 "$1/api/v1/messages?limit=200" 2>/dev/null \
    | jq -r --arg to "$2" '[.messages[]? | select(any(.To[]?; .Address == $to))] | length'
}

# ── Misc ────────────────────────────────────────────────────────────────────

# Per test file, so leftovers from an aborted run cannot collide.
domain_for() { printf '%s.%s' "$1" "$TEST_DOMAIN"; }

json_escape() { printf '%s' "$1" | jq -Rs .; }

pem_json() { jq -Rs . <"$1"; }

finish() {
  if [ "$FAIL_COUNT" -gt 0 ]; then
    printf '  %s%d assertion(s) failed in %s%s\n' "$C_RED" "$FAIL_COUNT" "$SUITE_NAME" "$C_OFF"
    exit 1
  fi
  exit 0
}
