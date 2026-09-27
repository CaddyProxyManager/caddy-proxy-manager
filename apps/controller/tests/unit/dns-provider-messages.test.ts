/**
 * Provider and field text is keyed at runtime, so TypeScript cannot check the catalog covers it.
 * The English entries must match the registry exactly: its copy still feeds the API and Caddy.
 */
import { describe, expect, it } from 'bun:test';
import { createTranslator } from 'next-intl';
import messages from '../../messages/en.json';
import { DNS_PROVIDERS, challengeOptionFields } from '@/src/lib/dns-providers';
import {
  DNS_CHALLENGE_OPTION_KEYS,
  dnsMessageName,
  dnsProviderDescription,
  dnsProviderFieldText,
} from '@/src/lib/dns-provider-messages';

const t = createTranslator({ locale: 'en', messages, namespace: 'settings' });

const catalog = messages.settings.dnsProviders as Record<
  string,
  { description?: string; fields: Record<string, unknown> }
>;

const challengeKeys = new Set<string>(DNS_CHALLENGE_OPTION_KEYS);

describe('settings.dnsProviders messages', () => {
  it('knows the same challenge option fields the registry appends', () => {
    expect(challengeOptionFields().map((field) => field.key)).toEqual([
      ...DNS_CHALLENGE_OPTION_KEYS,
    ]);
  });

  it('describes every provider as the registry does', () => {
    const mismatches = DNS_PROVIDERS.filter(
      (provider) => dnsProviderDescription(t, provider) !== provider.description,
    ).map((provider) => provider.name);
    expect(mismatches).toEqual([]);
  });

  it('labels, describes and fills in every field as the registry does', () => {
    // Every provider, including the challenge options with and without a provider default.
    const mismatches: string[] = [];
    for (const provider of DNS_PROVIDERS) {
      for (const field of provider.fields) {
        const text = dnsProviderFieldText(t, provider, field);
        const at = `${provider.name}.${field.key}`;
        if (text.label !== field.label) mismatches.push(`${at}.label`);
        if (text.description !== field.description) mismatches.push(`${at}.description`);
        if (text.placeholder !== field.placeholder) mismatches.push(`${at}.placeholder`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('has no entry for a provider or field that no longer exists', () => {
    const known = new Map(
      DNS_PROVIDERS.map((provider) => [
        dnsMessageName(provider.name),
        new Set(
          provider.fields
            .filter((field) => !challengeKeys.has(field.key))
            .map((field) => dnsMessageName(field.key)),
        ),
      ]),
    );
    const stale = Object.entries(catalog).flatMap(([name, entry]) => {
      const fields = known.get(name);
      if (!fields) return [name];
      return Object.keys(entry.fields)
        .filter((field) => !fields.has(field))
        .map((field) => `${name}.${field}`);
    });
    expect(stale).toEqual([]);
  });
});
