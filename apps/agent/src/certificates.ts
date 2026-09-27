/**
 * Caddy's storage is readable only by Caddy's user (0700/0600), so it is read from a throwaway,
 * network-less container of Caddy's image with its volumes read-only, as `caddy validate` runs.
 */
import { X509Certificate } from "node:crypto";
import type { CaddyCertificate, CertificateFileRequest, CertificateFiles } from "@cpm/shared";
import type { DockerHost } from "./docker";

const ROOT = "/data/caddy/certificates";
const SEPARATOR = "@@cpm-cert@@";
/** A storage path component: an issuer directory or a certificate name, never a traversal. */
export const STORAGE_NAME = /^[A-Za-z0-9*][A-Za-z0-9._*+-]{0,252}$/;

/** Listing runs a container, so a page opened twice in a minute asks once. */
const CACHE_MS = 60_000;
let cached: { at: number; certificates: CaddyCertificate[] } | null = null;

export function clearCertificateCache() {
  cached = null;
}

/** Parse the listing script's output: a separator line with the path, then the PEM. */
export function parseCertificateListing(output: string): CaddyCertificate[] {
  const found: CaddyCertificate[] = [];
  for (const section of output.split(`${SEPARATOR} `).slice(1)) {
    const newline = section.indexOf("\n");
    const path = section.slice(0, newline).trim();
    const pem = section.slice(newline + 1);
    const [issuerKey, name] = path.split("/");
    if (!issuerKey || !name || !STORAGE_NAME.test(issuerKey) || !STORAGE_NAME.test(name)) continue;
    try {
      const cert = new X509Certificate(pem);
      const names = (cert.subjectAltName ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith("DNS:") || entry.startsWith("IP Address:"))
        .map((entry) => entry.replace(/^(DNS|IP Address):/, ""));
      found.push({
        issuerKey,
        name,
        names,
        issuer: cert.issuer.replace(/\n/g, ", "),
        notBefore: new Date(cert.validFrom).toISOString(),
        notAfter: new Date(cert.validTo).toISOString(),
        fingerprint: cert.fingerprint256,
      });
    } catch {
      // Not a certificate this can read; leave it out rather than fail the whole listing.
    }
  }
  return found;
}

export async function listCaddyCertificates(
  docker: DockerHost,
): Promise<CaddyCertificate[] | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.certificates;
  // A fixed script: nothing from the request reaches it.
  const script = `cd ${ROOT} 2>/dev/null || exit 0; for f in */*/*.crt; do [ -f "$f" ] || continue; echo "${SEPARATOR} $f"; cat "$f"; done`;
  const result = await docker.runInCaddyStorage(["sh", "-c", script]);
  if (!result.ok) return null;
  const certificates = parseCertificateListing(result.output);
  cached = { at: Date.now(), certificates };
  return certificates;
}

/** One certificate's PEM, and its key when asked for. The names are checked, never interpolated. */
export async function readCaddyCertificate(
  docker: DockerHost,
  request: CertificateFileRequest,
): Promise<CertificateFiles | null> {
  if (!STORAGE_NAME.test(request.issuerKey) || !STORAGE_NAME.test(request.name)) return null;
  const base = `${ROOT}/${request.issuerKey}/${request.name}/${request.name}`;
  // Paths go in as positional arguments, so the shell never parses them.
  const result = await docker.runInCaddyStorage([
    "sh",
    "-c",
    `cat "$1"; echo "${SEPARATOR}"; [ -n "$2" ] && cat "$2"; true`,
    "cpm",
    `${base}.crt`,
    request.includeKey ? `${base}.key` : "",
  ]);
  if (!result.ok) return null;
  const [certificatePem, keyPem] = result.output.split(SEPARATOR);
  if (!certificatePem?.includes("BEGIN CERTIFICATE")) return null;
  return {
    certificatePem: certificatePem.trim(),
    ...(request.includeKey && keyPem?.includes("PRIVATE KEY") && { keyPem: keyPem.trim() }),
  };
}
