/**
 * DNS provider credentials over GraphQL, as Settings > DNS providers edits them: one provider at a
 * time against the stored `dns-provider` group. The whole group goes through the settings change
 * kind, so it is validated, encrypted, applied with rollback and held for approval like saveSettings;
 * what comes back is the redacted group, never a credential.
 */

import { NotFoundError } from "../api/auth";
import { ApiValidationError } from "../api/errors";
import { apiSubmitter, submitOrApply } from "../approvals";
import { getProviderDefinition } from "../dns/providers";
import { type DnsProviderSettings, getDnsProviderSettings } from "../settings";
import { readSettingsGroup } from "../settings/api";
import { SettingsValidationError } from "../settings/validation";
import type { GraphQLContext } from "./context";

const GROUP = "dns-provider";

async function currentSettings(): Promise<DnsProviderSettings> {
  const current = await getDnsProviderSettings();
  return current
    ? { ...current, providers: { ...current.providers } }
    : { providers: {}, default: null };
}

async function save(context: GraphQLContext, settings: DnsProviderSettings) {
  await submitOrApply(apiSubmitter(await context.viewer()), {
    kind: "settingsGroup",
    payload: { group: GROUP, input: settings },
  });
  return (await readSettingsGroup(GROUP))?.value ?? {};
}

function requireConfigured(settings: DnsProviderSettings, provider: string): void {
  if (!settings.providers[provider]) throw new NotFoundError("DNS provider not configured");
}

export const dnsProviderMutationResolvers = {
  saveDnsProviderCredentials: async (
    _: unknown,
    args: { provider: string; credentials: unknown },
    context: GraphQLContext,
  ) => {
    const definition = getProviderDefinition(args.provider);
    if (!definition) throw new NotFoundError("Unknown DNS provider");
    const given = args.credentials;
    if (typeof given !== "object" || given === null || Array.isArray(given)) {
      throw new ApiValidationError("credentials must be an object of field values");
    }
    const settings = await currentSettings();
    const existing = settings.providers[args.provider];
    // As the form: a blank field keeps the stored value, so a secret need not be re-entered.
    const credentials: Record<string, string> = {};
    for (const field of definition.fields) {
      const raw = (given as Record<string, unknown>)[field.key];
      const value = raw == null ? "" : String(raw).trim();
      if (value) credentials[field.key] = value;
      else if (existing?.[field.key]) credentials[field.key] = existing[field.key];
    }
    settings.providers[args.provider] = credentials;
    settings.default ??= args.provider;
    return await save(context, settings);
  },
  removeDnsProvider: async (_: unknown, args: { provider: string }, context: GraphQLContext) => {
    const settings = await currentSettings();
    requireConfigured(settings, args.provider);
    const delegated = (settings.delegations ?? []).filter((d) => d.provider === args.provider);
    if (delegated.length > 0) {
      throw new SettingsValidationError("dnsProviderStillDelegated", {
        provider: args.provider,
        domains: delegated.map((d) => d.domain).join(", "),
      });
    }
    delete settings.providers[args.provider];
    if (settings.default === args.provider) {
      settings.default = Object.keys(settings.providers)[0] ?? null;
    }
    return await save(context, settings);
  },
  setDefaultDnsProvider: async (
    _: unknown,
    args: { provider?: string | null },
    context: GraphQLContext,
  ) => {
    const settings = await currentSettings();
    const provider = args.provider ?? null;
    if (provider) requireConfigured(settings, provider);
    settings.default = provider;
    return await save(context, settings);
  },
};
