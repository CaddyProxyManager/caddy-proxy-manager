"use server";

import { requireCan } from "@/src/lib/users/permissions";
import { revalidatePath } from "next/cache";
import { domainError } from "@/src/lib/errors/domain-error";
import { normalizeCidr } from "@/src/lib/access-lists/rules";
import type { AccessRuleKind } from "@/src/lib/access-lists/limits";
import type { ActionResult } from "@/src/lib/errors/action-result";
import { runAction } from "@/src/lib/errors/run-action";
import {
  addAccessListEntry,
  getAccessList,
  getAccessListStats,
  removeAccessListEntry,
  type AccessList,
  type AccessListSettingsInput,
  type AccessListStats,
} from "@/src/lib/models/access-lists";
import { submitOrApply } from "@/src/lib/approvals";
import { orSubmitted } from "@/src/lib/approvals/action-result";

export async function createAccessListAction(input: {
  name: string;
  description: string | null;
  users: { username: string; password: string }[];
}) {
  return runAction(async () => {
    const session = await requireCan("accessLists:write");
    const userId = Number(session.user.id);
    const list = await orSubmitted(() =>
      submitOrApply(
        { userId },
        {
          kind: "accessListCreate",
          payload: {
            input: {
              name: input.name,
              description: input.description,
              users: input.users.filter((u) => u.username.trim() && u.password),
            },
          },
        },
      ),
    );
    revalidatePath("/access-lists");
    return list;
  });
}

export async function updateAccessListAction(id: number, input: AccessListSettingsInput) {
  return runAction(async () => {
    const session = await requireCan("accessLists:write");
    const list = await orSubmitted(() =>
      submitOrApply(
        { userId: Number(session.user.id) },
        { kind: "accessListUpdate", payload: { id, input } },
      ),
    );
    revalidatePath("/access-lists");
    return list;
  });
}

/**
 * The whole ordered set, replacing what was there. An `address` that is no IP or range is a
 * hostname; the model checks every value.
 */
export async function setAccessListIpRulesAction(
  id: number,
  rules: {
    action: string;
    kind: AccessRuleKind;
    target: string;
    note?: string | null;
    expiresAt?: string | null;
  }[],
) {
  return runAction(async () => {
    const session = await requireCan("accessLists:write");
    const typed = rules.map(({ kind, target, ...rule }) => {
      if (kind === "address") {
        return normalizeCidr(target) ? { ...rule, cidr: target } : { ...rule, hostname: target };
      }
      return { ...rule, [kind]: target };
    });
    const list = await orSubmitted(() =>
      submitOrApply(
        { userId: Number(session.user.id) },
        { kind: "accessListRules", payload: { id, rules: typed } },
      ),
    );
    revalidatePath("/access-lists");
    return list;
  });
}

/** Hosts using the list, and what it stopped over the last day when analytics are on. */
export async function getAccessListStatsAction(id: number): Promise<ActionResult<AccessListStats>> {
  return runAction(async () => {
    await requireCan("accessLists:read");
    return getAccessListStats(id);
  });
}

/** The approval notice when the delete was held for review. */
export async function deleteAccessListAction(
  id: number,
): Promise<ActionResult<{ submitted?: string }>> {
  return runAction(async () => {
    const session = await requireCan("accessLists:write");
    const userId = Number(session.user.id);
    const outcome = await orSubmitted(() =>
      submitOrApply({ userId }, { kind: "accessListDelete", payload: { id } }),
    );
    revalidatePath("/access-lists");
    return typeof outcome === "object" ? { submitted: outcome.message } : {};
  });
}

export async function addAccessEntryAction(
  accessListId: number,
  entry: { username: string; password: string },
) {
  return runAction(async () => {
    const session = await requireCan("accessLists:write");
    const userId = Number(session.user.id);
    const list = await orSubmitted(() =>
      submitOrApply(
        { userId },
        { kind: "accessListEntryAdd", payload: { id: accessListId, entry } },
      ),
    );
    revalidatePath("/access-lists");
    return list;
  });
}

export async function deleteAccessEntryAction(accessListId: number, entryId: number) {
  return runAction(async () => {
    const session = await requireCan("accessLists:write");
    const userId = Number(session.user.id);
    const list = await orSubmitted(() =>
      submitOrApply(
        { userId },
        { kind: "accessListEntryRemove", payload: { id: accessListId, entryIds: [entryId] } },
      ),
    );
    revalidatePath("/access-lists");
    return list;
  });
}

export async function bulkDeleteEntriesAction(accessListId: number, entryIds: number[]) {
  return runAction(async () => {
    const session = await requireCan("accessLists:write");
    const userId = Number(session.user.id);
    const list = await orSubmitted(() =>
      submitOrApply(
        { userId },
        { kind: "accessListEntryRemove", payload: { id: accessListId, entryIds } },
      ),
    );
    revalidatePath("/access-lists");
    return list;
  });
}

export async function regeneratePasswordAction(
  accessListId: number,
  entryId: number,
  newPassword: string,
): Promise<ActionResult<AccessList>> {
  return runAction(async () => {
    const session = await requireCan("accessLists:write");
    const userId = Number(session.user.id);
    // Replaced as remove-and-add under the same username, which has to be read first.
    const listBefore = await getAccessList(accessListId);
    if (!listBefore) throw domainError("accessListNotFound");
    const entry = listBefore.entries.find((e) => e.id === entryId);
    if (!entry) throw domainError("accessListEntryNotFound");

    await removeAccessListEntry(accessListId, entryId, userId);
    const list = await addAccessListEntry(
      accessListId,
      { username: entry.username, password: newPassword },
      userId,
    );
    revalidatePath("/access-lists");
    return list;
  });
}
