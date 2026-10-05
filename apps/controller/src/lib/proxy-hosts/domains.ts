import { isIP } from "node:net";
import { domainError } from "../errors/domain-error";

const HOST_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isValidHostname(value: string) {
  if (!value || value.length > 253) {
    return false;
  }

  return value.split(".").every((label) => HOST_LABEL_REGEX.test(label));
}

export function isValidProxyHostDomain(value: string) {
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) {
    return false;
  }

  if (normalized.startsWith("*.")) {
    const baseDomain = normalized.slice(2);
    return !baseDomain.includes("*") && isValidHostname(baseDomain);
  }

  if (normalized.includes("*")) {
    return false;
  }

  return isIP(normalized) !== 0 || isValidHostname(normalized);
}

export function normalizeProxyHostDomains(domains: string[]) {
  const normalizedDomains = Array.from(
    new Set(
      domains.map((domain) => domain.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean),
    ),
  );

  if (normalizedDomains.length === 0) {
    throw domainError("proxyHostDomainsRequired");
  }

  const invalidDomain = normalizedDomains.find((domain) => !isValidProxyHostDomain(domain));
  if (invalidDomain) {
    throw domainError("proxyHostDomainInvalid", { domain: invalidDomain });
  }

  return normalizedDomains;
}
