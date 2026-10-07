"use server";

import { unstable_rethrow } from "next/navigation";
import { requireCan } from "@/src/lib/users/permissions";
import { revalidatePath } from "next/cache";
import { domainError } from "@/src/lib/errors/domain-error";
import { internalCaSubject } from "@/src/lib/certificates/ca-subject";
import type { ActionResult } from "@/src/lib/errors/action-result";
import { runAction } from "@/src/lib/errors/run-action";
import {
  createCaCertificate,
  deleteCaCertificate,
  updateCaCertificate,
  getCaCertificatePrivateKey,
} from "@/src/lib/models/ca-certificates";
import {
  createIssuedClientCertificate,
  revokeIssuedClientCertificate,
} from "@/src/lib/models/issued-client-certificates";
import { generateKeyPair as generateKeyPairCb, randomBytes, X509Certificate } from "node:crypto";
import { promisify } from "node:util";
import { getTranslations } from "next-intl/server";
import { passwordPolicyMessage } from "@/src/lib/auth/password/policy-message";
import forge from "node-forge";

/**
 * RFC 5280: unique per CA, at most 20 bytes, positive. A timestamp repeated within a millisecond,
 * and every CA was "01"; 16 random bytes with the top bit clear cannot collide in practice.
 */
function randomSerialNumber(): string {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] & 0x7f) | 0x01;
  return bytes.toString("hex");
}

const generateKeyPairAsync = promisify(generateKeyPairCb);

/** The declared options plus `prfAlgorithm`, which forge honours but does not type. */
type Pkcs12ExportOptions = NonNullable<Parameters<typeof forge.pkcs12.toPkcs12Asn1>[3]> & {
  prfAlgorithm?: "sha1" | "sha256" | "sha384" | "sha512";
};

/**
 * On the crypto threadpool: forge's pure-JS keygen blocks the loop ~150-450ms at 4096 bits.
 * Returns forge key objects, so the certificate and stored PEM stay byte-identical.
 */
async function generateForgeKeyPair(bits: number) {
  const { privateKey, publicKey } = await generateKeyPairAsync("rsa", {
    modulusLength: bits,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    privateKey: forge.pki.privateKeyFromPem(privateKey),
    publicKey: forge.pki.publicKeyFromPem(publicKey),
  };
}

function validatePem(pem: string): void {
  try {
    new X509Certificate(pem);
  } catch (error) {
    unstable_rethrow(error);
    throw domainError("certificatePemInvalid");
  }
}

export async function createCaCertificateAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const session = await requireCan("certificates:write");
    const userId = Number(session.user.id);
    const name = String(formData.get("name") ?? "").trim();
    const certificatePem = String(formData.get("certificate_pem") ?? "").trim();

    if (!name) throw domainError("nameRequired");
    if (!certificatePem) throw domainError("certificatePemRequired");
    validatePem(certificatePem);

    await createCaCertificate({ name, certificatePem: certificatePem }, userId);
    revalidatePath("/certificates");
  });
}

export async function updateCaCertificateAction(
  id: number,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(async () => {
    const session = await requireCan("certificates:write");
    const userId = Number(session.user.id);
    const name = formData.get("name") ? String(formData.get("name")).trim() : undefined;
    const certificatePem = formData.get("certificate_pem")
      ? String(formData.get("certificate_pem")).trim()
      : undefined;

    if (certificatePem) {
      validatePem(certificatePem);
    }

    await updateCaCertificate(
      id,
      {
        ...(name ? { name } : {}),
        ...(certificatePem ? { certificatePem: certificatePem } : {}),
      },
      userId,
    );
    revalidatePath("/certificates");
  });
}

export async function deleteCaCertificateAction(id: number): Promise<ActionResult> {
  return runAction(async () => {
    const session = await requireCan("certificates:write");
    await deleteCaCertificate(id, Number(session.user.id));
    revalidatePath("/certificates");
  });
}

export async function generateCaCertificateAction(
  formData: FormData,
): Promise<ActionResult<{ id: number }>> {
  return runAction(async () => {
    const session = await requireCan("certificates:write");
    const userId = Number(session.user.id);
    const name = String(formData.get("name") ?? "").trim();
    const commonName = String(formData.get("common_name") ?? name).trim() || name;
    const validityDays = Math.min(
      3650,
      Math.max(1, parseInt(String(formData.get("validity_days") ?? "3650"), 10) || 3650),
    );

    if (!name) throw domainError("nameRequired");

    const keypair = await generateForgeKeyPair(4096);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keypair.publicKey;
    cert.serialNumber = randomSerialNumber();
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + validityDays);

    const attrs = await internalCaSubject(commonName);
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      { name: "subjectKeyIdentifier" },
    ]);

    cert.sign(keypair.privateKey, forge.md.sha256.create());

    const certificatePem = forge.pki.certificateToPem(cert);
    const privateKeyPem = forge.pki.privateKeyToPem(keypair.privateKey);

    const record = await createCaCertificate(
      { name, certificatePem: certificatePem, privateKeyPem: privateKeyPem },
      userId,
    );
    revalidatePath("/certificates");
    return { id: record.id };
  });
}

export type IssuedClientCert = {
  pkcs12Base64: string;
  passwordProtected: boolean;
};

export async function issueClientCertificateAction(
  caCertId: number,
  formData: FormData,
): Promise<ActionResult<IssuedClientCert>> {
  return runAction(async () => {
    const session = await requireCan("certificates:write");
    const userId = Number(session.user.id);
    const commonName = String(formData.get("common_name") ?? "").trim();
    const validityDays = Math.min(
      3650,
      Math.max(1, parseInt(String(formData.get("validity_days") ?? "365"), 10) || 365),
    );
    const exportPassword = String(formData.get("export_password") ?? "");

    if (!commonName) throw domainError("commonNameRequired");
    if (!exportPassword) throw domainError("exportPasswordRequired");

    // The .p12 leaves as a file with a SHA-1 MAC, so this password alone guards the private key:
    // hold it to the login-password bar. Already translated, so a plain Error that runAction keeps.
    const t = await getTranslations();
    const exportPasswordError = passwordPolicyMessage(
      t,
      exportPassword,
      t("passwordPolicy.subject.exportPassword"),
    );
    if (exportPasswordError) throw new Error(exportPasswordError);

    const caPrivateKeyPem = await getCaCertificatePrivateKey(caCertId);
    // A code, not a sentence: see `errors/domain-error.ts`.
    if (!caPrivateKeyPem) throw domainError("caCertificatePrivateKeyMissing");

    const caCertRecord = await import("@/src/lib/models/ca-certificates").then((m) =>
      m.getCaCertificate(caCertId),
    );
    if (!caCertRecord) throw domainError("caCertificateNotFound");

    const caKey = forge.pki.privateKeyFromPem(caPrivateKeyPem);
    const caCert = forge.pki.certificateFromPem(caCertRecord.certificatePem);

    const keypair = await generateForgeKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keypair.publicKey;
    cert.serialNumber = randomSerialNumber();
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + validityDays);

    cert.setSubject([{ name: "commonName", value: commonName }]);
    cert.setIssuer(caCert.subject.attributes);
    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", clientAuth: true },
    ]);

    cert.sign(caKey, forge.md.sha256.create());
    const certificatePem = forge.pki.certificateToPem(cert);
    const certificate = new X509Certificate(certificatePem);

    await createIssuedClientCertificate(
      {
        caCertificateId: caCertId,
        commonName: commonName,
        serialNumber: certificate.serialNumber,
        fingerprintSha256: certificate.fingerprint256,
        certificatePem: certificatePem,
        validFrom: new Date(certificate.validFrom).toISOString(),
        validTo: new Date(certificate.validTo).toISOString(),
      },
      userId,
    );
    revalidatePath("/certificates");

    // Forge's weak defaults (2048 iterations, 8-byte salt, SHA-1 PRF) raised, since the bundle
    // leaves as a file. The PKCS#12 MAC stays SHA-1.
    const pkcs12Options = {
      algorithm: "aes256",
      friendlyName: commonName,
      count: 100000,
      saltSize: 16,
      prfAlgorithm: "sha256",
    } satisfies Pkcs12ExportOptions;

    const pkcs12Asn1 = forge.pkcs12.toPkcs12Asn1(
      keypair.privateKey,
      [cert, caCert],
      exportPassword,
      pkcs12Options,
    );
    const pkcs12Der = forge.asn1.toDer(pkcs12Asn1).getBytes();

    return {
      pkcs12Base64: forge.util.encode64(pkcs12Der),
      passwordProtected: true,
    };
  });
}

export async function revokeIssuedClientCertificateAction(
  id: number,
): Promise<ActionResult<{ revokedAt: string }>> {
  return runAction(async () => {
    const session = await requireCan("certificates:write");
    const record = await revokeIssuedClientCertificate(id, Number(session.user.id));
    revalidatePath("/certificates");
    return { revokedAt: record.revokedAt! };
  });
}
