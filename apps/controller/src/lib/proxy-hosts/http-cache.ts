/**
 * Where the Caddy cache (Souin) keeps entries, and which CDN it purges alongside. Each storage is
 * its own opt-in module; one not compiled in is left out, and Souin falls back to memory.
 *
 * Only storages verified against cache-handler v0.17.0 are offered: its lookup id for NATS and
 * Olric never matches the one those storages register, and NutsDB hangs on read, so all three
 * would silently cache in memory. Akamai is left out because Souin's purge requests are unsigned.
 */

import { decryptSecret, encryptSecret } from "../secrets";
import { type DomainErrorCode, domainError } from "../errors/domain-error";

import {
  CACHE_STORAGE_PATHS,
  CACHE_STORAGES,
  type CacheStorage,
  CDN_PROVIDERS,
  CDN_STRATEGIES,
  type CdnProvider,
  type CdnStrategy,
  type HttpCacheSettings,
  type HttpCacheSettingsView,
  MAX_CACHE_ENDPOINTS,
  MAX_CACHE_TOKEN_LENGTH,
  MAX_OTTER_SIZE,
  MAX_REDIS_DB,
  MIN_OTTER_SIZE,
  type ModuleCacheStorage,
} from "./http-cache-options";

export * from "./http-cache-options";

// host:port, IPv6 bracketed. Handed to Caddy verbatim, so nothing that could end the value.
const HOST_PORT =
  /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):\d{1,5}$/;
const ETCD_ENDPOINT =
  /^(?:https?:\/\/)?(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):\d{1,5}$/;
// Room for the encrypted form of a long secret, which is what the stored row holds.
const MAX_SECRET_LENGTH = 4096;
const TOKEN = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_CACHE_TOKEN_LENGTH}}$`);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
const CONTROL = /[\u0000-\u001f\u007f]/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const blank = (value: unknown): boolean =>
  value === null || value === undefined || (typeof value === "string" && value.trim() === "");

function list(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  return items.map(text).filter(Boolean);
}

function port(address: string): number {
  return Number(address.slice(address.lastIndexOf(":") + 1));
}

// One code per field: a field name interpolated into a sentence is not something a reader can use.
function endpoints(
  value: unknown,
  pattern: RegExp,
  codes: { tooMany: DomainErrorCode; invalid: DomainErrorCode },
): string[] {
  const entries = [...new Set(list(value))];
  if (entries.length > MAX_CACHE_ENDPOINTS) {
    throw domainError(codes.tooMany, { max: MAX_CACHE_ENDPOINTS });
  }
  for (const entry of entries) {
    const p = port(entry);
    if (!pattern.test(entry) || p < 1 || p > 65_535) {
      throw domainError(codes.invalid, { value: entry });
    }
  }
  return entries;
}

function secret(value: unknown, code: DomainErrorCode): string {
  const raw = typeof value === "string" ? value : "";
  if (raw.length > MAX_SECRET_LENGTH || CONTROL.test(raw)) throw domainError(code);
  return raw;
}

function matching(value: unknown, pattern: RegExp, code: DomainErrorCode): string {
  const raw = text(value);
  if (raw && !pattern.test(raw)) throw domainError(code, { max: MAX_CACHE_TOKEN_LENGTH });
  return raw;
}

function integer(value: unknown, min: number, max: number, code: DomainErrorCode): number {
  const n = typeof value === "number" ? value : Number(text(value));
  if (!Number.isInteger(n) || n < min || n > max) throw domainError(code, { min, max });
  return n;
}

/**
 * Throws on anything Caddy could not take; the stored secrets pass through as they are, whether
 * encrypted or not. A storage or provider missing what it needs is refused here rather than left
 * for Souin to fall back from quietly. `secretsPending` skips the API key's presence, for a form that
 * leaves a stored one blank until `keepStoredSecrets` fills it in.
 */
export function normalizeHttpCacheSettings(
  value: unknown,
  { secretsPending = false }: { secretsPending?: boolean } = {},
): HttpCacheSettings {
  const raw = isObject(value) ? value : {};
  const storage = CACHE_STORAGES.includes(raw.storage as CacheStorage)
    ? (raw.storage as CacheStorage)
    : "memory";
  const redisRaw = isObject(raw.redis) ? raw.redis : {};
  const etcdRaw = isObject(raw.etcd) ? raw.etcd : {};
  const cdnRaw = isObject(raw.cdn) ? raw.cdn : {};

  const otterSize = blank(raw.otterSize)
    ? null
    : integer(raw.otterSize, MIN_OTTER_SIZE, MAX_OTTER_SIZE, "httpCacheOtterSizeInvalid");

  const redis = {
    addresses: endpoints(redisRaw.addresses, HOST_PORT, {
      tooMany: "httpCacheTooManyRedisAddresses",
      invalid: "httpCacheRedisAddressInvalid",
    }),
    username: matching(redisRaw.username, TOKEN, "httpCacheRedisUsernameInvalid"),
    password: secret(redisRaw.password, "httpCacheRedisPasswordInvalid"),
    db: blank(redisRaw.db) ? 0 : integer(redisRaw.db, 0, MAX_REDIS_DB, "httpCacheRedisDbInvalid"),
  };
  const etcd = {
    endpoints: endpoints(etcdRaw.endpoints, ETCD_ENDPOINT, {
      tooMany: "httpCacheTooManyEtcdEndpoints",
      invalid: "httpCacheEtcdEndpointInvalid",
    }),
  };
  if (storage === "redis" && redis.addresses.length === 0) {
    throw domainError("httpCacheStorageNeedsEndpoint", { storage: "Redis" });
  }
  if (storage === "etcd" && etcd.endpoints.length === 0) {
    throw domainError("httpCacheStorageNeedsEndpoint", { storage: "etcd" });
  }

  const provider = CDN_PROVIDERS.includes(cdnRaw.provider as CdnProvider)
    ? (cdnRaw.provider as CdnProvider)
    : "none";
  const cdn = {
    provider,
    apiKey: secret(cdnRaw.apiKey, "httpCacheCdnApiKeyInvalid"),
    email: matching(cdnRaw.email, EMAIL, "httpCacheCdnEmailInvalid"),
    zoneId: matching(cdnRaw.zoneId, TOKEN, "httpCacheCdnZoneIdInvalid"),
    serviceId: matching(cdnRaw.serviceId, TOKEN, "httpCacheCdnServiceIdInvalid"),
    strategy: CDN_STRATEGIES.includes(cdnRaw.strategy as CdnStrategy)
      ? (cdnRaw.strategy as CdnStrategy)
      : "soft",
  };
  const hasApiKey = secretsPending || cdn.apiKey !== "";
  const needs: [boolean, DomainErrorCode][] =
    provider === "cloudflare"
      ? [
          [hasApiKey, "httpCacheCloudflareApiKeyRequired"],
          [cdn.email !== "", "httpCacheCloudflareEmailRequired"],
          [cdn.zoneId !== "", "httpCacheCloudflareZoneIdRequired"],
        ]
      : provider === "fastly"
        ? [
            [hasApiKey, "httpCacheFastlyApiKeyRequired"],
            [cdn.serviceId !== "", "httpCacheFastlyServiceIdRequired"],
          ]
        : [];
  const missing = needs.find(([present]) => !present);
  if (missing) throw domainError(missing[1]);

  return { storage, otterSize, redis, etcd, cdn };
}

const sameServers = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/**
 * Fills a blank secret from the stored one, as a re-saved form leaves it blank. Only for the same
 * storage or provider, and dropped with it: a key for a CDN switched off is not kept on file.
 * The Redis password also needs the same servers, or pointing them elsewhere would hand it over.
 */
export function keepStoredSecrets(
  submitted: HttpCacheSettings,
  stored: HttpCacheSettings | null,
): HttpCacheSettings {
  const redisKept =
    submitted.storage === "redis" &&
    stored?.storage === "redis" &&
    sameServers(submitted.redis.addresses, stored.redis.addresses);
  const cdnKept =
    submitted.cdn.provider !== "none" && stored?.cdn.provider === submitted.cdn.provider;
  return {
    ...submitted,
    redis: {
      ...submitted.redis,
      password:
        submitted.storage === "redis"
          ? submitted.redis.password || (redisKept ? (stored?.redis.password ?? "") : "")
          : "",
    },
    cdn: {
      ...submitted.cdn,
      apiKey:
        submitted.cdn.provider === "none"
          ? ""
          : submitted.cdn.apiKey || (cdnKept ? (stored?.cdn.apiKey ?? "") : ""),
    },
  };
}

export function encryptHttpCacheSecrets(settings: HttpCacheSettings): HttpCacheSettings {
  return {
    ...settings,
    redis: { ...settings.redis, password: encryptSecret(settings.redis.password) },
    cdn: { ...settings.cdn, apiKey: encryptSecret(settings.cdn.apiKey) },
  };
}

export function redactHttpCacheSettings(settings: HttpCacheSettings): HttpCacheSettingsView {
  const { password, ...redis } = settings.redis;
  const { apiKey, ...cdn } = settings.cdn;
  return {
    ...settings,
    redis: { ...redis, hasPassword: password.length > 0 },
    cdn: { ...cdn, hasApiKey: apiKey.length > 0 },
  };
}

/**
 * The `cache` app, or null to leave it out: nothing to say, or a global Caddyfile's own `cache`
 * block should win. `storageUsable` says whether the chosen storage is compiled into this agent.
 * `found: true` is required: without it Souin ignores the block and caches in memory.
 */
export function buildHttpCacheApp(
  settings: HttpCacheSettings | null,
  storageUsable: (storage: ModuleCacheStorage) => boolean,
): Record<string, unknown> | null {
  if (!settings) return null;
  const app: Record<string, unknown> = {};
  const { storage } = settings;

  if (storage !== "memory" && storageUsable(storage)) {
    switch (storage) {
      case "otter":
        app.otter = {
          found: true,
          configuration: settings.otterSize ? { size: settings.otterSize } : {},
        };
        break;
      case "badger":
      case "simplefs":
        app[storage] = { found: true, path: CACHE_STORAGE_PATHS[storage] };
        break;
      case "redis": {
        const { addresses, username, password, db } = settings.redis;
        // ClientName is not optional: cache-handler assumes this one, and a mismatch falls back.
        const configuration: Record<string, unknown> = {
          InitAddress: addresses,
          SelectDB: db,
          ClientName: "souin-redis",
        };
        if (username) configuration.Username = username;
        const plain = decryptSecret(password, "HTTP cache Redis password");
        if (plain) configuration.Password = plain;
        app.redis = { found: true, configuration };
        break;
      }
      case "etcd":
        // The url form: the configuration form's lookup id never matches (see the header).
        app.etcd = { found: true, url: settings.etcd.endpoints.join(",") };
        break;
    }
  }

  const { cdn } = settings;
  if (cdn.provider !== "none") {
    const apiKey = decryptSecret(cdn.apiKey, "HTTP cache CDN API key");
    app.cdn =
      cdn.provider === "cloudflare"
        ? { provider: "cloudflare", api_key: apiKey, email: cdn.email, zone_id: cdn.zoneId }
        : {
            provider: "fastly",
            api_key: apiKey,
            service_id: cdn.serviceId,
            strategy: cdn.strategy,
          };
  }

  return Object.keys(app).length > 0 ? app : null;
}
