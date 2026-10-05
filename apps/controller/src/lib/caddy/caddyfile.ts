/**
 * Caddy's own `/adapt` does the parsing, so the running binary's plugin set decides; a hand-rolled
 * parser would drift and accept directives for plugins that are not compiled in.
 */

import { connectedAgents } from "../agent/registry";
import { type DomainError, domainError } from "../errors/domain-error";
import { caddyAdminRequest } from "./admin";

export type AdaptedCaddyfile = {
  routes: Record<string, unknown>[];
  warnings: string[];
  /** Apps not honoured at host scope (`tls`, `layer4`), surfaced so they do not silently vanish. */
  ignoredApps: string[];
};

export class CaddyfileAdaptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaddyfileAdaptError";
  }
}

/** `:80` produces no host matcher; host matching is added when the routes are nested. */
function wrapSnippet(snippet: string): string {
  return `:80 {\n${snippet}\n}\n`;
}

type AdaptResponse = {
  result?: {
    apps?: {
      http?: {
        servers?: Record<string, { routes?: Record<string, unknown>[] }>;
      };
    } & Record<string, unknown>;
  };
  warnings?: { message?: string; file?: string; line?: number }[];
  error?: string;
};

/**
 * `agentId` must be the agent the document is loaded onto: the answer is nested unmodified, so an
 * agent adapting for another would be writing that agent's routes.
 */
export async function adaptCaddyfileSnippet(
  snippet: string,
  agentId?: string,
): Promise<AdaptedCaddyfile> {
  const trimmed = snippet.trim();
  if (!trimmed) return { routes: [], warnings: [], ignoredApps: [] };

  const parsed = await requestAdapt(wrapSnippet(trimmed), agentId);
  const apps = parsed.result?.apps ?? {};
  const servers = apps.http?.servers ?? {};
  const routes: Record<string, unknown>[] = [];
  for (const server of Object.values(servers)) {
    for (const route of server.routes ?? []) {
      routes.push(route);
    }
  }

  const ignoredApps = Object.keys(apps).filter((key) => key !== "http");

  return { routes, warnings: adaptWarnings(parsed), ignoredApps };
}

async function requestAdapt(caddyfile: string, agentId?: string): Promise<AdaptResponse> {
  const response = await caddyAdminRequest({
    path: "/adapt",
    method: "POST",
    body: caddyfile,
    contentType: "text/caddyfile",
    // Pure parsing: a slow answer means the admin endpoint is wrong, not the snippet.
    timeoutMs: 10_000,
    agentId,
  });

  let parsed: AdaptResponse;
  try {
    parsed = JSON.parse(response.text) as AdaptResponse;
  } catch {
    throw new CaddyfileAdaptError(
      `Caddy returned an unreadable response while adapting the Caddyfile (HTTP ${response.status}): ${response.text.slice(0, 200)}`,
    );
  }

  if (response.status >= 400 || parsed.error) {
    throw new CaddyfileAdaptError(
      parsed.error ?? `Caddy rejected the Caddyfile (HTTP ${response.status})`,
    );
  }
  return parsed;
}

function adaptWarnings(parsed: AdaptResponse): string[] {
  return (parsed.warnings ?? [])
    .map((w) => (w.line ? `line ${w.line}: ${w.message ?? ""}` : (w.message ?? "")))
    .filter(Boolean);
}

export async function adaptCaddyfile(
  caddyfile: string,
  agentId?: string,
): Promise<{ config: Record<string, unknown>; warnings: string[] }> {
  const parsed = await requestAdapt(caddyfile, agentId);
  return {
    config: (parsed.result ?? {}) as Record<string, unknown>,
    warnings: adaptWarnings(parsed),
  };
}

/** A `subroute`: flattening would apply the routes' path-scoped directives to every request. */
export function buildCaddyfileSubrouteHandler(
  routes: Record<string, unknown>[],
): Record<string, unknown> | null {
  if (routes.length === 0) return null;
  return { handler: "subroute", routes };
}

/** `agentRowIds` are the host's pinned agents, empty for all, as `servedByAgent` reads them. */
export async function validateCaddyfileSnippet(
  snippet: string,
  agentRowIds: readonly number[] = [],
): Promise<DomainError | null> {
  if (!snippet.trim()) return null;
  // Each agent loading the host is asked, since one's verdict must not pass what another rejects;
  // an agent that never loads it has no say, as its Caddy may lack the host agent's modules.
  const agents = connectedAgents().filter(
    (agent) => agentRowIds.length === 0 || agentRowIds.includes(agent.agentRowId),
  );
  const targets = agents.length > 0 ? agents.map((agent) => agent.agentId) : [undefined];
  const verdicts = await Promise.all(
    targets.map(async (agentId): Promise<DomainError | null> => {
      try {
        const { ignoredApps } = await adaptCaddyfileSnippet(snippet, agentId);
        if (ignoredApps.length > 0) {
          return domainError("customCaddyfileOutsideHttp", { apps: ignoredApps }, { status: 400 });
        }
      } catch (error) {
        if (error instanceof CaddyfileAdaptError) {
          return domainError("customCaddyfileInvalid", { error: error.message }, { status: 400 });
        }
        // A transport failure is not a syntax error: let the save through and the build warn.
        console.warn("Could not reach Caddy to validate a Caddyfile snippet", error);
      }
      return null;
    }),
  );
  return verdicts.find((verdict) => verdict !== null) ?? null;
}
