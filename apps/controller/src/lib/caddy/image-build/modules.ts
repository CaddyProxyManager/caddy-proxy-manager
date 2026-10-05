/**
 * One place for which plugins are compiled in, so the Dockerfile, the config builder (an absent
 * module makes Caddy reject the *entire* config) and the UI agree. The shipped image's list is
 * SHIPPED_CADDY_MODULES in @cpm/shared, which the agent reads too; a unit test keeps them equal.
 */

import { MODULE_PATH_PATTERN, MODULE_VERSION_PATTERN } from "@cpm/shared";
import { DNS_PROVIDERS } from "../../dns/providers";
import { type DomainError, domainError } from "../../errors/domain-error";
import {
  CACHE_STORAGE_MODULE_IDS,
  type ModuleCacheStorage,
} from "../../proxy-hosts/http-cache-options";

/** What the UI and generation gate on; one toggled module can power several. */
export type CaddyFeatureId =
  | "l4"
  | "geoblock"
  | "waf"
  | "tailscale"
  /** Satisfied by *any* enabled DNS module. */
  | "dns01"
  | "cache"
  | "ratelimit"
  | "crowdsec";

export type CaddyModuleCategory = "dns" | "proxy" | "cache" | "security";

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
  /** The HTTP cache storage this module provides (`proxy-hosts/http-cache.ts`). */
  cacheStorage?: ModuleCacheStorage;
  /**
   * False for an opt-in module the shipped image leaves out: it is compiled in only once an admin
   * selects it and rebuilds. Defaulting it on would ask every fresh install to rebuild.
   */
  defaultEnabled?: boolean;
};

/** Named by the build-conflict check, which refuses dropping it while CrowdSec is on. */
export const CROWDSEC_MODULE_ID = "caddy-crowdsec";

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
    // The repository moved to ingres-si, but its go.mod still declares this path, and saved
    // Caddy Build settings are keyed by it.
    modulePath: "github.com/fuomag9/caddy-blocker-plugin",
    description:
      "Country, continent, ASN, and CIDR blocking. Required by global geoblocking and by per-host geoblock rules.",
    docsUrl: "https://github.com/ingres-si/caddy-blocker-plugin",
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
  {
    id: "caddy-ratelimit",
    name: "Rate Limit",
    modulePath: "github.com/mholt/caddy-ratelimit",
    description:
      "Sliding-window request limits per client. Required by a proxy host's Rate limiting option.",
    docsUrl: "https://github.com/mholt/caddy-ratelimit",
    category: "security",
    features: ["ratelimit"],
    defaultEnabled: false,
  },
  {
    // The module root, whose package imports the HTTP handler, AppSec and the L4 matcher alike:
    // one entry, one pin. The L4 matcher compiles caddy-l4 in, whatever its own toggle says.
    id: CROWDSEC_MODULE_ID,
    name: "CrowdSec",
    modulePath: "github.com/hslatman/caddy-crowdsec-bouncer",
    description:
      "A CrowdSec bouncer: refuses clients your CrowdSec Local API has banned, on proxy hosts and L4 hosts, with optional AppSec. Required by the CrowdSec settings.",
    docsUrl: "https://github.com/hslatman/caddy-crowdsec-bouncer",
    category: "security",
    features: ["crowdsec"],
    defaultEnabled: false,
  },
  {
    id: "cache-handler",
    name: "HTTP Cache",
    modulePath: "github.com/caddyserver/cache-handler",
    description:
      "A shared HTTP cache (Souin) in front of upstreams. Enables the Caddy cache mode of a proxy host's Cache assets option.",
    docsUrl: "https://github.com/caddyserver/cache-handler",
    category: "cache",
    features: ["cache"],
    defaultEnabled: false,
  },
  cacheStorageModule(
    "otter",
    "Otter Cache Storage",
    "An in-memory store for the HTTP cache, bounded by entry count and faster than the built-in one. Entries are lost on restart.",
  ),
  cacheStorageModule(
    "badger",
    "Badger Cache Storage",
    "Keeps the HTTP cache on disk in a Badger database on the Caddy data volume, so it survives a restart.",
  ),
  cacheStorageModule(
    "simplefs",
    "SimpleFS Cache Storage",
    "Keeps the HTTP cache as plain files on the Caddy data volume, so it survives a restart.",
  ),
  cacheStorageModule(
    "redis",
    "Redis Cache Storage",
    "Keeps the HTTP cache in Redis or Valkey, shared by every Caddy that points at the same server.",
  ),
  cacheStorageModule(
    "etcd",
    "etcd Cache Storage",
    "Keeps the HTTP cache in an etcd cluster, shared by every Caddy that points at it. No authentication.",
  ),
];

/** Needs HTTP Cache as well; alone it compiles but nothing loads it. */
function cacheStorageModule(
  storage: ModuleCacheStorage,
  name: string,
  description: string,
): CaddyModuleDefinition {
  return {
    id: CACHE_STORAGE_MODULE_IDS[storage],
    name,
    modulePath: `github.com/darkweak/storages/${storage}/caddy`,
    description,
    docsUrl: `https://github.com/darkweak/storages/tree/main/${storage}`,
    category: "cache",
    features: [],
    cacheStorage: storage,
    defaultEnabled: false,
  };
}

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

/** Everything but opt-in modules, so an upgrade never silently drops a plugin hosts need. */
export const DEFAULT_ENABLED_MODULE_IDS: string[] = CADDY_MODULES.filter(
  (m) => m.defaultEnabled !== false,
).map((m) => m.id);

// ─── Custom modules ──────────────────────────────────────────────────────────

export const CUSTOM_MODULE_NAME_MAX = 80;

// Local, not settings-validation's: this module ships to the browser and that one imports node APIs.
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export type CaddyCustomModule = {
  /** A label for the settings list only; never part of the build. */
  name?: string;
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
  if (entry.name !== undefined) {
    const name = entry.name.trim();
    if (name.length > CUSTOM_MODULE_NAME_MAX || hasControlCharacter(name)) {
      return domainError(
        "customModuleNameInvalid",
        { max: CUSTOM_MODULE_NAME_MAX },
        { status: 400 },
      );
    }
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
