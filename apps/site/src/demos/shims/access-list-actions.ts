/**
 * Stands in for `app/(dashboard)/access-lists/actions.ts` (see astro.config.mjs): saves land on
 * the demo's own copy of the list, which the Network tab reads back as if a server had answered.
 */
import type {
  AccessList,
  AccessListSettingsInput,
} from "@cpm/controller/src/lib/models/access-lists";

const lists = new Map<number, AccessList>();

/** The demo registers the list it renders, so a save has something to update. */
export function rememberAccessList(list: AccessList): void {
  lists.set(list.id, list);
}

function save(id: number, change: Partial<AccessList>): AccessList {
  const current = lists.get(id);
  if (!current) throw new Error("There is no controller behind the documentation site.");
  const next = { ...current, ...change, updatedAt: new Date().toISOString() };
  lists.set(id, next);
  return next;
}

export async function updateAccessListAction(
  id: number,
  input: AccessListSettingsInput,
): Promise<AccessList> {
  return save(id, input as Partial<AccessList>);
}

/** Digits, dots and slashes, or any colon, is an address; the server tells them apart with `isIP`. */
const looksLikeAddress = (target: string) => /^[\d./]+$|:/.test(target);

export async function setAccessListIpRulesAction(
  id: number,
  rules: { action: string; target: string; note?: string | null }[],
): Promise<AccessList> {
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
      const note = rule.note ?? null;
      if (looksLikeAddress(rule.target)) {
        return { action, cidr: rule.target, hostname: null, note };
      }
      const hostname = rule.target.toLowerCase();
      const resolved = known.get(hostname) ?? {
        ranges: [],
        resolvedAt: null,
        lastError: null,
        lastErrorAt: null,
      };
      return { action, cidr: null, hostname, note, resolved };
    }),
  });
}
