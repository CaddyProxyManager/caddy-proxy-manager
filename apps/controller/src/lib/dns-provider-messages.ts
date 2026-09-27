/**
 * The DNS Providers screen's catalog lookups. `dns-providers.ts` stays English for the Caddy config
 * and APIs; keys are runtime values, so tests/unit/dns-provider-messages.test.ts checks coverage.
 * Only the registry's type is imported: its values pull secret helpers into the client bundle.
 */

import type { useTranslations } from "next-intl";
import type { DnsProviderDefinition, DnsProviderField } from "./dns-providers";

type SettingsTranslator = ReturnType<typeof useTranslations<"settings">>;

/** The one place the narrowing is given up, for the reason in the header comment. */
type DynamicTranslator = {
  (key: string, values?: Record<string, string | number>): string;
  has: (key: string) => boolean;
};

function dynamic(t: SettingsTranslator): DynamicTranslator {
  return t as unknown as DynamicTranslator;
}

/**
 * Mirrors the challenge option keys in `dns-providers.ts`. Those fields are shared by every
 * provider, so their messages are too; the test checks this list against the registry.
 */
export const DNS_CHALLENGE_OPTION_KEYS = ["propagation_delay", "propagation_timeout"] as const;

type ChallengeOptionKey = (typeof DNS_CHALLENGE_OPTION_KEYS)[number];

function isChallengeOption(key: string): key is ChallengeOptionKey {
  return (DNS_CHALLENGE_OPTION_KEYS as readonly string[]).includes(key);
}

/**
 * A registry name as a catalog key segment. Provider names and field keys are Caddy's own
 * (`api_token`), and the catalog is camelCase throughout.
 */
export function dnsMessageName(name: string): string {
  return name.replace(/[-_]([a-z0-9])/g, (_, next: string) => next.toUpperCase());
}

export function dnsProviderDescription(
  t: SettingsTranslator,
  provider: DnsProviderDefinition,
): string | undefined {
  if (!provider.description) return undefined;
  return dynamic(t)(`dnsProviders.${dnsMessageName(provider.name)}.description`);
}

export type DnsProviderFieldText = {
  label: string;
  description?: string;
  placeholder?: string;
};

export function dnsProviderFieldText(
  t: SettingsTranslator,
  provider: DnsProviderDefinition,
  field: DnsProviderField,
): DnsProviderFieldText {
  const translate = dynamic(t);

  if (isChallengeOption(field.key)) {
    const base = `dnsChallengeOptions.${dnsMessageName(field.key)}`;
    const duration = provider.challengeDefaults?.[field.key];
    return {
      label: translate(`${base}.label`),
      description: duration
        ? translate(`${base}.descriptionWithDefault`, { duration })
        : translate(`${base}.description`),
      // A provider default is shown as the placeholder itself, and a duration is not prose.
      placeholder: duration ?? translate(`${base}.placeholder`),
    };
  }

  const base = `dnsProviders.${dnsMessageName(provider.name)}.fields.${dnsMessageName(field.key)}`;
  return {
    label: translate(`${base}.label`),
    description: field.description ? translate(`${base}.description`) : undefined,
    // Most placeholders are example values (`us-east-1`, `AKIA…`) and are not in the catalog;
    // the ones written as prose are.
    placeholder: translate.has(`${base}.placeholder`)
      ? translate(`${base}.placeholder`)
      : field.placeholder,
  };
}
