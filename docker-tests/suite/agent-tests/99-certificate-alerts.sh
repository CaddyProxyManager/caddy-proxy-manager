#!/usr/bin/env bash
# Certificate expiry alerts, delivered: an imported certificate five days from expiry, Settings →
# Certificate alerts sending to a mailbox, and the scheduled check that runs five minutes after the
# controller starts. There is no way to run it on demand, so this restarts web (last in the phase,
# as it drops the agents' streams) after clearing the check's state, and waits for the mail.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "certificate expiry alerts"

EMAIL_PAGE=/settings/email
RECIPIENT="alerts-$(date +%s)@cpm.test"
POSTGRES=$(docker ps --filter label=com.docker.compose.project=cpm-docker-tests \
  --filter label=com.docker.compose.service=postgres --format '{{.Names}}' | head -n1)

restore() {
  server_action "$EMAIL_PAGE" updateEmailSettingsAction --form smtpPort=587 smtpSecurity=starttls >/dev/null 2>&1
  server_action "$EMAIL_PAGE" updateCertificateAlertSettingsAction --form alertRecipients= alertDays=14 >/dev/null 2>&1
}
trap 'cleanup_tracked; restore' EXIT

server_action "$EMAIL_PAGE" updateEmailSettingsAction --form smtpEnabled=on smtpHost=mailpit smtpPort=1025 \
  smtpSecurity=starttls smtpUsername=cpm-mailer smtpPassword=rig-smtp-password smtpFrom=cpm-rig@cpm.test
t_eq "email can be configured" "true" "$(printf '%s' "$ACTION_RESULT" | jq -r '.success')"
server_action "$EMAIL_PAGE" updateCertificateAlertSettingsAction --form "alertRecipients=$RECIPIENT" alertDays=14
t_eq "alerts can be sent to a recipient of their own" "true" "$(printf '%s' "$ACTION_RESULT" | jq -r '.success')"

make_ca alerts || fail "a local CA can be created" "openssl failed"
domain=$(domain_for "expiring-soon")
openssl req -newkey rsa:2048 -nodes -keyout "$STATE_DIR/expiring.key.pem" -out "$STATE_DIR/expiring.csr" \
  -subj "/CN=$domain" >/dev/null 2>&1
printf 'subjectAltName=DNS:%s\n' "$domain" >"$STATE_DIR/expiring.ext"
openssl x509 -req -in "$STATE_DIR/expiring.csr" -CA "$STATE_DIR/alerts-ca.crt.pem" -CAkey "$STATE_DIR/alerts-ca.key.pem" \
  -CAcreateserial -out "$STATE_DIR/expiring.crt.pem" -days 5 -extfile "$STATE_DIR/expiring.ext" >/dev/null 2>&1
if create_resource certificates "$(jq -nc --arg d "$domain" --rawfile c "$STATE_DIR/expiring.crt.pem" \
     --rawfile k "$STATE_DIR/expiring.key.pem" \
     '{name:"docker-test expiring soon", type:"imported", domainNames:[$d], certificatePem:$c, privateKeyPem:$k}')"; then
  pass "a certificate five days from expiry can be imported"
else
  fail "a certificate five days from expiry can be imported" "HTTP $API_STATUS: $(printf '%.200s' "$API_BODY")"
  finish
fi

# The check runs at most twice a day; a state from an earlier run would hold this one back.
t_ok "the check's last run can be forgotten" docker exec "$POSTGRES" \
  psql -U cpm -d cpm -c "DELETE FROM settings WHERE key = 'certificate_expiry_alerts'"

mail_clear "$MAILBOX"
docker restart cpm-test-web >/dev/null 2>&1
healthy() { curl -sSf --max-time 5 -o /dev/null "$CPM_API/api/health"; }
wait_for "web to come back" 120 healthy || { fail "web restarts" "no health answer"; finish; }
info "waiting for the check five minutes after startup"

if mail_wait "$MAILBOX" "$RECIPIENT" "attention" 420; then
  pass "the scheduled check emails the recipient"
  body=$(printf '%s' "$MAIL_JSON" | jq -r '.Text')
  t_contains "about the imported certificate" "docker-test expiring soon" "$body"
  t_matches "with its expiry date and the days left" 'expires on [0-9]{4}-[0-9]{2}-[0-9]{2}, in [45] days' "$body"
  t_contains "and a link to the certificates page" "$CPM_API/certificates" "$body"
  t_contains "under a subject naming the app" "attention on CPM Docker Test" "$(printf '%s' "$MAIL_JSON" | jq -r '.Subject')"
else
  fail "the scheduled check emails the recipient" "nothing for $RECIPIENT in $MAILBOX"
fi

state=$(docker exec "$POSTGRES" psql -U cpm -d cpm -tAc "SELECT value FROM settings WHERE key = 'certificate_expiry_alerts'")
t_ne "the run is recorded" "" "$(printf '%s' "$state" | jq -r '.checkedAt // empty')"
t_eq "with the certificate marked as reported" "expiring" "$(printf '%s' "$state" | jq -r '[.alerted[]] | first')"

finish
