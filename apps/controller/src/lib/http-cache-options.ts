/** The HTTP cache settings' shape and choices, free of server imports so the form can use them. */

export const CACHE_STORAGES = ["memory", "otter", "badger", "simplefs", "redis", "etcd"] as const;
export type CacheStorage = (typeof CACHE_STORAGES)[number];

export const CDN_PROVIDERS = ["none", "cloudflare", "fastly"] as const;
export type CdnProvider = (typeof CDN_PROVIDERS)[number];

export const CDN_STRATEGIES = ["soft", "hard"] as const;
export type CdnStrategy = (typeof CDN_STRATEGIES)[number];

/** Module id per storage; `memory` is Souin's built-in and needs none. */
export const CACHE_STORAGE_MODULE_IDS: Record<Exclude<CacheStorage, "memory">, string> = {
  otter: "souin-storage-otter",
  badger: "souin-storage-badger",
  simplefs: "souin-storage-simplefs",
  redis: "souin-storage-redis",
  etcd: "souin-storage-etcd",
};

/** On the Caddy data volume, so a file-backed cache survives a restart. Fixed: no path input. */
export const CACHE_STORAGE_PATHS = {
  badger: "/data/souin/badger",
  simplefs: "/data/souin/simplefs",
} as const;

export const MAX_CACHE_ENDPOINTS = 16;
export const MIN_OTTER_SIZE = 1_000;
export const MAX_OTTER_SIZE = 10_000_000;
export const MAX_REDIS_DB = 255;

export type HttpCacheSettings = {
  storage: CacheStorage;
  /** Entries Otter holds; null keeps Souin's default. */
  otterSize: number | null;
  redis: { addresses: string[]; username: string; password: string; db: number };
  etcd: { endpoints: string[] };
  cdn: {
    provider: CdnProvider;
    apiKey: string;
    email: string;
    zoneId: string;
    serviceId: string;
    strategy: CdnStrategy;
  };
};

/** What the browser and `/api/v1` see: secrets become flags. */
export type HttpCacheSettingsView = Omit<HttpCacheSettings, "redis" | "cdn"> & {
  redis: Omit<HttpCacheSettings["redis"], "password"> & { hasPassword: boolean };
  cdn: Omit<HttpCacheSettings["cdn"], "apiKey"> & { hasApiKey: boolean };
};

export const DEFAULT_HTTP_CACHE_SETTINGS: HttpCacheSettings = {
  storage: "memory",
  otterSize: null,
  redis: { addresses: [], username: "", password: "", db: 0 },
  etcd: { endpoints: [] },
  cdn: { provider: "none", apiKey: "", email: "", zoneId: "", serviceId: "", strategy: "soft" },
};
