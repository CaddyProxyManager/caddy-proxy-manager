/**
 * The one seam to the Caddy admin API, so tests swap in an in-memory adapter. Requests go through
 * an agent: dialling `CADDY_API_URL` directly could configure this host's Caddy while a remote agent
 * runs the real one. The direct transport is only for a deployment with no agent, and one
 * controller: several would each load their own config onto it, and agents are how they share.
 */
import http from "node:http";
import https from "node:https";
import { loadsConfig, pinAdminListen } from "@cpm/shared";
import { isDemoMode } from "../demo/mode";

export type CaddyAdminRequest = {
  /** Path relative to the configured admin API root, e.g. "/load" or "/config/". */
  path: string;
  method: string;
  body?: string;
  /** Omitted means no client-side timeout. */
  timeoutMs?: number;
  /** Defaults to application/json; /adapt needs text/caddyfile. */
  contentType?: string;
  /**
   * Required when the answer shapes a config loaded onto that agent: one agent's answer must never
   * shape another's. A pinned request never falls back to a direct connection.
   */
  agentId?: string;
};

export type CaddyAdminResponse = {
  status: number;
  text: string;
  headers: Record<string, string | string[] | undefined>;
};

export type CaddyAdminTransport = (request: CaddyAdminRequest) => Promise<CaddyAdminResponse>;

/** Settings imported lazily: they read process.env on load, before a test could set it. */
async function caddyAdminUrl(path: string): Promise<string> {
  const [{ caddyApiUrl }, { getSetting }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  const root = (await getSetting(caddyApiUrl)).replace(/\/+$/, "");
  return `${root}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Pins `CADDY_ADMIN_LISTEN` as the agent does: the built document binds every interface, which
 * would expose the admin API on caddy-network to every upstream.
 */
export function directRequestBody(
  request: Pick<CaddyAdminRequest, "method" | "path" | "body">,
  listen = process.env.CADDY_ADMIN_LISTEN?.trim() || null,
): string | undefined {
  if (!listen || !request.body || !loadsConfig(request)) return request.body;
  const pinned = pinAdminListen(request.body, listen);
  if (pinned === null) throw new Error("A config for Caddy must be a JSON object.");
  return pinned;
}

/** node:http, not `fetch`: Sec-Fetch-* headers trigger Caddy's CORS origin enforcement. */
export const httpCaddyAdminTransport: CaddyAdminTransport = async ({
  path,
  method,
  body: requestBody,
  timeoutMs,
  contentType,
}) => {
  // Catches a module that grabbed the real transport before demo mode swapped it.
  if (isDemoMode()) {
    throw new Error("The real Caddy admin transport was used in demo mode.");
  }

  // Backstop for tests/setup.bun.ts. CPM_TEST comes from tests/helpers/env.ts; bun sets no marker.
  if (process.env.CPM_TEST) {
    throw new Error(
      "The real Caddy admin transport was used inside a test. Tests must install an " +
        "in-memory adapter via setCaddyAdminTransport() - see tests/helpers/caddy-admin.ts.",
    );
  }

  const parsed = new URL(await caddyAdminUrl(path));
  const body = directRequestBody({ method, path, body: requestBody });

  return new Promise((resolve, reject) => {
    const lib = parsed.protocol === "https:" ? https : http;
    // outbound: caddyAdmin
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          ...(body
            ? {
                "Content-Type": contentType ?? "application/json",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: data, headers: res.headers }),
        );
      },
    );
    if (timeoutMs !== undefined) {
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error("timeout"));
      });
    }
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
};

/** Falls back to `direct` when no agent answers, for a Caddy running without an agent. */
export function agentCaddyAdminTransportWith(direct: CaddyAdminTransport): CaddyAdminTransport {
  return async (request) => {
    const { caddyAdminViaAgent, AgentRequiredError, AgentUnavailableError } = await import(
      "../agent/client"
    );
    try {
      const response = await caddyAdminViaAgent(
        {
          path: request.path,
          method: request.method,
          body: request.body,
          contentType: request.contentType,
        },
        request.agentId,
      );
      return { status: response.status, text: response.text, headers: response.headers };
    } catch (error) {
      // Never for a pinned request: an agent going away mid-apply must not redirect it here.
      if (!(error instanceof AgentUnavailableError) || request.agentId !== undefined) throw error;
      const { otherReplicasLive } = await import("../cluster/replicas");
      if (otherReplicasLive()) throw new AgentRequiredError();
      return direct(request);
    }
  };
}

export const agentCaddyAdminTransport = agentCaddyAdminTransportWith(httpCaddyAdminTransport);

// On globalThis: a dev program reload re-evaluates this module without re-running register(),
// which would drop the demo's simulated Caddy for the real one.
const slot = globalThis as typeof globalThis & { __cpmCaddyAdminTransport?: CaddyAdminTransport };

/** Returns the previous adapter so callers can restore it. */
export function setCaddyAdminTransport(next: CaddyAdminTransport): CaddyAdminTransport {
  const previous = slot.__cpmCaddyAdminTransport ?? agentCaddyAdminTransport;
  slot.__cpmCaddyAdminTransport = next;
  return previous;
}

export function caddyAdminRequest(request: CaddyAdminRequest): Promise<CaddyAdminResponse> {
  return (slot.__cpmCaddyAdminTransport ?? agentCaddyAdminTransport)(request);
}
