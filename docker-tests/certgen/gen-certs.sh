#!/usr/bin/env bash
# Mints the fixed PKI the rig needs before anything else starts:
#   pebble-ca.*    the rig CA: signs Pebble's ACME endpoint (Caddy trusts it via acme.caRootPem)
#                  and every in-network TLS server below; web trusts it through NODE_EXTRA_CA_CERTS
#   pebble.*       Pebble's server cert, valid for the name Caddy dials (its own is localhost-only)
#   origin-tls.*   self-signed cert for the HTTPS origin, issued for a name it is NOT reachable
#                  under, so upstream hostname verification fails unless a host opts out
#   mailpit.*      the SMTP servers' certificate, for STARTTLS and implicit TLS
#   files.*        the file server standing in for MaxMind, GitHub and a CRS plugin registry
#   registry.*     the local container registry the update check reads
# Output lands in a named volume; each file is made only when missing or changed, so a leaf added
# later reaches an old volume without re-keying the CA everything else already trusts.
set -euo pipefail

CERT_DIR=/certs
DAYS=3650

mkdir -p "$CERT_DIR"
cd "$CERT_DIR"

if [ ! -s pebble-ca.crt.pem ]; then
  echo "certgen: generating the rig CA"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout pebble-ca.key.pem -out pebble-ca.crt.pem \
    -days "$DAYS" -sha256 \
    -subj "/CN=CPM Docker Test Pebble CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1
fi

leaf() {  # leaf NAME SAN - re-minted when SAN changes, so a name added here reaches an old volume
  local name="$1" san="$2"
  [ -s "$name.crt.pem" ] && [ "$(cat "$name.san" 2>/dev/null)" = "$san" ] && return 0
  echo "certgen: generating $name ($san)"
  openssl req -newkey rsa:2048 -nodes \
    -keyout "$name.key.pem" -out "$name.csr" -subj "/CN=$name" >/dev/null 2>&1
  printf '%s\n' "basicConstraints=CA:FALSE" \
    "keyUsage=critical,digitalSignature,keyEncipherment" \
    "extendedKeyUsage=serverAuth" "subjectAltName=$san" >"$name.ext"
  openssl x509 -req -in "$name.csr" \
    -CA pebble-ca.crt.pem -CAkey pebble-ca.key.pem -CAcreateserial \
    -out "$name.crt.pem" -days "$DAYS" -sha256 -extfile "$name.ext" >/dev/null 2>&1
  rm -f "$name.csr" "$name.ext"
  printf '%s' "$san" >"$name.san"
}

leaf pebble "DNS:pebble,DNS:localhost,IP:172.28.0.30,IP:127.0.0.1"
# Not smtp-untrusted.rig.internal, an alias of the same container: a name the certificate lacks.
leaf mailpit "DNS:mailpit,DNS:mailpit-tls"
leaf files "DNS:files.rig.internal,DNS:download.maxmind.com,DNS:updates.maxmind.com,DNS:api.github.com,DNS:raw.githubusercontent.com"
leaf registry "DNS:registry.rig.internal"

if [ ! -s origin-tls.crt.pem ]; then
  echo "certgen: generating the intentionally-mismatched HTTPS origin certificate"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout origin-tls.key.pem -out origin-tls.crt.pem \
    -days "$DAYS" -sha256 \
    -subj "/CN=not-the-origin-hostname.invalid" \
    -addext "subjectAltName=DNS:not-the-origin-hostname.invalid" >/dev/null 2>&1
fi

# Consumers run as assorted UIDs (Pebble as root, the origin as python's user, mailpit as its own).
# Nothing here is secret - it is a throwaway PKI on an isolated network.
chmod 0644 ./*.pem

echo "certgen: done"
ls -l "$CERT_DIR"
