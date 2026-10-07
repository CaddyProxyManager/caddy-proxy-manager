/**
 * Stands in for `app/(dashboard)/access-lists/actions.ts` (see astro.config.mjs): saves land on
 * the demo's own copy of the list, which the Network tab reads back as if a server had answered.
 */
import type {
  AccessList,
  AccessListSettingsInput,
  AccessListStats,
} from "@cpm/controller/src/lib/models/access-lists";
import type { ActionResult } from "@cpm/controller/src/lib/errors/action-result";

const lists = new Map<number, AccessList>();

/** The demo registers the list it renders, so a save has something to update. */
export function rememberAccessList(list: AccessList): void {
  lists.set(list.id, list);
}

function save(id: number, change: Partial<AccessList>): ActionResult<AccessList> {
  const current = lists.get(id);
  if (!current)
    return { ok: false, error: "There is no controller behind the documentation site." };
  const next = { ...current, ...change, updatedAt: new Date().toISOString() };
  lists.set(id, next);
  return { ok: true, data: next };
}

export async function updateAccessListAction(
  id: number,
  input: AccessListSettingsInput,
): Promise<ActionResult<AccessList>> {
  const { denyResponse, ...rest } = input;
  const change = rest as Partial<AccessList>;
  if (denyResponse !== undefined) {
    const deny = denyResponse as { status?: number; body?: string; redirectUrl?: string } | null;
    change.denyResponse = deny?.redirectUrl
      ? { status: 302, body: null, redirectUrl: deny.redirectUrl }
      : deny
        ? { status: deny.status ?? 403, body: deny.body || null, redirectUrl: null }
        : null;
  }
  return save(id, change);
}

/** Digits, dots and slashes, or any colon, is an address; the server tells them apart with `isIP`. */
const looksLikeAddress = (target: string) => /^[\d./]+$|:/.test(target);

export async function setAccessListIpRulesAction(
  id: number,
  rules: {
    action: string;
    kind: "address" | "country" | "continent" | "asn";
    target: string;
    note?: string | null;
    expiresAt?: string | null;
  }[],
): Promise<ActionResult<AccessList>> {
  // A name saved before keeps its answer; a new one has nothing to look it up with, so it shows as
  // not looked up yet.
  const known = new Map(
    (lists.get(id)?.ipRules ?? []).flatMap((rule) =>
      rule.hostname && rule.resolved ? [[rule.hostname, rule.resolved]] : [],
    ),
  );
  return save(id, {
    ipRules: rules.map((rule) => {
      const action = rule.action === "deny" ? "deny" : "allow";
      const base = { action, cidr: null, hostname: null, note: rule.note ?? null } as const;
      const expiresAt = rule.expiresAt ?? null;
      if (rule.kind === "country")
        return { ...base, country: rule.target.toUpperCase(), expiresAt };
      if (rule.kind === "continent") return { ...base, continent: rule.target, expiresAt };
      if (rule.kind === "asn") {
        return { ...base, asn: Number(rule.target.replace(/^as/i, "")), expiresAt };
      }
      if (looksLikeAddress(rule.target)) return { ...base, cidr: rule.target, expiresAt };
      const hostname = rule.target.toLowerCase();
      const resolved = known.get(hostname) ?? {
        ranges: [],
        resolvedAt: null,
        lastError: null,
        lastErrorAt: null,
      };
      return { ...base, hostname, expiresAt, resolved };
    }),
  });
}

/** The docs site has no analytics, so traffic reads as switched off. */
export async function getAccessListStatsAction(id: number): Promise<ActionResult<AccessListStats>> {
  return { ok: true, data: { hosts: lists.get(id) ? 2 : 0, traffic: null } };
}
