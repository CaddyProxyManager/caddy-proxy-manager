#!/usr/bin/env bash
# A host's raw configuration: pre-handler JSON, JSON merged into its reverse_proxy, and a Caddyfile
# snippet adapted by Caddy - each seen on the request origin-a reflects or on the response - and
# the input each of them refuses.
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "advanced host configuration"

domain=$(domain_for "advanced-config")
# In the snippet's path, so the origin's request log is searched for this run alone.
TEAPOT="/teapot-$(date +%s)$$"
pre='[{"handler":"headers","request":{"set":{"X-Rig-Pre":["from-pre-handler"]}},
       "response":{"set":{"X-Rig-Pre-Response":["set"]}}}]'
proxy='{"headers":{"request":{"set":{"X-Rig-Proxy":["merged-into-reverse-proxy"]}}}}'
snippet="request_header X-Rig-Caddyfile \"from-the-snippet\"
header X-Rig-Caddyfile-Response \"set\"
respond $TEAPOT \"short and stout\" 418"

create_host_or_fail "a host with raw configuration can be created" "$(jq -nc --arg d "$domain" \
  --arg pre "$pre" --arg proxy "$proxy" --arg cf "$snippet" '{
    name: "docker-test advanced config", domains: [$d], upstreams: ["origin-a:8080"],
    customPreHandlersJson: $pre, customReverseProxyJson: $proxy, customCaddyfile: $cf}')" || finish
pass "a host with raw configuration can be created"
host_id=$NEW_ID

api GET "/api/v1/proxy-hosts/$host_id"
t_eq "the three fields read back" "true|true|true" \
  "$(jqr '"\(.customPreHandlersJson != null)|\(.customReverseProxyJson != null)|\(.customCaddyfile != null)"')"

wait_for_https "$domain" 120
fetch "https://$domain/reflect"
t_eq "the host still proxies" "200|origin-a" "$FETCH_CODE|$(fetch_json '.origin')"
t_eq "the pre-handler's request header reaches the upstream" "from-pre-handler" "$(fetch_json '.headers["x-rig-pre"]')"
t_eq "and its response header reaches the client" "set" "$(header_value x-rig-pre-response)"
t_eq "the reverse_proxy JSON is merged in" "merged-into-reverse-proxy" "$(fetch_json '.headers["x-rig-proxy"]')"
t_eq "the Caddyfile snippet's request header reaches the upstream" "from-the-snippet" \
  "$(fetch_json '.headers["x-rig-caddyfile"]')"
t_eq "and its response header the client" "set" "$(header_value x-rig-caddyfile-response)"

fetch "https://$domain$TEAPOT"
t_eq "a snippet's respond answers before the upstream" "418|short and stout" "$FETCH_CODE|$FETCH_BODY"
t_eq "which never sees the request" "0" \
  "$(curl -sS --max-time 10 http://origin-a:8080/__requests | jq --arg p "$TEAPOT" '[.[] | select(.raw_path == $p)] | length')"

# ── Refused input ───────────────────────────────────────────────────────────

refused() {  # refused NAME FIELD VALUE - an update setting FIELD to VALUE is a 400
  api PUT "/api/v1/proxy-hosts/$host_id" "$(jq -nc --arg f "$2" --arg v "$3" '{($f): $v}')"
  t_eq "$1" "400" "$API_STATUS"
}

refused "a Caddyfile snippet Caddy cannot adapt is refused" customCaddyfile 'not_a_directive'
t_contains "naming the problem" "Caddyfile" "$API_BODY"
refused "a snippet configuring TLS, which is not a route's to set, is refused" customCaddyfile \
  'tls /etc/rig/cert.pem /etc/rig/key.pem'
refused "pre-handler JSON that does not parse is refused" customPreHandlersJson '[{"handler": "headers"'
refused "pre-handlers that are not objects are refused" customPreHandlersJson '["headers"]'
refused "reverse_proxy JSON that does not parse is refused" customReverseProxyJson '{"headers":'
refused "reverse_proxy JSON that is not an object is refused" customReverseProxyJson '[1, 2]'

api GET "/api/v1/proxy-hosts/$host_id"
t_eq "a refused update leaves the last good snippet" "$snippet" "$(jqr '.customCaddyfile')"
fetch "https://$domain/reflect"
t_eq "and the host serving as before" "200|from-pre-handler" "$FETCH_CODE|$(fetch_json '.headers["x-rig-pre"]')"

# ── Clearing ────────────────────────────────────────────────────────────────

api PUT "/api/v1/proxy-hosts/$host_id" '{"customPreHandlersJson":null,"customReverseProxyJson":"","customCaddyfile":null}'
t_eq "the raw fields can be cleared" "200" "$API_STATUS"
cleared() { [ "$(http_code "https://$domain$TEAPOT")" = "200" ]; }
if wait_for "the snippet to leave the host" 30 cleared; then
  fetch "https://$domain/reflect"
  t_eq "and none of them applies any more" "||" \
    "$(fetch_json '.headers["x-rig-pre"] // ""')|$(fetch_json '.headers["x-rig-proxy"] // ""')|$(fetch_json '.headers["x-rig-caddyfile"] // ""')"
else
  fail "the snippet stops applying once cleared" "$TEAPOT still answers $(http_code "https://$domain$TEAPOT")"
fi

finish
