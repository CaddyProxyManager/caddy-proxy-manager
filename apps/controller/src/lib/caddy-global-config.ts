/**
 * Merged by addition only: CPM rebuilds the whole document on every apply, so an override would
 * silently fight it. One that fails to adapt or merge is skipped, never blocking the rest.
 */

import { CADDY_VALIDATE_REFUSED_STATUS } from "@cpm/shared";
import { adaptCaddyfile, CaddyfileAdaptError } from "./caddy-caddyfile";
import { domainError } from "./domain-error";

export const GLOBAL_CADDYFILE_MAX_LENGTH = 64 * 1024;

type Json = Record<string, unknown>;

/** Log names CPM writes to, whether or not this deployment has them switched on. */
const RESERVED_LOGS = new Set(["http_access", "waf_rules"]);
/** Apps CPM builds. Only `http` and `tls` take additions; the rest are CPM's alone. */
const CPM_APPS = new Set(["http", "tls", "layer4", "tailscale"]);
/** CPM serves ACME challenges and redirects on 80 and 443; moving them breaks every host. */
const REFUSED_HTTP_KEYS = new Set(["http_port", "https_port"]);

const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);

type PortRange = [number, number];

/** The ports a Caddy listen address claims; null for one that can't be read, which never merges. */
function listenPorts(address: string): PortRange | null | "none" {
  const bare = address.replace(/^[a-z0-9+]+\//i, "");
  if (/^unix/i.test(address) || /^fd\//i.test(address)) return "none";
  const match = /:(\d+)(?:-(\d+))?$/.exec(bare);
  if (!match) return null;
  const from = Number(match[1]);
  return [from, match[2] ? Number(match[2]) : from];
}

function claimedPorts(document: Json): PortRange[] {
  const apps = isObject(document.apps) ? document.apps : {};
  const ranges: PortRange[] = [];
  for (const app of ["http", "layer4"]) {
    const servers =
      isObject(apps[app]) && isObject((apps[app] as Json).servers)
        ? ((apps[app] as Json).servers as Json)
        : {};
    for (const server of Object.values(servers)) {
      const listen = isObject(server) && Array.isArray(server.listen) ? server.listen : [];
      for (const address of listen) {
        const ports = typeof address === "string" ? listenPorts(address) : null;
        if (Array.isArray(ports)) ranges.push(ports);
      }
    }
  }
  return ranges;
}

function collides(listen: unknown, taken: PortRange[]): boolean {
  if (!Array.isArray(listen) || listen.length === 0) return true;
  return listen.some((address) => {
    const ports = typeof address === "string" ? listenPorts(address) : null;
    if (ports === "none") return false;
    if (!ports) return true;
    return taken.some(([from, to]) => ports[0] <= to && from <= ports[1]);
  });
}

/** With anything refused the caller keeps the original: half a config is worse than none. */
export function mergeGlobalConfig(
  document: Json,
  adapted: Json,
): { document: Json; refused: string[] } {
  const refused: string[] = [];
  const merged: Json = { ...document };

  for (const [key, value] of Object.entries(adapted)) {
    if (key === "logging" && isObject(value)) {
      const logging: Json = isObject(merged.logging) ? { ...merged.logging } : {};
      for (const [part, partValue] of Object.entries(value)) {
        if (part === "logs" && isObject(partValue)) {
          const logs: Json = isObject(logging.logs) ? { ...logging.logs } : {};
          for (const [name, log] of Object.entries(partValue)) {
            if (RESERVED_LOGS.has(name) || name in logs) refused.push(`logging.logs.${name}`);
            else logs[name] = log;
          }
          logging.logs = logs;
        } else if (part in logging) {
          refused.push(`logging.${part}`);
        } else {
          logging[part] = partValue;
        }
      }
      merged.logging = logging;
    } else if (key === "apps" && isObject(value)) {
      merged.apps = mergeApps(isObject(merged.apps) ? merged.apps : {}, value, document, refused);
    } else {
      // `admin` would move the API the agent drives, `storage` the certificates it reads.
      refused.push(key);
    }
  }
  return { document: merged, refused };
}

function mergeApps(apps: Json, adapted: Json, document: Json, refused: string[]): Json {
  const merged: Json = { ...apps };
  for (const [name, app] of Object.entries(adapted)) {
    if (!CPM_APPS.has(name)) {
      if (name in merged) refused.push(`apps.${name}`);
      else merged[name] = app;
      continue;
    }
    if ((name !== "http" && name !== "tls") || !isObject(app)) {
      refused.push(`apps.${name}`);
      continue;
    }
    const target: Json = isObject(merged[name]) ? { ...(merged[name] as Json) } : {};
    for (const [key, value] of Object.entries(app)) {
      if (name === "http" && key === "servers" && isObject(value)) {
        const servers: Json = isObject(target.servers) ? { ...target.servers } : {};
        const taken = claimedPorts(document);
        for (const [serverName, server] of Object.entries(value)) {
          // Prefixed, so the adapter's srv0 can never land on a name CPM uses.
          const renamed = `global_${serverName}`;
          const listen = isObject(server) ? server.listen : undefined;
          if (renamed in servers || collides(listen, taken)) {
            refused.push(`apps.http.servers.${serverName}`);
          } else {
            servers[renamed] = server;
          }
        }
        target.servers = servers;
      } else if (
        (name === "tls" && key === "automation") ||
        (name === "http" && REFUSED_HTTP_KEYS.has(key)) ||
        key in target
      ) {
        refused.push(`apps.${name}.${key}`);
      } else {
        target[key] = value;
      }
    }
    merged[name] = target;
  }
  return merged;
}

export async function withGlobalCaddyConfig(
  document: Json,
  caddyfile: string,
  agentId?: string,
): Promise<Json> {
  if (!caddyfile.trim()) return document;
  try {
    const { config } = await adaptCaddyfile(caddyfile, agentId);
    const { document: merged, refused } = mergeGlobalConfig(document, config);
    if (refused.length > 0) {
      console.warn(`[caddy] Skipping the global Caddyfile: it would replace ${refused.join(", ")}`);
      return document;
    }
    return merged;
  } catch (error) {
    console.warn(
      "[caddy] Skipping the global Caddyfile:",
      error instanceof Error ? error.message : error,
    );
    return document;
  }
}

/** Anything a save must refuse before a byte of it reaches Caddy. */
function assertShape(caddyfile: string) {
  if (caddyfile.length > GLOBAL_CADDYFILE_MAX_LENGTH) {
    throw domainError(
      "globalCaddyfileTooLong",
      { max: GLOBAL_CADDYFILE_MAX_LENGTH },
      { status: 400 },
    );
  }
  // Tabs and newlines are the Caddyfile's own; anything else below space is not.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: finding them is the point
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(caddyfile)) {
    throw domainError("globalCaddyfileControlCharacter", {}, { status: 400 });
  }
}

/** Every connected agent is asked, since each loads it; with none, only the shape is checked. */
export async function assertGlobalCaddyConfigLoads(caddyfile: string): Promise<void> {
  assertShape(caddyfile);
  if (!caddyfile.trim()) return;

  const { connectedAgents } = await import("./agent/registry");
  const { buildCaddyDocument } = await import("./caddy");
  const { caddyValidateViaAgent } = await import("./agent/client");

  const agents = connectedAgents();
  const targets = agents.length > 0 ? agents : [null];
  for (const agent of targets) {
    let adapted: Json;
    try {
      adapted = (await adaptCaddyfile(caddyfile, agent?.agentId)).config;
    } catch (error) {
      if (error instanceof CaddyfileAdaptError) {
        throw domainError("globalCaddyfileInvalid", { detail: error.message }, { status: 400 });
      }
      // Not the operator's fault; the apply-time skip stays the net.
      console.warn("[caddy] Could not reach Caddy to adapt the global Caddyfile", error);
      continue;
    }
    const base = await buildCaddyDocument(agent?.agentRowId, {
      adaptVia: agent?.agentId,
      globalCaddyfile: "",
    });
    const { document, refused } = mergeGlobalConfig(base, adapted);
    if (refused.length > 0) {
      throw domainError("globalCaddyfileRefused", { keys: refused }, { status: 400 });
    }
    if (!agent) continue;

    const verdict = await caddyValidateViaAgent(JSON.stringify(document), agent.agentId).catch(
      () => null,
    );
    if (verdict?.status !== CADDY_VALIDATE_REFUSED_STATUS) continue;
    // Only the global config's fault if the document validates without it.
    const without = await caddyValidateViaAgent(JSON.stringify(base), agent.agentId).catch(
      () => null,
    );
    if (without?.status === CADDY_VALIDATE_REFUSED_STATUS) continue;
    const detail = verdict.text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 500);
    throw domainError("globalCaddyfileRejected", { detail }, { status: 400 });
  }
}
