import type { Certificate } from "./models/certificates";

/** An allowlist, so private keys and future model fields never cross the API by default. */
export type CertificateApiResponse = {
  id: number;
  name: string;
  type: Certificate["type"];
  domainNames: string[];
  autoRenew: boolean;
  providerOptions: { provider: string } | null;
  certificatePem: string | null;
  hasPrivateKey: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CertificatePickerOption = Pick<Certificate, "id" | "name">;

function safeProviderOptions(
  providerOptions: Record<string, unknown> | null,
): { provider: string } | null {
  const provider = providerOptions?.provider;
  return typeof provider === "string" && provider.length > 0 ? { provider } : null;
}

export function toCertificateApiResponse(certificate: Certificate): CertificateApiResponse {
  return {
    id: certificate.id,
    name: certificate.name,
    type: certificate.type,
    domainNames: certificate.domainNames,
    autoRenew: certificate.autoRenew,
    providerOptions: safeProviderOptions(certificate.providerOptions),
    certificatePem: certificate.certificatePem,
    hasPrivateKey: Boolean(certificate.privateKeyPem),
    createdAt: certificate.createdAt,
    updatedAt: certificate.updatedAt,
  };
}

export function toCertificatePickerOption(certificate: Certificate): CertificatePickerOption {
  return { id: certificate.id, name: certificate.name };
}
