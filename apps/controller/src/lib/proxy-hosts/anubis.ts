/**
 * A proof-of-work bot challenge from an Anubis instance the operator runs, in its subrequest mode
 * (TARGET=" "): every request is checked against it, and one without a pass cookie is redirected
 * to its challenge page. Separate from forward auth, so a host can have both: challenge, then SSO.
 */
import { domainError } from "../errors/domain-error";

/** Anubis serves its challenge page, assets and pass endpoint under this prefix. */
export const ANUBIS_PREFIX = "/.within.website";
export const ANUBIS_CHECK_URI = `${ANUBIS_PREFIX}/x/cmd/anubis/api/check`;
export const ANUBIS_EXEMPT_PATHS_MAX = 50;
const EXEMPT_PATH_MAX_LENGTH = 512;

/** As stored in the host's meta. */
export type HostAnubisMeta = {
  enabled: boolean;
  upstream?: string;
  exempt_paths?: string[];
};

/** As the API and the editor see it. */
export type HostAnubisConfig = {
  enabled: boolean;
  /** Anubis's base URL, e.g. http://anubis:8923. */
  upstream: string | null;
  /** Caddy path matchers that skip the challenge: API clients cannot solve one. */
  exemptPaths: string[];
};

type Refuse = (
  code: "hostAnubisUpstreamInvalid" | "hostAnubisExemptPathInvalid",
  value: string,
) => void;

/** host:port to dial, or null. A brace would read as a placeholder in the dial address. */
function dialOf(upstream: string): { dial: string; tls: boolean } | null {
  if (/[{}\s]/.test(upstream)) return null;
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname || url.username || url.password) return null;
  const tls = url.protocol === "https:";
  return { dial: `${url.hostname}:${url.port || (tls ? "443" : "80")}`, tls };
}

function build(value: unknown, refuse: Refuse): HostAnubisMeta | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const meta: HostAnubisMeta = { enabled: raw.enabled === true };

  const upstream = typeof raw.upstream === "string" ? raw.upstream.trim() : "";
  if (upstream && dialOf(upstream)) meta.upstream = upstream;
  else if (upstream) refuse("hostAnubisUpstreamInvalid", upstream.slice(0, 80));

  const paths: string[] = [];
  const rawPaths = raw.exempt_paths ?? raw.exemptPaths;
  for (const entry of Array.isArray(rawPaths) ? rawPaths : []) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const path = entry.trim();
    // Refused rather than stripped: a placeholder in a matcher would read request state.
    if (!path.startsWith("/") || /[{}\s]/.test(path) || path.length > EXEMPT_PATH_MAX_LENGTH) {
      refuse("hostAnubisExemptPathInvalid", path.slice(0, 80));
      continue;
    }
    if (!paths.includes(path)) paths.push(path);
  }
  if (paths.length > 0) meta.exempt_paths = paths.slice(0, ANUBIS_EXEMPT_PATHS_MAX);

  // Off with nothing to remember is the same as never set.
  return meta.enabled || Object.keys(meta).length > 1 ? meta : undefined;
}

/** A stored blob: anything unreadable is dropped rather than failing the config. */
export function sanitizeHostAnubis(value: unknown): HostAnubisMeta | undefined {
  return build(value, () => {});
}

/** From the editor or the API: refuses what generation would have to drop. */
export function normalizeHostAnubisInput(value: unknown): HostAnubisMeta | undefined {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const rawPaths = raw.exempt_paths ?? raw.exemptPaths;
  if (Array.isArray(rawPaths) && rawPaths.length > ANUBIS_EXEMPT_PATHS_MAX) {
    throw domainError(
      "hostAnubisExemptPathsTooMany",
      { max: ANUBIS_EXEMPT_PATHS_MAX },
      { status: 400 },
    );
  }
  const meta = build(value, (code, bad) => {
    throw domainError(code, { value: bad }, { status: 400 });
  });
  if (meta?.enabled && !meta.upstream) {
    throw domainError("hostAnubisUpstreamRequired", {}, { status: 400 });
  }
  return meta;
}

export function hydrateHostAnubis(meta: HostAnubisMeta | undefined): HostAnubisConfig | null {
  if (!meta) return null;
  return {
    enabled: meta.enabled,
    upstream: meta.upstream ?? null,
    exemptPaths: meta.exempt_paths ?? [],
  };
}

/**
 * Both hops name the client explicitly: Anubis keys challenges on X-Real-Ip, and would otherwise
 * derive it from an X-Forwarded-For that ignores Caddy's trusted proxies.
 */
const CLIENT_IP_HEADERS = {
  "X-Real-Ip": ["{http.vars.client_ip}"],
  "X-Forwarded-For": ["{http.vars.client_ip}"],
};

/**
 * A non-admin picks the upstream and this runs before an access list strips Authorization, so it
 * never leaves. Cookie stays: Anubis's pass cookie name carries a configurable prefix and a hash.
 */
const WITHHELD_HEADERS = ["Authorization"];

/**
 * One subroute for the shared chain, or null when off or unusable. Its routes match disjoint
 * paths rather than relying on `terminal`, which inside a subroute would end the whole request.
 */
export function buildAnubisHandler(
  meta: HostAnubisMeta | undefined,
): Record<string, unknown> | null {
  if (!meta?.enabled || !meta.upstream) return null;
  const target = dialOf(meta.upstream);
  if (!target) return null;

  const upstreamFields = (): Record<string, unknown> => ({
    upstreams: [{ dial: target.dial }],
    ...(target.tls ? { transport: { protocol: "http", tls: {} } } : {}),
  });
  const challengePaths = [`${ANUBIS_PREFIX}/*`];

  const check: Record<string, unknown> = {
    handler: "reverse_proxy",
    ...upstreamFields(),
    // The bare `?` clears the query, which Caddy otherwise keeps: Anubis answers a passing check
    // whose query holds `redir` with a redirect of its own, which would replace the page.
    rewrite: { method: "GET", uri: `${ANUBIS_CHECK_URI}?` },
    headers: {
      request: {
        set: {
          ...CLIENT_IP_HEADERS,
          "X-Forwarded-Method": ["{http.request.method}"],
          "X-Forwarded-Uri": ["{http.request.uri}"],
          "X-Forwarded-Host": ["{http.request.hostport}"],
          "X-Forwarded-Proto": ["{http.request.scheme}"],
        },
        delete: WITHHELD_HEADERS,
      },
    },
    handle_response: [
      // A pass: on to the rest of the chain. Without this route the 200 itself would be the answer.
      { match: { status_code: [2] }, routes: [{ handle: [{ handler: "vars" }] }] },
      // Relative and query-escaped, so Anubis's redirect check applies and `&` in it survives.
      // Anything else (a DENY's 403, the 307 Anubis sends itself with PUBLIC_URL) passes through.
      {
        match: { status_code: [401] },
        routes: [
          {
            handle: [
              {
                handler: "static_response",
                status_code: 307,
                headers: {
                  Location: [`${ANUBIS_PREFIX}/?redir={http.request.uri_escaped}`],
                  "Cache-Control": ["no-store"],
                },
              },
            ],
          },
        ],
      },
    ],
  };

  const exempt = meta.exempt_paths ?? [];
  return {
    handler: "subroute",
    routes: [
      {
        match: [{ path: challengePaths }],
        handle: [
          {
            handler: "reverse_proxy",
            ...upstreamFields(),
            headers: { request: { set: { ...CLIENT_IP_HEADERS }, delete: WITHHELD_HEADERS } },
          },
        ],
      },
      {
        match: [{ not: [{ path: [...challengePaths, ...exempt] }] }],
        handle: [check],
      },
    ],
  };
}
