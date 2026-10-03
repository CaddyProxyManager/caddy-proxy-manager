#!/usr/bin/env bash
# Email through real SMTP servers (mailpit): Settings → Email saved and tested over STARTTLS with
# credentials and over implicit TLS, a server that refuses plain text and a certificate for another
# name both failing, then a password reset and an invitation read out of the mailbox and followed
# to a sign-in with the password they set.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "email"

EMAIL_PAGE=/settings/email
FROM=cpm-rig@cpm.test
RUN="m$(date +%s)$$"
NEW_PASSWORD='Rig-Reset-Passw0rd!'

# save_smtp HOST PORT SECURITY [USERNAME PASSWORD] - through the Settings form's own action.
save_smtp() {
  server_action "$EMAIL_PAGE" updateEmailSettingsAction --form smtpEnabled=on \
    "smtpHost=$1" "smtpPort=$2" "smtpSecurity=$3" "smtpUsername=${4:-}" "smtpPassword=${5:-}" \
    "smtpFrom=$FROM"
  [ "$(printf '%s' "$ACTION_RESULT" | jq -r '.success' 2>/dev/null)" = "true" ]
}

send_test() {  # send_test RECIPIENT -> ACTION_RESULT; true when the action reports success
  server_action "$EMAIL_PAGE" sendTestEmailAction --args "$(jq -nc --arg r "$1" '[$r]')"
  [ "$(printf '%s' "$ACTION_RESULT" | jq -r '.success' 2>/dev/null)" = "true" ]
}

restore() {
  server_action "$EMAIL_PAGE" updateEmailSettingsAction --form smtpPort=587 smtpSecurity=starttls \
    >/dev/null 2>&1
}
trap 'cleanup_tracked; restore' EXIT

mail_clear "$MAILBOX"
mail_clear "$MAILBOX_TLS"

# ── STARTTLS with credentials ───────────────────────────────────────────────

if save_smtp mailpit 1025 starttls cpm-mailer rig-smtp-password; then
  pass "SMTP settings can be saved through Settings → Email"
else
  fail "SMTP settings can be saved through Settings → Email" "$(printf '%.300s' "$ACTION_RESULT")"
fi

to="starttls-$RUN@cpm.test"
if send_test "$to"; then
  pass "a test message is accepted over STARTTLS with credentials"
else
  fail "a test message is accepted over STARTTLS with credentials" "$(printf '%.300s' "$ACTION_RESULT")"
fi
if mail_wait "$MAILBOX" "$to" "test message"; then
  pass "it arrives at the server that requires STARTTLS"
  t_eq "from the configured address" "$FROM" "$(printf '%s' "$MAIL_JSON" | jq -r '.From.Address')"
  t_eq "under the app's name" "CPM Docker Test" "$(printf '%s' "$MAIL_JSON" | jq -r '.From.Name')"
  t_contains "naming the server it went through" "mailpit" "$(printf '%s' "$MAIL_JSON" | jq -r '.Text')"
else
  fail "it arrives at the server that requires STARTTLS" "nothing for $to in $MAILBOX"
fi

save_smtp mailpit 1025 starttls cpm-mailer wrong-password >/dev/null
to="badauth-$RUN@cpm.test"
send_test "$to"
t_eq "a wrong SMTP password fails the test message" "false" "$(printf '%s' "$ACTION_RESULT" | jq -r '.success')"

save_smtp mailpit 1025 none cpm-mailer rig-smtp-password >/dev/null
to="plain-$RUN@cpm.test"
send_test "$to"
t_eq "plain text to a server requiring STARTTLS fails" "false" "$(printf '%s' "$ACTION_RESULT" | jq -r '.success')"

# The rig CA signs the certificate, but not for this name.
save_smtp smtp-untrusted.rig.internal 1025 starttls cpm-mailer rig-smtp-password >/dev/null
to="untrusted-$RUN@cpm.test"
send_test "$to"
t_eq "a certificate issued for another name is refused" "false" "$(printf '%s' "$ACTION_RESULT" | jq -r '.success')"
t_eq "and nothing refused was delivered" "0" \
  "$(( $(mail_count "$MAILBOX" "badauth-$RUN@cpm.test") + $(mail_count "$MAILBOX" "plain-$RUN@cpm.test") + $(mail_count "$MAILBOX" "$to") ))"

# ── Implicit TLS ────────────────────────────────────────────────────────────

save_smtp mailpit-tls 1025 tls >/dev/null
to="tls-$RUN@cpm.test"
if send_test "$to" && mail_wait "$MAILBOX_TLS" "$to" "test message"; then
  pass "a test message is delivered over implicit TLS"
else
  fail "a test message is delivered over implicit TLS" "$(printf '%.300s' "$ACTION_RESULT")"
fi

save_smtp mailpit-tls 1025 starttls >/dev/null
send_test "tls-starttls-$RUN@cpm.test"
t_eq "STARTTLS against an implicit-TLS port fails" "false" "$(printf '%s' "$ACTION_RESULT" | jq -r '.success')"

save_smtp mailpit 1025 starttls cpm-mailer rig-smtp-password || fail "the working settings can be restored"

# ── Password reset ──────────────────────────────────────────────────────────

# public_post PATH BODY -> API_STATUS, API_BODY; the reset routes demand a same-origin Origin.
public_post() {
  local out="$STATE_DIR/public-post.$$"
  API_STATUS=$(curl -sS --max-time 20 -o "$out" -w '%{http_code}' -H 'Content-Type: application/json' \
    -H "Origin: $CPM_API" --data-binary "$2" "$CPM_API$1" 2>/dev/null) || API_STATUS=000
  API_BODY=$(cat "$out" 2>/dev/null); rm -f "$out"
}

# sign_in_email EMAIL PASSWORD -> the status. Better Auth allows three sign-ins per 10s per client,
# so a 429 is waited out rather than reported.
sign_in_email() {
  local status
  for _ in $(seq 1 15); do
    status=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
      -H "Origin: $CPM_API" --data-binary "$(jq -nc --arg e "$1" --arg p "$2" '{email:$e, password:$p}')" \
      "$CPM_API/api/auth/sign-in/email" 2>/dev/null)
    [ "$status" != "429" ] && break
    sleep 1
  done
  printf '%s' "$status"
}

link_in() { printf '%s' "$MAIL_JSON" | jq -r '.Text' | grep -oE 'https?://[^ ]*/login/reset-password#[A-Za-z0-9_-]+' | head -n1; }

reset_email="reset-$RUN@cpm.test"
if create_resource users "$(jq -nc --arg e "$reset_email" --arg u "reset-$RUN" \
     '{email:$e, username:$u, password:"Rig-Initial-Passw0rd!", role:"user"}')"; then
  pass "a user with a deliverable address can be created"
else
  fail "a user with a deliverable address can be created" "HTTP $API_STATUS: $(printf '%.200s' "$API_BODY")"
fi

public_post /api/password-reset/request "$(jq -nc --arg i "reset-$RUN" '{identifier:$i}')"
t_eq "a reset can be requested by username" "200" "$API_STATUS"

public_post /api/password-reset/request '{"identifier":"nobody-at-all"}'
t_eq "an unknown identifier gets the same answer" "200" "$API_STATUS"

public_post /api/password-reset/request "$(jq -nc --arg e "$reset_email" '{identifier:$e}')"
t_eq "and by email" "200" "$API_STATUS"

t_eq "a request without a same-origin Origin is refused" "403" \
  "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
       --data-binary '{"identifier":"x"}' "$CPM_API/api/password-reset/request")"

# Two requests: the second link replaces the first.
if wait_for "two reset messages" 30 bash -c "[ \"\$(curl -sS '$MAILBOX/api/v1/messages?limit=200' | jq --arg to '$reset_email' '[.messages[] | select(any(.To[]; .Address == \$to))] | length')\" -ge 2 ]"; then
  pass "each request sends a reset message"
else
  fail "each request sends a reset message" "$(mail_count "$MAILBOX" "$reset_email") message(s) for $reset_email"
fi
older_id=$(curl -sS "$MAILBOX/api/v1/messages?limit=200" | jq -r --arg to "$reset_email" \
  '[.messages[] | select(any(.To[]; .Address == $to))] | last | .ID')
MAIL_JSON=$(curl -sS "$MAILBOX/api/v1/message/$older_id")
older_token=$(link_in | sed 's/.*#//')

mail_wait "$MAILBOX" "$reset_email" "Reset your"
t_contains "the subject names the app" "CPM Docker Test" "$(printf '%s' "$MAIL_JSON" | jq -r '.Subject')"
link=$(link_in)
t_matches "the message carries a link to the reset page on the public URL" \
  "^${CPM_API//./\\.}/login/reset-password#[A-Za-z0-9_-]{43}$" "$link"
token="${link#*#}"

public_post /api/password-reset/inspect "$(jq -nc --arg t "$older_token" '{token:$t}')"
t_eq "the link a newer one replaced no longer works" "404" "$API_STATUS"

t_eq "the link opens the reset page" "200" \
  "$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "${link%%#*}")"

public_post /api/password-reset/inspect "$(jq -nc --arg t "$token" '{token:$t}')"
t_eq "the page can read what the link is for" "reset|reset-$RUN" "$(jqr '"\(.purpose)|\(.username)"')"

public_post /api/password-reset/complete "$(jq -nc --arg t "$token" '{token:$t, password:"short"}')"
t_eq "a password the policy refuses is rejected" "PASSWORD_POLICY" "$(jqr '.code')"

public_post /api/password-reset/complete "$(jq -nc --arg t "$token" --arg p "$NEW_PASSWORD" '{token:$t, password:$p}')"
t_eq "without using up the link, which then sets the password" "200|reset" "$API_STATUS|$(jqr '.purpose')"

public_post /api/password-reset/complete "$(jq -nc --arg t "$token" --arg p "$NEW_PASSWORD" '{token:$t, password:$p}')"
t_eq "the link works once" "404" "$API_STATUS"

t_eq "the new password signs in" "200" "$(sign_in_email "$reset_email" "$NEW_PASSWORD")"
t_ne "the old one does not" "200" "$(sign_in_email "$reset_email" "Rig-Initial-Passw0rd!")"

# ── Invitation ──────────────────────────────────────────────────────────────

invitee="invitee-$RUN@cpm.test"
server_action /users createUserAction --form-only "email=$invitee" "name=Rig Invitee" role=user invite=on
t_eq "an admin can invite a user with no password" "success" "$(printf '%s' "$ACTION_RESULT" | jq -r '.status')"
api GET /api/v1/users
invitee_id=$(jqr 'first(.[] | select(.email == $e)) | .id' --arg e "$invitee")
[ -n "$invitee_id" ] && [ "$invitee_id" != "null" ] && track "users/$invitee_id"

if mail_wait "$MAILBOX" "$invitee" "invited"; then
  pass "the invitation is delivered"
  link=$(link_in)
  token="${link#*#}"
  public_post /api/password-reset/inspect "$(jq -nc --arg t "$token" '{token:$t}')"
  t_eq "its link is an invitation" "invite" "$(jqr '.purpose')"
  t_ne "the invitee cannot sign in before accepting" "200" "$(sign_in_email "$invitee" "$NEW_PASSWORD")"
  public_post /api/password-reset/complete "$(jq -nc --arg t "$token" --arg p "$NEW_PASSWORD" '{token:$t, password:$p}')"
  t_eq "accepting it sets a password" "200|invite" "$API_STATUS|$(jqr '.purpose')"
  t_eq "the invitee signs in with it" "200" "$(sign_in_email "$invitee" "$NEW_PASSWORD")"
else
  fail "the invitation is delivered" "nothing for $invitee in $MAILBOX"
fi

# A user with a password gets a reset link from the same button, not another invitation.
server_action /users sendEmailedLinkAction --args "[$invitee_id]"
t_eq "re-sending to an account with a password is allowed" "success" "$(printf '%s' "$ACTION_RESULT" | jq -r '.status')"
if mail_wait "$MAILBOX" "$invitee" "Reset your"; then
  pass "and sends a reset link instead"
else
  fail "and sends a reset link instead" "no reset message for $invitee"
fi

finish
