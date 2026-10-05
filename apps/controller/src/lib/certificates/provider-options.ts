export type CertificateProviderOptions = { provider: string };

export function normalizeCertificateProviderOptions(
  value: unknown,
): CertificateProviderOptions | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const provider = (value as Record<string, unknown>).provider;
  return typeof provider === "string" && provider.trim().length > 0
    ? { provider: provider.trim() }
    : null;
}

export function parseStoredCertificateProviderOptions(
  value: string | null,
): CertificateProviderOptions | null {
  if (!value) return null;
  try {
    return normalizeCertificateProviderOptions(JSON.parse(value));
  } catch {
    return null;
  }
}

export function sanitizeStoredCertificateProviderOptions(value: string | null): string | null {
  const normalized = parseStoredCertificateProviderOptions(value);
  return normalized ? JSON.stringify(normalized) : null;
}
