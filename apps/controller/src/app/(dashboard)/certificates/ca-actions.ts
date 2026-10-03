"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/src/lib/auth";
import { domainError } from "@/src/lib/domain-error";
import { internalCaSubject } from "@/src/lib/ca-subject";
import { withTranslatedErrors } from "@/src/lib/translated-action";
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
import { generateKeyPair as generateKeyPairCb, X509Certificate } from "node:crypto";
import { promisify } from "node:util";
import { getTranslations } from "next-intl/server";
import { passwordPolicyMessage } from "@/src/lib/password-policy-message";
import forge from "node-forge";

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
  } catch {
    throw domainError("certificatePemInvalid");
  }
}

async function createCaCertificateActionUntranslated(formData: FormData) {
  const session = await requireAdmin();
  const userId = Number(session.user.id);
  const name = String(formData.get("name") ?? "").trim();
  const certificatePem = String(formData.get("certificate_pem") ?? "").trim();

  if (!name) throw domainError("nameRequired");
  if (!certificatePem) throw domainError("certificatePemRequired");
  validatePem(certificatePem);

  await createCaCertificate({ name, certificatePem: certificatePem }, userId);
  revalidatePath("/certificates");
}

export async function updateCaCertificateAction(id: number, formData: FormData) {
  const session = await requireAdmin();
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
}

export async function deleteCaCertificateAction(
  id: number,
): Promise<{ success: boolean; error?: string }> {
  const session = await requireAdmin();
  const userId = Number(session.user.id);
  try {
    // Translates a DomainError before the catch hands it to the dialog. `requireAdmin` stays
    // outside: its redirect throws.
    await withTranslatedErrors(() => deleteCaCertificate(id, userId));
    revalidatePath("/certificates");
    return { success: true };
  } catch (e) {
    const t = await getTranslations("caCertificates");
    return {
      success: false,
      error: e instanceof Error ? e.message : t("deleteCaCertificateFailed"),
    };
  }
}

async function generateCaCertificateActionUntranslated(
  formData: FormData,
): Promise<{ id: number }> {
  const session = await requireAdmin();
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
  cert.serialNumber = "01";
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
}

export type IssuedClientCert = {
  pkcs12Base64: string;
  passwordProtected: boolean;
};

async function issueClientCertificateActionUntranslated(
  caCertId: number,
  formData: FormData,
): Promise<IssuedClientCert> {
  const session = await requireAdmin();
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
  // hold it to the login-password bar.
  const t = await getTranslations();
  const exportPasswordError = passwordPolicyMessage(
    t,
    exportPassword,
    t("passwordPolicy.subject.exportPassword"),
  );
  if (exportPasswordError) throw new Error(exportPasswordError);

  const caPrivateKeyPem = await getCaCertificatePrivateKey(caCertId);
  // A code, not a sentence: see `domain-error.ts`.
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
  cert.serialNumber = Date.now().toString(16);
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
      serialNumber: cert.serialNumber.toUpperCase(),
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
}

export async function revokeIssuedClientCertificateAction(
  id: number,
): Promise<{ revokedAt: string }> {
  const session = await requireAdmin();
  const userId = Number(session.user.id);
  const record = await revokeIssuedClientCertificate(id, userId);
  revalidatePath("/certificates");
  return { revokedAt: record.revokedAt! };
}

/*
 * These return data, so they throw rather than return an `ActionState`; the wrapper translates
 * first, since only the server can reach the catalog.
 */

export async function createCaCertificateAction(formData: FormData) {
  return withTranslatedErrors(() => createCaCertificateActionUntranslated(formData));
}

export async function generateCaCertificateAction(formData: FormData): Promise<{ id: number }> {
  return withTranslatedErrors(() => generateCaCertificateActionUntranslated(formData));
}

export async function issueClientCertificateAction(
  caCertId: number,
  formData: FormData,
): Promise<IssuedClientCert> {
  return withTranslatedErrors(() => issueClientCertificateActionUntranslated(caCertId, formData));
}
