/**
 * Has an agent `caddy validate` the WAFs a save would produce: a directive Coraza refuses fails the
 * whole document, and `waf/seclang.ts` cannot see id clashes with the CRS or across merged sources.
 * Best effort: with no capable agent the save proceeds and `crs-plugins/recovery.ts` is the net.
 */

import { CADDY_VALIDATE_REFUSED_STATUS } from "@cpm/shared";
import { type CrsPluginRules, buildWafHandler, resolveEffectiveWaf } from "./caddy";
import { domainError } from "../errors/domain-error";
import { type WafExclusionRule, exclusionsFor } from "./exclusions";
import type { WafHostConfig } from "../models/proxy-hosts";
import type { WafSettings } from "../settings";

/** What the refusal names. */
export type WafDryRunTarget =
  | { kind: "global" }
  | { kind: "dashboard" }
  /** `id` picks the host's own exclusions; a new host has none yet. */
  | { kind: "host"; name: string; id?: number }
  | { kind: "preset" }
  | { kind: "plugin" };

export type WafDryRunCandidate = { target: WafDryRunTarget; waf: WafSettings | null };

export type WafDryRunOutcome =
  | { status: "accepted" }
  | { status: "refused"; target: WafDryRunTarget; detail: string }
  /** Nothing was learned; the save proceeds. */
  | { status: "skipped"; reason: "noAgent" | "unavailable" | "notWaf" };

/** Runs `caddy validate` on a config; null when nothing can. */
export type CaddyValidator = (config: string) => Promise<{ status: number; text: string } | null>;

const agentValidator: CaddyValidator = async (config) => {
  const { isDemoMode } = await import("../demo/mode");
  if (isDemoMode()) return null;
  const { caddyValidateViaAgent } = await import("../agent/client");
  return caddyValidateViaAgent(config);
};

let validator: CaddyValidator = agentValidator;

/** Test seam; returns the previous validator to restore. */
export function setCaddyValidator(next: CaddyValidator): CaddyValidator {
  const previous = validator;
  validator = next;
  return previous;
}

/** Nothing binds during validate; ports are distinct only so servers do not clash. */
const CANDIDATE_PORT_BASE = 20_000;

/** One server per WAF handler, so the server name in a refusal says which one failed. */
export function buildValidationDocument(handlers: readonly Record<string, unknown>[]): string {
  const servers = Object.fromEntries(
    handlers.map((handler, index) => [
      `candidate_${index}`,
      {
        listen: [`127.0.0.1:${CANDIDATE_PORT_BASE + index}`],
        automatic_https: { disable: true },
        routes: [{ handle: [handler] }],
      },
    ]),
  );
  return JSON.stringify({ admin: { disabled: true }, apps: { http: { servers } } });
}

/** As caddy/apply-error.ts matches it. */
const WAF_FAILURE = /provision http\.handlers\.waf: |invalid WAF config/i;
/** Long enough for any Coraza message; a rule it quotes whole is cut. */
const MAX_DETAIL = 400;

/**
 * Null when the refusal is not a WAF's (e.g. Caddy built without coraza). The detail is shown
 * untranslated; it can only quote the directives being saved and the public CRS.
 */
export function parseValidationRefusal(
  transcript: string,
): { index: number | null; detail: string } | null {
  const lines = transcript.split("\n").map((line) => line.trim());
  const error = [...lines].reverse().find((line) => line.startsWith("Error:")) ?? lines.join(" ");
  const match = WAF_FAILURE.exec(error);
  if (!match) return null;
  const server = /server candidate_(\d+)/.exec(error);
  const detail = error
    .slice(match.index + (match[0].startsWith("provision") ? match[0].length : 0))
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  return {
    index: server ? Number(server[1]) : null,
    detail: detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}...` : detail,
  };
}

/** Validates every candidate that would emit a WAF handler, in one `caddy validate`. */
export async function dryRunWaf(
  candidates: readonly WafDryRunCandidate[],
  presets: ReadonlyMap<number, string>,
  plugins: ReadonlyMap<number, CrsPluginRules>,
): Promise<WafDryRunOutcome> {
  const targets: WafDryRunTarget[] = [];
  const handlers: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const { target, waf } of candidates) {
    // What caddy/index.ts skips: no handler, nothing for Coraza to compile.
    if (!waf?.enabled || waf.mode === "Off") continue;
    const handler = buildWafHandler(waf, presets, plugins);
    // Most hosts inherit the global WAF unchanged; compiling it once per host only costs time.
    const key = JSON.stringify(handler);
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
    handlers.push(handler);
  }
  if (handlers.length === 0) return { status: "accepted" };

  let answer: Awaited<ReturnType<CaddyValidator>>;
  try {
    answer = await validator(buildValidationDocument(handlers));
  } catch (error) {
    console.warn(
      "[waf] could not dry-run the WAF configuration:",
      error instanceof Error ? error.message : error,
    );
    return { status: "skipped", reason: "unavailable" };
  }
  if (!answer) return { status: "skipped", reason: "noAgent" };
  if (answer.status !== CADDY_VALIDATE_REFUSED_STATUS) return { status: "accepted" };

  const refusal = parseValidationRefusal(answer.text);
  if (!refusal) {
    console.warn(
      "[waf] caddy validate refused the WAF dry run for a reason that is not the WAF's.",
    );
    return { status: "skipped", reason: "notWaf" };
  }
  const target = (refusal.index !== null ? targets[refusal.index] : undefined) ?? targets[0];
  return { status: "refused", target, detail: refusal.detail };
}

const REFUSAL_CODES = {
  global: "wafDryRunRejectedGlobal",
  dashboard: "wafDryRunRejectedDashboard",
  host: "wafDryRunRejectedHost",
  preset: "wafDryRunRejectedPreset",
  plugin: "wafDryRunRejectedPlugin",
} as const;

/** Throws when Caddy refuses one of the candidates; anything else lets the save proceed. */
export async function assertWafLoads(
  candidates: readonly WafDryRunCandidate[],
  rules: {
    presets?: ReadonlyMap<number, string>;
    plugins?: ReadonlyMap<number, CrsPluginRules>;
  } = {},
): Promise<void> {
  if (!candidates.some(({ waf }) => waf?.enabled && waf.mode !== "Off")) return;
  const presets = rules.presets ?? (await loadPresets());
  const plugins = rules.plugins ?? (await loadPlugins());
  const outcome = await dryRunWaf(candidates, presets, plugins);
  if (outcome.status !== "refused") return;
  const { target, detail } = outcome;
  throw domainError(
    REFUSAL_CODES[target.kind],
    target.kind === "host" ? { name: target.name, detail } : { detail },
    { status: 400 },
  );
}

// Lazy: the models import this module, and caddy/index.ts imports them.
async function loadPresets(): Promise<Map<number, string>> {
  const { getWafPresetDirectives } = await import("../models/waf-presets");
  return getWafPresetDirectives();
}

async function loadPlugins(): Promise<Map<number, CrsPluginRules>> {
  const { getCrsPluginRules } = await import("../models/crs-plugins");
  return getCrsPluginRules();
}

// Candidates: the WAFs a save would change, resolved as caddy/index.ts resolves them.

type HostWaf = { target: WafDryRunTarget; waf: WafHostConfig | null | undefined };

/** As caddy/index.ts attaches them: every global exclusion, and the host's own. */
export function withExclusions(
  waf: WafSettings | null,
  exclusions: readonly WafExclusionRule[],
  target: WafDryRunTarget,
  host?: WafHostConfig | null,
): WafSettings | null {
  if (!waf) return null;
  // A new host has no id, and gets the global ones only.
  const own = exclusionsFor(
    exclusions,
    target.kind === "host" ? (target.id ?? null) : null,
    host?.waf_mode === "override",
  );
  return own.length > 0 ? { ...waf, exclusions: own } : waf;
}

async function loadExclusions(): Promise<WafExclusionRule[]> {
  const { listWafExclusionRules } = await import("../models/waf-exclusions");
  return listWafExclusionRules();
}

function wafInMeta(meta: string | null | undefined): WafHostConfig | null {
  if (!meta) return null;
  try {
    return (JSON.parse(meta) as { waf?: WafHostConfig })?.waf ?? null;
  } catch {
    return null;
  }
}

async function hostWafs(): Promise<HostWaf[]> {
  const [{ default: db }, { proxyHosts }, { eq }, { getDashboardSettings }] = await Promise.all([
    import("../db"),
    import("../db/schema"),
    import("drizzle-orm"),
    import("../settings"),
  ]);
  const [dashboard, rows] = await Promise.all([
    getDashboardSettings(),
    db
      .select({ id: proxyHosts.id, name: proxyHosts.name, meta: proxyHosts.meta })
      .from(proxyHosts)
      .where(eq(proxyHosts.enabled, true)),
  ]);
  const out: HostWaf[] = [];
  if (dashboard?.enabled) {
    out.push({ target: { kind: "dashboard" }, waf: wafInMeta(dashboard.options?.meta) });
  }
  for (const row of rows)
    out.push({ target: { kind: "host", name: row.name, id: row.id }, waf: wafInMeta(row.meta) });
  return out;
}

async function currentGlobal(): Promise<WafSettings | null> {
  const { getWafSettings } = await import("../settings");
  return getWafSettings();
}

/** A global save changes the global WAF and every host that merges it. */
export async function wafCandidatesForGlobal(
  next: WafSettings,
  exclusions?: readonly WafExclusionRule[],
): Promise<WafDryRunCandidate[]> {
  const rules = exclusions ?? (await loadExclusions());
  return [
    { target: { kind: "global" }, waf: withExclusions(next, rules, { kind: "global" }) },
    ...(await hostWafs()).map(({ target, waf }) => ({
      target,
      waf: withExclusions(resolveEffectiveWaf(next, waf), rules, target, waf),
    })),
  ];
}

export async function wafCandidatesForHost(
  target: WafDryRunTarget,
  waf: WafHostConfig | null | undefined,
): Promise<WafDryRunCandidate[]> {
  const effective = resolveEffectiveWaf(await currentGlobal(), waf);
  return [{ target, waf: withExclusions(effective, await loadExclusions(), target, waf) }];
}

/** For an exclusion edit: every current WAF, with `next` in place of the stored exclusions. */
export async function wafCandidatesForExclusions(
  next: readonly WafExclusionRule[],
): Promise<WafDryRunCandidate[]> {
  const global = await currentGlobal();
  return global ? wafCandidatesForGlobal(global, next) : hostOnlyCandidates(next);
}

async function hostOnlyCandidates(
  next: readonly WafExclusionRule[],
): Promise<WafDryRunCandidate[]> {
  return (await hostWafs()).map(({ target, waf }) => ({
    target,
    waf: withExclusions(resolveEffectiveWaf(null, waf), next, target, waf),
  }));
}

/** For a preset or plugin edit: every current WAF that `selects` matches. */
export async function wafCandidatesSelecting(
  selects: (waf: WafSettings) => boolean,
): Promise<WafDryRunCandidate[]> {
  const global = await currentGlobal();
  const rules = await loadExclusions();
  const all: WafDryRunCandidate[] = [
    { target: { kind: "global" }, waf: withExclusions(global, rules, { kind: "global" }) },
    ...(await hostWafs()).map(({ target, waf }) => ({
      target,
      waf: withExclusions(resolveEffectiveWaf(global, waf), rules, target, waf),
    })),
  ];
  return all.filter(({ waf }) => waf !== null && selects(waf));
}
