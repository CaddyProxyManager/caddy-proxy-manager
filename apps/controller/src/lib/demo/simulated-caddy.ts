/**
 * An in-memory Caddy admin API for demo mode: answers load, read back and adapt so apply runs end
 * to end. Nothing is served, so no certificate is ordered and no DNS provider called.
 */
import type { CaddyAdminProxyRequest, CaddyAdminProxyResponse } from "@cpm/shared";

export type SimulatedCaddy = (request: CaddyAdminProxyRequest) => CaddyAdminProxyResponse;

const JSON_HEADERS = { "content-type": "application/json" };

function answer(status: number, body: unknown): CaddyAdminProxyResponse {
  // A copy per response: the config readback adds an ETag, which must not stick to every answer.
  return { status, text: body === "" ? "" : JSON.stringify(body), headers: { ...JSON_HEADERS } };
}

/** Walk `/config/apps/http/...` the way Caddy does: a missing key reads as null, not an error. */
function readPath(config: unknown, path: string): unknown {
  let node = config;
  for (const segment of path.split("/").filter(Boolean)) {
    if (node === null || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[decodeURIComponent(segment)] ?? null;
  }
  return node;
}

export function createSimulatedCaddy(): SimulatedCaddy {
  // Caddy starts with an empty config, and the monitor reads `{}` as one that needs applying.
  let loaded: Record<string, unknown> = {};
  // Real Caddy tags each config it serves. Without one the monitor falls back to "does it have
  // apps", and a demo with no hosts loads none - so it read every check as a restart and reapplied.
  let generation = 0;

  return ({ method, path, body }) => {
    const route = path.split("?")[0];

    if (method === "POST" && route === "/load") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? "");
      } catch {
        return answer(400, { error: "loading config: invalid JSON" });
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return answer(400, { error: "loading config: config must be a JSON object" });
      }
      loaded = parsed as Record<string, unknown>;
      generation++;
      return answer(200, "");
    }

    if (method === "GET" && route.startsWith("/config/")) {
      const response = answer(200, readPath(loaded, route.slice("/config/".length)));
      // Only once something is loaded: an untagged empty config is what a restarted Caddy serves.
      if (generation > 0) response.headers.etag = `"demo-${generation}"`;
      return response;
    }

    // Parsing a Caddyfile takes Caddy itself. Accepting the snippet with a warning keeps the host
    // saveable; the routes it would have produced are simply absent from a config nothing serves.
    if (method === "POST" && route === "/adapt") {
      return answer(200, {
        result: { apps: { http: { servers: {} } } },
        warnings: [{ message: "Demo mode: the Caddyfile was not adapted, so it adds no routes." }],
      });
    }

    return answer(404, { error: `unrecognized admin path: ${route}` });
  };
}
