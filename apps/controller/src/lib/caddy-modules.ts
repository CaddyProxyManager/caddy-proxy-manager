/**
 * One place for which plugins are compiled in, so the Dockerfile, the config builder (an absent
 * module makes Caddy reject the *entire* config) and the UI agree. The shipped image's list is
 * SHIPPED_CADDY_MODULES in @cpm/shared, which the agent reads too; a unit test keeps them equal.
 */

import { MODULE_PATH_PATTERN, MODULE_VERSION_PATTERN } from "@cpm/shared";
import { DNS_PROVIDERS } from "./dns-providers";
import { type DomainError, domainError } from "./domain-error";

/** What the UI and generation gate on; one toggled module can power several. */
export type CaddyFeatureId =
  | "l4"
  | "geoblock"
  | "waf"
  | "tailscale"
  /** Satisfied by *any* enabled DNS module. */
  | "dns01";

export type CaddyModuleCategory = "dns" | "proxy" | "security";

export type CaddyModuleDefinition = {
  /** Persisted in settings. Never reuse or rename. */
  id: string;
  name: string;
  modulePath: string;
  description: string;
  docsUrl?: string;
  category: CaddyModuleCategory;
  features: CaddyFeatureId[];
  dnsProvider?: string;
  /** The brand as written, which the translated module name is built around. */
  dnsProviderDisplayName?: string;
};

const CORE_MODULES: CaddyModuleDefinition[] = [
  {
    id: "caddy-l4",
    name: "Layer 4 Proxy",
    modulePath: "github.com/mholt/caddy-l4",
    description:
      "TCP/UDP proxying. Required by L4 Proxy Hosts and by the agent that binds their ports.",
    docsUrl: "https://github.com/mholt/caddy-l4",
    category: "proxy",
    features: ["l4"],
  },
  {
    id: "caddy-tailscale",
    name: "Tailscale",
    modulePath: "github.com/tailscale/caddy-tailscale",
    description:
      "Runs Tailscale inside Caddy. Required to serve a proxy host on your tailnet, to gate one on Tailscale identity, and to reach an upstream over the tailnet.",
    docsUrl: "https://github.com/tailscale/caddy-tailscale",
    category: "proxy",
    features: ["tailscale"],
  },
  {
    id: "caddy-blocker",
    name: "Request Blocker",
    modulePath: "github.com/fuomag9/caddy-blocker-plugin",
    description:
      "Country, continent, ASN, and CIDR blocking. Required by global geoblocking and by per-host geoblock rules.",
    docsUrl: "https://github.com/fuomag9/caddy-blocker-plugin",
    category: "security",
    features: ["geoblock"],
  },
  {
    id: "coraza-waf",
    name: "Coraza WAF",
    modulePath: "github.com/corazawaf/coraza-caddy/v2",
    description:
      "ModSecurity-compatible web application firewall with the OWASP Core Rule Set. Required by the WAF settings and the WAF events page.",
    docsUrl: "https://github.com/corazawaf/coraza-caddy",
    category: "security",
    features: ["waf"],
  },
];

export function dnsModuleId(providerName: string): string {
  return `caddy-dns-${providerName}`;
}

const DNS_MODULES: CaddyModuleDefinition[] = DNS_PROVIDERS.map((provider) => ({
  id: dnsModuleId(provider.name),
  name: `${provider.displayName} DNS`,
  modulePath: provider.modulePath,
  description:
    provider.description ??
    `ACME DNS-01 challenge support for ${provider.displayName}. Required to issue certificates through this provider.`,
  docsUrl: provider.docsUrl,
  category: "dns" as const,
  features: ["dns01" as const],
  dnsProvider: provider.name,
  dnsProviderDisplayName: provider.displayName,
}));

/** In display order. */
export const CADDY_MODULES: CaddyModuleDefinition[] = [...CORE_MODULES, ...DNS_MODULES];

const MODULES_BY_ID = new Map(CADDY_MODULES.map((m) => [m.id, m]));

export function findCaddyModule(id: string): CaddyModuleDefinition | undefined {
  return MODULES_BY_ID.get(id);
}

/** A feature is available if *any* of these is on. */
export function modulesForFeature(feature: CaddyFeatureId): CaddyModuleDefinition[] {
  return CADDY_MODULES.filter((m) => m.features.includes(feature));
}

/** Everything on, so an upgrade never silently drops a plugin someone's hosts need. */
export const DEFAULT_ENABLED_MODULE_IDS: string[] = CADDY_MODULES.map((m) => m.id);

// ─── Custom modules ──────────────────────────────────────────────────────────

export type CaddyCustomModule = {
  modulePath: string;
  /** Passed as `--with path@version`. */
  version?: string;
  enabled: boolean;
};

// Paths arrive pasted from READMEs. The patterns are shared: the agent re-checks every spec.

export function normalizeModulePath(raw: string): string {
  const path = raw.trim().replace(/^https?:\/\//, "");
  // By index, not /\/+$/, which is quadratic on input that is all slashes.
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end--;
  return path.slice(0, end);
}

/** A code, not a sentence: the action, the REST API and the picker each word it themselves. */
export function customModuleProblem(entry: CaddyCustomModule): DomainError | null {
  const path = normalizeModulePath(entry.modulePath);
  if (!path) return domainError("customModulePathRequired", {}, { status: 400 });
  if (path.length > 200) {
    return domainError("customModulePathTooLong", { path: path.slice(0, 40) }, { status: 400 });
  }
  if (!MODULE_PATH_PATTERN.test(path)) {
    return domainError("customModulePathInvalid", { path }, { status: 400 });
  }
  if (!path.includes("/")) {
    return domainError("customModulePathMissingHost", { path }, { status: 400 });
  }
  if (entry.version) {
    const version = entry.version.trim();
    if (!MODULE_VERSION_PATTERN.test(version)) {
      return domainError("customModuleVersionInvalid", { version, path }, { status: 400 });
    }
  }
  return null;
}

export function validateCustomModule(entry: CaddyCustomModule): string | null {
  return customModuleProblem(entry)?.message ?? null;
}

export function customModuleSpec(entry: CaddyCustomModule): string {
  const path = normalizeModulePath(entry.modulePath);
  const version = entry.version?.trim();
  return version ? `${path}@${version}` : path;
}
