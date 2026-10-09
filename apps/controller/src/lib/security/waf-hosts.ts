/** Each proxy host's WAF mode, where it comes from, and its recent WAF events. */

import type { WafHostConfig } from "../models/proxy-hosts";
import type { WafSettings } from "../settings";
import { resolveEffectiveWaf } from "../waf/caddy";

export type WafEngineMode = "On" | "DetectionOnly" | "Off";

/**
 * `global`: the host follows the global mode. `host`: it sets its own. `hostOff`: it opted out of
 * the WAF. `override`: it replaces the global WAF with its own settings.
 */
export type WafModeSource = "global" | "host" | "hostOff" | "override";

export type WafHostMode = {
  id: number;
  /** Empty for the dashboard host. */
  uuid: string;
  name: string;
  domains: string[];
  enabled: boolean;
  mode: WafEngineMode;
  source: WafModeSource;
  /** Null when analytics are off. */
  events7d: number | null;
  /** The managed dashboard host, whose WAF lives in its settings rather than a proxy host. */
  dashboard?: boolean;
};

/**
 * A host's WAF with only the switch changed, so its own tuning survives. An explicit Off mode is
 * dropped on the way on, or the switch would turn on a WAF that runs nothing.
 */
export function wafWithEnabled(
  waf: WafHostConfig | null | undefined,
  enabled: boolean,
): WafHostConfig {
  const { mode, ...rest } = waf ?? {};
  return { ...rest, enabled, ...(mode && !(enabled && mode === "Off") && { mode }) };
}

export function effectiveWafMode(
  global: WafSettings | null,
  host: WafHostConfig | null | undefined,
): { mode: WafEngineMode; source: WafModeSource } {
  const effective = resolveEffectiveWaf(global, host);
  const mode: WafEngineMode =
    !effective?.enabled || effective.mode === "Off"
      ? "Off"
      : effective.mode === "DetectionOnly"
        ? "DetectionOnly"
        : "On";
  if (host?.enabled === false) return { mode, source: "hostOff" };
  if (host?.enabled && host.waf_mode === "override") return { mode, source: "override" };
  // With the global WAF off, a host that switched it on is the reason it runs, whatever its mode.
  if (host?.enabled && (host.mode || !global?.enabled)) return { mode, source: "host" };
  return { mode, source: "global" };
}

export function wafHostModes(
  global: WafSettings | null,
  hosts: readonly {
    id: number;
    uuid: string;
    name: string;
    domains: string[];
    enabled: boolean;
    waf?: WafHostConfig | null;
  }[],
  eventsByHost: ReadonlyMap<string, number> | null,
): WafHostMode[] {
  return hosts.map((host) => ({
    id: host.id,
    uuid: host.uuid,
    name: host.name,
    domains: host.domains,
    enabled: host.enabled,
    ...effectiveWafMode(global, host.waf),
    events7d: eventsByHost
      ? host.domains.reduce((sum, domain) => sum + (eventsByHost.get(domain.toLowerCase()) ?? 0), 0)
      : null,
  }));
}

export function countModes(modes: readonly WafHostMode[]): Record<WafEngineMode, number> {
  const out: Record<WafEngineMode, number> = { On: 0, DetectionOnly: 0, Off: 0 };
  for (const host of modes) if (host.enabled) out[host.mode]++;
  return out;
}
