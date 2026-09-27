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

export async function setAccessListIpRulesAction(
  id: number,
  rules: { action: string; cidr: string; note?: string | null }[],
): Promise<AccessList> {
  return save(id, {
    ipRules: rules.map((rule) => ({
      action: rule.action === "deny" ? "deny" : "allow",
      cidr: rule.cidr,
      note: rule.note ?? null,
    })),
  });
}
