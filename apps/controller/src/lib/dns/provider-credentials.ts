/**
 * DNS provider credentials at rest and in Caddy's config. Split from dns/providers.ts, which
 * client components reach: `secret` pulls in `node:crypto`, which Vite's browser build stubs
 * with one that throws when the Settings page loads.
 */

import type { AcmeDnsAccount } from "./challenge-delegation";
import {
  CHALLENGE_OPTION_KEYS,
  type DnsProviderCredentials,
  getProviderDefinition,
} from "./providers";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../secrets";

export type { DnsProviderCredentials };

/**
 * Encrypt password-type credential fields; others, non-strings (the REST API validates shape, not
 * types) and already-encrypted values pass through.
 */
export function encryptProviderCredentials(
  providerName: string,
  credentials: Record<string, string>,
): Record<string, string> {
  const def = getProviderDefinition(providerName);
  if (!def) return credentials;

  const result = { ...credentials };
  for (const field of def.fields) {
    const value: unknown = result[field.key];
    if (
      field.type === "password" &&
      typeof value === "string" &&
      value &&
      !isEncryptedSecret(value)
    ) {
      result[field.key] = encryptSecret(value);
    }
  }
  return result;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encryptAcmeDnsAccounts(accounts: unknown): unknown {
  if (!isJsonObject(accounts)) return accounts;
  return Object.fromEntries(
    Object.entries(accounts).map(([domain, account]) => {
      if (!isJsonObject(account)) return [domain, account];
      const { password } = account;
      return typeof password === "string" && password && !isEncryptedSecret(password)
        ? [domain, { ...account, password: encryptSecret(password) }]
        : [domain, account];
    }),
  );
}

/**
 * A whole `dns_provider` value with its password fields encrypted, in the current
 * `{ providers, default }` shape or the legacy `{ provider, credentials }` one. Anything else is
 * returned as it came.
 */
export function encryptDnsProviderSettingCredentials<T>(value: T): T {
  if (!isJsonObject(value)) return value;
  if (isJsonObject(value.providers)) {
    const providers = Object.fromEntries(
      Object.entries(value.providers).map(([provider, credentials]) => [
        provider,
        isJsonObject(credentials)
          ? encryptProviderCredentials(provider, credentials as Record<string, string>)
          : credentials,
      ]),
    );
    return "acmeDnsAccounts" in value
      ? { ...value, providers, acmeDnsAccounts: encryptAcmeDnsAccounts(value.acmeDnsAccounts) }
      : { ...value, providers };
  }
  if (typeof value.provider === "string" && isJsonObject(value.credentials)) {
    const credentials = value.credentials as Record<string, string>;
    return { ...value, credentials: encryptProviderCredentials(value.provider, credentials) };
  }
  return value;
}

/** Decrypt password-type credential fields for use in Caddy config. */
export function decryptProviderCredentials(
  providerName: string,
  credentials: Record<string, string>,
): Record<string, string> {
  const def = getProviderDefinition(providerName);
  if (!def) return credentials;

  const result = { ...credentials };
  for (const field of def.fields) {
    if (field.type === "password" && result[field.key] && isEncryptedSecret(result[field.key])) {
      result[field.key] = decryptSecret(
        result[field.key],
        `DNS provider "${providerName}" credential "${field.key}"`,
      );
    }
  }
  return result;
}

function decryptAcmeDnsConfig(
  config: Record<string, AcmeDnsAccount>,
): Record<string, Record<string, string>> {
  return Object.fromEntries(
    Object.entries(config).map(([domain, account]) => {
      const entry: Record<string, string> = {};
      for (const [key, value] of Object.entries(account)) {
        if (typeof value === "string" && value) entry[key] = value;
      }
      if (entry.password && isEncryptedSecret(entry.password)) {
        entry.password = decryptSecret(entry.password, `acme-dns account "${domain}" password`);
      }
      return [domain, entry];
    }),
  );
}

/**
 * The Caddy DNS challenge config for `issuer.challenges.dns`. Challenge options are hoisted out
 * of the credentials to the challenge level; `resolvers` comes from the global DNS settings.
 */
export function buildDnsChallengeConfig(
  providerName: string,
  credentials: Record<string, string>,
  dnsResolvers: string[],
  delegation: {
    overrideDomain?: string | null;
    acmeDnsConfig?: Record<string, AcmeDnsAccount> | null;
  } = {},
): Record<string, unknown> | null {
  const def = getProviderDefinition(providerName);
  if (!def) return null;

  const decrypted = decryptProviderCredentials(providerName, credentials);

  // Challenge option keys configure the challenge, not the provider module, so they go below.
  const providerConfig: Record<string, unknown> = { name: providerName };
  if (delegation.acmeDnsConfig) {
    // With `config` set the module ignores the single-account fields.
    providerConfig.config = decryptAcmeDnsConfig(delegation.acmeDnsConfig);
  } else {
    const caddyKeys = new Map(def.fields.map((field) => [field.key, field.caddyKey ?? field.key]));
    for (const [key, value] of Object.entries(decrypted)) {
      if (value && !(CHALLENGE_OPTION_KEYS as readonly string[]).includes(key)) {
        providerConfig[caddyKeys.get(key) ?? key] = value;
      }
    }
  }

  const dnsChallenge: Record<string, unknown> = { provider: providerConfig };
  if (delegation.overrideDomain) {
    dnsChallenge.override_domain = delegation.overrideDomain;
  }
  if (dnsResolvers.length > 0) {
    dnsChallenge.resolvers = dnsResolvers;
  }

  // A stored option wins over the provider default. "-1" is emitted as a number because
  // time.ParseDuration rejects a bare "-1".
  for (const key of CHALLENGE_OPTION_KEYS) {
    const value = decrypted[key] || def.challengeDefaults?.[key];
    if (value) {
      dnsChallenge[key] = value === "-1" ? -1 : value;
    }
  }

  return dnsChallenge;
}
