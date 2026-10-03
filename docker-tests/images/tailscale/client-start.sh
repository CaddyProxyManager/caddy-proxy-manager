#!/bin/sh
# A tailnet client for the runner to reach Caddy's node through: waits for Headscale's key, then
# runs containerboot in userspace mode with a SOCKS5 server on the rig network.
set -eu
until [ -s /keys/authkey ]; do sleep 1; done
TS_AUTHKEY=$(cat /keys/authkey)
export TS_AUTHKEY
exec /usr/local/bin/containerboot
