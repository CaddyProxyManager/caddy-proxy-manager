#!/bin/sh
# Starts Headscale, then leaves a reusable pre-auth key in /keys/authkey for every other node.
set -eu

rm -f /keys/authkey
headscale serve &
server=$!

until curl -sf -o /dev/null http://127.0.0.1:8080/health; do sleep 1; done

headscale users create rig >/dev/null 2>&1 || true
user=$(headscale users list -o json | jq -r '.[] | select(.name == "rig") | .id')
headscale preauthkeys create --user "$user" --reusable --expiration 24h >/keys/authkey.tmp
tail -n1 /keys/authkey.tmp | tr -d '\r\n' >/keys/authkey
rm -f /keys/authkey.tmp
# For the runner, to look nodes' addresses up through the REST API.
headscale apikeys create --expiration 24h | tail -n1 | tr -d '\r\n' >/keys/apikey
chmod 0644 /keys/authkey /keys/apikey
echo "headscale: pre-auth key for user $user written to /keys/authkey"

wait "$server"
