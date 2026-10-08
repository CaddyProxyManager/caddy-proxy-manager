/**
 * Forwards the controller's admin requests to this agent's Caddy, which only the agent can locate;
 * otherwise a remote host's Caddy and its container would be managed on different machines.
 */

import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import {
  CADDY_DIGEST_HEADER,
  type CaddyAdminProxyRequest,
  type CaddyAdminProxyResponse,
} from "@cpm/shared";

/**
 * An allowlist, not a sanitiser: the admin API can also stop the server or load config anywhere,
 * and the controller needs only these. Anything else did not come from this app, whoever signed it.
 */
const ALLOWED_PATHS: ReadonlyArray<RegExp> = [
  /** Replace the whole config - the apply path. */
  /^\/load$/,
  /** Read the running config, for the restart detector. */
  /^\/config\/?$/,
  /** Convert a Caddyfile snippet to JSON. */
  /^\/adapt$/,
  /** Caddy's own liveness endpoint. */
  /^\/reverse_proxy\/upstreams$/,
];

export function isAllowedAdminPath(path: string): boolean {
  // Checked before the allowlist so a traversal can never be smuggled through a pattern that
  // happens to match after normalisation.
  if (!path.startsWith("/") || path.includes("..")) return false;
  const withoutQuery = path.split("?")[0];
  return ALLOWED_PATHS.some((pattern) => pattern.test(withoutQuery));
}

/** `CaddyAdminProxyRequest.digest`: the hash the controller would take of the body itself. */
export function digestResponse(response: CaddyAdminProxyResponse): CaddyAdminProxyResponse {
  if (response.status >= 300) return response;
  return {
    status: response.status,
    text: createHash("sha256").update(response.text).digest("hex"),
    headers: { [CADDY_DIGEST_HEADER]: "sha256" },
  };
}

/** Shared with the controller, which pins a config it loads without an agent the same way. */
export { loadsConfig, pinAdminListen } from "@cpm/shared";

export class CaddyAdminUnreachable extends Error {}

/** node:http, not fetch: its Sec-Fetch-* headers trip Caddy's origin check and 403 every call. */
export async function forwardToCaddy(
  adminRoot: string,
  request: CaddyAdminProxyRequest,
  timeoutMs = 30_000,
): Promise<CaddyAdminProxyResponse> {
  const root = adminRoot.replace(/\/+$/, "");
  const parsed = new URL(`${root}${request.path}`);
  const body = request.body;

  return new Promise((resolve, reject) => {
    const lib = parsed.protocol === "https:" ? https : http;
    // outbound: caddyAdmin
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: request.method,
        headers: body
          ? {
              "Content-Type": request.contentType ?? "application/json",
              "Content-Length": Buffer.byteLength(body),
            }
          : {},
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === "string") headers[key] = value;
            else if (Array.isArray(value)) headers[key] = value.join(", ");
          }
          resolve({ status: res.statusCode ?? 0, text: data, headers });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new CaddyAdminUnreachable("Caddy did not answer in time."));
    });
    req.on("error", () => reject(new CaddyAdminUnreachable("Caddy is not reachable.")));
    if (body) req.write(body);
    req.end();
  });
}
