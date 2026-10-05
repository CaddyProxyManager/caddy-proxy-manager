/**
 * The controller's own check of a certificate an agent read from a file. The agent checks too, but
 * it is less trusted: nothing it sends is stored until it parses here and the key matches.
 */
import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import type { CertificateFileError } from "@cpm/shared";

/** The agent normalises with the same expressions, so a fingerprint means the same on both sides. */
const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/g;
const PEM_KEY = /-----BEGIN ((?:RSA |EC )?PRIVATE KEY)-----[A-Za-z0-9+/=\s]+?-----END \1-----/;

export function chainFingerprint(certificatePem: string): string {
  return createHash("sha256").update(certificatePem).digest("hex");
}

/** DNS and IP SANs, lowercased and deduplicated: what a host on this certificate may serve. */
export function certificateSanNames(cert: X509Certificate): string[] {
  const names = (cert.subjectAltName ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("DNS:") || entry.startsWith("IP Address:"))
    .map((entry) => entry.replace(/^(DNS|IP Address):/, "").toLowerCase());
  return [...new Set(names)];
}

export type CheckedCertificatePair =
  | { ok: true; certificatePem: string; keyPem: string; names: string[]; fingerprint: string }
  | { ok: false; error: CertificateFileError };

export function checkCertificatePair(chainText: string, keyText: string): CheckedCertificatePair {
  const blocks = chainText.match(PEM_CERTIFICATE) ?? [];
  const [first] = blocks;
  if (!first) return { ok: false, error: "not-a-certificate" };
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(first);
    for (const block of blocks.slice(1)) new X509Certificate(block);
  } catch {
    return { ok: false, error: "not-a-certificate" };
  }
  const keyPem = PEM_KEY.exec(keyText)?.[0];
  if (!keyPem) return { ok: false, error: "not-a-key" };
  try {
    if (!leaf.checkPrivateKey(createPrivateKey(keyPem))) {
      return { ok: false, error: "key-mismatch" };
    }
  } catch {
    return { ok: false, error: "not-a-key" };
  }
  const names = certificateSanNames(leaf);
  if (names.length === 0) return { ok: false, error: "no-names" };
  const certificatePem = blocks.join("\n");
  return { ok: true, certificatePem, keyPem, names, fingerprint: chainFingerprint(certificatePem) };
}
