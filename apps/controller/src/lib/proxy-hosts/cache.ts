/**
 * "Cache assets" for a proxy host, applied to static asset paths only: HTML and API responses are
 * too often per-user to cache by default. Browser mode only sets Cache-Control where the upstream
 * set none; Caddy mode adds a shared cache in front of the upstream, and needs the opt-in
 * cache-handler module (caddy/image-build/modules.ts).
 */

export const HOST_CACHE_MODES = ["browser", "caddy"] as const;
export type HostCacheMode = (typeof HOST_CACHE_MODES)[number];

export const DEFAULT_CACHE_MAX_AGE = 86_400;
export const MIN_CACHE_MAX_AGE = 60;
export const MAX_CACHE_MAX_AGE = 31_536_000;

/** As stored in the host's meta. */
export type HostCacheMeta = { mode: HostCacheMode; max_age: number };
/** As the API and the editor see it. */
export type HostCacheConfig = { mode: HostCacheMode; maxAge: number };

/** The extensions NPM's assets.conf caches, plus the modern image and font formats. */
export const CACHE_ASSET_PATHS = [
  "css",
  "js",
  "mjs",
  "map",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
  "svg",
  "ico",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
].map((extension) => `*.${extension}`);

function clampMaxAge(value: unknown): number {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds)) return DEFAULT_CACHE_MAX_AGE;
  return Math.min(MAX_CACHE_MAX_AGE, Math.max(MIN_CACHE_MAX_AGE, Math.round(seconds)));
}

/** Null turns caching off; anything unreadable falls back to browser mode for a day. */
export function sanitizeHostCache(value: unknown): HostCacheMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const mode = HOST_CACHE_MODES.includes(raw.mode as HostCacheMode)
    ? (raw.mode as HostCacheMode)
    : "browser";
  return { mode, max_age: clampMaxAge(raw.max_age ?? raw.maxAge) };
}

export function hydrateHostCache(meta: HostCacheMeta | undefined): HostCacheConfig | null {
  return meta ? { mode: meta.mode, maxAge: meta.max_age } : null;
}

/**
 * A Set-Cookie response is marked private before any cache sees it, so one visitor's cookie is
 * never stored and replayed to the next - Souin caches such responses otherwise. Added, not set,
 * so an upstream's own `no-store` survives it.
 */
const COOKIE_GUARD = {
  handler: "headers",
  response: {
    add: { "Cache-Control": ["private"] },
    require: { headers: { "Set-Cookie": [] } },
  },
};

/**
 * The handler for a host's chain, or null when caching is off. Sits after auth and the WAF and
 * before the proxy; a non-terminal subroute, so the proxy after it still answers every request.
 * `caddyCacheUsable` false degrades Caddy mode to browser mode: emitting a handler for a module
 * the binary lacks would make Caddy refuse the whole config.
 */
export function buildHostCacheHandler(
  cache: HostCacheMeta | undefined,
  caddyCacheUsable: boolean,
): Record<string, unknown> | null {
  if (!cache) return null;
  const maxAge = clampMaxAge(cache.max_age);
  const browser = {
    handler: "headers",
    response: {
      set: { "Cache-Control": [`max-age=${maxAge}`] },
      // 2xx only, so a 404 or 500 mid-deploy is not kept for a day. A null list matches only
      // when the header is absent: the upstream's own policy wins.
      require: { status_code: [2], headers: { "Cache-Control": null } },
    },
  };
  // Outermost first: the innermost header op runs first on the way out, so the guard marks a
  // cookie response before the browser default would fill it in, and the cache sees both.
  const headers = [browser, COOKIE_GUARD];
  if (cache.mode !== "caddy" || !caddyCacheUsable) {
    return {
      handler: "subroute",
      routes: [{ match: [{ path: CACHE_ASSET_PATHS }], handle: headers }],
    };
  }
  // Souin keys on the URL and skips only Authorization, so an asset an upstream gates by cookie
  // would reach the next visitor. Exclusive matchers: a terminal route here would end the request.
  return {
    handler: "subroute",
    routes: [
      {
        match: [{ path: CACHE_ASSET_PATHS, header: { Cookie: null } }],
        handle: [
          // The per-host TTL lives here; the handler's own `ttl` field is ignored.
          { handler: "cache", Configuration: { DefaultCache: { ttl: `${maxAge}s` } } },
          ...headers,
        ],
      },
      { match: [{ path: CACHE_ASSET_PATHS, header: { Cookie: [] } }], handle: headers },
    ],
  };
}

/** One handler either way, so every route shape can place it where the bare proxy went. */
export function withHostCache(
  proxy: Record<string, unknown>,
  cacheHandler: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!cacheHandler) return proxy;
  return { handler: "subroute", routes: [{ handle: [structuredClone(cacheHandler), proxy] }] };
}
