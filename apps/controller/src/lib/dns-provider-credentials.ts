/**
 * DNS provider credentials at rest and in Caddy's config. Split from dns-providers.ts, which
 * client components reach: `secret` pulls in `node:crypto`, which Vite's browser build stubs
 * with one that throws when the Settings page loads.
 */

import {
  CHALLENGE_OPTION_KEYS,
  type DnsProviderCredentials,
  getProviderDefinition,
} from "./dns-providers";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./secret";

export type { DnsProviderCredentials };

/** Encrypt password-type credential fields; others and already-encrypted values pass through. */
export function encryptProviderCredentials(
  providerName: string,
  credentials: Record<string, string>,
): Record<string, string> {
  const def = getProviderDefinition(providerName);
  if (!def) return credentials;

  const result = { ...credentials };
  for (const field of def.fields) {
    if (field.type === "password" && result[field.key] && !isEncryptedSecret(result[field.key])) {
      result[field.key] = encryptSecret(result[field.key]);
    }
  }
  return result;
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

/**
 * The Caddy DNS challenge config for `issuer.challenges.dns`. Challenge options are hoisted out
 * of the credentials to the challenge level; `resolvers` comes from the global DNS settings.
 */
export function buildDnsChallengeConfig(
  providerName: string,
  credentials: Record<string, string>,
  dnsResolvers: string[],
): Record<string, unknown> | null {
  const def = getProviderDefinition(providerName);
  if (!def) return null;

  const decrypted = decryptProviderCredentials(providerName, credentials);

  // Challenge option keys configure the challenge, not the provider module, so they go below.
  const providerConfig: Record<string, string> = { name: providerName };
  for (const [key, value] of Object.entries(decrypted)) {
    if (value && !(CHALLENGE_OPTION_KEYS as readonly string[]).includes(key)) {
      providerConfig[key] = value;
    }
  }

  const dnsChallenge: Record<string, unknown> = { provider: providerConfig };
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
